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

*Demo coming soon — a screen recording showing DS components being inserted in real time and the learning summary at the end.*

---

## Works with any design system

Team libraries, community libraries, component-only kits — Mimic adapts to what your DS provides.

| DS configuration | What works |
|---|---|
| **Team library with components + tokens** | Full support. Components, text styles, color/spacing/radius variables all bind correctly. |
| **Team library with components only** | Components used. Text, colors, spacing fall back to raw values. Build report recommends adding tokens. |
| **Community library** (Material UI, HeroUI, iOS, etc.) | Full support. Components and text styles import normally. Variables use key-based import — Mimic discovers keys via the Figma REST API and imports them directly. |
| **No library enabled** | Blocked. Mimic requires a published library enabled in the target file. |

Verified with: LayerLens Theme (team), Material UI for Figma (community), HeroUI Figma Kit (community).

---

## How it learns

Mimic keeps a local file (`ds-knowledge.json`) that records how HTML patterns map to your design system components. Each build loads what it knows, uses the cache, and saves what it discovered.

| Build | What happens | DS lookups |
|---|---|---|
| **1st** | Scans your library for matching components. Caches every mapping it finds. | Depends on DS size and screen complexity |
| **3rd** | Patterns used 3 times without correction are promoted to VERIFIED — skipped on future builds. | Fewer — verified patterns skip lookup |
| **10th+** | Most patterns verified. Variable IDs cached. Builds are nearly instant. | New patterns only |

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
2. Go to **Plugins → Development → Import plugin from manifest...**
3. Find the `mimic-ai` folder the script just created (usually in your home folder: `~/mimic-ai/plugin/`) and select `manifest.json`
4. The plugin now appears under **Plugins → Development → Mimic AI**

### Step 3 — Start Mimic (do this each session)

Open a terminal and paste this:

```bash
cd ~/mimic-ai && npm run bridge
```

Keep this terminal window open — it's the connection between your AI assistant and Figma.

Then in **Figma desktop:** go to **Plugins → Development → Mimic AI → Run**. You'll see a small badge that says **● ready** — that means the connection is live.

**Verify the connection.** Ask your AI assistant: *"Check mimic status."* You should see bridge connected, plugin connected, and your DS libraries listed. If anything is missing, fix it before building.

### Step 4 — Enable your design system

Open the Figma file where you want to build. Then:

1. Click the **book icon** in the left sidebar (Assets panel)
2. Click the **library icon** at the top (looks like a grid of squares)
3. Find your design system in the list and **toggle it on**

You only need to do this once per file. Without it, Mimic can't find your components.

> **Using a community library?** Community libraries (Material UI, HeroUI, iOS kits, etc.) work out of the box. Enable the library in your file and Mimic handles the rest — components import normally, and variables are discovered via the Figma REST API and imported by key. No need to duplicate or re-publish.

### You're ready

Ask your AI assistant to build something. Include a Figma link to the file and page, or describe where you want the output.

---

## Works with any MCP client

Mimic uses MCP (Model Context Protocol), the open standard that connects AI assistants to external tools. The build protocol, voice, and learning pipeline are optimized for **Claude Code** — other MCP clients can create and edit Figma, but may not follow the full governance lifecycle or produce learning reports. Add it to your client's config:

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

**CSS maps to Figma auto-layout.** Mimic reads the HTML's CSS properties and translates them directly: `display: flex` → auto-layout, `gap` → itemSpacing bound to DS spacing variables, `max-width + margin: auto` → FILL + maxWidth + parent CENTER, `align-items: flex-end` → counterAxisAlignItems MAX. The CSS→Figma reference table in `CLAUDE.md` documents every mapping.

---

## Quality built in — not bolted on

Every build is checked by 6 specialist roles before it's reported as done. A 7th role (Marketing & Communications) ensures public documentation stays current. You don't invoke them — they run automatically.

| Role | What it checks | When |
|---|---|---|
| **Platform Architect** | Target confirmed, DS mode set, artboard at 1440px FIXED. Release management. | Phase 0 |
| **DS Integration Engineer** | Every element mapped to a DS component. Variables imported (including community library key-based import). | Phase 1-2 |
| **Build Engineer** | Every frame uses auto-layout. Every text node uses DS style. Every color uses DS variable. CSS layout translated faithfully. | Phase 3 |
| **Design QA** | Content matches HTML exactly. No raw values. Charts render correctly. | Phase 4 |
| **Learning Engineer** | Patterns saved. Gaps tracked. Build report generated. | Phase 5 |
| **Product QA** | Report uses designer vocabulary. Gap recommendations are questions, not commands. Save-report offer. | Phase 5 |

**How it works without costing you tokens:**

1. **Plugin-level enforcement (free)** — The Figma plugin automatically hides icon placeholders, sets auto-layout defaults, and rejects raw values in strict mode. Zero tool calls, zero tokens. It just happens.

2. **Inline warnings (free)** — Every tool response includes warnings if something isn't DS-compliant: "Text created without DS text style," "Frame fill is raw hex." These are in responses you'd already see — no extra calls.

3. **Build completion audit (1 call)** — At the end of the build, one audit checks everything: DS compliance, content fidelity, learning pipeline. If anything fails, it gets fixed before you see "Build complete."

The result: 46 rules enforced, 0 extra tool calls for enforcement.

Full specification: [`GOLDEN_RULES.md`](GOLDEN_RULES.md), [`ROLES.md`](ROLES.md), [`VOICE_AND_TONE.md`](VOICE_AND_TONE.md).

---

## Available tools

<details>
<summary><strong>Status & Learning</strong></summary>

| Tool | What it does |
|---|---|
| `mimic_status` | Check readiness: bridge, plugin connection, DS knowledge, pattern counts, DS gaps |
| `mimic_discover_ds` | Extract and normalize a DS from a Figma library file (components, styles, variables) |
| `mimic_ai_knowledge_read` | Load cached pattern→component mappings. VERIFIED entries skip DS lookup. |
| `mimic_ai_knowledge_write` | Persist mappings. Auto-promotes CANDIDATE→VERIFIED at 3 consistent uses. |

</details>

<details>
<summary><strong>DS Setup</strong></summary>

| Tool | What it does |
|---|---|
| `figma_preload_styles` | Batch import DS text and color styles into plugin cache |
| `figma_preload_variables` | Batch import DS variables — supports key-based import for community libraries |
| `figma_set_session_defaults` | Set default text fill (style or variable), font family, DS enforcement mode |
| `figma_list_text_styles` | List all text styles with IDs for use in text creation |
| `figma_read_variable_values` | Read resolved values of all variables (colors as hex, spacing as numbers) |

</details>

<details>
<summary><strong>Build</strong></summary>

| Tool | What it does |
|---|---|
| `figma_create_frame` | Auto-layout frame with DS spacing, radius, fill variables. Supports maxWidth. |
| `figma_create_text` | Text node bound to DS text style and color variable |
| `figma_create_rectangle` | Rectangle with DS fill/stroke |
| `figma_create_chart` | Chart (scatter, line, donut, bar) — bars distribute evenly, donut legend auto-layout |
| `figma_insert_component` | Published library component by key (team or community) |
| `figma_batch` | Multiple operations in one round trip |

</details>

<details>
<summary><strong>Edit</strong></summary>

| Tool | What it does |
|---|---|
| `figma_set_component_text` | Text property on a component instance |
| `figma_set_text` | Text on a nested TEXT node by ID |
| `figma_set_node_fill` | DS color variable on any node |
| `figma_set_layout_sizing` | Sizing, alignment, padding, maxWidth, minWidth |
| `figma_set_variant` | VARIANT or BOOLEAN component property |
| `figma_set_visibility` | Show/hide a node |
| `figma_swap_main_component` | Swap instance to a different variant |
| `figma_replace_component` | Replace node with new component |
| `figma_move_node` | Reorder within parent |
| `figma_delete_node` | Delete a node |

</details>

<details>
<summary><strong>Inspect & QA</strong></summary>

| Tool | What it does |
|---|---|
| `figma_get_node_props` | Component properties and text layers |
| `figma_get_node_children` | Direct children |
| `figma_get_node_parent` | Parent and siblings |
| `figma_get_text_info` | DS text style ID and color variable |
| `figma_get_component_variants` | All variant options in a component set |
| `figma_get_selection` | Selected node IDs and dimensions |
| `figma_select_node` | Select and zoom to a node |
| `figma_get_page_nodes` | Top-level nodes on current page |
| `figma_get_pages` | All pages in document |
| `figma_change_page` | Switch page |
| `figma_validate_ds_compliance` | Post-build audit: flags raw fills, raw text, raw spacing, fixed sizing |

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
  learning/         — Build completion, knowledge persistence
  parsing/          — HTML parsing

CLAUDE.md           — Build protocol, CSS→Figma mapping, phased lifecycle
GOLDEN_RULES.md     — 46 rules governing every build
ROLES.md            — 6 roles operating as build gates
VOICE_AND_TONE.md   — Identity, voice principles, output formats
KNOWN_ISSUES.md     — Compatibility matrix and limitations
CHANGELOG.md        — Version history
docs/
  GUIDE.md          — Full setup guide, DS structure, build patterns
  knowledge-schema.md — Knowledge file schema reference
```

---

## Privacy

Runs entirely on your machine. No design data, component names, token values, or HTML content is sent to any external server. The only outbound call is to the Figma REST API to look up published component keys — the same call Figma's own plugins make.

---

## Troubleshooting

**"Figma plugin is not connected"** → Open Figma desktop → Plugins → Development → Mimic AI → Run. The plugin runs per file — if you switch to a different Figma file, you need to run the plugin again in that file.

**"Library import failed"** → Your design system isn't enabled in the target file. Open the Assets panel → Team library → toggle it on.

**"No component key"** → The component isn't published. Open your DS file → Assets → Team library → Publish.

**"DS_VARIABLE_NOT_FOUND"** → The variable path doesn't match what's in the DS. Run `mimic_discover_ds` to refresh the DS inventory, or check variable naming with `figma_read_variable_values`.

**Plugin code changes not taking effect** → The Figma plugin loads `code.js` once at startup. Close and reopen the plugin in Figma to load updated code.

---

## Known constraints

- **Figma Professional plan required.** The free plan can't publish component libraries, which Mimic needs to import your DS components.
- **First-build font caching.** If text styles don't apply on the very first build, it's because Figma hasn't cached the font data yet. Re-run the build — the second attempt will succeed.
- **npx mode doesn't support library imports.** The one-click `npx -y @miapre/mimic-ai` install doesn't set a `FIGMA_ACCESS_TOKEN`, which is needed for importing components from team libraries. Use the full installer script for team library support.
- **Governance is Claude-optimized.** The 46 rules, phased lifecycle, and learning reports are followed by Claude Code. Other MCP clients will have the tools but may not follow the protocol unless their LLM is instructed to read `CLAUDE.md`.
- **Chart geometry uses absolute positioning.** Donut arcs, scatter dots, and line paths use pixel calculations. Everything else in charts (bars, labels, legends, containers) uses auto-layout and DS tokens.

---

## License

MIT
