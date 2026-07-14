# Contributing to Mimic AI

Issues and PRs are welcome. This is a small project maintained on a
best-effort basis, so please read this before opening a PR: it saves a
round trip.

## Dev setup

Requirements: Node.js v20.6+, the Figma desktop app (browser Figma can't
run development plugins), and a Figma file with a design system (a team
library or any community library) to test against.

```bash
git clone https://github.com/miapre/mimic-ai.git
cd mimic-ai
npm install
```

Set `FIGMA_TOKEN` (a Figma personal access token, see the README's
"Figma setup details" for scopes) in your MCP client's server config so
you can exercise the REST-API-backed discovery path, or in
`~/.mimic-ai.json` as a fallback.

**Load the plugin in Figma desktop:**

1. Figma desktop > **Plugins > Development > Import plugin from
   manifest**
2. Select `plugin/manifest.json` from your clone
3. Open a file with a design system enabled, then **Plugins >
   Development > Mimic AI > Run**

The MCP server and the plugin talk over an embedded WebSocket bridge that
starts automatically on the server's first tool call, no separate
process to start by hand.

**Point your MCP client at your local clone** instead of the published
package while you work:

```json
{
  "mcpServers": {
    "mimic-ai": {
      "command": "node",
      "args": ["/absolute/path/to/your/clone/mcp.js"]
    }
  }
}
```

## Running tests

```bash
npm test
```

This runs the suite in `internal/tests/` with Node's built-in test
runner. It doesn't need `FIGMA_TOKEN`, network access, or a running
Figma instance: it exercises the server and bridge logic directly.
Tests also run in CI on Node 20 and 22 for every push and PR against
`main`.

## Before opening a PR

- **Tests are required for behavior changes.** If you change enforcement
  logic, the learning/knowledge store, the bridge, or any tool's
  response shape, add or update a test in `internal/tests/` covering
  it. PRs that change behavior without a test won't be merged as-is.
- **No design-system-vendor-specific values, anywhere.** Mimic is
  DS-agnostic by design: it reads whatever variables, styles, and
  components exist in the *user's* file and adapts to them. Never hardcode
  a specific vendor's token names, component names, color values, or
  library structure into the server, the plugin, tests, docs, or
  examples. Use generic placeholders (`Button/Primary`,
  `Colors/Brand/500`, "your DS") instead. This is a hard rule, not a
  style preference: code that assumes one design system's shape breaks
  the tool for everyone else's.
- Keep the change scoped. Small, focused PRs are much easier to review
  than ones that also refactor unrelated code.
- Match the existing code style (no build step, no bundler: this is
  plain Node.js and a vanilla Figma plugin).
- If you're changing anything a user would notice (a tool's behavior, an
  enforcement rule, an install step), update the README or `CLAUDE.md`
  in the same PR.

## What's out of scope for a casual PR

Changes to the 6-phase build protocol, the knowledge-store schema, or
plugin-level enforcement gates are architecturally sensitive: open an
issue to discuss the approach first rather than sending a large PR cold.

## Reporting bugs vs. security issues

Regular bugs: open a GitHub issue with the bug report template. Anything
that could be a security vulnerability (token handling, the bridge's
network exposure, path handling): see [SECURITY.md](SECURITY.md) instead
of a public issue.
