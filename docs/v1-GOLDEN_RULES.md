# Mimic AI — Golden Rules (Final)

## 1. Core

Mimic transforms HTML into Figma using the user's design system.

**DS-agnostic mandate:** The tool code must NEVER contain hardcoded references to any specific design system — no font families, no hex colors, no component names, no variable paths from any particular DS (LayerLens, Untitled UI, Material UI, or any other). All DS-specific values must come from the user's DS at runtime via discovery, preloading, or session defaults. If a fallback is needed (e.g., chart labels when no DS context is provided), use neutral values (grays: #212121, #757575, #F7F7F7) that don't assume any brand palette. The Platform Architect must audit code for DS-specific leaks after every session that modifies plugin/bridge/MCP code.

## 2. Design system first

Always use design system components when a correct match exists. A mandatory DS discovery step must precede every build. Search the DS for all component types present in the HTML (buttons, tabs, badges, tables, inputs, pagination, page headers, etc.). Produce a component map before creating any frame.

The HTML's styling is irrelevant to component selection — if the DS has one type of tabs, those are the tabs to use regardless of how the HTML styled them.

## 3. Safe fallback

If no valid component exists, build with primitives using ONLY DS variables:
- Typography: every text node MUST have a `textStyleId` — no raw fontName/fontSize, ever
- Colors: must match the DS's semantic categories. If the DS separates variables by purpose (e.g., text colors, background colors, border colors, foreground/icon colors), each variable must be used on the correct node type. Mixing categories is a violation even if the resolved color looks the same.
- Spacing: ALL padding, gap, and margins via DS spacing variables — no raw pixel values, ever. **Spacing variables must be bound at creation time.** Every `createFrame()` call that sets padding or gap must immediately follow with `setBoundVariable('paddingTop', var)`, `setBoundVariable('itemSpacing', var)`, etc. A "fix pass" after the build to bind spacing is a Phase 3 defect, not an acceptable workflow. If a specific px value doesn't exist in the DS spacing scale, use the closest available. For centering (e.g., container padding), check if the DS has container/width variables before falling back to the closest spacing variable.
- Radius: via DS radius variables (bound at creation time, same as spacing)

Never raw values. During DS Discovery (Rule 23), produce a variable category map that documents which variable group applies to which node type. Enforce it per-node during build.

**Component-only DS exception:** Some libraries ship components but no published variables or text styles. When Phase 2 discovers zero tokens, the build proceeds using all available DS components — these carry their own internal styles and will render correctly. Elements built from scratch (text, frames, dividers) will use raw values since no tokens exist to bind to. This is not a Rule 3 violation — the DS simply doesn't provide tokens. The build report must include a **Token gap** section explaining: the library has no published design tokens (variables or styles); adding color, spacing, and radius variable collections would enable full token binding on future builds and unlock mode support (light/dark). Frame this as a DS maturity recommendation, not a build failure.

## 4. No fake usage

Never use components incorrectly:
- No wrong variants
- No placeholders
- No overrides

If the match is not correct, fall back to primitives.

## 5. Mandatory auto-layout

Everything must use auto-layout:
- Hug or Fill — content frames must ALWAYS hug height
- Fixed dimensions only for decorative elements (dividers, dots, icon containers)
- Fixed height on content frames (e.g., breadcrumb at 44px) is a violation — use hug + padding instead

**Table sizing protocol:**
- Table wrapper frame: `layoutSizingVertical='HUG'` (never FILL — tables grow with content, they don't stretch to fill a parent)
- Header row and data rows: `counterAxisSizingMode='AUTO'` (hug height to content)
- At least one column (typically the primary data column) must use `layoutSizingHorizontal='FILL'` to stretch the table to full parent width
- All other columns: fixed or hug width based on content type

## 6. HTML content fidelity

The HTML is the source of truth:
- Same content
- Same structure
- Same order

It is not interpreted, not improved, not altered.

## 7. Layout fidelity

The HTML layout must be reflected in Figma:
- Visual relationships
- Groupings
- Direction (horizontal / vertical)

## 8. No UI invention

Mimic does not add to or modify the HTML's intent. It translates, it does not design.

## 9. Explicit target

Mimic builds where the user specifies. If not defined, it must ask.

## 10. Correct placement

Builds must not break the canvas:
- New builds go to the right of existing content
- Existing builds respect their context
- Never overlap

## 11. Usable output

The result must be usable in Figma. If it is not usable, it is a failure.

## 12. Correct component configuration

Components must be fully configured after insertion:
- **Variant selection:** Import the exact variant that matches the HTML's intent. A blue primary button is not a destructive button. **Always verify the component SET name** (e.g., `Buttons/Button` not `Buttons/Button destructive`) — variant names can be identical across different sets. Cross-reference with the Phase 1 variant mapping.
- **Text overrides:** Set all text content to match the HTML. Target text nodes by `node.name` (e.g., `findByName(root, 'Text')`), never by index in a flat list.
- **Icon configuration (3-layer model):** Components with icon slots may require up to 3 configuration layers: (1) a VARIANT property that selects the slot type (e.g., Default/Dot leading/Only), (2) BOOLEAN properties that show/hide each icon slot (e.g., `Icon leading`, `Icon trailing`), (3) INSTANCE_SWAP properties that select the actual icon component. All three layers must be configured. Missing any layer produces wrong icons or visible placeholders.
- **Icon visibility:** If the HTML doesn't show an icon, hide or remove the icon slot. Components with `Icon=Default` often show placeholder circles — switch to `Icon=False` variant, or hide the icon instance. Never leave placeholder icons visible.
- **Icon content:** If the HTML shows an icon (arrow, chevron, play, etc.), use the component's icon slot or a DS icon component. Never type icon characters (→, ▶, ✓, ←, ✎, etc.) as text content — this is a critical violation. When an icon is needed and the DS icon component cannot be found, use a placeholder box (empty frame with border), never a text character.
- **Semantic color properties:** Components with color/status properties (e.g., Badge `Color`, Alert `Type`) must have those properties explicitly set to match the HTML's semantic intent. Default component colors are never correct for semantic use — a status badge must be Success/Error/Warning, a framework badge must be Gray/Neutral, etc.
- **Boolean property completeness:** Components with multiple boolean feature toggles (e.g., Page header with Back btn, Icon, Badges, Description, Actions) must have ALL unused features explicitly set to `false`. Do not rely on variant defaults — they may show unwanted elements.
- **Multi-item component cleanup:** When using a component with N default items but only needing M (M < N), hide extras with `visible=false` on the extra items. Do not just override the first M labels and leave N-M items showing default content. Applies to tabs, navigation items, breadcrumb segments, etc.
- **Size and state:** Match the HTML's sizing and default state.

Inserting alone is never enough. Every property must be verified.

## 13. Context-aware layout adaptation

Components must adapt to the layout where they are inserted. They must not retain sizes or behaviors that break the design.

- If a component is wider than its parent's content area, adjust it (set width to FILL, add padding wrapper, or constrain).
- Breadcrumbs, tabs, and other full-width DS components inserted into a padded content area must respect the padding — they should not span edge-to-edge if the HTML shows them centered.

## 14. Content integrity

HTML content is not modified:
- Exact text
- Images become valid placeholders

## 15. Post-build learning

Every build generates knowledge:
- Saved locally
- Visible to the user
- Includes metrics and results

## 16. Actionable recommendations

Learning translates into concrete improvements:
- What is missing from the DS
- What to optimize
- How to improve future builds

## 17. Design system copilot

Mimic evolves with continued use of the same DS:
- Recognizes patterns
- Improves decisions
- Reduces errors

## 18. DS as source of truth

The current design system always has priority:
- Learnings do not replace it
- Every build revalidates against the DS

## 19. DS change adaptation

Mimic adjusts automatically to changes in the design system. No manual intervention required.

## 20. Transparency

Mimic explains its decisions:
- What it used
- What it could not resolve
- Why

## 21. Graceful failure, not broken output

If a build operation fails, stop that section and report it. Never continue building on top of broken state. A partial build that is honest about what is missing is better than a complete build with silent failures.

## 22. Minimal tool calls

Every tool call has a cost. Mimic must be efficient:
- Never make calls the user can do faster (deleting artboards, moving frames, renaming layers)
- Batch operations where possible
- Do not verify what was just created — trust the response
- Do not preload styles that will not be used
- The best build is the one with the fewest calls that still follows all other rules
- **Track tool call counts** during the build. The build report must include: total use_figma calls, get_screenshot calls, get_metadata calls, and post-QA fix calls. Post-QA fixes are Phase 3 defects — track them separately.

## 23. Mandatory DS discovery

Before building, search the DS for every component type present in the HTML. Produce a component map: HTML element → DS component key, or "primitive fallback" with reason. This search must happen before any `createFrame` or `createText` call.

Component types to search for: buttons, tabs, badges, table cells, pagination, dropdowns/selects, inputs, page headers, navigation bars, cards, dividers, avatars, tooltips — anything the DS might have.

**Universal patterns that almost every DS has — always search for these first:**
- Navigation (header bar, sidebar, top nav) — nearly every HTML has one, nearly every DS has a component for it. Never build navigation from primitives without first checking the DS.
- Page headers (breadcrumb + title + actions)
- Buttons, tabs, badges, inputs, dropdowns
- Table structure (header cells, data cells, filters, pagination)

Skipping discovery is a critical violation. Building a primitive when a DS component exists is a Rule 2 violation.

**Tool-level enforcement:** The plugin tracks whether DS discovery has been performed in the current session. When `dsMode` is `strict` and no discovery has happened (no `preload_styles`, `preload_variables`, `discover_library_styles`, `discover_library_variables`, or `insert_component` call), creating a new artboard (page-level `create_frame`) returns a `DS_DISCOVERY_REQUIRED` warning. This makes it impossible to silently skip Phase 1. The warning appears in the build output and the orchestrator must acknowledge it before proceeding. `set_session_defaults` resets the flag — each new build session requires fresh discovery.

**Rule 2 always takes precedence over Rule 22 (efficiency).** If the DS has table cells, use them — even if it means more tool calls. Efficiency is never an acceptable reason to skip a DS component. The only valid reason to use a primitive is "the DS does not have a matching component."

## 24. Build report & user communication

Every build produces a structured report saved to `mimic/reports/build-NNN-*.md`. The report includes:
- Build metadata (date, source, target, method)
- Section inventory (what was built, status)
- DS component audit (used vs available vs primitive, with reasons)
- Issue log (rule violations found, severity)
- Classification (DS-specific vs tool-specific)
- Recommendations (DS gaps, improvements)

After saving the report, communicate a summary to the user using this format:

```
Build complete. [X] sections built.
DS components: [Y] instances ([names]).
Primitives: [Z] sections ([section: reason], ...).
Issues: [N] ([severity breakdown]).
Known limitations: [list if any].
DS gap recommendations: [list if any].
Full report: [path].
```

If post-QA fixes were applied, state them transparently. A build without a report and user message is incomplete. It is not done.

**Tool-level enforcement:** The MCP server injects a `_phase5_reminder` field into every tool response when an artboard exists but `mimic_generate_build_report` hasn't been called. New artboard creation and `set_session_defaults` are BLOCKED until Phase 5 completes (`PHASE5_BLOCKING` error). This makes Phase 5 impossible to skip silently.

## 25. Charts are built, not placeholders

When the HTML contains charts (bar, line, scatter, donut, radar, etc.), Mimic must build them in Figma — not placeholders.

**Native chart building is the default.** Charts are built using the same primitives as any other section: `create_frame`, `create_text`, `create_rectangle`, `create_ellipse`, and `create_svg`. This ensures 100% DS compliance — every label uses a DS text style, every fill uses a DS color variable, every spacing value uses a DS spacing variable. The `figma_create_chart` convenience tool exists for rapid prototyping but produces partial DS compliance — it must NOT be used in production builds.

**Three primitives for chart geometry:**

| Primitive | Use for | DS compliance |
|---|---|---|
| `create_frame` + `create_rectangle` | Bar charts, heatmap cells, progress bars, grid lines | Full — bind DS variables directly |
| `create_ellipse` with `arcData` | Donut/pie segments, scatter dots, bubble markers | Full — `fillVariable` binds DS color |
| `create_svg` (SVG string import) | Line paths, area fills, radar polygons, polar areas, curves | Partial — apply DS variables to children post-import |

**Per chart type — native build approach:**

- **Bar chart (vertical/horizontal/stacked):** HORIZONTAL auto-layout frame with column frames per bar. Each column: VERTICAL, `primaryAxisAlignItems: MAX` (bottom-align). Bar = frame with FIXED height (scaled to data), DS fill variable. Label = `create_text` with DS text style. Bars use `layoutGrow: 1` to distribute evenly.
- **Line / area chart:** Structure frames for Y-axis labels, plot area, X-axis labels. Line geometry via `create_svg` with an SVG `<path>` using cubic bezier commands. Area = same path but closed and filled. Apply DS `strokeVariable` to the line vectors post-import.
- **Donut / pie chart:** `create_ellipse` per segment with `arcData: { startingAngle, endingAngle, innerRadius }`. Angles in radians, calculated from cumulative data percentages. Each segment gets `fillVariable` for DS color. Legend items = frame rows with color dot + label text.
- **Radar / spider chart:** Calculate vertex positions using trigonometry: `x = cx + r * cos(angle)`, `y = cy + r * sin(angle)`. Generate SVG polygon path. Import via `create_svg`. Axis labels via `create_text` positioned around the polygon.
- **Scatter / bubble chart:** `create_ellipse` per data point positioned via `x`/`y` in a `layoutMode: 'NONE'` container. Each gets `fillVariable`. Size = data dimension for bubbles.
- **Heatmap:** Grid of `create_frame` cells in auto-layout rows. Each cell gets `fillVariable` mapped from intensity to a DS color scale (e.g., brand-50 through brand-600).
- **Progress bar:** HORIZONTAL frame: label (text) + bar bg (frame, `layoutGrow: 1`, DS border color) containing fill (frame, FIXED width proportional to %). Value label (text) at end.
- **Polar area:** Like donut but each segment has a different radius. `create_svg` with arc paths calculated from data.

**Chart grid line widths:**
- Horizontal reference lines: `stroke-width="1"` (1px)
- Vertical separator lines: `stroke-width="1.5"` (1.5px)
- Grid SVG uses `strokeVariable` for DS color binding. The `create_svg` handler preserves individual stroke widths from the SVG markup.

**Area fill opacity:** Area fills must be created as a SEPARATE SVG from the line path. Do NOT apply `fillVariable` to the area SVG — it overrides the SVG's `fill-opacity`. The raw SVG `fill-opacity` is the correct mechanism for semi-transparent area backgrounds. The line + dots SVG can use `strokeVariable` for DS binding.

**Auto-layout applies to charts too.** Charts must be resizable:
- **Chart containers** (cards, wrappers): auto-layout, FILL horizontal, HUG vertical — same as any other frame.
- **Bar columns**: `layoutGrow: 1` to distribute evenly in horizontal parent.
- **Label rows**: HORIZONTAL, SPACE_BETWEEN — labels distribute with the data.
- **Legends**: HORIZONTAL or VERTICAL auto-layout stack. Each legend item is HORIZONTAL (dot + text).
- **Donut/scatter geometry** (arcs, dots, paths): these are the ONLY elements that may use absolute positioning (`layoutMode = 'NONE'`). But they must be inside an auto-layout parent that positions the geometry frame relative to labels and legends.

**DS compliance is mandatory — no exceptions:**
- Every text node (labels, values, legends, axis ticks) must have a DS `textStyleId`
- Every fill (bars, segments, dots, grid lines) must use a DS color variable via `fillVariable`
- Every stroke (lines, borders) must use a DS color variable via `strokeVariable`
- All spacing (padding, gaps) must use DS spacing variables
- After SVG import, traverse child nodes and bind DS color variables
- The chart card wrapper uses `create_frame` with DS padding, gap, radius, and border — same as any card

A placeholder shape labeled "Radar Chart" is not acceptable output.

**Graph visualization coordinate protocol:**
When the HTML contains node-and-edge graphs (agent flows, state machines, dependency trees), connection lines must be calculated from actual node positions after nodes are placed:
- Use `node.x + node.width/2` for center-x, `node.y + node.height` for bottom edge, etc.
- Bezier curves via `vectorNetwork` with `tangentStart`/`tangentEnd` for natural flow
- Never hardcode line coordinates — always derive from the placed nodes' actual positions
- If nodes move (due to auto-layout reflow), lines must be recalculated

## 26. Multi-page HTML: one artboard at a time

When the HTML contains multiple views or pages (e.g., a list view and a detail view, or tabs that switch content):

1. **Detect and list.** Scan the HTML and present a numbered list of distinct views/pages.
2. **Ask the user.** Do not build all views automatically. Let the user pick which one to build first.
3. **Build one, learn, continue.** After each artboard is built and reported, show the list again with completed builds checked. Let the user pick the next one or stop.
4. **Each build improves the next.** Learnings from artboard N (component configurations, style mappings, spacing patterns, corrections) carry forward to artboard N+1.

Building multiple artboards in a single run without user checkpoints is a violation. The learning loop depends on iteration.

## 27. DS change detection

At the start of every build, compare the current DS inventory against previous builds:

- **New components:** Surface them to the user. "Your DS has N new components since my last build. I'll use them where they match."
- **Previously-missing components now available:** "Last time I built [element] as a primitive. You've since added [component] — using it now."
- **Removed components:** Warn the user and fall back gracefully.

This comparison is part of Phase 1 (DS Discovery) and must be visible to the user before build begins.

## 28. No non-DS fonts

If the HTML uses a font that is not in the DS, do not use it. Substitute with the closest DS font and tell the user. Never silently load a non-DS font — it produces nodes that can't be styled consistently and breaks the DS contract.

## 29. Zero raw hex tolerance on text nodes

Every text node fill MUST be bound to a DS text color variable. If no exact match exists, use the closest semantic variable and flag it. Raw hex on text is never acceptable — it means the node will not respond to mode switches and cannot be maintained.

This applies equally to accent colors (brand-700, success-700, error-700). If the DS has these as foreground or utility variables, use them. If not, flag the gap in the report and use the closest available.

## 30. Regression check

Before building any screen, check if a similar screen type has been built before (table, detail, form, etc.). If a previous build used a DS component for an element, this build must use it too — or document why the component no longer applies. Regression (using primitives where a previous build used DS components) is a critical violation.

## 31. Never delete artboards

Mimic must NEVER remove or delete existing artboards. Always build new artboards to the right of existing content. Deleting artboards wastes tool calls and tokens. The user manages cleanup. Mimic builds, it does not clean up.

## 32. Component structure inspection before use

Before using any DS component in a build, Mimic must inspect its internal structure:
1. Create a temporary test instance
2. Traverse its layer tree and map named text nodes to their semantic purpose
3. Document the configuration recipe: which node gets which content, which properties to toggle
4. Only then use the component in the build

Text overrides must target nodes by `node.name`, not by index in a flat list. Index-based text replacement is a critical violation — it produces components with wrong content in the right containers.

A component that is inserted but not configured is worse than a well-built primitive.

## 33. Configuration recipe persistence

When a DS component is correctly configured (user confirms, QA passes, or 3 uncorrected builds), save the configuration recipe to `ds-knowledge.json`:

```
{
  "component_key": "...",
  "variant": "Size=md, Hierarchy=Primary, ...",
  "text_overrides": { "Text": "{from_html}", "Supporting text": "..." },
  "hidden_slots": ["Icon leading"],
  "badge_colors": { "Badge": "Success" },
  "verified": true
}
```

On the next build, replay the recipe instead of re-inspecting the component structure (Rule 32). This eliminates test-instance creation for known components and directly reduces tool calls.

A recipe is invalidated when:
- The component key no longer resolves (component removed from DS)
- The target variant no longer exists in the component set
- The user corrects the configuration (supersede with new recipe)

## 34. Cache is acceleration, DS is authority

Mimic may cache match decisions and configuration recipes in `ds-knowledge.json` to accelerate warm builds. But the cache is NEVER the source of truth — the live DS is.

Before using any cached match:
1. **Validate component exists:** `importComponentByKeyAsync(cached_key)` — if it throws, invalidate cache entry, search fresh
2. **Validate variant exists:** check the component set's children for the cached variant name — if missing, invalidate recipe, inspect fresh
3. **Report invalidations:** "X/Y cached matches validated, Z invalidated (DS changed)"

A stale cache entry that silently resolves to the wrong component is the most dangerous failure mode. Validation costs one API call per unique component type — negligible compared to the cost of a wrong build.

This rule takes absolute precedence over Rule 22 (efficiency). Correctness is never traded for speed.

## 35. Sequential component imports

Component imports (`insert_component`) must be called **one at a time, sequentially**. Never send multiple insert_component calls in parallel — the Figma plugin is single-threaded and concurrent imports queue internally. If the queue depth exceeds the bridge timeout, all pending imports fail and the plugin's import pipeline jams (requires plugin restart to clear).

**Safe pattern:** import → wait for response → import next.
**Unsafe pattern:** fire 6 imports simultaneously → all timeout → plugin jammed.

This applies to any operation that triggers `importComponentByKeyAsync` or `importComponentSetByKeyAsync` in the plugin. Style preloading (`preload_styles`) uses controlled concurrency internally and is safe to call with large batches.

## 36. No overlapping components

DS components inserted into auto-layout parents must never overlap. The plugin automatically sets inserted components to HUG on both axes (sizing to their content, not their default fixed dimensions). This prevents the most common overlap scenario: multiple fixed-width components in a horizontal row whose combined widths exceed the parent.

After insertion, the orchestrator must set explicit widths where the layout requires it:
- **Table rows:** Set the primary data column (usually Name) to `layoutSizingHorizontal: FILL`. Other columns to fixed widths matching the header cell widths.
- **Button groups / form actions:** Leave as HUG (buttons size to their text content).
- **Filter bars:** Use a spacer frame with `layoutGrow: 1` to push elements apart.

If a component appears clipped or collapsed after insertion, check that HUG is appropriate for that component. Some components (e.g., Table header cell, Table filters) may need explicit width or FILL to render correctly.

## 37. Hide ALL unused icon slots on EVERY component

After inserting ANY component instance, **scan ALL its boolean properties and set every icon-related one to `false`** unless the HTML explicitly shows an icon in that position. Components ship with icon placeholders visible by default — leaving them produces visible circles or empty frames that break the design.

This is not limited to buttons. It applies to **every component type**: buttons, inputs, badges, nav items, footer links, table cells, tabs, dropdowns, cards, headers, footers — everything. If it's an instance and it has a boolean property with "icon" in the name, it defaults to `false`.

**Implementation:** After every `insert_component` or `createInstance()`, immediately call:
```
var props = instance.componentProperties;
for (var key in props) {
  if (props[key].type === "BOOLEAN" && key.toLowerCase().includes("icon")) {
    var update = {};
    update[key] = false;
    instance.setProperties(update);
  }
}
```

This must be **automatic and systematic** — not something the builder remembers to do. If the plugin's `handleInsertComponent` can do this automatically, it should.

## 38. Zero raw values — absolute, no exceptions

Every visual property on every node MUST come from the design system. This is not a goal — it is a gate. A build with raw values is a failed build, regardless of how it looks.

**Text:** Every text node MUST have a `textStyleId` from the DS. No raw `fontSize`, `fontWeight`, or `fontName`. If the text style cannot be applied, the build stops — do not proceed with raw fallbacks.

**Colors:** Every fill and stroke MUST use a DS color variable via `fillVariable`/`strokeVariable` or a bound paint. No raw hex values. If a specific color doesn't exist in the DS variable set, use the closest semantic match and flag it in the build report.

**Spacing:** Every `paddingTop`, `paddingBottom`, `paddingLeft`, `paddingRight`, `itemSpacing` MUST be bound to a DS spacing variable via `setBoundVariable()`. No raw pixel numbers.

**Radius:** Every `cornerRadius` MUST be bound to a DS radius variable. No raw pixel numbers.

**Enforcement:** After every build, run a compliance audit: count text nodes without textStyleId, fills without variable binding, spacing without variable binding. If any count > 0, the build is NOT done — fix every violation before reporting to the user.

**If the DS doesn't have a token:** Build the element with the closest available token and add a recommendation: "Your DS doesn't have [X]. Consider adding [specific token] to maintain consistency." This is how Mimic audits the DS — by revealing what's missing.

This rule takes absolute precedence over Rules 22 (efficiency) and 5 (auto-layout). A fast build with raw values is worse than a slow build with full DS compliance.

## 39. Text styles are the only way to style text

If the DS has text styles, **only text styles are to be used**. Never set fontSize, fontWeight, lineHeight, fontName, or letterSpacing as individual properties. Never bind them as individual variables. The text style is the single source of truth for all typography — apply it via `textStyleId` and nothing else.

Figma shows a properly applied text style as "Ag Display xl/Semibold· 60/72" — one reference controlling everything. If instead you see "Inter / Semi Bold / 60 / 72" as separate fields, the text is NOT DS-compliant regardless of whether the values match.

**Setting individual typography properties is only acceptable when the DS has NO text styles at all.** If even one text style exists, all text nodes must use text styles. No exceptions.

This means:
- Never call `setBoundVariable('fontSize', ...)` or `setBoundVariable('lineHeight', ...)` on text
- Never call `node.fontName = ...` or `node.fontSize = ...` on text
- Never detach a text style to "override" one property
- The ONLY text property you set is `node.textStyleId = styleId`
- Color fills are separate — those use color variables via `setBoundVariableForPaint`, not the text style

## 40. No default text on any component

After inserting ANY component, **every visible text node must be overridden** to match the HTML content. No component may display its default placeholder text (e.g., "Untitled UI", "Button CTA", "Team members", "My details", "Label", "Badge"). If a default text is visible in the output, the build is broken.

This is not a suggestion — it is a gate. After every `insert_component` call, immediately inspect the component's text layers and set them all. If the component has text you cannot override (deeply nested, read-only), note it as a limitation — but never leave default text showing.

Components that commonly violate this: **Header navigation** (logo, nav links), **Tabs** (tab labels), **Footer** (brand name, column headings, links), **Input fields** (label, placeholder, hint), **Badges** (label text), **Table header cells** (column names).

## 41. Read the HTML before writing any text

Before setting ANY text content on a Figma node, **read the exact text from the HTML source**. Do not write text from memory. Do not paraphrase. Do not "improve" labels. Do not add words that aren't in the HTML.

If the HTML says "Uptime", the Figma text says "Uptime" — not "UPTIME GUARANTEE". If the HTML says "New — Real-time pipelines in beta", the Figma text says exactly that — not "v3.0 — Real-time pipelines now in beta".

This is Rule 6 (HTML content fidelity) made operational: read the source, copy the source, verify against the source. Every text mismatch between HTML and Figma is a build failure.

## 42. No hardcoded line breaks in text

Never insert `\n` (line breaks) into text content unless the HTML source explicitly contains a `<br>` tag. Text wrapping must be controlled by the **container width**, not by embedded newlines.

If the HTML says "The analytics platform that scales with you" as a single line, the Figma text node must contain that exact string without breaks. The frame width determines where it wraps — that is how responsive design works in Figma.


## 43. DS-only rule — the foundational constraint

Mimic will ONLY use components or styles/variables from the design system to create everything in the artboard (using auto-layout with hug/fill widths and heights only). If it can't for any reason, it will notify the user and the user will be the one deciding what to do. These exceptions are a BLOCKER.

**Fills:** ONLY DS color variables (bound via `setBoundVariableForPaint`). Never raw hex.
**Text:** ONLY DS text styles (applied via `textStyleId`). Never raw `fontName`/`fontSize`/`fontWeight`.
**Spacing:** ONLY DS spacing variables (bound via `setBoundVariable`). Never raw px.
**Radius:** ONLY DS radius variables (bound via `setBoundVariable`). Never raw px.
**Strokes:** ONLY DS border variables. Never raw hex.
**Effects:** ONLY DS effect styles. Never raw shadow values.
**Components:** ONLY DS library components (via `importComponentByKeyAsync`). Never hand-built recreations.
**Layout:** ONLY auto-layout with HUG/FILL. Never fixed widths/heights unless the element is the artboard itself.

**If ANY of the above can't be satisfied:** STOP. Return a structured error with `action_required: "user_decision"`. The orchestrator surfaces this to the user. The user decides: use raw fallback (with explicit acknowledgment), skip the element, or fix the DS reference.

**Enforcement:** `dsMode: "strict"` in session defaults (set via `set_session_defaults`). When strict, all tools reject raw values and throw `DS_STRICT_VIOLATION` or `DS_VARIABLE_NOT_FOUND` errors.

**Post-build:** Call `validate_ds_compliance` on the artboard after every build. Any violation found is a build defect.

**Exception: SVG-imported geometry only.** Line paths, area fills, radar polygons, and polar arcs imported via `create_svg` may contain raw color values in the SVG markup. After import, the orchestrator must apply DS color variables to child vector nodes via `fillVariable`/`strokeVariable`. If DS binding succeeds, the violation is resolved. If it fails (e.g., SVG structure prevents binding), document it in the build report. All other chart elements (containers, bars, labels, legends, ellipse segments, heatmap cells) must use DS variables directly — no exceptions. See Rule 25 for the full native chart building protocol.

This rule overrides all other rules. If any rule conflicts with this one, this one wins.


## 44. Mandatory stop on unreachable DS

If the target design system's components cannot be imported (library import failures, timeouts, or API errors), the build MUST stop at Phase 1. Building an all-primitive artboard when the DS has published components is a critical violation — it makes Mimic behave as a generic HTML-to-Figma converter, which contradicts the core product identity.

**Stop triggers:**
- All component imports for the target library fail or time out
- Phase 1 produces a component map with zero DS components when the library has published components
- The same tool error occurs 3 times in one build session

**What to do when stopped:**
1. Save a partial build report explaining what failed
2. Tell the user which library operations failed and suggest next steps
3. Do not delete partial output — the user may find it useful
4. Do not retry the same failed operation more than twice

**What NOT to stop for:**
- Single component import failure in a build with other successful imports (log and continue)
- Variant not found but fallback variant exists (use fallback, log)
- Variable not found but closest semantic match available (use closest, log)

This rule takes absolute precedence over Rule 22 (efficiency). A fast all-primitive build is worse than a stopped build with an honest report. Stopping is a feature, not a failure.


## 45. Artboard is 1440px FIXED — the only fixed-width element

The artboard is always 1440px wide, FIXED width, auto-layout VERTICAL, `clipsContent: true`. This is the only element in the entire build that uses a fixed width. Every other frame uses HUG or FILL — no exceptions.

**Artboard creation:**
```
width: 1440
direction: VERTICAL
primaryAxisSizingMode: AUTO  (height hugs content)
counterAxisSizingMode: FIXED (width stays 1440)
clipsContent: true
```

If the artboard stretches beyond 1440px, the build has a structural defect. Investigate which child is causing the overflow and constrain it.


## 46. HTML container fidelity — extract, map, bind

The HTML's container constraints (`max-width`, `padding`, `gap`, `margin: 0 auto`) define the layout structure in Figma. Mimic extracts these values and applies them using DS variables.

**Phase 3 protocol — before building each section:**

1. **Extract** the HTML's container model: section padding, content max-width, element gaps, centering. Read the CSS — don't guess.
   - `padding: 80px 48px` → top: 80, right: 48, bottom: 80, left: 48
   - `max-width: 960px; margin: 0 auto` → 960px content, centered in parent
   - `gap: 24px` → 24px between children

2. **Map to DS variables:** For each extracted value, search the DS for the closest spacing/width variable:
   - If the DS has spacing variables (e.g., `spacing-xl = 48`), bind via `setBoundVariable`
   - If the DS has width variables (e.g., `container-max = 960`), bind them
   - If the DS has no spacing variables, use raw values in permissive mode — document in report as a DS gap

3. **Apply as auto-layout — FILL width, HUG height, max-width from HTML:**

   **Width is FILL by default.** Every frame fills its parent's width. No exceptions for containers.

   **Height is always HUG.** Content determines height — never FILL or FIXED on content frames (Rule 5).

   **When the HTML has `max-width`:** Apply it as Figma's `maxWidth` property on the frame. The frame still uses FILL width but stops growing at the max-width value. The parent frame uses `counterAxisAlignItems: CENTER` to center the constrained frame. This maps 1:1 to CSS `max-width + margin: 0 auto`.

   If the DS has width/container variables, bind the maxWidth to the closest DS variable. If not, use the raw value from the HTML.

   **Element sizing** (buttons, cards, inputs, etc.) follows the HTML context — no fixed rules. If the HTML says `flex: 1`, the element FILLs. If the HTML gives it a fixed width, use that width. Read the CSS, don't assume.

   **Text nodes with wrapping:** explicit width for wrapping is acceptable (hero subtitle at 540px). Also map to DS spacing variable if available.

   **Gaps and padding:** Always bound to DS spacing variables when available. Values come from the HTML's CSS.

   **No side-padding hacks.** Never add extra padding to simulate max-width. Max-width is the constraint mechanism. Every `max-width + margin: auto` in the HTML becomes `FILL + maxWidth + parent CENTER` in Figma.

**Example — cards section:**
```css
.cards { display: flex; gap: 24px; max-width: 960px; margin: 0 auto; }
.card { flex: 1; padding: 24px; }
```
Becomes:
- Features section: FILL width, padding 96/48 (DS spacing), `counterAxisAlignItems: CENTER`
- Cards container: FILL width, **maxWidth: 960** (DS width var if available), gap 24 (DS spacing)
- Each card: FILL width (flex: 1 → cards share space equally), padding 24, radius from DS

**Example — charts section:**
```css
.charts { display: flex; gap: 24px; padding: 0 48px 80px; }
.chart-card { flex: 2; }
.chart-card.small { flex: 1; }
```
Becomes:
- Charts section: FILL width, gap 24 (DS spacing), padding 0/48/80/48
- Bar chart card: FILL width (flex: 2)
- Donut chart card: FILL width (flex: 1) — Figma's `layoutGrow` distributes space proportionally

**Example — table section:**
```css
.table-wrap { max-width: 900px; margin: 0 auto; }
```
Becomes:
- Table section: FILL width, `counterAxisAlignItems: CENTER`
- Table wrapper: FILL width, **maxWidth: 900** — fills up to 900px then stops, centered by parent

**What this rule prevents:**
- Content stretching beyond its HTML intent
- Artboards wider than 1440px
- Side-padding hacks to simulate max-width
- Gap/padding values not bound to DS spacing variables

This rule is owned by the **Build Engineer** (execution) and **Design QA** (verification against HTML).


## 47. Style preload retry protocol — never switch to permissive

When text style preloading times out, the ONLY valid response is retry or stop. Switching to `dsMode: "permissive"` is never acceptable when the DS has tokens.

**Retry protocol:**
1. Retry failed styles in batches of 3 (not all at once).
2. If a batch of 3 fails, check `mimic_status` for plugin connectivity.
3. If plugin is connected, retry failed styles individually (1 at a time).
4. If 3 consecutive individual retries fail, this is a BLOCKER — stop the build.
5. Report to the user: "Style preloading failed after retries. The Figma plugin may need to be restarted."

**What NOT to do:**
- Never call `set_session_defaults(dsMode: "permissive")` as a workaround for timeouts.
- Never use raw `fontSize`/`fontWeight` as a "temporary" fallback — there is no such thing.
- Never continue building when styles can't be loaded — the output will be non-DS-compliant.

**Enforcement:** The plugin now rejects `dsMode: "permissive"` when the DS has published tokens (validated at the API level). Even if the orchestrator tries, the tool will return `DS_PERMISSIVE_REJECTED`.

This rule is owned by the **DS Integration Engineer** (Phase 2) and the **Build Engineer** (Phase 3).


## 48. Mandatory knowledge load before every build

Before any build starts, the orchestrator MUST call `mimic_ai_knowledge_read` to load the DS knowledge base. If the knowledge base has VERIFIED patterns with component mappings, those components must be used (after validation).

**Protocol:**
1. Call `mimic_ai_knowledge_read` at the start of every build session.
2. For each VERIFIED pattern: validate the component key still resolves.
3. Produce a component map from knowledge + fresh DS search for unmapped elements.
4. If no knowledge base exists, perform a full DS search (Phase 1 cold path).

**Why:** The knowledge base contains proven component mappings from previous builds. Ignoring it means rediscovering (or failing to discover) components that are already known.

**Enforcement (MCP-level gate):** The MCP server tracks whether `mimic_ai_knowledge_read` has been called in the current session. When the knowledge base has active patterns, attempting to create an artboard (page-level `create_frame`) without calling `mimic_ai_knowledge_read` first returns a `PHASE1_KNOWLEDGE_REQUIRED` error. The artboard is NOT created. This gate is separate from the plugin's `DS_DISCOVERY_REQUIRED` gate — both must pass. The knowledge read gate resets when `set_session_defaults` is called (new build session).

This rule is owned by the **DS Integration Engineer** (Phase 1).


## 49. Token waste threshold — early cascade detection

If a build has created more than 5 nodes (frames or text) that violate DS compliance (no `textStyleId`, raw fills, raw spacing), the build MUST pause and self-check before proceeding.

**Self-check protocol:**
1. Count violations so far.
2. If violations > 5: stop building. Review why violations are accumulating.
3. Common cause: dsMode is permissive when it shouldn't be, or styles failed to load.
4. Fix the root cause before continuing. If the root cause can't be fixed, stop the build.

**Why:** The 2026-04-29 dashboard build created 40+ non-compliant nodes over 33 minutes before the user noticed. A threshold of 5 would have caught the cascade within 2 minutes, saving 31 minutes and hundreds of tool calls.

**Enforcement:** The plugin tracks `rawFallbackCount` in the session. When it exceeds 5 in strict mode, subsequent `create_frame` and `create_text` calls return a `RAW_FALLBACK_THRESHOLD: Build paused — 5+ nodes created with raw fallbacks in strict mode. Investigate root cause before continuing.` error.

This rule is owned by **Design QA** (monitoring) and the **Platform Architect** (enforcement).


## 50. Component search is mandatory — primitives are the fallback, not the default

Building an element from primitives when the DS has a matching component is a Rule 2 violation. The MCP server enforces this with a non-blocking warning: when content frames are being created inside an artboard but `insert_component` has never been called, the first `create_frame` returns a `COMPONENT_SEARCH_MISSING` warning listing all VERIFIED component mappings in the knowledge base.

**What the orchestrator must do:**
1. After calling `mimic_ai_knowledge_read` (Rule 48), extract all VERIFIED patterns with `component_key`.
2. For each component type present in the HTML (buttons, badges, inputs, tabs, table cells, etc.), check if a VERIFIED mapping exists.
3. If yes: validate the component key still resolves, then use `insert_component`.
4. If no VERIFIED mapping: search the DS via `search_design_system` (Figma MCP) for a matching component.
5. Only if BOTH the knowledge base AND a fresh DS search return no match → build with primitives, and document the reason.

**The warning fires once per session** (not per frame) to avoid noise. But one warning is enough — if it fires, the orchestrator must stop and address it before continuing the build.

**Cold start (no knowledge base):** The warning only fires when VERIFIED patterns with component keys exist. On the very first build with a new DS, the knowledge base is empty, so no warning fires. But Rule 23 still requires a fresh DS search — the orchestrator must search `search_design_system` for all component types present in the HTML before building.

This rule is owned by the **DS Integration Engineer** (Phase 1) and **Build Engineer** (Phase 3).


## 51. Phase 5 is structurally enforced — a build without a report is incomplete

Every build MUST end with a call to `mimic_generate_build_report`. The MCP server tracks build session state: when an artboard has been created but `mimic_generate_build_report` has not been called, this is surfaced in two ways:

1. **On `mimic_status`:** The response includes `build_session.phase5_pending: true` and the status message includes a warning.
2. **On `set_session_defaults` (new build session):** If the previous session created an artboard but never generated a report, the response includes a `phase5_warning` field with a `PHASE5_SKIPPED` message.

**Why this matters:** The build report is not just documentation — it is the tool's self-audit. The report surfaces:
- DS compliance score (raw fills, raw text, raw spacing violations)
- Component usage vs. available (catches the zero-component bug)
- DS gap recommendations (what the DS is missing)
- Tool call counts and efficiency metrics
- Learned patterns for future builds

Without the report, construction errors go undetected, the user gets no recommendations, and the learning loop breaks. Phase 5 is Mimic's secondary core feature — it makes the tool visible and valuable beyond the build itself.

**The report would have caught Bug 1:** A build report listing "DS components: 0 instances" when the knowledge base has 7 VERIFIED component mappings would immediately flag the zero-component problem.

This rule is owned by the **Learning Engineer** (Phase 5) and **Product QA** (communication).


## 52. Creation operations must not leave orphaned nodes on failure

Every node creation handler (`create_frame`, `create_text`, `create_rectangle`, `create_ellipse`, `create_svg`, `insert_component`) wraps all post-creation property application in a try/catch. If any property binding fails (DS variable not found, style import failure, parent not found, strict mode violation), the handler calls `node.remove()` before re-throwing the error.

**Why this matters:** Without rollback, a failed `create_frame` that errors on padding or fill still leaves a frame node on the page root. The caller never receives a `nodeId` for it, so it becomes invisible garbage on the canvas. In a complex build, this accumulates to dozens of orphaned nodes the user must manually clean up. Batch operations compound the problem — a batch of 8 operations where 4 fail leaves 4 orphans.

**Implementation pattern:**
```javascript
const node = figma.createFrame();
try {
  // ... all property application
  return { nodeId: node.id, ... };
} catch (e) {
  try { node.remove(); } catch (_) {}
  throw e;
}
```

**The error message is unchanged** — the caller still receives the same DS_VARIABLE_NOT_FOUND / DS_STRICT_VIOLATION / DS_VARIABLE_BIND_FAILED error. The only difference is the node is cleaned up before the error propagates.

This rule is owned by the **Platform Architect** (plugin code) and **Build Engineer** (Phase 3).


## 53. Variable modes must propagate to component instances

Component instances imported from a DS library carry their library's default variable mode (typically Light). When the artboard has an explicit variable mode set (e.g., Dark), the mode cascades to primitive frames with DS variable bindings — but component instances resolve their internal variables against the library's authoring mode, not the artboard's mode.

**Two-part enforcement:**

1. **`set_variable_mode`**: After setting the mode on the target node, walks all descendant INSTANCE nodes and calls `setExplicitVariableModeForCollection` on each one. This fixes components already on the artboard at the time the mode is set.

2. **`insert_component`**: After appending the new instance to its parent, walks up the ancestor chain looking for the nearest node with `explicitVariableModes`. If found, applies those modes to the new instance. This fixes components inserted after the artboard mode was set.

**Without this rule:** A dark-mode build produces an artboard with correct dark backgrounds on primitive frames, but all DS components (buttons, tables, tabs, inputs, headers, footers) render in light mode — a broken, unusable result.

This rule is owned by the **Platform Architect** (plugin code) and **DS Integration Engineer** (Phase 2).


## 54. `figma_create_chart` is blocked in strict mode

The `figma_create_chart` convenience tool is a prototyping aid only. In strict mode, calling it throws `CHART_BLOCKED_STRICT_MODE` with guidance to build charts natively.

**Why it's blocked, not just warned:**
1. **Rendering bugs:** Line charts produce invisible output due to layout/clip dimension mismatches (vector paths calculated from pre-layout sizes, then clipped by post-layout frame).
2. **DS non-compliance:** Chart internals use raw font sizes, raw spacing, and raw fills — 30+ violations per chart that cannot be fixed post-hoc.
3. **Inconsistent quality:** Bar and donut charts render acceptably; line and radar charts do not. Inconsistent output is worse than no output.

**Native chart building produces:**
- Full DS compliance (text styles, color variables, spacing variables on every node)
- Reliable rendering (SVG paths for curves, `create_ellipse` for arcs, native frames for bars)
- Dark/light mode support (all elements use DS variables that respect the artboard's variable mode)

The tool remains available in permissive mode for rapid prototyping with component-only design systems.

This rule is owned by the **Platform Architect** (plugin code) and **Build Engineer** (Phase 3).


## 55. Layout anti-pattern detection in compliance validation

`validate_ds_compliance` checks not only DS token usage but also common layout mistakes that produce misaligned builds. These are reported as `layoutWarnings` (separate from `violations`) so the orchestrator can fix them during Phase 4 QA.

**Detection 1 — Centering mismatch:** A frame with fixed width significantly narrower than its VERTICAL parent (< 90% of parent width), where the parent's `counterAxisAlignItems` is not CENTER. This catches the common `margin: 0 auto` translation error where the orchestrator sets counterAxisAlignItems on the child instead of the parent.

**Detection 2 — Cross-axis alignment default:** A HORIZONTAL frame with children whose heights differ by >1.3x, and `counterAxisAlignItems` defaults to MIN (top-aligned). This catches icon+text rows (e.g., 32px icon + 42px text = 1.3x ratio) where the icon should be vertically centered with the text block.

**These are warnings, not violations** — the orchestrator may have intentionally chosen the alignment. But they flag the most common layout mistakes so they can be reviewed before the build is reported as done.

This rule is owned by the **Design QA** (Phase 4) and **Build Engineer** (Phase 3).


## 56. Icon placeholder detection in compliance validation

`validate_ds_compliance` detects small circular frames built as primitives that should use DS icon components instead. These are reported as `ICON_PLACEHOLDER` layout warnings.

**Detection pattern:** A FRAME node that is:
- Small: ≤ 48px and ≥ 16px on both axes
- Circular: cornerRadius ≥ 50% of the smaller dimension
- Empty: no INSTANCE child (meaning no icon component was inserted)

If a frame matches all three criteria, it's flagged as a probable icon placeholder. The warning prompts the orchestrator to search the DS for icon components and use `insert_component`.

**Why this matters:** Many design systems ship extensive icon libraries as components. Building icon-like shapes as empty colored circles is a visible quality defect — the build looks unfinished. This detection catches the pattern during Phase 4 QA so the orchestrator can fix it before reporting "done."

**Not flagged:** Frames that contain an INSTANCE child (an icon component was inserted), frames larger than 48px (likely content containers, not icons), and frames without circular radius (likely cards or badges).

This rule is owned by the **Design QA** (Phase 4) and **DS Integration Engineer** (Phase 1).


## 57. Input normalization — node IDs, variable paths, and error hints

The plugin normalizes orchestrator inputs to prevent wasted tool calls from format mismatches:

**1. Node ID auto-conversion:** Figma URLs use dashes (`8261-2956`), the Plugin API uses colons (`8261:2956`). The message dispatcher converts all `nodeId`, `parentNodeId`, and `parentId` params from dash to colon format before any handler runs. Only converts when the string contains dashes and no colons (avoids mangling already-correct IDs).

**2. Fuzzy variable path resolution:** When a variable path like `Spacing/spacing-5xl` isn't found in cache, `getVariableByPath` strips prefix segments and retries with progressively shorter suffixes (`spacing-5xl`). This handles orchestrators that guess a collection prefix that doesn't match the actual collection name (e.g., "Spacing" vs "3. Spacing"). Successful fuzzy matches are cached under the original path for instant future lookups.

**3. Contextual error hints:** When `applySpacing` fails in strict mode, the error message includes a contextual hint:
- If the value looks numeric (e.g., `"40"`): hints that raw px values aren't allowed and suggests a variable path
- If the value looks like a path: hints to try without prefixes

**Impact:** These three normalizations eliminated 5 wasted tool calls in a single build session (2 from node ID format, 3 from variable path trial-and-error).

This rule is owned by the **Platform Architect** (plugin code).


## 58. Composite component matching — headers, footers, sidebars

Phase 1 must attempt to match composite HTML sections (header, footer, sidebar) to DS composite components before building them as primitives. The matching protocol:

**1. Feature extraction:** Analyze the HTML section and list its semantic features as a flat list. For a header: `["logo", "nav_links:4", "cta_button", "avatar"]`. For a footer: `["logo", "tagline", "link_columns:3", "social_links:3", "copyright"]`.

**2. DS component search:** Search the normalized DS knowledge for composite components by name (e.g., "Header", "Navigation", "Footer", "Sidebar"). These are typically large component sets with many variants.

**3. Variant inspection:** Call `get_component_variants` and `get_node_props` on the default variant. List all BOOLEAN and VARIANT properties — these represent the component's feature set. For example, a header with `{Search: true/false, Avatar: true/false, CTA: true/false, Breadcrumbs: true/false}` supports 4 toggleable features.

**4. Feature comparison:** Match HTML features to component features. **Layout differences are NOT disqualifying** — if the HTML has the logo on the right but the component puts it on the left, that's acceptable. Only MISSING FEATURES disqualify: if the HTML has a search input but the component has no search toggle, the component can't represent the HTML.

**5. Decision and recording:**
- **Match:** Use the component. Configure variant properties and text overrides to match the HTML.
- **No match:** Build with primitives. Record the analysis in `componentFitAnalysis` for the build report.

**6. Recommendations:** When a component isn't used, the build report includes specific, constructive recommendations phrased as questions:
- "Would adding a 'Search' boolean property to your Header Navigation component be useful? It would enable Mimic to use the component for headers with search inputs."
- "Your Footer component supports 4 link columns but this HTML has 3. Consider adding a variant with fewer columns, or would a boolean toggle per column work better?"

These are the recommendations designers value most — they're specific, actionable, and directly improve DS coverage for future builds.

**Caching:** Successful matches are cached in ds-knowledge as composite patterns (`composite/header`, `composite/footer`, etc.) with `htmlFeatures`, `componentFeatures`, and `matchResult`. Future builds skip the full variant inspection for known feature combinations.

This rule is owned by the **DS Integration Engineer** (Phase 1) and **Learning Engineer** (Phase 5 reporting).


## 59. No tool switching during builds (anti-bypass)

**Context:** On 2026-04-30, strict mode blocked `create_text` (no text styles in DS) and `create_chart` (blocked in strict mode). The LLM responded by abandoning the entire Mimic toolchain and switching to `mcp__claude_ai_Figma__use_figma` (raw Figma Plugin API). Result: 0/362 DS tokens used, 0/11 components used — total DS compliance failure.

**Rule:** Once a Mimic build session starts (artboard created), `mcp__claude_ai_Figma__use_figma` is **FORBIDDEN**. The only Figma write tools allowed are Mimic's own tools.

**When a Mimic tool returns an error:**
1. Check if `insert_component` can solve it (components have their own text/styles)
2. Check if a different Mimic tool can solve it
3. If no Mimic tool can solve it: **STOP** and report the blocker to the user
4. **NEVER** switch to `use_figma` as a workaround

**Enforcement:** All `DS_STRICT_VIOLATION` errors include an `ANTI_BYPASS_SUFFIX`. The component search gate is now a blocking error (frame not created) instead of a warning.

This rule is owned by the **Platform Architect** (error messages, MCP gates) and all roles during **mandatory role review**.


## 60. Typography-variables-only DSs

Some design systems publish typography as variables (`Font size/*`, `Line height/*`, `Font weight/*`) instead of Figma text styles. When the plugin's variable cache contains typography variables, strict mode **requires** `fontSizeVariable` and `lineHeightVariable` params on `create_text` — raw `fontSize`/`lineHeight` numbers are rejected. The plugin binds these variables via `setBoundVariable()`, same pattern as spacing and radius variables. `fillVariable` for text color is still required.

**API params:** `fontSizeVariable` (e.g., `"Font size/display-2xl"`), `fontWeightVariable` (e.g., `"Font weight/semibold"`), `lineHeightVariable` (e.g., `"Line height/text-md"`). These are bound to the text node via `setBoundVariable('fontSize', variable)` etc.

**Strict mode enforcement:** If typography variables exist in the cache and the caller passes raw `fontSize` or `lineHeight` without the corresponding variable param, the plugin throws `DS_STRICT_VIOLATION`. `fontWeight` without a variable path is allowed since the font style is already resolved via the `FONT_STYLES` mapping.

Text nodes created via this path report `textStyle: 'typography_variables_bound'` and `typographyBinding: { fontSize: true/false, fontWeight: true/false, lineHeight: true/false }` in dsCompliance.

This rule is owned by the **Platform Architect** (plugin code) and **DS Integration Engineer** (Phase 2 inventory).
