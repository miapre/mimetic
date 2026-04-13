# Mimic AI

**An MCP that builds in Figma using your design system — and gets faster every time.**

Mimic AI translates HTML into Figma using your published components and design tokens. It's built for how Figma's API actually works: reads are limited, writes are not. So Mimic minimizes reads, caches what it learns, and uses the budget where it counts. By run 3, familiar patterns require no lookups at all. By run 10, most builds are nearly free.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js: v20.6+](https://img.shields.io/badge/node-%3E%3D20.6-brightgreen)
![Platform: macOS / Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
[![Glama](https://glama.ai/mcp/servers/@miapre/mimic-ai/badge)](https://glama.ai/mcp/servers/@miapre/mimic-ai)

> **Not a Figma product.** This is an independent, open-source MCP server built for Claude Code.

---

<!-- TODO: Add a demo GIF here showing HTML → Figma conversion. Recommended: screen recording of a real build with the plugin badge visible, ~30–60 seconds, showing real DS components being inserted. -->
<!-- TODO: Add a before/after screenshot: HTML source on the left, Figma output on the right with real components and variable bindings visible. -->

---

## How Mimic works with Figma limits

Figma's API has two kinds of operations: reads and writes. They behave very differently.

**Writes are free.** Every frame Mimic creates, every component it inserts, every token it binds — these use Figma's plugin channel, which has no rate limit. Mimic can write as much as it needs.

**Reads are limited.** Figma's official MCP tools — inspecting library components, reading design context, capturing screenshots — draw from a daily quota (200 on Professional plans, 600 on Enterprise). These calls are shared across everything you do in Claude that day.

Mimic is designed around this reality. It enters every build in **Instant mode** by default: reads only what it must, caches everything it learns, and uses the quota as little as possible. A cold build might use 3–5 reads. A warm build might use 1. A fully learned build might use none.

---

## How it learns

Mimic maintains a local knowledge file — `ds-knowledge.json` — that records how HTML patterns map to your DS components and which variable IDs belong to which tokens. Every run loads from it before doing any library inspection, and writes back what it used.

| Run | What happens | Read cost |
|---|---|---|
| Run 1 | Mimic inspects the library for unknown patterns. Caches every successful mapping and your variable IDs. | 3–5 reads |
| Run 3 | Patterns used consistently 3× with no corrections are promoted to VERIFIED — no lookup needed for those. | 1–2 reads |
| Run 10+ | All patterns are VERIFIED. Variable IDs are cached. Builds are nearly free. | 0–1 reads |

Learning also improves **consistency**. The same HTML pattern resolves to the same DS component every time — no variance between runs. And it improves **speed**: fewer lookups mean Claude spends more time building and less time discovering.

**The knowledge file is yours.** It lives on your machine, travels with your project, and is fully inspectable JSON. Nothing is sent anywhere.

**Your corrections teach Mimic.** If Mimic inserts the wrong component, tell Claude: *"That component was wrong — use [the correct one] instead, and remember it for next time."* Claude demotes the mapping, records the correction, and uses the right component from that point on. No configuration needed — a plain sentence is enough.

**Your DS evolves and Mimic notices.** When a new component is added that's a better match for an existing mapping, Mimic flags it in the run report. It never auto-switches — you decide.

**Every run produces a learning summary.** At the end of each build, Claude reports how many patterns were saved, how many were promoted to VERIFIED, how many reads were used, and any design system gaps detected. Gap reports are the clearest signal about what your DS might be missing.

---

## Before every build — two things Mimic needs

**1. Where to build**
Mimic will always ask where in Figma you want the output before it starts. You can answer with a Figma link (file, page, or specific frame), or just describe it in plain language: *"my product file, the Screens page, next to the Login artboard."* If your original request already includes a link, Mimic skips the question.

**2. A library enabled in that file**
Mimic needs your component library to be enabled in the target Figma file — not just published in your DS file. If no library is found, Mimic stops and tells you exactly how to enable it before continuing. It will never build a screen without DS components and call it done.

---

## What to expect on your first run

The first run is the most expensive — in reads, in time, and in imperfection. That's expected, and the gap closes fast.

**Instant mode is always on by default.** Mimic does not scan your entire design system. It reads only what it needs for the patterns in your HTML. There is no "full DS ingestion" pass.

**5 reads maximum.** On a first run, Mimic targets 1 variable read, 1 targeted DS search, and 1 final screenshot. That's typically 3 reads. Two more are held in reserve for anything unexpected.

**The output is functional, not perfect.** Patterns Mimic has never seen before will be resolved with its best judgment. A few may be off — resolved as a close component when a better one exists, or built from primitives when a DS component wasn't found. These are candidates for correction, not failures.

**After the first run, the gaps start closing.** Correcting a component teaches Mimic what to use. Repeating a pattern three times makes it permanent. Variable IDs are cached after the first read — no re-collection on subsequent runs.

**The learning summary at the end tells you where things stand:** how many patterns are now VERIFIED, how many reads were used, and what to correct if anything was off.

---

## When Mimic may stop a build

Mimic is aware of your Figma read budget. If a mid-build situation would require reads that exceed what's available or advisable, Mimic stops and tells you — rather than burning calls on uncertain operations.

This is intentional. A partial build with 3 compliant sections is more useful than an incomplete attempt that exhausts the daily budget on retries. You can continue the next day, or ask Mimic to resume from where it stopped.

**Mimic will also stop if a write fails unexpectedly.** It does not retry blindly — it classifies the error, applies a fix if one is known, and reports what happened.

---

## Why this matters

Other HTML-to-Figma tools are stateless. Every run starts from scratch: inspect library, resolve patterns, build, done. Run 1 and run 50 cost the same.

Mimic compounds. The longer you use it against the same design system, the fewer reads each run requires, the more consistent the output becomes, and the faster builds complete. It converges on your DS vocabulary instead of re-discovering it every time.

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

> **Requirements before you begin:** Node.js v20.6+, git, Figma desktop app, **Figma Professional plan or above** (the free plan cannot publish component libraries or bind variables — the tool's core features require a paid Figma plan). Full Figma setup steps are in [Before you start](#before-you-start-figma-requirements) below.

**Step 1 — Run the installer:**
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/miapre/mimic-ai/main/install.sh)
```
The script clones this repo, runs `npm install`, asks for your Figma token, and writes the MCP entry to `~/.claude/settings.json`.

**Step 2 — Install the Figma plugin:**
1. Open **Figma desktop**
2. From the menu bar: **Plugins → Development → Import plugin from manifest…**
3. Navigate to your `~/mimic-ai/plugin/` folder and select `manifest.json`
4. Confirm — the plugin now appears under **Plugins → Development → Mimic AI**

**Step 3 — Restart Claude Code**, then each session:
1. `cd ~/mimic-ai && npm run bridge` — keep this terminal open
2. In Figma desktop: **Plugins → Development → Mimic AI → Run**
3. The plugin badge shows **● ready**

**Step 4 — Enable your design system in the target file:**
1. Open the Figma file where you want Claude to build
2. Open the **Assets panel** (book icon, left sidebar)
3. Click the **Team library** icon at the top
4. Find your design system and toggle it **on**

Without this, Mimic can't find any components and will stop before building anything.

**You're ready.** Ask Claude to build something — include a Figma link or tell it which file and page to use.

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
<summary><strong>5. Figma plan requirement</strong></summary>

Publishing component libraries and using variables (design tokens) requires a **Figma Professional plan or above** — not the Starter/Free plan. This is a hard requirement, not a feature limitation.

**What works on the free plan:** The bridge can create frames and raw text nodes.

**What does not work on the free plan:** Component insertion, variable binding, and design token application — the three features that make Mimic AI useful. If you are on a free plan, upgrade before setting up the tool.

</details>

---

## Manual setup

Prefer to set things up manually, or want to understand each step? See **[docs/GUIDE.md](docs/GUIDE.md)** for the full walkthrough:

- How to structure your Figma design system
- How to export design tokens so Claude can use them
- How to find and save component keys
- How to build Claude's memory for consistent results across sessions
- Build script patterns and layout rules

To inspect or manually manage the knowledge file, see **[docs/knowledge-schema.md](docs/knowledge-schema.md)** for the full schema reference — including how to inject known mappings, dismiss recommendations, share knowledge across a team, and reset entries after DS changes.

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
