# Known Issues & Compatibility

Last updated: 2026-05-07

## Compatibility Matrix

| DS Configuration | Support Level | Notes |
|---|---|---|
| Team/org library with components + tokens | Full | Components, text styles, color/spacing/radius variables |
| Team/org library with components + typography variables | Full | Typography variables bound via setBoundVariable |
| Team/org library with components only | Partial | Components used. Text/color use raw values. Report recommends adding tokens. |
| Community library | Full (with setup) | Variables via REST API key discovery |
| No library enabled | Blocked | Build will not start without a library |

## Known Limitations

### Font loading on first text node
The Figma plugin pre-warms Inter font variants on startup. If using a non-Inter DS, the first text node may fail — retry succeeds. Will be fixed by pre-warming the DS's fonts during Phase 2.

### Community library variables
Figma's Plugin API doesn't enumerate community library variable collections. Mimic works around this via REST API key discovery + importVariableByKeyAsync.

### Large library preloading
Libraries with 200+ text styles may take 30-60s on first build. Cached afterward.

### Charts
Chart geometry (donut arcs, scatter positions, line paths) is computed in Node.js. All chart text and fills use DS tokens. SVG-imported geometry (line paths, radar polygons) may need post-import DS variable binding.

## Reporting Issues

Open an issue at the GitHub repository with:
1. Your DS setup (team library, community library, tokens available)
2. The HTML or description used as input
3. The error message or unexpected output
4. Your Figma plan (Professional, Organization, Enterprise)
