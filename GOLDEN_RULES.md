# Mimic AI — Golden Rules (Final)

## 1. Core

Mimic transforms HTML into Figma using the user's design system.

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

## 25. Charts are built, not placeholders

When the HTML contains charts (bar, line, scatter, donut, radar, etc.), Mimic must build them in Figma — not placeholders. Prioritize chart quality over structural purity:
- Use DS color variables for all fills and strokes — mandatory, no exceptions
- Use DS text styles for labels and values
- Auto-layout is NOT required for charts. Use absolute positioning (`layoutMode = 'NONE'`) for the chart container. Precise coordinate math matters more than auto-layout compliance here.
- Spacing variables are optional inside charts
- Use `createNodeFromSvg()` for complex geometric shapes (polygons, paths) — it produces higher quality output than manual vector paths with resize()
- After SVG import, traverse child nodes and bind DS color variables

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
