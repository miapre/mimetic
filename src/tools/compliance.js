'use strict';

function register(server, context) {
  const { registerTool, bridge } = context;

  // ── figma_validate_ds_compliance ───────────────────────────────
  registerTool(
    'figma_validate_ds_compliance',
    'Recursively checks a node (and its children) against the current DS enforcement profile — flags hardcoded colors/fonts instead of variables/styles, missing text style bindings, and other DS violations. Use during Phase 3/4 QA, especially at the 20-op build checkpoint, before generating the report. Params: nodeId (required, typically the artboard root).',
    {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'The Figma node ID to validate.',
        },
      },
      required: ['nodeId'],
    },
    async (args) => {
      const result = await bridge.send('validate_ds_compliance', { nodeId: args.nodeId });
      return result;
    },
    {
      annotations: { title: 'Validate DS compliance', readOnlyHint: true, idempotentHint: true },
      outputSchema: {
        type: 'object',
        properties: {
          violations: { type: 'array', items: { type: 'object' }, description: 'Per-node compliance violations found.' },
          summary: {
            type: 'object',
            properties: {
              totalNodes: { type: 'number' },
              compliant: { type: 'number' },
              violations: { type: 'number' },
            },
          },
        },
      },
    }
  );
}

module.exports = { register };
