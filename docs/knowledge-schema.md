# ds-knowledge.json — Schema Reference

The knowledge file (`ds-knowledge.json`) is the persistence layer for Mimic AI's learning system. It lives in the root of your `mimic-ai` installation and is updated automatically after every successful build. This file is plain JSON — you can inspect, edit, and share it freely.

---

## Top-level structure

```json
{
  "version": 1,
  "patterns": [...],
  "explicit_rules": [...],
  "updated": "2026-04-13T12:00:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `version` | number | Schema version. Always `1` for this release. |
| `patterns` | array | Component mappings — what HTML pattern maps to what DS component. |
| `explicit_rules` | array | DS structural rules — gaps, substitutions, and conventions learned over time. |
| `updated` | ISO 8601 string | Timestamp of the last write. Set automatically — do not edit manually. |

---

## Pattern entry

Each entry in `patterns` records one HTML pattern → DS component mapping.

```json
{
  "pattern_key": "metric/kpi",
  "component_key": "3iUvHvO7znmQ...",
  "component_name": "MetricCard",
  "state": "VERIFIED",
  "use_count": 5,
  "correction_count": 0,
  "last_used": "2026-04-13T12:00:00.000Z",
  "aliases": ["KPI tile", "revenue-card", "kpi-metric"],
  "dismissed_conflicts": [],
  "notes": null
}
```

| Field | Type | Description |
|---|---|---|
| `pattern_key` | string | Pattern taxonomy key (e.g. `metric/kpi`, `nav/top-bar`). See [pattern key taxonomy](#pattern-key-taxonomy). |
| `component_key` | string | The published Figma component key hash used to insert this component. Permanent — survives renames. |
| `component_name` | string | Human-readable name for inspection. Does not affect behavior. |
| `state` | enum | `CANDIDATE`, `VERIFIED`, `REJECTED`, or `EXPIRED`. See [pattern states](#pattern-states). |
| `use_count` | number | How many times this mapping was used. Auto-incremented each run. |
| `correction_count` | number | How many times the user corrected this mapping. A correction demotes `VERIFIED` → `CANDIDATE`. |
| `last_used` | ISO 8601 string | Timestamp of the last run that used this entry. |
| `aliases` | array of strings | Exact HTML labels that previously triggered this mapping — class names, element text content, or semantic role text. Added automatically by Phase 7 via `add_alias`. Used in Phase 3 step 0.5 for deterministic matching before LLM classification runs. Safe to edit manually: add known synonyms your HTML uses, or remove incorrect ones. |
| `dismissed_conflicts` | array of strings | Component keys the user has acknowledged as not a conflict. |
| `notes` | string or null | Free-text annotation. Safe to edit manually. |

### Pattern states

| State | Meaning | Effect on next run |
|---|---|---|
| `CANDIDATE` | Used 1–2 times with no corrections, or use_count reset by correction. | DS lookup runs but stored `component_key` is used as the expected answer. |
| `VERIFIED` | Used ≥ 3 times with `correction_count = 0`. | DS lookup is skipped entirely — `component_key` is used directly. This is the main performance gain. |
| `REJECTED` | User explicitly marked this mapping as wrong. | Never used. DS lookup runs and finds the component from scratch. |
| `EXPIRED` | Component key is no longer valid (e.g. component deleted from the library). | Treated as a new pattern. |

**Promotion is automatic:** when `use_count` reaches 3 and `correction_count` is 0, the MCP promotes the entry to `VERIFIED` on the next write.

**Demotion on correction:** when the user tells Claude a component was wrong, `correction_count` is incremented and the state is demoted from `VERIFIED` to `CANDIDATE`.

---

## Explicit rule entry

Each entry in `explicit_rules` records a structural DS insight: a gap (no component exists for a pattern), a substitution (a different component is being used as a stand-in), or a convention (a DS usage rule that should always be applied).

```json
{
  "rule_key": "label/chip",
  "type": "gap",
  "state": "active",
  "substitution_key": "xyz789...",
  "substitution_name": "Badge",
  "reason": "No chip component in DS — Badge used as nearest semantic equivalent",
  "seen_count": 4,
  "first_seen": "2026-03-01T09:00:00.000Z",
  "last_seen": "2026-04-13T12:00:00.000Z",
  "dismissed": false,
  "notes": null
}
```

| Field | Type | Description |
|---|---|---|
| `rule_key` | string | Same taxonomy key as pattern entries. Must match `category/name` format. |
| `type` | enum | `gap`, `substitution`, or `convention`. See [rule types](#rule-types). |
| `state` | enum | `active` or `resolved`. See [rule states](#rule-states). |
| `substitution_key` | string or null | Component key used as a stand-in when type is `substitution`. |
| `substitution_name` | string or null | Human-readable name of the substitution component. |
| `reason` | string or null | Why this rule exists. Written by Claude during gap detection. Safe to edit. |
| `seen_count` | number | How many runs encountered this pattern with no DS component. Drives escalation to a DS recommendation. |
| `first_seen` | ISO 8601 string | When this gap was first detected. |
| `last_seen` | ISO 8601 string | When this gap was most recently encountered. |
| `dismissed` | boolean | If `true`, this rule is excluded from all future DS recommendations. Set to `true` if you have decided to leave the gap unresolved. |
| `notes` | string or null | Free-text annotation. Safe to edit. |

### Rule types

| Type | Meaning |
|---|---|
| `gap` | No DS component exists for this pattern. Mimic AI builds from primitives or uses a substitution. |
| `substitution` | No exact DS match exists, but a structurally similar component is being used instead. The `substitution_key` field holds the component used. |
| `convention` | A DS usage rule discovered during a run (e.g. "always use the 'filled' variant for primary buttons, never 'solid'"). Applied automatically on future runs. |

### Rule states

| State | Meaning |
|---|---|
| `active` | Rule is in effect. Applied on every run. |
| `resolved` | The DS situation changed (e.g. a component was added). On the next run, Mimic AI runs a fresh DS search for this pattern instead of applying the rule. If a component is found, the pattern gets a new `patterns` entry. If still not found, the rule returns to `active`. |

---

## DS recommendations

When `seen_count` reaches 3 for a `gap` or `substitution` rule, Mimic AI surfaces it as a DS recommendation in the run report and the Phase 8 learning summary. This means the pattern appeared in 3 separate builds with no DS component — a strong signal that the DS may benefit from adding one.

To permanently suppress a recommendation you have acknowledged and decided not to act on, set `"dismissed": true` on the rule entry.

---

## Manual edits

The knowledge file is safe to edit manually. Common reasons:

- **Demote a VERIFIED entry you know is wrong:** set `"state": "CANDIDATE"` and `"correction_count": 1`.
- **Remove a bad entry entirely:** delete the object from the `patterns` array.
- **Inject a known component key:** add a `patterns` entry with `"state": "VERIFIED"` and the correct `component_key`. Mimic AI will use it on the next run without any DS lookup.
- **Seed aliases for faster matching:** add known HTML labels to the `aliases` array of any entry. For example, if your team's HTML always uses `class="kpi-tile"` for metric cards, add `"kpi-tile"` to the `metric/kpi` entry's aliases. On the next run, that node resolves instantly with zero reads and no LLM classification.
- **Dismiss a gap recommendation:** set `"dismissed": true` on the rule entry.
- **Reset a gap's seen count after adding the missing component to your DS:** set `"seen_count": 0` and `"state": "resolved"` on the rule entry. On the next run, Mimic AI searches the DS fresh and, if it finds the new component, creates a pattern entry.
- **Share knowledge across a team:** the file is plain JSON — commit it to your repository. Team members who pull it start with your accumulated mappings already in place.

---

## Pattern key taxonomy

Pattern keys follow the format `category/name`. Keys must come from the canonical taxonomy defined in `docs/mimic-ai.md` (Pattern key taxonomy section). Common examples:

| Key | Meaning |
|---|---|
| `nav/top-bar` | Horizontal top navigation bar |
| `nav/sidebar` | Vertical sidebar |
| `metric/kpi` | KPI card |
| `card/content` | General content card |
| `table/row` | Data table row |
| `form/button-primary` | Primary action button |
| `label/badge` | Status or count badge |
| `chart/bar` | Bar chart |
| `layout/page-header` | Page-level header section |

Do not invent keys outside the taxonomy — mismatched keys produce `key_warnings` in the write response and must be corrected immediately.
