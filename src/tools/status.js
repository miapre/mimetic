'use strict';

const { DsDiscovery } = require('../ds/discovery');

const PHASE_LABELS = {
  0: 'idle',
  1: 'discovery',
  2: 'inventory',
  3: 'build',
  4: 'qa',
  5: 'report',
};

const PHASE_HINTS = {
  0: 'Call mimic_discover_ds with a fileKey to start DS discovery.',
  1: 'Discovery in progress. Preload styles and variables, then call figma_set_session_defaults to advance to inventory.',
  2: 'DS inventory ready. You can now create frames, insert components, and build.',
  3: 'Build in progress. Use build/component/edit tools. When done, call mimic_generate_build_report — the build is NOT complete until the report is generated.',
  4: 'QA phase. Inspect nodes, verify DS compliance, fix issues. Then call mimic_generate_build_report.',
  5: 'Build complete. Report generated.',
};

function register(server, context) {
  const { bridge, dsCache, knowledgeStore, session, advancePhase, resetSession, registerTool } = context;

  // ── mimic_status ──────────────────────────────────────────────
  registerTool(
    'mimic_status',
    'Returns plugin connection status, current build phase, enforcement profile, knowledge store summary, and a contextual hint for what to do next.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      let pluginConnected = false;
      try {
        pluginConnected = bridge.connected;
      } catch { /* ignore */ }

      const enforcement = dsCache.getEnforcementProfile();
      const knowledgeSummary = {
        components: Object.keys(knowledgeStore.data.components).length,
        patterns: Object.keys(knowledgeStore.data.patterns).length,
        gaps: Object.keys(knowledgeStore.data.gaps).length,
        buildCount: knowledgeStore.data.meta.buildCount,
      };

      // Report pending warning: if we're in Phase 3/4 and have done build ops, remind about the report
      const buildOps = session.phaseToolCalls[3] || 0;
      const reportPending = session.phase >= 3 && session.phase < 5 && buildOps > 0;

      return {
        pluginConnected,
        phase: session.phase,
        phaseLabel: PHASE_LABELS[session.phase] || 'unknown',
        hint: PHASE_HINTS[session.phase] || 'Unknown phase.',
        artboardId: session.artboardId,
        enforcementProfile: session.enforcementProfile || enforcement,
        toolCallCount: session.toolCallCount,
        cacheHits: session.cacheHits,
        dsCache: {
          textStyles: dsCache.textStyles.size,
          variables: dsCache.variables.size,
          components: dsCache.components.size,
          failedKeys: dsCache.failedKeys.size,
        },
        knowledge: knowledgeSummary,
        ...(reportPending ? {
          reportPending: true,
          reportWarning: `⚠ BUILD REPORT REQUIRED: ${buildOps} build operations completed but no report generated. The build is NOT complete until you call mimic_generate_build_report. This is the tool's key differentiator — it teaches users about their DS usage, gaps, and patterns.`,
        } : {}),
      };
    }
  );

  // ── mimic_discover_ds ─────────────────────────────────────────
  registerTool(
    'mimic_discover_ds',
    'Complete DS discovery in two steps. Step 1: call with fileKey — discovers variables, text styles, components via plugin API, caches everything, stays at Phase 1. Step 2: call again with communitySearchResults (library names from Figma MCP search_design_system) — verifies no community libraries were missed, then advances to Phase 2 (build-ready). Build tools are BLOCKED until Step 2 completes. If a community library\'s variables are not discoverable via the plugin API (communityVariablesRequired response), fetch them via Figma MCP search_design_system and pass as externalVariables.',
    {
      type: 'object',
      properties: {
        fileKey: { type: 'string', description: 'Figma file key to discover DS from.' },
        libraryKey: { type: 'string', description: 'Library key to use when multiple DS libraries are available. Returned from a previous call that detected multiple libraries.' },
        communitySearchResults: {
          type: 'array',
          items: { type: 'string' },
          description: 'Unique library names found via Figma MCP search_design_system (query "color", includeVariables: true). Required after initial discovery to verify no community libraries were missed. Pass only non-null libraryName values.',
        },
        communitySearchVariableKeys: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Map of libraryName → one sample variable key from search results. Used to validate which libraries are actually enabled in the file. Extract one key per library from the color search results.',
        },
        externalVariables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Variable name/path (e.g. "colors/content/content1").' },
              key: { type: 'string', description: 'Variable key from Figma MCP search results.' },
              resolvedType: { type: 'string', description: 'Variable type: COLOR, FLOAT, STRING, BOOLEAN.' },
              collection: { type: 'string', description: 'Collection name (e.g. "palette", "spacing").' },
              libraryName: { type: 'string', description: 'Library name the variable belongs to.' },
            },
          },
          description: 'Variables fetched via Figma MCP search_design_system for community libraries whose variables are not discoverable via the plugin API. Pass after receiving a communityVariablesRequired response.',
        },
      },
      required: ['fileKey'],
    },
    async (args) => {
      const discovery = new DsDiscovery(bridge, dsCache, knowledgeStore);

      // ── Variable mismatch confirmation flow ─────────────────────
      // If we're waiting for the user to confirm the variable source mismatch,
      // handle their choice before anything else.
      if (session.pendingVariableMismatchConfirmation && args.libraryKey) {
        session.toolCallCount++;
        const choice = args.libraryKey.trim().toUpperCase();
        const sourceLibs = session.variableMismatchSourceLibs || [];

        if (choice === 'A' || choice.startsWith('A)') || choice.toLowerCase().includes('continue') || choice.toLowerCase().includes('mixed')) {
          // Accept mixed sources — advance to Phase 2 with current selection
          session.pendingVariableMismatchConfirmation = false;
          session.variableMismatchSourceLibs = null;
          session.variableSourceConfirmed = 'mixed';
          advancePhase(2);

          const variablesCached = dsCache.variables.size;
          const stylesCached = dsCache.textStyles.size;
          const componentsCached = dsCache.components.size;

          return {
            phase: session.phase,
            phaseLabel: PHASE_LABELS[session.phase],
            fileKey: session.discoveryFileKey || args.fileKey,
            selectedLibraryKey: session.selectedLibraryKey || null,
            variableSourceConfirmed: 'mixed',
            variableSourceLibraries: sourceLibs,
            discovery: {
              variables: { cached: variablesCached },
              textStyles: { cached: stylesCached },
              components: { cached: componentsCached },
            },
            enforcement: session.enforcementProfile,
            _libraryConstraint: `Components from "${session.selectedLibraryKey}". Variables/text styles from ${sourceLibs.join(', ')}. User confirmed mixed-source build.`,
            hint: `Variable mismatch confirmed — mixed-source build. Components from "${session.selectedLibraryKey}", variables from ${sourceLibs.join(', ')}. NEXT: Call mimic_map_components with ALL section-level elements in your design.`,
          };
        } else if (choice === 'B' || choice.startsWith('B)') || (sourceLibs.length > 0 && choice.toLowerCase().includes(sourceLibs[0].toLowerCase()))) {
          // Switch to the variable source library for everything
          session.pendingVariableMismatchConfirmation = false;
          session.variableMismatchSourceLibs = null;
          const switchTo = sourceLibs[0];
          // Reset and re-run discovery with the new library
          session.selectedLibraryKey = null;
          session.phase = 0;
          // Trigger fresh discovery with the variable source library
          return {
            phase: 0,
            phaseLabel: 'idle',
            switchingLibrary: switchTo,
            _instruction: `Re-call mimic_discover_ds with libraryKey set to "${switchTo}" to switch to this library for components AND variables.`,
            hint: `User chose to switch to "${switchTo}". Re-call mimic_discover_ds with fileKey and libraryKey: "${switchTo}".`,
          };
        } else if (choice === 'C' || choice.startsWith('C)') || choice.toLowerCase().includes('different')) {
          // User wants to pick a different library — go back to multi-library prompt
          session.pendingVariableMismatchConfirmation = false;
          session.variableMismatchSourceLibs = null;
          session.selectedLibraryKey = null;
          session.phase = 0;
          return {
            phase: 0,
            phaseLabel: 'idle',
            _instruction: 'Re-call mimic_discover_ds with fileKey to restart discovery and pick a different library.',
            hint: 'User wants a different library. Re-call mimic_discover_ds with fileKey (no libraryKey) to restart discovery.',
          };
        }
        // Unrecognized choice — repeat the prompt
        return {
          phase: 1,
          phaseLabel: 'discovery',
          _stopBuild: true,
          _userPrompt:
            `I didn't understand that choice. Please reply with:\n` +
            `A) Continue with mixed sources\n` +
            `B) Switch to ${sourceLibs[0]} for everything\n` +
            `C) Pick a different library`,
          hint: 'User response not recognized. Present _userPrompt again.',
        };
      }

      // If mismatch confirmation is pending but no libraryKey provided, remind
      if (session.pendingVariableMismatchConfirmation && !args.libraryKey) {
        session.toolCallCount++;
        const sourceLibs = session.variableMismatchSourceLibs || [];
        return {
          phase: 1,
          phaseLabel: 'discovery',
          _stopBuild: true,
          _userPrompt:
            `⚠ Variable source mismatch still needs your decision:\n\n` +
            `A) Continue with mixed sources (${session.selectedLibraryKey} components + ${sourceLibs.join(', ')} variables)\n` +
            `B) Switch to ${sourceLibs[0]} for everything\n` +
            `C) Pick a different library`,
          hint: 'Variable mismatch confirmation still pending. Present _userPrompt and wait for user choice. Pass their choice as libraryKey.',
        };
      }

      // ── External variables flow (community library variable injection) ──
      // When a community library's variables can't be enumerated by the plugin
      // API, Claude fetches them via Figma MCP and passes them here.
      if (session.pendingExternalVariables && args.externalVariables && args.externalVariables.length > 0) {
        session.toolCallCount++;
        session.pendingExternalVariables = false;

        // The selected library is a community library whose variables weren't
        // discoverable by the plugin. The text styles cached during Step 1 came
        // from OTHER libraries (whatever was on the page) — they do NOT belong
        // to the selected library. Clear them so the enforcement profile won't
        // force usage of another library's text styles.
        if (dsCache.textStyles.size > 0) {
          dsCache.textStyles.clear();
          // Also clear the plugin-side style cache
          try {
            await bridge.send('clear_style_cache');
          } catch (e) { /* non-fatal — plugin may not support this yet */ }
        }

        const { inferCategory } = require('./ds-setup');
        let injectedCount = 0;
        const variableEntries = [];
        for (const v of args.externalVariables) {
          const path = v.name;
          const category = inferCategory(path, v.resolvedType, v.collection);
          dsCache.addVariable(path, {
            key: v.key,
            collection: v.collection || null,
            category,
            libraryName: v.libraryName || session.selectedLibraryKey || null,
          });
          injectedCount++;
          if (v.key) variableEntries.push({ path, key: v.key });
        }

        // Preload into plugin so importVariableByKeyAsync can resolve them
        if (variableEntries.length > 0) {
          try {
            await bridge.send('preload_variables', { variables: variableEntries });
          } catch (e) { /* non-fatal */ }
        }

        // Recompute enforcement profile with new variables
        const enforcement = dsCache.getEnforcementProfile();
        const dsMode = dsCache.variables.size > 0 ? 'strict' : 'permissive';
        session.enforcementProfile = { ...enforcement, dsMode };

        try {
          await bridge.send('set_session_defaults', {
            enforcementProfile: session.enforcementProfile,
          });
        } catch (e) { /* non-fatal */ }

        // Advance to Phase 2 — build-ready
        advancePhase(2);

        const variablesCached = dsCache.variables.size;
        const stylesCached = dsCache.textStyles.size;
        const componentsCached = dsCache.components.size;

        return {
          phase: session.phase,
          phaseLabel: PHASE_LABELS[session.phase],
          fileKey: session.discoveryFileKey || args.fileKey,
          selectedLibraryKey: session.selectedLibraryKey || null,
          externalVariablesInjected: injectedCount,
          discovery: {
            variables: { cached: variablesCached },
            textStyles: { cached: stylesCached },
            components: { cached: componentsCached },
          },
          enforcement: session.enforcementProfile,
          hint: `External variables injected: ${injectedCount} from "${session.selectedLibraryKey}". Total cached: ${variablesCached} variables, ${stylesCached} text styles, ${componentsCached} components. Enforcement: ${dsMode}. NEXT: Call mimic_map_components with ALL section-level elements in your design.`,
        };
      }

      // If external variables are pending but none provided, remind
      if (session.pendingExternalVariables && !args.externalVariables) {
        session.toolCallCount++;
        const libName = session.selectedLibraryKey;
        const libKey = session.externalVariablesLibraryKey;
        return {
          phase: 1,
          phaseLabel: 'discovery',
          _stopBuild: true,
          communityVariablesRequired: true,
          targetLibrary: libName,
          targetLibraryKey: libKey,
          hint: `External variables still needed. Search for variables from "${libName}" using Figma MCP search_design_system with includeLibraryKeys: ["${libKey}"], includeVariables: true, includeComponents: false, includeStyles: false. Run multiple queries to cover all variable types (e.g. "color", "spacing", "shape", "typography", "breakpoint"). Collect all results and re-call mimic_discover_ds with externalVariables array containing: name, key, resolvedType, collection, libraryName for each variable.`,
        };
      }

      // ── Community check confirmation flow ──────────────────────
      // If plugin discovery already completed and we're waiting for the
      // community library check, handle that before re-running discovery.
      if (session.pendingCommunityCheck && args.communitySearchResults) {
        const pluginNames = (session.discoveredLibraries || []).map(l => l.name);
        const searchNames = args.communitySearchResults;
        const newLibraries = searchNames.filter(n => n && !pluginNames.includes(n));

        // Store variable keys for later use (external variable fetch, validation)
        if (args.communitySearchVariableKeys) {
          session.communityLibraryVariableKeys = args.communitySearchVariableKeys;
        }

        if (newLibraries.length > 0) {
          // Validate which new libraries are actually enabled in the file
          // by asking the plugin to try importing a variable from each.
          const varKeys = args.communitySearchVariableKeys || {};
          const candidates = [];
          for (const libName of newLibraries) {
            const varKey = varKeys[libName];
            if (varKey) {
              candidates.push({ name: libName, variableKey: varKey });
            }
          }

          // Ask plugin to validate library access
          let validatedNames = newLibraries; // fallback: show all if validation fails
          if (candidates.length > 0) {
            try {
              const validation = await bridge.send('validate_library_access', { candidates });
              if (validation && validation.results) {
                const accessible = new Set(
                  validation.results.filter(r => r.accessible).map(r => r.name)
                );
                // Only keep libraries that are actually accessible
                // Also keep libraries we couldn't validate (no variable key found)
                validatedNames = newLibraries.filter(n => {
                  const wasValidated = candidates.some(c => c.name === n);
                  return wasValidated ? accessible.has(n) : true;
                });
              }
            } catch (e) { /* validation failed — fall through to show all */ }
          }

          if (validatedNames.length > 0) {
            // Build option list from plugin-discovered + validated search libraries
            const allNames = [...new Set([...pluginNames, ...validatedNames])];

            // If only 1 library total after filtering, auto-select — don't bother the user
            if (allNames.length === 1) {
              session.pendingCommunityCheck = false;
              session.selectedLibraryKey = allNames[0];
              advancePhase(2);
              session.toolCallCount++;
              return {
                phase: session.phase,
                phaseLabel: PHASE_LABELS[session.phase],
                fileKey: session.discoveryFileKey,
                autoSelected: true,
                selectedLibraryKey: allNames[0],
                discovery: session.discoveryResults,
                enforcement: session.enforcementProfile,
                hint: `Only one library found in file: "${allNames[0]}". Auto-selected. NEXT: Call mimic_map_components with ALL section-level elements in your design.`,
              };
            }

            const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
            const options = allNames.map((name, i) => ({
              letter: letters[i] || String(i + 1),
              name,
              libraryKey: name,
              source: pluginNames.includes(name) ? 'plugin' : 'search',
            }));
            const optionsList = options.map(o =>
              `${o.letter}) ${o.name}`
            ).join('\n');

            // Reset pending so re-call with libraryKey triggers fresh discovery
            session.pendingCommunityCheck = false;
            session.toolCallCount++;

            return {
              phase: session.phase,
              phaseLabel: PHASE_LABELS[session.phase],
              fileKey: session.discoveryFileKey,
              multipleLibraries: true,
              options,
              _stopBuild: true,
              _userPrompt: `Multiple design system libraries detected on this file.\nWhich one should I use for this build?\n\n${optionsList}\n\nReply with the letter (e.g. "use A").`,
              hint: 'STOP — multiple libraries found. Present _userPrompt to the user EXACTLY as written and wait for their choice. Then re-call mimic_discover_ds with libraryKey set to the chosen library name.',
            };
          }
          // All new libraries were phantoms — fall through to "no new libraries"
        }

        // No new libraries — safe to advance to Phase 2
        session.pendingCommunityCheck = false;
        advancePhase(2);
        session.toolCallCount++;

        return {
          phase: session.phase,
          phaseLabel: PHASE_LABELS[session.phase],
          fileKey: session.discoveryFileKey,
          communityCheckPassed: true,
          selectedLibraryKey: session.selectedLibraryKey || null,
          discoveredLibraries: session.discoveredLibraries || [],
          discovery: session.discoveryResults,
          enforcement: session.enforcementProfile,
          completenessWarnings: session.completenessWarnings || [],
          hint: `Community library check passed. ${session.discoveryResults?.variables?.cached || 0} variables, ${session.discoveryResults?.textStyles?.cached || 0} text styles, ${session.discoveryResults?.components?.cached || 0} components. Enforcement: ${session.enforcementProfile?.dsMode || 'unknown'}.${session.selectedLibraryKey ? ` Selected library: "${session.selectedLibraryKey}" — ALL components and Figma MCP searches must use ONLY this library.` : ''} NEXT: Call mimic_map_components with ALL section-level elements in your design (header, footer, sidebar, etc.) to find DS components BEFORE building. Target ~90% component usage.`,
        };
      }

      // If community check is pending but no search results provided, remind
      if (session.pendingCommunityCheck && !args.libraryKey && !args.communitySearchResults) {
        session.toolCallCount++;
        return {
          phase: session.phase,
          phaseLabel: PHASE_LABELS[session.phase],
          fileKey: session.discoveryFileKey,
          communityLibraryCheckRequired: true,
          _stopBuild: true,
          discoveredLibraries: session.discoveredLibraries || [],
          hint: `Community library check still pending. You MUST call Figma MCP search_design_system with query "color", includeVariables: true, includeComponents: false, includeStyles: false on fileKey "${session.discoveryFileKey}". Then re-call mimic_discover_ds with communitySearchResults set to the array of unique non-null libraryName values from the results.`,
        };
      }

      // ── Normal discovery flow ─────────────────────────────────

      // If a library key was provided (after multi-library prompt), store it
      // and reset pending state so fresh discovery runs
      if (args.libraryKey) {
        discovery.setLibrary(args.libraryKey);
        session.selectedLibraryKey = args.libraryKey;
        session.pendingCommunityCheck = false;
      } else if (session.selectedLibraryKey) {
        discovery.setLibrary(session.selectedLibraryKey);
      }

      // Verify plugin connection
      const libraryInfo = await discovery.enumerateLibrary();

      // ── Step 1: Discover variables (also detects multi-library) ──
      let varDiscovery;
      try {
        varDiscovery = await bridge.send('discover_library_variables', {});
      } catch (e) {
        // teamLibrary API not available (community files) — proceed with empty
        varDiscovery = { libraries: [], variables: [], totalVariables: 0 };
      }

      // Multi-library gate: if >1 library and none selected, ask user
      if (!session.selectedLibraryKey && varDiscovery.libraries && varDiscovery.libraries.length > 1) {
        session.toolCallCount++;
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const options = varDiscovery.libraries.map((lib, i) => ({
          letter: letters[i] || String(i + 1),
          name: lib.name,
          libraryKey: lib.name,
          collections: lib.collections || [],
        }));
        const optionsList = options.map(o => `${o.letter}) ${o.name}${o.collections.length ? ` (${o.collections.length} collections)` : ''}`).join('\n');
        return {
          phase: session.phase,
          phaseLabel: PHASE_LABELS[session.phase] || 'idle',
          fileKey: args.fileKey,
          library: libraryInfo,
          multipleLibraries: true,
          options,
          libraries: varDiscovery.libraries,
          discoveredVariables: varDiscovery.totalVariables,
          _stopBuild: true,
          _userPrompt: `Multiple design system libraries detected on this file. Which one should I use for this build?\n\n${optionsList}\n\nReply with the letter (e.g. "use A").`,
          hint: 'STOP — do NOT proceed with the build. Present the _userPrompt to the user EXACTLY as written and wait for their choice. Then re-call mimic_discover_ds with libraryKey set to the chosen library name from the options array.',
        };
      }

      // ── Step 2: Cache variables in MCP + preload in plugin ──
      const { inferCategory } = require('./ds-setup');
      let variablesCached = 0;
      let variablesPreloaded = 0;
      if (varDiscovery.variables && varDiscovery.variables.length > 0) {
        const variableEntries = [];
        for (const v of varDiscovery.variables) {
          const path = v.path || v.name;
          const category = v.category || inferCategory(path, v.resolvedType, v.collection);
          dsCache.addVariable(path, {
            key: v.key,
            collection: v.collection || null,
            category,
            libraryName: v.libraryName || null,
          });
          variablesCached++;
          if (v.key) variableEntries.push({ path, key: v.key });
        }
        // Preload into plugin
        if (variableEntries.length > 0) {
          try {
            const preloadResult = await bridge.send('preload_variables', { variables: variableEntries });
            variablesPreloaded = preloadResult?.preloadedVars || 0;
          } catch (e) { /* non-fatal */ }
        }
      }

      // ── Step 3: Discover text styles ──
      let stylesCached = 0;
      try {
        const styleResult = await bridge.send('discover_library_styles', { fileKey: args.fileKey });
        if (styleResult && styleResult.styles) {
          for (const style of styleResult.styles) {
            dsCache.addTextStyle(style.key, style);
            stylesCached++;
          }
        }
      } catch (e) { /* non-fatal */ }

      // If a library is selected, check whether it contributed any text styles.
      // Text styles discovered above come from scanning ALL page text nodes —
      // they may belong to other libraries. If the selected library has NO
      // text styles (e.g. MUI uses typography variables, not styles), clear
      // the cache so enforcement doesn't force usage of another library's styles.
      if (session.selectedLibraryKey && stylesCached > 0) {
        // The plugin-discovered libraries list tells us which library has which collections.
        // If the selected library has NO typography/text collection, its styles are 0.
        const selectedLib = (varDiscovery.libraries || []).find(l => l.name === session.selectedLibraryKey);
        const pluginLib = (session.discoveredLibraries || []).find(l => l.name === session.selectedLibraryKey);
        const lib = selectedLib || pluginLib;
        // Check if the library has text-style-bearing collections
        // (heuristic: collection names with "text", "typography", "type", or "font")
        const hasTextCollections = lib && lib.collections && lib.collections.some(c => {
          const lower = c.toLowerCase();
          return lower.includes('text style') || lower === 'text styles';
        });
        // If the selected library doesn't have text style collections, the cached
        // styles belong to other libraries — clear them.
        if (!hasTextCollections) {
          dsCache.textStyles.clear();
          stylesCached = 0;
          try { await bridge.send('clear_style_cache'); } catch (e) { /* non-fatal */ }
        }
      }

      // ── Step 4: Discover components on page ──
      let componentsCached = 0;
      try {
        const compResult = await bridge.send('discover_library_components', { fileKey: args.fileKey });
        if (compResult && compResult.components) {
          for (const comp of compResult.components) {
            dsCache.addComponent(comp.key, {
              name: comp.name,
              isRemote: comp.isRemote,
              isComponentSet: comp.isComponentSet,
              variantCount: comp.variantCount,
              variantProperties: comp.variantProperties,
              description: comp.description,
            });
            componentsCached++;
          }
        }
      } catch (e) { /* non-fatal */ }

      // ── Step 5: Compute and set enforcement profile ──
      const enforcement = dsCache.getEnforcementProfile();
      const dsMode = dsCache.variables.size > 0 ? 'strict' : 'permissive';
      session.enforcementProfile = { ...enforcement, dsMode };

      try {
        await bridge.send('set_session_defaults', {
          enforcementProfile: session.enforcementProfile,
        });
      } catch (e) { /* non-fatal */ }

      // Completeness warnings
      const completenessWarnings = [];
      if (variablesCached > 0 && variablesPreloaded < variablesCached * 0.8) {
        completenessWarnings.push(`Variables: only ${variablesPreloaded}/${variablesCached} preloaded into plugin. Some bindings may fail.`);
      }
      if (stylesCached === 0 && enforcement.enforceTextStyles) {
        completenessWarnings.push('No text styles found. Text style enforcement is ON but has no styles to offer.');
      }
      if (componentsCached === 0) {
        completenessWarnings.push('No components found on page. Use Figma MCP search_design_system to find them (search: button, input, badge, table cell, tabs, avatar, dropdown, textarea).');
      }

      session.toolCallCount++;

      // If libraryKey was provided, the user already resolved the multi-library
      // question (from plugin detection OR community check). Skip the community
      // check and advance directly to Phase 2.
      if (args.libraryKey) {
        session.pendingCommunityCheck = false;
        advancePhase(2);

        // Check if the selected library has variables/styles in the file.
        // Variables and text styles come from whatever libraries are enabled
        // in the file, NOT necessarily from the selected library. If the
        // selected library contributed no variables, the build will use
        // another library's tokens — warn about the mismatch.
        let selectedLibVarCount = 0;
        const varSourceLibs = new Set();
        for (const [, v] of dsCache.variables) {
          if (v.libraryName) varSourceLibs.add(v.libraryName);
          if (v.libraryName === session.selectedLibraryKey) selectedLibVarCount++;
        }
        if (selectedLibVarCount === 0 && variablesCached > 0) {
          const sourceList = [...varSourceLibs].join(', ');
          const sourceLibs = [...varSourceLibs];

          // Check if the selected library was NOT discovered by the plugin.
          // Community libraries often have published variables that the plugin
          // API (getAvailableLibraryVariableCollectionsAsync) can't enumerate,
          // even though Figma's REST API and library panel show them.
          const pluginDiscoveredNames = (varDiscovery.libraries || []).map(l => l.name);
          const isPluginDiscovered = pluginDiscoveredNames.includes(session.selectedLibraryKey);

          if (!isPluginDiscovered) {
            // ── Community library — variables need external fetch ──
            // The plugin can't enumerate this library's variables, but they
            // exist (visible in Manage Libraries). Redirect to external
            // variables flow: Claude fetches them via Figma MCP search and
            // passes them back as externalVariables.
            session.phase = 1;
            session.pendingExternalVariables = true;
            // Try to find the library key from the community check options
            session.externalVariablesLibraryKey = session.communityLibraryKeys?.[session.selectedLibraryKey] || null;

            return {
              phase: 1,
              phaseLabel: 'discovery',
              fileKey: args.fileKey,
              library: libraryInfo,
              selectedLibraryKey: session.selectedLibraryKey || null,
              communityVariablesRequired: true,
              _stopBuild: true,
              hint: `"${session.selectedLibraryKey}" has published variables but the plugin API cannot enumerate them (community library limitation). Fetch variables via Figma MCP search_design_system with includeLibraryKeys to restrict to this library. Run multiple queries to cover all variable types: "color", "spacing", "shape", "typography", "breakpoint". Collect ALL results and re-call mimic_discover_ds with externalVariables array (each entry: name, key, resolvedType, collection, libraryName).`,
            };
          }

          // ── STOP BUILD — genuine variable source mismatch ──
          // The selected library WAS discovered by the plugin but contributed
          // no variables. This is a real mismatch — the user must decide.
          session.phase = 1;
          session.pendingVariableMismatchConfirmation = true;
          session.variableMismatchSourceLibs = sourceLibs;

          return {
            phase: 1,
            phaseLabel: 'discovery',
            fileKey: args.fileKey,
            library: libraryInfo,
            selectedLibraryKey: session.selectedLibraryKey || null,
            discoveredLibraries: varDiscovery.libraries || [],
            discovery: {
              variables: { cached: variablesCached, preloaded: variablesPreloaded },
              textStyles: { cached: stylesCached },
              components: { cached: componentsCached },
            },
            enforcement: session.enforcementProfile,
            variableSourceMismatch: {
              selectedLibrary: session.selectedLibraryKey,
              selectedLibraryVariableCount: 0,
              variableSourceLibraries: sourceLibs,
              totalCachedVariables: variablesCached,
            },
            _stopBuild: true,
            _userPrompt:
              `⚠ VARIABLE SOURCE MISMATCH\n\n` +
              `"${session.selectedLibraryKey}" has NO variables (colors, spacing, radius) in this file.\n` +
              `All ${variablesCached} cached variables come from: ${sourceList}.\n\n` +
              `This means:\n` +
              `• Components → imported from "${session.selectedLibraryKey}"\n` +
              `• Colors, spacing, radius → bound from ${sourceList}\n\n` +
              `Options:\n` +
              `A) Continue with mixed sources (${session.selectedLibraryKey} components + ${sourceList} variables)\n` +
              `B) Switch to ${sourceLibs[0]} for everything (components + variables from same library)\n` +
              `C) Pick a different library\n\n` +
              `Reply with A, B, or C.`,
            hint: `STOP — variable source mismatch detected. Present _userPrompt to the user EXACTLY as written and wait for their choice.`,
          };
        }

        return {
          phase: session.phase,
          phaseLabel: PHASE_LABELS[session.phase],
          fileKey: args.fileKey,
          library: libraryInfo,
          selectedLibraryKey: session.selectedLibraryKey || null,
          discoveredLibraries: varDiscovery.libraries || [],
          discovery: {
            variables: { cached: variablesCached, preloaded: variablesPreloaded },
            textStyles: { cached: stylesCached },
            components: { cached: componentsCached },
          },
          enforcement: session.enforcementProfile,
          completenessWarnings,
          _libraryConstraint: `ALL components and Figma MCP searches must use ONLY "${session.selectedLibraryKey}". Never mix design systems.`,
          hint: completenessWarnings.length > 0
            ? `Discovery complete with ${completenessWarnings.length} warning(s). Review completenessWarnings. Selected library: "${session.selectedLibraryKey}" — use ONLY this library for all components and searches. NEXT: Call mimic_map_components with ALL section-level elements in your design (header, footer, sidebar, etc.) to find DS components BEFORE building. Target ~90% component usage.`
            : `Discovery complete. ${variablesCached} variables, ${stylesCached} text styles, ${componentsCached} components. Enforcement: ${dsMode}. Selected library: "${session.selectedLibraryKey}" — use ONLY this library for all components and searches. NEXT: Call mimic_map_components with ALL section-level elements in your design (header, footer, sidebar, etc.) to find DS components BEFORE building. Target ~90% component usage.`,
        };
      }

      // ── Stay at Phase 1 — community library check required ──
      advancePhase(1);

      // Store intermediate results for community check confirmation
      session.discoveryFileKey = args.fileKey;
      session.discoveredLibraries = varDiscovery.libraries || [];
      session.discoveryResults = {
        variables: { cached: variablesCached, preloaded: variablesPreloaded },
        textStyles: { cached: stylesCached },
        components: { cached: componentsCached },
      };
      session.completenessWarnings = completenessWarnings;
      session.pendingCommunityCheck = true;

      return {
        phase: session.phase,
        phaseLabel: PHASE_LABELS[session.phase],
        fileKey: args.fileKey,
        library: libraryInfo,
        selectedLibraryKey: session.selectedLibraryKey || null,
        discoveredLibraries: varDiscovery.libraries || [],
        discovery: {
          variables: { cached: variablesCached, preloaded: variablesPreloaded },
          textStyles: { cached: stylesCached },
          components: { cached: componentsCached },
        },
        enforcement: session.enforcementProfile,
        completenessWarnings,
        communityLibraryCheckRequired: true,
        _stopBuild: true,
        hint: `Plugin discovery complete — ${variablesCached} variables, ${stylesCached} text styles, ${componentsCached} components cached. MANDATORY NEXT STEP: Call Figma MCP search_design_system with query "color", includeVariables: true, includeComponents: false, includeStyles: false on fileKey "${args.fileKey}". Collect all unique non-null libraryName values from the results, then re-call mimic_discover_ds with communitySearchResults set to that array. Build tools are BLOCKED until this check completes.`,
      };
    }
  );
}

module.exports = { register };
