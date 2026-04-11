# HTML to Figma — Orchestration Protocol

How Claude should convert an HTML file into a Figma design using a real design system.

---

## Global principles (non-negotiable)

- Exact content always — no paraphrasing, no omissions
- Structure preserved — hierarchy mirrors the source
- Auto layout on every frame — no absolute positioning unless unavoidable
- Real design system variables always — never hardcode values
- Autonomous execution — do not ask the user for decisions already resolvable from the source or DS
- Auditable decisions — every mapping choice must be traceable
- Systemic consistency — identical elements resolve identically
- Deterministic by default — same input produces same output

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

## Phase 4 — Figma construction

**Objective:** Build the Figma structure cleanly using the bridge tools.

Rules:
- Every container is an auto layout frame — use `figma_create_frame` with `layoutMode: HORIZONTAL` or `VERTICAL`
- Insert real library components via `figma_insert_component` when Phase 3 resolved to exact or approximate
- Apply DS variables via `figma_apply_variable` — never pass raw hex or pixel values as hardcoded strings
- Mirror the source hierarchy — nesting in Figma matches nesting in HTML
- Name nodes clearly: `section/metrics`, `row/header`, `card/item-1`, etc.

Never:
- Use absolute positioning as a substitute for missing layout reasoning
- Hardcode colors, font sizes, or spacing values
- Create components — use existing library components only
- Flatten structure for visual convenience

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

**5. Forward insights**
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
- Use `figma_create_chart` if the chart type is supported
- If not supported: build from primitives, editable and not rasterized
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
