'use strict';

/**
 * Infer a variable's category from its path, resolved type, and collection name.
 * Categories: text, background, border, foreground, spacing, radius, etc.
 */
function inferCategory(path, resolvedType, collection) {
  const p = (path || '').toLowerCase();
  const col = (collection || '').toLowerCase();

  // Spacing / radius from collection name or path
  if (col.includes('spacing') || p.startsWith('sp-') || p.includes('spacing')) return 'spacing';
  if (col.includes('radius') || p.startsWith('radius') || p.includes('corner')) return 'radius';

  // Color categories from path prefix or any segment in the path
  if (resolvedType === 'COLOR') {
    if (p.startsWith('text-') || p.startsWith('fg-text') || p.includes('/text/') || p.includes('/text-')) return 'text';
    if (p.startsWith('bg-') || p.startsWith('background') || p.includes('/background/') || p.includes('/bg-')) return 'background';
    if (p.startsWith('border-') || p.startsWith('stroke') || p.includes('/border/') || p.includes('/border-')) return 'border';
    if (p.startsWith('fg-') || p.startsWith('foreground') || p.includes('/foreground/') || p.includes('/fg-') || p.startsWith('icon')) return 'foreground';
    return 'color';
  }

  if (resolvedType === 'FLOAT') {
    if (p.includes('spacing') || p.includes('gap') || p.includes('padding')) return 'spacing';
    if (p.includes('radius') || p.includes('corner')) return 'radius';
    if (p.includes('size') || p.includes('font')) return 'typography';
    return 'number';
  }

  return null;
}

/**
 * v3.0.0 consolidation: the 7 manual DS discovery/preload escape hatches
 * (figma_discover_library_styles, figma_discover_library_variables,
 * figma_discover_library_components, figma_preload_styles,
 * figma_preload_variables, figma_preload_fill_styles,
 * figma_set_session_defaults) are merged into ONE tool, `mimic_ds_assets`,
 * dispatched by {action, kind}. mimic_discover_ds already orchestrates all
 * of this internally for the normal build flow — these functions remain
 * as the manual escape hatch for edge cases (partial discovery, community
 * libraries, re-preloading after a cache miss).
 *
 * Each function below is a straight extraction of the former standalone
 * handler's body — same bridge calls, same cache writes, same response
 * shape — so mimic_ds_assets's dispatch is a pure routing layer with zero
 * behavior changes.
 */
function register(server, context) {
  const { bridge, dsCache, dsResolver, knowledgeStore, session, advancePhase, registerTool } = context;

  // ── discover: styles ───────────────────────────────────────────
  async function discoverStyles(args) {
    const result = await bridge.send('discover_library_styles', { fileKey: args.fileKey });
    session.toolCallCount++;

    if (result && result.styles) {
      for (const style of result.styles) {
        dsCache.addTextStyle(style.key, style);
      }
    }

    return {
      discovered: result?.styles?.length || 0,
      totalCached: dsCache.textStyles.size,
      result,
      hint: 'Styles discovered. Next: mimic_ds_assets({ action: "discover", kind: "variables", fileKey }).',
    };
  }

  // ── discover: variables ──────────────────────────────────────────
  async function discoverVariables(args) {
    const result = await bridge.send('discover_library_variables', { fileKey: args.fileKey });
    session.toolCallCount++;

    if (result && result.variables) {
      // Cache in MCP-side dsCache
      for (const v of result.variables) {
        const path = v.path || v.name;
        const category = v.category || inferCategory(path, v.resolvedType, v.collection);
        dsCache.addVariable(path, {
          key: v.key,
          collection: v.collection || null,
          category,
          libraryName: v.libraryName || null,
        });
      }

      // Auto-preload into plugin cache so getVariableByPath() can resolve them.
      // Without this, bindFillVariable/bindVariable silently fail because
      // library variables aren't in local collections — they must be imported
      // via importVariableByKeyAsync and cached.
      const variableEntries = result.variables
        .filter(v => v.key)
        .map(v => ({ path: v.path || v.name, key: v.key }));
      if (variableEntries.length > 0) {
        try {
          await bridge.send('preload_variables', { variables: variableEntries });
        } catch (e) {
          // Non-fatal: variables will need manual preload via
          // mimic_ds_assets({ action: 'preload', kind: 'variables' }).
        }
      }
    }

    const enforcement = dsCache.getEnforcementProfile();
    return {
      discovered: result?.variables?.length || 0,
      totalCached: dsCache.variables.size,
      libraries: result?.libraries || [],
      _rawCollections: result?._rawCollections || [],
      enforcement,
      hint: 'Variables discovered. Call mimic_ds_assets({ action: "set_defaults" }) to finalize enforcement and advance to build phase.',
    };
  }

  // ── discover: components ─────────────────────────────────────────
  async function discoverComponents(args) {
    const result = await bridge.send('discover_library_components', { fileKey: args.fileKey });
    session.toolCallCount++;

    // Cache discovered components
    if (result && result.components) {
      for (const comp of result.components) {
        dsCache.addComponent(comp.key, {
          name: comp.name,
          isRemote: comp.isRemote,
          isComponentSet: comp.isComponentSet,
          variantCount: comp.variantCount,
          variantProperties: comp.variantProperties,
          description: comp.description,
        });
      }
    }

    return {
      discovered: result?.totalFound || 0,
      instancesScanned: result?.totalInstancesScanned || 0,
      totalCached: dsCache.components.size,
      components: (result?.components || []).map(c => ({
        key: c.key,
        name: c.name,
        variantCount: c.variantCount,
        variantProperties: c.variantProperties?.map(vp => vp.name) || [],
      })),
      selectedLibrary: session.selectedLibraryKey || null,
      hint: result?.totalFound > 0
        ? `${result.totalFound} components discovered. Use these keys with figma_insert_component. For components not found here, use Figma MCP search_design_system to find them by name.${session.selectedLibraryKey ? ` ONLY use components from "${session.selectedLibraryKey}".` : ''}`
        : `No component instances on this page. Use Figma MCP search_design_system to find library components by name (search: button, input, badge, table cell, tabs, avatar, dropdown, textarea).${session.selectedLibraryKey ? ` ONLY use components from "${session.selectedLibraryKey}".` : ''}`,
    };
  }

  // ── preload: styles ──────────────────────────────────────────────
  async function preloadStyles(args) {
    const result = await bridge.send('preload_styles', { styleKeys: args.styleKeys });
    session.toolCallCount++;

    // Cache the styles returned by the plugin
    if (result && result.styles) {
      for (const style of result.styles) {
        dsCache.addTextStyle(style.key, style);
      }
    }

    const cached = result?.preloadedStyles || 0;
    const expectedCount = args.expectedCount || null;
    if (expectedCount) session.expectedStyleCount = expectedCount;
    const warning = expectedCount && cached < expectedCount * 0.8
      ? `Partial load: ${cached}/${expectedCount} styles cached. Proceed with available styles. Missing styles will be flagged in the report.`
      : null;

    return {
      cached,
      expectedStyles: expectedCount,
      warning,
      result,
      hint: 'Styles preloaded. Next: mimic_ds_assets({ action: "preload", kind: "variables" }).',
    };
  }

  // ── preload: variables ────────────────────────────────────────────
  async function preloadVariables(args) {
    if (!args.variables || !Array.isArray(args.variables)) {
      return { error: 'MISSING_VARIABLES', message: 'variables array is required. Use mimic_ds_assets({ action: "discover", kind: "variables" }) first to get the variable list.' };
    }
    for (const v of args.variables) {
      dsCache.addVariable(v.path, {
        key: v.key,
        collection: v.collection || null,
        category: v.category || null,
      });
    }

    // Send variable paths + keys to plugin for import
    const variableEntries = args.variables.map(v => ({ path: v.path, key: v.key }));
    const pluginResult = await bridge.send('preload_variables', { variables: variableEntries });
    session.toolCallCount++;

    const enforcement = dsCache.getEnforcementProfile();
    const cached = dsCache.variables.size;
    const expectedCount = args.expectedCount || null;
    const warning = expectedCount && cached < expectedCount * 0.8
      ? `Partial load: ${cached}/${expectedCount} variables cached. Proceed with available variables. Missing variables will be flagged in the report.`
      : null;

    return {
      cached,
      expectedVariables: expectedCount,
      warning,
      pluginImported: pluginResult?.preloadedVars || 0,
      enforcement,
      hint: 'Variables cached. Next: mimic_ds_assets({ action: "set_defaults" }) to finalize the enforcement profile and advance to phase 2.',
    };
  }

  // ── preload: fill_styles ──────────────────────────────────────────
  async function preloadFillStyles(args) {
    const figmaRest = context.figmaRest;
    if (!figmaRest) {
      return { error: 'FIGMA_TOKEN_REQUIRED', message: 'FIGMA_TOKEN not configured.' };
    }
    let fillCount = 0;
    let effectCount = 0;
    const fillKeys = [];
    try {
      const allStyles = await figmaRest.getAllStyles(args.libraryFileKey);
      for (const s of allStyles.fillStyles) {
        dsCache.addFillStyle(s.key, { name: s.name, description: s.description, source: 'rest_api' });
        fillKeys.push(s.key);
        fillCount++;
      }
      for (const s of allStyles.effectStyles) {
        dsCache.addEffectStyle(s.key, { name: s.name, description: s.description, source: 'rest_api' });
        effectCount++;
      }
    } catch (e) {
      return { error: 'FETCH_FAILED', message: e.message || 'Failed to fetch styles.' };
    }

    // Pre-import fill styles into the Figma plugin's styleCache
    // This prevents timeout on first use during builds
    let pluginPreloaded = 0;
    if (fillKeys.length > 0) {
      try {
        const preloadResult = await bridge.send('preload_fill_styles', { styleKeys: fillKeys });
        pluginPreloaded = preloadResult?.preloadedFillStyles || 0;
      } catch (e) { /* non-fatal — styles will be imported on first use */ }
    }

    session.toolCallCount++;
    const enforcement = dsCache.getEnforcementProfile();
    return {
      fillStylesCached: fillCount,
      effectStylesCached: effectCount,
      pluginPreloaded,
      enforcement,
      hint: `${fillCount} fill styles + ${effectCount} effect styles cached. ${pluginPreloaded} pre-imported in plugin. Use fillStyleId in create_frame, create_text, figma_create_shape, or figma_update_node. Call figma_list_ds({ kind: "fill_styles" }) to browse them.`,
    };
  }

  // ── set_defaults ───────────────────────────────────────────────────
  async function setSessionDefaults(args) {
    const enforcement = dsCache.getEnforcementProfile();
    const dsMode = args.dsMode || (dsCache.variables.size > 0 ? 'strict' : 'permissive');

    if (dsMode === 'permissive' && dsCache.variables.size > 0) {
      return {
        error: 'DS_MODE_REJECTED',
        message: 'Cannot use permissive mode when DS has tokens. Strict mode is required.',
        enforcement,
      };
    }

    session.enforcementProfile = { ...enforcement, dsMode };

    const result = await bridge.send('set_session_defaults', {
      enforcementProfile: session.enforcementProfile,
    });

    advancePhase(2);
    session.toolCallCount++;

    return {
      phase: session.phase,
      enforcement: session.enforcementProfile,
      pluginResult: result,
      hint: 'Inventory complete. You can now build. Use figma_create_frame to start your artboard.',
    };
  }

  // ── mimic_ds_assets ────────────────────────────────────────────────
  registerTool(
    'mimic_ds_assets',
    'Manual escape hatch for DS discovery/preload/finalize — the low-level building blocks mimic_discover_ds already orchestrates automatically. Use this ONLY when the automatic flow needs a targeted redo: re-discovering one asset kind after a partial load, preloading variables/styles/fill-styles fetched some other way, or manually finalizing the enforcement profile. Params: action ("discover"|"preload"|"set_defaults"), kind ("styles"|"variables"|"components"|"fill_styles", required for discover/preload), plus action-specific params (fileKey for discover, styleKeys/variables/libraryFileKey for preload, dsMode for set_defaults). Workflow position: DS Discovery / Style Inventory (Phase 1-2), before building.',
    {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['discover', 'preload', 'set_defaults'],
          description: '"discover" fetches DS assets from a library file. "preload" caches assets you already have. "set_defaults" computes the enforcement profile and advances to Phase 2.',
        },
        kind: {
          type: 'string',
          enum: ['styles', 'variables', 'components', 'fill_styles'],
          description: 'Which DS asset kind. Required for "discover" (styles|variables|components) and "preload" (styles|variables|fill_styles). Not used by "set_defaults".',
        },
        fileKey: { type: 'string', description: 'Library file key. Required for action="discover".' },
        styleKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Text style keys to preload. Required for action="preload", kind="styles".',
        },
        variables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Variable path (e.g. "bg-primary").' },
              key: { type: 'string', description: 'Variable key from Figma.' },
              collection: { type: 'string', description: 'Collection name.' },
              category: { type: 'string', description: 'Category: text, background, border, foreground, spacing, radius, etc.' },
            },
            required: ['path', 'key'],
          },
          description: 'Variables to cache. Required for action="preload", kind="variables".',
        },
        libraryFileKey: { type: 'string', description: 'Library file key to fetch fill styles from. Required for action="preload", kind="fill_styles".' },
        expectedCount: {
          type: 'number',
          description: 'Total number of styles/variables expected (from Figma MCP search results). Used to detect partial loads. Optional, for action="preload".',
        },
        dsMode: {
          type: 'string',
          enum: ['strict', 'permissive'],
          description: 'DS enforcement mode for action="set_defaults". Defaults to strict when DS has tokens.',
        },
      },
      required: ['action'],
    },
    async (args) => {
      const { action, kind } = args;

      if (action === 'set_defaults') return setSessionDefaults(args);

      if (!kind) {
        return { error: 'MISSING_KIND', message: `action="${action}" requires a "kind" param.` };
      }

      if (action === 'discover') {
        if (!args.fileKey) return { error: 'MISSING_FILE_KEY', message: 'fileKey is required for action="discover".' };
        if (kind === 'styles') return discoverStyles(args);
        if (kind === 'variables') return discoverVariables(args);
        if (kind === 'components') return discoverComponents(args);
        return { error: 'INVALID_KIND', message: `kind="${kind}" is not valid for action="discover". Use styles, variables, or components.` };
      }

      if (action === 'preload') {
        if (kind === 'styles') return preloadStyles(args);
        if (kind === 'variables') return preloadVariables(args);
        if (kind === 'fill_styles') return preloadFillStyles(args);
        return { error: 'INVALID_KIND', message: `kind="${kind}" is not valid for action="preload". Use styles, variables, or fill_styles.` };
      }

      return { error: 'INVALID_ACTION', message: `Unknown action "${action}". Use discover, preload, or set_defaults.` };
    },
    {
      annotations: { title: 'Manage DS assets (discover/preload/finalize)', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }
  );

  // ── figma_list_ds ───────────────────────────────────────────────────
  registerTool(
    'figma_list_ds',
    'Lists cached DS assets from the local cache — text styles, fill (color) styles, or variables. Use to browse what mimic_discover_ds already cached before binding: find a textStyleId for figma_create_text, a fillStyleId for figma_create_shape, or a variable path for figma_update_node. Params: kind ("text_styles"|"fill_styles"|"variables", required), filter (keyword, fill_styles only), category (text|background|border|foreground|spacing|radius, variables only). Read-only.',
    {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['text_styles', 'fill_styles', 'variables'],
          description: 'Which cache to list.',
        },
        filter: { type: 'string', description: 'Optional keyword filter on the style name. Only used with kind="fill_styles" (e.g. "Blue", "Gray", "Red").' },
        category: { type: 'string', description: 'Optional category filter. Only used with kind="variables" (text, background, border, foreground, spacing, radius). Omit for all.' },
      },
      required: ['kind'],
    },
    async (args) => {
      session.toolCallCount++;

      if (args.kind === 'text_styles') {
        const styles = [];
        for (const [key, style] of dsCache.textStyles) {
          styles.push({ key, ...style });
        }
        const totalExpected = session.expectedStyleCount || null;
        return {
          kind: 'text_styles',
          count: styles.length,
          totalExpected,
          partial: totalExpected ? styles.length < totalExpected * 0.8 : false,
          styles,
          hint: styles.length === 0
            ? 'No text styles cached. Call mimic_ds_assets({ action: "preload", kind: "styles" }) or mimic_ds_assets({ action: "discover", kind: "styles" }) first.'
            : totalExpected && styles.length < totalExpected * 0.8
              ? `Partial list: ${styles.length}/${totalExpected} styles. Proceed with available styles.`
              : 'Use the style key in figma_create_text or figma_update_node (op: "text", textStyleId).',
        };
      }

      if (args.kind === 'fill_styles') {
        const styles = [];
        const filter = args.filter ? args.filter.toLowerCase() : null;
        for (const [key, style] of dsCache.fillStyles) {
          if (filter && !(style.name || '').toLowerCase().includes(filter)) continue;
          styles.push({ key, ...style });
        }
        return {
          kind: 'fill_styles',
          count: styles.length,
          totalCached: dsCache.fillStyles.size,
          styles,
          hint: styles.length === 0
            ? 'No fill styles cached. Run discovery with a library file key to fetch fill styles.'
            : 'Use the style key as fillStyleId in figma_create_frame, figma_create_text, figma_create_shape, or figma_update_node.',
        };
      }

      if (args.kind === 'variables') {
        if (args.category) {
          const variables = dsResolver.listByCategory(args.category);
          return {
            kind: 'variables',
            category: args.category,
            count: variables.length,
            variables,
          };
        }

        const all = [];
        for (const [path, variable] of dsCache.variables) {
          all.push({ path, ...variable });
        }
        return {
          kind: 'variables',
          count: all.length,
          variables: all,
        };
      }

      return { error: 'INVALID_KIND', message: `Unknown kind "${args.kind}". Use text_styles, fill_styles, or variables.` };
    },
    {
      annotations: { title: 'List cached DS assets', readOnlyHint: true, idempotentHint: true },
    }
  );

  // ── mimic_map_components ──────────────────────────────────────
  registerTool(
    'mimic_map_components',
    'Maps HTML element types (button, input, badge, table, tab, avatar, dropdown, textarea, header, footer, sidebar, ...) to DS component keys for the current build. Call once after mimic_discover_ds with all section-level + control element types. With FIGMA_TOKEN configured, one call is enough — all library components are pre-cached and missing types are confirmed gaps. Without a token, call again with librarySearchResults (from Figma MCP search_design_system) to close the loop. Workflow position: Phase 1-2, right after DS discovery, before figma_insert_component.',
    {
      type: 'object',
      properties: {
        elementTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of HTML element types to map (e.g. ["button", "input", "badge", "table", "tab", "avatar", "dropdown", "textarea"]).',
        },
        librarySearchResults: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Component name from search results.' },
              componentKey: { type: 'string', description: 'Component key from search results.' },
              libraryName: { type: 'string', description: 'Library name the component belongs to.' },
              assetType: { type: 'string', description: 'Component type: "component" or "component_set".' },
            },
          },
          description: 'Component search results from Figma MCP search_design_system. Pass ALL results from your searches (any library — they will be filtered). This completes the search loop: matched components get cached, unmatched types get confirmed as "no component exists".',
        },
      },
      required: ['elementTypes'],
    },
    async (args) => {
      const { DsDiscovery } = require('../ds/discovery');
      const discovery = new DsDiscovery(bridge, dsCache, knowledgeStore);
      if (session.selectedLibraryKey) {
        discovery.setLibrary(session.selectedLibraryKey);
      }

      // If library search results are provided, ingest them into the cache first.
      // This closes the feedback loop: search → ingest → re-map → done.
      let ingested = 0;
      const hasLibrarySearchResults = Array.isArray(args.librarySearchResults);
      if (hasLibrarySearchResults) {
        ingested = discovery.ingestLibrarySearchResults(args.librarySearchResults);
      }

      // REST API discovery caches ALL library components — if present,
      // the first call already has full coverage, so missing = confirmed gap.
      const hasRestComponents = [...dsCache.components.values()].some(c => c.source === 'rest_api');
      const searchComplete = hasLibrarySearchResults || hasRestComponents;

      const map = discovery.buildComponentMap(args.elementTypes, {
        librarySearchComplete: searchComplete,
      });

      // If multi-library prompt, return it
      if (map.multipleLibraries) return map;

      const found = [];
      const missing = [];
      for (const [type, result] of Object.entries(map)) {
        if (result.found) {
          found.push({
            elementType: type,
            componentKey: result.componentKey,
            componentName: result.componentName || result.recipe?.name,
            source: result.source,
            isComponentSet: result.isComponentSet,
          });
        } else {
          missing.push({
            elementType: type,
            searchTerms: result.searchTerms || [type],
            message: result.message,
            fallbackRequired: Boolean(result.fallbackRequired),
            fallbackHint: result.fallbackHint,
            searchComplete: Boolean(result.searchComplete),
          });
        }
      }

      session.componentMap = {
        generatedAt: new Date().toISOString(),
        requested: args.elementTypes,
        components: found,
        notFound: missing,
      };

      // Build library filter guidance for Figma MCP searches
      const selectedLib = session.selectedLibraryKey || null;
      const libFilter = selectedLib
        ? ` Filter results to ONLY "${selectedLib}" — ignore components from other libraries.`
        : '';
      const libSearchNote = selectedLib
        ? `IMPORTANT: Only use components from "${selectedLib}". When calling Figma MCP search_design_system, check libraryName in results and discard any that don't match.`
        : '';

      // After search is complete, all missing types are confirmed gaps — no more searching needed
      if (searchComplete) {
        const newlyFound = ingested > 0 ? found.filter(f => f.source === 'ds_cache') : [];

        // Shell component recommendations — these are structural chrome
        // that every DS should have. If missing, surface a recommendation.
        const shellTypes = ['sidebar', 'header', 'footer', 'navigation'];
        const missingShell = missing.filter(m =>
          shellTypes.some(s => m.elementType.toLowerCase().includes(s))
        );
        const shellRecommendations = missingShell.length > 0
          ? {
            _shellRecommendation: {
              missing: missingShell.map(m => m.elementType),
              message: `Your DS is missing shell components: ${missingShell.map(m => m.elementType).join(', ')}. These define your app's structural chrome (navigation, layout frame) and should be consistent across all screens.`,
              recommendation: 'Create these as component sets in your DS library. Shell components ensure every screen built with Mimic uses the same navigation, header, and footer — matching your production app. Once published, Mimic will use them automatically.',
            },
          }
          : {};

        return {
          mapped: found.length,
          missing: missing.length,
          selectedLibrary: selectedLib,
          searchComplete: true,
          componentsIngested: ingested,
          components: found,
          notFound: missing.map(m => ({
            ...m,
            // Override hints — search is done, proceed with primitives
            fallbackHint: `No DS component for "${m.elementType}". Build as primitive frame with DS variables. Use confirmedNoComponent: true, primitiveOverrideReason: "No ${m.elementType} component in ${selectedLib || 'DS'} library".`,
          })),
          ...(libSearchNote ? { _libraryConstraint: libSearchNote } : {}),
          ...shellRecommendations,
          hint: missing.length > 0
            ? `Library search complete. ${found.length} components mapped, ${missing.length} confirmed gaps: ${missing.map(m => m.elementType).join(', ')}. Build these as primitive frames with DS variables — use confirmedNoComponent: true and primitiveOverrideReason for each. Proceed to build.`
            : 'All element types mapped to DS components. Use the componentKey values with figma_insert_component.',
        };
      }

      // First call (no search results yet) — identify section-level elements that are missing
      const sectionTypes = ['header', 'footer', 'sidebar', 'navigation', 'nav'];
      const missingSections = missing.filter(m => sectionTypes.some(s => m.elementType.toLowerCase().includes(s)));

      return {
        mapped: found.length,
        missing: missing.length,
        selectedLibrary: selectedLib,
        searchComplete: false,
        components: found,
        notFound: missing.map(m => ({
          ...m,
          fallbackHint: (m.fallbackHint || `Search the library using Figma MCP search_design_system with terms: ${m.searchTerms.join(', ')}.`) + libFilter,
        })),
        _componentFirstReminder: missing.length > 0
          ? `${missing.length} element type(s) not found in page instances. Search the DS library ONE TIME via Figma MCP search_design_system for the missing types. Then call mimic_map_components AGAIN with the same elementTypes + librarySearchResults containing ALL component results. That second call will finalize the mapping and confirm any gaps.${libFilter}`
          : undefined,
        _missingSectionWarning: missingSections.length > 0
          ? `Section-level elements missing: ${missingSections.map(m => m.elementType).join(', ')}. Include these in your library search.${libFilter}`
          : undefined,
        ...(libSearchNote ? { _libraryConstraint: libSearchNote } : {}),
        hint: missing.length > 0
          ? `${missing.length} element types not found in page instances. NEXT STEP: Search the DS library via Figma MCP search_design_system for: ${missing.map(m => m.elementType).join(', ')}. Then call mimic_map_components again with librarySearchResults to close the loop.${libFilter}`
          : 'All element types mapped to DS components. Use the componentKey values with figma_insert_component.',
      };
    },
    {
      annotations: { title: 'Map HTML elements to DS components', readOnlyHint: false, idempotentHint: false },
      outputSchema: {
        type: 'object',
        properties: {
          mapped: { type: 'number' },
          missing: { type: 'number' },
          selectedLibrary: { type: ['string', 'null'] },
          searchComplete: { type: 'boolean' },
          components: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                elementType: { type: 'string' },
                componentKey: { type: 'string' },
                componentName: { type: 'string' },
                source: { type: 'string' },
                isComponentSet: { type: 'boolean' },
              },
            },
          },
          notFound: { type: 'array', items: { type: 'object' } },
          hint: { type: 'string' },
        },
      },
    }
  );
}

module.exports = { register, inferCategory };
