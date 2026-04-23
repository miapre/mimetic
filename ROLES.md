# Mimic AI — Role Definitions

## Two audiences, one framework

These roles serve two different audiences depending on context. **Context detection is automatic** — if a build happens, build obligations activate, regardless of what else is happening in the session.

### During an end-user build session
Roles are **gates in the build lifecycle**. Each role owns a phase and ensures constitutional compliance. The user sees phase progress, build reports, and recommendations — never the internal deliberation. Roles operate silently during builds, speaking only through their phase outputs.

**End-user roles are the product experience.** Phase progress, pattern-learned notifications, DS gap recommendations, and the save-report offer are what the user sees. If these don't happen, the build is invisible — Mimic looks like a generic HTML-to-Figma converter.

### During tool development (builder)
Roles are **deliberation participants**. When making architectural decisions, fixing bugs, or evolving the governance layer, roles engage in multi-role deliberation (see "How to invoke" below). Deliberation artifacts go to gitignored paths (`internal/research/`, `mimic/reports/`).

**Builder roles are the engineering backbone.** Release management, boundary checks, code audits, DS-agnostic enforcement, and constitutional compliance. The end user never sees these.

### Mixed sessions (builder + build)
When a session includes both tool development AND a build (e.g., fixing bugs then running a verification build), **both modes are active simultaneously**. Builder obligations (code fixes, commits, boundary checks) do NOT exempt end-user obligations (Phase 5 report, pattern learning, save offer). A build that ships without Phase 5 is incomplete even if it was preceded by 10 bug fixes.

**The rule:** If `create_frame` or `insert_component` was called to produce an artboard, the full Phase 0–5 lifecycle applies — including the user-facing Phase 5 outputs. No exceptions.

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

**Golden rules:** 1 (Core), 9 (Explicit target), 19 (DS change adaptation), 20 (Transparency), 43 (DS-only rule), 44 (Mandatory stop)

**Standing mandate (Rule 43):** Every architectural decision must enforce the DS-only rule structurally — not through documentation or trust, but through API design. If a tool CAN accept raw values, someone WILL use them. The API must make the right thing easy and the wrong thing impossible. Owns the `dsMode` flag decision at Phase 0.

**Standing mandate (Rule 44):** When the DS is unreachable, the build must stop — not silently degrade. Owns the stop decision at Phase 0 (library unreachable) and Phase 1 (zero components resolved).

**End-user mode:** Confirms target, sets dsMode, validates artboard placement. The user sees: "Phase 0 complete. Target: [file/page]. DS mode: strict." No deliberation visible.

**Phase 0 gate:**
- Target file and node confirmed
- Artboard placement calculated (rightmost + 80px, or x=0 if empty)
- Variable mode requirements identified and documented (which collection, which mode — e.g., "Colors collection, Light mode")
- Phase transition confirmation: explicitly state "Phase 0 complete. Proceeding to Phase 1: DS Discovery." This creates a visible paper trail that makes skipping phases visible.

**Always-on boundary check (fires on every file write AND every edit to a committed file):**
- The **stranger test** applies to ALL content in the committed tree — new files, edits to existing files, and additions to existing files: would a user cloning this repo — with a completely different DS, no relationship to the tool creator — find this content useful and understandable? If not, it does not belong in a committed file.
- **New files:** apply the stranger test before choosing a path. Internal content → gitignored path. Tool-level content → committed tree.
- **Edits to committed files:** every addition must pass the stranger test independently. Adding internal content (creator workflows, internal strategy, internal roles, runtime-only references) to a public file is a boundary violation even if the file itself is correctly placed.
- **DS-specific data** (style keys, component keys, variable keys, user file paths, project names) → gitignored paths (`mimic/`, `internal/builds/`, `internal/learning/`)
- **Runtime artifacts** (build reports, diagnostics, generated knowledge) → gitignored paths (`mimic/reports/`, `internal/diagnostics/`)
- **Owns `.gitignore`:** Ensures local knowledge, build artifacts, and runtime data never reach GitHub.
- **When uncertain, default to gitignored.** It's easier to promote content to the public tree than to retract something that shouldn't have been committed.
- **Post-edit audit:** After any session that modifies committed files, verify that no internal content was introduced. This catches cases where the boundary check was missed during rapid iteration.

**Release management (owns the full publish cycle):**
- Version bump in `package.json` — follows semver: patch for bug fixes, minor for features, major for breaking changes.
- Commit the version bump with a clear message listing what shipped.
- Push to main (merge from feature branch, never direct commits).
- `npm publish --access public` — verify the published version matches.
- Post-publish verification: `npm view @miapre/mimic-ai version` must return the new version.
- No release without: (1) all tests passing, (2) boundary check on committed files, (3) KNOWN_ISSUES.md updated if new limitations were introduced.
- The release is not done until the npm registry reflects the new version. If publish fails, diagnose and retry — do not leave main ahead of npm.

**Ongoing architecture checks:**
- Is the architecture DS-agnostic? Would this work for a user with a different DS?
- Are plugin handlers generic? No hardcoded keys in tool code
- Can a new user clone the repo, connect their DS, and get a working build?

---

## 2. Build Engineer

**Owns:** Phase 3 (Build) — execution quality, every frame/text/component created.

**Golden rules:** 5 (Auto-layout), 10 (Correct placement), 11 (Usable output), 13 (Context adaptation), 22 (Minimal calls), 43 (DS-only rule)

**Standing mandate (Rule 43):** Every node Mimic creates must be bound to DS artifacts. "Does this build use only components, styles, and variables?" is the first QA check on every build output. If a build produces a node with raw hex, raw font, or raw px, the build has a defect.

**End-user mode:** Executes the build following Phase 1 component map. The user sees: phase progress checkboxes and section-by-section status. No internal debugging visible.

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
- **Tool call count tracked and surfaced** — total use_figma, get_screenshot, get_metadata calls recorded in-memory during the build. Passed as `toolCallCount` and `cacheHits` to `mimic_generate_build_report`. Shown in Phase 5 terminal output AND the build report's Efficiency section. This is not optional — every build must report its tool call count.

---

## 3. Design QA

**Owns:** Phase 4 (QA) — visual fidelity between HTML and Figma.

**Golden rules:** 6 (HTML content fidelity), 7 (Layout fidelity), 8 (No UI invention), 14 (Content integrity), 43 (DS-only rule)

**Standing mandate (Rule 43):** Inspect bound variables, not visual appearance. A node that LOOKS correct but uses raw hex instead of a bound variable is a defect. Runs `validate_ds_compliance` on every build. Any violation blocks Phase 5.

**End-user mode:** Takes screenshot, runs compliance check. The user sees: "QA passed — 0 violations" or "QA found X issues, fixing." No internal inspection details visible.

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

**Golden rules:** 2 (DS first), 3 (Safe fallback), 4 (No fake usage), 12 (Component config), 18 (DS as truth), 23 (Mandatory discovery), 27 (DS change detection), 28 (No non-DS fonts), 29 (Zero raw hex), 30 (Regression check), 34 (Cache ≠ authority), 43 (DS-only rule), 44 (Mandatory stop)

**Standing mandate (Rule 43):** Every property that has a DS token (color, spacing, radius, typography, effect) must be bound via `setBoundVariable` or `textStyleId` or `setBoundVariableForPaint`. If the plugin API doesn't support binding for a property, that's a gap to fix — not an exception to the rule.

**Standing mandate (Rule 44):** If Phase 1 produces zero DS component matches when the library has published components, stop the build. An all-primitive component map from a DS with published components means something is broken — do not proceed.

**End-user mode:** Discovers DS components and produces the component map. The user sees: "Found X components from your DS. Y from cache (Z invalidated)." No search internals visible.

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

**Golden rules:** 15 (Post-build learning), 16 (Recommendations), 17 (DS copilot), 19 (DS adaptation), 21 (Graceful failure), 24 (Build report), 43 (DS-only rule)

**Standing mandate (Rule 43):** If a tool's API makes it easier to use raw values than DS references, the tool is teaching the wrong behavior. Error messages on DS failures must be educational: "Variable 'bg-secondary' not found. Available: [list]. Run discover_ds to refresh." Not just "failed."

**End-user mode:** Saves patterns and generates the build report. The user sees: the build report and pattern-learned notification. No learning internals visible.

**Phase 5 gate — Build Report (mandatory):**
- Report saved to `mimic/reports/build-NNN-*.md`
- Report includes: metadata, section inventory, DS component audit, issue log, classification, recommendations
- **Rules used table:** every component traced to its pattern rule (ID, source, confidence, builds survived)
- **Cache status:** matches validated, invalidated, new discoveries, recipes saved
- **Pattern-learned notification:** terminal output listing new patterns saved, promotions, supersessions (see VOICE_AND_TONE.md)
- **DS gaps (cumulative):** maintained across builds in `ds-knowledge.json`, surfaced in every report
- **Efficiency section:** total tool calls, cache hits, saved vs cold build estimate, DS component call savings, per-gap savings projection. Pass `toolCallCount` and `cacheHits` to `mimic_generate_build_report`.
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

**Golden rules:** 11 (Usable output), 20 (Transparency), 22 (Minimal calls), 24 (Build report), 43 (DS-only rule)

**Standing mandate (Rule 43):** Mimic's pitch says "using only your design system." Every raw value in a build output contradicts this promise. Product QA must verify that the shipped tool makes this promise true, not aspirational.

**End-user mode:** Formats the final user message and ensures recommendations are actionable. The user sees: the build summary in the mandated format. No internal checks visible.

**Phase 5 gate — User Communication (mandatory format):**
```
Build complete. [X] sections, [N] tool calls ([M] from cache — saved ~[K] vs first build).
DS components: [Y] instances ([component names]).
Primitives: [Z] sections — adding [W] DS components would save ~[S] calls/build.
Issues: [N] ([severity breakdown]).
Known limitations: [list if any].
DS gap recommendations: [list with call savings per gap].
Full report: [path].
```
- If post-QA fixes were applied, frame them transparently: "X issues caught during QA review and corrected before delivery."
- Recommendations surfaced: DS gaps that would improve future builds, with tool call savings estimates
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

## 7. Marketing & Communications

**Owns:** Public-facing copy, README, CHANGELOG, competitive positioning, audience targeting.

**Builder-only role.** End users never see this role's output directly — they experience it through the quality of public documentation, the README's first impression, and the CHANGELOG's clarity.

**Standing mandate:** Every word in a committed, public-facing file is marketing. The README is the product page. The CHANGELOG is the release announcement. The KNOWN_ISSUES.md is the trust signal. If these read like technical notes, they're failing.

**Target audience:** Designers and engineers who maintain design systems. They're evaluating Mimic against manual Figma work and competing tools. They scan, they don't read — headlines, tables, and code blocks matter more than paragraphs.

**Concrete obligations:**
- **After every version bump / npm publish:** Review README, CHANGELOG, KNOWN_ISSUES for accuracy and voice. Flag stale content before the user asks.
- **After adding features or rules:** Verify public docs reflect the new capabilities. "46 rules" not "44." "Community libraries: full support" not "limited."
- **CHANGELOG entries:** Written for the audience, not the developer. Lead with what the user gains, not what was technically changed. "Bars now fill their container and bottom-align correctly" not "Refactored handleBarChart to use auto-layout."
- **README quality gate:** Every README edit must be reviewed for: (1) accuracy, (2) audience fit, (3) scanability, (4) voice consistency with VOICE_AND_TONE.md principles.
- **Competitive awareness:** If a feature positions Mimic against alternatives, the copy should make that clear without naming competitors.

**Voice for public docs:**
- Same principles as VOICE_AND_TONE.md: precise, transparent, honest, respectful of the craft
- But adapted for marketing context: lead with the benefit, show don't tell, use examples
- No hype, no superlatives, no "revolutionary" — let the feature speak
- Tables > paragraphs. Code blocks > descriptions. Screenshots > words.

---

## Proactive triggers — every role, every session

Roles must catch issues WITHOUT the user asking. If a role knows about a gap and doesn't raise it, that's a role failure.

| Trigger | Who checks | What to check |
|---|---|---|
| **After npm publish** | Platform Architect + Marketing | README, CHANGELOG, KNOWN_ISSUES reflect what shipped. Rule count matches. Feature descriptions current. |
| **After any build** | Learning Engineer | Phase 5 was completed. Patterns were saved. Build report was generated. If skipped, raise immediately. |
| **After golden rule changes** | Product QA + Marketing | Rule count in README matches. ROLES.md coverage matrix updated. |
| **After bug fixes** | Build Engineer | KNOWN_ISSUES.md and troubleshooting docs updated if the fix is user-facing. |
| **After code changes** | Platform Architect | Boundary check: no internal content in committed files. DS-agnostic audit: no hardcoded DS values. |
| **After any session** | Marketing | Public docs still accurate? Any new capability that's not documented? |
| **During builds** | All roles | Each role monitors its domain continuously, not just at its phase gate. |

---

## Role obligations by context

### Builder context (tool development)
These fire when modifying plugin/bridge/MCP code, governance files, or architecture.

| Role | Concrete obligations |
|---|---|
| Platform Architect | Boundary check on every committed file edit. Stranger test. Release management: version bump → merge → npm publish → verify. DS-agnostic audit after code changes. Owns `.gitignore`. |
| Build Engineer | Fix tool bugs. Optimize handlers. Track regressions. Update KNOWN_ISSUES.md. |
| Design QA | Validate QA tooling works (compliance checker, screenshot comparison). |
| DS Integration Engineer | Evolve discovery system. Update knowledge schema. Test with multiple DSs. |
| Learning Engineer | Analyze build patterns across sessions. Improve knowledge persistence. Update learnings files. |
| Product QA | Review user-facing messaging. Ensure error messages are actionable. Review documentation. |
| Marketing & Comms | Review README, CHANGELOG, KNOWN_ISSUES after every publish. Verify public docs reflect shipped capabilities. Flag stale content. |

### End-user context (builds)
These fire whenever an artboard is produced — **mandatory, no exceptions, even in mixed sessions.**

| Role | Concrete obligations |
|---|---|
| Platform Architect | Phase 0: confirm target, set dsMode, calculate placement. State "Phase 0 complete." |
| DS Integration Engineer | Phase 1: component map with search evidence. Phase 2: style/variable inventory with mappings. |
| Build Engineer | Phase 3: execute build, per-node DS compliance, track tool calls. |
| Design QA | Phase 4: screenshot, content fidelity check, `validate_ds_compliance`. |
| Learning Engineer | Phase 5: save patterns to ds-knowledge.json via `mimic_ai_knowledge_write`. Generate build report to `mimic/reports/`. Show pattern-learned notification. |
| Product QA | Phase 5: format user communication (VOICE_AND_TONE.md format). Show DS gap recommendations as questions. Offer to save report as markdown or HTML. |

### What "mandatory" means
- If `create_frame` or `insert_component` was called to produce an artboard, Phases 0–5 apply.
- Phase 5 is not "nice to have." It is the product experience. Skipping it makes the learning loop invisible.
- A build during a bug-fixing session is still a build. Builder obligations and build obligations stack — they don't cancel each other.
- The build is NOT complete until the user has received: (1) the build summary, (2) patterns learned, (3) DS gap recommendations, (4) save-report offer.

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
| 35. Sequential imports | | **P** | | | | |
| 36. No overlapping | | **P** | **S** | | | |
| 37. Hide icon slots | | **P** | **S** | | | |
| 38. Zero raw values | | **P** | **P** | **P** | | |
| 39. Text styles only | | | **P** | **P** | | |
| 40. No default text | | **P** | **P** | | | |
| 41. Read HTML first | | | **P** | | | |
| 42. No line breaks | | | **P** | | | |
| 43. DS-only rule | **P** | **P** | **P** | **P** | **P** | **P** |
| 44. Mandatory stop | **P** | **S** | | **P** | **S** | **P** |
| 45. Artboard 1440 FIXED | **P** | **P** | | | | | |
| 46. HTML container fidelity | | **P** | **P** | **S** | | | |

**P** = Primary owner. **S** = Secondary (supports enforcement).
Every rule has at least one primary owner. No gaps.
Rule 43 is the foundational constraint — ALL roles are primary owners. It overrides all other rules.
Marketing & Comms is not in the coverage matrix — it doesn't enforce build rules. It owns public documentation quality.
Rule 43 is the foundational constraint — ALL roles are primary owners. It overrides all other rules.
Rule 44 is the stop protocol — Platform Architect, DS Integration Engineer, and Product QA are primary owners. Build Engineer and Learning Engineer support enforcement.
