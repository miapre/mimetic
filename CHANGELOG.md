# Changelog

## 1.3.0 (2026-04-23)

### Added
- **Efficiency tracking in build reports**: New "Efficiency" section shows total tool calls, cache hits, saved-vs-cold estimates, and DS component call savings. Zero extra tool calls — uses counters already tracked in-memory during builds.
- **Economic DS gap recommendations**: Gap recommendations now include tool-call savings estimates. "Adding a Metric Card would save ~20 calls/build" instead of just "seen 5 times." Helps users prioritize which DS components to add.
- **Efficiency line in Phase 5 output**: Terminal summary now shows tool call count, cache hits, and savings. One line, zero extra cost.
- **README cost & efficiency section**: Honest cost model showing how builds get cheaper over time (cold ~140 calls → warm ~80 → hot ~55). Documents what drives cost down and what users can do about it.
- **`toolCallCount`, `cacheHits`, `coldBuildEstimate` params** on `mimic_generate_build_report`: Build orchestrators pass efficiency data for inclusion in reports.
- **`instances` field on primitives**: Primitives array now accepts an instance count per element type, used for per-gap savings projections.

### Fixed
- **`set_layout_sizing` padding in strict mode**: Accepts DS variable path strings (e.g., `spacing/spacing-xl`) in addition to numbers. Previously rejected valid DS paths as raw values.
- **Donut chart `categoryVariables`**: Maps category-level DS color variables to individual data entries. No more strict mode failures on donut charts with DS colors.
- **HTML build report tables**: Replaced regex-based markdown→HTML table converter with a line-by-line parser. Tables now render as clean `<table>` markup instead of broken fragments.
- **DESIGN.md generator accuracy**: Deduplicates colors, spacing, radius, and components by name/key. Removes fake `fontSize` values. Shows `token` placeholder for unresolvable variable values instead of null.

## 1.2.0 (2026-04-23)

### Added
- **Build report generator** (`mimic_generate_build_report`): Compiles DS compliance data, learned patterns, and gap recommendations into a structured report (markdown or HTML). Shareable with your team.
- **DESIGN.md generator** (`mimic_generate_design_md`): Compiles your DS into the open DESIGN.md format — compatible with Google Stitch, generative UI tools, and AI coding agents. Includes color tokens, typography, spacing, radius, and component patterns from builds.
- **Component description suggestions**: Workflow for generating component descriptions from Mimic's usage data. Ask Mimic to suggest descriptions based on how components are actually used across builds.
- **No-internal-names rule** in CLAUDE.md: Creator's company/brand names never appear in committed files.

### Changed
- **README rewrite**: Empathy-first positioning backed by research. "Learns your design system. Builds with it. Gets better every time." Comparison table, learning section as hero, DS enrichment angle (Figma Make, Stitch, generative UI), vibe design section.
- **Positioning strategy**: Full competitive analysis documented (opportunity-analysis.html). 11 capabilities mapped with honest status assessment.

## 1.1.6 (2026-04-22)

### Added
- **Rules 45-46**: Artboard always 1440px FIXED width. HTML container fidelity via `maxWidth` — CSS `max-width + margin: auto` maps to Figma FILL + maxWidth + parent CENTER.
- **CSS → Figma mapping table** in CLAUDE.md: flex/grid properties map 1:1 to auto-layout (direction, sizing, gap, alignment, overflow).
- **`maxWidth` / `minWidth`** support on `create_frame` and `set_layout_sizing`.
- **Role obligations restructure**: builder vs end-user context with concrete obligation lists. Phase 5 explicitly mandatory even during bug-fixing sessions.

### Fixed
- **Bar chart handler rewrite**: bars distribute evenly via `layoutGrow:1`, bottom-aligned via `counterAxisAlignItems: MAX`. Removed absolute-positioned plot-area — bars now participate in auto-layout and fill their container correctly.
- **Donut chart legend (bottom)**: auto-layout VERTICAL with SPACE_BETWEEN items (label+dot left, percentage right). Donut geometry in separate NONE-layout sub-frame.
- **`set_node_fill` reporting**: fallback path now correctly returns `applied: true` when fill is applied to a frame.

## 1.1.5 (2026-04-22)

### Added
- **Community library full support**: components, text styles, and variables all work. Variables use key-based import — discovered via Figma REST API, imported via Plugin API `importVariableByKeyAsync`.
- **`textFillVariable`** on `set_session_defaults`: alternative to `textFillStyleKey` for DSs that use variables instead of color styles (community libraries).
- **`plugin_connected`** field on `mimic_status` response.
- **DS enforcement modes**: `dsMode: "strict"` rejects raw values, `"permissive"` allows fallbacks. Set via `set_session_defaults`.
- **`validate_ds_compliance`** tool: post-build audit that walks all nodes and flags raw fills, raw text, raw spacing, fixed sizing.
- **Mandatory stop protocol** (Rule 44): build stops when DS library is unreachable instead of silently degrading.
- **KNOWN_ISSUES.md**: compatibility matrix for team/community/no-library configurations.

### Fixed
- **Null-cache poisoning in `preload_variables`**: once `getVariableByPath` cached a variable as null (not found), `preload_variables` skipped it on subsequent calls. Variables were permanently broken for the session. Now checks for null before skipping.
- **Bridge status detection**: `mimic_status` was hitting `/health` (404) instead of `/status`. Bridge always reported as down.
- **DS-agnostic enforcement**: removed 20+ hardcoded Inter font references and 14+ Untitled UI color values from plugin code. All DS-specific values now come from session defaults or runtime discovery.
- **Text style font loading**: plugin applies text style BEFORE setting characters, ensuring the correct font family loads (fixes Roboto/SF Pro not rendering on community libraries).
- **`textFillStyleKey` no longer required** on `set_session_defaults` — was blocking variable-only DSs.

### Changed
- **44 → 46 golden rules**: added Rule 43 (DS-only foundational constraint), Rule 44 (mandatory stop), expanded Rule 38 (zero raw values).

## 1.1.4 (2026-04-21)

- Cold-start reliability improvements
- Overlap prevention on component insertion
- DS-agnostic session defaults
