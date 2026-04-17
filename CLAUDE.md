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

**File placement rule:** Before creating ANY file, ask: "Would a public GitHub user need this?" If no, it goes in a gitignored path (`mimic/`, `internal/builds/`, `internal/learning/`). If yes, it goes in the committed tree. The Platform Architect owns this check — it must fire on every file creation, not just builds.

---

## Workflow

### Session Start (mandatory)
1. Read `GOLDEN_RULES.md` and `ROLES.md` — these are the authority
2. Read any user DS knowledge from memory files relevant to the current task
3. Golden rules are always active. Every build, every code change, every decision

### Build Lifecycle — Phased Gates (mandatory for every build)

Every build follows 6 phases. Each phase has a gate that must pass before proceeding:

1. **Phase 0 — Target** (Platform Architect): Confirm target file/node, calculate artboard placement, identify variable mode requirements.

2. **Phase 1 — DS Discovery** (DS Integration Engineer): Search the DS for every component type in the HTML. Produce a component map: `HTML element → DS component key` or `"primitive" + reason`. This is NON-OPTIONAL — skipping it is a critical violation (Rule 23).

3. **Phase 2 — Style & Variable Inventory** (DS Integration Engineer): Import all needed text styles, color variables, spacing, radius. Map every HTML font size to a DS text style. Map the DS's variable categories to node types (which color group for text fills, which for backgrounds, which for borders, which for icons).

4. **Phase 3 — Build** (Build Engineer): Execute the build. Per-node enforcement: auto-layout on every frame, textStyleId on every text node, correct variable category on every color binding, DS components used where Phase 1 mandated.

5. **Phase 4 — QA** (Design QA): Screenshot and compare. Verify content fidelity, layout direction, structure, nothing added/removed.

6. **Phase 5 — Report & Communicate** (Learning Engineer + Product QA): Save build report to `mimic/reports/build-NNN-*.md`. Communicate summary to user. **A build is NOT done until this phase completes.**

### Plan Mode
Enter plan mode for any non-trivial task (3+ steps or architectural decisions).
If something goes sideways, STOP and re-plan immediately.

### Self-Improvement Loop
After ANY correction from the user:
1. Classify: is this a **tool-level** fix or a **DS-specific** learning?
2. Tool-level → update this file, GOLDEN_RULES.md, or fix the code
3. DS-specific → update the relevant memory file
4. Never let the same mistake happen twice

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

**Authoritative source:** `GOLDEN_RULES.md` (25 rules).
Read it at the start of every session that involves building. Never violate any rule.

---

## Build Protocol

The phased gate model (above) is the canonical build protocol. Below are execution-level details for each phase.

### Phase 0–2 (Pre-build)
1. Discover the target DS: read `ds-knowledge-normalized.json` for available styles, components, variables
2. Search for DS components matching HTML elements (Phase 1). Produce component map.
3. Import all needed text styles and color variables (Phase 2). Map variable categories to node types.
4. If using the bridge: call `preload_styles` and `set_session_defaults` for batch efficiency
5. Calculate artboard placement: rightmost existing frame x + width + 80

### Phase 3 (Build)
- Read the HTML carefully. Build what's there, not what you think should be there.
- Every text node gets a `textStyleId` and a DS color fill from the correct semantic category
- Every frame gets a DS background fill and DS border stroke where applicable
- Accent/decorative colors that don't exist in the DS are acceptable as raw fills (document the reason in the build report)
- DS component insertions are immediately followed by variant configuration and text overrides

### Phase 4–5 (Post-build)
- Take a screenshot and compare with the HTML. Verify content fidelity.
- Generate the build report (Rule 24). Save to `mimic/reports/`.
- Communicate the summary to the user. The build is not done until this happens.

---

## Multi-Role Deliberation Framework

**Role definitions:** `ROLES.md` (6 roles, phased gate model, coverage matrix against all 24 golden rules).

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

internal/
  ds-knowledge/           — Normalized DS inventory (components, styles, variables)
  resolution/             — Component insertion, icon resolution
  rendering/              — DS reinterpretation (CSS → DS style mapping), Puppeteer rendering
  learning/               — Build completion, knowledge persistence
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
