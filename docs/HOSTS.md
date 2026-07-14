# Setting up Mimic AI in different MCP hosts

Mimic AI is a standard stdio MCP server. Any MCP host that can spawn a
local process and speak the stdio transport works. The list below
covers the common ones, but it isn't exhaustive.

The Figma plugin and the embedded WebSocket bridge are host-invisible:
they don't know or care which MCP client is driving them. Set up the
server once per host below, then in Figma desktop: **Plugins >
Development > Mimic AI > Run**. The bridge starts automatically on the
first tool call.

## Claude Code

```bash
claude mcp add mimic-ai -- npx -y @miapre/mimic-ai
```

Claude Code also gets the operational workflow via the Agent Skill in
`skills/mimic-ai/SKILL.md` and the full protocol in this repo's
`CLAUDE.md`. The 6-phase build protocol and contextual tool hints are
written against Claude Code specifically.

## Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mimic-ai": {
      "command": "npx",
      "args": ["-y", "@miapre/mimic-ai"]
    }
  }
}
```

The workflow rules in `.cursor/rules/mimic-ai.mdc` apply automatically
once that file exists in your project.

## Codex CLI

```bash
codex mcp add mimic -- npx -y @miapre/mimic-ai
```

## Gemini CLI

```bash
gemini mcp add mimic-ai npx -y @miapre/mimic-ai
```

Or add it directly to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "mimic-ai": {
      "command": "npx",
      "args": ["-y", "@miapre/mimic-ai"]
    }
  }
}
```

## Any other stdio MCP host

If your host supports adding a stdio MCP server by command and args, this
is all it needs:

```json
{
  "command": "npx",
  "args": ["-y", "@miapre/mimic-ai"]
}
```

Set `FIGMA_TOKEN` in the server's env block if the host supports it (see
the README's "Figma setup details" for how to generate one and which
scopes it needs). Without it, Mimic still works but falls back to a
slower, plugin-only discovery path instead of the REST-API-backed one.

Whatever host you use, the tools, the enforcement gate, and the learning
system behave identically. None of that logic lives in the host
integration.
