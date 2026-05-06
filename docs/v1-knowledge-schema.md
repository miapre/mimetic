# ds-knowledge.json: Schema Reference (V2)

The knowledge file (`ds-knowledge.json`) is Mimic AI's persistent learning layer. It lives in your `mimic-ai` installation root and is updated automatically after every build. Plain JSON. Inspect, edit, and share freely.

---

## Top-level structure

```json
{
  "version": 2,
  "patterns": [...],
  "explicit_rules": [...],
  "gaps": {...},
  "catalog": {...},
  "meta": {
    "schema_version": 2,
    "total_patterns": 12,
    "verified_patterns": 8
  },
  "updated": "2026-04-18T02:00:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `version` | number | Schema version. Current: `2`. V1 files are auto-migrated on load. |
| `patterns` | array | Component mappings: HTML pattern → DS component. |
| `explicit_rules` | array | DS structural rules: gaps, substitutions, conventions. |
| `gaps` | object | DS gap tracker. Components your DS is missing, accumulated across builds. |
| `catalog` | object | Cached DS inventory for warm-cache builds. |
| `meta` | object | Counts and diagnostics. |
| `updated` | ISO 8601 | Last write timestamp. Set automatically. |

---

## Pattern entry (V2)

Each entry records one HTML pattern → DS component mapping with provenance, confidence, and an optional configuration recipe.

```json
{
  "pattern_key": "form/button-primary",
  "component_key": "aa5d038...",
  "component_name": "Buttons/Button",
  "state": "VERIFIED",
  "use_count": 5,
  "correction_count": 0,
  "last_used": "2026-04-18T02:00:00.000Z",
  "dismissed_conflicts": [],
  "notes": null,
  "confidence": 0.9,
  "source": "user_correction",
  "valid_until": null,
  "supersedes": [],
  "configuration_recipe": {
    "text_overrides": { "Text": "{from_html}" },
    "hidden_slots": ["Icon leading"],
    "badge_colors": {}
  },
  "variant": "Size=md, Hierarchy=Primary, Icon=Default, State=Default",
  "props_mapping": { "Hierarchy": "Primary" },
  "signature": "button.cta",
  "scope": "project",
  "examples": [{ "html_snippet": "<button class='cta'>Get started</button>" }],
  "last_validated": "2026-04-18T02:00:00.000Z"
}
```

### V2 fields

| Field | Type | Description |
|---|---|---|
| `confidence` | float | 0.0–1.0. User corrections: 0.9. Auto-inferred: 0.5. Auto-promoted: 0.8. |
| `source` | enum | `user_correction`, `user_confirmation`, `auto_inferred`, `auto_promoted` |
| `valid_until` | ISO 8601 or null | Null = active. Set when superseded or invalidated (DS changed). |
| `supersedes` | array | IDs of patterns this one replaces. Enables audit trail. |
| `configuration_recipe` | object or null | Full configuration replay: text overrides by node name, hidden slots, badge colors. Eliminates component re-inspection on warm builds. |
| `variant` | string or null | Exact variant name string for the component. |
| `props_mapping` | object or null | Properties to set via `setProperties()`. |
| `signature` | string | HTML pattern signature: tag + classes + key attributes. |
| `scope` | enum | `project`, `user`, `global`. Scopes cascade: project → user → global. |
| `examples` | array | HTML snippets and build references. Kept to last 10. |
| `last_validated` | ISO 8601 or null | When the component key was last verified against the live DS. |

### Confidence thresholds

| Threshold | Meaning |
|---|---|
| ≥ 0.8 | Eligible for warm-cache use (skip DS search, validate key only) |
| ≥ 0.5 | Used if no better match, shown in reports |
| < 0.3 after 5 builds | Auto-expires (valid_until set) |

### Pattern states

| State | Effect |
|---|---|
| `CANDIDATE` | DS lookup runs. Cached key is the expected answer. |
| `VERIFIED` | DS lookup skipped. Key validated via import, then used directly. |
| `REJECTED` | Never used. Fresh DS search runs. |
| `EXPIRED` | Component key no longer valid. Treated as new pattern. |

**Promotion:** `use_count` ≥ 3 with `correction_count` = 0 → auto-promote to VERIFIED, confidence raised to 0.8.

**Demotion:** User correction → `correction_count` incremented, VERIFIED → CANDIDATE, confidence reduced.

**Invalidation:** If `importComponentByKeyAsync(key)` fails or the target variant no longer exists, `valid_until` is set and the pattern is re-discovered from the live DS. The DS is always the source of truth. Cache is acceleration, never authority.

---

## Configuration recipes

A recipe records how a component was correctly configured. On warm builds, Mimic replays the recipe instead of re-inspecting the component's internal structure.

```json
{
  "text_overrides": { "Text": "{from_html}", "Supporting text": "{from_html}" },
  "hidden_slots": ["Icon leading", "Description"],
  "badge_colors": { "Badge": "Success" },
  "boolean_props": { "Back btn": false, "Badges": false }
}
```

Recipes are invalidated when the component or variant changes in the DS.

---

## Gap tracker

Tracks DS components that are missing: elements Mimic builds as primitives because no component exists.

```json
{
  "status_badge": {
    "id": "status_badge",
    "description": "No DS component for status badges with semantic color variants",
    "affected_elements": 6,
    "first_seen": "2026-04-17",
    "builds_affected": ["build-004", "build-005"],
    "recommendation": "Add a Badge component with Error, Warning, Active, Pending colors",
    "resolved": false
  }
}
```

When a new DS component fills the gap, `resolved` is set to `true` and Mimic surfaces it: "Your DS now has [component]. Using it where I previously used primitives."

---

## Catalog

Cached DS inventory from searches. Used for warm-cache Phase 1.

```json
{
  "componentSets": [
    { "key": "...", "name": "Buttons/Button", "description": "...", "variants": [...] }
  ],
  "last_refreshed": "2026-04-18T02:00:00.000Z"
}
```

Refreshed when the DS file's `lastModified` is newer than `last_refreshed`, or after 7 days.

---

## Explicit rule entry

Unchanged from V1. Records DS structural insights: gaps, substitutions, conventions.

```json
{
  "rule_key": "label/chip",
  "type": "gap",
  "state": "active",
  "substitution_key": "xyz789...",
  "substitution_name": "Badge",
  "reason": "No chip component in DS. Badge used as nearest equivalent",
  "seen_count": 4,
  "first_seen": "2026-03-01T09:00:00.000Z",
  "last_seen": "2026-04-18T02:00:00.000Z",
  "dismissed": false,
  "notes": null
}
```

| Type | Meaning |
|---|---|
| `gap` | No DS component exists. Built from primitives or substitution. |
| `substitution` | Similar component used as stand-in. |
| `convention` | DS usage rule (e.g. "always use filled variant for primary buttons"). |

---

## V1 → V2 migration

Automatic on first load. V1 patterns get defaults:
- `confidence`: 0.8 (VERIFIED) or 0.5 (CANDIDATE)
- `source`: `user_correction` (if correction_count > 0) or `auto_inferred`
- `valid_until`: null
- All other V2 fields: null or empty

No data is lost. V1 files continue to work. They are upgraded transparently.

---

## Manual edits

Safe to edit. Common operations:

- **Inject a known mapping:** Add a pattern with `"state": "VERIFIED"`, `"confidence": 0.9`, and the correct `component_key`. Used on next build without DS lookup.
- **Add a configuration recipe:** Save the exact text overrides, hidden slots, and badge colors. Eliminates component inspection.
- **Dismiss a gap:** Set `"resolved": true` on the gap entry, or `"dismissed": true` on the explicit rule.
- **Reset after DS update:** Set `"valid_until": now` on stale patterns. Mimic re-discovers on next build.
- **Share across a team:** Copy `ds-knowledge.json` into your team's shared repo or Slack channel. Team members place it at the root of their Mimic installation to start with your accumulated knowledge. Note: the file is gitignored by default in the Mimic repo itself. This is about sharing it in *your project's* repo if you choose to.
