# HTML to Figma — Design System

**The only MCP that translates HTML into Figma using your own design system.**

Give Claude an HTML file. It reads your design system — published components and design token variables — and builds the layout inside Figma using real DS instances. Not hardcoded shapes. Not a visual approximation. Real component instances with real token bindings.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js: v20.6+](https://img.shields.io/badge/node-%3E%3D20.6-brightgreen)
![Platform: macOS / Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
[![Glama](https://glama.ai/mcp/servers/badge)](https://glama.ai/mcp/servers/html-to-figma-design-system)

> **Not a Figma product.** This is an independent, open-source MCP server built for Claude Code.

---

## Why this is different

Most HTML-to-Figma tools do a visual copy — they dump raw frames with hardcoded hex values. When you get the file, nothing connects to your design system. You have to re-apply tokens, swap in real components, and fix every layer by hand.

This tool does the opposite. Claude reads your HTML *and* your published component library at the same time, maps HTML elements to DS components, applies your token variables to every fill and text style, and builds a Figma file that's already part of your system.

**If you update a token in your library and re-publish, the Figma nodes update automatically.**

---

## What you can do

### Translate an HTML prototype into Figma

Have an existing HTML file — a prototype, a coded mockup, a landing page? Claude reads it and recreates it inside Figma using your design system instead of hardcoded values.

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
bash <(curl -fsSL https://raw.githubusercontent.com/miapre/html-to-figma-design-system/main/install.sh)
```
The script clones this repo, runs `npm install`, asks for your Figma token, and prints the exact block to add to `~/.claude/settings.json`.

**Step 3 — Restart Claude Code**, then each session:
1. `cd ~/html-to-figma-design-system && npm run bridge` — keep this terminal open
2. In Figma desktop: **Plugins → Development → HTML to Figma — Design System → Run**
3. The plugin panel shows **"Connected ✓"** — you're ready

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
cd ~/html-to-figma-design-system   # or wherever you installed it
npm run bridge
```

**2. Run the plugin in Figma desktop:**
Plugins → Development → HTML to Figma — Design System → Run

The plugin panel shows **"Connected ✓"** when ready.

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
→ The bridge is running but the plugin is not. Go to Figma desktop → Plugins → Development → HTML to Figma — Design System → Run.

**"Library import failed"**
→ Your design system library is not enabled in the target file. Open the Assets panel → Team library → toggle it on.

**"No component key"**
→ The component is not published. Open your design system file → Assets → Team library → Publish.

**"object is not extensible"**
→ A frame-only property (like `counterAxisSizingMode`) is being passed to a text node. See [docs/GUIDE.md — Troubleshooting](docs/GUIDE.md#troubleshooting) for the full list.

---

## License

MIT
