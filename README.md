# Mimic AI

**The reviewer for your design system — builds in Figma, learns your conventions, flags your gaps.**

Mimic translates HTML into Figma using your published components and tokens. It gets smarter about your DS over time: corrections become rules, repeated patterns auto-verify, and every build reports what your system is missing. Runs locally. Your design data never leaves your machine.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js: v20.6+](https://img.shields.io/badge/node-%3E%3D20.6-brightgreen)
![Platform: macOS / Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
[![Glama](https://glama.ai/mcp/servers/@miapre/mimic-ai/badge)](https://glama.ai/mcp/servers/@miapre/mimic-ai)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_MCP-0078d4?logo=visualstudiocode&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22mimic-ai%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40miapre%2Fmimic-ai%22%5D%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_MCP-24bfa5?logo=visualstudiocode&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22mimic-ai%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40miapre%2Fmimic-ai%22%5D%7D)

> **Not a Figma product.** Independent, open-source MCP server. Works with any MCP client — Claude Code, Cursor, VS Code, Windsurf, JetBrains.

---

<!-- TODO: Demo GIF — screen recording of a real build, ~30–60s, showing DS components being inserted and the learning summary at the end. -->

---

## How it learns

Mimic keeps a local file (`ds-knowledge.json`) that records how HTML patterns map to your design system components. Each build loads what it knows, uses the cache, and saves what it discovered.

| Build | What happens | DS lookups |
|---|---|---|
| **1st** | Scans your library for matching components. Caches every mapping it finds. | 3–5 |
| **3rd** | Patterns used 3 times without correction are promoted to VERIFIED — no more lookups for those. | 1–2 |
| **10th+** | Everything verified. Variable IDs cached. Builds are nearly free. | 0–1 |

**Your corrections teach it.** If Mimic picks the wrong component, tell it: *"That's wrong — use Button/Primary, and remember it."* The mapping updates immediately and applies on every future build.

**Your DS evolves, Mimic notices.** New components, removed components, variant changes — detected at the start of every build. Stale cache entries are invalidated and re-discovered from the live DS. The design system is always the source of truth, never the cache.

**Every build reports what it learned.** Patterns saved, patterns promoted, searches skipped, and gaps detected. Gap reports surface what your DS is missing — Mimic doubles as a design system audit tool.

**The knowledge is yours.** Inspectable JSON on your machine. Nothing is sent anywhere. Share the file with your team if you want everyone to start with the same learned mappings.

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

> **Before you begin:** You need [Node.js](https://nodejs.org/) v20.6 or later, the [Figma desktop app](https://www.figma.com/downloads/) (the browser version won't work), and a **Figma Professional plan or above** (the free plan can't publish component libraries, which Mimic needs).

### Step 1 — Install Mimic

Open a terminal (on Mac: search for "Terminal" in Spotlight) and paste this command:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/miapre/mimic-ai/main/install.sh)
```

The script downloads Mimic, installs what it needs, asks for your Figma token, and registers the tool. It takes about a minute.

### Step 2 — Install the Figma plugin

1. Open **Figma desktop**
2. Go to **Plugins → Development → Import plugin from manifest…**
3. Find the `mimic-ai` folder the script just created (usually in your home folder: `~/mimic-ai/plugin/`) and select `manifest.json`
4. The plugin now appears under **Plugins → Development → Mimic AI**

### Step 3 — Start Mimic (do this each session)

Open a terminal and paste this:

```bash
cd ~/mimic-ai && npm run bridge
```

Keep this terminal window open — it's the connection between your AI assistant and Figma.

Then in **Figma desktop:** go to **Plugins → Development → Mimic AI → Run**. You'll see a small badge that says **● ready** — that means the connection is live.

### Step 4 — Enable your design system

Open the Figma file where you want to build. Then:

1. Click the **book icon** in the left sidebar (Assets panel)
2. Click the **library icon** at the top (looks like a grid of squares)
3. Find your design system in the list and **toggle it on**

You only need to do this once per file. Without it, Mimic can't find your components.

### You're ready

Ask your AI assistant to build something. Include a Figma link to the file and page, or describe where you want the output.

---

## Works with any MCP client

Mimic uses MCP (Model Context Protocol), the open standard that connects AI assistants to external tools. Add it to your client's config:

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

Click the VS Code install badge at the top of this README, or add to your VS Code settings:

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

Regardless of which client you use, you still need the bridge running (Step 3) and the Figma plugin active. The config above just tells your AI assistant where to find Mimic's tools.

---

<details>
<summary><strong>Figma setup details</strong></summary>

### Desktop app required
The browser version of Figma won't work — the bridge connects to the plugin over a local network connection that only the desktop app supports. [Download Figma desktop](https://www.figma.com/downloads/)

### Personal Access Token
The bridge needs a Figma token to look up your published component keys. Think of it as a password that lets Mimic read (not write) your library metadata.

1. Open Figma desktop → click your **profile picture** (top-left) → **Settings**
2. Scroll to **Personal access tokens** → **Generate new token**
3. Name it something like `mimic-ai`, set read access
4. **Copy the token immediately** — Figma only shows it once
5. Paste it when the install script asks

### Publish your design system
Your components and tokens need to be in a **separate Figma file**, published as a team library. If you haven't done this:

1. Open your design system file
2. Click the **book icon** → **library icon** → **Publish**

Re-publish after adding or updating components — otherwise Mimic won't see the changes.

### Enable the library in your target file
Publishing makes the library available to your team. Enabling makes it usable in a specific file. You only need to do this once per file: Assets panel → Team library icon → toggle your DS on.

### Figma plan
Publishing component libraries and using design tokens (variables) requires a **Professional plan or above**. The free plan lets Mimic create basic frames and text, but it can't insert components or bind tokens — which is the whole point.

</details>

---

## How it works

```
Your AI assistant → Mimic MCP server → Bridge → Figma Plugin → Your Figma file
```

**Writes are unlimited.** Every frame Mimic creates, every component it inserts, every token it binds — these go through Figma's plugin channel, which has no rate limit.

**Reads are limited.** Inspecting library components and reading design context draw from a daily quota (200 on Professional, 600 on Enterprise). Mimic minimizes reads, caches aggressively, and stops if the budget would be exceeded mid-build.

All token bindings are real — nodes use your actual design system variables. Update a token in your library, re-publish, and the Figma nodes update automatically.

---

## Governance

Every build follows 6 phases, each owned by a role that acts as a quality gate. 34 rules govern every decision.

| Phase | Owner | Gate |
|---|---|---|
| **0. Target** | Platform Architect | File, page, artboard placement confirmed |
| **1. Discovery** | DS Integration Engineer | Component map: every HTML element → DS component or primitive with reason |
| **2. Inventory** | DS Integration Engineer | All text styles, color variables, spacing tokens imported |
| **3. Build** | Build Engineer | Per-node: auto-layout, DS text style, DS color variable, DS spacing variable, component fully configured |
| **4. QA** | Design QA | Screenshot comparison, content fidelity, no placeholder text, no raw values |
| **5. Report** | Learning Engineer + Product QA | Build report, patterns learned, DS gaps, provenance |

Full specification: [`GOLDEN_RULES.md`](GOLDEN_RULES.md), [`ROLES.md`](ROLES.md), [`VOICE_AND_TONE.md`](VOICE_AND_TONE.md).

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
mcp.js              — MCP server, exposes tools to your AI assistant
bridge.js           — Local bridge between the MCP server and Figma plugin
plugin/
  code.js           — Figma plugin (runs inside Figma's sandbox)
  ui.html           — Plugin UI and connection indicator
  manifest.json     — Plugin manifest

internal/
  rendering/        — URL rendering, input resolution
  resolution/       — Component matching, icon resolution
  layout/           — Layout tree builder, direction detection
  learning/         — Build reports, knowledge persistence
  parsing/          — HTML parsing
  ds-knowledge/     — DS inventory extraction

CLAUDE.md           — Build protocol and phased lifecycle
GOLDEN_RULES.md     — 34 rules governing every build
ROLES.md            — 6 roles operating as build gates
VOICE_AND_TONE.md   — Identity, voice principles, output formats
docs/
  GUIDE.md          — Full setup guide, DS structure, build patterns
  knowledge-schema.md — Knowledge file schema reference
```

---

## Privacy

Runs entirely on your machine. No design data, component names, token values, or HTML content is sent to any external server. The only outbound call is to the Figma REST API to look up published component keys — the same call Figma's own plugins make.

---

## Troubleshooting

**"Figma plugin is not connected"** → Open Figma desktop → Plugins → Development → Mimic AI → Run.

**"Library import failed"** → Your design system isn't enabled in the target file. Open the Assets panel → Team library → toggle it on.

**"No component key"** → The component isn't published. Open your DS file → Assets → Team library → Publish.

**"object is not extensible"** → A frame-only property was applied to a text node. See [docs/GUIDE.md](docs/GUIDE.md#troubleshooting) for details.

---

## License

MIT
