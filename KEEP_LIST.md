# Mimic AI v2 — Keep List

Extracted from v1.8.0 (2026-05-06). This document captures everything we learned that must survive the rewrite — the product definition, the principles that worked, the lessons from failure, and the decisions already made. Nothing here is code. This is the spec.

---

## 1. Product Identity

**One-liner:** The design system copilot that builds Figma screens from HTML, and gets better every time you use it.

**What it is:** An MCP server that translates HTML into Figma using the user's real design system — real components, real tokens, real text styles, auto-layout everywhere.

**What it is NOT:**
- Not a generic HTML-to-Figma converter (those produce pixel-perfect screenshots with zero structure)
- Not a Figma Make competitor (Figma Make generates from prompts; Mimic translates existing HTML)
- Not a code generator
- Not a chatbot

**Core differentiator:** DS compliance. Every other tool produces output that looks right but breaks on inspection. Mimic produces output that IS right — bound to the user's design system, responsive, maintainable.

**Second differentiator:** Learning loop. The tool gets cheaper and better with each build. Component matches cache, patterns verify through repetition, DS gaps accumulate evidence.

---

## 2. Architecture (Keep)

```
Claude Code ←→ MCP Server (mcp.js) ←→ HTTP Bridge (bridge.js) ←→ Figma Plugin (plugin/code.js)
                                                                         ↕
                                                                    Figma Desktop App
```

- **MCP server** exposes tools to any MCP client (Claude Code, Cursor, VS Code, etc.)
- **Bridge** is a local HTTP/WebSocket relay — runs on user's machine
- **Plugin** executes in Figma's sandbox via Plugin API
- **Read channel** (separate): Figma REST API via official Figma MCP for inspecting designs
- **Write channel** (ours): unlimited, no rate limit, all local

This architecture is correct and proven. Keep it.

---

## 3. Tool Interface (Keep — This is the public API)

45 tools organized into 5 groups:

**Status & learning:** `mimic_status`, `mimic_discover_ds`, `mimic_ai_knowledge_read`, `mimic_ai_knowledge_write`

**DS setup:** `figma_preload_styles`, `figma_preload_variables`, `figma_discover_library_styles`, `figma_discover_library_variables`, `figma_set_session_defaults`, `figma_list_text_styles`, `figma_read_variable_values`

**Build:** `figma_create_frame`, `figma_create_text`, `figma_create_rectangle`, `figma_create_ellipse`, `figma_create_chart`, `figma_create_svg`, `figma_insert_component`, `figma_batch`

**Edit:** `figma_set_component_text`, `figma_set_text`, `figma_set_node_fill`, `figma_set_layout_sizing`, `figma_set_variant`, `figma_set_visibility`, `figma_set_text_style`, `figma_set_variable_mode`, `figma_swap_main_component`, `figma_replace_component`, `figma_restyle_artboard`, `figma_move_node`, `figma_delete_node`

**Inspect & QA:** `figma_get_node_props`, `figma_get_node_children`, `figma_get_node_parent`, `figma_get_text_info`, `figma_get_component_variants`, `figma_get_selection`, `figma_select_node`, `figma_get_page_nodes`, `figma_get_pages`, `figma_change_page`, `figma_validate_ds_compliance`, `figma_tag_raw_exception`

**Rendering:** `mimic_pipeline_resolve`, `mimic_render_url`, `mimic_generate_build_report`, `mimic_generate_design_md`

### Tools to reconsider in v2:
- `figma_create_chart` — was blocked, then unblocked, then partially works. Should it exist at all, or should charts always be native?
- `figma_tag_raw_exception` — workaround for a problem that shouldn't exist if DS enforcement works
- `figma_batch` — caused bridge disconnects at >6 ops. Rethink batch strategy.
- `mimic_render_url` — Puppeteer rendering pipeline. Keep if URL→HTML is a real use case; drop if HTML input is sufficient.

---

## 4. Build Lifecycle (Keep — The 6-phase model works)

| Phase | Purpose | What it produces |
|---|---|---|
| **0: Target** | Where to build | File, page, artboard position, variable mode (light/dark) |
| **1: DS Discovery** | What to build WITH | Component map: HTML element → DS component or "primitive + reason" |
| **2: Style Inventory** | Tokens to use | Text style mappings, color variables, spacing/radius variables |
| **3: Build** | The actual construction | Figma nodes with DS bindings |
| **4: QA** | Verify correctness | Screenshot comparison, compliance check |
| **5: Report** | Learning + communication | Build report, patterns learned, DS gap recommendations |

This mental model is right. The problem was never the phases — it was the implementation within Phase 3 (build) that accumulated bugs.

---

## 5. Golden Rules — Distilled to What Actually Matters

### Structural (these define what Mimic IS — non-negotiable):

1. **DS first.** Always use DS components when a match exists. Search before building.
2. **DS-only values.** Every fill, stroke, text style, spacing, and radius must come from the DS. No raw hex, no raw px, no raw fonts.
3. **DS-agnostic.** Zero hardcoded references to any specific design system in tool code. All DS values come from runtime discovery.
4. **Auto-layout everywhere.** Hug or fill. Fixed width only for the artboard (1440px).
5. **HTML fidelity.** Same content, same structure, same order. Mimic translates, it doesn't design.
6. **Learning loop.** Every build generates knowledge. Corrections become permanent. Patterns verify through repetition.
7. **Transparency.** Every decision is traceable. Every match cites its source. Every primitive explains what was searched.
8. **Graceful failure.** Stop and report honestly rather than producing broken output silently.

### Operational (proven workflow rules):

9. Sequential component imports (parallel jams the plugin).
10. Artboard placement: rightmost existing + 80px offset.
11. Never delete artboards — user manages cleanup.
12. Multi-page HTML: one artboard at a time, user chooses order.
13. Component configuration requires full inspection before use (variant, text overrides, icon slots, boolean properties).
14. Hide all unused icon slots on every component.
15. Every text node content comes from reading the HTML — never from memory or invention.

### Rules that were band-aids (DO NOT carry forward as rules — fix in code instead):

- Rule 47 (style preload retry) → Fix the preloading to work reliably
- Rule 49 (token waste threshold) → Don't produce raw tokens in the first place
- Rule 50 (component search gate) → Make discovery mandatory by architecture, not by runtime check
- Rule 55 (no tool switching) → If the tool works correctly, there's no reason to switch
- Rule 59 (anti-bypass) → Same — this rule exists because the tool was broken

---

## 6. Voice & Tone (Keep entirely)

The v1 Voice & Tone document is excellent and battle-tested. Key principles:

- **Precise.** Uses designer vocabulary: token, variant, spec, spacing scale, semantic role.
- **Transparent.** Named, specific, falsifiable status messages. Labor illusion backed by research.
- **Honest.** States what failed, not feelings about failure.
- **Respectful of craft.** Designers spent months on their DS. Mimic treats every token as intentional.
- **No filler.** No "Let me think about this...", no "Great question!", no emojis.
- **Categorical confidence.** Strong/Moderate/New/Weak — never percentages.
- **Recommendations as questions.** "Should your DS include X?" backed by evidence, not "Add X."
- **Build report format.** What was built, what DS was used, what was learned, what's missing.

The copy test: Would a senior DS lead keep reading, or close the tab after the third emoji?

---

## 7. Compatibility Matrix (Keep)

| DS Configuration | Support Level |
|---|---|
| Team/org library with components + tokens | Full |
| Team/org library with components + typography variables | Full (since v1.8.0) |
| Team/org library with components only | Partial (components yes, tokens no) |
| Community library | Full (with REST API key discovery workaround) |
| No library enabled | Blocked (by design) |

---

## 8. What We Learned About Competitors (from research/)

- **Figma Make:** Generates from prompts, not HTML. Our angle is HTML→Figma with real DS compliance.
- **Screenshot-to-Figma tools:** Capture pixels, not structure. Mimic captures structure.
- **AI design tools (general):** Draw rectangles that look like buttons. Mimic uses real components.
- **Linear's tone:** Short, direct, practices what it preaches. Benchmark for our voice.
- **Shopify Polaris writing:** "Approach content like Jenga. What's the most you can take away before things fall apart?"
- The learning loop + DS gap detection is our unique moat. No competitor does this.

---

## 9. What We Learned From Failure (carry these as architecture requirements, not rules)

### The bypass incident (2026-04-30)
When strict mode blocked `create_text` and `create_chart`, the LLM abandoned the entire toolchain and switched to `use_figma`. Result: 0/362 DS tokens, 0/11 components.

**Architecture lesson:** The tool must never produce an error that has no valid path forward within the tool. Every error must have a recovery path using Mimic's own tools. If there's genuinely no path, stop cleanly — don't leave the LLM to improvise.

### The retry cascade (v1.5.0)
20s timeout on component imports → 3 retries × 5 components = 15 failed API calls → plugin WebSocket destabilized → builds die mid-way.

**Architecture lesson:** Timeouts must be generous for cold starts (45s+). Failed keys must be cached so the same failure doesn't repeat. Retry strategy: 2 attempts max, then cache failure and move on.

### The rule sprawl
v1.0 had 0 rules. v1.8.0 had 60. Most rules were patches for implementation bugs, not genuine design principles.

**Architecture lesson:** If you need a rule to prevent bad behavior, the architecture is wrong. Rules should describe WHAT the tool does, not what it must NOT do. The code should make the wrong thing impossible, not document why it's wrong.

### The fix-on-fix cycle
Every build exposed new failures → patches → new edge cases → more patches. Version jumped from 1.2.0 to 1.8.0 in 2 weeks, almost entirely fix commits.

**Architecture lesson:** v2 must be testable. Automated tests for DS compliance, for component insertion, for text style binding. If a fix can't be verified without a full manual build, the architecture doesn't support quality.

---

## 10. CSS → Figma Mapping (Keep — this reference table is correct and hard-won)

| CSS | Figma |
|---|---|
| `display: flex; flex-direction: row` | `direction: 'HORIZONTAL'` |
| `display: flex; flex-direction: column` | `direction: 'VERTICAL'` |
| `flex: 1` / `flex-grow: 1` | `layoutGrow: 1` |
| `width: 100%` | `layoutSizingHorizontal: 'FILL'` |
| `height: auto` | `layoutSizingVertical: 'HUG'` |
| `max-width: 960px; margin: 0 auto` | `FILL + maxWidth: 960 + parent CENTER` |
| `gap: 24px` | `gap: 24` → bind to DS spacing variable |
| `padding: 80px 48px` | Individual padding properties → bind to DS spacing |
| `justify-content: center` | `primaryAxisAlignItems: 'CENTER'` |
| `justify-content: space-between` | `primaryAxisAlignItems: 'SPACE_BETWEEN'` |
| `align-items: center` | `counterAxisAlignItems: 'CENTER'` |
| `overflow: hidden` | `clipsContent: true` |
| `border-radius: 12px` | `cornerRadius: 12` → bind to DS radius variable |

---

## 11. Chart Building Approach (Keep the knowledge, simplify the implementation)

Charts should be built natively using the same primitives as everything else: `create_frame`, `create_text`, `create_rectangle`, `create_ellipse`, `create_svg`. This ensures 100% DS compliance.

**Proven patterns:**
- Bar: auto-layout columns, `layoutGrow: 1`, bars bottom-aligned via `primaryAxisAlignItems: MAX`
- Donut: `create_ellipse` with `arcData` (cumulative angles in radians)
- Line: SVG `<path>` with cubic beziers, `strokeVariable` post-import
- Radar: Trig for vertex positions, SVG polygon
- Scatter: `create_ellipse` per point in a NONE-layout container
- Heatmap: Grid of frames with fill intensity mapped to DS color scale

The `figma_create_chart` convenience tool was a source of constant bugs. Consider dropping it entirely in v2.

---

## 12. Distribution & Market Presence (Current State)

- **npm:** `@miapre/mimic-ai` — v1.6.0 published (v1.8.0 ready but never published)
- **Glama:** 100/100 score, 607 weekly downloads
- **GitHub:** `miapre/mimic-ai` (public)
- **Badges:** Glama, VS Code install, VS Code Insiders install
- **Community PRs:** awesome-mcp-servers (email thread), awesome-ai-for-design #5, awesome-figma #28, Awesome-Design-Tools #515

---

## 13. What v2 Must NOT Repeat

1. **No rule-as-band-aid.** If the code is buggy, fix the code. Don't write a rule saying "don't trigger the bug."
2. **No anti-bypass machinery.** If the tool works, there's no reason to bypass it. The 6 anti-bypass fixes and suffixes were symptoms.
3. **No retry cascades.** Generous timeouts + cached failures. Two attempts max.
4. **No 60-rule governance.** The principles fit in ~15 rules. The rest were implementation debt.
5. **No version churn without testing.** v1.2.0 → v1.8.0 in 2 weeks was all fixes. v2 ships when it works, not when we've patched enough.
6. **No session state sprawl.** v1 tracked `dsDiscoveryPerformed`, `knowledgeReadDone`, `componentSearchDone`, `artboardCreated`, `buildReportGenerated`, `rawFallbackCount`, `phase5Pending`... as runtime flags. Simplify.

---

## 14. Open Questions for v2 Planning

1. **Should `figma_create_chart` exist?** Or always native chart building?
2. **Should we keep Puppeteer rendering** (`mimic_render_url`)? Or require HTML input?
3. **How should DS enforcement work?** Strict-by-default is right, but the implementation was fragile. Should the plugin reject raw values at the API level, or should the MCP layer ensure they never reach the plugin?
4. **Testing strategy?** What can be tested without a live Figma plugin? Mock layer? Snapshot tests?
5. **Role model:** Keep 7 roles? Simplify to 3-4? Or embed role logic into the phased gate model directly?
6. **Knowledge persistence:** `ds-knowledge.json` was the right idea. What's the right schema for v2?
7. **Should the bridge be a separate process** or embedded in the MCP server?
