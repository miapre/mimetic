# Mimic AI — Golden Rules

15 rules. These govern every build.

---

## Structural

### 1. DS first

If the design system has a component for the element, use it. Intent over pixel-matching. A header component is a header, even if the layout doesn't match exactly.

### 2. DS-only values

Every text node uses a DS text style and DS color variable. Every fill uses a DS color variable. No raw hex, no raw font properties. When the DS lacks styles or variables, accept raw values and flag every instance in the report.

### 3. DS-agnostic

Zero hardcoded references to any specific design system in code. No "Untitled UI" strings, no "Material" assumptions. The system works with whatever library is enabled on the target file.

### 4. Auto-layout everywhere

Every frame uses auto-layout. Widths are FILL (expand to parent). Heights are HUG (shrink to content). Fixed width only on the artboard (1440px). Cards in a row: all FILL. Table columns: at least one FILL.

### 5. HTML fidelity

Same text, same structure, same order as the source HTML. Content comes from the HTML, not from memory, not improved, not invented. If the HTML says "Acme Corp", the artboard says "Acme Corp".

### 6. Learning loop

Every build generates knowledge: component recipes, pattern mappings, icon associations, gap evidence. Corrections become permanent rules. Three uncorrected builds auto-promote a pattern. The tenth build is faster than the first.

### 7. Transparency

Every decision is traceable. Every component match cites its source and confidence band. Every primitive explains what was searched and why nothing matched. The build report shows what was learned and what the DS is missing.

### 8. Graceful failure

When something fails, stop and report honestly. State what failed, what was tried, and what to do next. No euphemisms, no silent retries, no inventing workarounds that compromise DS compliance.

---

## Operational

### 9. Sequential component imports

Import components one at a time. Each import is validated before the next begins. Batch imports cause silent failures in the Figma Plugin API.

### 10. Artboard placement

New artboards go at the rightmost existing artboard's x + width + 80px. Empty page: x=0, y=0. Predictable, no overlaps.

### 11. Never delete artboards

User feedback means editing the existing artboard in place. New artboards are only for new screens. Deletion destroys context and breaks the user's spatial memory.

### 12. Multi-page HTML

When the HTML contains multiple views, list them and let the user choose. Build one artboard at a time. Patterns from earlier artboards apply to later ones. Show the improvement.

### 13. Component configuration

Every inserted component goes through the full 7-step process: insert, inspect structure, override all text, set semantic properties, configure icons, hide unused slots, verify no placeholders remain. A component with default text is worse than a well-built primitive.

### 14. Hide unused icon slots

After inserting any component, set every unused boolean icon property to false. No placeholder icons may remain visible. If the DS has an icon library, search and swap. If not, hide and flag.

### 15. Text from HTML source only

Every text string in the artboard comes from the HTML being built. Never from memory, never from a previous build, never generated. If the HTML doesn't have it, the artboard doesn't have it.
