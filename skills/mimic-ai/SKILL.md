---
name: mimic-ai
description: Use when building, editing, or iterating on a Figma design via the Mimic AI MCP server (mimic_status, mimic_discover_ds, figma_create_frame, figma_insert_component, mimic_build_table, mimic_build_chart, etc. are available), or when the user asks to turn HTML, a prompt, or a Claude Design/Figma Make prototype into real Figma using their design system. Do not use for read-only Figma inspection, FigJam, or any task using the official Figma MCP tools instead.
---

# Mimic AI: building Figma with the user's design system

Mimic AI enforces design-system compliance at write time. The core
discipline is: never bypass the gate, never skip discovery, never end a
build without a report. Full tool-by-tool reference lives in the
project's own `CLAUDE.md` if it's present in the repo. This skill is the
operational sequence to follow every time.

## The sequence, every build

1. **`mimic_status`**, always the first call, every session. Returns the
   current phase, session state, and any stored design rules that apply.
   Never assume phase; read it from the response.

2. **Discovery, two steps, both required:**
   - **Step 1:** `mimic_discover_ds(fileKey)`. Discovers variables, text
     styles, and components via the plugin. This alone does NOT make the
     build ready: it stops at Phase 1 with `communityLibraryCheckRequired`.
   - **Step 2, community library check (do not skip):** call the Figma
     MCP `search_design_system` tool with query `"color"` on the same
     fileKey, collect the distinct `libraryName` values and one sample
     variable key per library, then re-call `mimic_discover_ds` with
     `communitySearchResults` and `communitySearchVariableKeys`. This is
     what unlocks Phase 2. If the tool returns a `_userPrompt` (multiple
     libraries), show it to the user verbatim and wait for their pick.

3. **`mimic_map_components`** with the section-level element types in the
   design (header, footer, sidebar, card, table, badge, button, input,
   etc.). With `FIGMA_TOKEN` configured, one call resolves found
   components and confirmed gaps. Without it, call once, search any
   missing types via Figma MCP `search_design_system`, then call again
   with `librarySearchResults` to confirm gaps. Only after this second
   pass are missing types real gaps you can build as primitives.

4. **Build, component-first.** For every element: does the DS have a
   component for it? If yes, use it even if the layout doesn't match
   exactly, intent over pixel-matching. Shell elements (header, footer,
   sidebar) and common UI patterns (buttons, badges, inputs, table
   cells, tabs, dropdowns, avatars) are never built as raw frames if the
   DS has them; the plugin gate blocks it. Only fall back to
   `figma_create_frame` for something with no DS equivalent, and even
   then bind every fill, stroke, spacing, and radius to a DS variable:
   raw hex, raw px, and non-DS fonts get rejected, not silently allowed.
   After every `figma_insert_component`, read `configurationChecklist`
   and do all of it: re-enable booleans the HTML shows (labels count as
   booleans), set variants, override every text node, set
   `layoutSizingHorizontal: FILL` by default.

5. **Batch instead of looping one call per node:**
   - All text overrides on one component instance:
     `figma_batch_set_component_text`, not repeated
     `figma_set_component_text` calls.
   - Any data table: `mimic_build_table` (headers, cells, variants, text
     in one call), not cell-by-cell construction.
   - Any chart: `mimic_build_chart` (bar/line/donut/radar, fully bound to
     DS color variables), not hand-built SVG or manual geometry.

6. **Content fidelity is non-negotiable.** Every label, heading, value,
   and CTA in Figma must match the HTML/prompt source exactly. Never
   paraphrase, shorten, or "improve" copy.

7. **End every build with `mimic_generate_build_report`**, before
   replying to the user, and then present its sections in the
   conversation (components used, primitives + justification, DS
   changes/staleness, recommendations, binding quality, rule
   compliance). A build without a visible report is incomplete: the
   report is the tool's differentiator, not an optional extra.

## Hard rules, no exceptions

- **Never fall back to other Figma tools mid-build.** If a tool response
  says `PLUGIN_DISCONNECTED` or `BUILD_INTERRUPTED`, stop building
  entirely and tell the user the plugin disconnected. Do not reach for
  the official Figma MCP, `use_figma`, or any other Figma-writing tool as
  a substitute: those bypass DS enforcement completely and produce
  output with no components, no bindings, and no text styles. Wait for
  reconnection, call `mimic_status` to confirm the session is clear, and
  resume where the build left off.
- **`bindingFailures: true` means stop, not continue.** Fix the variable
  path (`figma_read_variable_values` shows what's actually cached) before
  the next operation.
- **Feedback iterates the existing artboard.** Never delete an artboard
  to "start over."
- **A user correction repeated twice is a rule, not a one-off.** Offer to
  save it via `mimic_ai_knowledge_write` (`type: "rule"`) so it applies
  to every future build automatically.
