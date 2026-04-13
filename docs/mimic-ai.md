# Mimic AI — Orchestration Protocol

How Claude should convert an HTML file into a Figma design using a real design system.

---

## Global principles (non-negotiable)

- Exact content always — no paraphrasing, no omissions
- Structure preserved — hierarchy mirrors the source
- Auto layout on every frame by default — no absolute positioning unless structurally required
- Spatial, canvas, graph, gantt, timeline, and other coordinate-based layouts are explicit exceptions when absolute positioning is part of the layout semantics
- Real design system variables always — never hardcode values
- Autonomous execution — do not ask the user for decisions already resolvable from the source or DS
- Auditable decisions — every mapping choice must be traceable
- Systemic consistency — identical elements resolve identically
- Deterministic by default — same input produces same output
- Never break structural layout to improve visual fidelity

---

## Priority order

1. Content
2. Structure
3. Design system
4. Components
5. Visual fidelity

When there is a conflict between two priorities, the higher one wins. Visual accuracy is always last.

---

## Pattern key taxonomy (canonical vocabulary — mandatory)

Every pattern resolved in Phase 3 and recorded in Phase 7 must use a key from this list. Do not invent new keys. If a pattern fits no key exactly, use the closest category prefix and add a qualifier (e.g. `card/pricing`). Before writing any new key in Phase 7, check the existing keys loaded in Phase -1 — if a similar key already exists, use it instead.

**Navigation**
- `nav/top-bar` — horizontal top navigation bar spanning full width
- `nav/sidebar` — vertical sidebar with stacked links
- `nav/tab` — tab strip (horizontal tab row)
- `nav/breadcrumb` — breadcrumb trail
- `nav/pagination` — page navigation controls
- `nav/stepper` — step / wizard progress indicator

**Metrics & data display**
- `metric/kpi` — KPI card (value, label, optional trend or delta)
- `metric/stat` — single statistic, no card shell
- `metric/progress` — progress bar, ring, or gauge

**Cards**
- `card/content` — general content card
- `card/feature` — feature highlight card
- `card/profile` — user or entity profile card
- `card/action` — card with a primary CTA
- `card/summary` — summary or overview card

**Tables**
- `table/header` — column header row
- `table/row` — data row
- `table/cell` — individual data cell
- `table/footer` — totals or summary row

**Forms & inputs**
- `form/input-text` — text input field
- `form/input-select` — dropdown select
- `form/input-checkbox` — checkbox
- `form/input-radio` — radio button
- `form/input-toggle` — toggle switch
- `form/input-search` — search field with icon
- `form/button-primary` — primary action button
- `form/button-secondary` — secondary action button
- `form/button-ghost` — ghost / text button

**Labels & status**
- `label/badge` — status badge or count badge
- `label/chip` — interactive or decorative chip (filter, category)
- `label/tag` — categorization tag applied to cards or rows
- `label/status-dot` — colored dot indicating status inline

**Feedback & alerts**
- `alert/info` — informational alert or banner
- `alert/success` — success alert
- `alert/warning` — warning alert
- `alert/error` — error alert
- `feedback/toast` — toast notification
- `feedback/empty-state` — empty state (no data)
- `feedback/loader` — loading indicator or skeleton

**Charts**
- `chart/bar` — bar or column chart
- `chart/line` — line chart
- `chart/donut` — donut or pie chart
- `chart/radar` — radar / spider chart
- `chart/scatter` — scatter plot

**Layout**
- `layout/page-header` — page-level header section (title, actions)
- `layout/section-header` — section heading with optional subtitle
- `layout/footer` — page footer
- `layout/hero` — hero or banner section
- `layout/sidebar-panel` — side panel or drawer

**Overlays & menus**
- `overlay/modal` — modal dialog
- `overlay/tooltip` — tooltip
- `overlay/dropdown-menu` — dropdown menu

**Media & misc**
- `media/avatar` — user or entity avatar
- `media/icon` — standalone icon
- `list/item` — list item (non-table)
- `divider/horizontal` — horizontal rule or visual separator

---

## Phase -1 — Knowledge load (mandatory, always first)

**Objective:** Load accumulated DS knowledge before any parsing or DS inspection begins.

Call `mimic_ai_knowledge_read` with no arguments. Record the full result in working memory — both `patterns` and `explicit_rules`.

**How to use the returned patterns:**

| Entry state | Action in Phase 3 | Reads consumed |
|---|---|---|
| `VERIFIED` (use_count ≥ 3, correction_count = 0) | Use the stored component_key directly. Skip DS lookup. No search, no confirmation call. | **0 reads** |
| `CANDIDATE` (use_count 1–2) | Use the stored component_key directly. Do NOT run a confirming DS search. Only re-search if a prior run recorded an import error for this exact key. | **0 reads** |
| `REJECTED` | Never use this mapping. Fall back to DS inspection or primitive. | 1 read (new search) |
| `EXPIRED` | Treat as new pattern. Run 1 targeted DS search. | 1 read |

**VERIFIED and CANDIDATE entries cost zero reads.** A build where all patterns are VERIFIED or CANDIDATE requires no DS searches and no `get_variable_defs` call (if the variable cache is also warm). This is the target state after 3 runs.

**Alias loading:** Each pattern entry may include an `aliases` array — the exact HTML labels (class names, text content, data attributes) that previously triggered this mapping. Load all aliases into working memory alongside the pattern entries. They are used in Phase 3 step 0.5 for deterministic matching before LLM classification runs.

**Variable cache restoration (check before Phase 2.5):** After loading patterns, scan for a convention rule matching `file/{fileKey}/variable-cache`. If found, parse its `notes` field and restore the V dict and TS dict into working memory. This eliminates the `get_variable_defs` read from the Phase 0.7 budget — mark slot 1 as consumed-but-skipped.

**How to use the returned explicit_rules:**

Explicit rules encode what Mimic AI has learned about your DS beyond component mappings: what patterns have no component, what substitutions to use instead, and DS usage conventions.

| Rule type | Action in Phase 3 |
|---|---|
| `gap` (seen_count < 3) | DS has no component for this pattern. Run DS search anyway — the DS may have been updated. |
| `gap` (seen_count ≥ 3) | DS reliably has no component for this pattern. Skip DS search. Fall back to primitive or substitution_key immediately. |
| `substitution` | DS has no direct match — use `substitution_key` as the component. No DS search needed. |
| `convention` | Apply the recorded DS usage rule during Phase 3 resolution. |

**Key deduplication rule:** Before writing any pattern_key in Phase 7, check the patterns loaded here. If a key already exists that covers the same pattern (same taxonomy category, same semantic role), use the existing key. Do not create a synonym.

**DS update signal:** If the user says they updated their design system (added or changed components), add `reset_gap_seen_counts: true` to the Phase 7 write call. This resets seen_count=0 on all `gap` AND `substitution` rules. The reset takes effect on the **next run** — the current run has already loaded its Phase -1 state and proceeds normally.

**Important:** `reset_gap_seen_counts` resets seen_count on substitution rules, but Phase 3 step 0 applies substitution rules based on `type=substitution AND state=active` — there is no seen_count threshold for substitutions. **To actually unlock DS search for a substitution rule, you must explicitly write `state: "resolved"` on it.** For any pattern the user says was added to the DS and currently has a substitution rule, write:
```json
{ "rule_key": "label/chip", "state": "resolved" }
```
This causes Phase 3 step 0 to hit the resolved branch and run a full DS search on the next run, discovering the new component. `reset_gap_seen_counts` alone is not sufficient for substitution rules.

**If the knowledge file is empty or does not exist:** proceed normally. The file will be created at Phase 7.

**Never:** modify knowledge during Phase -1. This phase is read-only.

---

## Phase 0 — Research (optional, non-blocking)

Run only when unfamiliar with a pattern or tool. Never block execution on it.

Analyze tools such as html.to.design, Builder.io HTML-to-Figma, Codia, Figma Make, or similar. Extract:
- Parsing strategies
- Layout reconstruction approaches
- Style handling
- What they do well and where they fail
- Opportunities for improvement

Do not copy implementations. Use findings to inform decisions in later phases.

---

## Phase 0.5 — DOM rendering (optional, non-blocking)

**Objective:** Capture the fully rendered DOM state before static parsing when the HTML is JavaScript-rendered.

**When to activate:**
- HTML contains `<script>` tags, React/Vue/Svelte output, dynamic class names, or references external JS bundles
- Phase 1 static parse returns runtime-rendered content warnings for significant sections
- A headless browser environment (Playwright or Puppeteer) is available

**When to skip:**
- HTML is fully static (no JS, no framework)
- Playwright is not installed — do not block execution on its absence

**Procedure:**
1. Load the HTML file in a headless browser (Playwright preferred)
2. Wait for `networkidle` or `DOMContentLoaded` — do not proceed on a bare load event
3. Capture for each visible node:
   - Computed styles via `getComputedStyle` — resolved values, not raw CSS
   - Bounding box via `getBoundingClientRect`
   - Final text content (post-JS)
   - Actual class names (post-JS, not source attributes)
4. Serialize to JSON and pass to Phase 1 as the primary input

**Rules:**
- If Playwright is unavailable, skip silently — Phase 1 runs on static HTML as normal
- Do not invent content for nodes not present in the rendered output
- Record in the Phase 6 report whether rendered DOM or static HTML was used as the Phase 1 input
- If the rendered capture fails partway through, fall back to static HTML for the affected sections — do not abort

---

## Phase 0.7 — Execution mode and read budget (declare before any read)

**Objective:** Declare execution mode and enforce the read budget before any Figma API call. No Figma read tool (`get_design_context`, `get_variable_defs`, `search_design_system`, `get_screenshot`, `get_metadata`) may be called before this phase completes.

### Two execution modes

**Instant mode (default — always use on first run)**

Use when: Phase -1 knowledge file is empty, first run on this screen, or VERIFIED coverage is partial.

- No full DS ingestion
- Minimum reads only — what is strictly required to build, nothing more
- Warm-start shortcut: if Phase -1 returned VERIFIED entries covering every pattern in the screen AND the variable cache is populated, the read budget may reach zero — no DS searches, no variable reads required

**Learning mode (activate on subsequent runs, explicitly)**

Use when: Phase -1 VERIFIED coverage is complete, prior runs have populated the V and TS dicts, and the user explicitly wants expanded DS knowledge.

- Additional DS searches permitted after the build is complete
- `max_reads_soft_ceiling = 20` applies — still subject to a cap

---

### Read budget (Instant mode — hard enforced)

```
max_reads_first_run       = 5
max_screenshots_per_build = 1   (applies in all modes)
```

| Slot | Tool | Purpose | Skip condition |
|---|---|---|---|
| 1 | `get_variable_defs` | Collect V dict | Skip if V dict restored from Phase 7 variable cache |
| 2 | `search_design_system` | Targeted query for 1 new, unverified pattern | Skip if all patterns are VERIFIED in Phase -1 |
| 3 | `get_screenshot` | Final verification — build complete | Optional; skip if post-chunk sweeps confirmed compliance |
| 4–5 | Any | Contingency — unclassifiable error only | Use only if error classification table (below) gives no match |

---

### Disallowed reads (protocol violations — not guidelines)

The following are forbidden in Instant mode. Any violation must be documented in the Phase 6 report:

- Full DS scans: `search_design_system` with no specific pattern query, or a generic term (e.g., "component", "all")
- Repeated DS searches for the same pattern within a single run
- Read-based retry loops: issuing another read tool call after a failed read of the same type
- More than 1 screenshot per build
- Calling `get_variable_defs` when V dict is already populated from Phase 7 cache

---

### Single-pass read strategy (enforced globally)

All reads must complete **before** the first `use_figma` construction call. The session structure must be:

```
[Read phase] → [Build phase] → [Optional single final screenshot]
```

Interleaving reads and writes is a protocol violation:

```
read → write → read → write  ← FORBIDDEN
```

The read phase ends the moment the first `use_figma` call executes. After that point, no `get_design_context`, `search_design_system`, `get_variable_defs`, or `get_metadata` calls are permitted until all construction is complete.

**Single exception:** if a `use_figma` call returns an error whose cause cannot be determined from the error message alone, 1 targeted read may be issued from the contingency slots (4–5). Document it in Phase 6.

---

### Error classification — resolve without reads

Before issuing a contingency read on any `use_figma` error, check this table first:

| Error message contains | Root cause | Fix — no read required |
|---|---|---|
| `figma.pages` | Wrong API | Replace with `figma.root.children` |
| `clientStorage` | Unsupported API in plugin context | Remove the call entirely |
| `Cannot set properties of undefined` | Node not found before operation | Add null guard before the operation |
| `getVariableById` returns `null` | Variable ID missing from V dict | Add missing ID to V dict (known value; re-collect from cache) |
| `appendChild` into instance / `Expected instance` | Instance mutation attempted | Replace `appendChild` with `swapComponent` |
| `Cannot read properties of null` (after `findOne`) | Target node absent in this variant | Add null check; node may not exist in this component state |
| `Font is not available` | Font not loaded before characters write | Add `await figma.loadFontAsync(...)` before the characters assignment |

Only issue a contingency read if the error message matches none of the above.

---

## Phase 0.8 — Build target declaration (mandatory — ask before anything else)

**Objective:** Confirm exactly where in Figma the build will go before any parsing, DS inspection, or construction begins. If this information is not in the user's request, ask for it now. Do not proceed until it is confirmed.

**What to ask:**

> "Before I start — where in Figma should I build this?
> You can share a Figma link (to the file, a specific page, or a frame), or just tell me the file name and page. If you want me to place it next to existing content, point me to the artboard or frame."

**What the user can provide (all are valid):**
- A Figma URL to the file: `https://www.figma.com/design/abc123/...`
- A Figma URL to a specific page or frame (includes `node-id`)
- Plain language: "my main product file, the Screens page, next to the Login artboard"
- A file key directly: `abc123xyz`

**What to extract from the response:**
- `file_key` — the Figma file to build in
- `page` — which page (by name or ID)
- `placement` — where on the page: next to a named frame, specific coordinates, or new artboard at default position

**Rules:**
- If the user's original request already includes a Figma URL or clear file/page reference, skip the question — extract the target and proceed
- If any of the three values cannot be determined, ask before proceeding — do not assume
- If the user provides only a file URL (no page), ask which page
- Record the confirmed target in working memory — it is used in Phase 3.5 (bridge pre-flight) and Phase 4 (artboard placement)
- This question is asked once per run. Do not re-ask mid-build.

---

## Phase 1 — Parsing and layout

**Objective:** Build a reliable structural representation of the HTML. Do not use AI for this phase — parse deterministically.

Parse:
- Full DOM structure
- Computed styles (not just inline — resolved values)
- Node hierarchy and parent-child relationships
- Bounding boxes
- Exact text content at every node

Reconstruct layout:
- Identify horizontal and vertical stacks
- Identify grids
- Detect groupings (cards, rows, sections)
- Map parent-child relationships

Runtime-rendered content rule:
- If critical content is missing from the static DOM but is clearly produced at runtime, flag the affected region as runtime-rendered
- Do not invent missing content
- Continue parsing the available static structure
- Mark the missing runtime content explicitly in the report
- If an execution environment capable of rendering the DOM is available in the future, this may be used as an optional fallback, but it is not required for v1

Output structure:
```json
{
  "nodes": [...],
  "layout_tree": [...],
  "text_content": [...],
  "computed_styles": [...]
}
```

Section inventory (mandatory):
- After parsing, enumerate ALL top-level sections visible in the HTML — any structural block with its own heading, distinct content area, or semantic purpose (e.g. `<section>`, `<div class="section">`, `<article>`, named card groups)
- List every section by name and approximate document order
- This inventory is the authoritative checklist for Phase 4 completeness
- Do not begin Phase 4 construction until the inventory is explicitly written out
- A Phase 4 build that omits any inventoried section is a failure regardless of how many sections were successfully built

---

## Phase 2 — Semantic classification

**Objective:** Infer the intent of each node. Use AI here.

Classify each node into one of: `button`, `chip`, `tag`, `badge`, `card`, `table`, `text`, `container`, `nav`, `form`, `chart` (if applicable), or `unknown`.

Assign for each node:
```json
{
  "node_id": "...",
  "type": "...",
  "confidence": 0.0,
  "intent": "..."
}
```

Use visual features, position, repetition, and context to classify. A repeated structure with consistent styling is stronger signal than a one-off element.

Chart detection rule:
- Identify charts in the HTML via:
  - `<svg>` elements with repeated polygons, paths, or circles (radar, pie, area)
  - `<canvas>` elements with chart library initialization (Chart.js, D3, Recharts, Vega)
  - Repeated bar or column shapes of proportional width/height on a shared baseline
  - Radial structures: evenly spaced angular axes, concentric rings
  - Axis-label clusters: sequential numeric or categorical labels at regular intervals
  - Known chart library class names (`.chartjs-*`, `.recharts-*`, `.vega-*`) or script-level calls to chart render functions
- Classify chart type:
  - `radar` — radial polygon with category axes
  - `bar` — proportional rectangles on a shared baseline
  - `line` — connected data points on a shared axis
  - `pie` / `donut` — circular sector segments
  - `other` — unclassified data visualization
- If a chart is detected: mark it as a required element — it must be reconstructed in Phase 4
- Record: chart type, data source type (static SVG path data, JS runtime render function, canvas)
- A detected chart left as a placeholder without a documented blocker is a Phase 4 failure

---

## Phase 2.5 — Design system inspection

**Objective:** Discover actual variable paths, naming conventions, component keys, and text style IDs before mapping.

Rules:
- Before querying the DS, check Phase -1 knowledge for VERIFIED and CANDIDATE entries covering the patterns detected in Phase 2
- For each VERIFIED pattern: record the stored component_key — skip the DS search call entirely (0 reads)
- For each CANDIDATE pattern: use the stored component_key directly — skip the DS search call entirely (0 reads). Re-search only if a prior session recorded an `importComponentByKeyAsync` failure for this exact key.
- For new patterns (not in knowledge, or REJECTED/EXPIRED): 1 targeted DS search, maximum. If multiple new patterns need resolution, batch them into a single `search_design_system` query using the most discriminating term. If that single search resolves nothing, record all remaining new patterns as component candidates — do not issue additional searches.
- Full DS scans (no specific query term) are forbidden regardless of mode
- This tiering directly reduces DS lookup calls across runs — the savings compound as more entries reach VERIFIED state
- Inspect available design system variables before resolution
- Do not assume naming formats
- Use discovered variable paths in Phase 3 mappings
- Use `search_design_system` to discover available components and retrieve their `componentKey` hashes
- Record componentKey for every component that will be inserted in Phase 4
- Do not rely on REST lookup to resolve componentKey at runtime — it requires a token that may not be loaded
- Use `figma_list_text_styles` to discover available DS text style IDs — record the full ID (e.g. "S:abc123,7649:603") for every style that will be used in Phase 4 text node construction
- Use `figma_get_node_props` on any existing instance to inspect what component properties it exposes before attempting to set them
- If variable structure cannot be determined:
  - flag as DS ambiguity
  - proceed with best-effort mapping
  - report uncertainty

---

## Phase 3 — Design system resolution

**Objective:** Map every node to the design system without breaking structure.

Resolution order per node:
0. **Explicit rule check** — before any DS search, check explicit_rules from Phase -1. Evaluate in this exact order:
0.5. **Alias check** — after explicit rules, before any DS search or LLM classification: scan the aliases arrays loaded from Phase -1 patterns. If the node's raw HTML label (class name, element text, data-attribute, or semantic role text) exactly matches any alias, use that entry's component_key directly. Same cost as VERIFIED — 0 reads, no LLM classification, deterministic. Record the alias match in Phase 7 with `increment_use: true`. If no alias matches, proceed to step 1.
   - Alias matching is exact string match only — no fuzzy matching, no stemming
   - If multiple patterns share an alias (collision), treat as no match and proceed to step 1
   - Do not create aliases in Phase 3 — they are only recorded in Phase 7
   - **Any rule with `state: "resolved"`** (regardless of type) → treat as new pattern; run full DS search. The rule was cleared by a prior resolution or reset — check if the DS situation has changed again.
   - **`substitution` rule (state: active)** → use `substitution_key` directly. No DS search. Write `increment_seen: true` in Phase 7 to confirm it's still working.
   - **`gap` rule (state: active, seen_count ≥ 3)** → skip DS search. Use primitive or `substitution_key` if one is recorded.
   - **`gap` rule (state: active, seen_count < 3)** → run DS search anyway (DS may have been updated):
     - DS search **finds a component**: resolved. Write component mapping in `updates` AND `{ rule_key, state: "resolved" }` in `rule_updates` in Phase 7.
     - DS search **still finds nothing**: write `{ rule_key, increment_seen: true }` in Phase 7.
   - **`convention` rule** → apply the recorded rule during steps 1–2.
1. **Exact match** — component exists, use it directly
2. **Approximate match** — closest component with noted deviation
3. **Primitive fallback** — no component match; use DS variables for spacing, color, and type
4. **Component candidate** — pattern with no DS match and no explicit rule yet; flag for Phase 7 gap recording

Layout archetype rule:
- Before selecting any navigation or shell component, detect the page layout type from the HTML source:
  - `top-nav` — horizontal navigation bar spanning the full viewport width (`<nav>`, `.navbar`, fixed/sticky top bar with horizontal links)
  - `side-nav` — fixed or sticky sidebar with vertical link list (`.sidebar`, `position: fixed; left: 0`, drawer-style layout)
  - `hybrid` — both a top nav and a sidebar present simultaneously
- Layout archetype determines which DS shell component is required:
  - `top-nav` → DS header / top-navigation component
  - `side-nav` → DS sidenav component
  - `hybrid` → DS header + DS sidenav; both are required
- A horizontal nav in HTML must never resolve to a sidenav component — this is a structural mismatch, not an approximate match
- Layout archetype must be detected from the HTML source intent, not from DS component availability or convenience
- Record the detected archetype in Phase 3 output; a mismatch between detected archetype and component used is a Phase 4 failure

Semantic mapping rule:
- Before falling back to primitives, identify semantic UI patterns in the HTML:
  - **Badges / status labels**: small inline elements with a background fill and a one- to four-word label — `<span>` with colored background, `.badge`, `.tag`, `.label`, `.chip`, `.status`
  - **Chips**: interactive or decorative inline elements, often in a "best for", filter, or tag row
  - **Tags**: categorization labels applied to cards, rows, or items
- For each detected semantic pattern, search the DS for a matching component before constructing primitives
- If a DS badge, chip, or tag component exists and the HTML element fits the role → use the DS component
- Primitive text is not an acceptable substitute when a DS component exists for the pattern
- Example mappings (illustrative, not exhaustive):
  - A "Private" label with colored background → DS badge
  - Category labels ("Text", "Vision") on a model or item card → DS badge or tag
  - Items in a "Best for" chip row → DS chip
- Semantic pattern detection is mandatory — omitting DS components that exist for these patterns is a construction failure, not a style preference

Style resolution rules:
- Use real DS variables whenever they exist — `figma_apply_variable` not hardcoded values
- For spacing: evaluate proximity to token, role of the spacing, layout impact, local consistency — pick the closest token
- For color: resolve to the nearest semantic color variable (e.g., `text-primary`, `bg-surface`) not to the raw hex

Primitive fallback depth rule:
- When a component cannot be used, reconstruct its internal structure using primitives
- Do not stop at a container shell if the original component contains meaningful structure
- Preserve:
  - layout
  - text
  - hierarchy
- Only simplify if the internal structure cannot be inferred

Approximate component matching rule:
- If no exact DS component exists, evaluate whether a structurally similar component can represent the HTML element correctly
- Similarity criteria: role, layout, interaction type, visual structure, optional affordances
- When a DS component matches on role and structure, prefer using it even if minor visual differences exist or optional affordances are absent
- Only fall back to primitives when the component structure cannot represent the element, or when the interaction type is fundamentally different
- Do not reject a component solely because a non-critical affordance is missing
- Example: a dropdown trigger in HTML may map to a DS dropdown trigger even if icon treatment differs

Optional affordance rule:
- Secondary affordances — icons, chevrons, decorative indicators, and similar non-core details — must not block component reuse when the component still matches the intended role and structure
- Prioritize:
  1. correct component role
  2. correct structure
  3. required content
  4. optional affordances
- If the chosen DS component supports the optional affordance, populate it
- If it does not support it, keep the component and report the missing affordance
- Only add an adjacent primitive affordance if it can be done cleanly without compromising layout or component semantics

Spacing and radius variable rule (non-negotiable, same level as color):
- Every padding, gap (itemSpacing), and corner radius value must be bound to a DS spacing or radius variable — never a raw pixel number
- Use `node.setBoundVariable('paddingTop', var)` / `'paddingBottom'` / `'paddingLeft'` / `'paddingRight'` / `'itemSpacing'` / `'cornerRadius'` — the same mechanism as color and text style binding
- Spacing variables live in the semantic collection (e.g. `spacing-lg`, `spacing-2xl`) — never use raw Spacing/N primitives; those are internal aliases not exported by the library
- Radius variables follow the same pattern (`radius-sm`, `radius-xl`, etc.)
- A frame with raw padding or raw cornerRadius is a construction failure — same as a text node with a raw hex color

Spacing nearest-match rule:
- When the HTML value has no exact DS token, pick the closest token by pixel distance
- If two tokens are equidistant, prefer the one that produces consistent spacing across sibling elements — avoid mixing two different scales in the same section
- Record the deviation in the Phase 6 report under Design system gaps
- The goal is layout fidelity within the DS scale — preserve the visual rhythm, not the exact pixel value
- Spacing decisions must preserve the relational layout of the HTML: derive from parent/child nesting, sibling groupings, and repetition patterns
- Prefer consistency across similar elements over exact pixel matching — choose the closest consistent spacing scale across a section; avoid mixing multiple spacing scales unnecessarily
- If a DS component is inserted, reconcile its surrounding frame spacing against the HTML source
- Do not accept a correctly resolved component with incorrect surrounding spacing as a successful result

Out-of-DS color fallback:
- If no suitable DS color token exists, do not silently hardcode the source color as a normal resolved token
- Mark the color as an unresolved DS gap
- If the element is required for structural or informational fidelity, a local temporary value may be used only as a documented exception
- Any such exception must be explicitly listed in the report under Design system gaps and unresolved style exceptions
- Never treat unresolved raw values as if they were valid DS token mappings

Color fidelity rule:
- Visual elements that carry semantic meaning through color — status dots, category indicators, accent marks, trendlines, brand accents — must resolve to DS color variables that match the HTML intent
- Matching criteria: hue proximity, semantic role (success / warning / error / brand / neutral), and usage context within the screen
- Do not select an arbitrary nearby token — evaluate the element's role and choose the token whose semantic role matches that role
- If no semantically correct DS token exists:
  - select the closest available token and document the deviation
  - record as a DS color gap in the Phase 6 report
- Raw hex is never acceptable for these elements; if the DS has no adequate token, follow the out-of-DS color fallback rule above

Output per node:
```json
{
  "node_id": "...",
  "resolution": "exact | approximate | primitive | candidate",
  "component": "...",
  "variables": {
    "fill": "...",
    "spacing": "...",
    "typography": "..."
  }
}
```

---

## Phase 3.5 — Bridge pre-flight

**Objective:** Verify that the Figma bridge is available before any construction attempt.

Rules:
- Check that the local bridge is reachable and responsive before starting Phase 4
- If the bridge is unavailable:
  - do not attempt Figma construction
  - mark Phase 4 as blocked
  - continue with all non-bridge phases where possible
  - record the failure in the report
- Do not treat bridge unavailability as a parsing or DS resolution failure

---

## Phase 3.6 — Design system availability check

**Objective:** Confirm that at least one DS component library is accessible in the target Figma file before construction begins. This is a hard blocker — do not proceed to Phase 4 without confirmation.

**Procedure:**
1. Run a minimal `search_design_system` query (e.g., "button") against the target file
2. If results are returned → library is accessible. Proceed to Phase 3.7.
3. If 0 results are returned → stop. Surface the following message to the user:

> "I can't find any design system components in this Figma file. This usually means no component library is enabled here.
>
> To fix it:
> 1. Open your Figma file
> 2. Click the **Assets panel** (book icon in the left sidebar)
> 3. Click the **Team library** icon at the top
> 4. Find your design system and toggle it **on**
>
> Once that's done, let me know and I'll continue the build."

**Rules:**
- Do not attempt Phase 4 construction until this check passes
- Do not fall back silently to primitives — that produces a build without DS compliance and gives the user no signal that something is wrong
- If the user confirms the library is enabled and the search still returns 0 results, check whether the target file key from Phase 0.8 is correct
- Record the check result in the Phase 6 report

---

## Phase 3.7 — Execution mode detection and mandatory boilerplate

**Objective:** When construction uses raw JavaScript via `use_figma` rather than the `figma_*` bridge abstraction tools, emit a canonical DS helper block before writing any construction code. This is not optional.

**Detection:** If the bridge executes arbitrary JavaScript (i.e. the script contains `figma.createText()`, `figma.createFrame()`, or similar Plugin API calls directly), the raw-JavaScript execution path is active. The `figma_*` abstraction tools are not present and their DS compliance guarantees do not apply.

**When raw-JavaScript execution is detected — mandatory pre-script block:**

Every `use_figma` call, without exception, must open with the following canonical boilerplate before any construction code:

```javascript
// ── MIMIC DS BOILERPLATE — required at top of every use_figma call ──────────
const getVar = id => figma.variables.getVariableById(id);
const bindFill = (node, id) => {
  const v = getVar(id);
  if (!v) throw new Error(`DS var not found: ${id}`);
  node.fills = [{type:'SOLID', color:{r:0,g:0,b:0}}];
  node.setBoundVariableForPaint(0, 'color', v);
};
const bindStroke = (node, id) => {
  const v = getVar(id);
  if (!v) throw new Error(`DS var not found: ${id}`);
  node.strokes = [{type:'SOLID', color:{r:0,g:0,b:0}}];
  node.setBoundVariableForPaint(0, 'color', v, 'strokes');
};
const applyStyle = async (node, key) => {
  const s = await figma.importStyleByKeyAsync(key);
  node.textStyleId = s.id;
};
const txt = async (chars, tsKey, varId, x, y, parent) => {
  await figma.loadFontAsync({family:'Inter', style:'Regular'}).catch(()=>{});
  const t = figma.createText();
  t.characters = chars;
  if (tsKey) await applyStyle(t, tsKey);  // textStyleId — NEVER skip
  if (varId) bindFill(t, varId);          // DS color variable — NEVER skip
  t.x = x; t.y = y;
  if (parent) parent.appendChild(t);
  return t;
};
const dsBadge = async (compKey, label, x, y, parent) => {
  const c = await figma.importComponentByKeyAsync(compKey);
  const inst = c.createInstance();
  inst.x = x; inst.y = y;
  const tn = inst.findOne(n => n.type === 'TEXT');
  if (tn) { await figma.loadFontAsync(tn.fontName).catch(()=>{}); tn.characters = label; }
  if (parent) parent.appendChild(inst);
  return inst;
};
const dsIcon = async (iconKey, x, y, parent) => {
  const c = await figma.importComponentByKeyAsync(iconKey);
  const inst = c.createInstance();
  inst.x = x; inst.y = y;
  if (parent) parent.appendChild(inst);
  return inst;
};
// ── End boilerplate ──────────────────────────────────────────────────────────
```

**Enforcement rules (non-negotiable):**
- No `figma.createText()` call may appear outside the `txt()` helper
- No fill may be set as `node.fills = [{color:{r,g,b}}]` outside `bindFill()` or `bindStroke()`
- `node.fontSize`, `node.fontName`, `node.fontWeight`, `node.lineHeight` must never be set directly on a text node
- Hardcoded `{r,g,b}` color objects in fills or strokes are forbidden without exception
- DS component instances (badges, buttons, icons) must be created via `dsBadge()` / `dsIcon()` or an equivalent helper that uses `importComponentByKeyAsync` — never via `figma.createFrame()` styled to look like a component

**Icon-inside-button pattern (swapComponent — not appendChild):**

Figma instances are sealed containers. `appendChild` into an instance throws. For DS buttons that contain an icon placeholder, use `swapComponent`:

```javascript
const iconBtn = async (btnKey, iconKey, x, y, parent) => {
  const btnC = await figma.importComponentByKeyAsync(btnKey);
  const btn = btnC.createInstance();
  btn.x = x; btn.y = y;
  const ph = btn.findOne(n => n.type === 'INSTANCE');
  if (ph) {
    const icoC = await figma.importComponentByKeyAsync(iconKey);
    ph.swapComponent(icoC);
  }
  if (parent) parent.appendChild(btn);
  return btn;
};
```

**Variable and text style pre-load:**

Before any construction begins, pre-load all DS variable IDs and text style IDs needed for the screen into named dictionaries (`V` and `TS`). Do not look up variables inline during node construction — every lookup at construction time risks a missing-variable error that silently skips the binding.

```javascript
// Pre-loaded at Phase 3 — fill in discovered IDs
const V = {
  'bg-primary':     'VariableID:...',
  'text-primary':   'VariableID:...',
  // ... all variables needed for this screen
};
const TS = {
  'xs/Regular':   'S:...',
  'sm/Semibold':  'S:...',
  // ... all text styles needed for this screen
};
```

If a variable ID cannot be resolved during Phase 3, stop and find the correct ID before writing the build script. A build script that calls `getVar(undefined)` will silently fail to bind the variable — it is not acceptable to defer this discovery to runtime.

---

## Phase 4 — Figma construction

**Objective:** Build the Figma structure cleanly using the bridge tools.

Pre-build element inventory (mandatory — must complete before any construction call):

Before writing the first `use_figma` script, produce a written mapping of every element in the HTML to its Figma resolution. This is not a mental checklist — it must be written out explicitly in the response before any tool call. Format:

```
Element inventory — [screen name]
──────────────────────────────────────────────────────
HTML element               | Figma resolution          | Position / notes
---------------------------|---------------------------|---------------------
Page header (title)        | DS Page Header instance   | x=0, y=0; title overridden to "trc-01234567…"; badges hidden
Tags row (no label)        | DS Badge instances only    | No "Tags:" label — not in HTML
Transport button (play)    | DS Button sm/Tertiary      | Icon only — DS icon swapped in via swapComponent; text hidden
Transport button (prev)    | DS Button sm/Tertiary      | Icon only
Frame info ("Frame 1 · …") | txt() node                | RIGHT-aligned inside playback bar
Agent "entry" badge        | DS Badge instance          | Inside node card; not a custom frame
Event type (agent.input)   | DS Badge instance (Brand)  | In current event row
Event type (plain text)    | txt() node — NOT a badge   | Waterfall event rows; type is text, not a component
Container height (flow)    | 5 nodes × row-height + gaps| Calculated from content — no extra whitespace
```

Rules for the inventory:
- Every HTML element that will appear in Figma must have a row
- The "Figma resolution" column must explicitly state whether the element is: a DS component INSTANCE, a `txt()` text node, a primitive frame, or a calculated container
- Any element resolved as plain `txt()` text must not become a DS component in construction, and vice versa — the inventory is binding
- Layout positions that carry semantic meaning (right-aligned, left-aligned, nested inside a specific parent) must be noted explicitly
- Container heights for coordinate-based panels (graph, waterfall, gantt) must be calculated from their content before construction, written in the inventory, and matched exactly during construction — do not leave whitespace the HTML does not have

Proceeding to construction without a completed inventory is a Phase 4 failure.

Non-destructive build rule (non-negotiable):
- Always create a new artboard for each build. Never modify, overwrite, or delete an existing artboard.
- Position the new artboard adjacent to existing content: query `figma.currentPage.children` for the rightmost node, then place the new frame at `rightmost.x + rightmost.width + 80`.
- If a prior attempt produced a non-compliant artboard, leave it in place — the user decides what to delete. Build the corrected version as a new frame next to it.

Screenshot discipline:
- `max_screenshots_per_build = 1`
- The single allowed screenshot is the final verification screenshot — taken only after all construction and all post-chunk sweeps are complete.
- Per-chunk screenshots are forbidden.
- If construction fails mid-build, do not screenshot — document the failure in Phase 6 instead.

Rules:
- Every container is an auto layout frame — use `figma_create_frame` with `layoutMode: HORIZONTAL` or `VERTICAL`
- Insert real library components via `figma_insert_component` when Phase 3 resolved to exact or approximate
  - Use the `componentKey` hash from the Phase 2.5 DS search as the primary insertion mechanism
  - Insertion path: `search_design_system` → `componentKey` → `figma_insert_component` → `importComponentByKeyAsync`
  - Pass `componentKey` directly — do not require `nodeId` when `componentKey` is already known
  - `componentKey` is the library-global identifier; `nodeId` is file-local and requires REST resolution (unreliable without a token)
- Apply DS variables via `figma_apply_variable` — never pass raw hex or pixel values as hardcoded strings
- Mirror the source hierarchy — nesting in Figma matches nesting in HTML

Nested component rule:
- When a DS component is inserted and contains nested interactive or meaningful sub-elements, all nested elements must be fully populated — do not leave nested slots at library defaults
- Nested element resolution applies to:
  - **Buttons with icons**: if the HTML button has an icon, the DS button component's icon slot must be populated with a DS icon instance that matches the HTML icon intent — not a placeholder or omission
  - **Badges inside cards or cells**: badge label and variant/color must be set from the HTML source
  - **Navigation items with icons**: the icon node inside the nav link component must be set
  - **Any component with `icon`, `leading-icon`, `trailing-icon`, or similar slot properties**: populate if the HTML source has a corresponding icon element
- Partial component usage is not acceptable: inserting the shell of a DS component while leaving nested sub-elements at library defaults is a hydration failure
- Nested element population follows the same procedure as the Component hydration rule — check `componentProperties` first, then `findAll` traversal with no depth limit

Full build requirement (non-negotiable):
- Before starting any construction, read back the Phase 1 section inventory — not the HTML as held in working memory — and confirm the build plan includes every inventoried section
- Every section present in the HTML must exist in the Figma output — no omissions
- Partial builds are not acceptable: if only a subset of sections is constructed or major sections are missing, Phase 4 is a failure
- Do not mark Phase 4 complete until all sections from the HTML source are present in Figma
- Exception: sections that are explicitly conditional on runtime state that cannot be inferred from the static source (e.g. empty states visible only after user action) may be deferred — this must be documented in the report
- Tab content in multi-tab screens: the default active tab must be fully built; other tabs may be deferred only if explicitly noted — a multi-tab screen with only one tab built is still a partial build

Text style enforcement rule (non-negotiable):
- Typography compliance is achieved through DS text styles — pass `textStyleId` bound to a named DS text style
- Color compliance is achieved through DS color variables — pass `fillVariable` bound to a DS color variable path
- Every text node must have both applied
- Do not use: raw font properties (`fontSize`, `fontWeight`, `lineHeight`) or hardcoded color values
- Raw font properties and hardcoded text colors remain forbidden regardless of context

Text style validation rule:
- After creating or updating any text node, verify that a DS text style (`textStyleId`) is applied and a DS color variable (`fillVariable`) is applied
- If either is missing, treat the node as a construction failure — do not mark it complete
- Fix before moving to the next node

Text style fallback rule:
- If a matching DS text style cannot be found for the intended style, do not silently fall back to raw font properties
- Select the closest available DS text style instead
- Record the mismatch explicitly — it must appear in the Phase 6 report under style compliance

Auto layout sizing rule:
- When creating any auto-layout frame with explicit dimensions (especially root frames), you must set sizing mode at creation time
- Always pass `primaryAxisSizingMode="FIXED"` (and `counterAxisSizingMode="FIXED"` where needed) at frame creation — not in a follow-up call
- If primaryAxisSizingMode is not set, the frame may collapse to HUG and break layout fidelity
- For frames that should fill remaining space in their parent, pass `layoutGrow=1` inline at creation time — this eliminates a separate `set_layout_sizing` call
- Name nodes using a consistent pattern:

FILL sizing alias trap:
- `layoutSizingHorizontal` and `primaryAxisSizingMode` (on a HORIZONTAL frame) control the same axis — the last assignment wins
- Setting `layoutSizingHorizontal = 'FILL'` then `primaryAxisSizingMode = 'AUTO'` silently reverts to hug — FILL is lost with no error
- Rule: set FILL last; never write a sizing mode after `layoutSizingHorizontal = 'FILL'`
- For height hugging on a HORIZONTAL frame, use `counterAxisSizingMode = 'AUTO'` — that controls the perpendicular axis and is safe
- The same axis-alias applies symmetrically: on a VERTICAL frame, `layoutSizingVertical` and `primaryAxisSizingMode` are aliases; `layoutSizingHorizontal` and `counterAxisSizingMode` are aliases
- Symptom: SPACE_BETWEEN has no effect (container has no spare width to distribute) — first suspect is a silent FILL revert

layoutGrow safety rule:
- Never apply `layoutGrow=1` to children of a VERTICAL `primaryAxisSizingMode='AUTO'` parent — this creates a circular dependency that Figma resolves by collapsing the parent to near-zero height
- Only apply `layoutGrow=1` when the parent has a FIXED primary-axis dimension, or when horizontal fill is explicitly required inside a FIXED-height HORIZONTAL parent
- Default to `layoutGrow=0` when uncertain
- This applies to all frame and component children — not only direct children; check the full subtree if nesting multiple AUTO parents
  - section/*
  - row/*
  - card/*
  - item/*
  - label/*
  - value/*
- Avoid arbitrary or inconsistent naming

Never:
- Use absolute positioning as a substitute for missing layout reasoning
- Hardcode colors, font sizes, or spacing values
- Do not create or publish formal components to the design system library
- Flatten structure for visual convenience

Component key validation rule (lazy heartbeat):
- When inserting any VERIFIED or CANDIDATE component via `importComponentByKeyAsync`, if the call throws or returns null for a previously-known key: the component was deleted or re-keyed in the DS
- Do not retry with the same key — it is stale
- Immediately: mark that entry as EXPIRED in working memory, fall back to 1 targeted `search_design_system` query for that pattern (uses 1 contingency read from Phase 0.7 slots 4–5), and proceed with whatever the search returns
- Record the expired key in the Phase 6 report under "Stale component keys detected"
- Write `state: "EXPIRED"` for that entry in Phase 7 — the next run treats it as a new pattern
- This is the only validation mechanism for component key staleness — there is no pre-flight scan (which would consume reads before the build). Errors are caught at the point of use, not upfront.

Post insertion fit rule:
- After inserting any large structural component, verify that it fits within the intended parent frame and artboard
- Check for clipping, unintended cropping, or size mismatch between the component and its slot
- If a component is larger or smaller than the intended slot:
  - first attempt to adjust the surrounding layout to accommodate the component — do not discard a correct DS component due to minor size or spacing differences
  - only fall back to a structurally correct primitive reconstruction if the component breaks screen structure or meaning and layout adjustment cannot resolve it
- Do not count a component insertion as successful if the inserted component is visually clipped or structurally misfit
- Large structural components that require this check: sidenavs, page headers, tables, paginations, large cards or panels

Component hydration rule (non-negotiable):
- After inserting any DS component instance, all user-facing content must be populated with the correct values from the HTML source
- Default placeholder or library content must not remain in any inserted instance
- A component that is inserted but not populated is a construction failure — do not mark it complete

Content population procedure (apply in this order):
1. Check whether the component exposes named properties via `componentProperties` — if it does, use `instance.setProperties({ ... })` to set values
2. If the required text node is not exposed as a named property, locate it via `instance.findAll(n => n.type === 'TEXT')` and write `textNode.characters = correctValue` directly
3. Nested instances: if child instances themselves contain text, traverse them with `findAll` — there is no depth limit on this requirement
4. Never skip a text node because it is nested deep — all user-visible text must be correct

State handling:
- For components with states (tabs active/inactive, buttons primary/secondary, toggles on/off, badges with/without count): set the correct state that matches the HTML intent
- For tab components: the tab corresponding to the currently displayed content must be set to the active state; all other tabs must be inactive
- For button components: set the variant (primary, secondary, ghost) to match the HTML source button style
- Setting an instance to the correct state is part of hydration — inserting with the wrong state is a failure

Hydration verification:
- After populating a component, read back at least one text node to confirm the write succeeded
- If a text node's `characters` cannot be changed (locked, or read-only in the component architecture), document it as a DS architecture gap — not a pass
- Do not proceed to the next component until the current one is verified

Chart reconstruction rule (non-negotiable):
- A chart detected in Phase 2 must not be left as a placeholder in Figma
- If reconstruction is not possible, it is a Phase 4 failure — not an acceptable omission

Reconstruction procedure:
1. Extract chart data from the source:
   - Static SVG: parse polygon/path coordinates and attribute values directly from the markup
   - JS-rendered: locate and read the data array in `<script>` blocks before the render call
2. Reconstruct geometry using `figma.createNodeFromSvg()` with a precomputed SVG string for the structural layer:
   - grid rings, axis lines, data polygon, data dots
3. Add category labels as separate Figma text nodes after SVG insertion — do not embed `<text>` in the SVG; text nodes must carry DS text styles and DS color variables

Radar-specific construction:
- Grid rings: polygon per concentric ring at 25/50/75/100% of maxRadius
- Axis lines: one line per category from `(cx, cy)` to the outer ring vertex
- Data polygon: closed polygon with vertices at `(cx + r·value·cos θ, cy + r·value·sin θ)` per category
- Data dots: circle at each data vertex
- Labels: positioned at `outerRadius + labelOffset` from center along each axis angle

DS variable binding for charts:
- Grid ring stroke → DS border/separator color variable (gray scale)
- Axis line stroke → DS border/separator color variable (gray scale)
- Data polygon fill → DS brand color variable (opacity reduction applied inline on the fill if needed)
- Data polygon stroke → DS brand color variable
- Data dots fill → DS brand color variable
- Label text → DS text style + DS text color variable (e.g. `text-tertiary` or `text-secondary`)
- Exception: polygon point coordinates and line endpoints are computed geometry — raw numeric values are permitted only for SVG geometry attributes (`cx`, `cy`, `r`, `points`, `x1/y1/x2/y2`), not for color, typography, or spacing

Fallback rule:
- If chart data cannot be extracted (canvas-only with no accessible data source, obfuscated JS, unsupported chart type):
  - do NOT insert a placeholder frame silently
  - mark the chart as a Phase 4 failure
  - document the exact blocker and the required implementation path to unblock it
- A placeholder frame is only acceptable when the failure is explicitly documented in the Phase 6 report

Post-build reconciliation rule:
- After all elements are constructed, perform a single reconciliation pass across the full layout
- Adjust: spacing between components, padding inside containers, alignment across sections
- Goal: the final Figma layout must visually match the HTML structure as closely as the DS allows
- This pass must not: change component choices, alter content, or break hierarchy

Page layout consistency rule:
- Apply consistent vertical spacing across all top-level sections
- The last section on the page must have adequate bottom padding — a page that ends flush at the last content element without spacing is a layout failure
- Vertical rhythm: spacing between sections must be consistent throughout the page; do not alternate between two different gap values within the same content column
- If the HTML source specifies an explicit `padding-bottom` or `margin-bottom` on the content container, replicate it as `paddingBottom` on the Figma content frame
- Enforce at the artboard level — verify after Phase 4 construction and before Phase 5 validation

Post-chunk validation sweep (raw-JavaScript execution path only — blocking gate):

After every `use_figma` call during construction, before writing the next chunk, run the following validation script as a separate `use_figma` call. The next chunk must not start until the sweep returns `'PASS'`.

```javascript
// Post-chunk DS compliance sweep
const page = figma.root.children.find(p => p.id === TARGET_PAGE_ID);
await figma.setCurrentPageAsync(page);
const artboard = figma.currentPage.findOne(n => n.name === ARTBOARD_NAME);
const violations = [];

// ── Check 1: Text style and color variable compliance ────────────────────────
artboard.findAll(n => n.type === 'TEXT').forEach(t => {
  if (!t.textStyleId)
    violations.push({node: t.name || t.id, issue: 'missing textStyleId', text: t.characters.slice(0,60)});
  const hasBoundFill = t.fills?.some(f => f.boundVariables?.color);
  if (!hasBoundFill)
    violations.push({node: t.name || t.id, issue: 'raw fill — no DS color variable', text: t.characters.slice(0,60)});
});

// ── Check 2: Raw fill/stroke colors on containers ────────────────────────────
const FILL_TYPES = new Set(['FRAME','RECTANGLE','ELLIPSE']);
artboard.findAll(n => FILL_TYPES.has(n.type)).forEach(node => {
  (node.fills || []).forEach(f => {
    if (f.type === 'SOLID' && !f.boundVariables?.color)
      violations.push({node: node.name || node.id, issue: 'raw fill — no DS color variable'});
  });
  (node.strokes || []).forEach(s => {
    if (s.type === 'SOLID' && !s.boundVariables?.color)
      violations.push({node: node.name || node.id, issue: 'raw stroke — no DS color variable'});
  });
});

// ── Check 3: Custom frames masquerading as DS components ─────────────────────
// Any FRAME (not INSTANCE) whose name contains a component keyword is a fake component.
const COMPONENT_KEYWORDS = ['badge','btn','button','icon','chip','tag'];
artboard.findAll(n => n.type === 'FRAME').forEach(node => {
  const lname = (node.name || '').toLowerCase();
  if (COMPONENT_KEYWORDS.some(k => lname.includes(k)))
    violations.push({node: node.name || node.id, issue: 'FRAME named as DS component — must be an INSTANCE imported via importComponentByKeyAsync'});
});

// ── Check 4: DS component instances with default placeholder text ─────────────
// These strings are the most common DS library defaults across design systems.
const DS_PLACEHOLDERS = ['Title', 'Description', 'Label', 'Button text', 'Badge', 'Placeholder', 'Button label'];
artboard.findAll(n => n.type === 'INSTANCE').forEach(inst => {
  inst.findAll(n => n.type === 'TEXT').forEach(t => {
    if (DS_PLACEHOLDERS.includes(t.characters))
      violations.push({node: inst.name || inst.id, issue: `hydration failure — DS placeholder text "${t.characters}" not replaced`});
  });
});

return violations.length === 0
  ? 'PASS'
  : JSON.stringify({FAIL: violations.length, violations}, null, 2);
```

- If the sweep returns `FAIL`: fix every listed violation before proceeding. Do not suppress or ignore violations by marking them acceptable — each one is a construction failure.
- Do not skip this sweep to save bridge calls. Every skipped sweep is a violation that survives into the final file.
- This sweep is not a substitute for using the Phase 3.7 helpers — it is the enforcement backstop for anything that slips through.

When no suitable component exists:
- construct a local editable structure inside the generated Figma file
- use only primitives, auto layout, and real design system variables
- ensure the structure is clean and reusable
- treat this as a component candidate, not a design system component
- surface it in the report under component candidates

Phase 4 success criteria:
- All sections from the HTML source are present in Figma
- All frames are visible — no collapsed frames (height or width < 20px on any container that should have content)
- Content is rendered inside containers — text nodes exist and are not empty
- No major sections missing
- All inserted DS component instances are hydrated — no default DS library text remains in any instance
- Chart fidelity: every chart detected in Phase 2 is either reconstructed in Figma with visible geometry matching the HTML source, or explicitly documented as a failure with an exact blocker — a silent placeholder is never acceptable
- Layout archetype fidelity: the page shell component matches the HTML layout type — a horizontal nav resolved to a sidenav, or vice versa, is a failure regardless of visual similarity
- Semantic component fidelity: DS badge, chip, and tag components are used wherever the HTML has semantic label patterns and DS equivalents exist — primitive substitution when a DS component is available is a failure
- Nested component completeness: all nested sub-elements of inserted DS components (icons, badge labels, nav icons) are populated from the HTML source — library defaults remaining in nested slots are a failure
- Token color fidelity: visual elements carrying semantic meaning through color (status dots, category indicators, accents) are bound to semantically appropriate DS color variables — arbitrary token selection that misrepresents the HTML color intent is a failure
- **Spacing and radius compliance**: zero frames in the artboard have raw padding, gap, or cornerRadius values — every non-zero spacing/radius property is bound to a DS variable via `setBoundVariable`; any raw px value remaining is a failure

If any of the above conditions are not met, Phase 4 is FAIL — not PARTIAL. A PARTIAL result is only valid when explicitly documented deferred items (conditional runtime sections, non-default tabs) are the only missing pieces. Structural omissions or collapsed frames always constitute a failure.

---

## Phase 5 — Internal validation

Run before producing any output. Fix failures before continuing.

| Check | Tool | Pass condition |
|---|---|---|
| Content | `figma_get_node_children` | Every text node in the HTML exists in Figma with exact wording |
| Structure | `figma_get_node_parent` | Figma hierarchy matches HTML hierarchy |
| Auto layout | `figma_get_node_children` | No frame uses absolute positioning where a stack was intended |
| Text style compliance | `figma_get_text_info` | Every TEXT node has a `textStyleId` (DS text style) applied |
| Color variable compliance | `figma_get_text_info` | Every TEXT node has a `fillVariable` (DS color variable) applied |
| Spacing variable compliance | `figma_get_node_props` | Every frame with padding/gap/radius has those properties bound to DS variables via `setBoundVariable` — no raw px values |
| Variables | `figma_get_text_info` | No hardcoded hex, font size, or spacing value in any node |
| Consistency | — | Identical source elements resolved identically |
| Chart fidelity | `figma_get_node_children` | Every detected chart has vector children matching chart geometry, or is explicitly documented as a failure with a blocker |

For text node compliance: call `figma_get_text_info` on a representative sample of created text nodes. Any node missing `textStyleId` or `fillVariable` is a construction failure — fix before moving to Phase 6.

Spacing and radius compliance sweep (mandatory — run once after all construction is complete):
Run the following traversal against the root artboard frame before marking Phase 5 complete:
```javascript
// Scan all FRAME nodes; skip DS component internals (IDs starting with 'I')
artboard.findAll(n => n.type === 'FRAME' && !n.id.startsWith('I')).forEach(node => {
  ['paddingTop','paddingBottom','paddingLeft','paddingRight'].forEach(prop => {
    if (node[prop] !== 0 && !node.boundVariables?.[prop]) {
      node.setBoundVariable(prop, nearestSpacingVar(node[prop]));
    }
  });
  if (node.itemSpacing !== 0 && node.primaryAxisAlignItems !== 'SPACE_BETWEEN'
      && !node.boundVariables?.itemSpacing) {
    node.setBoundVariable('itemSpacing', nearestSpacingVar(node.itemSpacing));
  }
  ['topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius'].forEach(prop => {
    if (node.cornerRadius && node.cornerRadius !== 0 && !node.boundVariables?.[prop]) {
      node.setBoundVariable(prop, nearestRadiusVar(node.cornerRadius));
    }
  });
});
```
- `nearestSpacingVar(px)` and `nearestRadiusVar(px)` resolve to the closest DS variable from the semantic `3. Spacing` and `2. Radius` collections (see DS boilerplate memory for keys)
- This sweep catches every frame built in Phase 4 in one pass — it is not a substitute for binding at construction time, but it is the enforcement backstop
- After the sweep, re-run the scan to confirm zero remaining unbound values
- A non-zero result after the sweep is a Phase 5 failure — investigate and fix before proceeding

Visual validity check:
- After construction, query all top-level section frames and verify:
  - No frame has height < 20px unless it is semantically a divider or decorative rule
  - No frame has width < 20px unless it is semantically a narrow element (icon, bullet, indicator)
  - At least one text node exists inside each content container
- If collapsed frames are found (height or width near 0 unexpectedly):
  - diagnose the root cause before applying any fix (resize() trap, layoutGrow circular dependency, or missing content)
  - apply the fix and re-verify
  - do not proceed to Phase 6 until all containers pass the visibility check
- This check is mandatory — skipping it to save time is an anti-pattern

---

## Phase 6 — Report

Output as HTML file (not terminal text). Include:

**0. Phase status**
- Clearly state which phases completed, which were partial, and which were blocked
- If Phase 4 is blocked, distinguish protocol success in earlier phases from bridge execution failure
- Missing runtime-rendered content must be called out separately from parse failures
- Verdict constraint: if Phase 4 is FAIL, the overall report verdict must be FAIL or PARTIAL with blocking issues listed — it cannot be PASS. A run with missing sections or collapsed frames is not a successful run regardless of DS binding quality.

**1. Summary**
- Nodes processed
- Exact matches / approximate matches / primitive fallbacks / component candidates

**2. Key decisions**
- Variable mappings (what DS token was chosen and why)
- Conflicts resolved (where source style had no clean DS match)

**3. Component candidates**
- Patterns resolved as "component candidate" this run — describe the pattern and its frequency

**4. Design system gaps and recommendations**
- Values or patterns in the source that had no token or component equivalent
- For each gap resolved via an explicit substitution rule: name the substitution used and why
- **DS enhancement recommendations** (mandatory when present): any gap with seen_count ≥ 3 in the knowledge file must be called out explicitly as a recommendation to add to the DS. Format: pattern name, how many times seen across runs, what substitution is currently being used. These are the highest-signal signals Mimic AI can produce about the user's DS — never omit them.

**5. Performance insights**
- Report total bridge calls
- Highlight repeated call patterns
- Identify inefficiencies (e.g., required multi-call operations)
- Estimate scaling impact for full screens

**5a. Layout quality**
- Explicitly report:
  - spacing quality: sections with consistent spacing, sections with mismatched spacing, sections with poor layout coherence
  - cropping or clipping on any inserted component
  - fit issues after component insertion (component too large/small for its slot)
  - approximate component matches accepted despite missing optional affordances (list the missing affordance and why the match was still accepted)
- Distinguish these from bridge failures and DS architecture failures

**5c. Style compliance**
- Report the percentage of text nodes using a DS text style (`textStyleId`) and a DS color variable (`fillVariable`)
- List any nodes using raw font properties (`fontSize`, `fontWeight`, `lineHeight`) or missing a color variable — these are construction failures, not style preferences
- Note: typography compliance uses DS text styles; color compliance uses DS color variables — these are distinct mechanisms

**5b. Component editability**
- For every DS component that was inserted successfully, report whether it was also fully populated
- Distinguish: insertion success vs property population success
- If a component was inserted but required content could not be set (e.g. badge label not exposed as an editable property), report this explicitly as a DS architecture gap — not a bridge failure

**5d. Component content validation**
- Report the percentage of inserted DS components that were correctly hydrated (no default library content remaining)
- For each component that passed hydration: state how the text was set (via `setProperties()` or direct `characters` write) and confirm the read-back verified
- For each component that failed hydration or has default content leakage: name the exact instance, the text node that was not updated, and the default value that is still showing
- Verdict constraint: if any component still shows default DS library content, the overall verdict cannot be PASS — it must be PARTIAL or FAIL with the leaking component listed as a blocking issue

**5e. Chart validation**
- Chart detected: yes/no — if yes, chart type (`radar`, `bar`, `line`, `pie`, `donut`, `other`)
- Chart reconstructed: yes/no
- If reconstructed:
  - Construction method: SVG precomputed via `createNodeFromSvg`, Figma vector primitives, or hybrid
  - DS variable binding: which DS variables were applied to strokes, fills, and label text
  - Fidelity: proportions preserved / category labels preserved / data values visually accurate
- If not reconstructed:
  - Exact blocker: data not extractable, canvas-only rendering, obfuscated JS, unsupported chart type
  - Required implementation: what toolchain addition would unblock reconstruction
- Verdict constraint: a chart detected in Phase 2 that is silently replaced by a placeholder without a documented failure record is a blocking issue — the overall verdict cannot be PASS

**6. Forward insights**
- Possible reusable templates detected
- Patterns that appear across multiple screens (defer to v2)

---

## Phase 7 — Knowledge write (mandatory, always last)

**Objective:** Persist pattern→component mappings from this run so future runs benefit immediately.

Call `mimic_ai_knowledge_write` with the updates array. This is not optional — skipping Phase 7 means the run produced no learning value.

**What to write:**

This call takes two independent arrays: `updates` (pattern→component mappings) and `rule_updates` (DS gaps, substitutions, conventions). Always submit both in a single call.

---

**`updates` — pattern→component mappings**

For every pattern resolved via exact or approximate match in Phase 3:

```json
{
  "pattern_key": "metric/kpi",
  "component_key": "3iUvHvO7znmQ...",
  "component_name": "MetricCard",
  "increment_use": true,
  "add_alias": "KPI tile"
}
```

- `pattern_key`: must be a key from the Pattern Key Taxonomy — check Phase -1 loaded keys first, use an existing key if it covers this pattern
- `component_key`: the componentKey hash used in Phase 4
- `component_name`: human-readable name (for inspection)
- `increment_use`: always `true` — increments use_count toward VERIFIED promotion at 3 uses
- `add_alias`: the exact HTML label that identified this pattern this run — the raw class name, element text, or semantic role text from the source (e.g. `"KPI tile"`, `"revenue-card"`, `"metric/stat"`). The MCP appends it to the entry's `aliases` array if not already present. Omit this field only if the HTML had no recoverable label for the pattern.

**For primitive fallbacks:** do not write a `updates` entry. Primitives are not mappings.

**For stale component keys (EXPIRED during Phase 4):** write a state override in `updates`:
```json
{
  "pattern_key": "metric/kpi",
  "component_key": "3iUvHvO7znmQ...",
  "state": "EXPIRED"
}
```
Do not increment use. The EXPIRED state causes the next run to treat this as a new pattern and run a fresh DS search.

**For user corrections — two-part write (both parts are mandatory):**

Part 1 — demote the pattern:
```json
{ "pattern_key": "label/chip", "increment_correction": true }
```

Part 2 — reset the associated rule (if one exists in Phase -1 explicit_rules):
```json
{ "rule_key": "label/chip", "type": "gap", "reset_seen_count": true }
```

**Never write Part 1 without Part 2** when an associated rule exists. Omitting Part 2 means the old substitution rule survives and re-applies the wrong component on the next run, silently undoing the correction. Always scan Phase -1 explicit_rules for a matching rule_key before closing the correction write.

---

**`rule_updates` — DS gaps, substitutions, and conventions**

For every pattern that resolved to "component candidate" (step 4 in Phase 3 — no DS component found):

```json
{
  "rule_key": "label/chip",
  "type": "gap",
  "reason": "No chip component found in DS after search",
  "increment_seen": true
}
```

If you used a substitution (used a different DS component to fill the gap):

```json
{
  "rule_key": "label/chip",
  "type": "substitution",
  "substitution_key": "abc123...",
  "substitution_name": "Badge",
  "reason": "No chip in DS — Badge used as nearest semantic equivalent",
  "increment_seen": true
}
```

If a substitution rule already existed from Phase -1 and you applied it this run, still submit it with `increment_seen: true` — this confirms the substitution is still accurate and increments its recurrence count.

If a gap from Phase -1 was resolved this run (DS search found a component that wasn't there before):

```json
{
  "rule_key": "label/chip",
  "state": "resolved"
}
```

Resolved rules are excluded from future recommendations and future runs will search normally for that pattern.

For DS usage patterns you discovered this run that should be remembered:

```json
{
  "rule_key": "form/button-primary",
  "type": "convention",
  "notes": "This DS uses 'filled' variant for primary actions, never 'solid'"
}
```

Conventions do not use `increment_seen` — seen_count is not meaningful for conventions. Write them once and update `notes` if the convention changes.

Convention notes must be specific enough to apply unambiguously. Good: `"Use 'filled' variant for primary buttons — 'solid' is reserved for destructive actions"`. Bad: `"Buttons use a special variant"`. A vague convention note will be misapplied or ignored. If you cannot write a specific note, do not write the convention — wait until you have enough context to make it precise.

To permanently suppress a recommendation the user has acknowledged and decided to leave unresolved:

```json
{
  "rule_key": "label/chip",
  "dismissed": true
}
```

Dismissed gaps are excluded from all future recommendations.

---

### Variable ID cache — persist across sessions (mandatory)

After every build, write the full V dict and TS dict as a `convention` rule in `rule_updates`. This eliminates the `get_variable_defs` read on all subsequent runs for this Figma file.

```json
{
  "rule_key": "file/BoQobWgIHapsRafUJJyEZ4/variable-cache",
  "type": "convention",
  "notes": "{\"V\":{\"bg-primary\":\"VariableID:4231:12\",\"text-primary\":\"VariableID:4231:13\",\"border-secondary\":\"VariableID:4231:44\"},\"TS\":{\"xs/Regular\":\"S:abc123,7649:603\",\"sm/Semibold\":\"S:def456,7649:604\"}}"
}
```

- Replace `BoQobWgIHapsRafUJJyEZ4` with the actual Figma file key for the current build
- The `notes` field is a JSON string containing two keys: `V` (variable ID dict) and `TS` (text style ID dict)
- Include every variable ID and text style ID used in the build — not a subset
- **Phase -1 restoration:** on the next run, when Phase -1 loads this convention rule, it must parse `notes` with `JSON.parse(notes)` and restore both dicts to working memory before Phase 2.5. This eliminates slot 1 (`get_variable_defs`) from the Phase 0.7 read budget.
- Update this entry on every run — the last write is authoritative

**Promotion is automatic:** when use_count reaches 3 and correction_count is 0, the MCP promotes the entry to VERIFIED. You will see `verified` count increase in the response. On the next run, VERIFIED entries skip DS lookup entirely.

**Gap recommendations surface automatically:** the response includes a `recommendations` array listing any active, non-dismissed gaps with seen_count ≥ 3. These are the clearest signal Mimic AI can produce about what the user's DS is missing.

**Key format warnings:** if a pattern_key or rule_key doesn't match the `category/name` taxonomy format, the response includes a `key_warnings` array. **Treat these as write errors, not advisories.** The malformed key was saved — correct it immediately by re-submitting the write with the proper taxonomy key and state override to overwrite the bad entry. Do not proceed to Phase 6 with unresolved key warnings.

**Rule type change warnings:** if the response includes `rule_type_warnings`, a rule's type was changed (e.g. gap → convention). This is a permanent structural mutation. Verify it was intentional. If not, immediately re-submit a correcting rule_update to restore the original type.

**Exception — correction workflow:** when executing a user correction (Part 2 writes `type: "gap"` and `reset_seen_count: true` on a substitution rule), a `rule_type_warnings` entry is expected and correct. Do not treat it as an error in this context. The type change from `substitution` to `gap` is the intended result of the correction.

**After writing, report in the Phase 6 knowledge section:**
- Total patterns in knowledge file, how many VERIFIED / CANDIDATE
- Which entries were promoted to VERIFIED this run
- DS lookup calls saved (VERIFIED entries × calls avoided) plus rule-based skips (substitutions + high-confidence gaps)
- Active substitution rules applied this run
- Any new gap rules created this run, any gaps resolved this run
- DS enhancement recommendations (from response `recommendations` array) — **mandatory to surface, never omit**
- Any `key_warnings` from the response — **treat as errors, fix immediately, do not close the run report**
- Any `rule_type_warnings` from the response — verify intentional, correct if not

---

## Phase 8 — Learning summary (mandatory, always last, presented to the user)

**Objective:** Make the learning event visible. After Phase 7 completes, present a brief structured summary to the user. This is not a report — it is a plain-language statement of what the system learned this run.

Present the following, formatted as a short list with clear labels:

```
Mimic AI learning summary — Run [N]
────────────────────────────────────
Mode:                [Instant / Learning]
Patterns saved:      [X] new, [Y] updated
Promoted to VERIFIED:[Z] (these skip DS lookup from now on)
Alias matches:       [N] patterns resolved by alias (zero reads, zero LLM classification)
DS lookups skipped:  [N] (via VERIFIED/CANDIDATE entries and substitution rules)
DS gaps detected:    [N] pattern(s) with no matching DS component
Stale keys expired:  [N] (will re-resolve on next run)
Read budget used:    [N] of 5 reads (slots: [list which slots were consumed])
Knowledge maturity:  [early / developing / stable] — [V] of [T] patterns VERIFIED ([X]%)
```

Maturity thresholds:
- `early`: fewer than 5 total patterns, or VERIFIED < 30%
- `developing`: VERIFIED 30–79%
- `stable`: VERIFIED ≥ 80% and fewer than 2 new patterns this run

If `promoted_to_verified` is non-empty, list each promoted pattern_key by name — these are milestone events.

If `recommendations` is non-empty (gaps with seen_count ≥ 3), present each as a specific suggestion:
```
DS recommendation: Consider adding a [pattern name] component — seen [N] times with no DS match (currently substituted with [substitution_name]).
```

**Rules:**
- Always present this summary, even if nothing was learned (state "0 new patterns — all patterns were previously known")
- Use plain language — no JSON, no internal field names
- Keep it to under 15 lines
- This is the only user-facing evidence that the learning system is working — never skip it

---

## Extension — Chart translation (activate only if charts detected)

**Detection signals:** `<canvas>`, complex `<svg>`, axis labels, repeated bar/line shapes, legends, numeric tick labels.

**Classify** the chart type: `bar`, `line`, `area`, `pie`, `donut`, `stacked`.

**Extract:**
- Axes (labels, ranges, units)
- Series (name, data points, color)
- Legend entries
- Chart title and subtitle

**Construction rules:**
- Do not assume chart-specific tools exist
- If no chart-specific tool is available:
  - construct charts using primitives
  - ensure full editability
  - preserve axes, series, labels, and legends
  - never rasterize charts
- Use DS color variables for all series colors — never hardcode hex
- Preserve all text (axis labels, tick values, legend, title) as real text nodes

**Priority for charts:**
1. Chart type correctness
2. Information hierarchy (title > axis labels > data labels > legend)
3. Design system
4. Visual fidelity

---

## Performance rules

- Phases 1 and 4 are deterministic — do not use AI judgment for parsing or Figma calls
- Phase 2 (semantic classification) and Phase 3 (DS resolution) use AI judgment
- Batch Figma operations where possible — minimize round trips to the bridge
- Do not recompute layout after Phase 1 unless structure validation fails
- Limit recursion depth — stop at the granularity level where DS resolution is meaningful

---

## Anti-patterns (never do)

- Hardcode any style value
- Ask the user for decisions resolvable from the source or DS
- Break layout structure to achieve visual similarity
- Create new components in the design system
- Rely entirely on AI for structural decisions
- Produce inconsistent outputs for identical inputs
- Skip Phase 5 validation to save time
- Do not force auto layout onto layouts whose meaning depends on spatial positioning

---

## Bridge backlog (not part of v1 protocol)

Bridge capability gaps discovered during real execution. These are future enhancements to the bridge or plugin layer. They must not be treated as mandatory for protocol correctness unless a specific execution requires them.

- **SVG vector path support** — no primitive for arbitrary bezier curves, SVG path elements, or arrowhead markers; required for graph edges and flow diagrams
- **CSS grid support** — bridge only supports HORIZONTAL/VERTICAL auto-layout; fixed-width multi-column grid layouts (e.g., gantt ruler rows, event rows) cannot be represented
- **Form element support** — no primitive for `<input>`, `<select>`, `<checkbox>`; these must be approximated as text + frame constructs
- **Mixed absolute/flex layout support** — no mechanism for placing absolutely positioned children inside an auto-layout parent; required for canvas-type panels where nodes have spatial coordinates
- **Batched node creation** ✓ resolved — use `figma_batch` with an `operations` array; all operations execute in a single bridge round trip
- **Raw-JavaScript execution path** (`use_figma`) — when the bridge executes arbitrary Plugin API JavaScript instead of `figma_*` abstraction tools, the abstraction layer's DS compliance guarantees do not apply. Phase 3.7 mandatory boilerplate and the Phase 4 post-chunk validation sweep compensate for the missing guardrails. Both are required whenever this execution path is active. Audits that only test the `figma_*` abstraction path do not cover this path — test both modes independently.

---

## Design system backlog (not part of v1 protocol)

Design system architecture limitations discovered during real execution. These are gaps in the DS component library itself — not in the bridge. They must not be mislabeled as bridge failures.

- **Badge cell content not exposed as editable property** — DS table cell components that visually include a badge (`Table cell/Badge`, `Table cell/Badges multiple`) do not expose the badge label as a top-level component property. `set_component_text` cannot inject status or category values when the text is nested inside an internal instance without an exposed property. Until the DS exposes a `label` property at the top level, these cells cannot be automatically populated with dynamic content. Workaround: manual edit post-build, or primitive replacement if content fidelity is required.
- **Component property discoverability** ✓ resolved — use `figma_get_node_props` to inspect which named properties a component instance exposes; returns `componentProperties` and all nested `textLayers`.
