# HTML to Figma — Orchestration Protocol

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

---

## Phase 2.5 — Design system inspection

**Objective:** Discover actual variable paths, naming conventions, component keys, and text style IDs before mapping.

Rules:
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
1. **Exact match** — component exists, use it directly
2. **Approximate match** — closest component with noted deviation
3. **Primitive fallback** — no component match; use DS variables for spacing, color, and type
4. **Component candidate** — pattern with no DS match; flag for future addition

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

Spacing fidelity rule:
- Spacing decisions must preserve the relational layout of the HTML, not just map to the nearest token
- Derive spacing from HTML relationships: parent/child nesting, sibling groupings, and repetition patterns
- Evaluate: parent padding, child spacing, sibling gaps, outer margins, and whether inserted components introduce hidden internal spacing
- Prefer consistency across similar elements over exact pixel matching — choose the closest consistent spacing scale across a section; avoid mixing multiple spacing scales unnecessarily
- If DS spacing tokens do not match exactly, pick the closest token that keeps the section internally consistent
- If a DS component is inserted, reconcile its surrounding frame spacing against the HTML source
- Do not accept a correctly resolved component with incorrect surrounding spacing as a successful result

Out-of-DS color fallback:
- If no suitable DS color token exists, do not silently hardcode the source color as a normal resolved token
- Mark the color as an unresolved DS gap
- If the element is required for structural or informational fidelity, a local temporary value may be used only as a documented exception
- Any such exception must be explicitly listed in the report under Design system gaps and unresolved style exceptions
- Never treat unresolved raw values as if they were valid DS token mappings

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

**Objective:** Ensure DS components can actually be inserted during Phase 4.

Rules:
- Verify that required design system libraries are enabled in the target Figma file
- If DS components are not accessible:
  - do not attempt repeated insert failures
  - fall back to primitive construction immediately
  - record this as a DS environment limitation in the report

---

## Phase 4 — Figma construction

**Objective:** Build the Figma structure cleanly using the bridge tools.

Rules:
- Every container is an auto layout frame — use `figma_create_frame` with `layoutMode: HORIZONTAL` or `VERTICAL`
- Insert real library components via `figma_insert_component` when Phase 3 resolved to exact or approximate
  - Use the `componentKey` hash from the Phase 2.5 DS search as the primary insertion mechanism
  - Insertion path: `search_design_system` → `componentKey` → `figma_insert_component` → `importComponentByKeyAsync`
  - Pass `componentKey` directly — do not require `nodeId` when `componentKey` is already known
  - `componentKey` is the library-global identifier; `nodeId` is file-local and requires REST resolution (unreliable without a token)
- Apply DS variables via `figma_apply_variable` — never pass raw hex or pixel values as hardcoded strings
- Mirror the source hierarchy — nesting in Figma matches nesting in HTML

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

Post insertion fit rule:
- After inserting any large structural component, verify that it fits within the intended parent frame and artboard
- Check for clipping, unintended cropping, or size mismatch between the component and its slot
- If a component is larger or smaller than the intended slot:
  - first attempt to adjust the surrounding layout to accommodate the component — do not discard a correct DS component due to minor size or spacing differences
  - only fall back to a structurally correct primitive reconstruction if the component breaks screen structure or meaning and layout adjustment cannot resolve it
- Do not count a component insertion as successful if the inserted component is visually clipped or structurally misfit
- Large structural components that require this check: sidenavs, page headers, tables, paginations, large cards or panels

Post-build reconciliation rule:
- After all elements are constructed, perform a single reconciliation pass across the full layout
- Adjust: spacing between components, padding inside containers, alignment across sections
- Goal: the final Figma layout must visually match the HTML structure as closely as the DS allows
- This pass must not: change component choices, alter content, or break hierarchy

When no suitable component exists:
- construct a local editable structure inside the generated Figma file
- use only primitives, auto layout, and real design system variables
- ensure the structure is clean and reusable
- treat this as a component candidate, not a design system component
- surface it in the report under component candidates

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
| Variables | `figma_get_text_info` | No hardcoded hex, font size, or spacing value in any node |
| Consistency | — | Identical source elements resolved identically |

For text node compliance: call `figma_get_text_info` on a representative sample of created text nodes. Any node missing `textStyleId` or `fillVariable` is a construction failure — fix before moving to Phase 6.

---

## Phase 6 — Report

Output as HTML file (not terminal text). Include:

**0. Phase status**
- Clearly state which phases completed, which were partial, and which were blocked
- If Phase 4 is blocked, distinguish protocol success in earlier phases from bridge execution failure
- Missing runtime-rendered content must be called out separately from parse failures

**1. Summary**
- Nodes processed
- Exact matches / approximate matches / primitive fallbacks / component candidates

**2. Key decisions**
- Variable mappings (what DS token was chosen and why)
- Conflicts resolved (where source style had no clean DS match)

**3. Component candidates**
- Repeated patterns with no DS match — describe the pattern and its frequency

**4. Design system gaps**
- Values or patterns in the source that had no token or component equivalent

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

**6. Forward insights**
- Possible reusable templates detected
- Patterns that appear across multiple screens (defer to v2)

---

## Phase 7 — Design system knowledge capture

**Objective:** Capture structured knowledge to improve future runs against the same design system.

Detect and record:
- Repeated component usage patterns
- Consistent layout structures
- Variable combinations that recur
- Decisions made consistently across nodes

Only save if:
- Pattern appears more than once
- Confidence is high
- Does not contradict any base rule

Format:
```json
{
  "type": "pattern | component_usage",
  "definition": "...",
  "context": "...",
  "confidence": 0.0
}
```

Rules:
- Do not learn from single occurrences
- Do not overwrite base rules
- Do not mix design systems
- Flag all captures for user review — do not apply automatically
- Captured knowledge must not modify behavior during the current execution
- It may only be used in future runs if explicitly loaded

Output: a "Design system knowledge" section in the Phase 6 report listing what was learned, why, and at what confidence level.

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

---

## Design system backlog (not part of v1 protocol)

Design system architecture limitations discovered during real execution. These are gaps in the DS component library itself — not in the bridge. They must not be mislabeled as bridge failures.

- **Badge cell content not exposed as editable property** — DS table cell components that visually include a badge (`Table cell/Badge`, `Table cell/Badges multiple`) do not expose the badge label as a top-level component property. `set_component_text` cannot inject status or category values when the text is nested inside an internal instance without an exposed property. Until the DS exposes a `label` property at the top level, these cells cannot be automatically populated with dynamic content. Workaround: manual edit post-build, or primitive replacement if content fidelity is required.
- **Component property discoverability** ✓ resolved — use `figma_get_node_props` to inspect which named properties a component instance exposes; returns `componentProperties` and all nested `textLayers`.
