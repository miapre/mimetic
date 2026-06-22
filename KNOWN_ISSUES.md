# Known Issues

Platform behaviors, API quirks, and edge cases discovered during
development and builds. This file prevents re-discovery across sessions.

## Figma Plugin API

### Font loading on first component insert
Non-Inter fonts may fail on the first `figma_insert_component` call.
The plugin detects this and returns `LIBRARY_FONT_INCOMPATIBLE`.
Retry once — second attempt usually succeeds after Figma caches
the font. If it fails again, the library is genuinely font-incompatible
and the session switches to primitives-only mode.

### INSERT_TIMEOUT does not mean failure
When `figma_insert_component` returns INSERT_TIMEOUT, the component
MAY have been created. Always check via `figma_get_node_children`
on the parent before retrying. Duplicates are hard to detect.

### Phantom libraries in search results
`search_design_system` returns libraries that appear in Figma's
index but are NOT added to the file. The two-step discovery
(plugin + community check) filters these, but direct
`search_design_system` calls may return phantom results.
Status: known, deferred fix.

### Variable collections from community libraries
`getAvailableLibraryVariableCollections` cannot enumerate variables
from some community libraries even when enabled. When this happens,
discovery returns `communityVariablesRequired: true`. The workaround
is to search for variables via Figma MCP and pass them as
`externalVariables` to `mimic_discover_ds`.

### Component boolean auto-disable
All boolean properties are turned OFF at component insertion time.
The `disabledBooleans` array in the response lists what was disabled.
If the array is empty, auto-disable did not run — manually disable
booleans the HTML doesn't show.

## Figma REST API

### FIGMA_TOKEN scope requirements
Five read-only scopes required: `current_user:read`,
`file_content:read`, `file_metadata:read`, `library_assets:read`,
`library_content:read`. Missing scopes produce opaque 403 errors.

### Token hot-reload
`~/.mimic-ai.json` takes priority over env var. Token is resolved
on each discovery call (lazy), so rotation doesn't require restart.

## WebSocket Bridge

### Bridge must be running before builds
If the Figma plugin is not running, bridge operations fail silently
or timeout. Always verify via `mimic_status` before starting a build.

### Keepalive interval
Bridge sends keepalive pings every 30 seconds. If the plugin UI
is closed in Figma, the connection drops and auto-reconnects when
the plugin is reopened.

## Build Protocol

### Circuit breaker is session-scoped
3 consecutive failures blocks build tools for the rest of the session.
Generating the build report resets the counter. There is no way to
manually reset without generating a report.

### Build checkpoint at 20 operations
After 20 Phase 3 tool calls, a checkpoint message appears. This is
informational — the build continues. The 300-call hard limit is
the actual stop.

### ds-knowledge.json must be reset before validation sprints
Stale component recipes from previous DS sessions pollute learning
metrics. Always reset (`{"version":2,...}`) before starting a
validation sprint with a different DS.

## Chart Building

### SVG strokes render as thick fills in Figma
Figma converts stroked SVG paths into filled shapes. Never use
`stroke` in chart SVGs. Use filled rectangles for grid lines and
thin filled ribbons for line chart data lines.

### Text in SVGs is unusable
Figma renders SVG `<text>` as stacked single characters with
tiny widths. Always use native Figma text nodes positioned outside
the SVG frame.

### Unicode shapes in legends
`●` and similar Unicode shapes in text nodes inherit text color
and cannot be individually colored. Use `create_rectangle` or
`create_ellipse` for colored legend indicators.
