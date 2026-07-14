'use strict';

const { surfaceBindingFeedback } = require('../utils/binding-feedback');
const { wordBoundaryMatch } = require('../utils/text-match');

const PHASE_HINT = 'Complete DS Discovery and Style Inventory first (call mimic_discover_ds → preload → figma_set_session_defaults).';

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
    'Imports and inserts a DS component instance. Returns component info and configuration hints from the knowledge store.',
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
          hint: 'A previous insert for this component+parent timed out. The component likely EXISTS in Figma already. Call figma_get_node_children on the parent to check. Do NOT retry — duplicates are hard to detect and fix.',
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
                hint: 'Wait 10 seconds, then call figma_get_node_children on the parent to check if the component appeared. If it did, proceed with configuration. If not, try a different component from the same library first (to warm the library cache), then come back to this one.',
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
              hint: 'Wait 10 seconds, then call figma_get_node_children on the parent to check if the component appeared. If it did, proceed with configuration. If not, try a different component from the same library first (to warm the library cache), then come back to this one.',
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
      hints.push('After inserting: override ALL text with figma_set_component_text, set semantic properties, configure icons, hide unused slots.');

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
    }
  );

  // ── figma_set_component_text ──────────────────────────────────
  registerTool(
    'figma_set_component_text',
    'Sets text on a component instance by finding a text node with the given name. Prefer figma_set_component_text_by_id when configurationHints include text node IDs, because many components contain repeated text node names.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Component instance node ID.' },
        textNodeName: { type: 'string', description: 'Name of the text node within the component.' },
        content: { type: 'string', description: 'New text content.' },
      },
      required: ['nodeId', 'textNodeName', 'content'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const result = await bridge.send('set_component_text', args);
      session.toolCallCount++;
      surfaceBindingFeedback(result, 'set_component_text');

      // Track override — match by component nodeId + text node name
      const tracker = session.componentTextTracker?.get(args.nodeId);
      if (tracker) {
        const resultNodeId = result?.nodeId;
        if (resultNodeId) tracker.overridden.add(resultNodeId);
        tracker.overridden.add(args.textNodeName);
      }

      return {
        ...result,
        hint: result?.bindingFailures
          ? 'Text set but fill variable binding FAILED — check warnings.'
          : 'Text set. Remember to override ALL text nodes — no placeholder content allowed.',
      };
    }
  );

  // ── figma_set_component_text_by_id ────────────────────────────
  registerTool(
    'figma_set_component_text_by_id',
    'Sets text on a component instance using an exact text node ID from configurationHints.textNodes. Use this instead of name-based text overrides when available.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Component instance node ID that should contain the text node.' },
        textNodeId: { type: 'string', description: 'Exact TEXT node ID from configurationHints.textNodes.' },
        content: { type: 'string', description: 'New text content.' },
        fillVariable: { type: 'string', description: 'Optional DS text color variable path.' },
      },
      required: ['nodeId', 'textNodeId', 'content'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const result = await bridge.send('set_component_text_by_id', args);
      session.toolCallCount++;
      surfaceBindingFeedback(result, 'set_component_text_by_id');

      // Track override — match by component nodeId + exact text node ID
      const tracker = session.componentTextTracker?.get(args.nodeId);
      if (tracker) {
        tracker.overridden.add(args.textNodeId);
        const resultNodeId = result?.nodeId;
        if (resultNodeId) tracker.overridden.add(resultNodeId);
      }

      return {
        ...result,
        hint: result?.bindingFailures
          ? 'Text set by ID but fill variable binding FAILED — check warnings.'
          : 'Text set by exact node ID.',
      };
    }
  );

  // ── figma_batch_set_component_text ─────────────────────────────
  registerTool(
    'figma_batch_set_component_text',
    'Sets ALL text overrides on a component instance in a single call. Pass an array of {textNodeName, content} overrides. Saves 1 tool call per text node vs. individual figma_set_component_text calls. Use after figma_insert_component — configurationHints.textNodes tells you which nodes to override.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Component instance node ID.' },
        overrides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              textNodeName: { type: 'string', description: 'Name of the text node within the component.' },
              content: { type: 'string', description: 'New text content.' },
              fillVariable: { type: 'string', description: 'Optional DS text color variable path.' },
            },
            required: ['textNodeName', 'content'],
          },
          description: 'Array of text overrides to apply.',
        },
      },
      required: ['nodeId', 'overrides'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const result = await bridge.send('batch_set_component_text', args);
      session.toolCallCount++;
      surfaceBindingFeedback(result, 'batch_set_component_text');

      // Track overrides — mark all successful text nodes as overridden
      const tracker = session.componentTextTracker?.get(args.nodeId);
      if (tracker && result?.results) {
        for (const r of result.results) {
          if (r.ok) {
            tracker.overridden.add(r.textNodeName);
            if (r.nodeId) tracker.overridden.add(r.nodeId);
          }
        }
      }

      // Learn text node structure for this component
      const compKey = session._nodeComponentKeys?.get(args.nodeId);
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

      const failed = result?.failed || 0;
      return {
        ...result,
        hint: failed > 0
          ? `${failed} text node(s) not found — check textNodeName spelling against configurationHints.textNodes.`
          : result?.bindingFailures
            ? 'All text set but some fill bindings FAILED — check warnings.'
            : `All ${result?.succeeded || 0} text node(s) set in one call.`,
      };
    }
  );

  // ── figma_set_variant ─────────────────────────────────────────
  registerTool(
    'figma_set_variant',
    'Sets variant properties on a component instance.',
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
          : 'Variant set. Use figma_get_component_variants to see all available variants for this component set.',
      };
    }
  );

  // ── figma_swap_main_component ─────────────────────────────────
  registerTool(
    'figma_swap_main_component',
    'Swaps the main component of an instance to a different component.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Instance node ID.' },
        newComponentKey: { type: 'string', description: 'New component key to swap to.' },
      },
      required: ['nodeId', 'newComponentKey'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const result = await bridge.send('swap_main_component', args);
      session.toolCallCount++;
      return {
        ...result,
        hint: 'Component swapped. Re-apply any text overrides and variant settings.',
      };
    }
  );

  // ── figma_replace_component ───────────────────────────────────
  registerTool(
    'figma_replace_component',
    'Replaces an instance node with a new component instance at the same position.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Instance node ID to replace.' },
        newComponentKey: { type: 'string', description: 'New component key.' },
      },
      required: ['nodeId', 'newComponentKey'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const result = await bridge.send('replace_component', args);
      session.toolCallCount++;
      return {
        ...result,
        hint: 'Component replaced. Set all text overrides and properties on the new instance.',
      };
    }
  );
}

module.exports = { register };
