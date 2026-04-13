# From Zero to AI-Generated Figma UI
### How to let Claude Code build production-ready designs using your own design system

---

## What this guide covers

By the end of this guide you will be able to do three things with Claude Code and Figma:

**1. Build UI from a description**
Describe a screen — layout, sections, data, charts — and watch it appear in Figma in real time, using your actual published components and design token variables. Not a mockup. Not a recreation. Your real library components, your real variables, wired up correctly.

**2. Translate HTML into Figma**
If you have an HTML prototype or coded mockup, Claude can read it and recreate it inside Figma — mapping your HTML structure to your design system components and replacing hardcoded CSS values with the correct tokens.

**3. Target specific library components and variables**
You can tell Claude which components to use, which design tokens to apply, and which layout patterns to follow. Claude will look up what is available in your library and use the right pieces.

Here is an example of what you can build with this system:

> *"Go to the 'Screens' page in my design file and build a new dashboard on the artboard called 'Overview'. Use the standard top-navigation layout. Include: a page header with title and subtitle, 4 KPI metric cards (revenue, active users, conversion rate, avg order value), a line chart of weekly activity over 12 weeks, a data table of top accounts with sortable columns, and a donut chart by category."*

Claude wrote the code, executed it, and the entire page appeared in Figma in under two minutes.

---

## What you need before you start

| Tool | Purpose | Cost |
|---|---|---|
| [Claude Code](https://claude.ai/claude-code) (CLI, VS Code, or desktop) | The AI that does the work — install options in Part 1 | Anthropic account required |
| [Node.js](https://nodejs.org/) v20.6 or later | Runs the local bridge server (v20.6+ required for `--env-file` support) | Free |
| Python 3 | Runs build scripts | Free |
| [Figma desktop app](https://www.figma.com/downloads/) | Required — browser Figma won't work | Free plan works |
| A Figma account with a published component library | Your design system | Figma plan required for libraries |
| A Figma Personal Access Token | Lets the bridge look up component keys | Free to generate |

---

## How it works — the big picture

There are two separate channels between Claude and Figma. Understanding them upfront will make every setup step make sense.

```
┌─────────────────────────────────────────────────────────────────┐
│                          Claude Code                            │
│                                                                 │
│   ┌─────────────────────┐       ┌─────────────────────────┐    │
│   │   Figma MCP         │       │   mimic-ai     │    │
│   │   (official,        │       │   (custom, write-only)  │    │
│   │    read-only)       │       │                         │    │
│   └──────────┬──────────┘       └────────────┬────────────┘    │
└──────────────┼───────────────────────────────┼─────────────────┘
               │                               │
               │ Figma REST API                │ HTTP POST
               │ reads designs,                │ to localhost:3055
               │ gets metadata                 │
               ▼                               ▼
          figma.com                    ┌───────────────┐
                                       │   bridge.js   │
                                       │  (runs on     │
                                       │  your machine)│
                                       └───────┬───────┘
                                               │ WebSocket
                                               ▼
                                       ┌───────────────┐
                                       │ Figma Plugin  │
                                       │ (runs inside  │
                                       │  Figma app)   │
                                       └───────┬───────┘
                                               │ Figma Plugin API
                                               ▼
                                       ┌───────────────┐
                                       │  Your Figma   │
                                       │     file      │
                                       └───────────────┘
```

**Channel 1 — Read (Figma MCP):** Claude uses Figma's official MCP server to read your designs. It can inspect any frame, see what components exist, read property values, and understand the design context. This is read-only — it cannot create or modify anything.

**Channel 2 — Write (Mimic AI):** To create things in Figma, this repo provides a custom local system: a small Node.js bridge server that runs on your computer, plus a Figma plugin that runs inside the Figma desktop app. Claude sends instructions to the bridge over HTTP; the bridge forwards them to the plugin over WebSocket; the plugin executes them using Figma's Plugin API.

---

## Part 0 — Set up Figma correctly

This is the most skipped step and the one that causes the most problems. Before writing a single line of code, your Figma file needs to be structured in a specific way. If this is not right, the plugin will fail to find your components and variables no matter what.

### 0.1 Use a dedicated design system file

Do not put your component library in the same file where you build UIs. Figma's publishing system works file-by-file: you publish one file as a library, and other files subscribe to it.

Create (or designate) one Figma file as your **design system source**. This is where all components, variables, and styles live. All other files — your product UI files — will consume from it.

### 0.2 Set up Variables

Variables are the backbone of the token system. The plugin reads variable values from your library and binds them to nodes it creates.

**Creating a Variable Collection:**

1. Open your design system file
2. Click the **Variables** icon in the right panel (or go to **Edit → Variables**)
3. Click **+** to create a new collection
4. Name it meaningfully — for example: `1. Color modes`, `3. Spacing`, `2. Radius`

The collection name becomes part of the variable path. For example, if color variables live in a collection called `1. Color modes` and are named like `Colors/Background/bg-primary`, the path Claude passes to the plugin is `Colors/Background/bg-primary` — the collection name is NOT included.

**Creating variables in a collection:**

1. Inside a collection, click **+** to add a variable
2. Choose the type:
   - **Color** — for fill colors, border colors, text colors
   - **Number** — for spacing, radius, sizing
   - **String** — for font names, rarely used directly
3. Name the variable using the full path format: `Colors/Background/bg-primary`
   - The `/` creates nested groups in the panel — purely visual organisation
   - This full path is exactly what you pass to the bridge

**Setting variable scope — this is critical:**

By default a new variable can be applied to anything. You should restrict it to make the design system intentional, but more importantly, certain scope settings are required for the plugin's `setBoundVariable` calls to work.

Click the variable → in the right panel, find **Scopes**:

| Variable type | Required scopes to enable |
|---|---|
| Background color | Fill color |
| Text color | Text fill |
| Border color | Stroke color |
| Spacing (gap, padding) | Gap, Padding all (top/right/bottom/left) |
| Corner radius | Corner radius |
| Width/Height | Width, Height |

If a scope is not enabled, `setBoundVariable` will fail silently — the value will be set as a raw number or not at all.

**Tip:** For spacing variables, enable all padding and gap scopes together. This allows the same token (e.g. `spacing-3xl`) to be bound to gap, paddingTop, paddingLeft, etc.

**Setting modes (for color themes):**

If your design system supports light and dark mode, each color collection has modes. Click the **Mode** button at the top of the collection to add modes. Name them `Light mode` and `Dark mode`. Set different values for each mode per color variable.

The plugin reads the current mode that is active in your Figma file when it binds the variable.

### 0.3 Set up Components

Components in Figma are reusable design elements — buttons, headers, cards, navigation bars.

**Creating a component:**

1. Design your element on the canvas as you normally would
2. Select all the layers that make up the component
3. Press `Cmd+Alt+K` (Mac) or `Ctrl+Alt+K` (Windows), or right-click → **Create component**
4. A purple diamond icon confirms it is now a master component
5. Name it clearly — this is the name Claude will reference and the name that appears in the Assets panel

**Organising components:**

Components can be grouped using `/` in their name, just like variables. For example:
- `Button/Primary/Large`
- `Button/Secondary/Medium`
- `Header/Desktop`

**Linking components to variables:**

For the plugin to insert a component AND have it respect your design tokens, the component itself must use variables internally. Select layers within the component and apply variable fills, strokes, and spacing from your collection rather than hardcoded hex values. This way, when the plugin inserts the component and the mode changes, everything updates.

### 0.4 Publish the library

Publishing makes your components and variables available in other Figma files. Until you publish, nothing is accessible to the plugin from outside the design system file.

**To publish:**

1. In your design system file, open the **Assets** panel (book icon, left sidebar)
2. Click the **Team library** icon (grid of squares at the top of the Assets panel)
3. You will see a list of component groups and a list of variable collections
4. Click **Publish** next to each section, or use the main **Publish library** button at the top
5. Write a short description of what changed (optional but helpful for your team)
6. Click **Publish**

**What gets published:**
- All master components in the file
- All variable collections in the file
- All styles (colors, text styles, effects)

**What does NOT get published automatically:**
- Components that are set to "Private to this file" — check the component's right panel
- Variable collections that have "Do not publish" enabled

**After publishing, every component has a key.** This is the long hash string that the plugin uses to import the component from the library. It is permanent — it never changes even if you rename or move the component. You only need to find it once and save it.

### 0.5 Enable the library in your product file

Publishing makes the library available. Enabling makes it accessible in a specific file.

1. Open the Figma file where you want to build UIs
2. Open the **Assets** panel
3. Click the **Team library** icon
4. Find your design system file in the list
5. Toggle it **on**

You only need to do this once per file. After this, all published components appear in the Assets panel under their library name, and all published variables are accessible via `figma.teamLibrary` in the plugin.

### 0.6 Export variables for Claude

The plugin resolves variable names at runtime, but Claude needs to know the variable names upfront to write correct build scripts. Export your variables so you can give Claude an accurate reference.

**Option 1 — Figma Variables panel export (if available in your plan):**
1. Open the Variables panel
2. Click the **Export** button (downward arrow icon, top right of the panel)
3. Choose JSON format
4. Save the file

**Option 2 — REST API export:**
The Figma REST API always works regardless of plan. Claude can fetch it for you:

> *"Use the Figma MCP to export all variables from file [your file key] and list the variable names and their values."*

Claude will call `get_variable_defs` on your file and return a complete list.

**What the export gives you:**

The export contains every variable with:
- Its **name** — this is the path you pass to the bridge (e.g. `Colors/Background/bg-primary`)
- Its **collection** — the group it belongs to
- Its **type** — COLOR, FLOAT, STRING
- Its **value per mode** — the actual hex or pixel value

You use this to build the `figma_variable_names.md` memory file described in Part 6.

**Variable name format — important:**

The name you pass to the bridge is the variable's name within its collection, not the collection name itself. For example, if your collection is called `3. Spacing` and contains a variable called `spacing-3xl`, you pass `"spacing-3xl"` — not `"3. Spacing/spacing-3xl"`.

However, if your collection is `1. Color modes` and contains `Colors/Background/bg-primary`, you pass `"Colors/Background/bg-primary"` — including the internal folder path but excluding the collection name.

The safest way to confirm: look at what the plugin's variable search returns. Add a quick test call:
```python
ex("debug_variables", {"query": "bg-primary"})
```
This will show you all variables whose name contains "bg-primary" along with their exact paths.

---

## Part 1 — Install Claude Code

Claude Code is available as a CLI, a VS Code extension, a JetBrains extension, and a desktop app. Pick whichever fits your workflow — they all give Claude access to the same tools.

### 1.1 Install options

**Option A — CLI (recommended for most developers)**

```bash
npm install -g @anthropic-ai/claude-code
```

Then run `claude` in any terminal to start a session.

**Option B — VS Code extension**

1. Open VS Code
2. Click the Extensions icon in the left sidebar (`Cmd+Shift+X` on Mac, `Ctrl+Shift+X` on Windows)
3. Search for **Claude Code** and click **Install**

**Option C — Desktop app**

Download from [claude.ai/download](https://claude.ai/download). Includes the full Claude Code experience without needing VS Code.

### 1.2 Sign in

**If you have a Claude subscription (Pro, Team, or Enterprise):**
Run `claude` (or click Sign in inside the extension/app) and authenticate with your Anthropic account via browser. No API key needed.

**If you want to use an API key directly:**
Get a key at [console.anthropic.com](https://console.anthropic.com) under **API Keys → Create key**, then paste it when prompted.

### 1.3 Open your project folder

Claude Code works within a folder on your computer. Create a dedicated folder for this project and open it — either in VS Code (`File → Open Folder`) or navigate to it in the terminal before running `claude`.

---

## Part 2 — Set up the Figma Read MCP (official)

The official Figma MCP lets Claude read your designs. This is how Claude discovers component node IDs, inspects existing frames, and understands what is already in your file.

### 2.1 Generate a Figma Personal Access Token

The token lets the bridge call the Figma REST API to look up published component keys. Without it, component insertion from a different file will not work.

1. Open **Figma desktop** (not the browser — only the desktop app has the settings you need)
2. Click your **profile picture** in the top-left corner → **Settings**
3. Scroll down to the **Personal access tokens** section
4. Click **Generate new token**
5. Give it a descriptive name, e.g. `claude-bridge`
6. Set an expiration date (or no expiration) and leave permissions at the default — read access is sufficient
7. Click **Generate token**
8. **Copy the token immediately.** Figma only shows it once. If you close the dialog without copying, you will need to generate a new one.

Store the token in the `.env` file at the root of this repo:

```
FIGMA_ACCESS_TOKEN=your_token_here
```

The bridge reads this automatically when it starts.

### 2.2 Configure the MCP in Claude Code

Claude Code is configured via a file at `~/.claude/settings.json`. The `~` means your home folder (`/Users/yourname` on Mac, `C:\Users\yourname` on Windows). Open it in any text editor:

```bash
# macOS
open -e ~/.claude/settings.json

# Windows (PowerShell)
notepad $env:USERPROFILE\.claude\settings.json

# Any platform — VS Code
code ~/.claude/settings.json
```

If the file does not exist yet, create it. Add this content:

```json
{
  "mcpServers": {
    "claude.ai Figma": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/figma-mcp"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "paste_your_token_here"
      }
    }
  }
}
```

Save the file, then restart Claude Code (quit and reopen the app, or restart the terminal session).

### 2.3 Verify the read MCP works

In the Claude Code chat panel, paste a Figma design URL and ask Claude to describe it. If it can read the contents, the read MCP is working correctly.

---

## Part 3 — Set up the Write Bridge (Mimic AI)

This custom system lets Claude create things in Figma. It has three components:

- **mcp.js** — the tool server that Claude Code calls
- **bridge.js** — a local HTTP and WebSocket server
- **plugin/** — the Figma plugin that runs inside the Figma app

> **Used the installer or cloned the repo?** All files in Parts 3.1–3.6 already exist. Skip directly to **[Part 3.7 — Register with Claude Code](#37-register-mimic-ai-with-claude-code)**.

### 3.1 Create the project folder

Inside your main project folder, create a subfolder called `mimic-ai`. In a terminal:

```bash
mkdir mimic-ai
cd mimic-ai
```

### 3.2 Create package.json

Create a file called `package.json` inside `mimic-ai`:

```json
{
  "name": "mimic-ai",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "bridge": "node --env-file=.env bridge.js",
    "mcp": "node mcp.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.15.0",
    "ws": "^8.18.0"
  },
  "engines": {
    "node": ">=20.6"
  }
}
```

Then install dependencies:

```bash
npm install
```

### 3.3 Create the .env file

Create a file called `.env` (the dot at the start is intentional) in the `mimic-ai` folder:

```
FIGMA_ACCESS_TOKEN=paste_your_figma_token_here
BRIDGE_PORT=3055
```

This token is the same one from Part 2. The bridge uses it to call the Figma REST API to resolve published component keys.

> **Important — do not change `BRIDGE_PORT`** unless you also edit `plugin/ui.html` to match. The plugin connects to the bridge via WebSocket at `ws://localhost:3055`, and this value is hardcoded in the plugin's HTML file. If the ports don't match, the plugin will show "Bridge not running" even when the bridge is up.

### 3.4 Create bridge.js

`bridge.js` is a small HTTP and WebSocket server that runs on your computer. It is the middleman between Claude Code and the Figma plugin.

**What it does:**
- Listens at `http://localhost:3055/execute` for POST requests from Claude
- For component insertion requests, calls the Figma REST API to get the component's published key
- Forwards instructions to the Figma plugin over WebSocket
- Waits for the plugin to complete the action, then returns the result to Claude

It must handle one instruction at a time, queuing them if needed. Each instruction gets a unique ID; the response from the plugin includes that same ID so the bridge knows which promise to resolve.

### 3.5 Create mcp.js

`mcp.js` is the MCP server — the piece Claude Code sees as a list of available tools. It uses the `@modelcontextprotocol/sdk` package.

**It exposes these tools:**

| Tool | What it does |
|---|---|
| `figma_create_frame` | Create an auto-layout frame with fill, border, padding, gap, corner radius |
| `figma_create_text` | Create a text node with font, size, weight, color |
| `figma_create_rectangle` | Create a rectangle (used for bars, dividers, placeholders) |
| `figma_insert_component` | Insert a library component instance by node ID + file key |
| `figma_set_component_text` | Set a text layer value on a component instance |
| `figma_set_layout_sizing` | Adjust layout grow/align on an existing node |
| `figma_get_selection` | Read what is currently selected in Figma |
| `figma_select_node` | Select a node by its ID |
| `figma_get_page_nodes` | List all top-level nodes on the current Figma page |
| `figma_delete_node` | Delete a node |
| `figma_create_chart` | Render a complete chart (scatter, line, donut, bar) in a single call |

Each tool call in Claude triggers an HTTP POST to the bridge, which forwards it to the plugin.

### 3.6 Create the Figma plugin

The plugin runs inside the Figma desktop app. It is the only part of this system that can directly control Figma. It has three files:

**plugin/manifest.json**

This tells Figma how to load your plugin:

```json
{
  "name": "Mimic AI",
  "id": "mimic-ai",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "editorType": ["figma"],
  "permissions": ["teamlibrary"],
  "networkAccess": {
    "allowedDomains": ["*"],
    "reasoning": "Connects to the local bridge server to receive design instructions."
  }
}
```

The `"teamlibrary"` permission is essential — without it, the plugin cannot access your published component library or bind design token variables.

---

**plugin/ui.html**

Figma plugins have two layers: a sandboxed JavaScript worker (`code.js`) and an optional browser iframe (`ui.html`). The worker cannot open network connections, but the iframe can. So `ui.html` acts as the network relay:

1. It opens a WebSocket connection to `ws://localhost:3055`
2. When a message arrives from the bridge, it forwards it to `code.js` via `postMessage`
3. When `code.js` finishes an action and posts a result, `ui.html` sends it back to the bridge

The badge displays a colored dot and a status label: **● ready** (green) when the bridge is reachable, **● offline** (red) when it is not.

---

**plugin/code.js**

This is the main plugin worker. It handles all Figma API calls. Key capabilities:

**Variable resolution and binding**

When you pass a color or spacing token name (e.g. `"Colors/Background/bg-primary"` or `"spacing-3xl"`), the plugin:
1. Searches your team library for a variable matching that name using `figma.teamLibrary.getVariablesInLibraryCollectionAsync()`
2. Imports it with `figma.variables.importVariableByKeyAsync()`
3. Binds it to the node using `figma.variables.setBoundVariableForPaint()` for colors, or `node.setBoundVariable('itemSpacing', variable)` for spacing

This means the resulting Figma nodes have real variable bindings — not hardcoded values. If you update the token in your library, the UI updates automatically.

**Component insertion from library**

For library components, the plugin calls `figma.importComponentByKeyAsync(key)` to import the component from your team library, then creates an instance. The published component key is resolved by the bridge via the Figma REST API before the instruction reaches the plugin.

**Auto-layout setup**

The plugin sets `layoutMode`, `itemSpacing` (gap), padding, `primaryAxisSizingMode`, `counterAxisSizingMode`, `layoutAlign`, and `layoutGrow` on created frames.

> **Critical:** `layoutAlign` and `layoutGrow` must be set AFTER the node is appended to its parent (`parent.appendChild(node)`). Setting them before append has no effect — Figma silently ignores them because the node is not yet inside an auto-layout parent.

**Chart rendering**

Charts are rendered entirely within one plugin call. Instead of creating each dot or line segment individually (which would require hundreds of bridge round trips), all data is sent to the plugin at once and it renders the full chart internally using Figma's vector and ellipse APIs.

---

### 3.7 Register Mimic AI with Claude Code

Update `~/.claude/settings.json` to include both MCPs:

```json
{
  "mcpServers": {
    "claude.ai Figma": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/figma-mcp"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "your_token_here"
      }
    },
    "mimic-ai": {
      "command": "node",
      "args": ["/absolute/path/to/your/mimic-ai/mcp.js"]
    }
  }
}
```

Use the full absolute path to `mcp.js` — relative paths do not work here.

---

## Part 4 — Install the plugin into Figma

### 4.1 Import the plugin for development

1. Open Figma desktop
2. From the menu bar: **Plugins → Development → Import plugin from manifest…**
3. Navigate to your `mimic-ai/plugin/` folder and select `manifest.json`
4. The plugin now appears under **Plugins → Development → Mimic AI**

### 4.2 Enable your team library in the target file

The plugin needs access to your published components and variables:

1. Open the Figma file where you want Claude to build UIs
2. Open the **Assets** panel (book icon in the left sidebar)
3. Click the **Team library** button (grid icon)
4. Find your design system library and toggle it **on**

### 4.3 Start the bridge and run the plugin

You need both running every time you want to build with Claude.

**Step 1 — Start the bridge** (in a terminal, keep this running):

```bash
cd mimic-ai
npm run bridge
```

You will see:
```
[bridge] Running on http://127.0.0.1:3055
[bridge] Waiting for Figma plugin to connect…
```

**Step 2 — Run the plugin in Figma:**

1. In Figma desktop, go to **Plugins → Development → Mimic AI → Run**
2. A small badge appears showing **● ...** (amber, connecting)
3. Within a second it turns green: **● ready**

The terminal will print `[bridge] Figma plugin connected`. You are ready.

---

## Part 5 — Export your design tokens

For Claude to use your design tokens instead of raw hex values and pixel numbers, it needs to know the exact variable names.

### 5.1 Export variables from Figma

In your design system Figma file:
1. Open the **Variables** panel
2. Click the export icon (or go to **Edit → Copy variables as JSON**)
3. Save the file (e.g. `design_system_variables.json`)

### 5.2 Organise tokens into foundation files

Parse the export into separate files by type and store them in your project:

```
design_system/foundations/
  colors.json        ← semantic colors + primitive palette
  spacing.json       ← spacing scale + named aliases
  typography.json    ← font size, weight, line height
  radius.json        ← corner radius tokens
  shadows.json       ← shadow effect styles
```

What matters is extracting the **variable name as it appears in Figma**. These are the exact strings you pass to the bridge. For example, a typical design system might have:

- `"Colors/Background/bg-primary"` — white background
- `"Colors/Text/text-primary"` — primary text color
- `"Colors/Border/border-default"` — default border color
- `"spacing-sm"` — small spacing (e.g. 8px)
- `"spacing-lg"` — large spacing (e.g. 24px)
- `"radius-md"` — medium corner radius

Your variable names will be different — they depend entirely on how your design system file is structured. The safest way to confirm the exact name is to open the Variables panel and read the path directly.

### 5.3 Find your component keys

Every published component in your Figma library has a unique key. You need this key to insert components from a different file. You only need to find it once — then save it to Claude's memory.

**Method 1:** Right-click the master component in your library file → **Copy link**. The URL contains the node ID (e.g. `?node-id=1234-5678`), not the key. Pass that URL to Claude and ask it to resolve the component key using the Figma MCP.

**Method 2:** Ask Claude — paste the component's Figma URL and say "get me the component key for this node." Claude will use the Figma MCP to look it up.

**Method 3:** The bridge resolves keys automatically if you have `FIGMA_ACCESS_TOKEN` set in `.env`. But hardcoding them in memory is faster and avoids API calls.

---

## Part 6 — Build Claude's memory

Claude Code has a persistent memory system at:
```
~/.claude/projects/[project-folder-name]/memory/
```

Create a `MEMORY.md` file there — this is an index that Claude reads at the start of every conversation. It is the key to consistent, knowledgeable responses across sessions.

**What to put in memory:**

```markdown
# Project Memory

## Figma
File key: YOUR_PRODUCT_FILE_KEY
Library file key: YOUR_DESIGN_SYSTEM_FILE_KEY

## Design token variable names
See memory/figma_variable_names.md

## Structural component keys
HEADER:   [published component key]
FOOTER:   [published component key]
SIDEBAR:  [published component key]
CARD:     [published component key]

## Layout rules
- Artboard width: [e.g. 1440px]
- Content max-width: [e.g. 1280px, centered]
- Spacing tokens must be used everywhere — never raw pixel numbers
- Full-width containers: layoutAlign="STRETCH" + counterAxisSizingMode="AUTO"
- Horizontal rows with grow children: primaryAxisSizingMode="FIXED" + layoutAlign="STRETCH"
- Page background token: [e.g. Colors/Background/bg-primary]
```

Create a separate `figma_variable_names.md` file with the complete list of your token paths. The more accurate this file is, the more reliably Claude applies your design system.

---

## Part 7 — Ask Claude to build a UI

With the bridge running and the plugin connected, you are ready.

### 7.1 What to say

Give Claude three things:
1. **Where to build** — the file name, page name, and artboard name. Claude will use `figma_get_page_nodes` to find the right node ID itself. You never need to look up IDs manually.
2. **What surface** — which navigation shell to use (e.g. "top navigation header with footer", "sidebar navigation")
3. **What content** — the sections, data, charts, and tables you want on the page

Example:
> *"Go to the 'Screens' page in my design file and build a new screen on the artboard called 'Analytics'. Use the standard top-navigation layout. Page title: Sales Overview · Q4 2024. Include: a metadata strip with date range / region / total accounts / last updated, a summary card with headline numbers, 4 KPI metric cards (revenue, active users, conversion rate, avg order value), a line chart of monthly revenue over 12 months, a sortable table of top 10 accounts with columns for name / revenue / growth / status, and a bar chart comparing performance by region."*

### 7.2 What happens

1. Claude checks memory for variable names, component keys, and layout rules
2. Claude writes a Python build script
3. Claude executes the script — each function call sends one instruction to the bridge
4. The bridge forwards the instruction to the Figma plugin
5. The plugin creates the element, binds the variables, and returns the new node ID
6. Claude uses that ID as the parent for the next element
7. You watch the page build in real time in Figma

---

### 7.3 More ways to prompt

**Translate an HTML prototype into Figma**

If you have an existing HTML file, attach it or paste its contents and ask Claude to translate it:

> *"Here's an HTML prototype I built for the onboarding flow. Go to the 'Onboarding' page in my design file and recreate it on the artboard called 'Onboarding v2'. Use my design system components wherever there's a match — replace any hardcoded colors and spacing with the correct design tokens."*

Claude will read the HTML structure, identify elements (nav, cards, buttons, forms, tables), map them to the closest component in your library, and build the Figma version using the bridge tools. The result will use your real variables rather than the CSS values in the HTML.

---

**Target specific library components**

If you know which components you want, name them directly:

> *"Build a settings screen on the 'Settings' page, artboard 'Account Settings'. Use the Sidebar component for navigation, Modal/Large for the confirmation dialog, and FormInput for each field. Apply `surface-secondary` as the page background and `spacing-xl` for section gaps."*

Claude will use `figma_get_page_nodes` to find the artboard, then look up the component keys from your library and insert the real instances.

---

**Iterate on something that already exists**

You can point Claude at an existing frame and ask it to add to or modify it:

> *"Go to the 'Dashboard' artboard on the 'Screens' page. A metrics section already exists at the top. Add a new section below it with a bar chart comparing performance across the last 6 months. Use the same card style and spacing as the existing sections."*

Claude will read the current state of the artboard using `figma_get_page_nodes` and `figma_get_selection`, then build only what is missing.

---

**Ask what is available before building**

If you're not sure what components or tokens your library has, ask Claude first:

> *"Look at my design system library file and list all the available components and color token names."*

Claude will use the Figma MCP to read your library and return a structured list you can reference in follow-up prompts.

---

## The build script pattern

Every build script Claude generates follows this same structure:

```python
import urllib.request, urllib.error, json

BRIDGE   = "http://127.0.0.1:3055/execute"
FILE_KEY = "your_library_file_key"
ARTBOARD = "your_artboard_node_id"

def ex(t, p={}):
    """Send one instruction to the bridge and return the result."""
    body = json.dumps({"type": t, "params": p}).encode()
    req  = urllib.request.Request(BRIDGE, data=body,
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            d = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:    d = json.loads(e.read())
        except: raise Exception(f"HTTP {e.code}: {e.reason}")
    if not d.get("ok"):
        raise Exception(d.get("error", "unknown error"))
    return d["result"]

# Shorthand helpers
def F(name, parent, **kw):   return ex("create_frame",     {"name": name, "parentNodeId": parent, **kw})["nodeId"]
def T(txt,  parent, **kw):   return ex("create_text",      {"text": txt,  "parentNodeId": parent, **kw})["nodeId"]
def R(parent, w, h, **kw):   return ex("create_rectangle", {"width": w, "height": h, "parentNodeId": parent, **kw})["nodeId"]
def INS(nid, parent, key=None, **kw):
    p = {"nodeId": nid, "fileKey": FILE_KEY, "parentNodeId": parent, **kw}
    if key: p["componentKey"] = key
    return ex("insert_component", p)["nodeId"]
```

---

## Rules that prevent broken layouts

These patterns were discovered through iteration. Skipping them causes collapsed sections, invisible elements, or components with no content.

### Always use spacing tokens, never numbers

```python
# Wrong — creates a raw unbound value
F("Content", page, gap=24, paddingLeft=32)

# Correct — binds to the design system variable
F("Content", page, gap="spacing-3xl", paddingLeft="spacing-4xl")
```

The plugin resolves the string to a Figma variable and uses `setBoundVariable` to bind it. If you update the token in your library, the node updates automatically.

---

### Full-width containers: STRETCH + AUTO

For any container that should fill the width of its parent:

```python
F("Card", content,
  direction="VERTICAL",
  layoutAlign="STRETCH",          # fills parent width
  counterAxisSizingMode="AUTO",   # hugs content height
  primaryAxisSizingMode="AUTO")
```

---

### Horizontal rows where children split the space: FIXED

When children use `layoutGrow=1` to divide a row equally, the parent **must** have `primaryAxisSizingMode="FIXED"`. If the parent is set to hug (`AUTO`), there is no available space and all children collapse.

```python
# The row that should fill parent width AND distribute space to children
row = F("Score Cards", content,
        direction="HORIZONTAL",
        gap="spacing-2xl",
        primaryAxisSizingMode="FIXED",   # ← required for layoutGrow to work
        layoutAlign="STRETCH",
        counterAxisSizingMode="AUTO")

# Each child takes an equal share of the row's width
card = F("Score A", row,
         direction="VERTICAL",
         layoutGrow=1)
```

---

### Text nodes: layoutAlign only, no counterAxisSizingMode

`counterAxisSizingMode` is a property of frames, not text nodes. Passing it to `create_text` will crash the plugin with "object is not extensible".

```python
# Wrong
T("Body text", card, layoutAlign="STRETCH", counterAxisSizingMode="AUTO")

# Correct
T("Body text", card, layoutAlign="STRETCH")
```

---

### Component insertion: always pass the key

```python
# Without key — the bridge makes an extra REST API call (slower)
INS("1234:56789", page, width=1440)

# With key — direct import, no extra API call
INS("1234:56789", page, key="your_component_published_key_here", width=1440)
```

Hardcode your frequently used component keys in Claude's memory to avoid looking them up every time.

---

### Colors: always use variable paths

```python
# Wrong — raw hex bypasses the design system
F("Card", content, fillHex="#FFFFFF")

# Correct — bound to library variable
F("Card", content, fillVariable="Colors/Background/bg-primary")
```

---

## What you do NOT need

It is tempting to document every component into detailed JSON and Markdown specification files — buttons, cards, inputs, describing token mappings for every state and variant.

**None of this is needed for AI-generated UI.**

Claude does not need component spec files to build screens. What is actually used:

| Used | Not needed |
|---|---|
| Figma variables export (colors, spacing, radius) | Component JSON spec files |
| Structural component node IDs and published keys | Pattern specification files |
| Figma MCP to discover IDs and inspect frames | Component Markdown documentation |
| Claude memory files with variable name formats | Design token changelog entries |

The component documentation has value for design decisions, code handoff, and design review — but the AI build pipeline only needs the foundations (variable paths) and the component keys. You can skip building a full spec library if your goal is AI-generated UI.

---

## Troubleshooting

**"Figma plugin is not connected"**
→ The bridge is running but the Figma plugin is not. Go to Figma desktop → Plugins → Development → Mimic AI → Run. The bridge terminal should print "plugin connected".

**"Component not found locally and no component key was resolved"**
→ Either the library is not enabled in your file, or the component key is wrong. Check Assets → Team library to ensure your library is toggled on. Verify the component key by looking up the component in your library file.

**"object is not extensible"**
→ A frame property (like `counterAxisSizingMode`) is being passed to a text node. Text nodes only accept `layoutAlign`, `layoutGrow`, `width`, `fontSize`, `fillVariable`, etc. Remove the invalid property.

**layoutGrow has no effect — children stay small**
→ The parent's `primaryAxisSizingMode` is set to `"AUTO"` (hug). Change it to `"FIXED"`. Children can only grow into available space — if the parent hugs its content, there is no space to grow into.

**Spacing shows as a raw number instead of a variable**
→ You passed a number instead of a string. Pass `"spacing-3xl"` (string) rather than `24` (number).

**Python crashes on HTTP errors**
→ Use `except urllib.error.HTTPError as e: d = json.loads(e.read())`. The bridge returns error details in the response body, but Python's `urllib` raises an exception for non-200 status codes and hides the body unless you read it explicitly.

---

## Setup checklist

Work through this list in order:

- [ ] Claude Code installed and signed in
- [ ] Figma Personal Access Token generated
- [ ] Figma Read MCP added to `~/.claude/settings.json`
- [ ] `mimic-ai/` folder created with `package.json`
- [ ] `npm install` run inside `mimic-ai/`
- [ ] `.env` file created with Figma token and bridge port
- [ ] `bridge.js`, `mcp.js`, and `plugin/` folder created
- [ ] mimic-ai registered in `~/.claude/settings.json`
- [ ] Claude Code restarted so it picks up both MCPs
- [ ] Plugin imported into Figma from `plugin/manifest.json`
- [ ] Team library enabled in your target Figma file
- [ ] Variables exported from Figma and organised into foundation files
- [ ] Variable names and component keys saved to Claude's memory (`MEMORY.md`)
- [ ] Bridge running: `npm run bridge` in `mimic-ai/`
- [ ] Plugin running and showing **● ready** in Figma
- [ ] Ask Claude to build a UI
