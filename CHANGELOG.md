# Changelog

## 1.6.0 (2026-04-29)

### Breaking
- **Default dsMode is now `strict`** -- previously defaulted to `permissive`. Builds start with full DS enforcement. If your DS has no published tokens (component-only library), the plugin now validates this before accepting `permissive`.

### Added
- **Conditional permissive mode** -- `set_session_defaults(dsMode: "permissive")` is now rejected when the DS has published variables or text styles. Returns `DS_PERMISSIVE_REJECTED` with the token count. Permissive mode is only accepted for component-only DSs with genuinely zero tokens.
- **Immutable dsMode** -- once set to `strict`, dsMode cannot be downgraded to `permissive` in the same session. Prevents mid-build enforcement bypass. Returns `DS_PERMISSIVE_REJECTED` explaining the lock.
- **Discovery gate upgraded to error** -- creating a page-level frame (artboard) without DS discovery now returns `DS_DISCOVERY_REQUIRED` error and does NOT create the artboard. Previously this was a warning that allowed the artboard to be created anyway.
- **Raw fallback threshold (Rule 49)** -- plugin tracks `rawFallbackCount`. After 5 nodes with raw fallbacks in strict mode, `RAW_FALLBACK_THRESHOLD` warning is emitted on every subsequent node creation. Catches cascading DS compliance failures early.
- **Rule 47: Style preload retry protocol** -- when styles timeout, retry in batches of 3, then individually. Never switch to permissive as a workaround. 3 consecutive individual failures = BLOCKER.
- **Rule 48: Mandatory knowledge load** -- `mimic_ai_knowledge_read` must be called before every build to load cached component mappings.
- **Rule 49: Token waste threshold** -- if 5+ nodes are created with raw fallbacks in strict mode, build must pause for root cause investigation.
- **46 -> 49 golden rules** -- updated GOLDEN_RULES.md, CLAUDE.md, ROLES.md, README.md.

## 1.5.0 (2026-04-28)

### Fixed
- **Critical: component import timeout cascade** -- `ATTEMPT_TIMEOUT` increased from 20s to 45s. Complex component sets (inputs, dropdowns, toggles) need 25-40s for cold-start download via `importComponentByKeyAsync`. The 20s timeout caused consistent failures, and 3 retries per component (15 failed API calls total) destabilized the plugin WebSocket, killing builds mid-way. Reduced `MAX_RETRIES` from 3 to 2 to limit cascade damage.
- **Failed component key caching** -- New `failedComponentKeys` session cache. When a component key fails to import, all subsequent calls for the same key return instantly instead of waiting another 90s. Prevents the import cascade that destabilizes the plugin. Cache cleared on `set_session_defaults` (new build session).
- **Bridge timeout alignment** -- `insert_component` bridge timeout updated from 90s to 100s to match the new plugin timing (45s x 2 + 2s pause = 92s).

### Added
- **`figma_create_svg` tool** -- Import SVG strings into Figma as vector frames. Supports DS color variable binding on child vectors via `fillVariable`/`strokeVariable`. Used for line charts, radar polygons, area fills, and other geometric shapes that require path data.
- **`figma_set_text_style` tool** -- Apply a DS text style to an existing text node by ID. Used for post-creation style application on text nodes inside charts or SVG-adjacent labels.
- **`figma_set_variable_mode` handler** -- Set explicit variable mode on a frame (e.g., dark mode). Calls `setExplicitVariableModeForCollection` on the target node.
- **Phase 1 enforcement gate** -- Plugin tracks `dsDiscoveryPerformed` flag. In strict mode, creating artboards without prior DS discovery returns `DS_DISCOVERY_REQUIRED` warning. Prevents builds that skip Phase 1 from producing primitive-only output.
- **Native chart building protocol** -- Charts built with `create_frame`, `create_text`, `create_rectangle`, `create_ellipse`, and `create_svg` instead of `figma_create_chart`. Achieves 100% DS compliance (0 violations vs 125 with the convenience tool). Documented per-chart-type patterns in CLAUDE.md and GOLDEN_RULES.md.
- **Batch operation timeout** -- Bridge batch timeout set to 600s to cover large sequential operations in strict DS mode.

## 1.4.0 (2026-04-24)

### Fixed
- **Component import race condition**: Both `importComponentByKeyAsync` and `importComponentSetByKeyAsync` now reject immediately when both fail, instead of waiting 55s for a timeout. Previously, the MCP client gave up before the plugin responded, causing valid component keys to appear broken.
- **Empty frame garbage collection**: Frames with explicit dimensions now default to FIXED on the primary axis only (not counter axis), preventing Figma from collapsing empty auto-layout frames to 0×0. Counter axis always defaults to HUG unless explicitly overridden.
- **Variable path resolution**: `getVariableByPath` now resolves variables with or without collection name prefix (e.g., both `Colors/Background/bg-primary` and `1. Color modes/Colors/Background/bg-primary` work). Variables are cached with collection-prefixed keys on first load.
- **set_node_fill on frames**: FRAME, SECTION, COMPONENT nodes now get fills and strokes applied directly instead of walking to vector descendants. Previously, applying a stroke to a card frame would create a stray Rectangle instead of styling the frame.
- **Text style import font loading**: Fonts are now loaded BEFORE applying `textStyleId`, not after. Fixes silent style application failures when the style's font wasn't pre-loaded.

### Added
- **Active file info in mimic_status**: New `active_file` field returns the plugin's current file name and page, so Phase 0 can verify the build target matches the plugin context.
- **get_file_info plugin handler**: Returns `fileName`, `currentPageId`, `currentPageName`, and `pageCount` from the active Figma file.

## 1.3.2 (2026-04-24)

### Changed
- **README rewrite**: New structure led by elevator pitch framing. Learning loop and DS gap detection as hero sections. "What changes after 10 builds" section. Preserved all technical elements (badges, MCP configs, 45 tools, Figma setup, golden rules reference).

## 1.3.1 (2026-04-23)

### Fixed
- **README tool count**: Updated from 35 to 45. Added 10 tools that were missing from the documentation (batch, ellipse, chart, discover styles/variables, compliance, restyle, tag exception, pipeline resolve, render URL, DESIGN.md generator).
- **KNOWN_ISSUES accuracy**: Configuration recipes status updated (active since v1.2.0, not "being rolled out"). Added npx mode `FIGMA_ACCESS_TOKEN` limitation.
- **Boundary violation**: Removed internal DS name from `mimic_ai_knowledge_write` tool description.

## 1.3.0 (2026-04-23)

### Added
- **Efficiency tracking in build reports**: New "Efficiency" section shows total tool calls, cache hits, saved-vs-cold estimates, and DS component call savings. Zero extra tool calls. Uses counters already tracked in-memory during builds.
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
- **DESIGN.md generator** (`mimic_generate_design_md`): Compiles your DS into the open DESIGN.md format, compatible with Google Stitch, generative UI tools, and AI coding agents. Includes color tokens, typography, spacing, radius, and component patterns from builds.
- **Component description suggestions**: Workflow for generating component descriptions from Mimic's usage data. Ask Mimic to suggest descriptions based on how components are actually used across builds.
- **No-internal-names rule** in CLAUDE.md: Creator's company/brand names never appear in committed files.

### Changed
- **README rewrite**: Empathy-first positioning backed by research. "Learns your design system. Builds with it. Gets better every time." Comparison table, learning section as hero, DS enrichment angle (Figma Make, Stitch, generative UI), vibe design section.
- **Positioning strategy**: Full competitive analysis documented (opportunity-analysis.html). 11 capabilities mapped with honest status assessment.

## 1.1.6 (2026-04-22)

### Added
- **Rules 45-46**: Artboard always 1440px FIXED width. HTML container fidelity via `maxWidth`. CSS `max-width + margin: auto` maps to Figma FILL + maxWidth + parent CENTER.
- **CSS → Figma mapping table** in CLAUDE.md: flex/grid properties map 1:1 to auto-layout (direction, sizing, gap, alignment, overflow).
- **`maxWidth` / `minWidth`** support on `create_frame` and `set_layout_sizing`.
- **Role obligations restructure**: builder vs end-user context with concrete obligation lists. Phase 5 explicitly mandatory even during bug-fixing sessions.

### Fixed
- **Bar chart handler rewrite**: bars distribute evenly via `layoutGrow:1`, bottom-aligned via `counterAxisAlignItems: MAX`. Removed absolute-positioned plot-area. Bars now participate in auto-layout and fill their container correctly.
- **Donut chart legend (bottom)**: auto-layout VERTICAL with SPACE_BETWEEN items (label+dot left, percentage right). Donut geometry in separate NONE-layout sub-frame.
- **`set_node_fill` reporting**: fallback path now correctly returns `applied: true` when fill is applied to a frame.

## 1.1.5 (2026-04-22)

### Added
- **Community library full support**: components, text styles, and variables all work. Variables use key-based import, discovered via Figma REST API, imported via Plugin API `importVariableByKeyAsync`.
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
- **`textFillStyleKey` no longer required** on `set_session_defaults`. Was blocking variable-only DSs.

### Changed
- **44 → 46 golden rules**: added Rule 43 (DS-only foundational constraint), Rule 44 (mandatory stop), expanded Rule 38 (zero raw values).

## 1.1.4 (2026-04-21)

- Cold-start reliability improvements
- Overlap prevention on component insertion
- DS-agnostic session defaults
