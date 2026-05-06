'use strict';

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
  3: 'Build in progress. Use build/component/edit tools. When done, advance to QA.',
  4: 'QA phase. Inspect nodes, verify DS compliance, fix issues.',
  5: 'Build complete. Generate the report.',
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
      };
    }
  );

  // ── mimic_discover_ds ─────────────────────────────────────────
  registerTool(
    'mimic_discover_ds',
    'Triggers Phase 1 DS discovery. Connects to the Figma plugin and begins design system analysis for the given file.',
    {
      type: 'object',
      properties: {
        fileKey: { type: 'string', description: 'Figma file key to discover DS from.' },
      },
      required: ['fileKey'],
    },
    async (args) => {
      const status = await bridge.send('get_plugin_status', { fileKey: args.fileKey });
      advancePhase(1);
      session.toolCallCount++;

      return {
        phase: session.phase,
        phaseLabel: PHASE_LABELS[session.phase],
        pluginStatus: status,
        hint: 'Discovery started. Next: preload text styles with figma_preload_styles, preload variables with figma_preload_variables, then call figma_set_session_defaults to finalize inventory.',
      };
    }
  );
}

module.exports = { register };
