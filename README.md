# Mimic AI

**Learns your design system. Builds with it. Gets better every time.**

Give it any HTML. It builds the equivalent in Figma using only your design system:

- Your real components — not blue rectangles
- Your real tokens — not hardcoded hex values
- Your real text styles — not raw font sizes
- Auto-layout everywhere — not fixed frames

Correct it once, it remembers. After every build, it tells you what your DS is missing.

---

You built a design system. Every token, every component, every variable — intentional. Then someone needs a screen and builds it from scratch. Your system sits right there in the library panel. Unused.

AI tools make it worse. They generate frames that look right but fall apart on inspection — no components, no tokens, no auto-layout. The cleanup takes as long as building it yourself.

Mimic doesn't approximate your design system. It uses it.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js: v20.6+](https://img.shields.io/badge/node-%3E%3D20.6-brightgreen)
![Platform: macOS / Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
[![Glama](https://glama.ai/mcp/servers/@miapre/mimic-ai/badge)](https://glama.ai/mcp/servers/@miapre/mimic-ai)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_MCP-0078d4?logo=visualstudiocode&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22mimic-ai%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40miapre%2Fmimic-ai%22%5D%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_MCP-24bfa5?logo=visualstudiocode&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22mimic-ai%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40miapre%2Fmimic-ai%22%5D%7D)

> Open-source MCP server. Runs locally — your design data never leaves your machine.

---

<!-- TODO: GIF showing same HTML → different DS = different Figma output -->

---

## It learns — and it keeps learning

The first build is a discovery — Mimic scans your library and maps everything it can find. By the third build, recurring patterns auto-verify. By the tenth, most decisions are instant. The knowledge compounds across every build you do.

**Correct it once.** Tell Mimic *"That's not the right Badge — use Tag/Neutral"* and the mapping updates permanently. Every future build uses the correction without you having to repeat yourself.

**Your DS is alive. Mimic knows that.** Design systems evolve — new components get published, tokens get renamed, variants change. Mimic detects this at the start of every build. New components surface automatically. Renamed tokens re-map. Removed components fall back gracefully with an explanation. You never have to tell Mimic your DS changed — it checks every time.

**Every build is a DS review.** After each build, Mimic generates a report: what components it used, what it built from primitives and why, what patterns it learned, and what your DS is missing. Recommendations come as questions, not commands — *"Should your DS include a Tab component? 4 elements across 3 builds were built as primitives."* Ask Mimic to save the report as an HTML or markdown file, and you have a shareable DS audit your team can act on.

**DS maintenance on autopilot.** Over time, Mimic's build reports become a living record of your system's gaps. Components that keep getting requested but don't exist. Tokens that would eliminate raw values. Patterns that should be standardized. You don't have to audit your DS manually — every build does it for you, while respecting your Figma token usage by caching aggressively and minimizing library reads.

**Make your DS ready for what's coming.** The tools around your design system are changing fast. Figma Make generates designs by picking components based on their descriptions — the better your descriptions, the better its output. Stitch reads your library metadata to generate full screens. Generative UI — where interfaces assemble themselves from your component library in real time — is already production-ready, but it only works when components have clear descriptions, semantic roles, and structured metadata.

Most design systems aren't there yet. Mimic helps close that gap in two ways:

1. **Component descriptions from usage.** Mimic tracks how your components actually get used across builds — which variants, in which contexts, for what purpose. A Button used 40 times as a primary CTA across 12 builds? That's a description writing itself. Ask Mimic to suggest descriptions, review them, and add them to your library.

2. **DESIGN.md generation.** Mimic can generate a DESIGN.md file from your DS — the open format for describing a design system to AI tools. It includes your color tokens, typography scale, spacing, radius, and component patterns. Stitch, Cursor, Copilot, generative UI frameworks, and any AI tool that reads this format produces on-brand output from your DS.

Better-documented components mean better results from Figma Make, Stitch, generative UI, and every AI-powered design tool that comes next.

---

## Beyond HTML — vibe design with your DS

You don't always have an HTML prototype. Sometimes you just know what you need.

> *"Build a system dashboard with user metrics, a recent activity table, and a status overview."*

Mimic generates the layout, picks the right components from your library, applies your tokens, and delivers a DS-compliant screen. Like vibe coding, but the output is a real Figma file your team can iterate on — built entirely from your design system.

Describe a screen. Get a design. Every element traceable to your DS.

---

## What other tools get wrong

Other AI tools can put frames on a Figma canvas. But look closer:

| | Other tools | Mimic |
|---|---|---|
| **Components** | Draws rectangles that look like buttons | Inserts your real Button with the right variant, size, and state |
| **Colors** | Hardcodes hex values | Binds your color variables — update the token, every node updates |
| **Typography** | Sets font size and weight manually | Applies your text styles — your typeface, your scale, one source of truth |
| **Spacing** | Pixel values everywhere | Binds your spacing tokens where available |
| **Layout** | Fixed frames, manual positioning | Auto-layout on everything — resize the artboard and content reflows |
| **After the build** | You spend an hour swapping in real components and fixing tokens | You hand it to your team. It's ready. |

Screenshot-to-Figma tools are even worse — they capture pixels, not structure. The result is a flat image you can't iterate on. Mimic reads the semantic HTML and produces structured, layered Figma that designers can actually work with.

---

## Works with any design system

| DS type | What Mimic does |
|---|---|
| **Team library** (components + tokens) | Uses everything — components, text styles, color, spacing, and radius variables |
| **Team library** (components only) | Uses every available component. Flags missing tokens in the build report. |
| **Community library** (Material UI, HeroUI, iOS kits) | Full support — components and variables both work out of the box |

---

## Get started

> [Node.js](https://nodejs.org/) v20.6+, [Figma desktop](https://www.figma.com/downloads/), Professional plan or above.

### 1. Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/miapre/mimic-ai/main/install.sh)
```

### 2. Add the Figma plugin

**Plugins → Development → Import plugin from manifest** → select `~/mimic-ai/plugin/manifest.json`

### 3. Connect (each session)

Terminal:
```bash
cd ~/mimic-ai && npm run bridge
```

Figma: **Plugins → Development → Mimic AI → Run**

### 4. Enable your design system

Assets panel → Team library icon → toggle on. Once per file. Community libraries work out of the box.

### 5. Build

> *"Build this HTML in Figma. Use my design system."*

---

## What gets checked — automatically

Mimic runs 46 quality rules on every build. You don't configure them. You don't invoke them. They just run.

- Text nodes use your text styles — not raw font properties
- Colors bound to your variables — not hardcoded
- Spacing bound to your tokens where available
- Every frame uses auto-layout — resizable, not static
- Content matches the source exactly — nothing invented
- Your components used wherever a match exists
- Charts built with real data and auto-layout — not placeholder shapes
- Build report with learning summary and DS gap recommendations

The output is what you'd build yourself if you had the patience. Except Mimic does it in minutes and tells you what your DS is missing at the end.

Full specification: [`GOLDEN_RULES.md`](GOLDEN_RULES.md)

---

## MCP client setup

Works with any MCP client. Optimized for **Claude Code**.

<details>
<summary><strong>Claude Code</strong></summary>

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

Add to `.cursor/mcp.json`:

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
<summary><strong>VS Code</strong></summary>

Click the install badge above, or add to settings:

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
<summary><strong>Windsurf / JetBrains</strong></summary>

Windsurf: `~/.codeium/windsurf/mcp_config.json`
JetBrains: Settings → Tools → AI Assistant → MCP Servers

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

All clients need the bridge running and the Figma plugin active.

---

<details>
<summary><strong>How it works</strong></summary>

Your AI assistant talks to Mimic. Mimic talks to Figma. Everything happens locally.

- **Building is unlimited** — frames, components, and token bindings have no rate limit
- **Inspecting is limited** — reading your library uses Figma's daily quota. Mimic caches aggressively to stay well under.
- **Token bindings are real** — update a variable in your DS, re-publish, every node updates automatically
- **Auto-layout everywhere** — every frame resizes correctly. Nothing is manually positioned.

</details>

<details>
<summary><strong>35 tools available</strong></summary>

**Status & learning:** `mimic_status`, `mimic_discover_ds`, `mimic_ai_knowledge_read`, `mimic_ai_knowledge_write`

**DS setup:** `figma_preload_styles`, `figma_preload_variables`, `figma_set_session_defaults`, `figma_list_text_styles`, `figma_read_variable_values`

**Build:** `figma_create_frame`, `figma_create_text`, `figma_create_rectangle`, `figma_create_chart`, `figma_insert_component`, `figma_batch`

**Edit:** `figma_set_component_text`, `figma_set_text`, `figma_set_node_fill`, `figma_set_layout_sizing`, `figma_set_variant`, `figma_set_visibility`, `figma_swap_main_component`, `figma_replace_component`, `figma_move_node`, `figma_delete_node`

**Inspect & QA:** `figma_get_node_props`, `figma_get_node_children`, `figma_get_node_parent`, `figma_get_text_info`, `figma_get_component_variants`, `figma_get_selection`, `figma_select_node`, `figma_get_page_nodes`, `figma_get_pages`, `figma_change_page`, `figma_validate_ds_compliance`

</details>

<details>
<summary><strong>Figma setup details</strong></summary>

**Desktop app required** — browser Figma won't work. [Download](https://www.figma.com/downloads/)

**Personal Access Token** — Figma → Profile → Settings → Personal access tokens → Generate. Read access. Copy immediately.

**Publish your DS** — components and tokens in a separate file, published as a team library. Re-publish after changes.

**Professional plan or above** — free plan can't publish libraries.

</details>

---

## Privacy

Everything runs on your machine. No design data, component names, token values, or HTML content is sent anywhere. The only outbound call is to the Figma REST API for published component keys.

---

## Cost & efficiency

Mimic runs on your AI plan. Every build uses tool calls and tokens. The learning loop isn't just about quality — it's about cost.

| Build | Tool calls | Why |
|---|---|---|
| 1st (cold) | ~140 | Full DS discovery, no cache, every pattern new |
| 5th (warm) | ~80 | Most patterns cached, discovery skipped for known components |
| 10th+ (hot) | ~55 | Nearly everything cached, decisions instant |

**What drives cost down:**
- **Cache** — every pattern Mimic learns skips a DS search next time
- **DS components** — inserting a component = ~3 calls. Building the same thing from primitives = ~10-15 calls
- **DS gap recommendations** — when Mimic suggests a component, it's also telling you how to make future builds cheaper

**What you can do:**
- Add components Mimic recommends — fewer primitive builds, fewer calls
- Build similar screens in sequence — patterns transfer, cache warms fast
- Use strict DS mode — fewer QA fix passes, fewer calls

Every build report includes tool call counts and efficiency savings.

---

## Constraints

- **Figma Professional plan required** — free plan can't publish libraries
- **First-build font caching** — text styles may need a second build to render correctly
- **npx mode** — doesn't set `FIGMA_ACCESS_TOKEN`. Use the full installer for team library support
- **Claude-optimized** — the 46-rule governance and learning reports work best with Claude Code. Other MCP clients get the tools but may not follow the full protocol

---

## License

MIT
