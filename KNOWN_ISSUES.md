# Known Issues & Compatibility

Last updated: 2026-04-22

## Compatibility Matrix

| DS Configuration | Support Level | Notes |
|---|---|---|
| **Team/org library with components + tokens** | Full | Components, text styles, color/spacing/radius variables all work. Full DS compliance achievable. |
| **Team/org library with components only** | Partial | Components are used. Text, colors, spacing fall back to raw values. Build report recommends adding tokens. |
| **Community library** | Full (with setup) | Components and text styles import normally. Variables require key-based import — Mimic discovers variable keys via the Figma REST API and imports them directly, bypassing the plugin's collection enumeration which doesn't cover community libraries. |
| **No library enabled** | Blocked | Mimic requires a published library enabled in the target file. The build will not start without one. |

## Known Limitations

### Community library variables
Figma's Plugin API (`figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync`) does not enumerate variable collections from community-published libraries — even when those variables are visible in the Figma UI and discoverable via the REST API.

Mimic works around this by importing community library variables directly by key. During Phase 1, variable keys are discovered via the Figma REST API (`search_design_system`), then imported via `figma.variables.importVariableByKeyAsync` in Phase 2. This makes community library variables fully bindable — they respond to mode changes (light/dark) and behave identically to team library variables once imported.

Components and text styles from community libraries import normally — no workaround needed.

### Large library preloading
Libraries with 200+ text styles may take 30-60 seconds to preload on first build. Subsequent builds use cached style IDs and are faster.

### Charts
Chart data geometry (donut arcs, scatter dots, line paths) uses pixel calculations, not DS tokens. Everything else in a chart — bar distribution, labels, legends, containers — uses auto-layout and DS tokens. Bar charts use flexible widths so they adapt when you resize the card.

### Auto-layout constraints
- `layoutGrow` on nodes inside HUG-sizing parents produces 0-width children. Mimic now warns when this happens and suggests explicit widths.
- Frames with `direction=NONE` inside auto-layout parents may stretch unexpectedly. Mimic now defaults these to `INHERIT` alignment.

### Configuration recipes
Component configuration recipes (remembering HOW to configure a component, not just which one to use) are being rolled out. Early builds record recipes; future builds will replay them to skip component inspection and reduce build time.

## Reporting Issues

If you encounter a bug or unexpected behavior, please open an issue at the GitHub repository. Include:
1. Your DS setup (team library, community library, tokens available)
2. The HTML or description you used as input
3. The error message or unexpected output
4. Your Figma plan (Professional, Organization, Enterprise)
