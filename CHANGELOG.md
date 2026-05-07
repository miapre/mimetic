# Changelog

## 2.0.0 (unreleased)

Complete rewrite from scratch.

### Architecture
- Split MCP server (intelligence) / plugin (enforcement gate)
- Embedded bridge — no separate process to start
- Chart geometry computed in Node.js (not by LLM)
- Graduated DS enforcement — adapts to what the DS provides
- Phase enforcement — mechanical sequencing in MCP layer
- WebSocket keepalive + auto-reconnect

### Added
- First build always succeeds on any DS configuration
- Chart calculation engine — deterministic bar/donut/line/radar/scatter/heatmap geometry
- Contextual tool responses — every tool returns hints, available values, recovery paths
- 7-step component configuration protocol with icon library detection
- DS gap tracking with savings estimates across builds
- Three-trigger learning model (correction → confirmation → auto-promote)
- ~20 focused source files (was 1 x 203KB monolith)
- 31 automated tests

### Changed
- 8 core rules in CLAUDE.md (was 60 golden rules)
- QA uses structural validation, not screenshots
- Artboard placement: rightmost + 80px (enforced)

### Removed
- `figma_create_chart` convenience tool (replaced by native chart building)
- Anti-bypass machinery (6 mechanisms removed)
- Session state flag sprawl (7 boolean flags → 1 phase counter)
- 45 band-aid rules that compensated for implementation bugs
