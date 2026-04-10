# figma-write-mcp

Let Claude Code write designs directly into Figma — creating frames, inserting real library components, and applying design tokens — without Figma Make.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js: v18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Platform: macOS / Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)

---

## Table of contents

- [What you can do](#what-you-can-do)
- [Quick start](#quick-start)
- [Before you start: Figma requirements](#before-you-start-figma-requirements)
- [Manual setup](#manual-setup)
- [Available tools](#available-tools)
- [Every session](#every-session)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)

---

## What you can do

### Build UI from a description

Describe a screen and Claude builds it in Figma — section by section, using your actual published components and design token variables.

> *"Go to the 'Screens' page in my design file and build a new dashboard on the artboard called 'Overview'. Use the top-nav shell. Include: 4 KPI metric cards, a line chart of weekly activity, a data table with sortable columns, and a donut chart by category."*

### Translate an HTML prototype into Figma

Have an existing HTML file — a prototype, a coded mockup, a landing page? Claude reads it and recreates it inside Figma using your design system instead of hardcoded values.

> *"Here's an HTML file I built as a prototype. Translate it into Figma on the 'Prototypes' page, artboard 'Onboarding v2'. Use my design system components wherever possible — match the layout, hierarchy, and content."*

### Target specific library components and variables

Name the components you want, and Claude will find and insert the real library instances.

> *"Build a settings screen using my Sidebar, Modal/Large, and FormInput components. Use the `surface-secondary` background, `spacing-xl` gaps, and `text-secondary` for label colors."*

---

## Quick start

**Step 1 — Make sure your Figma is set up** (see [Before you start](#before-you-start-figma-requirements) below)

**Step 2 — Run the installer:**
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/miapre/figma-write-mcp/main/install.sh)
```
The script clones this repo, runs `npm install`, asks for your Figma token, and prints the exact block to add to `~/.claude/settings.json`.

**Step 3 — Restart Claude Code**, then each session:
1. `cd ~/figma-write-mcp && npm run bridge` — keep this terminal open
2. In Figma desktop: **Plugins → Development → Figma Write Bridge → Run**
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

| Tool | What it does |
|---|---|
| `figma_create_frame` | Create an auto-layout frame (shells, cards, rows, columns) |
| `figma_create_text` | Create a text node with font and color tokens |
| `figma_create_rectangle` | Create a rectangle (dividers, placeholders, blocks) |
| `figma_insert_component` | Insert a published library component by node ID |
| `figma_set_component_text` | Set text on a component instance |
| `figma_set_layout_sizing` | Adjust layout grow/align on an existing node |
| `figma_create_chart` | Render a chart (scatter, line, donut, bar) in a single call |
| `figma_get_selection` | Get currently selected node IDs and dimensions |
| `figma_select_node` | Select and zoom to a node by ID |
| `figma_get_page_nodes` | List all top-level nodes on the current page |
| `figma_delete_node` | Delete a node |

---

## Every session

**1. Start the bridge** (keep this terminal open):
```bash
cd ~/figma-write-mcp
npm run bridge
```

**2. Run the plugin in Figma desktop:**
Plugins → Development → Figma Write Bridge → Run

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

## Troubleshooting

**"Figma plugin is not connected"**
→ The bridge is running but the plugin is not. Go to Figma desktop → Plugins → Development → Figma Write Bridge → Run.

**"Library import failed"**
→ Your design system library is not enabled in the target file. Open the Assets panel → Team library → toggle it on.

**"No component key"**
→ The component is not published. Open your design system file → Assets → Team library → Publish.

**"object is not extensible"**
→ A frame-only property (like `counterAxisSizingMode`) is being passed to a text node. See [docs/GUIDE.md — Troubleshooting](docs/GUIDE.md#troubleshooting) for the full list.

---

## License

MIT
