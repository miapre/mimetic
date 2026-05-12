# Mimic AI

MCP tool that translates HTML into Figma using the DS present
on the user's target file. Learns from every build.

## Component-First Principle

**Target ~90% DS component usage, ~10% primitives with DS
variables.** Every build should maximize DS component coverage.
Before creating ANY frame, check if the DS has a component for
it. Section-level elements (header, footer, sidebar) and UI
patterns (cards, metrics, tables, badges, buttons, inputs)
should ALWAYS be DS components. Only use `figma_create_frame`
for truly custom layouts that have no DS equivalent — and even
then, bind every property to DS variables and text styles.

After `mimic_discover_ds`, ALWAYS call `mimic_map_components`
with all section-level elements in the design. For any missing
components, search the library via Figma MCP
`search_design_system` before building custom frames.

## Build Protocol

Every build follows 6 phases in order:
0. Target → 1. DS Discovery → 2. Style Inventory →
3. Build → 4. QA → 5. Report

Call `mimic_status` to start. It returns the current state
and what to do next.

## Phase 1+2 — DS Discovery (ONE CALL)

```
mimic_discover_ds(fileKey)
```

This single call does everything:
1. Discovers all variables from enabled libraries
2. Discovers all text styles (local + library)
3. Discovers all components on the page
4. Preloads variables into the plugin cache
5. Computes enforcement profile (strict/permissive)
6. Advances to Phase 2 (build-ready)

If multiple DS libraries are detected, it returns a prompt.
Re-call with the chosen `libraryKey`.

Check `completenessWarnings` in the response. If components
were not found on the page, use Figma MCP
`search_design_system` to find them by name.

After discovery, call `mimic_map_components` with the HTML
element types to get the exact component keys for the build.

The individual tools (`figma_discover_library_styles`,
`figma_discover_library_variables`, etc.) still exist for
manual use if needed, but `mimic_discover_ds` replaces the
5-step sequence.

## Core Rules

1. Components first. If the DS has it, use it — even if the
   layout doesn't match exactly. Intent over pixel-matching.
2. Mandatory components: Buttons, Badges, Input fields, Table
   cells, Table header cells, Tabs, Dropdowns, Textareas, and
   Avatars MUST always use DS components. Never build these as
   primitives. If import fails, STOP — do not substitute.
3. Text and color are non-negotiable. Every text node: DS text
   style (textStyleId) + DS color variable (fillVariable).
   No exceptions. Use fontSizeVariable ONLY if no text style
   exists for the size.
4. Spacing/radius: bind to DS variables when available, raw
   values acceptable if DS lacks them.
5. Auto-layout everywhere. FILL widths, HUG heights.
   Fixed width only on the artboard (1440px).
6. Cards in a horizontal row: layoutSizingVertical = FILL so
   they match height. Never HUG on cards in a row.
7. After inserting any component — read `configurationChecklist`
   in the response. It tells you EXACTLY what to do. The steps
   are always:
   a. Read `configurationChecklist` — it has
      ENABLE_BOOLEANS_IF_NEEDED, OVERRIDE_ALL_TEXT, and
      SET_VARIANTS actions. Do ALL of them.
   b. **Booleans are auto-disabled at insertion time.** The
      plugin turns OFF all boolean properties (hint text,
      help icons, trailing icons, asterisks, etc.) when a
      component is inserted. You only need to RE-ENABLE
      booleans that the source HTML explicitly shows. If the
      HTML has no icons, no hint text, no asterisks — do
      nothing. The component is already clean.
   c. Set the correct variant properties via
      `figma_set_variant`. Always check what the current
      values are and change any that don't match the HTML.
   d. Override ALL text via `figma_set_component_text`. Use
      the `textNodes` list — every node listed must get real
      content from the HTML. No placeholder text ever.
   e. Set layoutSizingHorizontal to FILL when the component
      should stretch to fill its container.
   CRITICAL: If `disabledBooleans` is empty in the response,
   auto-disable did not run — manually disable all booleans
   the HTML doesn't show.
8. Dividers and separators: search for a DS component first
   (e.g. "Content divider"). Never use raw rectangles for
   visual separators. After inserting, check variantProperties
   for the right type, override any text, and set FILL width.
9. HTML is the source of truth for content. Same text, same
   structure, same order. Don't invent or improve.
10. Feedback means iterate the existing artboard.
    Never delete artboards.
11. Every build MUST end with `mimic_generate_build_report`.
    This is NOT optional — it is the tool's key differentiator.
    The report teaches users about DS usage, gaps, patterns,
    and efficiency. A build without a report is incomplete.
    Call it BEFORE responding to the user with build results.
12. Name every node after its HTML role. "Header Section" not
    "Frame". "Card: Total Users" not "Frame". This enables
    iteration — finding nodes by name instead of traversing.
13. Section-level elements (header, footer, sidebar) MUST use
    DS components if they exist. `figma_discover_library_components`
    only scans page instances — if no match is found, you MUST
    search the library via Figma MCP `search_design_system` before
    building a custom section. Never build a custom footer/header
    without first confirming the DS has no component for it.

## Safety Guardrails

- **Binding feedback**: Every create/edit tool returns
  `applied` (what DS bindings succeeded) and `warnings`
  (what failed). If `bindingFailures: true`, the node has
  missing DS bindings. Check `_bindingWarning` for specifics.
  DO NOT continue building if bindings are failing — fix the
  variable paths first using `figma_read_variable_values`.
- **Variable validation**: All `*Variable` params are checked
  against the DS cache before reaching the plugin. Wrong paths
  return suggestions, not silent failures.
- **Circuit breaker**: 3 consecutive failures → all build tools
  blocked until you generate the report. Status/QA/report tools
  remain available.
- **Build checkpoint**: After 20 build operations in Phase 3,
  a checkpoint message prompts you to verify progress before
  continuing.
- **Build limit**: 200 tool calls in Phase 3 → forced stop.
  Generate the report and assess.

## Artboard Setup

1. Create the artboard with x/y position. Query page nodes
   first, place at rightmost artboard x + width + 80px.
2. Call `figma_set_all_variable_modes` with the artboard
   nodeId. This sets default modes on ALL variable collections
   (including library collections). Without it, DS variables
   render as black.
3. Use modeIndex=0 for light, modeIndex=1 for dark.

## Tool Guidance

Each tool response includes:
- `applied`: Which DS bindings succeeded (true/false per binding)
- `warnings`: What failed and why (variable not found, style not importable)
- `bindingFailures`: true if ANY binding failed — treat as a red flag
- `_bindingWarning`: Human-readable summary of what went wrong
- `hint`: Next step guidance

**If you see `bindingFailures: true` — STOP and fix before continuing.**
The most common cause is wrong variable paths. Call
`figma_read_variable_values` to see the actual cached paths.

## Chart Computation

Use `mimic_compute_chart` for all chart geometry. NEVER hand-write
SVG arc paths, trig, or coordinate math — the tool does it all.

Supported types:
- **line**: data as `{label, value}` or `{x, y}` — returns `pathD`
- **bar**: data as `{label, value}` — returns scaled heights
- **donut**: returns `svgPaths[]` with ready-to-use SVG path strings
  for each segment. `innerRadius` can be absolute px (>1) or
  ratio (0-1). Center is at `(outerRadius, outerRadius)`.
  Use the `pathD` from each segment directly in the SVG `<path d="">`.
- **radar**: `maxValue` auto-derived from data if not provided
- **scatter**: data as `{x, y}` — normalized to plot dimensions
- **heatmap**: data as `{row, col, value}` — cell positions

### Chart Build Rules (MANDATORY)

Charts are built as single SVGs via `figma_create_svg`. Every
chart response includes `_chartBuildRules` with the full
mandatory workflow. Follow ALL rules — they exist because
the defaults produce broken output.

#### Preferred: Native Auto-Layout Charts (No SVGs)

Build charts with native Figma primitives whenever possible.
This produces editable, responsive charts that survive
copy-paste between artboards.

**Bar charts (vertical):**
- Chart area: HORIZONTAL frame, FILL width, HUG height
- Per bar: VERTICAL column (FILL width, HUG height,
  counterAxisAlignItems=CENTER, gap=spacing-xs) containing:
  1. Spacer rectangle (bg-primary fill, fixed height =
     maxBarHeight - thisBarHeight) — invisible, pushes bar down
  2. Bar rectangle (fixed 24px width, fixed height = value,
     DS color fill, radius-xs)
  3. Label text (DS text style + DS color)
- Skip spacer for the tallest bar (height=0 not needed)

**Donut/pie charts:**
- Container: VERTICAL frame (FILL, HUG, counterAxisAlignItems=CENTER)
- Ring: NONE-direction frame (fixed 160x160) containing
  overlapping `create_ellipse` nodes with `arcData`
  (startingAngle, endingAngle, innerRadius as 0-1 ratio)
- Legend: HORIZONTAL frame with dot+label pairs below

**Horizontal bar charts:**
- Per row: HORIZONTAL frame (FILL, HUG, counterAxisAlignItems=CENTER, gap=spacing-sm)
  containing: label text (fixed width) + bar rectangle
  (fixed width proportional to value, 8px height, radius-full)
- No track frame needed — just the colored bar rectangle

**Key rules:**
- `create_frame` height parameter NOW works (fixed in plugin).
  `set_layout_sizing` can also resize with width/height params.
- Rectangles always respect width/height — use them for spacers
  and bars, not frames.
- SVG text breaks in Figma (tiny fixed widths, character stacking).
  Always use native Figma text nodes for labels.
- For SVG-only elements (complex paths), use vector-only SVGs
  with NO text, then add Figma text nodes outside the SVG.

#### SVG Fallback Rules (When Native Won't Work)

Use SVGs only for geometry that can't be built with primitives
(complex paths, radar polygons, scatter with many points).

- Use `<rect height="1" fill="...">` for grid lines — NEVER
  `<line stroke="...">`. No `figma_set_node_stroke` tool exists.
- NEVER include `<text>` elements in SVGs — Figma imports them
  as tiny fixed-width text nodes that break. Use native Figma
  text nodes outside the SVG instead.
- SVG nodes MUST use `layoutSizingHorizontal: "FILL"`.
- After creation, bind ALL vector children to DS variables via
  `figma_set_node_fill` (grid → border-secondary, data → palette).

#### Line Charts (CRITICAL — DO NOT USE SVG STROKES)

Figma converts SVG `stroke` attributes into thick filled shapes.
A `<path stroke="..." stroke-width="2">` becomes a solid filled
blob, NOT a thin line. This makes SVG-based line charts unusable.

**Build line charts natively:**
1. Container: NONE-direction frame (fixed plotWidth × plotHeight)
2. Grid lines: horizontal create_rectangle (FILL width × 1px
   height, border-secondary fill) at each y-axis tick position
3. Area fill: single SVG `<path>` with fill ONLY (no stroke) —
   closed polygon from data points down to baseline. Low opacity.
4. Data points: create_ellipse at each point (6×6px, DS fill)
5. Axis labels: native Figma text nodes OUTSIDE the chart frame

The area fill SVG MUST be a closed shape: trace all points
left-to-right → bottom-right corner → bottom-left corner.
Use `fill="#hex" opacity="0.15"` and NO stroke attribute.

#### Donut/Pie Legends (CRITICAL — NO TEXT DOTS)

NEVER use `●` characters in text nodes for legend color
indicators. Text nodes inherit a single color — the dots
cannot be individually colored to match chart segments.

**Build legends as colored indicators:**
- Per item: HORIZONTAL frame (HUG, gap=spacing-xs, center-aligned)
  containing: create_rectangle (8×8px, radius-full, DS fill
  matching segment color) + text node (DS style, text-tertiary)
- Wrap items in HORIZONTAL frame with gap=spacing-xl

#### Radar Charts (Limited Fidelity)

SVG strokes become filled shapes in Figma, making grid lines
thick bands. Use ONLY filled polygons with decreasing opacity
for grids (outermost=0.15 → innermost=0.03). Data polygons:
filled, low opacity (0.12-0.20), NO stroke.

#### Anti-Patterns (NEVER DO THESE)
- NEVER use `stroke` in SVGs — produces thick blobs, not lines.
- NEVER put text in SVGs — renders as stacked characters.
- NEVER leave SVG vector children without DS fill bindings.
- NEVER use `●` in text for chart legends — not individually
  colorable. Use create_rectangle/create_ellipse instead.
