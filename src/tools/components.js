'use strict';

const { surfaceBindingFeedback } = require('../utils/binding-feedback');
const { wordBoundaryMatch } = require('../utils/text-match');

const PHASE_HINT = 'Complete DS Discovery and Style Inventory first (call mimic_discover_ds → mimic_ds_assets → mimic_ds_assets action="set_defaults").';

/**
 * Normalize a cached DS component's variantProperties (array-of-{name,values}
 * from the plugin's page-scan, or absent for REST-only components — see
 * defect I) into a { [propName]: string[] } value lookup for apply-time
 * validation (spec §4.4).
 */
function extractLiveVariantValues(componentMeta) {
  const out = {};
  const schema = componentMeta && componentMeta.variantProperties;
  if (!schema) return out;
  if (Array.isArray(schema)) {
    for (const vp of schema) out[vp.name] = (vp.values || []).map(String);
  } else if (typeof schema === 'object') {
    for (const [name, vp] of Object.entries(schema)) out[name] = (vp.values || []).map(String);
  }
  return out;
}

/**
 * Build the `_autoApplied.provenance` strings the spec §5.2 describes:
 * `{ Size: "md in 7/9 builds" }`, derived from the recipe's variantStats
 * majority-wins counts for each property actually applied.
 */
function buildReplayProvenance(recipe, appliedProps) {
  const provenance = {};
  const stats = recipe.variantStats || {};
  for (const [prop, value] of Object.entries(appliedProps || {})) {
    const valueCounts = stats[prop];
    if (!valueCounts) continue;
    const total = Object.values(valueCounts).reduce((a, b) => a + (b || 0), 0);
    if (total === 0) continue;
    const count = valueCounts[value] || 0;
    provenance[prop] = `${value} in ${count}/${total} builds`;
  }
  return provenance;
}

function register(server, context) {
  const { bridge, buildManifest, dsCache, knowledgeStore, session, requirePhase, advancePhase, registerTool } = context;

  // ── figma_insert_component ────────────────────────────────────
  registerTool(
    'figma_insert_component',
    'Imports and inserts a DS component instance into the document. Returns componentKey/nodeId, configurationChecklist (booleans to enable, text nodes to override, variants to set), and _autoApplied variant defaults replayed from the knowledge store when a confirmed recipe exists. Params: componentKey (required, from mimic_map_components/discovery), parentId (required), name (instance name override), importMode ("component"|"componentSet", usually inferred), applyRecipe (false to skip auto-replay). Workflow position: Phase 3 build, after mimic_map_components. Follow up with figma_component_text and figma_set_variant.',
    {
      type: 'object',
      properties: {
        componentKey: { type: 'string', description: 'Component key from the DS library.' },
        name: { type: 'string', description: 'Instance name override.' },
        parentId: { type: 'string', description: 'Parent node ID to insert into.' },
        importMode: { type: 'string', enum: ['component', 'componentSet'], description: 'Optional import hint. Usually inferred from DS discovery cache.' },
        applyRecipe: { type: 'boolean', description: 'Set to false to skip auto-applying confirmed recipe defaults. Defaults to true.' },
      },
      required: ['componentKey', 'parentId'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);

      if (dsCache.hasFailed(args.componentKey)) {
        return {
          error: 'COMPONENT_PREVIOUSLY_FAILED',
          componentKey: args.componentKey,
          hint: 'This component key failed before. Verify the key is correct and the library is enabled in the file.',
        };
      }

      // ── No retry on timeout ──────────────────────────────────────
      // insert_component is NOT idempotent — the plugin creates the
      // instance before responding. If the bridge times out but the
      // plugin succeeded, retrying creates duplicate instances (issue #4).
      // Use a generous 180s timeout instead (cold library imports can
      // take 60-90s).

      // ── Dedup guard ─────────────────────────────────────────────
      // Track pending/timed-out inserts by parentId+componentKey.
      // If the same insert is attempted while one already timed out,
      // warn instead of inserting again — prevents duplicates.
      if (!session._pendingInserts) session._pendingInserts = new Map();
      const dedupKey = `${args.parentId}:${args.componentKey}`;
      if (session._pendingInserts.has(dedupKey)) {
        return {
          error: 'INSERT_ALREADY_ATTEMPTED',
          componentKey: args.componentKey,
          parentId: args.parentId,
          previousAttempt: session._pendingInserts.get(dedupKey),
          hint: 'A previous insert for this component+parent timed out. The component likely EXISTS in Figma already. Call figma_inspect (target: "children") on the parent to check. Do NOT retry — duplicates are hard to detect and fix.',
        };
      }

      const componentMeta = dsCache.getComponent(args.componentKey);
      const insertArgs = { ...args };
      if (!insertArgs.importMode && componentMeta && typeof componentMeta.isComponentSet === 'boolean') {
        insertArgs.importMode = componentMeta.isComponentSet ? 'componentSet' : 'component';
      }

      let result;
      try {
        result = await bridge.send('insert_component', insertArgs, 180000);
        // Success — remove from pending if it was there
        session._pendingInserts.delete(dedupKey);
      } catch (err) {
        const isPluginTimeout = err.pluginError && (err.pluginError.error === 'INSERT_TIMEOUT' || /timed?\s*out/i.test(err.message));
        const isBridgeTimeout = err.message && err.message.includes('timeout');
        const isTimeout = isPluginTimeout || isBridgeTimeout;
        const isFontError = err.message && /unloaded font|loadFontAsync|font.*not.*loaded/i.test(err.message);
        if (isTimeout) {
          // Transient failure — allow retry after cooldown (30s)
          dsCache.markFailed(args.componentKey, false);
        } else {
          // Permanent failure — component doesn't exist or library not enabled
          dsCache.markFailed(args.componentKey, true);
        }
        if (isFontError && !dsCache.libraryFontIncompatible) {
          dsCache.libraryFontIncompatible = true;
        }
        if (isFontError) {
          return {
            error: 'LIBRARY_FONT_INCOMPATIBLE',
            componentKey: args.componentKey,
            message: `Component requires a font not loaded in this file. All components from this library will fail to import.`,
            libraryFontIncompatible: true,
            hint: 'The selected DS library requires fonts not available in this file. Component-first enforcement has been automatically disabled for the rest of this build. You can now create frames with component-like names without confirmedNoComponent/primitiveOverrideReason — the gate will auto-bypass.',
          };
        }
        if (isTimeout) {
          // Auto-retry once after a short pause. Large libraries (5000+ components)
          // often timeout on the first import because Figma loads the library's font
          // and asset data lazily. The second attempt usually succeeds because the
          // library is now warm in memory.
          if (!session._timeoutRetries) session._timeoutRetries = new Map();
          const retryCount = session._timeoutRetries.get(dedupKey) || 0;

          if (retryCount === 0) {
            session._timeoutRetries.set(dedupKey, 1);
            // Clear the transient failure so retry is allowed
            dsCache.failedKeys.delete(args.componentKey);
            // Wait 3 seconds for Figma to finish loading, then retry
            await new Promise(resolve => setTimeout(resolve, 3000));
            try {
              result = await bridge.send('insert_component', insertArgs, 180000);
              session._pendingInserts.delete(dedupKey);
              // Fall through to normal success handling below
            } catch (retryErr) {
              // Second attempt also failed — give up with clear guidance
              session._pendingInserts.set(dedupKey, {
                timestamp: Date.now(),
                componentKey: args.componentKey,
                parentId: args.parentId,
              });
              return {
                error: 'INSERT_TIMEOUT',
                componentKey: args.componentKey,
                retriesExhausted: true,
                message: 'Component import timed out twice. This typically happens with large libraries (5000+ components) on the first import of a session. The library may still be loading in Figma.',
                hint: 'Wait 10 seconds, then call figma_inspect (target: "children") on the parent to check if the component appeared. If it did, proceed with configuration. If not, try a different component from the same library first (to warm the library cache), then come back to this one.',
              };
            }
          } else {
            // Already retried once — don't retry again
            session._pendingInserts.set(dedupKey, {
              timestamp: Date.now(),
              componentKey: args.componentKey,
              parentId: args.parentId,
            });
            return {
              error: 'INSERT_TIMEOUT',
              componentKey: args.componentKey,
              retriesExhausted: true,
              message: 'Component import timed out. This component may require fonts or assets that Figma is still loading.',
              hint: 'Wait 10 seconds, then call figma_inspect (target: "children") on the parent to check if the component appeared. If it did, proceed with configuration. If not, try a different component from the same library first (to warm the library cache), then come back to this one.',
            };
          }
        }
        throw err;
      }

      session.toolCallCount++;
      advancePhase(3);

      // Cache the component info
      if (result?.componentKey) {
        dsCache.addComponent(result.componentKey, {
          name: result.name || args.name,
          variants: result.variants || null,
          isComponentSet: componentMeta?.isComponentSet,
        });
      }

      // Track insertion for learning persistence (maps componentKey → all names used)
      if (!session._componentInsertions) session._componentInsertions = new Map();
      if (args.componentKey) {
        const existing = session._componentInsertions.get(args.componentKey) || { count: 0, names: [] };
        existing.count++;
        const instanceName = args.name || result?.name;
        if (instanceName && !existing.names.includes(instanceName)) existing.names.push(instanceName);
        session._componentInsertions.set(args.componentKey, existing);
      }

      const nodeId = result?.nodeId || result?.id;

      // Check knowledge store for recipes — look up by componentKey first,
      // then by name. Track the ACTUAL store key the recipe was found under
      // (fixes defect H's "always clear via the recipe's actual store key"
      // — the old code always used args.componentKey even when the recipe
      // was only found via a name-keyed lookup, a silent no-op).
      let recipeStoreKey = null;
      let recipe = knowledgeStore.getComponent(args.componentKey);
      if (recipe) {
        recipeStoreKey = args.componentKey;
      } else {
        const nameKey = args.name || result?.name;
        recipe = nameKey ? knowledgeStore.getComponent(nameKey) : null;
        if (recipe) recipeStoreKey = nameKey;
      }
      const hints = [];
      const autoApplied = {};

      if (recipe) {
        hints.push(`Known recipe: ${JSON.stringify(recipe)}`);
        session.cacheHits++;

        // Auto-apply confirmed/verified recipes unless explicitly opted out.
        // A stale recipe never replays (acceptance 9) — self-heal for
        // variant staleness only happens via a manual figma_set_variant call
        // that re-validates cleanly (see that tool below), not auto-apply.
        // Enters the replay path whenever there's EITHER a majority-wins
        // default OR raw variantStats observations to explain (acceptance
        // 14: a genuine 5/4 split has no defaultVariants entry but must
        // still surface _autoApplied.skipped explaining why nothing replayed
        // — not just silently skip the whole block).
        const hasVariantData = (recipe.defaultVariants && Object.keys(recipe.defaultVariants).length > 0)
          || (recipe.variantStats && Object.keys(recipe.variantStats).length > 0);
        const isReplayable = (recipe.confidence === 'confirmed' || recipe.confidence === 'verified')
          && !recipe.stale
          && hasVariantData
          && args.applyRecipe !== false;

        if (isReplayable && nodeId) {
          // ── Apply-time validation (spec §4.4 belt-and-braces) ──
          // Filter defaultVariants against the live schema in the DS cache
          // BEFORE replay — skip entries the current DS no longer supports
          // and report them in _autoApplied.skipped, instead of blindly
          // replaying a stale value.
          const liveMeta = dsCache.getComponent(args.componentKey);
          const liveValuesByProp = extractLiveVariantValues(liveMeta);
          const toApply = {};
          const skipped = {};
          for (const [prop, value] of Object.entries(recipe.defaultVariants || {})) {
            const liveValues = liveValuesByProp[prop];
            if (liveValues && !liveValues.includes(String(value))) {
              skipped[prop] = `stored value "${value}" no longer valid for "${prop}" — DS schema changed`;
              continue;
            }
            toApply[prop] = value;
          }
          // Explain properties with OBSERVATIONS but no dominant default
          // (spec §5.1/§5.2, acceptance 14: a genuine 5/4 split must not
          // replay either value, and _autoApplied.skipped must say why —
          // not just silently omit the property).
          for (const [prop, valueCounts] of Object.entries(recipe.variantStats || {})) {
            if (prop in (recipe.defaultVariants || {}) || prop in skipped) continue;
            const entries = Object.entries(valueCounts || {});
            if (entries.length === 0) continue;
            const total = entries.reduce((sum, [, c]) => sum + (c || 0), 0);
            const sorted = entries.sort((a, b) => b[1] - a[1]);
            const split = sorted.map(([v, c]) => `${v}:${c}`).join('/');
            skipped[prop] = `no dominant value (${split} split of ${total}) — set explicitly from HTML`;
          }

          if (Object.keys(toApply).length > 0) {
            try {
              const applyResult = await bridge.send('set_variant', {
                nodeId,
                properties: toApply,
              });
              // Inspect appliedProperties for PER-KEY errors (fixes defect B
              // — the plugin returns a successful response envelope even
              // when individual properties failed; `applied[key]` is the
              // value on success, `{ error: message }` on failure).
              const appliedProperties = applyResult?.appliedProperties || {};
              const failedProps = Object.entries(appliedProperties)
                .filter(([, v]) => v && typeof v === 'object' && 'error' in v)
                .map(([k]) => k);
              const cleanApply = failedProps.length === 0;
              const succeededProps = Object.fromEntries(Object.entries(toApply).filter(([k]) => !failedProps.includes(k)));

              if (recipeStoreKey) {
                if (cleanApply) {
                  for (const prop of Object.keys(toApply)) knowledgeStore.recordReplaySuccess(recipeStoreKey, prop);
                  knowledgeStore.restoreAfterCleanReplay(recipeStoreKey);
                } else {
                  for (const prop of failedProps) knowledgeStore.recordReplayFailure(recipeStoreKey, prop);
                }
              }

              // A failed apply is a FAILURE, not a saving (fixes defect B):
              // no replaySavings increment for failed keys.
              if (Object.keys(succeededProps).length > 0) {
                session.replaySavings = (session.replaySavings || 0) + 1;
              }

              // Per-node final-variant tracking (spec §5.1): counting unit
              // for majority-wins is the final state per inserted instance
              // at report time, not per set_variant call — track it here
              // keyed by nodeId so a later manual correction (figma_set_
              // variant) can refine the SAME node's entry rather than
              // creating a second, competing observation.
              if (nodeId && Object.keys(succeededProps).length > 0) {
                if (!session._nodeVariantConfigs) session._nodeVariantConfigs = new Map();
                const existingNodeProps = session._nodeVariantConfigs.get(nodeId) || {};
                session._nodeVariantConfigs.set(nodeId, { ...existingNodeProps, ...succeededProps });
              }

              autoApplied.variants = succeededProps;
              autoApplied.provenance = buildReplayProvenance(recipe, succeededProps);
              if (Object.keys(skipped).length > 0) autoApplied.skipped = skipped;
              autoApplied.confidence = recipe.confidence;
              autoApplied.overrideHint = 'Pass applyRecipe:false or call figma_set_variant to differ.';
              if (failedProps.length > 0) {
                autoApplied.failed = failedProps;
                hints.push(`Auto-apply FAILED for: ${failedProps.join(', ')} — NOT counted as a replay saving, logged to failureLog.`);
              }
              hints.push(Object.keys(succeededProps).length > 0
                ? `Auto-applied variant config from ${recipe.confidence} recipe: ${JSON.stringify(succeededProps)}. Override with figma_set_variant if this instance needs different values.`
                : 'Recipe variant auto-apply produced no successful properties — set variants manually.');
            } catch (_) {
              hints.push('Recipe variant auto-apply failed — set variants manually.');
            }
          } else if (Object.keys(skipped).length > 0) {
            autoApplied.skipped = skipped;
            autoApplied.confidence = recipe.confidence;
            hints.push('All stored variant defaults were invalid against the current DS schema — skipped. Set variants manually.');
          }
        }
      }
      hints.push('After inserting: override ALL text with figma_component_text, set semantic properties, configure icons, hide unused slots.');

      // Self-heal (fixes defect H): a successful insert clears
      // component_removed staleness ONLY — variant staleness is untested at
      // insert time and clears exclusively via a clean, validated
      // figma_set_variant apply (see that tool below). Always clears via the
      // recipe's ACTUAL store key.
      if (recipe && recipe.stale && recipe.staleReason === 'component_removed' && nodeId && recipeStoreKey) {
        knowledgeStore.clearRecipeStale(recipeStoreKey);
        hints.push(`Stale recipe cleared for "${recipe.names?.[0] || recipeStoreKey}" — component still exists in DS.`);
      }

      // Gap lifecycle (spec §4.5/§5.4, defect L): the discovery-time diff
      // (status.js) already marks a matching gap `resolved-pending` when the
      // DS gains a name-matching component. The gap becomes fully `resolved`
      // — and stops generating recommendations — on the FIRST successful
      // insert of the resolving component, checked here by componentKey
      // first (the reliable link left by that diff), then by a word-boundary
      // name match for gaps that predate this component ever being diffed.
      if (nodeId && knowledgeStore) {
        const insertedName = result?.name || args.name || '';
        for (const [gapName, gap] of Object.entries(knowledgeStore.data.gaps || {})) {
          if (gap.status === 'resolved') continue;
          const matchesByKey = gap.resolvedBy && gap.resolvedBy === args.componentKey;
          const matchesByName = !matchesByKey && gap.status === 'open' && (() => {
            const searchTerms = gap.searchTerms && gap.searchTerms.length > 0 ? gap.searchTerms : [gapName];
            return searchTerms.some(t => wordBoundaryMatch(t, insertedName)) || wordBoundaryMatch(gapName, insertedName);
          })();
          if (matchesByKey || matchesByName) {
            knowledgeStore.markGapResolved(gapName);
          }
        }
      }

      // Track nodeId → componentKey for variant config capture
      if (!session._nodeComponentKeys) session._nodeComponentKeys = new Map();
      if (nodeId && args.componentKey) {
        session._nodeComponentKeys.set(nodeId, args.componentKey);
      }

      // Auto-set FILL width when inserted into a VERTICAL auto-layout parent
      // that has a deterministic width (FIXED or FILL). Skip when:
      // - Parent is HUG — FILL children in HUG create layout conflicts
      // - Parent is HORIZONTAL — FILL would stretch the component across the
      //   row (e.g., a sidebar taking the full artboard width). In HORIZONTAL
      //   parents, components keep their natural width; the caller sets FILL
      //   explicitly on the element that should expand (e.g., main content).
      // - Component is inline (Badge, Breadcrumb, etc.) — these should HUG
      //   their content, not stretch across the parent.
      const INLINE_COMPONENTS = [
        'badge', 'breadcrumb', 'tag', 'chip', 'pill', 'avatar', 'toggle',
        'checkbox', 'radio', 'switch', 'icon',
      ];
      const compName = (result?.name || args.name || '').toLowerCase();
      const isInline = INLINE_COMPONENTS.some(p => compName.includes(p));
      if (nodeId && args.parentId && !isInline) {
        try {
          const parentProps = await bridge.send('get_node_props', { nodeId: args.parentId });
          const parentSizing = parentProps?.layoutSizingHorizontal;
          const parentDirection = parentProps?.layoutMode;
          const parentHasWidth = parentSizing === 'FIXED' || parentSizing === 'FILL';
          const parentIsVertical = parentDirection === 'VERTICAL';
          if (parentHasWidth && parentIsVertical) {
            await bridge.send('set_layout_sizing', {
              nodeId,
              layoutSizingHorizontal: 'FILL',
            });
            result._autoSized = { layoutSizingHorizontal: 'FILL' };
          } else {
            result._autoSized = { skipped: true, reason: parentIsVertical
              ? `parent is ${parentSizing || 'HUG'} — FILL would cause layout conflict`
              : `parent is HORIZONTAL — components keep natural width` };
          }
        } catch (_) {
          // Non-critical — parent may not be auto-layout
        }
      } else if (isInline) {
        result._autoSized = { skipped: true, reason: `inline component "${compName}" keeps HUG width` };
      }

      // Record component in build manifest
      if (nodeId) {
        buildManifest.addSection(
          args.name || result?.name || 'unnamed-component',
          nodeId,
          'component',
          result?.name || args.name
        );
      }

      // ── Build explicit configuration checklist from configurationHints ──
      const configHints = result?.configurationHints || {};
      const checklist = [];

      // Track expected text overrides for build report
      const expectedTextNodes = configHints.textNodes || [];
      if (nodeId && expectedTextNodes.length > 0) {
        session.componentTextTracker.set(nodeId, {
          name: args.name || result?.name || 'unnamed',
          expected: expectedTextNodes.map(t => ({
            nodeId: t.nodeId,
            name: t.name,
            defaultText: t.characters,
          })),
          overridden: new Set(),
        });
      }

      // Boolean properties — auto-disabled at insertion time by the plugin.
      // The builder only needs to RE-ENABLE booleans the HTML explicitly shows.
      const disabledBools = result?.disabledBooleans || [];
      const boolProps = configHints.booleanProperties || {};
      const boolKeys = Object.keys(boolProps);
      if (disabledBools.length > 0) {
        const boolList = disabledBools.map(k => {
          const displayName = k.includes('#') ? k.split('#')[0].trim() : k;
          return displayName;
        });
        checklist.push({
          action: 'ENABLE_BOOLEANS_IF_NEEDED',
          message: `${disabledBools.length} boolean(s) were auto-disabled: ${boolList.join(', ')}. Only re-enable those the source HTML explicitly shows (e.g. an icon that is visible in the HTML). Most components work correctly with all booleans OFF.`,
          properties: disabledBools,
        });
      } else if (boolKeys.length > 0) {
        // Fallback for components where auto-disable didn't run
        const boolList = boolKeys.map(k => {
          const displayName = k.includes('#') ? k.split('#')[0].trim() : k;
          return displayName;
        });
        checklist.push({
          action: 'DISABLE_BOOLEANS',
          message: `Toggle OFF these boolean properties unless the source HTML explicitly shows them: ${boolList.join(', ')}`,
          properties: boolKeys,
        });
      }

      // Text nodes that need overrides — list ALL of them
      const textNodes = configHints.textNodes || [];
      if (textNodes.length > 0) {
        const placeholders = textNodes.map(t => `"${t.name}" (current: "${t.characters}")`);
        checklist.push({
          action: 'OVERRIDE_ALL_TEXT',
          message: `Override ALL ${textNodes.length} text node(s) with content from the source HTML. No placeholder text allowed.`,
          textNodes: placeholders,
        });
      }

      // Variant properties — list current values so Claude can decide what to change
      const variantProps = configHints.variantProperties || {};
      if (Object.keys(variantProps).length > 0) {
        const variantSummary = Object.entries(variantProps).map(([key, val]) =>
          `${key}: "${val.current}" (options: ${val.values.join(', ')})`
        );
        checklist.push({
          action: 'SET_VARIANTS',
          message: 'Review and set variant properties to match the source HTML.',
          variants: variantSummary,
        });
      }

      // ── Contextual rule injection ─────────────────────────
      // Find stored rules relevant to this component type.
      const compNameLower = compName || '';
      const compWords = compNameLower.split(/[\s:,/]+/).filter(w => w.length >= 3);
      const matchingRules = knowledgeStore.findMatchingRules(compWords, 'component');
      // Also check structure rules (e.g., "cards must have card header")
      const structureRules = knowledgeStore.findMatchingRules(compWords, 'structure');
      const allRules = [...matchingRules, ...structureRules];

      if (allRules.length > 0) {
        checklist.push({
          action: 'APPLY_DESIGN_RULES',
          message: `${allRules.length} user-defined design rule(s) apply to this component. Follow ALL of them.`,
          rules: allRules.map(r => r.rule),
        });
      }

      return {
        nodeId,
        ...result,
        configurationChecklist: checklist.length > 0 ? checklist : undefined,
        _autoApplied: Object.keys(autoApplied).length > 0 ? autoApplied : undefined,
        _rules: allRules.length > 0 ? allRules : undefined,
        hints,
      };
    },
    {
      annotations: { title: 'Insert a DS component instance', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }
  );

  /**
   * v3.0.0 consolidation: figma_set_component_text, figma_set_component_
   * text_by_id, and figma_batch_set_component_text are merged into ONE
   * tool, figma_component_text, taking an `overrides` array (a single
   * override is just an array of one). Each override may carry a
   * textNodeId (routed to the by-id bridge handler individually, since
   * the plugin's batch_set_component_text only matches by name) or a
   * textNodeName (routed through the batch bridge handler as a group,
   * even for N=1 — the batch handler behaves identically to the old
   * single-override tool in that case). Both underlying functions are
   * unchanged extractions of the former standalone handlers' bodies.
   */
  async function applyByIdOverride(nodeId, override) {
    const payload = { nodeId, textNodeId: override.textNodeId, content: override.content, fillVariable: override.fillVariable };
    const result = await bridge.send('set_component_text_by_id', payload);
    surfaceBindingFeedback(result, 'set_component_text_by_id');

    const tracker = session.componentTextTracker?.get(nodeId);
    if (tracker) {
      tracker.overridden.add(override.textNodeId);
      const resultNodeId = result?.nodeId;
      if (resultNodeId) tracker.overridden.add(resultNodeId);
    }

    return {
      ok: !result?.error,
      textNodeId: override.textNodeId,
      ...result,
    };
  }

  async function applyNameOverrides(nodeId, overrides) {
    const result = await bridge.send('batch_set_component_text', { nodeId, overrides });
    surfaceBindingFeedback(result, 'batch_set_component_text');

    const tracker = session.componentTextTracker?.get(nodeId);
    if (tracker && result?.results) {
      for (const r of result.results) {
        if (r.ok) {
          tracker.overridden.add(r.textNodeName);
          if (r.nodeId) tracker.overridden.add(r.nodeId);
        }
      }
    }

    // Learn text node structure for this component
    const compKey = session._nodeComponentKeys?.get(nodeId);
    if (compKey && result?.succeeded > 0) {
      if (!session._textNodeStructures) session._textNodeStructures = new Map();
      const nodeNames = (result.results || [])
        .filter(r => r.ok)
        .map(r => r.textNodeName);
      if (nodeNames.length > 0) {
        session._textNodeStructures.set(compKey, {
          nodeNames,
          count: nodeNames.length,
        });
      }
    }

    return result;
  }

  // ── figma_component_text ───────────────────────────────────────
  registerTool(
    'figma_component_text',
    'Overrides text on a component instance in one call — pass an `overrides` array (a single override is just a one-item array). Each override sets one text node via textNodeName (matches by name — use for most cases) or textNodeId (exact match — use when configurationHints.textNodes gave you IDs, e.g. components with repeated node names). Use after figma_insert_component; configurationHints.textNodes lists every node that needs overriding. Saves N-1 tool calls vs. one call per node. Requires Phase 2.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Component instance node ID.' },
        overrides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              textNodeName: { type: 'string', description: 'Name of the text node within the component. Ignored if textNodeId is set.' },
              textNodeId: { type: 'string', description: 'Exact TEXT node ID from configurationHints.textNodes. Takes precedence over textNodeName — use when component text nodes share the same name.' },
              content: { type: 'string', description: 'New text content.' },
              fillVariable: { type: 'string', description: 'Optional DS text color variable path.' },
            },
            required: ['content'],
          },
          description: 'Array of text overrides to apply. Each item needs textNodeName or textNodeId, plus content.',
        },
      },
      required: ['nodeId', 'overrides'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);

      if (!Array.isArray(args.overrides) || args.overrides.length === 0) {
        return { error: 'EMPTY_OVERRIDES', message: 'overrides array is required and must not be empty.' };
      }

      const byId = args.overrides.filter(o => o.textNodeId);
      const byName = args.overrides.filter(o => !o.textNodeId);

      const results = [];
      let succeeded = 0;
      let failed = 0;
      let anyBindingFailure = false;

      for (const override of byId) {
        const r = await applyByIdOverride(args.nodeId, override);
        session.toolCallCount++;
        results.push(r);
        if (r.ok) succeeded++; else failed++;
        if (r.bindingFailures) anyBindingFailure = true;
      }

      if (byName.length > 0) {
        const batchResult = await applyNameOverrides(args.nodeId, byName);
        session.toolCallCount++;
        succeeded += batchResult?.succeeded || 0;
        failed += batchResult?.failed || 0;
        if (batchResult?.bindingFailures) anyBindingFailure = true;
        results.push(...(batchResult?.results || []));
      }

      return {
        nodeId: args.nodeId,
        total: args.overrides.length,
        succeeded,
        failed,
        results,
        bindingFailures: anyBindingFailure || undefined,
        hint: failed > 0
          ? `${failed} text node(s) not found — check textNodeName/textNodeId against configurationHints.textNodes.`
          : anyBindingFailure
            ? 'All text set but some fill bindings FAILED — check warnings.'
            : `All ${succeeded} text node(s) set.`,
      };
    },
    {
      annotations: { title: 'Override component instance text', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }
  );

  // ── figma_set_variant ─────────────────────────────────────────
  registerTool(
    'figma_set_variant',
    'Sets variant properties (e.g. Size, State, Color) on a component instance. Use figma_inspect (target: "variants") first to see available properties/values for the component set. Params: nodeId (required), properties (required, key-value map e.g. { "Size": "Large" }). Requires Phase 2. Tracks replay success/failure for the knowledge store\'s recipe learning.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Component instance node ID.' },
        properties: {
          type: 'object',
          description: 'Variant property key-value pairs (e.g. { "Size": "Large", "State": "Default" }).',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['nodeId', 'properties'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const result = await bridge.send('set_variant', args);
      session.toolCallCount++;

      // Track variant config for template replay
      if (!session._variantConfigs) session._variantConfigs = new Map();
      const compKey = session._nodeComponentKeys?.get(args.nodeId);
      if (compKey && args.properties) {
        const existing = session._variantConfigs.get(compKey) || {};
        session._variantConfigs.set(compKey, { ...existing, ...args.properties });
      }

      // Inspect appliedProperties for per-key errors (spec §4.4/§4.6, defect
      // B/H) — this is the manual apply path a stale VARIANT recipe self-
      // heals through (auto-apply refuses to fire while stale, so a clean,
      // fully-validated manual re-set is the only way it clears — never
      // just because SOME insert succeeded).
      const appliedProperties = result?.appliedProperties || {};
      const failedProps = Object.entries(appliedProperties)
        .filter(([, v]) => v && typeof v === 'object' && 'error' in v)
        .map(([k]) => k);
      const cleanApply = failedProps.length === 0 && Object.keys(appliedProperties).length > 0;

      // Per-node final-variant tracking (spec §5.1) — only successfully-
      // applied properties count toward this node's final observed state;
      // a later correction on the same node overwrites the earlier value
      // rather than creating a second, competing observation.
      if (args.nodeId && args.properties) {
        const successfulProps = Object.fromEntries(
          Object.entries(args.properties).filter(([k]) => !failedProps.includes(k))
        );
        if (Object.keys(successfulProps).length > 0) {
          if (!session._nodeVariantConfigs) session._nodeVariantConfigs = new Map();
          const existingNodeProps = session._nodeVariantConfigs.get(args.nodeId) || {};
          session._nodeVariantConfigs.set(args.nodeId, { ...existingNodeProps, ...successfulProps });
        }
      }

      if (compKey && knowledgeStore) {
        if (failedProps.length > 0) {
          for (const prop of failedProps) knowledgeStore.recordReplayFailure(compKey, prop);
        } else if (cleanApply) {
          for (const prop of Object.keys(appliedProperties)) knowledgeStore.recordReplaySuccess(compKey, prop);

          const recipe = knowledgeStore.getComponent(compKey);
          if (recipe && recipe.stale && (recipe.staleReason === 'variant_property_removed' || recipe.staleReason === 'variant_value_removed')) {
            // Self-heal only when EVERY stored property this recipe tracks
            // was covered by this clean apply — a partial set (e.g. only
            // "Size" when the recipe also tracks "Color") isn't sufficient
            // evidence the whole recipe is valid again.
            const trackedProps = new Set([
              ...Object.keys(recipe.defaultVariants || {}),
              ...Object.keys(recipe.variantStats || {}),
            ]);
            const coveredAll = [...trackedProps].every((p) => Object.prototype.hasOwnProperty.call(appliedProperties, p));
            if (coveredAll) {
              knowledgeStore.clearRecipeStale(compKey);
              knowledgeStore.restoreAfterCleanReplay(compKey);
            }
          } else {
            knowledgeStore.restoreAfterCleanReplay(compKey);
          }
        }
      }

      return {
        ...result,
        hint: failedProps.length > 0
          ? `Variant set with per-key error(s): ${failedProps.join(', ')} — not treated as a successful replay.`
          : 'Variant set. Use figma_inspect (target: "variants") to see all available variants for this component set.',
      };
    },
    {
      annotations: { title: 'Set component variant properties', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }
  );

  /**
   * v3.0.0 consolidation: figma_swap_main_component absorbs
   * figma_replace_component via a `mode` param. Both took the identical
   * {nodeId, newComponentKey} shape and are near-duplicates at the MCP
   * layer — but they dispatch to genuinely different bridge handlers
   * (swap_main_component preserves instance overrides; replace_component
   * removes the instance and creates a new one at the same position), so
   * the bridge protocol is untouched — this is purely a routing merge.
   */
  registerTool(
    'figma_swap_main_component',
    'Swaps or replaces a component instance\'s underlying component. mode="swap" (default) preserves the instance\'s overrides (text, variants) — use when switching to a close variant of the same component. mode="replace" removes the instance and creates a fresh one at the same position — use when swapping to an unrelated component where old overrides would be invalid. Params: nodeId (required), newComponentKey (required), mode ("swap"|"replace", default "swap"). Requires Phase 2.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Instance node ID.' },
        newComponentKey: { type: 'string', description: 'New component key to swap/replace to.' },
        mode: { type: 'string', enum: ['swap', 'replace'], description: '"swap" preserves overrides (default). "replace" creates a fresh instance at the same position.' },
      },
      required: ['nodeId', 'newComponentKey'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const mode = args.mode === 'replace' ? 'replace' : 'swap';
      const handlerType = mode === 'replace' ? 'replace_component' : 'swap_main_component';
      const result = await bridge.send(handlerType, { nodeId: args.nodeId, newComponentKey: args.newComponentKey });
      session.toolCallCount++;
      return {
        ...result,
        mode,
        hint: mode === 'replace'
          ? 'Component replaced. Set all text overrides and properties on the new instance.'
          : 'Component swapped. Re-apply any text overrides and variant settings.',
      };
    },
    {
      annotations: { title: 'Swap or replace a component instance', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }
  );

  /**
   * v3.0.0 consolidation: figma_fill_slot + figma_reset_slot merge into
   * figma_manage_slot via an `action` param. Both operate on the same
   * SLOT-type component property concept (Figma Slots, GA June 2026) and
   * are structurally near-identical (single bridge call, same phase
   * gate) — the same pattern as the swap/replace merge above.
   */
  registerTool(
    'figma_manage_slot',
    'Fills or resets a SLOT-type component property on an existing instance (Figma Slots, GA June 2026). action="fill" inserts a DS component instance into the slot (use configurationHints.slotProperties from figma_insert_component to find slotName). action="reset" restores the slot\'s default content. Params: nodeId (required), slotName (required), action ("fill"|"reset", default "fill"), componentKey (required for action="fill"). Requires Phase 2. Slot fills are recorded for build-report visibility only — never auto-replayed.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Instance node ID that owns the slot.' },
        slotName: { type: 'string', description: 'SLOT property name from configurationHints.slotProperties.' },
        action: { type: 'string', enum: ['fill', 'reset'], description: '"fill" inserts a component into the slot (default). "reset" restores default content.' },
        componentKey: { type: 'string', description: 'DS component key to insert into the slot. Required for action="fill".' },
      },
      required: ['nodeId', 'slotName'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const action = args.action === 'reset' ? 'reset' : 'fill';

      if (action === 'reset') {
        const result = await bridge.send('reset_slot', { nodeId: args.nodeId, slotName: args.slotName });
        session.toolCallCount++;
        return {
          ...result,
          hint: 'Slot reset to its default content.',
        };
      }

      if (!args.componentKey) {
        return { error: 'MISSING_COMPONENT_KEY', message: 'componentKey is required for action="fill".' };
      }

      if (dsCache.hasFailed(args.componentKey)) {
        return {
          error: 'COMPONENT_PREVIOUSLY_FAILED',
          componentKey: args.componentKey,
          hint: 'This component key failed before. Verify the key is correct and the library is enabled in the file.',
        };
      }

      let result;
      try {
        result = await bridge.send('fill_slot', { nodeId: args.nodeId, slotName: args.slotName, componentKey: args.componentKey });
      } catch (err) {
        const isTimeout = err.message && /timed?\s*out/i.test(err.message);
        dsCache.markFailed(args.componentKey, !isTimeout);
        throw err;
      }
      session.toolCallCount++;

      // Record the slot fill as an OBSERVATION only — spec: SLOT props are
      // never replayed, checklist only (schema-v3-spec.md §4.1). This never
      // feeds figma_insert_component's auto-apply path; it exists purely so
      // the build report / future tooling can see which slots get used and
      // with what, without ever auto-filling a slot on the caller's behalf.
      const hostComponentKey = session._nodeComponentKeys?.get(args.nodeId);
      if (hostComponentKey && knowledgeStore) {
        const recipe = knowledgeStore.getComponent(hostComponentKey)
          || { names: [hostComponentKey], instances: 0, buildCount: 0, componentKey: hostComponentKey, confidence: 'new' };
        recipe.slots = recipe.slots || {};
        const slotEntry = recipe.slots[args.slotName] || { observed: 0 };
        slotEntry.observed = (slotEntry.observed || 0) + 1;
        recipe.slots[args.slotName] = slotEntry;
        knowledgeStore.setComponent(hostComponentKey, recipe);
      }

      return {
        ...result,
        hint: result?.error
          ? result.error
          : 'Slot filled. Override text/variants on the inserted instance as usual — slot fills are recorded for visibility only and are never auto-replayed.',
      };
    },
    {
      annotations: { title: 'Fill or reset a component slot', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }
  );
}

module.exports = { register };
