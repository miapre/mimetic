# Mimic AI

**An MCP that learns your design system.**

Mimic AI translates HTML into Figma using your published components and design tokens. But the conversion is just the starting point — every run teaches Mimic AI your DS vocabulary. By run 10, familiar patterns resolve instantly with near-zero library lookups. Your corrections teach it too.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js: v20.6+](https://img.shields.io/badge/node-%3E%3D20.6-brightgreen)
![Platform: macOS / Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
[![Glama](https://glama.ai/mcp/servers/badge)](https://glama.ai/mcp/servers/mimic-ai)

> **Not a Figma product.** This is an independent, open-source MCP server built for Claude Code.

---

## How it learns

Mimic AI maintains a local knowledge file — `ds-knowledge.json` — that records how HTML patterns map to your DS components. Every run reads from it before doing any library inspection, and writes back what it used.

| Run | What happens |
|---|---|
| Run 1 | Mimic AI inspects your library to resolve each pattern. Saves every successful mapping as a CANDIDATE. |
| Run 3 | Patterns used consistently 3 times with no corrections are promoted to VERIFIED. No DS lookup needed for those. |
| Run 10+ | Familiar patterns resolve instantly. DS calls are reserved for genuinely new patterns. |

**The knowledge file is yours.** It lives on your machine, travels with your project, and is fully inspectable JSON. Nothing is sent anywhere.

**Your corrections teach Mimic AI.** If you change a component Mimic AI placed — and tell it — the mapping is demoted and re-evaluated. The system adjusts.

**Your DS evolves and Mimic AI notices.** When a new component is added that's a better match for an existing mapping, Mimic AI flags it in the run report. It never auto-switches — you decide.

---

## Why this matters

Other HTML-to-Figma tools are stateless. Every run starts from scratch: inspect library, resolve patterns, build, done. The work done on run 1 doesn't help run 50.

Mimic AI compounds. The longer you use it against the same design system, the less work each run requires, and the more consistent the output becomes. It converges on your DS vocabulary instead of re-discovering it every time.

This is the part that can't be replicated by a generic write-back tool. The knowledge belongs to your team's specific DS, your specific naming conventions, and your specific corrections over time.

---

## What you can do

### Translate an HTML prototype into Figma

Have an existing HTML file — a prototype, a coded mockup, a landing page? Mimic AI reads it and recreates it inside Figma using your design system instead of hardcoded values.

> *"Here's an HTML file I built as a prototype. Translate it into Figma on the 'Prototypes' page, artboard 'Onboarding v2'. Use my design system components wherever possible — match the layout, hierarchy, and content."*

### Build UI from a description

Describe a screen and Claude builds it in Figma — section by section, using your actual published components and design token variables.

> *"Go to the 'Screens' page in my design file and build a new dashboard on the artboard called 'Overview'. Use the top-nav shell. Include: 4 KPI metric cards, a line chart of weekly activity, a data table with sortable columns, and a donut chart by category."*

### Target specific library components and variables

Name the components you want, and Claude will find and insert the real library instances.

> *"Build a settings screen using my Sidebar, Modal/Large, and FormInput components. Use the `surface-secondary` background, `spacing-xl` gaps, and `text-secondary` for label colors."*

---

## Quick start

**Step 1 — Make sure your Figma is set up** (see [Before you start](#before-you-start-figma-requirements) below)

**Step 2 — Run the installer:**
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/miapre/mimic-ai/main/install.sh)
```
The script clones this repo, runs `npm install`, asks for your Figma token, and writes the MCP entry to `~/.claude/settings.json`.

**Step 3 — Restart Claude Code**, then each session:
1. `cd ~/mimic-ai && npm run bridge` — keep this terminal open
2. In Figma desktop: **Plugins → Development → Mimic AI → Run**
3. The plugin badge shows **● ready** — you're ready

---

## Before you start: Figma requirements

These are the most common reason things break. Work through them in order before running the installer.

<details>
<summary><strong>1. Install the Figma desktop app</strong></summary>

The browser version of Figma does not work. The bridge communicates with a Figma plugin over WebSocket, which requires the desktop app.

Download it at: [figma.com/downloads](https://www.figma.com/downloads/)

</details>

<details>
<summary><strong>2. Generate a Personal Access Token</strong></summary>

The bridge uses this token to resolve published component keys via the Figma REST API.

1. Open **Figma desktop**
2. Click your **profile picture** (top-left corner) → **Settings**
3. Scroll down to **Personal access tokens**
4. Click **Generate new token**
5. Give it a name, e.g. `claude-bridge`
6. Set an expiration (or no expiration) — read access is sufficient
7. Click **Generate token**
8. **Copy the token immediately** — Figma only shows it once

You will be asked to paste it during the install script. It gets saved to the `.env` file in the repo.

</details>

<details>
<summary><strong>3. Publish your component library</strong></summary>

The plugin imports components from your team library. Your design system must live in a **separate Figma file** and be **published as a library**.

**To publish:**
1. Open your design system file in Figma desktop
2. Open the **Assets panel** (book icon in the left sidebar)
3. Click the **Team library** icon (grid of squares at the top)
4. Click **Publish** → confirm

> If you add or update a component later, publish again before asking Claude to use it.

**Starting from scratch?** See [docs/GUIDE.md — Part 0](docs/GUIDE.md#part-0--set-up-figma-correctly) for how to structure a design system file, set up variables (tokens), and create components properly.

</details>

<details>
<summary><strong>4. Enable the library in your target file</strong></summary>

Publishing makes the library available to your team. Enabling makes it accessible in a specific file.

1. Open the Figma file where you want Claude to build
2. Open the **Assets panel**
3. Click the **Team library** icon
4. Find your design system in the list and toggle it **on**

You only need to do this once per file.

</details>

<details>
<summary><strong>5. Figma plan note</strong></summary>

Publishing component libraries and using variables (design tokens) requires a **Figma Professional plan or above** — not the Starter/Free plan.

If you are on a free plan, the bridge can still create frames and text nodes, but component insertion and variable binding will not work.

</details>

---

## Manual setup

Prefer to set things up manually, or want to understand each step? See **[docs/GUIDE.md](docs/GUIDE.md)** for the full walkthrough:

- How to structure your Figma design system
- How to export design tokens so Claude can use them
- How to find and save component keys
- How to build Claude's memory for consistent results across sessions
- Build script patterns and layout rules

---

## Available tools

Once the MCP is registered, Claude has access to:

**Learning**

| Tool | What it does |
|---|---|
| `mimic_ai_knowledge_read` | Load known pattern→component mappings before a run. VERIFIED entries skip DS lookup entirely. |
| `mimic_ai_knowledge_write` | Persist mappings after a run. Auto-promotes CANDIDATE→VERIFIED at 3 consistent uses. |

**Build**

| Tool | What it does |
|---|---|
| `figma_create_frame` | Create an auto-layout frame (shells, cards, rows, columns) |
| `figma_create_text` | Create a text node bound to DS text style and color variable |
| `figma_create_rectangle` | Create a rectangle (dividers, placeholders, blocks) |
| `figma_create_chart` | Render a chart (scatter, line, donut, bar) in a single call |
| `figma_insert_component` | Insert a published library component by key or node ID |
| `figma_batch` | Execute multiple operations in a single round trip (tables, lists, grids) |

**Edit**

| Tool | What it does |
|---|---|
| `figma_set_component_text` | Set a text property on a component instance |
| `figma_set_text` | Set text on a specific nested TEXT node by direct ID |
| `figma_set_node_fill` | Apply a DS color variable to any node or its vector descendant |
| `figma_set_layout_sizing` | Adjust sizing, alignment, padding, or dimensions on a node |
| `figma_set_variant` | Set a VARIANT or BOOLEAN component property directly |
| `figma_set_visibility` | Show or hide a node |
| `figma_swap_main_component` | Swap an instance to a different variant by component key |
| `figma_replace_component` | Replace a node with a new component at the same parent position |
| `figma_move_node` | Reorder a node within its parent |
| `figma_delete_node` | Delete a node |

**Inspect**

| Tool | What it does |
|---|---|
| `figma_get_node_props` | Get component properties and text layers for a node |
| `figma_get_node_children` | List direct children of a node |
| `figma_get_node_parent` | Get parent and siblings of a node |
| `figma_get_text_info` | Get DS text style ID and color variable of a TEXT node |
| `figma_get_component_variants` | List all variant options in a component set |
| `figma_list_text_styles` | List all DS text styles with their IDs |
| `figma_get_selection` | Get currently selected node IDs and dimensions |
| `figma_select_node` | Select and zoom to a node by ID |
| `figma_get_page_nodes` | List all top-level nodes on the current page |
| `figma_get_pages` | List all pages in the document |
| `figma_change_page` | Switch to a different page |

---

## Every session

**1. Start the bridge** (keep this terminal open):
```bash
cd ~/mimic-ai   # or wherever you installed it
npm run bridge
```

**2. Run the plugin in Figma desktop:**
Plugins → Development → Mimic AI → Run

The plugin badge shows **● ready** when connected.

**3. Ask Claude to build something.**

---

## How it works

```
Claude Code  →  MCP server (mcp.js)  →  Bridge server (bridge.js)  →  Figma Plugin  →  Figma document
```

Two separate channels connect Claude to Figma:

**Read channel — official Figma MCP**
Claude uses Figma's official MCP server to inspect designs, discover node IDs, and read existing content. Read-only.

**Write channel — this repo**
Claude calls tools in `mcp.js`. Each call is an HTTP POST to `bridge.js` running locally on your machine. The bridge forwards the instruction to the Figma plugin over WebSocket. The plugin executes it using Figma's Plugin API and returns the new node ID. Claude uses that ID as the parent for the next element.

All variable bindings are real — nodes created this way use your actual design token variables, not hardcoded values. If you update a token in your library and re-publish, the nodes update automatically.

---

## Privacy

This tool runs entirely on your machine. No design data, component names, token values, or HTML content is sent to any external server. The only outbound network call is to the Figma REST API to resolve published component keys using your Personal Access Token — the same call Figma's own plugins make.

---

## Troubleshooting

**"Figma plugin is not connected"**
→ The bridge is running but the plugin is not. Go to Figma desktop → Plugins → Development → Mimic AI → Run.

**"Library import failed"**
→ Your design system library is not enabled in the target file. Open the Assets panel → Team library → toggle it on.

**"No component key"**
→ The component is not published. Open your design system file → Assets → Team library → Publish.

**"object is not extensible"**
→ A frame-only property (like `counterAxisSizingMode`) is being passed to a text node. See [docs/GUIDE.md — Troubleshooting](docs/GUIDE.md#troubleshooting) for the full list.

---

## License

MIT
