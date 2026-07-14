# Security Policy

Mimic AI runs entirely on your machine: an MCP server process plus a Figma
plugin talking to it over a local WebSocket bridge. There is no hosted
backend and no telemetry, but it does handle a Figma personal access token
and an embedded local server, so real security issues are still possible.

## Supported versions

Only the latest published minor version receives security fixes.

| Version | Supported |
|---|---|
| Latest `2.x` minor | Yes |
| Anything older | No |

Upgrade with `npm install -g @miapre/mimic-ai@latest` (or re-run the
installer) before reporting an issue, in case it's already fixed.

## Reporting a vulnerability

Report privately through GitHub Security Advisories, not a public issue:

1. Go to the [repository's Security tab](https://github.com/miapre/mimic-ai/security).
2. Click "Report a vulnerability."
3. Describe the issue, the affected version, and steps to reproduce.

Do not open a public GitHub issue for anything that could be exploited
before a fix ships (token handling, the local bridge's network exposure,
path handling, injected-instruction handling in HTML input, etc.).

## What counts

Examples of in-scope reports:

- The WebSocket bridge accepting connections or Origins it shouldn't
- Any way for HTML/prompt input to escape its role as content and affect
  server behavior, file paths, or plugin execution
- Path traversal in any file read/write (knowledge store, report output,
  config resolution)
- Figma token exposure in logs, error messages, or written artifacts
- Anything that could cause a write to a Figma file the user didn't
  request

## Track record

This isn't a hypothetical process. Version 2.0.3 shipped fixes for three
vulnerabilities found in an internal audit: the local bridge was
reachable beyond localhost with a wildcard CORS origin, a file-read tool
allowed path traversal outside the working directory, and the plugin's
manifest allowed network access wider than it needed. All three are
detailed in the [changelog](CHANGELOG.md#203-2026-07-14). Reports are
read, fixed, and disclosed in the changelog once a release is out.

## Response expectations

This is an open-source project maintained on a best-effort basis. There's
no SLA, but private reports are prioritized over feature work and a fix
or mitigation is the goal before any public disclosure.
