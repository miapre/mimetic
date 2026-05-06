# Mimic AI v2 — Design Spec

> **For agentic workers:** This is the design specification for building Mimic AI v2 from scratch. Read this before any implementation work.

**Goal:** Rebuild Mimic AI as a clean, testable, DS-first MCP tool that translates HTML into Figma using the user's design system, learns from every build, and acts as a design system copilot.

**Architecture:** Split responsibility — smart MCP server (Node.js, testable), thin Figma plugin (enforcement gate, mechanical handlers), embedded bridge (auto-starts, invisible to user). Full 45-tool surface from day one.

**Tech Stack:** Node.js (MCP server + bridge), Figma Plugin API (plugin), WebSocket (bridge↔plugin), Puppeteer (URL→HTML rendering)

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────┐
│                  MCP Client                      │
│         (Claude Code, Cursor, VS Code)           │
└─────────────────┬───────────────────────────────┘
                  │ MCP Protocol (stdio)
                  ▼
┌─────────────────────────────────────────────────┐
│              MCP Server (mcp.js)                 │
│                                                  │
│  ┌─────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │  Tools  │ │ DS Cache │ │ Knowledge Store  │  │
│  │ Registry│ │& Resolver│ │ (ds-knowledge)   │  │
│  └────┬────┘ └─────┬────┘ └────────┬─────────┘  │
│       │            │               │             │
│  ┌────▼────────────▼───────────────▼──────────┐  │
│  │         Bridge (embedded HTTP/WS)          │  │
│  │         Auto-starts on first tool call     │  │
│  └────────────────────┬───────────────────────┘  │
└───────────────────────┼─────────────────────────┘
                        │ WebSocket
                        ▼
┌─────────────────────────────────────────────────┐
│            Figma Plugin (plugin/code.js)          │
│                                                  │
│  ┌──────────────┐  ┌─────────────────────────┐  │
│  │  Handlers    │  │  DS Enforcement Gate     │  │
│  │  (thin,      │  │  (rejects raw text/color │  │
│  │   mechanical)│  │   requires DS bindings)  │  │
│  └──────────────┘  └─────────────────────────┘  │
│                                                  │
│              Figma Plugin API                    │
└─────────────────────────────────────────────────┘
```

### Key Principle

Intelligence flows down, enforcement flows up. The MCP layer resolves the right DS values. The plugin refuses anything that isn't a DS value (for text and color). Tool responses carry contextual hints so the LLM always knows what to do next.

### File Decomposition

```
mcp.js                    — Entry point, MCP protocol, tool registry
src/
  bridge.js               — Embedded HTTP/WS bridge, auto-lifecycle,
                            keepalive ping every 15s, auto-reconnect
                            with 3-attempt backoff, pending-op queue
  tools/
    status.js             — mimic_status, mimic_discover_ds
    ds-setup.js           — preload_styles, preload_variables, session_defaults,
                            list_text_styles, discover_library_styles,
                            discover_library_variables, read_variable_values
    build.js              — create_frame, create_text, create_rectangle,
                            create_ellipse, create_svg
                            (no create_chart — charts built natively)
    components.js         — insert_component, set_component_text, set_variant,
                            swap_main_component, replace_component
    edit.js               — set_text, set_node_fill, set_layout_sizing,
                            set_visibility, set_variable_mode, set_text_style,
                            move_node, delete_node, restyle_artboard
    inspect.js            — get_node_props, get_node_children, get_node_parent,
                            get_pages, change_page, get_page_nodes,
                            get_component_variants, get_text_info,
                            get_selection, select_node
    learning.js           — knowledge_read, knowledge_write,
                            generate_build_report, generate_design_md
    rendering.js          — pipeline_resolve, render_url
    compliance.js         — validate_ds_compliance
    batch.js              — figma_batch (max 6 operations per call)
  ds/
    cache.js              — DS variable/style cache, lookup, invalidation
    resolver.js           — Variable path resolution, fuzzy matching,
                            category mapping (text/bg/border/icon colors)
    discovery.js          — Library enumeration, component search,
                            REST API integration for community libraries
  knowledge/
    store.js              — Read/write ds-knowledge.json, schema validation
    patterns.js           — Pattern matching, confidence promotion,
                            three-trigger model
    gaps.js               — Gap tracking, evidence accumulation,
                            savings estimation, recommendation generation
  charts/
    calculator.js         — Chart math engine: bar scaling, donut angles,
                            SVG path generation, radar trig, scatter positioning.
                            All geometry computed in Node.js, never by the LLM.
                            Input: data + chart type + dimensions.
                            Output: exact coordinates, SVG strings, arc angles.
  utils/
    html-parser.js        — HTML analysis, view detection, CSS extraction
    figma-types.js        — CSS → Figma property mapping reference
    errors.js             — Structured error types with recovery paths

plugin/
  code.js                — Thin handlers + DS enforcement gate
  manifest.json
  ui.html
```

Each file has one responsibility. Each is independently testable (except plugin/code.js which is kept minimal).

---

## 2. What Mimic AI Is

Mimic AI is a **design system copilot**. It translates HTML into Figma using the DS present on the user's target file, and it learns from every build.

The HTML→Figma translation is the entry point. The real value is:

1. **DS learning** — every build deepens Mimic's understanding of the user's DS (component patterns, variable mappings, configuration recipes, icon library)
2. **DS recommendations** — proposing improvements (missing components, token gaps), backed by evidence from actual builds, with estimated savings in tool calls and build time
3. **DS maintenance** — detecting changes, flagging regressions, keeping builds current as the DS evolves
4. **DS readiness** — helping designers structure their DS for AI tools (Figma Make, Stitch, generative UI) as a side effect of using Mimic

Users can also describe screens ("build a dashboard") and Mimic discovers the DS on the spot and builds with it — no prior builds required. The learning loop makes subsequent builds faster and smarter (cached recipes, proven patterns, known icon mappings), but the first build works too.

---

## 3. DS Enforcement Hierarchy

Enforcement is in the Figma plugin — the last gate before anything touches the canvas. **Enforcement is graduated, not binary.** Phase 2 inventories what the DS actually provides, and the plugin adapts its enforcement per-category. A DS with text styles but no color variables enforces text styles and accepts raw colors. The first build must always produce output.

### How Graduated Enforcement Works

During Phase 2 (Style & Variable Inventory), the MCP server catalogs what the DS has:
- Text styles present? → `enforceTextStyles: true`
- Typography variables present (no text styles)? → `enforceTypographyVars: true`
- Color variables present? → `enforceColorVars: true`
- Spacing variables present? → `enforceSpacingVars: true`
- Radius variables present? → `enforceRadiusVars: true`

This enforcement profile is sent to the plugin via `set_session_defaults`. The plugin gate checks each category independently.

### Tier 1: Components (always prefer)

If the DS has a component for the element, **use it** — even if the component doesn't match the HTML's exact layout, icon configuration, or variant. A header component is a header. A button is a button. **Intent over pixel-matching.**

Missing features (like an icon slot that doesn't exist) are not blockers. Use the component, configure what you can, note the gap in the report.

### Tier 2: Text and Color (enforced when DS provides them)

**When the DS has text styles/typography variables:** every text node must use them. Plugin rejects `create_text` without DS text style.

**When the DS has color variables:** every fill and stroke must use them. Plugin rejects `create_frame` fill without DS color variable.

**When the DS lacks text styles:** accept raw text properties, flag every instance in the build report. "Your DS has no text styles. Adding them would enable consistent typography across builds."

**When the DS lacks color variables:** accept raw hex, flag every instance. "Your DS has no color variables. Adding them would enable mode switching (light/dark) and consistent theming."

The enforcement adapts to the DS. The report always shows what's missing and what it would unlock.

### Tier 3: Spacing and Radius (best-effort, always)

Bind padding, gap, and corner radius to DS variables when available. If the DS doesn't have spacing or radius tokens, accept raw values and flag in the build report as a DS gap recommendation.

### Tier 4: Auto-layout (structural requirement, always enforced)

Every frame uses auto-layout. Widths are FILL (expand to parent), heights are HUG (shrink to content). Fixed width only for the artboard (1440px).

Cards in a row: all FILL width. Table columns: at least one FILL. Content sections: FILL width, HUG height.

This is structural, not DS-dependent. Enforced regardless of what the DS provides.

### Error Format

Every plugin rejection includes a recovery path:

```json
{
  "error": "DS_REQUIRED",
  "property": "textStyle",
  "message": "Text node requires a DS text style (your DS has 24 text styles)",
  "available": ["Display xl/Semibold", "Text sm/Regular", "Text xs/Medium"],
  "recovery": "Pass textStyleId with one of the available styles"
}
```

No dead ends. The LLM always knows what to do next.

### First Build Always Succeeds

Even if the DS has zero tokens (component-only library), the first build produces a complete artboard using whatever the DS provides. Components are used where available. Raw values fill the gaps. The build report then shows exactly what's missing:

> "Built with 12 DS components. 47 text nodes used raw font properties (no text styles in DS). 23 fills used raw hex (no color variables in DS). Adding text styles and color variables would enable full DS compliance, mode switching, and consistent theming across builds."

The tool demonstrates value first, then recommends improvements. Never block the first build.

---

## 4. Component Configuration Protocol

Inserting a component is step 1 of 7. A component that still says "Button" with placeholder icons is worse than a well-built primitive.

### The 7-Step Process

```
1. INSERT — Correct component set + variant
   (verify SET name, not just variant name — "Button" vs "Button destructive")

2. INSPECT — Read internal structure
   - Map text nodes by node.name (never by index)
   - Map icon slots (boolean properties + instance swap properties)
   - Map semantic properties (Badge Color, Alert Type, etc.)
   - Cache the structure as a recipe in knowledge store

3. OVERRIDE TEXT — Every visible text node gets HTML content
   - Target by node.name ("Label", "Supporting text", etc.)
   - No placeholder text may survive ("Button", "Label", "Olivia Rhye", etc.)

4. SET SEMANTICS — Match HTML intent
   - Badge → set Color property (Success, Error, Warning, Neutral)
   - Alert → set Type property
   - Button → set Hierarchy (Primary, Secondary, Tertiary, Link)

5. CONFIGURE ICONS
   a. HTML has no icon → hide the slot (boolean property = false)
   b. HTML has icon + DS has icon library → search icons, swap in match
   c. HTML has icon + DS has no icons → hide slot, note gap in report
   d. Never leave placeholder icons visible
   e. Never use text characters (→, ▶, ✓) as icon substitutes

6. HIDE UNUSED — Set ALL unused boolean features to false
   - Page headers: Back btn, Icon, Badges, Description, Actions
   - Inputs: Hint, Help icon, Prefix, Suffix
   - Any boolean property not needed by the HTML → false

7. VERIFY — No placeholder text remains, no placeholder icons visible
   - Check against known default texts (cached per component)
   - If any default text survives → the component is not done
```

### Icon Library Handling

1. During Phase 1, detect if the DS has an icon library (search for "icon", "icons", common icon names)
2. If yes, cache icon component names and keys
3. During build, match HTML icons to DS icons by semantic name
4. Cache successful icon mappings in knowledge store
5. No match → hide slot, flag in report
6. No icon library → hide all icon slots, recommend adding icons to DS

### Recipe Caching

After successful configuration, save the full recipe to the knowledge store:

```json
{
  "componentKey": "abc123",
  "componentSetName": "Buttons/Button",
  "variant": { "Size": "md", "Hierarchy": "Primary" },
  "textOverrides": { "Label": "{from_html}", "Supporting text": "{from_html}" },
  "defaultTexts": ["Button", "Supporting text"],
  "hiddenSlots": ["Icon leading", "Icon trailing"],
  "iconSlots": {
    "Icon leading": { "booleanProp": "Icon leading", "swapProp": "swap-key" },
    "Icon trailing": { "booleanProp": "Icon trailing", "swapProp": "swap-key" }
  },
  "knownIconMappings": {
    "arrow-right": "icon-component-key-789",
    "search": "icon-component-key-012"
  },
  "confidence": "strong",
  "source": "user_correction",
  "buildCount": 7
}
```

Next build: replay the recipe instead of re-inspecting. Validate component key still resolves first.

---

## 5. Knowledge Layer

Four collections in `ds-knowledge.json`. Machine-optimized (JSON), well-structured, debuggable.

```json
{
  "version": 2,
  "dsFingerprint": "hash-of-library-component-keys-and-variable-keys",
  "components": {
    "button-primary": { "...recipe as above..." },
    "header-nav": { "...composite component recipe..." },
    "badge-success": { "..." }
  },
  "patterns": {
    ".status-badge.success": {
      "componentKey": "def456",
      "variant": { "Color": "Success" },
      "confidence": "moderate",
      "buildCount": 3
    },
    "div.metric-card": {
      "type": "primitive",
      "reason": "No DS component found. Searched: stat, KPI, metric, card stat",
      "buildCount": 4
    }
  },
  "gaps": {
    "tab-component": {
      "evidence": "Built as primitive 4 times across 3 builds",
      "elements": ["nav tabs", "filter tabs", "settings tabs"],
      "estimatedSavings": { "toolCalls": 18, "perBuild": 6 },
      "recommendation": "Should your DS include a Tab component? Built 4 times using DS styles and variables. You can use the primitives I built as a starting point."
    },
    "spacing-tokens": {
      "evidence": "12 frames across 2 builds used raw padding values",
      "estimatedSavings": { "tokenUsage": "~15% reduction" },
      "recommendation": "Adding spacing variables would enable full token binding and mode support."
    }
  },
  "meta": {
    "buildCount": 12,
    "lastBuild": "2026-05-06T...",
    "dsLibraryKey": "filekey123",
    "totalToolCalls": 847,
    "totalFromCache": 312
  }
}
```

### Three-Trigger Learning Model

- **User correction** → Immediate save, confidence: strong, source: `user_correction`
- **User confirmation** → Promote existing pattern to strong
- **3 uncorrected builds** → Auto-promote to strong (source: `auto_promoted`)

### DS Change Detection

At build start, compute fingerprint of current DS (hash of component keys + variable keys). Compare against stored `dsFingerprint`. If different:
- Revalidate all cached component keys (import test)
- Report what changed: "Your DS has 3 new components since last build. 1 component was removed."
- Invalidate recipes for removed/changed components

### Gap Tracking — The Copilot Feature

Every primitive built from styles/variables (instead of a component) becomes a recommendation:

> "No Tab component found — built with DS text styles and color variables across 4 builds. You can use the primitives I built as a starting point to create the component. Adding it would save ~18 tool calls per build (~6 per tab instance)."

Gaps accumulate evidence across builds. The build report surfaces them ranked by estimated savings.

---

## 6. Build Lifecycle — 6 Phases

### Phase 0 — Target

- User specifies target: file, page, or section
- **Check plugin connection.** The bridge is embedded in the MCP server and always running. But the Figma plugin must be started manually by the user (Plugins → Development → Mimic AI → Run). If the plugin is not connected, **stop and guide the user:**
  > "The Figma plugin isn't connected. Open your Figma file, go to Plugins → Development → Mimic AI → Run. I'll wait."
  Do not proceed until the plugin responds. Do not retry silently.
- Scan target for existing artboards → calculate placement (rightmost.x + width + 80px, or x:0 if empty)
- Detect HTML color scheme (dark/light) → set variable mode on artboard after creation
- Load knowledge store
- Create artboard: 1440px wide FIXED, auto-layout VERTICAL, HUG height, `clipsContent: true`, `counterAxisAlignItems: 'CENTER'`
- Create content container inside artboard: FILL width, `maxWidth: 1280`, HUG height, auto-layout VERTICAL, padding 24px (DS spacing variable if available). All build content goes inside this container.

### Phase 1 — DS Discovery

- Load cached component mappings from knowledge store
- Validate cached keys still resolve (one import attempt each)
- For every HTML element type (header, footer, buttons, tabs, inputs, table cells, badges, cards, pagination, navigation, etc.):
  - Check knowledge store first
  - If not cached: search DS for matching component
  - For composite sections (header, footer, sidebar): match by semantic features, not layout
- Build component map: `HTML element → DS component + variant + recipe` or `"primitive — searched [terms], not found"`
- Detect icon library availability, cache icon list
- Compare DS fingerprint — report changes

### Phase 2 — Style & Variable Inventory

- Preload all text styles needed
- Map HTML font sizes → DS text styles
- Map DS color variables by semantic category (text, background, border, icon/foreground)
- Map spacing and radius variables (note which are available vs missing)
- **Build enforcement profile** based on what the DS actually has:
  - `enforceTextStyles`: true if DS has text styles or typography variables
  - `enforceColorVars`: true if DS has color variables
  - `enforceSpacingVars`: true if DS has spacing variables
  - `enforceRadiusVars`: true if DS has radius variables
- Send enforcement profile to plugin via `set_session_defaults`
- Result: complete lookup table for Phase 3 + enforcement profile

### Phase 3 — Build

For each section of the HTML, in source order:

**If component available:**
1. Insert component (correct set + variant)
2. Full 7-step configuration process (Section 4)
3. Verify no placeholder content remains

**If no component (primitive build):**
1. Build with `create_frame`, `create_text`, `create_rectangle`, `create_ellipse`, `create_svg`
2. Every text node: DS text style + DS text color variable
3. Every fill: DS color variable
4. Every frame: auto-layout, FILL width, HUG height
5. Spacing/radius: DS variables if available, raw if not (flagged)

**Charts (native build — no convenience tool):**

| Chart type | Tools | Approach |
|---|---|---|
| Bar | `create_frame` + `create_text` | Auto-layout columns, bars bottom-aligned, `layoutGrow: 1` |
| Donut/Pie | `create_ellipse` + `create_text` | `arcData` with cumulative angles in radians, DS `fillVariable` per segment |
| Line/Area | `create_svg` + `create_text` | SVG `<path>` with cubic beziers, `strokeVariable` post-import, area fill as separate SVG |
| Scatter | `create_ellipse` + `create_text` | Per-point ellipse in NONE-layout container, DS `fillVariable` |
| Radar | `create_svg` + `create_text` | Trig for vertices, SVG polygon, DS variables post-import |
| Heatmap | `create_frame` grid | Frame cells with DS fill intensity mapping |
| Progress | `create_frame` + `create_text` | BG frame + fill frame (proportional width) |

All chart text uses DS text styles. All chart fills use DS color variables. No exceptions.

**Tracking:** Count tool calls and cache hits throughout the build.

### Phase 4 — QA

No screenshots. LLM visual comparison was unreliable in v1 — it said "looks good" when charts were missing and layout was wrong. Replace with deterministic checks:

**1. Section checklist** (primary QA gate):
- Phase 1 produces a section inventory from the HTML (header, hero, metrics row, table, chart, footer, etc.)
- Walk the artboard's children and check each section off
- Missing section = build failure → fix before proceeding
- Extra section = something was invented → remove it

**2. Content audit:**
- Extract all text content from the built artboard (recursive traversal)
- Compare against all text content from the HTML source
- Missing text = missing element. Extra text = placeholder leak or invention.
- Every text mismatch is a defect

**3. Structural validation:**
- Component count: inserted vs mapped in Phase 1 (if Phase 1 mapped 6 components and only 4 were inserted, 2 were missed)
- DS compliance: every text node has DS text style + color variable, every fill has DS color variable (already enforced by plugin gate, but verify the count)
- Layout: no nodes outside the content container, all frames use auto-layout
- Placeholder check: no default component text remains ("Button", "Label", etc.)

**4. Fix pass:**
- Issues found → edit existing artboard to fix (do not rebuild)
- Max one fix pass — if issues persist after one pass, report them honestly

Screenshots remain available as a tool (`get_screenshot`) for users to request manually, but they are not part of the automated QA phase.

### Phase Enforcement (MCP layer)

The MCP server tracks the current build phase mechanically. This is not advisory — it's enforced:

- Phase 3 tools (`create_frame`, `create_text`, `insert_component`, etc.) return an error if Phase 1 (discovery) and Phase 2 (inventory) haven't completed: "DS Discovery not complete. Call mimic_discover_ds first."
- Phase 5 tools (`generate_build_report`) return an error if no artboard was created in Phase 3.
- `mimic_status` always returns the current phase and what to do next.

This prevents the LLM from skipping phases under working memory pressure. The enforcement is lightweight — a single phase counter in the MCP session state, reset on each new build. Not the v1 sprawl of 7 independent boolean flags.

**Save to knowledge store:**
- New component recipes (from first-time configurations)
- Updated pattern confidence (build count incremented)
- New gap evidence (primitives built this session)
- Updated DS fingerprint

**Generate build report:**
- Components used (names, instance counts, configuration details)
- Primitives built (search evidence, DS styles/variables used)
- Gap recommendations ranked by savings estimate
- Efficiency: total tool calls, cache hits, savings vs cold build
- "What I learned this build" — new patterns, promotions, invalidations
- Offer to save as markdown or HTML

**Communicate to user:**
```
Build complete. [X] sections, [N] tool calls ([M] from cache — saved ~[K] vs first build).
DS components: [Y] instances ([names]).
Primitives: [Z] sections — [recommendations with savings].
Full report: [path].
```

---

## 7. Artboard Rules

- **Artboard:** Always 1440px FIXED width — the only fixed-width element in the entire build. Auto-layout VERTICAL, HUG height, `clipsContent: true`.
- **Content container:** Every artboard has an immediate child frame that acts as the content wrapper: FILL width, `maxWidth: 1280`, HUG height, auto-layout VERTICAL, centered via artboard's `counterAxisAlignItems: 'CENTER'`. Padding 24px (or closest DS spacing variable). All page content goes inside this container — sections, cards, tables, charts, everything. This maps to the standard CSS pattern `max-width: 1280px; margin: 0 auto; padding: 0 24px`.
- **All nodes are children of the content container.** Nothing placed directly on the artboard root (except the content container itself) and nothing on the canvas root.
- **Placement:** If target has existing artboards, new artboard goes at `rightmost.x + rightmost.width + 80px`. Empty target: `x: 0, y: 0`.
- **Variable mode:** Set on artboard after creation (light or dark, matching HTML color scheme)
- **Iteration:** User feedback → edit existing artboard in place. Never delete artboards. New artboard only for new screens.

---

## 8. CLAUDE.md Strategy

v1 had 800+ lines of instructions. v2: ~40 lines. The intelligence is in the tool responses, not in a document the LLM has to memorize.

```markdown
# Mimic AI

MCP tool that translates HTML into Figma using the DS present
on the user's target file. Learns from every build.

## Build Protocol

Every build follows 6 phases in order:
0. Target → 1. DS Discovery → 2. Style Inventory →
3. Build → 4. QA → 5. Report

Call `mimic_status` to start. It returns the current state
and what to do next.

## Core Rules

1. Components first. If the DS has it, use it — even if the
   layout doesn't match exactly. Intent over pixel-matching.
2. Text and color are non-negotiable. Every text node: DS text
   style + DS color variable. Every fill: DS color variable.
   No exceptions.
3. Spacing/radius: bind to DS variables when available, raw
   values acceptable if DS lacks them.
4. Auto-layout everywhere. FILL widths, HUG heights.
   Fixed width only on the artboard (1440px).
5. After inserting any component: override ALL text, set
   semantic properties, configure icons, hide unused slots.
   No placeholder content ever.
6. HTML is the source of truth for content. Same text, same
   structure, same order. Don't invent or improve.
7. Feedback means iterate the existing artboard.
   Never delete artboards.
8. Every build ends with a report. Not optional.

## Tool Guidance

Each tool response includes contextual hints:
- Available DS variables for the current property
- Component recipes from the knowledge store
- Warnings when something looks wrong
- Next steps when an error occurs

Follow the tool responses. They know the DS state.
```

Tool responses replace rules. Examples:
- `mimic_status` → "No build in progress. Call `mimic_discover_ds` with your target file."
- `figma_create_text` without text style → error with available styles listed
- `figma_insert_component` → "Inserted Button. Default texts: ['Button', 'Supporting text']. Override both. Icon slots: leading (visible — hide if unused), trailing (visible — hide if unused)."

---

## 9. Chart Building — Native with Calculation Layer

No `figma_create_chart` convenience tool. Charts use the same primitives as everything else. **All chart math is computed in Node.js (`src/charts/calculator.js`), never by the LLM.** The LLM provides data + chart type + dimensions. The calculator returns exact coordinates, SVG strings, and arc angles. The LLM passes these to the plugin.

**Why:** LLMs cannot reliably perform floating-point geometry (angle accumulation, trig, SVG bezier paths). The pre-mortem identified this as a critical failure mode — donuts summing to 340°, bars at wrong heights, radar polygons lopsided. Moving math to Node.js makes chart correctness a testable code path.

**How it works:**
1. LLM extracts chart data from HTML (labels, values, chart type)
2. LLM calls an MCP tool (e.g., `mimic_compute_chart`) with data + chart type + dimensions
3. MCP server computes all geometry in `calculator.js` and returns: exact pixel positions, SVG path strings, arc angles, bar heights
4. LLM calls standard build tools (`create_frame`, `create_svg`, `create_ellipse`, `create_text`) with the pre-computed values
5. All text uses DS text styles, all fills use DS color variables — same enforcement as everything else

**Per chart type — what the calculator returns:**

**Bar chart:** Array of `{ x, y, width, height }` per bar, scaled to `chartAreaHeight`. Labels array with positions.

**Donut/Pie:** Array of `{ startingAngle, endingAngle, innerRadius }` per segment, in radians. Cumulative, sums to exactly 2π. Legend items with labels.

**Line/Area:** Complete SVG `<path>` string with cubic bezier commands. Data point coordinates for dots. Axis label positions.

**Scatter/Bubble:** Array of `{ x, y, radius }` per point, normalized to plot area dimensions.

**Radar/Spider:** Vertex coordinates per data series (trig pre-computed). Grid ring SVG strings. Axis label positions around the polygon.

**Heatmap:** Grid of `{ row, col, fillIntensity }` mapped to a color scale index.

**What the LLM still does:**
- Reads the HTML to extract chart data and type
- Calls the calculator with the right parameters
- Creates Figma nodes with the returned values
- Applies DS text styles and color variables to every node
- Builds the chart container (card wrapper, title, legend) using standard build tools

**Grid lines in all chart types:**
- Horizontal reference lines: 1px stroke
- Vertical separator lines: 1.5px stroke
- DS color variable for all grid strokes

---

## 10. CSS → Figma Property Mapping

Hard-won reference from v1. Correct and complete.

| CSS | Figma |
|---|---|
| `display: flex; flex-direction: row` | `direction: 'HORIZONTAL'` |
| `display: flex; flex-direction: column` | `direction: 'VERTICAL'` |
| `flex: 1` / `flex-grow: 1` | `layoutGrow: 1` |
| `width: 100%` | `layoutSizingHorizontal: 'FILL'` |
| `height: auto` | `layoutSizingVertical: 'HUG'` |
| `max-width: 960px; margin: 0 auto` | `FILL + maxWidth: 960 + parent counterAxisAlignItems: 'CENTER'` |
| `gap: 24px` | `gap: 24` → bind to DS spacing variable if available |
| `padding: 80px 48px` | `paddingTop/Bottom: 80, paddingLeft/Right: 48` → bind to DS spacing |
| `justify-content: center` | `primaryAxisAlignItems: 'CENTER'` |
| `justify-content: space-between` | `primaryAxisAlignItems: 'SPACE_BETWEEN'` |
| `justify-content: flex-start` | `primaryAxisAlignItems: 'MIN'` |
| `justify-content: flex-end` | `primaryAxisAlignItems: 'MAX'` |
| `align-items: center` | `counterAxisAlignItems: 'CENTER'` |
| `align-items: flex-start` | `counterAxisAlignItems: 'MIN'` |
| `align-items: stretch` | Children `layoutSizingVertical: 'FILL'` |
| `text-align: center` | `textAlignHorizontal: 'CENTER'` |
| `overflow: hidden` | `clipsContent: true` |
| `border-radius: 12px` | `cornerRadius: 12` → bind to DS radius variable if available |
| `border: 1px solid color` | `strokeWeight: 1` + DS `strokeVariable` |

**Key principle:** Read the HTML's CSS, translate it. Don't guess layout from visual inspection.

---

## 11. Voice & Tone

Carried from v1 in full. See `docs/v1-VOICE_AND_TONE.md` for the complete reference. Research backing: `internal/research/voice-and-tone.md`.

**The audience is designers**, not developers. Every message, error, report, and recommendation must be written for someone who maintains a design system — precise, professional, no filler.

**Summary:**
- Precise — uses designer vocabulary (token, variant, spec, spacing scale, semantic role)
- Transparent — named, specific, falsifiable status messages. "Scanning 237 published components" not "Loading..."
- Honest — states what failed, not feelings. "Couldn't import Badge (key: abc123). Built as primitive." not "Oops!"
- Respectful of craft — treats every DS token as intentional
- No filler — no "Great question!", no emojis, no narration of process
- Categorical confidence — Strong/Moderate/New/Weak, never percentages
- Recommendations as questions — "Should your DS include X?" with evidence and savings estimate
- Build reports answer: what was built, what was used, what was learned, what's missing

**Voice is embedded in tool responses, not just documentation.** MCP progress notifications are broken in most clients (Claude Code, Cursor, Cline all drop or mangle them). The only reliable channel is the tool result itself. Every tool response must carry status in the voice & tone style — specific counts, named operations, actionable next steps. The CLAUDE.md tells the LLM to relay these to the user as-is.

**The copy test:** Would a senior DS lead keep reading, or close the tab after the third emoji?

---

## 12. Compatibility Matrix

| DS Configuration | Support Level | Behavior |
|---|---|---|
| Team/org library with components + tokens | Full | Components, text styles, color/spacing/radius variables |
| Team/org library with components + typography variables | Full | Typography variables bound via `setBoundVariable` |
| Team/org library with components only | Partial | Components used. Text/color fall back to raw values. Report recommends adding tokens. |
| Community library | Full | Components + styles import normally. Variables via REST API key discovery + `importVariableByKeyAsync` |
| No library enabled | Blocked | Build will not start. User must enable a library. |

---

## 13. What v2 Must NOT Repeat

1. **No rule-as-band-aid.** Fix the code, don't document the bug.
2. **No anti-bypass machinery.** If the tool works, there's no reason to bypass it.
3. **No retry cascades.** Generous timeouts (45s+ for cold imports). Cache failures. Two attempts max.
4. **No governance sprawl.** ~8 core rules in CLAUDE.md. Intelligence in tool responses.
5. **No version churn without testing.** Ship when it works, not when we've patched enough.
6. **No monolith files.** Each source file has one responsibility. The plugin is thin.
7. **No LLM math.** Chart geometry, SVG paths, angle calculations — all in Node.js. The LLM passes data, receives coordinates.
8. **No binary enforcement.** Graduated per-category based on what the DS actually provides. First build always produces output.

---

## 15. Pre-Mortem Findings (2026-05-06)

A 7-agent pre-mortem was run against this spec. Full report: `internal/research/premortem-report-20260506.html`.

**Critical risks identified and addressed:**
- Plugin enforcement too rigid → Graduated enforcement (Section 3)
- LLM can't do chart math → Calculation layer in Node.js (Section 9)
- LLM skips phases on complex builds → Phase enforcement in MCP (Section 6)
- WebSocket drops during long builds → Keepalive + auto-reconnect (Section 1)
- First build fails on imperfect DSs → First build always succeeds (Section 3)

**Risks acknowledged but not fully mitigable in v2:**
- Component matching relies on naming conventions — mitigated by learning loop (corrections cache)
- Setup is complex for non-technical designers — mitigated by install script + documentation
- Learning loop requires repeated use — mitigated by making single builds valuable on their own

**Pre-build validation checklist:**
1. Chart math: test all chart types with known data
2. Imperfect DS: test 4 DS configurations (full tokens, components only, partial tokens, community library)
3. Complex build: 12 sections, 3 chart types, 20+ components — run 3 times
4. WebSocket: 5+ minute build, 200+ calls, simulated drop
5. Onboarding: non-technical designer attempts full setup from zero

---

## 14. Distribution

- **npm:** `@miapre/mimic-ai`
- **GitHub:** `miapre/mimic-ai` (public)
- **Glama:** maintain 100/100 score
- **Install:** `npx -y @miapre/mimic-ai` or `install.sh` for full setup
- **MCP clients:** Claude Code, Cursor, VS Code, Windsurf, JetBrains (JSON config examples)
- **Badges:** Glama, VS Code install, VS Code Insiders install
