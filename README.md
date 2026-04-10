# figma-write-mcp

Let Claude Code write designs directly into Figma — creating frames, inserting real library components, and applying design tokens — without Figma Make.

```
Claude Code  →  MCP server (mcp.js)  →  Bridge server (bridge.js)  →  Figma Plugin  →  Figma document
```

---

## What you can do with it

### Build UI from a description

Describe the screen you want and Claude builds it in Figma — section by section, using your real published components and design token variables.

> "Go to the 'Screens' page in my design file and build a new dashboard on the artboard called 'Overview'. Use the top-nav shell. Include: 4 KPI metric cards, a line chart of weekly activity, a data table with sortable columns, and a donut chart breaking down by category."

### Translate an HTML prototype into Figma

If you have an HTML file — a prototype, a coded mockup, a landing page — Claude can read it and recreate it inside Figma using your actual design system instead of hardcoded values.

> "Here's an HTML file I built as a prototype. Translate it into Figma on the 'Prototypes' page, artboard 'Onboarding v2'. Use my design system components wherever possible — match the layout, hierarchy, and content."

### Target specific library components and variables

You can ask Claude to use particular components from your library or apply specific design tokens rather than letting it decide on its own.

> "Build a settings screen using my Sidebar, Modal/Large, and FormInput components. Use the `surface-secondary` background, `spacing-xl` gaps, and `text-secondary` for label colors."

---

## Figma requirements

Before running the installer, make sure your Figma setup meets these requirements. Skipping any of these is the most common reason things break.

### 1. Use the Figma desktop app

**The browser version of Figma does not work.** The bridge communicates with a Figma plugin over WebSocket, which requires the desktop app.

Download it at: [figma.com/downloads](https://www.figma.com/downloads/)

---

### 2. Generate a Personal Access Token

The bridge uses this token to resolve published component keys via the Figma REST API.

1. Open **Figma desktop**
2. Click your profile picture (top-left corner) → **Settings**
3. Scroll down to **Personal access tokens**
4. Click **Generate new token**
5. Give it a name (e.g. `claude-bridge`)
6. Set the expiration and permissions — read access is enough
7. Click **Generate token**
8. **Copy the token immediately** — Figma only shows it once

You will paste this token during the install script, or add it to the `.env` file manually afterward.

---

### 3. Have a published component library

The plugin imports components from your team library. For this to work, your design system must be in a **separate Figma file** that has been **published as a library**.

**If you already have a design system file:**
1. Open the design system file in Figma desktop
2. Open the **Assets panel** (book icon in the left sidebar)
3. Click the **Team library** icon (grid of squares at the top)
4. Click **Publish** — review the changes and confirm

**If you're starting from scratch:**
See [docs/GUIDE.md — Part 0](docs/GUIDE.md#part-0--set-up-figma-correctly) for how to structure your design system file, create variables (design tokens), and set up components the right way.

> **Important:** Components must be published to be accessible from other files. If you add or update a component, publish again before asking Claude to use it.

---

### 4. Enable the library in your target file

Publishing makes the library available to your team. Enabling makes it accessible in a specific file.

1. Open the Figma file where you want Claude to build
2. Open the **Assets panel**
3. Click the **Team library** icon
4. Find your design system in the list and toggle it **on**

You only need to do this once per file.

---

### 5. Figma plan note

Publishing component libraries requires a **Figma Professional plan or above** (not Starter/Free). Variables also require a paid plan. If you are on a free plan, the bridge can still create frames and text nodes, but component insertion and variable binding will not work.

---

## Quick install

Once your Figma setup is ready, run:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/miapre/figma-write-mcp/main/install.sh)
```

The script will:
1. Clone this repo to a directory of your choice
2. Run `npm install`
3. Ask for your Figma Personal Access Token
4. Print the exact block to add to `~/.claude/settings.json`

Then restart Claude Code.

## Manual setup

See **[docs/GUIDE.md](docs/GUIDE.md)** for the full step-by-step guide, including:
- How to structure your Figma design system for this to work
- How to export your design tokens so Claude can use them
- How to find and save your component keys
- How to build Claude's memory for consistent results
- Build script patterns and layout rules

---

## Available tools

Claude gets these tools once the MCP is registered:

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

The system has two separate channels between Claude and Figma:

**Read channel — official Figma MCP**
Claude uses Figma's official MCP server to inspect designs, discover node IDs, and read existing content. Read-only.

**Write channel — this repo**
To create things, Claude calls tools in `mcp.js`. Each call is an HTTP POST to `bridge.js` running locally. The bridge forwards the instruction to the Figma plugin over WebSocket. The plugin executes it using Figma's Plugin API and returns the new node ID. Claude uses that ID as the parent for the next element.

All variable bindings are real — nodes created this way use your actual design token variables, not hardcoded values.

---

## Troubleshooting

**"Figma plugin is not connected"**
→ Start the bridge (`npm run bridge`) and then run the Figma Write Bridge plugin inside Figma desktop.

**"Library import failed"**
→ Check that your design system library is enabled in the target Figma file: Assets panel → Team library → toggle it on.

**"No component key" / "object is not extensible"**
→ See [docs/GUIDE.md — Troubleshooting](docs/GUIDE.md#troubleshooting).

---

## License

MIT
