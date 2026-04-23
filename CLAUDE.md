# Mimic AI — CLAUDE.md

## What Is Mimic AI

An MCP tool that translates HTML into Figma using the user's design system.
Public-facing tool (GitHub). Must be DS-agnostic — works with ANY design system.

---

## Separation of Concerns

### Tool-level (this file, committed to GitHub)
- Build protocol, golden rules, architecture decisions
- Plugin/bridge/MCP behavior
- DS-agnostic patterns (how to discover styles, how to apply them)
- Everything here must make sense for ANY user with ANY design system

### User DS knowledge (memory files, NEVER committed)
- Specific style keys, variable keys, component keys for a particular DS
- Learned mappings (e.g., "14px semibold → Text sm/Semibold")
- These live in the user's Claude memory directory (project-specific memory files)

**Rule:** If a piece of information only makes sense for one specific DS, it goes in memory, not here.

**No internal names in committed files.** Never mention the creator's company, brand, or DS name (LayerLens, Stratix, or any other internal name) in any committed file — README, CHANGELOG, KNOWN_ISSUES, code comments, error messages, or any other public-facing content. Use generic examples: "team library", "your DS", "Material UI" (a public community library). This applies to every commit, every time. The Platform Architect must grep for internal names after any session that modifies committed files.

**File placement rule:** Before creating ANY file OR editing ANY committed file, apply the stranger test: "Would a user cloning this repo — with a different DS, no relationship to the creator — find this content useful?" New files with internal content → gitignored path (`mimic/`, `internal/`). Additions to committed files must also pass — adding internal content to a public file is a boundary violation. The Platform Architect owns this check — it fires on every file creation AND every edit to committed files. When uncertain, default to gitignored. After any session that modifies committed files, verify nothing internal was introduced.

---

## Voice & Tone

**Authoritative source:** `VOICE_AND_TONE.md`
Read it at the start of every session that involves building. All user-facing output — status messages, phase updates, reports, recommendations, error messages — must follow the voice and tone guidelines. Mimic has a personality: precise, transparent, honest, respectful of the craft.

---

## Workflow

### Session Start (mandatory)
1. Read `GOLDEN_RULES.md`, `ROLES.md`, and `VOICE_AND_TONE.md` — these are the authority
2. Read any user DS knowledge from memory files relevant to the current task
3. Golden rules are always active. Every build, every code change, every decision
4. Compare current DS inventory against last known state (Rule 27 — DS change detection)

### Build Lifecycle — Phased Gates (mandatory for every build)

Every build follows 6 phases. Each phase has a gate that must pass before proceeding. **All phases must be shown to the user with checkbox progress** (see VOICE_AND_TONE.md for format):

1. **Phase 0 — Target** (Platform Architect): Confirm target file/node, calculate artboard placement, identify variable mode requirements. **DS-only enforcement (Rule 43):** Call `set_session_defaults` with `dsMode: "strict"` at the start of every build when a DS is connected. This makes all tools reject raw hex, raw px, and raw fonts — DS variables/styles are required. For component-only DSs without published tokens, use `dsMode: "permissive"` instead.

### Mandatory Stop Protocol

Mimic must stop and notify the user — not fall back silently — when:

1. **DS library unreachable:** Component imports fail for the target library. This means `importComponentByKeyAsync` returns errors or times out for the library's components. The build CANNOT proceed with primitives as a silent fallback. Stop and report: "Your DS library could not be imported. This may happen with community-published libraries. Verify: (1) the library is a team/org library, (2) it is published and enabled in this file."

2. **Zero DS components resolved in Phase 1:** If the component map contains ONLY "primitive fallback" entries and the DS library has published components, something is wrong. Stop and investigate — do not build an all-primitive artboard from a DS that has components.

3. **Critical tool failure during build:** If `create_frame`, `insert_component`, or `set_layout_sizing` fail with errors that prevent correct structure (not just cosmetic issues), stop the current section. Do not rebuild the same section more than twice — if two attempts fail, stop the build and report the failure.

4. **DS compliance gate failure:** If `validate_ds_compliance` returns violations and the violations cannot be fixed in one pass, stop and report to the user rather than entering a fix-rebuild loop.

**What "stop" means:** Save a partial build report to `mimic/reports/`. Communicate to the user what was built, what failed, and why. Do not delete what was partially built — the user may find it useful. End the build lifecycle. Do not continue to the next phase.

**What "stop" does NOT mean:** Do not stop for recoverable issues (single component import failure in a build with other successful imports, variant not found but fallback variant exists, variable not found but closest semantic match available). These are logged and reported, not stopped.

The product philosophy is: "stopping is a feature, not a failure." A stopped build with an honest report is better than a completed build with silent degradation.

2. **Phase 1 — DS Discovery** (DS Integration Engineer): Produce a component map: `HTML element → DS component key` or `"primitive" + reason`. This is NON-OPTIONAL — skipping it is a critical violation (Rule 23). **Regression check (Rule 30):** compare against previous builds of similar screen types.

   **Warm-cache path (Rule 34):** If `ds-knowledge.json` has cached patterns:
   - For each cached match: validate component exists (`importComponentByKeyAsync`) → validate variant exists → if both pass, use cached match (skip `search_design_system`)
   - For invalidated or missing matches: search DS fresh, cache result
   - Report: "X/Y from cache (Z invalidated), W new discoveries"
   
   **Cold path:** No cache exists. Full DS search for every component type. Cache all results.

3. **Phase 2 — Style & Variable Inventory** (DS Integration Engineer): Import all needed text styles, color variables, spacing, radius. Map every HTML font size to a DS text style. Map the DS's variable categories to node types. **Font validation (Rule 28):** every font in the HTML must be checked against the DS. Non-DS fonts are substituted. **Color validation (Rule 29):** every color must map to a DS variable. No raw hex on text.

   **Component-only DS (no tokens):** If the library has components but no published variables or text styles, Phase 2 reports this clearly: "This DS provides components but no design tokens. Components will be used wherever available. Colors, spacing, and typography will use raw values." The build proceeds using all available components, but the Phase 5 report includes a **Token gap** section recommending the user add variable collections (colors, spacing, radius) to their library for full DS compliance on future builds.

4. **Phase 3 — Build** (Build Engineer): Execute the build. Per-node enforcement: auto-layout on every frame, textStyleId on every text node, correct variable category on every color binding, DS components used where Phase 1 mandated.

5. **Phase 4 — QA** (Design QA): Screenshot and compare. Verify content fidelity, layout direction, structure, nothing added/removed. **DS compliance validation (Rule 43):** Call `validate_ds_compliance` on the artboard. Any violation (raw fill, raw text style, raw spacing, fixed sizing) is a build defect that must be fixed before Phase 5. If a violation cannot be fixed (e.g., chart internal geometry), document it in the build report as a known exception.

6. **Phase 5 — Report & Communicate** (Learning Engineer + Product QA): Save build report to `mimic/reports/build-NNN-*.md`. Communicate summary to user including tool call count, cache hits, and savings vs cold build. Pass `toolCallCount` and `cacheHits` to `mimic_generate_build_report`. DS gap recommendations must include tool-call savings estimates. **A build is NOT done until this phase completes.**

### Multi-Page HTML (Rule 26)
When the HTML contains multiple views/pages, list them and let the user choose which to build first. Build one at a time. Learn between builds. Show the list with completion status after each build.

### Component Description Suggestions

When the user asks Mimic to help improve their DS documentation, or after a series of builds where patterns have accumulated:

1. Read the knowledge file (`mimic_ai_knowledge_read`)
2. For each VERIFIED pattern, generate a component description based on observed usage:
   - What the component is (from `component_name`)
   - How it's used (from `notes`, `use_count`, `variant`)
   - In what contexts (from build history)
3. Present descriptions to the user for review — Mimic suggests, the designer approves
4. The user can apply these descriptions to their Figma library components

Example output:
```
Based on 12 builds, here are suggested descriptions for your components:

**Button** (used 47 times, verified)
"Primary action trigger. Used for CTAs (Contained/Primary), secondary
actions (Outlined), and navigation (Text variant). Sizes: sm for nav,
md for forms, lg for hero sections."

**Badge** (used 8 times, candidate)
"Status indicator and announcement label. Used for hero announcements
(Brand color) and table row status (semantic colors: Success/Warning/Error)."
```

These descriptions make the DS work better with Figma Make, Stitch, and generative UI tools — all of which read component metadata to make decisions.

### Plan Mode
Enter plan mode for any non-trivial task (3+ steps or architectural decisions).
If something goes sideways, STOP and re-plan immediately.

### Self-Improvement Loop — Three-Trigger Learning Model
After ANY correction from the user:
1. Classify: is this a **tool-level** fix or a **DS-specific** learning?
2. Tool-level → update this file, GOLDEN_RULES.md, or fix the code
3. DS-specific → update `ds-knowledge.json` as a structured pattern record
4. Never let the same mistake happen twice

**Stop threshold for repeated failures:** If the same tool error occurs 3 times in a single build session, stop the build. The tool has a bug that cannot be worked around by retrying. Report the error pattern and save it to `internal/learning/` for future investigation.

**Learning triggers (event-driven, not open-ended extraction):**
- **User correction** → Write new pattern record with confidence 0.9, source: `user_correction`. If correcting an existing pattern, set `valid_until` on the old record and `supersedes: [old_id]` on the new one.
- **User confirmation** → Promote existing pattern from CANDIDATE to VERIFIED. Increment `use_count`.
- **Repetition** → If Mimic makes the same match 3 builds without correction, auto-promote to VERIFIED (source: `auto_promoted`).
- **NOT_WORTH_STORING** → If a pattern is too specific or ephemeral to generalize, explicitly skip it. This prevents junk accumulation.

**What is NOT a learning trigger:** Scanning every interaction for "things worth remembering." No open-ended LLM extraction. Every write to `ds-knowledge.json` must trace back to one of the three triggers above.

### Mandatory Role Review After Every Build

After Phase 3 (Build) completes and before communicating anything to the user, run an internal role review. This is not optional. Every build, every time.

**Design QA** checks:
- Does every text node have a DS text style? (Rule 39)
- Does every fill use a DS color variable? (Rule 38)
- Does every spacing value use a DS spacing variable? (Rule 38)
- Does the output match the HTML content exactly? (Rule 6, Rule 41)
- Are there any visible icon placeholders? (Rule 37)
- Are there any line breaks not in the HTML? (Rule 42)

**DS Integration Engineer** checks:
- Were all available DS components used? (Rule 2, Rule 23)
- Were any components left with default text? (Rule 40)
- Are all component variants correctly configured? (Rule 12)

**Product QA** checks:
- Does the build report use designer vocabulary, not tool jargon? (Rule 39 note)
- Are gap recommendations phrased as questions? (VOICE_AND_TONE.md)
- Would a designer understand every line without asking "what does that mean?"

**Learning Engineer** checks:
- Was `mimic_ai_knowledge_write` called with all patterns? 
- Were gaps tracked?
- Was Phase 5 completed with a build report?

If ANY check fails, fix it before reporting the build as complete. Do not tell the user "done" until all roles pass.

### Push Back on Incorrect Feedback
If the user provides feedback that contradicts what the HTML or the tool actually did, say so directly. Don't accept blame for something that was correct. Wasting time on non-issues is worse than a brief disagreement.

---

## Role Activation Tiers

### Tier 1 — Always on (every build)
The phased gate model (Phases 0–5) is mandatory for every build. Golden rules are enforced at every phase. No invocation needed — this is default behavior. The Platform Architect's boundary check fires on every file write.

### Tier 2 — On-demand deliberation
The full 6-role scoring framework (see `ROLES.md`). Activated when the user invokes it:
> "As [role1], [role2], ..., [goal]..."

Used for architecture changes, new features, pre-launch reviews, and complex decisions.
Each role evaluates and scores — iterate until all roles reach 10/10.

---

## Golden Rules

**Authoritative source:** `GOLDEN_RULES.md` (44 rules).
Read it at the start of every session that involves building. Never violate any rule.

---

## Build Protocol

The phased gate model (above) is the canonical build protocol. Below are execution-level details for each phase.

### Phase 0–2 (Pre-build)
1. Discover the target DS: read the local DS knowledge cache (generated at runtime — see `docs/knowledge-schema.md`) for available styles, components, variables
2. Search for DS components matching HTML elements (Phase 1). Produce component map.
3. Import all needed text styles and color variables (Phase 2). Map variable categories to node types.
4. If using the bridge: call `preload_styles` and `set_session_defaults` for batch efficiency
5. Calculate artboard placement: rightmost existing frame x + width + 80

### CSS → Figma Auto-Layout Reference

Read the HTML's CSS before building. These properties map directly — don't guess layout, translate it.

**Direction & display:**
| CSS | Figma |
|---|---|
| `display: flex; flex-direction: row` | `direction: 'HORIZONTAL'` |
| `display: flex; flex-direction: column` | `direction: 'VERTICAL'` |
| `display: grid; grid-template-columns: repeat(3, 1fr)` | `direction: 'HORIZONTAL'`, children `layoutSizingHorizontal: 'FILL'` (equal distribution) |

**Sizing:**
| CSS | Figma |
|---|---|
| `flex: 1` / `flex-grow: 1` | `layoutGrow: 1` (FILL remaining space) |
| `flex: 2` vs `flex: 1` | Both `layoutGrow: 1` (Figma can't do proportional — equal split) |
| `width: 300px` | `width: 300` (explicit, only when HTML specifies) |
| `max-width: 960px; margin: 0 auto` | `layoutSizingHorizontal: 'FILL'`, `maxWidth: 960`, parent `counterAxisAlignItems: 'CENTER'` |
| `width: 100%` | `layoutSizingHorizontal: 'FILL'` |
| `height: auto` / no height | `layoutSizingVertical: 'HUG'` (always — height is HUG) |
| `align-items: stretch` (default in flex) | Children `layoutSizingVertical: 'FILL'` in horizontal parents (equal height siblings) |

**Spacing:**
| CSS | Figma |
|---|---|
| `gap: 24px` | `gap: 24` → bind to DS spacing variable |
| `padding: 48px` | `padding: 48` → bind to DS spacing variable |
| `padding: 80px 48px` | `paddingTop: 80, paddingBottom: 80, paddingLeft: 48, paddingRight: 48` → bind each to DS spacing |
| `border-radius: 12px` | `cornerRadius: 12` → bind to DS radius variable |

**Alignment:**
| CSS | Figma |
|---|---|
| `justify-content: center` | `primaryAxisAlignItems: 'CENTER'` |
| `justify-content: space-between` | `primaryAxisAlignItems: 'SPACE_BETWEEN'` |
| `justify-content: flex-start` | `primaryAxisAlignItems: 'MIN'` |
| `justify-content: flex-end` | `primaryAxisAlignItems: 'MAX'` |
| `align-items: center` | `counterAxisAlignItems: 'CENTER'` |
| `align-items: flex-start` | `counterAxisAlignItems: 'MIN'` |
| `text-align: center` | `textAlignHorizontal: 'CENTER'` |
| `margin: 0 auto` (on block element) | Parent `counterAxisAlignItems: 'CENTER'` |

**Overflow & clipping:**
| CSS | Figma |
|---|---|
| `overflow: hidden` | `clipsContent: true` |
| `overflow: visible` | `clipsContent: false` |

**Borders:**
| CSS | Figma |
|---|---|
| `border: 1px solid #e5e7eb` | `strokeVariable: 'divider'`, `strokeWidth: 1` |
| `border-bottom: 2px solid #7c3aed` | Figma strokes apply to all sides — use a nested frame or accept all-side stroke |

**Key principle:** Every CSS layout property has a Figma equivalent. Read the CSS, translate it. Don't invent layout from visual inspection.

### Phase 3 (Build)
- Read the HTML carefully. Build what's there, not what you think should be there.
- Every text node gets a `textStyleId` and a DS color fill from the correct semantic category
- Every frame gets a DS background fill and DS border stroke where applicable
- **Every frame's padding, gap, and radius are bound to DS variables at creation time** — use `paddingVariable`, `gapVariable`, and `cornerRadiusVariable` params on `create_frame` (preferred), or pass variable path strings to `gap`/`padding`/`cornerRadius` params. In strict mode, raw px numbers are rejected. A post-build spacing fix pass is a Phase 3 defect.
- Accent/decorative colors that don't exist in the DS are acceptable as raw fills (document the reason in the build report)
- DS component insertions are immediately followed by variant configuration and text overrides
- **Component icon 3-layer model:** When configuring icon slots on components (buttons, inputs, etc.), set all 3 layers: (1) VARIANT property for slot type, (2) BOOLEAN property for visibility, (3) INSTANCE_SWAP property for icon content. Missing any layer produces wrong icons.
- **Badge/status color properties:** Every Badge, Tag, or status component must have its semantic color property explicitly set. Default colors are never correct for semantic use.
- **Table sizing:** Table wrapper uses `layoutSizingVertical='HUG'`. Rows use `counterAxisSizingMode='AUTO'`. At least one column uses `layoutSizingHorizontal='FILL'` to stretch the table to full width.
- **Multi-item components:** When using tabs, nav items, or other multi-item components with more items than needed, hide extras with `visible=false`. Don't leave default items showing.
- **Page header completeness:** Set ALL boolean properties to `false` for features not shown in the HTML (Back btn, Icon, Badges, Description, Actions, etc.).

### Phase 4–5 (Post-build)
- Take a screenshot and compare with the HTML. Verify content fidelity.
- Generate the build report (Rule 24). Save to `mimic/reports/`.
- Communicate the summary to the user. The build is not done until this happens.

---

## Multi-Role Deliberation Framework

**Role definitions:** `ROLES.md` (6 roles, phased gate model, coverage matrix against all 44 golden rules).

When invoked with a prompt like:
> "As [role1], [role2], ..., come up with a framework to [goal]..."

Protocol:
1. Each role evaluates all relevant areas on 1-10 scale with fact-based justifications
2. Identify areas below 10 — each role proposes specific improvements
3. Iterate until all roles score 10/10 with verifiable assertions
4. Document the full deliberation to the specified file
5. Implement the agreed framework
6. Same multi-role scoring during implementation — iterate until 10/10

Roles must disagree when they see different tradeoffs. Consensus without tension is a sign of shallow analysis.

---

## Architecture

```
mcp.js          — MCP server, exposes tools to Claude
bridge.js       — HTTP/WebSocket bridge between MCP and Figma plugin
plugin/code.js  — Figma plugin sandbox, executes instructions
plugin/ui.html  — Plugin UI, WebSocket relay to bridge

internal/                           (committed code — runtime data dirs are gitignored)
  resolution/             — Component insertion, icon resolution
  rendering/              — DS reinterpretation (CSS → DS style mapping), Puppeteer rendering
  learning/               — Build completion, knowledge persistence (*.js committed; *.json/*.md runtime)
  layout/                 — Layout tree building, computed style extraction
  execution/              — Automated pipeline execution (experimental, not canonical)
  parsing/                — HTML parsing
```

### Execution Paths

**Canonical: Claude-orchestrated builds.**
Claude reads the HTML, understands visual intent, and calls bridge tools directly
(create_frame, create_text, insert_component, set_variant). This produces the best
output because Claude makes layout and DS decisions with full context.

**Input resolution: URL → HTML.**
`pipeline-controller.js` handles input classification (URL vs file vs raw HTML),
headless rendering for client-rendered SPAs (via Puppeteer), and auth acquisition.
It returns a path to static HTML that Claude then builds from. This is a support
module for the canonical path, not an alternative to it.

### Plugin Capabilities
- `create_frame`, `create_text`, `create_rectangle` — with DS style params
- `insert_component` — import from DS library by key
- `set_variant` — batch mode for VARIANT + BOOLEAN properties
- `set_component_text` — set text on component instances
- `preload_styles` — batch import DS styles into cache
- `set_session_defaults` — set default text fill for the build session
- `applyTextStyle` / `applyColorStyle` — DS style binding with cache + fallback

---

## Absolute Rules (from platform engineering principles)

1. **Never silently skip failing operations.** If a bridge call fails, STOP. Don't continue building on broken state.
2. **Never return fake data.** If a component import fails, report it. Don't substitute a hand-crafted frame and call it done.
3. **Never work around a problem — fix it.** If `set_variant` doesn't work, fix the handler. Don't skip property configuration.
4. **Simplicity first.** Make every change as simple as possible. No over-engineering.
5. **Minimal impact.** Only touch what's necessary. A bug fix doesn't need surrounding code cleaned up.
