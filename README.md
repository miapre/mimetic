# Mimic AI

**The reviewer for your design system — builds in Figma, learns your conventions, flags your gaps.**

Mimic translates HTML into Figma using your published components and tokens. It gets smarter about your DS over time: corrections become rules, repeated patterns auto-verify, and every build reports what your system is missing. Runs locally. Your design data never leaves your machine.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js: v20.6+](https://img.shields.io/badge/node-%3E%3D20.6-brightgreen)
![Platform: macOS / Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
[![Glama](https://glama.ai/mcp/servers/@miapre/mimic-ai/badge)](https://glama.ai/mcp/servers/@miapre/mimic-ai)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_MCP-0078d4?logo=visualstudiocode&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22mimic-ai%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40miapre%2Fmimic-ai%22%5D%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_MCP-24bfa5?logo=visualstudiocode&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22mimic-ai%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40miapre%2Fmimic-ai%22%5D%7D)

> **Not a Figma product.** Independent, open-source MCP server. Works with any MCP client.

---

<!-- TODO: Demo GIF — screen recording of a real build, ~30–60s, showing DS components being inserted and the learning summary at the end. -->

---

## How it learns

Mimic maintains `ds-knowledge.json` — a local file that records how HTML patterns map to your DS components. Every build loads it, uses what's cached, and writes back what it discovered.

| Build | What happens | DS lookups |
|---|---|---|
| **1st** | Inspects library for unknown patterns. Caches every mapping. | 3–5 |
| **3rd** | Patterns used 3× without correction auto-promote to VERIFIED. | 1–2 |
| **10th+** | All patterns verified. Variable IDs cached. Builds are nearly free. | 0–1 |

**Your corrections teach it.** Tell Claude *"That's wrong — use Button/Primary, and remember it."* The mapping updates with high confidence and applies on every future build.

**Your DS evolves, Mimic notices.** New components, removed components, variant changes — detected at the start of every build. Stale cache entries are invalidated and re-discovered from the live DS.

**Every build reports what it learned.** Patterns saved, patterns promoted, DS searches skipped, and gaps detected. Gap reports surface what your DS is missing — Mimic doubles as a DS audit tool.

**The knowledge is yours.** Inspectable JSON on your machine. Nothing is sent anywhere.

---

## What you can do

**Translate an HTML prototype into Figma**

> *"Here's my HTML prototype. Build it in Figma on the 'Screens' page. Use my design system components wherever possible."*

**Build UI from a description**

> *"Build a dashboard with 4 KPI cards, a data table with sortable columns, and a donut chart. Use my top-nav shell and `spacing-xl` gaps."*

**Target specific components and tokens**

> *"Use my Sidebar, Modal/Large, and FormInput components. `surface-secondary` background, `text-secondary` labels."*

---

## Quick start

> **Requires:** Node.js v20.6+, Figma desktop (not browser), Figma Professional plan or above (free plan can't publish libraries or bind variables).

**1. Install:**
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/miapre/mimic-ai/main/install.sh)
```
Clones the repo, installs dependencies, saves your Figma token, registers the MCP.

**2. Install the Figma plugin:**
Figma desktop → Plugins → Development → Import plugin from manifest → select `~/mimic-ai/plugin/manifest.json`

**3. Each session:**
```bash
cd ~/mimic-ai && npm run bridge   # keep open
```
In Figma: Plugins → Development → Mimic AI → Run. Badge shows **● ready**.

**4. Enable your DS library** in the target file:
Assets panel → Team library → toggle your DS **on**.

**Ready.** Ask your AI assistant to build something. Include a Figma link or describe the target.

---

## Works with any MCP client

Mimic speaks standard MCP over stdio. Add it to your client's config:

<details>
<summary><strong>Claude Code</strong></summary>

The install script registers Mimic automatically. Or add manually to `~/.claude/settings.json`:

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

Add to `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` for global):

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
<summary><strong>VS Code (Copilot Chat)</strong></summary>

Click the badge at the top of this README, or add to your VS Code settings:

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
<summary><strong>Windsurf</strong></summary>

Add to `~/.codeium/windsurf/mcp_config.json`:

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
<summary><strong>JetBrains (IntelliJ, WebStorm, etc.)</strong></summary>

Settings → Tools → AI Assistant → MCP Servers → Add:

```json
{
  "mimic-ai": {
    "command": "npx",
    "args": ["-y", "@miapre/mimic-ai"]
  }
}
```

</details>

All clients need the bridge running (`npm run bridge`) and the Figma plugin active. The MCP config just connects your AI assistant to Mimic's tool server.

---

<details>
<summary><strong>Figma setup details</strong></summary>

### Desktop app required
The browser version doesn't work. The bridge connects to the plugin via WebSocket, which requires the desktop app. [Download](https://www.figma.com/downloads/)

### Personal Access Token
The bridge uses this to resolve published component keys via the Figma REST API.

1. Figma desktop → Profile → Settings → Personal access tokens
2. Generate new token (read access is sufficient)
3. Copy immediately — shown only once
4. Paste when the install script asks

### Publish your library
Your DS must be a separate Figma file, published as a library. Assets panel → Team library → Publish. Re-publish after any component updates.

### Enable in target file
Publishing makes the library available. Enabling makes it accessible in a specific file. Assets panel → Team library → toggle on. Once per file.

### Plan requirement
Publishing libraries and using variables requires **Professional plan or above**. The free plan can create frames and text, but not insert components or bind tokens — the core features.

</details>

---

## How it works

```
Claude Code → MCP server (mcp.js) → Bridge (bridge.js) → Figma Plugin → Canvas
```

**Writes are unlimited.** Every frame, component, and token binding uses Figma's plugin channel — no rate limit.

**Reads are limited.** Library inspection and design context draw from a daily quota (200 Professional, 600 Enterprise). Mimic minimizes reads, caches aggressively, and stops if the budget would be exceeded mid-build.

All variable bindings are real. Nodes use your actual design token variables — update a token in your library, re-publish, and the nodes update.

---

## Governance

Every build follows 6 phases — each owned by a role that acts as a quality gate. 34 rules govern every decision.

| Phase | Owner | Gate |
|---|---|---|
| **0. Target** | Platform Architect | File, page, artboard placement confirmed |
| **1. Discovery** | DS Integration Engineer | Component map: every HTML element → DS component or primitive + reason |
| **2. Inventory** | DS Integration Engineer | All text styles, color variables, spacing tokens imported |
| **3. Build** | Build Engineer | Per-node: auto-layout, DS text style, DS color variable, DS spacing variable, component fully configured |
| **4. QA** | Design QA | Screenshot comparison, content fidelity, no placeholder text, no raw values |
| **5. Report** | Learning Engineer + Product QA | Build report, patterns learned, DS gaps, provenance |

See [`GOLDEN_RULES.md`](GOLDEN_RULES.md), [`ROLES.md`](ROLES.md), and [`VOICE_AND_TONE.md`](VOICE_AND_TONE.md).

---

## Available tools

<details>
<summary><strong>Status & Learning</strong></summary>

| Tool | What it does |
|---|---|
| `mimic_status` | Check readiness: bridge, plugin, DS knowledge, pattern counts, DS gaps, catalog freshness |
| `mimic_ai_knowledge_read` | Load cached pattern→component mappings. VERIFIED entries skip DS lookup. |
| `mimic_ai_knowledge_write` | Persist mappings. Auto-promotes CANDIDATE→VERIFIED at 3 consistent uses. |

</details>

<details>
<summary><strong>Build</strong></summary>

| Tool | What it does |
|---|---|
| `figma_create_frame` | Auto-layout frame with DS spacing variables |
| `figma_create_text` | Text node bound to DS text style and color variable |
| `figma_create_rectangle` | Rectangle with DS fill/stroke |
| `figma_create_chart` | Chart (scatter, line, donut, bar) in one call |
| `figma_insert_component` | Published library component by key |
| `figma_batch` | Multiple operations in one round trip |

</details>

<details>
<summary><strong>Edit</strong></summary>

| Tool | What it does |
|---|---|
| `figma_set_component_text` | Text property on a component instance |
| `figma_set_text` | Text on a nested TEXT node by ID |
| `figma_set_node_fill` | DS color variable on any node |
| `figma_set_layout_sizing` | Sizing, alignment, padding, dimensions |
| `figma_set_variant` | VARIANT or BOOLEAN component property |
| `figma_set_visibility` | Show/hide a node |
| `figma_swap_main_component` | Swap instance to a different variant |
| `figma_replace_component` | Replace node with new component |
| `figma_move_node` | Reorder within parent |
| `figma_delete_node` | Delete a node |

</details>

<details>
<summary><strong>Inspect</strong></summary>

| Tool | What it does |
|---|---|
| `figma_get_node_props` | Component properties and text layers |
| `figma_get_node_children` | Direct children |
| `figma_get_node_parent` | Parent and siblings |
| `figma_get_text_info` | DS text style ID and color variable |
| `figma_get_component_variants` | All variant options in a component set |
| `figma_list_text_styles` | All DS text styles with IDs |
| `figma_get_selection` | Selected node IDs and dimensions |
| `figma_select_node` | Select and zoom to a node |
| `figma_get_page_nodes` | Top-level nodes on current page |
| `figma_get_pages` | All pages in document |
| `figma_change_page` | Switch page |

</details>

---

## Project structure

```
mcp.js              — MCP server, exposes tools to Claude
bridge.js           — HTTP/WebSocket bridge to Figma plugin
plugin/
  code.js           — Figma plugin sandbox
  ui.html           — Plugin UI, WebSocket relay
  manifest.json     — Plugin manifest

internal/
  rendering/        — URL rendering, input resolution
  resolution/       — Component matching, icon resolution
  layout/           — Layout tree builder, direction detection
  learning/         — Build reports, knowledge persistence
  parsing/          — HTML parsing
  ds-knowledge/     — DS inventory extraction

CLAUDE.md           — Build protocol, phased lifecycle
GOLDEN_RULES.md     — 34 rules governing every build
ROLES.md            — 6 roles operating as build gates
VOICE_AND_TONE.md   — Identity, voice principles, output formats
docs/
  GUIDE.md          — Setup guide, DS structure, build patterns
  knowledge-schema.md — Knowledge file schema reference
```

---

## Privacy

Runs entirely on your machine. No design data, component names, token values, or HTML content is sent to any external server. The only outbound call is to the Figma REST API to resolve published component keys — the same call Figma's own plugins make.

---

## Troubleshooting

**"Figma plugin is not connected"** → Figma desktop → Plugins → Development → Mimic AI → Run.

**"Library import failed"** → DS library not enabled in target file. Assets → Team library → toggle on.

**"No component key"** → Component not published. DS file → Assets → Team library → Publish.

**"object is not extensible"** → Frame-only property on a text node. See [docs/GUIDE.md](docs/GUIDE.md#troubleshooting).

---

## License

MIT
