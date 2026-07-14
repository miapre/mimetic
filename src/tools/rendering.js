'use strict';

const fs = require('node:fs');
const path = require('node:path');

function register(server, context) {
  const { registerTool } = context;

  // ── mimic_pipeline_resolve ─────────────────────────────────────
  registerTool(
    'mimic_pipeline_resolve',
    'Classifies build input as a URL, local file path, or raw HTML string and returns the resolved content ready for building. Use FIRST when the user gives you a link, a file path, or ambiguous input instead of raw HTML — it tells you what you actually received. Params: input (string, required). Workflow position: before mimic_discover_ds, at the very start of a build.',
    {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'A URL, file path, or raw HTML string to classify and resolve.',
        },
      },
      required: ['input'],
    },
    async (args) => {
      const { input } = args;

      // URL detection
      if (/^https?:\/\//i.test(input)) {
        return { type: 'url', url: input };
      }

      // File path detection — confined to cwd to prevent arbitrary reads
      if (!input.includes('<') && !input.includes('>')) {
        const baseDir = process.cwd();
        const resolved = path.resolve(baseDir, input);
        // Ensure resolved path stays within baseDir (no traversal)
        if (resolved.startsWith(baseDir + path.sep) || resolved === baseDir) {
          if (fs.existsSync(resolved)) {
            const content = fs.readFileSync(resolved, 'utf-8');
            return { type: 'file', content, path: resolved };
          }
        } else {
          return { type: 'error', message: 'File path must be relative to the working directory. Absolute paths and directory traversal are not allowed.' };
        }
      }

      // Default: treat as raw HTML
      return { type: 'html', content: input };
    },
    {
      annotations: { title: 'Classify build input', readOnlyHint: true, idempotentHint: true },
    }
  );
}

module.exports = { register };
