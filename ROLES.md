# Mimic AI — Role Definitions

## How to invoke

Include roles in your prompt to activate multi-role deliberation:

```
As a [role1], [role2], ..., [goal]. Each role rates relevant areas 1-10 
with fact-based assertions. Iterate until all roles score 10/10. 
Document deliberation to [file]. Then implement.
```

---

## Build Lifecycle — Phased Gate Model

Roles are not passive reviewers. Each role owns a specific phase of the build lifecycle and acts as a gate. The build cannot proceed to the next phase until the current phase's gate passes.

| Phase | Owner | Gate |
|---|---|---|
| **Phase 0: Target** | Platform Architect | Target file + node confirmed. Artboard placement calculated. |
| **Phase 1: DS Discovery** | DS Integration Engineer | Component map produced: every HTML element mapped to DS component or marked "primitive fallback" with reason. Variable category map produced. |
| **Phase 2: Style & Variable Inventory** | DS Integration Engineer | All text style keys, color variable keys, spacing keys, radius keys imported. Text style mapping table: HTML font size → DS style + key. |
| **Phase 3: Build** | Build Engineer | Every frame uses auto-layout (hug/fill). Every text node has textStyleId. Every color uses correct semantic category. DS components used where Phase 1 mandated. |
| **Phase 4: QA** | Design QA | Content fidelity verified. Layout direction correct. Nothing added or removed vs HTML. |
| **Phase 5: Report & Communicate** | Learning Engineer + Product QA | Build report saved. User receives summary. Build is NOT done until this happens. |

---

## 1. Platform Architect

**Owns:** Phase 0 (Target) + tool architecture, DS-agnosticism, public/private boundary.

**Golden rules:** 1 (Core), 9 (Explicit target), 19 (DS change adaptation), 20 (Transparency)

**Phase 0 gate:**
- Target file and node confirmed
- Artboard placement calculated (rightmost + 80px, or x=0 if empty)
- Variable mode requirements identified and documented (which collection, which mode — e.g., "Colors collection, Light mode")
- Phase transition confirmation: explicitly state "Phase 0 complete. Proceeding to Phase 1: DS Discovery." This creates a visible paper trail that makes skipping phases visible.

**Always-on boundary check (fires on every file write, not just push):**
- Before ANY file is written inside the Mimic AI directory, verify: does this content contain DS-specific keys, user paths, or project-specific data? If yes, it MUST go to a gitignored path (`mimic/`, `internal/builds/`, `internal/learning/`). If it's tool-level and generic, it can go in the committed tree.
- Style keys, component keys, variable keys, user file paths, project names — all belong in user's local knowledge layer, never in committed source.
- Every golden rule, role definition, and protocol document must pass the "stranger test": would a user with a completely different DS understand this without modification?
- **Owns `.gitignore`:** Ensures local DS knowledge, build artifacts, and reports never reach GitHub.

**Ongoing architecture checks:**
- Is the architecture DS-agnostic? Would this work for a user with a different DS?
- Are plugin handlers generic? No hardcoded keys in tool code
- Can a new user clone the repo, connect their DS, and get a working build?

---

## 2. Build Engineer

**Owns:** Phase 3 (Build) — execution quality, every frame/text/component created.

**Golden rules:** 5 (Auto-layout), 10 (Correct placement), 11 (Usable output), 13 (Context adaptation), 22 (Minimal calls)

**Phase 3 gate (per-node enforcement):**
- Every frame has auto-layout set (VERTICAL or HORIZONTAL)
- Every frame uses hug or fill — no fixed heights on content frames
- Every text node has `textStyleId` applied — no raw fontName/fontSize
- Every color binding uses the correct semantic variable category
- Every frame's padding, gap, and radius are bound to DS spacing/radius variables at creation time — no raw px values
- DS components used where Phase 1 component map requires them
- Every Badge instance has its semantic color property explicitly set (no default colors on semantic elements)
- Table sizing: wrapper HUGs vertically, rows HUG height, at least one column FILLs horizontally
- No collapsed frames, no orphaned nodes, no overlapping children

**Phase 3 Component Configuration Checklist (run for EVERY DS component inserted):**
- [ ] Variant matches HTML visual appearance (correct color, size, state) — verified against Phase 1 variant mapping
- [ ] Correct component set (e.g., Button not Button destructive)
- [ ] All text content overrides set to match HTML exactly — targeted by `node.name`, never by index
- [ ] No placeholder text remains ("Label", "Olivia Rhye", default avatar names, default badge text)
- [ ] Icon slots configured using 3-layer model: (1) variant for slot type, (2) boolean for visibility, (3) instance swap for icon content
- [ ] Icon slots: hidden if HTML has no icon, swapped to correct DS icon if HTML has icon
- [ ] No text characters (→, ▶, ✓, ←, ✎) substituting for icons — use placeholder box if DS icon unavailable
- [ ] Semantic color properties set on every instance (Badge Color, Alert Type, etc.) to match HTML intent
- [ ] All unused boolean feature toggles explicitly set to `false` (e.g., Page header: Back btn, Badges, Description, Actions)
- [ ] Multi-item components: extras hidden with `visible=false` (tabs, nav items, etc.)
- [ ] Component width fits within parent content area (FILL or constrained)

**Post-QA fix target: 0.** Phase 3 is clean when Phase 4 finds zero issues. Every post-QA fix is tracked as a Phase 3 defect.

**Efficiency checks:**
- Were operations batched where possible?
- Were unnecessary calls avoided?
- Was the resize() trap avoided? (set sizing modes AFTER resize)
- **Tool call count tracked** — total use_figma, get_screenshot, get_metadata calls recorded for the build report

---

## 3. Design QA

**Owns:** Phase 4 (QA) — visual fidelity between HTML and Figma.

**Golden rules:** 6 (HTML content fidelity), 7 (Layout fidelity), 8 (No UI invention), 14 (Content integrity)

**Phase 4 gate:**
- Take a screenshot and compare with HTML rendering
- Content is verbatim — no shortening, paraphrasing, or "improving"
- No placeholder text in any component instance ("Label", "Olivia Rhye", default content = Phase 3 defect)
- Badge colors match HTML semantic intent (status badges = semantic colors, framework badges = neutral, tag badges = colored)
- Table fills available parent width (at least one column uses FILL horizontal)
- No raw px spacing visible — all padding/gap/radius bound to DS variables
- Structure and order match HTML
- Layout directions correct (horizontal where HTML uses flex-row, vertical for flex-column)
- Nothing added that isn't in the HTML
- Nothing removed or altered

---

## 4. DS Integration Engineer

**Owns:** Phase 1 (DS Discovery) + Phase 2 (Inventory) — the bridge between raw HTML and the user's design system.

**Golden rules:** 2 (DS first), 3 (Safe fallback), 4 (No fake usage), 12 (Component config), 18 (DS as truth), 23 (Mandatory discovery), 27 (DS change detection), 28 (No non-DS fonts), 29 (Zero raw hex), 30 (Regression check), 34 (Cache ≠ authority)

**Phase 1 gate — DS Discovery (mandatory, before any build):**
- **Warm-cache path (Rule 34):** If `ds-knowledge.json` has cached patterns, validate each against the live DS: `importComponentByKeyAsync(key)` must succeed AND the target variant must still exist in the component set. Invalidate stale entries. Report: "X/Y validated, Z invalidated."
- **Cold/fresh path:** Search the DS for every component type in the HTML: buttons, tabs, badges, table cells, pagination, dropdowns, inputs, page headers, navigation, cards, avatars
- Produce a component map: `HTML element → DS component key` or `"primitive" + reason`
- **Variant mapping:** For each DS component in the map, document the exact variant that matches the HTML element's visual appearance. Format: `"Get started" → Button (sm, Primary, Default) from Buttons/Button set — blue fill, matches HTML`. This prevents picking variants from wrong component sets (e.g., Button destructive instead of Button).
- **Verify component set:** When the DS has multiple component sets with identical variant names (Button, Button destructive, Button success), always verify the component set name, not just the variant name.
- **Search documentation for primitives:** For each element marked "primitive fallback," list the search terms used. E.g., "KPI card: searched 'stat', 'KPI', 'metric', 'card stat' — no DS component found."
- Produce a variable category map: which DS variable group applies to each node type (e.g., text colors for text fills, background colors for frame fills, border colors for strokes, foreground colors for icon/shape fills — names vary per DS)
- The HTML's styling is irrelevant — DS components are used based on semantic match, not visual similarity

**Phase 2 gate — Style & Variable Inventory:**
- All needed text styles imported and mapped: HTML font size → DS text style name + key
- All needed color variables imported with correct semantic categories
- All needed spacing and radius variables imported
- Coverage verified: every node in the build plan has assigned style/variable keys

**During build enforcement:**
- Every text node: `textStyleId` set, fill bound to the DS's text color variables
- Every frame fill: bound to the DS's background color variables
- Every stroke: bound to the DS's border color variables
- Every icon/shape fill: bound to the DS's foreground color variables
- Variable categories must follow the map produced in Phase 1 — no mixing
- Components correctly configured after insertion: correct variant selected, text overrides set, unused icon slots hidden, icon characters never typed as text
- Component width adapted to parent layout — no edge-to-edge overflow in padded containers

---

## 5. Learning Engineer

**Owns:** Phase 5 (Report) — the feedback loop, build documentation, knowledge persistence.

**Golden rules:** 15 (Post-build learning), 16 (Recommendations), 17 (DS copilot), 19 (DS adaptation), 21 (Graceful failure), 24 (Build report)

**Phase 5 gate — Build Report (mandatory):**
- Report saved to `mimic/reports/build-NNN-*.md`
- Report includes: metadata, section inventory, DS component audit, issue log, classification, recommendations
- **Rules used table:** every component traced to its pattern rule (ID, source, confidence, builds survived)
- **Cache status:** matches validated, invalidated, new discoveries, recipes saved
- **Pattern-learned notification:** terminal output listing new patterns saved, promotions, supersessions (see VOICE_AND_TONE.md)
- **DS gaps (cumulative):** maintained across builds in `ds-knowledge.json`, surfaced in every report
- **Execution metrics section:** total use_figma calls, get_screenshot calls, get_metadata calls, total tool calls, post-QA fix count, Phase 3 defect rate (fixes / sections)
- **Spacing compliance:** X/Y frames bound to DS spacing variables (0 raw px = compliant)
- **Badge color compliance:** X/Y Badge instances with semantic color set (0 default colors = compliant)
- Every finding classified as DS-specific or tool-specific
- DS-specific findings → `ds-knowledge.json` as structured pattern records (three-trigger model)
- Tool-specific findings → golden rules or code changes
- **Recommendation specificity:** each recommendation must include gap description, number of elements affected, and a concrete suggestion
- Cross-build comparison: if this screen was built before, note improvements and regressions
- **Memory persistence trail:** report must end with "Persisted to: [list of files created/updated]"

**Knowledge management — Three-Trigger Model:**
- **User correction** → write pattern record (confidence 0.9, source: user_correction). Supersede old record if exists.
- **User confirmation** → promote pattern to VERIFIED. Increment use_count.
- **3 uncorrected builds** → auto-promote to VERIFIED (source: auto_promoted).
- **NOT_WORTH_STORING** → explicitly skip ephemeral patterns to prevent junk.
- When the DS changes, revalidate cached patterns (Rule 34 enforcement)

---

## 6. Product QA

**Owns:** Phase 5 (Communication) — end-to-end experience from user's perspective.

**Golden rules:** 11 (Usable output), 20 (Transparency), 22 (Minimal calls), 24 (Build report)

**Phase 5 gate — User Communication (mandatory format):**
```
Build complete. [X] sections built.
DS components: [Y] instances ([component names]).
Primitives: [Z] sections ([section: reason], ...).
Issues: [N] ([severity breakdown]).
Known limitations: [list if any].
DS gap recommendations: [list if any].
Full report: [path].
```
- If post-QA fixes were applied, frame them transparently: "X issues caught during QA review and corrected before delivery."
- Recommendations surfaced: DS gaps that would improve future builds
- **No silent completion.** A build that ends without user communication is a Rule 20 + Rule 24 violation

**Voice & tone (UX writing standards):**
- Every message Mimic sends to the user must be concise, actionable, and professional. Lead with what happened, then what to do next.
- No filler, no commentary about difficulty, no internal narration. "Building section 3 of 7" is useful status. "This is a huge HTML, building now" is noise — it adds no value and makes the tool sound like it's struggling.
- Error messages: state what failed and what the user can do about it. Not what Mimic tried internally.
- Recommendations: state the gap and the impact. "Your DS has no Tab component — tabs were built as primitives" is actionable. "Consider adding a Tab component" is vague.
- The user is a designer or engineer. Write for them, not for a general audience.

**Ongoing checks:**
- Is the output ready to use in a design workflow?
- Did the tool explain what it did and why?
- Is the build report honest — flagging real issues, not hiding them?
- Cost awareness: were there redundant calls or wasted operations?

---

## Coverage Matrix

| Golden Rule | Architect | Build Eng | Design QA | DS Integ | Learning | Product QA |
|---|---|---|---|---|---|---|
| 1. Core | **P** | | | | | |
| 2. DS first | | | | **P** | | |
| 3. Safe fallback | | **S** | | **P** | | |
| 4. No fake usage | | | | **P** | | |
| 5. Auto-layout | | **P** | | | | |
| 6. HTML fidelity | | | **P** | | | |
| 7. Layout fidelity | | | **P** | | | |
| 8. No UI invention | | | **P** | | | |
| 9. Explicit target | **P** | | | | | |
| 10. Placement | | **P** | | | | |
| 11. Usable output | | **P** | | | | **S** |
| 12. Component config | | | | **P** | | |
| 13. Context adaptation | | **P** | | | | |
| 14. Content integrity | | | **P** | | | |
| 15. Post-build learning | | | | | **P** | |
| 16. Recommendations | | | | | **P** | |
| 17. DS copilot | | | | | **P** | |
| 18. DS as truth | | | | **P** | | |
| 19. DS adaptation | **P** | | | | **S** | |
| 20. Transparency | **S** | | | | | **P** |
| 21. Graceful failure | | | | | **P** | |
| 22. Minimal calls | | **P** | | | | **S** |
| 23. DS discovery | | | | **P** | | |
| 24. Build report | | | | | **P** | **P** |
| 25. Charts built | | **P** | | | | |
| 26. Multi-page HTML | **P** | | | | | **S** |
| 27. DS change detection | | | | **P** | **S** | |
| 28. No non-DS fonts | | | **S** | **P** | | |
| 29. Zero raw hex text | | | **S** | **P** | | |
| 30. Regression check | | | **S** | **P** | | |
| 31. Never delete artboards | **P** | | | | | |
| 32. Component inspection | | **P** | | **S** | | |
| 33. Recipe persistence | | **P** | | | **P** | |
| 34. Cache ≠ authority | **P** | **S** | **S** | **P** | | |

**P** = Primary owner. **S** = Secondary (supports enforcement).
Every rule has at least one primary owner. No gaps.
