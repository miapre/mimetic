<p align="center">
  <img src="assets/logo.svg" alt="Mimic AI" width="120">
</p>

# Mimic AI

**Production-ready Figma from your design system. Describe it, build it, ship it.**

Tell Mimic what you need. It builds it in Figma using your actual design system: real components, real tokens, real auto-layout. Give it HTML, a prompt, or a Stitch export. The output uses your DS for everything.

After every build, it tells you what your design system is missing.

---

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js: v20.6+](https://img.shields.io/badge/node-%3E%3D20.6-brightgreen)
![Platform: macOS / Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
[![Glama](https://glama.ai/mcp/servers/@miapre/mimic-ai/badge)](https://glama.ai/mcp/servers/@miapre/mimic-ai)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_MCP-0078d4?logo=visualstudiocode&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22mimic-ai%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40miapre%2Fmimic-ai%22%5D%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_MCP-24bfa5?logo=visualstudiocode&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22mimic-ai%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40miapre%2Fmimic-ai%22%5D%7D)

> Open-source MCP server. Runs locally. Your design data never leaves your machine.

---

<!-- TODO: GIF showing prompt → Figma build with DS components -->

---

## Why Mimic exists

You built a design system. Every token, every component, every variable. Intentional.

Then someone needs a screen and builds it from scratch. Your system sits in the library panel. Unused.

AI tools make it worse. Claude Design generates prototypes you have to rebuild in Figma. Figma Make generates interactive demos with raw CSS values instead of your actual components. The cleanup takes as long as building it yourself.

Mimic is different. The output is the deliverable: real Figma layers with your published components, your variable bindings, your auto-layout. Nothing to convert. Nothing to swap. Hand it off.

---

## How it works

Describe what you need:

> "Dashboard with three metric cards, an activity table, and a status filter"

Or give it HTML from any source: your codebase, a Stitch export, a Claude Design prototype, a hand-written mockup.

Mimic discovers your design system, matches components and tokens, and builds structured Figma that uses your DS for everything. Same system, same rules, regardless of input.

---

## How Mimic compares

|  | Claude Design | Figma Make | Mimic |
|---|---|---|---|
| **Output** | HTML / React prototype | Interactive prototype | Figma canvas (real layers) |
| **Uses your Figma components** | No, infers from code | Partial, Make Kits (CSS subset) | Yes, real instances from your library |
| **Variable bindings** | No | No (raw values) | Yes, every node |
| **Auto-layout** | N/A | N/A | Every frame |
| **Works with any Figma library** | No | Only via Make Kits | Yes, any enabled library |
| **Learns across builds** | No | No | Yes, patterns, recipes, gap tracking |
| **DS audit after build** | No | No | Yes, every build |
| **Output ready for hand-off** | No, needs Figma conversion | No, needs component swap | Yes |

Claude Design is great for ideation. Figma Make is great for interactive prototyping. Mimic is for when the output needs to be the actual Figma file your team ships with.

---

## It learns your system

The first build scans your design system.

By the third, recurring components auto-verify. Patterns lock in. Corrections become permanent rules.

**Correct it once.** Tell Mimic: "That's not the right Badge, use Tag/Neutral." The mapping updates permanently. Every future build uses it.

**Your DS evolves. Mimic keeps up.** New components, renamed tokens, updated variants, all detected at the start of every build.

**Every build is a DS review.** After each build, Mimic reports:
- What components were used
- What was built from primitives and why
- What patterns it learned
- What your design system is missing

Recommendations come as questions, backed by evidence:
"Should your DS include a Status Badge? Used 31 times as primitives across 5 builds."

---

## What changes after 10 builds

- You stop rebuilding screens by hand
- Your team uses the same component patterns automatically
- Design system gaps become visible, with evidence
- New team members produce consistent output from day one

Mimic becomes the system that remembers how your team builds.

---

## Make your design system AI-ready

Tools like Figma Make, Stitch, and generative UI depend on well-structured design systems: clear component roles, consistent tokens, meaningful descriptions.

Most design systems aren't there yet.

Mimic helps you get there as a side effect of using it.

**Component descriptions from usage.** Mimic observes how components are used across builds and suggests real descriptions based on actual patterns.

**DESIGN.md generation.** Generate a structured file describing your design system, readable by AI tools and frameworks.

Better structure leads to better output across every AI tool you use.

---

## Works with any design system

| Design system type | What Mimic does |
|---|---|
| **Team library** (components + tokens) | Full usage: components, variables, text styles |
| **Team library** (components + typography variables) | Full usage: typography variables bound via setBoundVariable |
| **Team library** (components only) | Uses components, flags missing tokens, recommends adding them |
| **Community libraries** | Full support via REST API key discovery |

Enforcement adapts to what your DS provides. A library with text styles but no color variables enforces text styles and accepts raw colors. The build report shows what's missing and what adding it would unlock.

---

## Get started

> [Node.js](https://nodejs.org/) v20.6+, [Figma desktop](https://www.figma.com/downloads/), Professional plan or above.

### 1. Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/miapre/mimic-ai/main/install.sh)
```

### 2. Add the Figma plugin

**Plugins > Development > Import plugin from manifest** > select `~/mimic-ai/plugin/manifest.json`

### 3. Connect (each session)

Figma: **Plugins > Development > Mimic AI > Run**

The bridge starts automatically when you make your first tool call. No separate process to manage.

### 4. Enable your design system

Assets panel > Team library icon > toggle on. Once per file. Community libraries work out of the box.

### 5. Build

> *"Build a settings page with three form fields and a save button. Use my design system."*

One call discovers your entire DS (variables, styles, components), preloads everything, and advances to build-ready. No multi-step setup.

---

## What gets checked automatically

Every build enforces 13 quality rules across 6 sequential phases. You don't configure them. They just run.

- Text uses your text styles, not raw font properties
- Colors bound to your variables, not hardcoded
- Spacing bound to your tokens where available
- Every frame uses auto-layout, resizable, not static
- Content matches the source exactly, nothing invented
- Your components used wherever a match exists
- Variable paths validated with suggestions before reaching the plugin
- Binding feedback on every operation: you see exactly what succeeded
- Circuit breaker stops runaway builds after 3 consecutive failures
- Charts built with deterministic geometry and DS tokens
- Components fully configured: text overrides, semantic properties, icon slots
- Build report with learning summary, component usage %, and DS gap recommendations

The result is what you'd build manually, without the time cost.

Full specification: [`CLAUDE.md`](CLAUDE.md)

---

## MCP client setup

Works with any MCP client. Optimized for **Claude Code**.

<details>
<summary><strong>Claude Code</strong></summary>

```json
{
  "mcpServers": {
    "mimic-ai": {
      "command": "npx",
      "args": ["-y", "@miapre/mimic-ai"]
    }
  }
}
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mimic-ai": {
      "command": "npx",
      "args": ["-y", "@miapre/mimic-ai"]
    }
  }
}
```

</details>

<details>
<summary><strong>VS Code</strong></summary>

Click the install badge above, or add to settings:

```json
{
  "mcp": {
    "servers": {
      "mimic-ai": {
        "command": "npx",
        "args": ["-y", "@miapre/mimic-ai"]
          }
    }
  }
}
```

</details>

<details>
<summary><strong>Windsurf / JetBrains</strong></summary>

Windsurf: `~/.codeium/windsurf/mcp_config.json`
JetBrains: Settings > Tools > AI Assistant > MCP Servers

```json
{
  "mcpServers": {
    "mimic-ai": {
      "command": "npx",
      "args": ["-y", "@miapre/mimic-ai"]
    }
  }
}
```

</details>

All clients need the Figma plugin active. The bridge is embedded and starts automatically.

---

<details>
<summary><strong>How it works</strong></summary>

```
MCP Client (Claude Code, Cursor, VS Code)
    |
    | MCP Protocol (stdio)
    v
MCP Server (intelligence layer)
    - Tool registry, DS cache, knowledge store
    - Variable validation + suggestions before plugin
    - Circuit breaker (3 failures -> stop + report)
    - Chart geometry engine (Node.js)
    - Phase enforcement (6 sequential phases)
    |
    | Embedded WebSocket bridge (auto-starts)
    v
Figma Plugin (enforcement gate)
    - DS enforcement: rejects raw values when DS has tokens
    - Binding feedback: reports which bindings succeeded/failed
    - Thin handlers: mechanical operations only
    |
    v
Figma Plugin API > Canvas
```

Intelligence flows down. Binding feedback flows up. The MCP layer validates variable paths before reaching the plugin. The plugin reports exactly which DS bindings succeeded and which failed. Tool responses carry contextual hints so the LLM always knows what to do next.

- **Building is unlimited.** Frames, components, and token bindings have no rate limit.
- **Inspecting is limited.** Reading your library uses Figma's daily quota. Mimic caches aggressively to stay well under.
- **Token bindings are real.** Update a variable in your DS, re-publish, and every node updates automatically.
- **Auto-layout everywhere.** Every frame resizes correctly. Nothing is manually positioned.

</details>

<details>
<summary><strong>53 tools available</strong></summary>

**Status and learning:** `mimic_status`, `mimic_discover_ds`, `mimic_ai_knowledge_read`, `mimic_ai_knowledge_write`, `mimic_generate_build_report`, `mimic_generate_design_md`

**DS setup:** `figma_preload_styles`, `figma_preload_variables`, `figma_discover_library_styles`, `figma_discover_library_variables`, `figma_discover_library_components`, `figma_set_session_defaults`, `figma_list_text_styles`, `figma_read_variable_values`, `mimic_map_components`

**Build:** `figma_create_frame`, `figma_create_text`, `figma_create_rectangle`, `figma_create_ellipse`, `figma_create_svg`, `figma_insert_component`, `figma_batch`

**Edit:** `figma_set_component_text`, `figma_set_component_text_by_id`, `figma_set_text`, `figma_set_text_style`, `figma_set_node_fill`, `figma_set_node_position`, `figma_set_layout_sizing`, `figma_set_variant`, `figma_set_visibility`, `figma_set_variable_mode`, `figma_set_all_variable_modes`, `figma_swap_main_component`, `figma_replace_component`, `figma_restyle_artboard`, `figma_move_node`, `figma_delete_node`

**Inspect and QA:** `figma_get_node_props`, `figma_get_node_children`, `figma_get_node_parent`, `figma_get_text_info`, `figma_get_component_variants`, `figma_get_selection`, `figma_select_node`, `figma_get_page_nodes`, `figma_get_pages`, `figma_change_page`, `figma_validate_ds_compliance`, `mimic_find_node`

**Rendering and charts:** `mimic_pipeline_resolve`, `mimic_render_url`, `mimic_compute_chart`

</details>

<details>
<summary><strong>Figma setup details</strong></summary>

**Desktop app required.** Browser Figma won't work. [Download](https://www.figma.com/downloads/)

**Personal Access Token.** Figma > Profile > Settings > Security > Personal access tokens > Generate new token. Name: "Mimic AI", expiration: 90 days. Check five scopes: `current_user:read`, `file_content:read`, `file_metadata:read`, `library_assets:read`, `library_content:read`. All read-only. Mimic never writes to your library. Copy the token immediately.

**Publish your DS.** Components and tokens in a separate file, published as a team library. Re-publish after changes.

**Professional plan or above.** Free plan can't publish libraries.

</details>

---

## How Mimic learns

Every build teaches Mimic about your design system.

- **Component recipes:** After you configure a component once (variants, booleans, text slots), Mimic replays that configuration automatically on future inserts
- **Layout patterns:** Frame configs (direction, padding, gap, fills) are captured from your first build and reused when the same pattern appears again
- **Text batch optimization:** All text overrides on a component instance are set in a single call instead of one-by-one
- **Bulk table builder:** An entire data table (headers + cells + variants + text) in a single call instead of inserting cells one by one
- **DS gap tracking:** Patterns built as primitives are tracked across builds. Mimic surfaces recommendations backed by evidence ("Status Badge used 31 times as primitives across 5 builds")

Every build report includes component usage stats, binding quality, and DS gap recommendations.

---

## Privacy

Everything runs locally.

No design data leaves your machine.
No telemetry.
No tracking.

The only outbound call is to the Figma REST API for published component keys.

---

## Constraints

- **Figma Professional plan required.** Free plan can't publish libraries.
- **First-build font caching.** Non-Inter DS fonts may fail on the first text node. Retry succeeds.
- **npx mode.** Doesn't set `FIGMA_ACCESS_TOKEN`. Use the full installer for team library support.
- **Graduated DS enforcement.** Adapts to what your DS provides. A component-only library gets components; raw values fill the gaps. The report shows what to add.
- **Claude-optimized.** The 6-phase protocol and contextual tool hints work best with Claude Code. Other MCP clients get the tools but may not follow the full protocol.

---

## License

MIT
