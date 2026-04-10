# figma-write-mcp

Let Claude Code write designs directly into Figma — creating frames, inserting real library components, and applying design tokens — without Figma Make.

```
Claude Code  →  MCP server (mcp.js)  →  Bridge server (bridge.js)  →  Figma Plugin  →  Figma document
```

## What it does

You describe a UI to Claude. Claude writes a Python build script, executes it, and the design appears in Figma in real time — using your actual published components and design token variables.

**Example prompt:**
> "Build an analytics dashboard on frame 6069:5898. Use the top-nav shell. Include: 4 KPI cards, a line chart of weekly activity, a data table with 20 rows, and a donut chart by category."

Claude handles the rest.

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | v18 or later |
| Figma desktop app | Required — browser Figma won't work |
| Claude Code | Any current version |
| Figma Personal Access Token | Free to generate |
| Published Figma component library | Your design system |

## Quick install

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

## How it works

The system has two separate channels between Claude and Figma:

**Read channel — official Figma MCP**
Claude uses Figma's official MCP server to inspect designs, discover node IDs, and read existing content. Read-only.

**Write channel — this repo**
To create things, Claude calls tools in `mcp.js`. Each call is an HTTP POST to `bridge.js` running locally. The bridge forwards the instruction to the Figma plugin over WebSocket. The plugin executes it using Figma's Plugin API and returns the new node ID. Claude uses that ID as the parent for the next element.

All variable bindings are real — nodes created this way use your actual design token variables, not hardcoded values.

## Troubleshooting

**"Figma plugin is not connected"**
→ Start the bridge (`npm run bridge`) and then run the Figma Write Bridge plugin inside Figma desktop.

**"Library import failed"**
→ Check that your design system library is enabled in the target Figma file: Assets panel → Team library → toggle it on.

**"No component key" / "object is not extensible"**
→ See [docs/GUIDE.md — Troubleshooting](docs/GUIDE.md#troubleshooting).

## License

MIT
