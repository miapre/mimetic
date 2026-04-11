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

**Objective:** Discover actual variable paths and naming conventions before mapping.

Rules:
- Inspect available design system variables before resolution
- Do not assume naming formats
- Use discovered variable paths in Phase 3 mappings
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
- Apply DS variables via `figma_apply_variable` — never pass raw hex or pixel values as hardcoded strings
- Mirror the source hierarchy — nesting in Figma matches nesting in HTML

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

When no suitable component exists:
- construct a local editable structure inside the generated Figma file
- use only primitives, auto layout, and real design system variables
- ensure the structure is clean and reusable
- treat this as a component candidate, not a design system component
- surface it in the report under component candidates

---

## Phase 5 — Internal validation

Run before producing any output. Fix failures before continuing.

| Check | Pass condition |
|---|---|
| Content | Every text node in the HTML exists in Figma with exact wording |
| Structure | Figma hierarchy matches HTML hierarchy |
| Auto layout | No frame uses absolute positioning where a stack was intended |
| Variables | No hardcoded hex, font size, or spacing value in any node |
| Consistency | Identical source elements resolved identically |

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

Bridge capability gaps discovered during real execution. These are future enhancements. They must not be treated as mandatory for protocol correctness unless a specific execution requires them.

- **SVG vector path support** — no primitive for arbitrary bezier curves, SVG path elements, or arrowhead markers; required for graph edges and flow diagrams
- **CSS grid support** — bridge only supports HORIZONTAL/VERTICAL auto-layout; fixed-width multi-column grid layouts (e.g., gantt ruler rows, event rows) cannot be represented
- **Form element support** — no primitive for `<input>`, `<select>`, `<checkbox>`; these must be approximated as text + frame constructs
- **Mixed absolute/flex layout support** — no mechanism for placing absolutely positioned children inside an auto-layout parent; required for canvas-type panels where nodes have spatial coordinates
- **Batched node creation** — each call is a round trip; large tables or waterfall rows with 50+ items are impractical without a batch create operation
