'use strict';

const MAX_BATCH_SIZE = 6;

function register(server, context) {
  const { bridge, session, requirePhase, registerTool } = context;

  registerTool(
    'figma_batch',
    `Executes up to ${MAX_BATCH_SIZE} operations sequentially via the Figma plugin bridge. Each operation specifies a type (bridge handler name) and payload. Returns an array of results in order.`,
    {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          maxItems: MAX_BATCH_SIZE,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Bridge handler name (e.g. "create_frame", "set_text").' },
              payload: { type: 'object', description: 'Parameters for the handler.' },
            },
            required: ['type', 'payload'],
          },
          description: `Array of operations to execute (max ${MAX_BATCH_SIZE}).`,
        },
      },
      required: ['operations'],
    },
    async (args) => {
      requirePhase(2, 'Complete DS Discovery and Style Inventory before batch operations.');

      if (!args.operations || args.operations.length === 0) {
        return { error: 'EMPTY_BATCH', message: 'No operations provided.' };
      }

      if (args.operations.length > MAX_BATCH_SIZE) {
        return {
          error: 'BATCH_TOO_LARGE',
          message: `Max ${MAX_BATCH_SIZE} operations per batch. Got ${args.operations.length}.`,
        };
      }

      const results = [];
      for (const op of args.operations) {
        try {
          const result = await bridge.send(op.type, op.payload || {});
          results.push({ ok: true, type: op.type, result });
        } catch (err) {
          results.push({
            ok: false,
            type: op.type,
            error: err.message,
          });
        }
        session.toolCallCount++;
      }

      const failed = results.filter(r => !r.ok).length;
      return {
        total: results.length,
        succeeded: results.length - failed,
        failed,
        results,
        hint: failed > 0
          ? `${failed} operation(s) failed. Check individual results for error details.`
          : 'All operations succeeded.',
      };
    }
  );
}

module.exports = { register };
