# Changelog

## 2.0.3 (2026-07-14)

### Security

Three vulnerabilities fixed from an internal audit:
- **MIMIC-01 (HIGH)** — the WebSocket bridge bound to `0.0.0.0` with no
  Origin validation and `Access-Control-Allow-Origin: *`. Now binds to
  `127.0.0.1` only, validates Origin on both HTTP and WebSocket
  connections, and returns a dynamic CORS origin instead of a wildcard.
- **MIMIC-02 (MEDIUM)** — `mimic_pipeline_resolve` allowed path
  traversal. File reads are now confined to `process.cwd()`; absolute
  paths and `../` traversal are rejected.
- **MIMIC-03 (LOW)** — the plugin's `networkAccess.allowedDomains` was
  set to `["*"]`. Restricted to `["localhost"]`, and a stale port
  reference in a reasoning comment was corrected.

### Learning system

- No-good compilation: recurring failure signals become candidate
  rules at 3 occurrences and are promoted to active at 6
- Signal store on `KnowledgeStore`: dedup, 200-entry cap, 20-build
  rolling eviction window
- Staleness detection now runs at DS discovery time (not just at
  report time), with self-heal on the next successful build
- Stale recipes are skipped in the component-first gate and template
  replay, and surfaced with stale badges in `mimic_status` and the
  build report's Component Confidence section
- Mapped-component enforcement: `mimic_map_components` output is now
  cross-referenced at build time — a frame matching a mapped component
  blocks with `MAPPED_COMPONENT_AVAILABLE`; the report audits any
  mapped component that was never inserted
- `mimic_ai_knowledge_write` supports status-only updates — confirming
  or dismissing a candidate rule merges the status instead of
  overwriting the rule
- Build report expanded with a DS Changes section: stale recipes
  (component removals, variant changes) with affected-instance impact

### Report integrity

- Structural validation now actually executes. It was previously
  silently skipped (a missing context destructure threw a swallowed
  `ReferenceError`), so every report claimed validation passed without
  it ever running. `validationStatus` is now honest and four-state
  (PASS/WARN/FAIL/UNAVAILABLE), starting from UNAVAILABLE so a
  swallowed error can no longer masquerade as success
- Rule matching switched from substring `includes()` to whole-word
  token matching — "tab" no longer matches rules about "table" and
  produces phantom violations
- Only active rules (confirmed/verified) are injected into
  `figma_create_frame` / `figma_insert_component` responses; candidate
  and dismissed auto-compiled rules no longer leak into build guidance
- Recommendations now lead with a component-first quality gate failure
  instead of reporting good build quality under a failing gate
- Removed the invalid cross-build "N% fewer tool calls" comparison
  from Recommendations and the Learning Trend section; replaced with
  cache-hit and template/layout replay savings, which are valid
  same-build metrics

### Chart fixes

- Line charts now run the post-import DS-variable binding pass (donut
  and radar already did this; line charts previously discarded the
  `create_svg` result and shipped unbound hardcoded hex for grid, area,
  and dots)
- Grid and line geometry use filled shapes instead of SVG strokes,
  which Figma renders as thick blobs
- Legend dot radius now binds via `cornerRadiusVariable` (the
  parameter the plugin actually reads — `radiusVariable` was silently
  ignored)
- Fallback chart palette no longer contains Brand/Success/Warning/
  Error; the response now states explicitly when the fallback engaged

### Plugin

- Added the missing `set_node_props` handler — the documented
  `firstColumnPaddingLeft` / `lastColumnPaddingRight` table parameters
  previously did nothing because the dispatcher returned "Unknown
  handler" and call sites swallowed the error
- Fixed community-library variable key lookup — a read/write key
  mismatch (`communityLibraryKeys` vs. `communityLibraryVariableKeys`)
  meant the key always resolved to `null`

### Knowledge store

- `save()` is atomic (temp file + rename) — a crash mid-write can no
  longer corrupt the store
- `load()` never throws — corrupt or unsupported-version files are
  backed up to `ds-knowledge.json.corrupt-<timestamp>`, a fresh store
  is created, and a warning is surfaced instead of the MCP server
  silently failing to start
- Canonical store location is `~/.mimic-ai/ds-knowledge.json`
  (override via `MIMIC_KNOWLEDGE_PATH`), with one-time automatic
  migration from the old cwd-relative location — learning no longer
  fragments per working directory
- Report generation clears `buildsSinceReport` before writing report
  files; file-write failures degrade to a response warning with a
  `~/.mimic-ai` fallback instead of wedging the session in
  `REPORT_REQUIRED`

### Bridge

- Startup no longer kills processes on the bridge port. On
  `EADDRINUSE` the bridge probes the existing listener: another Mimic
  session produces a clear "already running" error, anything else a
  plain port-in-use error. `MIMIC_BRIDGE_PORT` overrides the port
- Keepalive now tracks pongs — a frozen or half-open plugin
  connection is terminated at the next tick and pending operations
  fail fast with `PLUGIN_DISCONNECTED` instead of burning the full
  operation timeout
- In-flight requests are rejected immediately when the plugin
  connection closes or is superseded by a reconnect, instead of
  waiting out the timeout
- The plugin relay now identifies itself with a hello message before
  the bridge treats it as the executor; unparseable or unknown
  messages are logged and ignored
- `/execute` request bodies are capped at 2 MB (413 beyond)
- Removed dead `pendingOps` queue machinery and its misleading
  `/status` field

### Text handling

- `figma_create_text` and `figma_set_text` strip hardcoded line
  breaks (`\n` / `\r\n`) — container width controls wrapping in
  auto-layout; the response notes when stripping occurred. Component
  text overrides are unaffected

### Documentation

- Reconciled the two KNOWN_ISSUES files (root = public platform
  quirks, internal = compatibility matrix), fixing stale claims:
  keepalive interval, knowledge-store path and reset schema
- Golden rules and CLAUDE.md rule sets brought to parity (19 rules)
- README: corrected DS-evolution claims to current detection
  behavior, absolute image URLs (render on npm), visible Figma
  desktop + Professional plan prerequisites, manual install path
  documented alongside the installer script

### Packaging

- Added `repository`, `homepage`, and `bugs` metadata to `package.json`
- Expanded `keywords` for discoverability
- Excluded `assets/` from the npm tarball
- Server version is read from `package.json` (was a hardcoded string
  that had drifted to 2.0.0)

### Test count: 485 (was 384)

---

## 2.0.2 (2026-05-22)

### Learning enforcement

The learning system now enforces what it learns, not just stores it.

#### Design rules engine
- User-defined rules persist in the knowledge store and are enforced during builds
- Rules are injected at point of use: `figma_create_frame` and `figma_insert_component` surface matching rules in their responses based on frame name and component type
- Rules also loaded at session start via `mimic_status` for full visibility
- Build report audits rule compliance: violations detected for structure, component, and color rules with evidence
- Five rule categories: color, variable, structure, component, spacing
- Save via `mimic_ai_knowledge_write` with `type: "rule"`

#### Variable category enforcement
- `validateVariables` detects category mismatches: bg-* used for strokes warns (should be border-*), bg-* on text warns (should be text-*), border-* on fills warns (should be bg-*)
- fg-* treated as ambiguous (no warning)
- Mismatches produce warnings but don't block builds (the variable path IS valid)
- Session tracks mismatches for the build report recommendations section
- Raw `cornerRadius` warns when the DS has radius variables (`enforceRadiusVars`)

#### Component-first gate from knowledge store
- Confirmed and verified component recipes block primitive frame creation with `KNOWN_COMPONENT_EXISTS`
- Returns the stored `componentKey` in recovery guidance so the LLM uses the real component
- Catches component types not in the hardcoded pattern list (e.g., "Progress Bar", "Metric Card") once they've been used in 3+ builds

#### Build guards
- Plugin disconnect during active build (Phase 3-4) sets `buildInterrupted` flag, blocks all non-exempt tools
- Bridge error messages explicitly say "do NOT use other Figma tools as a fallback"
- `mimic_status` clears the flag when plugin reconnects
- `figma_delete_node` checks parent type: PAGE children (artboards) are blocked with `ARTBOARD_DELETE_BLOCKED`

#### Build report
- New "Recommendations" section: missing variable categories, category mismatches detected during build
- New "Rule Compliance" section: violations or all-clear message with rules-checked count
- Response includes `_presentationRules` instructing the LLM to offer an HTML report
- Chart `suggestedPalette` no longer includes Brand, Success, Warning, or Error colors
- New `colorRules` array in chart responses with explicit semantic color restrictions

#### Table builder
- `firstColumnPaddingLeft` and `lastColumnPaddingRight` parameters for card-inset tables
- Applied to all header cells and data cells of the first/last columns

#### CLAUDE.md
- 18 core rules (was 16): added variable categories (rule 5) and color semantics (rule 6)
- Content fidelity rule strengthened: "character for character" matching mandate
- Build report presentation rule updated: always offer HTML format
- Plugin disconnect rule in Safety Guardrails
- New "Design Rules" section documenting persistent rules engine usage

### Test count: 384 (was 212)

---

## 2.0.1 (2026-05-21)

### Bug fixes
- Auto-retry on first component import timeout for large libraries (5000+ components)
- Score-based component matching: component sets rank above icons in REST API cache

---

## 2.0.0 (2026-05-20)

Complete rewrite from scratch.

### Architecture
- Split MCP server (intelligence) / plugin (enforcement gate)
- Embedded bridge — no separate process to start
- Chart geometry computed in Node.js (not by LLM)
- Graduated DS enforcement — adapts to what the DS provides
- Phase enforcement — mechanical sequencing in MCP layer
- WebSocket keepalive + auto-reconnect

### Added
- Variable path validation — all `*Variable` params checked against DS cache before plugin; returns suggestions on mismatch
- Circuit breaker — 3 consecutive failures blocks build tools, forces report generation
- Build checkpoint — after 20 Phase 3 operations, prompts verification before continuing
- Build limit — 300 Phase 3 calls triggers forced stop
- `figma_set_all_variable_modes` — sets default mode on all collections at once (no collection name guessing)
- Plugin error surfacing — recovery hints and available options from plugin errors now visible to the LLM
- Component import timeout increased to 120s (was 60s) for cold library imports
- Fuzzy collection name matching in `set_variable_mode` (strips prefix numbers, case-insensitive)
- First build always succeeds on any DS configuration
- Chart calculation engine — deterministic bar/donut/line/radar/scatter/heatmap geometry
- Contextual tool responses — every tool returns hints, available values, recovery paths
- 7-step component configuration protocol with icon library detection
- DS gap tracking with savings estimates across builds
- Three-trigger learning model (correction → confirmation → auto-promote)
- Template replay — confirmed component recipes auto-applied on insert (variants, booleans)
- Layout structure replay — frame configs (direction, padding, gap, fill) learned and reused per pattern
- Text batch optimization — `figma_batch_set_component_text` sets all text overrides in one call
- Text style name-to-key resolution — text styles matched by name when exact key unavailable
- Inline component sizing — Badge, Avatar, and similar components skip auto-FILL, keep HUG
- DS gap noise filtering — layout containers excluded from gap tracking
- REST API discovery — library components and text styles fetched via Figma REST API (replaces page scanning)
- DS change detection — fingerprint-based comparison surfaces new/removed components between builds
- ~26 focused source files (was 1 x 203KB monolith)
- 207 automated tests (was 31)

### 2.0.0-alpha.6 (2026-05-15)

#### Auto-resolve fix for knowledge store
- `searchComponent()` now skips knowledge store entries with null `componentKey` and falls through to the DS cache
- Previously, entries learned as gaps (no component found) returned `found: true` with `componentKey: null`, blocking the DS cache search
- Fixes `mimic_build_table` auto-resolve: table cell/header cell keys are now found from the REST API cache when the knowledge store only has gap entries
- 4 new tests for `DsDiscovery.searchComponent` covering null-key fallthrough, library filtering, and cache miss

#### Community library support (skipRestApi)
- New `skipRestApi` parameter on `mimic_discover_ds` allows discovery to proceed without the library file key
- Community libraries are accessible via Figma but their file keys are not available to users
- When set, discovery uses plugin-only data (variables + page-scan components) and skips the REST API component fetch
- Components are then found via the Figma MCP `search_design_system` + `mimic_map_components` two-call workflow
- Discovery prompt now mentions the `skipRestApi` escape hatch

#### Test count: 109 (was 105)

### 2.0.0-alpha.5 (2026-05-13)

#### Font-incompatible library handling
- `figma_insert_component` detects font loading errors (`unloaded font`, `loadFontAsync`) and returns structured `LIBRARY_FONT_INCOMPATIBLE` error instead of throwing
- Sets `libraryFontIncompatible` flag on the DS cache — persists for the session, resets on `clear()`
- `figma_create_frame` component-first gate auto-bypasses when flag is set — no more `confirmedNoComponent` + `primitiveOverrideReason` needed on every frame
- `mimic_status` exposes the flag in `dsCache.libraryFontIncompatible`

#### Variable source mismatch warning
- After library selection, `mimic_discover_ds` checks if the selected library has any variables cached from the file
- If no variables belong to the selected library, `completenessWarnings` includes a `VARIABLE SOURCE MISMATCH` warning listing which libraries actually provide the tokens
- Prevents silent builds where components come from one library but all styling comes from another

### 2.0.0-alpha.3 (2026-05-13)

#### Community library detection enforced at tool level
- `mimic_discover_ds` is now a two-step process: plugin discovery (Phase 1) → community library check (Phase 2)
- Build tools are blocked at Phase 1 until `communitySearchResults` are provided — the LLM cannot skip the check
- New `communitySearchResults` parameter accepts library names from Figma MCP `search_design_system`
- If community search finds libraries the plugin missed, auto-generates a multi-library prompt with source labels (plugin vs search)
- `libraryKey` selection after multi-library prompt advances directly to Phase 2 (no infinite loop)
- Session state tracks pending community check across calls (`pendingCommunityCheck`, `discoveryFileKey`, `discoveredLibraries`, `discoveryResults`)

### 2.0.0-alpha.2 (2026-05-08)

#### Binding feedback system
- Every plugin create/edit handler now returns `{ applied, warnings, bindingFailures }` — the LLM sees exactly what DS bindings succeeded and which failed
- MCP tools surface `_bindingWarning` with specific failed binding names when plugin reports failures
- Session-level `bindingFailures[]` accumulates every failure for the build report
- Build report includes "Binding Failures" section with most-common failure patterns and recovery suggestions
- Batch handler propagates binding feedback from sub-handlers

#### Consolidated discovery
- `mimic_discover_ds` now performs all discovery in one call: variables → styles → components → preload → enforcement → Phase 2
- Returns `completenessWarnings` when discovery is partial
- Replaces the 5-step manual discovery sequence

#### Component variant properties
- `insert_component` now returns `variantProperties` with available values and current value for each property
- LLM can set correct variants (Icon, Hierarchy, Size, etc.) on first try — no guessing

#### Circuit breaker improvements
- Discovery, setup, and inspect tools exempt from circuit breaker (failures don't block builds)
- Discovery failures don't increment consecutive failure counter

#### Bug fixes
- `mimic_map_components`: `knowledgeStore` not destructured in ds-setup.js
- `figma_validate_ds_compliance`: MCP sent `validate` but plugin handler was `validate_ds_compliance`
- `inferCategory` exported from ds-setup.js for consolidated discovery

### Changed
- Hint text no longer says "retry" — always says "proceed with available, flag in report"
- 8 core rules in CLAUDE.md (was 60 golden rules)
- QA uses structural validation, not screenshots
- Artboard placement: rightmost + 80px (enforced)

### Removed
- `figma_create_chart` convenience tool (replaced by native chart building)
- Anti-bypass machinery (6 mechanisms removed)
- Session state flag sprawl (7 boolean flags → 1 phase counter)
- 45 band-aid rules that compensated for implementation bugs
