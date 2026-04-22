/**
 * HTML to Figma — Design System — plugin worker (code.js)
 *
 * Runs in the Figma plugin sandbox. Receives instructions from the bridge
 * via the UI iframe (WebSocket → postMessage) and executes them against
 * the Figma Plugin API.
 */

// Show the UI panel (hidden by default — only needed for the WebSocket connection).
figma.showUI(__html__, { visible: true, width: 120, height: 28 });

// ---------------------------------------------------------------------------
// Variable resolution cache
// ---------------------------------------------------------------------------

let variableCache = null; // Map<name, Variable>
const styleCache = new Map(); // Map<styleKey, figmaStyleId> — preloaded DS styles

// Session defaults — set once per build via set_session_defaults instruction.
// These get applied automatically when no explicit value is provided.
// DS-agnostic: the orchestrator discovers the right keys from the DS knowledge layer.
var sessionDefaults = {
  textFillStyleKey: null,   // Applied to text when no fillStyleKey/fillVariable/fills provided
  textFillVariable: null,   // Alternative to textFillStyleKey — DS variable path for default text fill. Used when DS has variables but no color styles (e.g., community libraries).
  frameFillStyleKey: null,  // NOT auto-applied — frames often have no fill intentionally
  strokeStyleKey: null,     // NOT auto-applied
  fontFamily: null,          // No default — set via set_session_defaults or auto-detected from first text style import. DS-agnostic: never hardcode a font family.
  dsMode: 'permissive',     // 'strict' = DS references required, raw values rejected. 'permissive' = raw fallbacks allowed. Set to 'strict' via set_session_defaults when DS is connected.
};

async function getVariableByPath(path) {
  if (!variableCache) {
    const vars = await figma.variables.getLocalVariablesAsync();
    variableCache = new Map(vars.map(v => [v.name, v]));
  }

  if (variableCache.has(path)) return variableCache.get(path);

  // Library variable import: walk team library collections to find by name
  // Time-bounded to prevent hanging when library walk is slow
  try {
    const result = await Promise.race([
      (async () => {
        const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
        for (const col of collections) {
          const libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(col.key);
          for (const lv of libVars) {
            // Match exact name, or match after stripping parenthetical suffixes
            // e.g., "Colors/Text/text-primary (900)" matches query "Colors/Text/text-primary (900)"
            // AND "Colors/Text/text-primary" matches "Colors/Text/text-primary (900)"
            const nameBase = lv.name.replace(/\s*\([^)]*\)\s*$/, '');
            const pathBase = path.replace(/\s*\([^)]*\)\s*$/, '');
            if (lv.name === path || nameBase === path || lv.name === pathBase || nameBase === pathBase) {
              const imported = await figma.variables.importVariableByKeyAsync(lv.key);
              variableCache.set(path, imported);
              // Also cache the base name so future lookups without parenthetical work
              if (nameBase !== path) variableCache.set(nameBase, imported);
              return imported;
            }
          }
        }
        return null;
      })(),
      new Promise((resolve) => setTimeout(() => resolve(null), 30000)),
    ]);
    if (result) return result;
  } catch (_) {
    // teamLibrary API not available or timed out — silent fallback
  }

  // Mark as not found so we don't retry
  variableCache.set(path, null);
  return null;
}

// Apply a spacing value to a node property — accepts either a number (px) or
// a variable path string (e.g. "spacing-3xl"). Binds the variable when resolved.
// In strict mode: string paths are required, raw numbers are rejected.
async function applySpacing(node, prop, value) {
  if (typeof value === 'string') {
    const variable = await getVariableByPath(value);
    if (variable) { node.setBoundVariable(prop, variable); return; }
    // Variable path not found
    if (sessionDefaults.dsMode === 'strict') {
      throw new Error(
        `DS_VARIABLE_NOT_FOUND: Spacing variable "${value}" not found for property "${prop}". ` +
        `In strict mode, raw px fallback is not allowed.`
      );
    }
    const n = parseFloat(value);
    if (!isNaN(n)) node[prop] = n;
  } else if (typeof value === 'number') {
    if (sessionDefaults.dsMode === 'strict') {
      throw new Error(
        `DS_STRICT_VIOLATION: Raw px value ${value} provided for "${prop}". ` +
        `In strict mode, spacing must use DS variable paths (e.g., "spacing-3xl"). ` +
        `Provide a variable path or switch to permissive mode.`
      );
    }
    node[prop] = value;
  }
}

// Apply a fill (solid color) to a node using a DS variable.
// In strict mode: variable is required, hex fallback is rejected.
// In permissive mode: hex fallback is allowed (for component-only DSs without tokens).
// Returns { bound: true/false, method: 'variable'|'raw_fallback'|'none' }
async function applyFill(node, variablePath, hexFallback) {
  if (variablePath) {
    const variable = await getVariableByPath(variablePath);
    if (variable) {
      const boundPaint = figma.variables.setBoundVariableForPaint(
        { type: 'SOLID', color: { r: 1, g: 1, b: 1 } },
        'color',
        variable
      );
      node.fills = [boundPaint];
      return { bound: true, method: 'variable' };
    }
    // Variable path was provided but not found
    if (sessionDefaults.dsMode === 'strict') {
      throw new Error(
        `DS_VARIABLE_NOT_FOUND: Fill variable "${variablePath}" not found. ` +
        `In strict mode, raw hex fallback is not allowed. ` +
        `Check the variable path or run discover_ds to refresh.`
      );
    }
  }
  if (hexFallback) {
    if (sessionDefaults.dsMode === 'strict' && !variablePath) {
      throw new Error(
        `DS_STRICT_VIOLATION: Raw hex fill "${hexFallback}" provided without a variablePath. ` +
        `In strict mode, all fills must use DS variables. ` +
        `Provide a variablePath or switch to permissive mode.`
      );
    }
    node.fills = [{ type: 'SOLID', color: hexToRgb(hexFallback) }];
    return { bound: false, method: 'raw_fallback' };
  }
  // Neither provided — leave fills as-is
  return { bound: false, method: 'none' };
}

// Apply a stroke to a node using a DS variable.
// Same strict/permissive behavior as applyFill.
async function applyStroke(node, variablePath, hexFallback, width) {
  if (variablePath) {
    const variable = await getVariableByPath(variablePath);
    if (variable) {
      const boundPaint = figma.variables.setBoundVariableForPaint(
        { type: 'SOLID', color: { r: 0, g: 0, b: 0 } },
        'color',
        variable
      );
      node.strokes = [boundPaint];
      node.strokeWeight = width !== undefined && width !== null ? width : 1;
      node.strokeAlign = 'INSIDE';
      return;
    }
    // Variable path was provided but not found
    if (sessionDefaults.dsMode === 'strict') {
      throw new Error(
        `DS_VARIABLE_NOT_FOUND: Stroke variable "${variablePath}" not found. ` +
        `In strict mode, raw hex fallback is not allowed.`
      );
    }
  }
  if (hexFallback) {
    if (sessionDefaults.dsMode === 'strict' && !variablePath) {
      throw new Error(
        `DS_STRICT_VIOLATION: Raw hex stroke "${hexFallback}" provided without a variablePath. ` +
        `In strict mode, all strokes must use DS variables.`
      );
    }
    node.strokes = [{ type: 'SOLID', color: hexToRgb(hexFallback) }];
    node.strokeWeight = width !== undefined && width !== null ? width : 1;
    node.strokeAlign = 'INSIDE';
  }
}

// Apply a DS color style to a node's fill or stroke.
// Uses preloaded cache first (instant), falls back to live import with timeout.
async function applyColorStyle(node, target, styleKey) {
  if (!styleKey) return false;

  // Check preloaded cache first — instant, no async
  const cachedId = styleCache.get(styleKey);
  if (cachedId) {
    try {
      if (target === 'fill') node.fillStyleId = cachedId;
      else if (target === 'stroke') node.strokeStyleId = cachedId;
      return true;
    } catch (_) { /* cached ID invalid — fall through to import */ }
  }

  // Live import with timeout
  try {
    const imported = await Promise.race([
      figma.importStyleByKeyAsync(styleKey),
      new Promise((_, reject) => setTimeout(() => reject(new Error('color style timeout')), 20000)),
    ]);
    if (imported && imported.id) {
      styleCache.set(styleKey, imported.id); // cache for future use
      if (target === 'fill') node.fillStyleId = imported.id;
      else if (target === 'stroke') node.strokeStyleId = imported.id;
      return true;
    }
  } catch (e) { /* import failed or timed out */ }
  return false;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

// Apply layout sizing to a node within an auto-layout parent.
// Returns a warning string if layoutGrow is used inside a HUG parent, null otherwise.
function applyLayoutSizing(node, params) {
  var warning = null;
  if (params.layoutGrow !== undefined) {
    // Warn if parent uses HUG — layoutGrow distributes remaining space, but HUG has none
    try {
      if (node.parent && node.parent.primaryAxisSizingMode === 'AUTO') {
        warning = 'layoutGrow=' + params.layoutGrow + ' in HUG parent — child may collapse to 0px. Use explicit FIXED widths or switch parent to FIXED sizing.';
      }
    } catch (_) {}
    node.layoutGrow = params.layoutGrow;
  }
  if (params.layoutAlign)              node.layoutAlign = params.layoutAlign;
  if (params.primaryAxisSizingMode)    node.primaryAxisSizingMode = params.primaryAxisSizingMode;
  if (params.counterAxisSizingMode)    node.counterAxisSizingMode = params.counterAxisSizingMode;
  return warning;
}

// Find a text node by name within a subtree.
function findTextNode(root, name) {
  if (root.type === 'TEXT' && (!name || root.name === name)) return root;
  if ('children' in root) {
    for (const child of root.children) {
      const found = findTextNode(child, name);
      if (found) return found;
    }
  }
  return null;
}

// Font weight → style mapping. Works for Inter and most standard font families.
// Fonts with non-standard style names (e.g., "SemiBold" vs "Semi Bold") may need
// the DS to use text styles instead of raw font weights.
const FONT_STYLES = {
  400: 'Regular',
  500: 'Medium',
  600: 'Semi Bold',
  700: 'Bold',
};

async function loadFont(weight) {
  // Use DS font from session defaults — never hardcode a specific font family.
  // If no default is set, fall back to 'Inter' as a last resort (Figma ships it).
  var family = sessionDefaults.fontFamily || 'Inter';
  await figma.loadFontAsync({ family: family, style: FONT_STYLES[weight] || 'Regular' });
}

// ---------------------------------------------------------------------------
// Instruction handlers
// ---------------------------------------------------------------------------

async function handleInsertComponent(params) {
  let component = null;

  // Import timeout — prevents indefinite hangs when Figma API is unresponsive.
  // Normal imports complete in <2s. Cold start with large libraries (3+ DSs enabled)
  // can take 30-45s on first import. 60s covers the worst case.
  const IMPORT_TIMEOUT_MS = 60000;

  function withTimeout(promise, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${IMPORT_TIMEOUT_MS / 1000}s`)), IMPORT_TIMEOUT_MS)
      ),
    ]);
  }

  // 1. Try by local node ID first (same-file components)
  if (params.nodeId) {
    const localNode = figma.getNodeById(params.nodeId);
    if (localNode && (localNode.type === 'COMPONENT' || localNode.type === 'COMPONENT_SET')) {
      component = localNode.type === 'COMPONENT_SET'
        ? (localNode.defaultVariant || localNode.children[0])
        : localNode;
    }
  }

  // 2. Try library import using the component key resolved by the bridge.
  //    Race both import methods in parallel — the key may be a COMPONENT or COMPONENT_SET key.
  //    Each attempt is individually time-bounded so a hung API call cannot block the build.
  if (!component && params.componentKey) {
    let importError = null;

    // Progressive notifications so the user never sees a silent hang (Product QA requirement)
    const notify5 = setTimeout(() => {
      figma.notify('Importing from library — first load may take a moment...', { timeout: 10000 });
    }, 5000);
    const notify15 = setTimeout(() => {
      figma.notify('Still importing — large libraries take longer on first run.', { timeout: 15000 });
    }, 15000);
    const notify30 = setTimeout(() => {
      figma.notify('This is taking longer than usual. If this persists, check that the library is published and enabled.', { timeout: 20000 });
    }, 30000);

    // Race both import methods in parallel — whichever resolves first wins.
    // This keeps total import time to max(60s) instead of 60s + 60s sequential.
    try {
      var raceResult = await withTimeout(
        new Promise(function(resolve, reject) {
          var settled = false;
          // Attempt 1: import as individual component
          figma.importComponentByKeyAsync(params.componentKey).then(function(comp) {
            if (!settled) { settled = true; resolve({ type: 'component', value: comp }); }
          }).catch(function() {});
          // Attempt 2: import as component set
          figma.importComponentSetByKeyAsync(params.componentKey).then(function(compSet) {
            if (!settled) { settled = true; resolve({ type: 'set', value: compSet }); }
          }).catch(function() {});
          // If neither resolves, the withTimeout wrapper will reject
          setTimeout(function() { if (!settled) reject(new Error('neither import resolved')); }, 55000);
        }),
        'parallel component import'
      );
      if (raceResult.type === 'component') {
        component = raceResult.value;
      } else if (raceResult.type === 'set' && raceResult.value) {
        component = raceResult.value.defaultVariant || raceResult.value.children[0];
      }
    } catch (e) {
      importError = 'Component import failed: ' + e.message + '. This can happen with community libraries — Figma\'s API may not support importing components from community-published files. Verify: (1) the library is a team/org library, not a community file, (2) it is published and enabled in this file.';
    }

    // Clear all pending notifications
    clearTimeout(notify5);
    clearTimeout(notify15);
    clearTimeout(notify30);

    // If import failed, store error for the final error message
    if (!component && importError) {
      params._importError = importError;
    }
  }

  // 3. Scan document for an existing INSTANCE with matching component key,
  //    then use its mainComponent (handles components local to this file)
  if (!component && params.componentKey) {
    function scanForInstance(node) {
      if (node.type === 'INSTANCE' && node.mainComponent && node.mainComponent.key === params.componentKey) {
        return node.mainComponent;
      }
      if ('children' in node) {
        for (const child of node.children) {
          const found = scanForInstance(child);
          if (found) return found;
        }
      }
      return null;
    }
    for (const page of figma.root.children) {
      const found = scanForInstance(page);
      if (found) { component = found; break; }
    }
  }

  if (!component) {
    const importDetail = params._importError ? ` Import error: ${params._importError}` : '';
    throw new Error(
      `Component not found (key: ${params.componentKey || 'none'}, nodeId: ${params.nodeId || 'none'}).${importDetail} ` +
      'Check: (1) DS library is enabled in this file (Assets > Team library), ' +
      '(2) FIGMA_ACCESS_TOKEN is set in bridge .env, ' +
      '(3) component is published in the library.'
    );
  }

  const instance = component.createInstance();

  const instanceParentRef = params.parentNodeId || params.parentId;
  if (instanceParentRef) {
    const parent = figma.getNodeById(instanceParentRef);
    if (!parent || !('appendChild' in parent)) throw new Error(`Parent ${instanceParentRef} not found or cannot have children`);
    parent.appendChild(instance);
  } else {
    figma.currentPage.appendChild(instance);
  }

  // Defensive: when inserted into an auto-layout parent, set the component to HUG
  // on both axes so it sizes to content, not its default fixed dimensions.
  // Without this, fixed-width components in horizontal rows overlap when their
  // combined widths exceed the parent. The orchestrator can override with explicit
  // width/layoutSizingHorizontal params after insertion. (Rule 35/36)
  if (instanceParentRef) {
    const parentNode = figma.getNodeById(instanceParentRef);
    if (parentNode && parentNode.layoutMode && parentNode.layoutMode !== 'NONE') {
      try {
        instance.layoutSizingHorizontal = 'HUG';
        instance.layoutSizingVertical = 'HUG';
      } catch (_) { /* some instances may not support layout sizing */ }
    }
  }

  // Rule 37: Auto-hide all icon slots on every component instance.
  // Components ship with icon placeholders visible by default.
  // Unless the orchestrator explicitly enables an icon, all icon booleans default to false.
  try {
    const props = instance.componentProperties;
    for (const key in props) {
      if (props[key].type === 'BOOLEAN' && key.toLowerCase().includes('icon')) {
        const update = {};
        update[key] = false;
        instance.setProperties(update);
      }
    }
  } catch (_) { /* some instances may not support setProperties */ }

  // Layout sizing within parent (must be set AFTER appendChild)
  // Explicit params override the HUG defaults above.
  var layoutWarning = applyLayoutSizing(instance, params);

  if (params.x !== undefined) instance.x = params.x;
  if (params.y !== undefined) instance.y = params.y;
  if (params.width !== undefined && params.height !== undefined) {
    instance.resize(params.width, params.height);
  } else if (params.width !== undefined) {
    instance.resize(params.width, instance.height);
  }

  // Role warnings: check for default text still showing (Rule 40)
  const warnings = [];
  const defaultTexts = ['Button CTA', 'Label', 'Text', 'Title', 'Badge', 'Heading', 'Description',
    'Team members', 'Untitled', 'My details', 'Enter your email'];
  try {
    const visibleTexts = instance.findAll(n => n.type === 'TEXT' && n.visible);
    for (const t of visibleTexts) {
      if (defaultTexts.includes(t.characters)) {
        warnings.push(`Default text "${t.characters}" still showing — override with HTML content (Rule 40)`);
      }
    }
  } catch (_) {}
  if (layoutWarning) warnings.push(layoutWarning);

  return { nodeId: instance.id, name: instance.name, warnings: warnings.length > 0 ? warnings : undefined };
}

async function handleCreateFrame(params) {
  const frame = figma.createFrame();
  frame.name = params.name || 'Frame';

  // Size — coerce to numbers (MCP serialization may send strings)
  const w = params.width !== undefined ? Number(params.width) : 100;
  const h = params.height !== undefined ? Number(params.height) : 100;
  frame.resize(w, h);

  // Auto-layout — accept both "direction" and "layoutMode" as the mode param
  const layoutDir = params.direction || params.layoutMode;
  if (layoutDir && layoutDir !== 'NONE') {
    frame.layoutMode = layoutDir;
    // Gap — prefer gapVariable (DS bound), fall back to gap param (handled by applySpacing strict/permissive)
    if (params.gapVariable) await applySpacing(frame, 'itemSpacing', params.gapVariable);
    else if (params.gap !== undefined) await applySpacing(frame, 'itemSpacing', params.gap);
    else if (params.itemSpacing !== undefined) await applySpacing(frame, 'itemSpacing', params.itemSpacing);

    // Padding — prefer paddingVariable (DS bound, all 4 sides), then per-side, then uniform padding
    if (params.paddingVariable) {
      await applySpacing(frame, 'paddingTop',    params.paddingVariable);
      await applySpacing(frame, 'paddingRight',  params.paddingVariable);
      await applySpacing(frame, 'paddingBottom', params.paddingVariable);
      await applySpacing(frame, 'paddingLeft',   params.paddingVariable);
    } else if (params.padding !== undefined) {
      await applySpacing(frame, 'paddingTop',    params.padding);
      await applySpacing(frame, 'paddingRight',  params.padding);
      await applySpacing(frame, 'paddingBottom', params.padding);
      await applySpacing(frame, 'paddingLeft',   params.padding);
    }
    if (params.paddingTop    !== undefined) await applySpacing(frame, 'paddingTop',    params.paddingTop);
    if (params.paddingRight  !== undefined) await applySpacing(frame, 'paddingRight',  params.paddingRight);
    if (params.paddingBottom !== undefined) await applySpacing(frame, 'paddingBottom', params.paddingBottom);
    if (params.paddingLeft   !== undefined) await applySpacing(frame, 'paddingLeft',   params.paddingLeft);
    // Default both axes to HUG (AUTO) — Rule 5 says fixed dimensions on content
    // frames is a violation. Explicit params override these defaults.
    frame.primaryAxisSizingMode  = params.primaryAxisSizingMode  || 'AUTO';
    frame.counterAxisSizingMode  = params.counterAxisSizingMode  || 'AUTO';
    if (params.primaryAxisAlignItems)  frame.primaryAxisAlignItems  = params.primaryAxisAlignItems;
    if (params.counterAxisAlignItems)  frame.counterAxisAlignItems  = params.counterAxisAlignItems;
  }

  // DS compliance tracking for frame fills and strokes
  const frameDsCompliance = { fill: 'none', stroke: 'none' };

  // Fill — DS style > DS variable > raw (flagged)
  if (params.fillNone || (Array.isArray(params.fills) && params.fills.length === 0)) {
    frame.fills = [];
    frameDsCompliance.fill = 'none';
  } else if (params.fillStyleKey) {
    // Apply DS color style by key (imported from library)
    const applied = await applyColorStyle(frame, 'fill', params.fillStyleKey);
    frameDsCompliance.fill = applied ? 'ds_style' : 'ds_style_unavailable';
    if (!applied && Array.isArray(params.fills)) frame.fills = params.fills;
  } else if (params.fillVariable) {
    const result = await applyFill(frame, params.fillVariable);
    frameDsCompliance.fill = result.bound ? 'ds_variable' : 'raw_fallback';
    if (!result.bound) frameDsCompliance.rawFillReason = 'variable_not_found:' + params.fillVariable;
  } else if (Array.isArray(params.fills)) {
    if (sessionDefaults.dsMode === 'strict') {
      throw new Error('DS_STRICT_VIOLATION: Raw fills array provided without a fillVariable. In strict mode, all fills must use DS variables.');
    }
    frame.fills = params.fills;
    frameDsCompliance.fill = 'raw_fallback';
  } else if (params.fillHex) {
    await applyFill(frame, null, params.fillHex);
    frameDsCompliance.fill = 'raw_fallback';
  } else {
    frameDsCompliance.fill = 'none';
  }

  // Stroke — DS style > DS variable > raw (flagged)
  if (params.strokeStyleKey) {
    const applied = await applyColorStyle(frame, 'stroke', params.strokeStyleKey);
    frameDsCompliance.stroke = applied ? 'ds_style' : 'ds_style_unavailable';
    if (!applied) {
      if (Array.isArray(params.strokes)) { frame.strokes = params.strokes; }
      if (params.strokeWeight !== undefined) frame.strokeWeight = params.strokeWeight;
      if (params.strokeAlign) frame.strokeAlign = params.strokeAlign;
    } else {
      if (params.strokeWeight !== undefined) frame.strokeWeight = params.strokeWeight;
      if (params.strokeAlign) frame.strokeAlign = params.strokeAlign;
    }
  } else if (params.strokeVariable) {
    await applyStroke(frame, params.strokeVariable, null, params.strokeWidth || params.strokeWeight);
    frameDsCompliance.stroke = 'ds_variable';
  } else if (Array.isArray(params.strokes)) {
    frame.strokes = params.strokes;
    if (params.strokeWeight !== undefined) frame.strokeWeight = params.strokeWeight;
    if (params.strokeAlign) frame.strokeAlign = params.strokeAlign;
    frameDsCompliance.stroke = 'raw_fallback';
  } else if (params.strokeHex) {
    await applyStroke(frame, null, params.strokeHex, params.strokeWidth || params.strokeWeight);
    frameDsCompliance.stroke = 'raw_fallback';
  }

  // frameDsCompliance stored for return value

  // Corner radius — prefer cornerRadiusVariable (DS bound), fall back to cornerRadius (strict/permissive)
  if (params.cornerRadiusVariable) await applySpacing(frame, 'cornerRadius', params.cornerRadiusVariable);
  else if (params.cornerRadius !== undefined) await applySpacing(frame, 'cornerRadius', params.cornerRadius);

  // Clip content
  if (params.clipsContent !== undefined) frame.clipsContent = params.clipsContent;

  // Add to parent first — layoutAlign/layoutGrow only take effect inside an auto-layout parent
  const parentRef = params.parentNodeId || params.parentId;
  if (parentRef) {
    let parent = figma.getNodeById(parentRef);
    // If getNodeById fails, try searching the current page children (handles sections)
    if (!parent) {
      parent = figma.currentPage.children.find(n => n.id === parentRef) || null;
    }
    if (!parent) throw new Error(`Parent ${parentRef} not found`);
    try {
      parent.appendChild(frame);
    } catch(e) {
      // Some node types (e.g. SectionNode) may use insertChild instead
      if (typeof parent.insertChild === 'function') {
        parent.insertChild(parent.children ? parent.children.length : 0, frame);
      } else {
        throw e;
      }
    }
  } else {
    figma.currentPage.appendChild(frame);
  }

  // Layout sizing within parent (must be set AFTER appendChild)
  var layoutWarning = applyLayoutSizing(frame, params);

  // Fix: direction=NONE frames in auto-layout parents default to STRETCH (Figma behavior).
  // Override to INHERIT unless explicitly requested, preventing unwanted stretching.
  if (parentRef && (!layoutDir || layoutDir === 'NONE') && !params.layoutAlign) {
    try {
      const parentNode = figma.getNodeById(parentRef);
      if (parentNode && parentNode.layoutMode && parentNode.layoutMode !== 'NONE') {
        frame.layoutAlign = 'INHERIT';
      }
    } catch (_) {}
  }

  // Layout alignment within parent.
  // Previously this auto-filled the cross-axis for ALL frames, causing badges, buttons,
  // and other HUG-content frames to stretch to full parent width. Now: only FILL when
  // explicitly requested via layoutAlign=STRETCH. Otherwise inherit parent alignment.
  if (parentRef && params.layoutAlign === 'STRETCH') {
    try {
      const parentNode = figma.getNodeById(parentRef);
      if (parentNode && parentNode.layoutMode === 'VERTICAL') {
        frame.layoutSizingHorizontal = 'FILL';
      } else if (parentNode && parentNode.layoutMode === 'HORIZONTAL') {
        frame.layoutSizingVertical = 'FILL';
      }
    } catch (_) {
      frame.layoutAlign = 'STRETCH';
    }
  } else if (parentRef && params.layoutAlign && params.layoutAlign !== 'STRETCH') {
    // Explicit non-STRETCH alignment (MIN, CENTER, MAX, INHERIT)
    frame.layoutAlign = params.layoutAlign;
  }
  // When layoutAlign is omitted: frame inherits parent's counterAxisAlignItems (Figma default)

  if (params.x !== undefined) frame.x = params.x;
  if (params.y !== undefined) frame.y = params.y;

  // Role warnings: flag DS compliance issues inline
  const frameWarnings = [];
  if (frameDsCompliance.fill === 'raw_fallback') {
    frameWarnings.push('Frame fill is raw hex — Rule 38 violation. Use fillVariable with a DS color variable.');
  }
  if (frameDsCompliance.stroke === 'raw_fallback') {
    frameWarnings.push('Frame stroke is raw hex — Rule 38 violation. Use strokeVariable with a DS color variable.');
  }
  if (layoutWarning) frameWarnings.push(layoutWarning);

  return { nodeId: frame.id, name: frame.name, dsCompliance: frameDsCompliance, warnings: frameWarnings.length > 0 ? frameWarnings : undefined };
}

async function handleCreateText(params) {
  const weight = params.fontWeight !== undefined ? params.fontWeight : 400;
  const text = figma.createText();

  // DS compliance tracking
  const dsCompliance = { textStyle: 'unresolved', fill: 'unresolved' };

  // Typography: try DS text style FIRST. The style defines the font — load that font,
  // not a hardcoded fallback. This is critical for community libraries (e.g., MUI uses
  // Roboto, not Inter). Only fall back to Inter if no style is provided or import fails.
  let styleApplied = false;
  if (params.textStyleId) {
    // Import the style to get its font information
    var styleKey = params.textStyleId.replace(/^S:/, '').split(',')[0];
    var importedStyle = null;
    try {
      // Check preloaded cache first
      var cachedId = styleCache.get(params.textStyleId) || styleCache.get(styleKey);
      if (cachedId) {
        // Style is cached — apply directly, then load the font it uses
        try {
          text.textStyleId = cachedId;
          // Load the font the style uses (read from the node after style is applied)
          if (text.fontName && text.fontName !== figma.mixed) {
            await figma.loadFontAsync(text.fontName);
          }
          styleApplied = true;
        } catch (e) {
          // Style applied but font load failed — try importing fresh
          styleApplied = false;
        }
      }
      if (!styleApplied) {
        importedStyle = await Promise.race([
          figma.importStyleByKeyAsync(styleKey),
          new Promise(function(_, reject) { setTimeout(function() { reject(new Error('style import timeout')); }, 20000); }),
        ]);
        if (importedStyle && importedStyle.id) {
          text.textStyleId = importedStyle.id;
          // Load the font the style specifies
          if (text.fontName && text.fontName !== figma.mixed) {
            await figma.loadFontAsync(text.fontName);
          }
          styleApplied = true;
          styleCache.set(params.textStyleId, importedStyle.id);
          styleCache.set(styleKey, importedStyle.id);
          // Auto-detect DS font: if no fontFamily is set, learn it from the first successful style import.
          // This makes the plugin DS-agnostic — it discovers the font from the DS instead of assuming one.
          if (!sessionDefaults.fontFamily && text.fontName && text.fontName !== figma.mixed) {
            sessionDefaults.fontFamily = text.fontName.family;
          }
        }
      }
    } catch (_) { /* style import failed — fall through to raw */ }
    dsCompliance.textStyle = styleApplied ? 'ds_style' : 'style_failed';
    if (!styleApplied) dsCompliance.failedStyleId = params.textStyleId;
  }

  if (!styleApplied) {
    // No DS style — load fallback font (Inter or session default)
    var fallbackFamily = sessionDefaults.fontFamily || 'Inter';
    var fallbackStyle = FONT_STYLES[weight] || 'Regular';
    await figma.loadFontAsync({ family: fallbackFamily, style: fallbackStyle });
    text.fontName = { family: fallbackFamily, style: fallbackStyle };

    if (sessionDefaults.dsMode === 'strict' && params.textStyleId) {
      throw new Error(
        'DS_TEXT_STYLE_FAILED: Text style "' + params.textStyleId + '" could not be applied. ' +
        'In strict mode, raw fontName/fontSize fallback is not allowed. ' +
        'Check the style key or run preload_styles.'
      );
    }
    if (sessionDefaults.dsMode === 'strict' && !params.textStyleId) {
      throw new Error(
        'DS_STRICT_VIOLATION: No textStyleId provided for text node. ' +
        'In strict mode, all text must use DS text styles. ' +
        'Provide a textStyleId or switch to permissive mode.'
      );
    }
    // Permissive mode — apply raw properties when DS style is not available
    if (params.fontSize) text.fontSize = params.fontSize;
    if (params.lineHeight) text.lineHeight = { value: params.lineHeight, unit: 'PIXELS' };
    dsCompliance.textStyle = params.textStyleId ? 'style_failed' : 'raw_fallback';
    dsCompliance.rawFontSize = params.fontSize || null;
    dsCompliance.rawFontWeight = weight;
  }

  // Set characters AFTER font is loaded (either from style or fallback)
  text.characters = params.text !== undefined ? params.text : '';

  if (params.textAlignHorizontal) text.textAlignHorizontal = params.textAlignHorizontal;

  // Fill: DS style > DS variable > raw (flagged)
  if (params.fillStyleKey) {
    const applied = await applyColorStyle(text, 'fill', params.fillStyleKey);
    dsCompliance.fill = applied ? 'ds_style' : 'ds_style_unavailable';
    if (!applied && Array.isArray(params.fills)) text.fills = params.fills;
  } else if (params.fillVariable) {
    const result = await applyFill(text, params.fillVariable);
    dsCompliance.fill = result.bound ? 'ds_variable' : 'raw_fallback';
    if (!result.bound) dsCompliance.rawFillReason = 'variable_not_found:' + params.fillVariable;
  } else if (Array.isArray(params.fills)) {
    if (sessionDefaults.dsMode === 'strict') {
      throw new Error('DS_STRICT_VIOLATION: Raw fills array on text without fillVariable. In strict mode, all fills must use DS variables.');
    }
    text.fills = params.fills;
    dsCompliance.fill = 'raw_fallback';
  } else if (params.fillHex) {
    await applyFill(text, null, params.fillHex);
    dsCompliance.fill = 'raw_fallback';
  } else if (sessionDefaults.textFillStyleKey) {
    // No explicit fill — apply session default via color style
    var defaultApplied = await applyColorStyle(text, 'fill', sessionDefaults.textFillStyleKey);
    dsCompliance.fill = defaultApplied ? 'ds_session_default' : 'raw_fallback';
    if (!defaultApplied) dsCompliance.rawFillReason = 'session_default_failed';
  } else if (sessionDefaults.textFillVariable) {
    // No explicit fill — apply session default via DS variable (community library path)
    var varApplied = await applyFill(text, sessionDefaults.textFillVariable, null);
    dsCompliance.fill = varApplied ? 'ds_session_default' : 'raw_fallback';
    if (!varApplied) dsCompliance.rawFillReason = 'session_default_variable_failed';
  } else {
    // No fill param and no session default — Figma default black. Raw, not DS compliant.
    dsCompliance.fill = 'raw_fallback';
    dsCompliance.rawFillReason = 'no_fill_param_provided';
  }

  // Store compliance for return (can't set custom props on Figma nodes)
  const textDsCompliance = dsCompliance;

  if (params.width) {
    text.textAutoResize = 'HEIGHT';
    text.resize(params.width, text.height);
  }

  const textParentRef = params.parentNodeId || params.parentId;
  if (textParentRef) {
    const parent = figma.getNodeById(textParentRef);
    if (!parent || !('appendChild' in parent)) throw new Error(`Parent ${textParentRef} not found`);
    parent.appendChild(text);
  } else {
    figma.currentPage.appendChild(text);
  }

  // layoutAlign/layoutGrow must be set AFTER appendChild
  var layoutWarning = applyLayoutSizing(text, params);

  // Auto-fill + wrap: text in auto-layout parents should fill cross-axis and wrap.
  // Skip if explicit width was set or explicit layoutAlign was provided.
  if (textParentRef && !params.width && !params.layoutAlign) {
    try {
      const parentNode = figma.getNodeById(textParentRef);
      if (parentNode && parentNode.layoutMode === 'VERTICAL') {
        text.layoutSizingHorizontal = 'FILL';
      }
    } catch (_) {
      text.layoutAlign = 'STRETCH';
    }
    text.textAutoResize = 'HEIGHT';
  }

  if (params.x !== undefined) text.x = params.x;
  if (params.y !== undefined) text.y = params.y;

  // Role warnings: flag DS compliance issues inline
  const textWarnings = [];
  if (textDsCompliance.textStyle === 'raw_fallback') {
    textWarnings.push('Text created without DS text style — Rule 39 violation. Use textStyleId instead of fontSize/fontWeight.');
  }
  if (textDsCompliance.fill === 'raw_fallback') {
    textWarnings.push('Text fill is raw hex — Rule 38 violation. Use fillVariable with a DS color variable.');
  }
  if (layoutWarning) textWarnings.push(layoutWarning);

  return { nodeId: text.id, dsCompliance: textDsCompliance, warnings: textWarnings.length > 0 ? textWarnings : undefined };
}

async function handleCreateRectangle(params) {
  const rect = figma.createRectangle();
  rect.name = params.name || 'Rectangle';
  // Coerce width/height to numbers — MCP serialization may send strings
  rect.resize(Number(params.width) || 100, Number(params.height) || 100);

  if (params.fillNone) {
    rect.fills = [];
  } else {
    await applyFill(rect, params.fillVariable, params.fillHex);
  }

  if (params.strokeVariable || params.strokeHex) {
    await applyStroke(rect, params.strokeVariable, params.strokeHex, params.strokeWidth);
  }

  // Corner radius — prefer variable path string, fall back to raw number (strict/permissive via applySpacing)
  if (params.cornerRadiusVariable) {
    await applySpacing(rect, 'cornerRadius', params.cornerRadiusVariable);
  } else if (params.cornerRadius !== undefined) {
    if (typeof params.cornerRadius === 'string') {
      await applySpacing(rect, 'cornerRadius', params.cornerRadius);
    } else if (sessionDefaults.dsMode === 'strict') {
      throw new Error(
        'DS_STRICT_VIOLATION: Raw cornerRadius ' + params.cornerRadius + ' on rectangle. ' +
        'In strict mode, use a DS radius variable path (e.g., "Radius/radius-xl").'
      );
    } else {
      rect.cornerRadius = params.cornerRadius;
    }
  }

  const rectParentRef = params.parentNodeId || params.parentId;
  if (rectParentRef) {
    const parent = figma.getNodeById(rectParentRef);
    if (!parent || !('appendChild' in parent)) throw new Error(`Parent ${rectParentRef} not found`);
    parent.appendChild(rect);
  } else {
    figma.currentPage.appendChild(rect);
  }

  // layoutAlign/layoutGrow must be set AFTER appendChild
  var layoutWarning = applyLayoutSizing(rect, params);

  if (params.x !== undefined) rect.x = params.x;
  if (params.y !== undefined) rect.y = params.y;

  var rectWarnings = [];
  if (layoutWarning) rectWarnings.push(layoutWarning);

  return { nodeId: rect.id, warnings: rectWarnings.length > 0 ? rectWarnings : undefined };
}

async function handleCreateEllipse(params) {
  const ellipse = figma.createEllipse();
  ellipse.name = params.name || 'Ellipse';
  ellipse.resize(Number(params.width) || 100, Number(params.height) || 100);

  // Arc support — for donut segments, partial circles, etc.
  if (params.arcData) {
    ellipse.arcData = {
      startingAngle: params.arcData.startingAngle || 0,
      endingAngle: params.arcData.endingAngle || 6.2832,
      innerRadius: params.arcData.innerRadius || 0,
    };
  }

  // Fill
  if (params.fillNone) {
    ellipse.fills = [];
  } else {
    await applyFill(ellipse, params.fillVariable, params.fillHex);
  }

  // Stroke
  if (params.strokeVariable || params.strokeHex) {
    await applyStroke(ellipse, params.strokeVariable, params.strokeHex, params.strokeWidth);
  }

  const parentRef = params.parentNodeId || params.parentId;
  if (parentRef) {
    const parent = figma.getNodeById(parentRef);
    if (!parent || !('appendChild' in parent)) throw new Error('Parent ' + parentRef + ' not found');
    parent.appendChild(ellipse);
  } else {
    figma.currentPage.appendChild(ellipse);
  }

  applyLayoutSizing(ellipse, params);
  if (params.x !== undefined) ellipse.x = params.x;
  if (params.y !== undefined) ellipse.y = params.y;

  return { nodeId: ellipse.id };
}

async function handleSetComponentText(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);

  // Try component properties first (Figma's typed component props).
  // Only use setProperties when the value type matches the property type:
  // booleans for BOOLEAN props, strings for VARIANT props.
  // String values are NOT passed to BOOLEAN props — fall through to text layer search.
  try {
    if ('componentProperties' in node && node.componentProperties[params.propertyName]) {
      const propDef = node.componentProperties[params.propertyName];
      const isBoolean = propDef.type === 'BOOLEAN';
      const isVariant  = propDef.type === 'VARIANT';
      if (isBoolean && typeof params.value === 'boolean') {
        node.setProperties({ [params.propertyName]: params.value });
        return { ok: true, method: 'componentProperty' };
      }
      if (isVariant && typeof params.value === 'string') {
        try {
          node.setProperties({ [params.propertyName]: params.value });
          return { ok: true, method: 'componentProperty' };
        } catch (_) {
          // Value not a valid variant option — fall through to text layer search
        }
      }
      // Type mismatch or invalid variant value — fall through to text layer search below
    }
  } catch (_componentPropsErr) {
    // componentProperties threw (e.g. "Component set has existing errors") — fall through
  }

  // Fall back: find a text layer by name and set its characters
  const textNode = findTextNode(node, params.propertyName);
  if (textNode) {
    await figma.loadFontAsync(textNode.fontName);
    textNode.characters = params.value;
    return { ok: true, method: 'textLayer' };
  }

  // Last resort: find the first text node at all
  const anyText = findTextNode(node, null);
  if (anyText) {
    await figma.loadFontAsync(anyText.fontName);
    anyText.characters = params.value;
    return { ok: true, method: 'firstTextLayer' };
  }

  throw new Error(`No text property "${params.propertyName}" found on node ${params.nodeId}`);
}

async function handleSetLayoutSizing(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  // Enable / change auto-layout mode before setting sizing properties
  if (params.layoutMode !== undefined) node.layoutMode = params.layoutMode;
  if (params.itemSpacing !== undefined) await applySpacing(node, 'itemSpacing', params.itemSpacing);
  var layoutWarning = applyLayoutSizing(node, params);
  // Modern Figma API: layoutSizingHorizontal / layoutSizingVertical
  // MCP schema sends 'horizontal' and 'vertical' params — map both naming conventions
  const hSizing = params.horizontal || params.layoutSizingHorizontal;
  const vSizing = params.vertical   || params.layoutSizingVertical;
  if (hSizing !== undefined && 'layoutSizingHorizontal' in node) {
    node.layoutSizingHorizontal = hSizing;
  }
  if (vSizing !== undefined && 'layoutSizingVertical' in node) {
    node.layoutSizingVertical = vSizing;
  }
  // Padding support (works on frames and auto-layout nodes, including instance overrides)
  if (params.paddingTop    !== undefined) await applySpacing(node, 'paddingTop',    params.paddingTop);
  if (params.paddingBottom !== undefined) await applySpacing(node, 'paddingBottom', params.paddingBottom);
  if (params.paddingLeft   !== undefined) await applySpacing(node, 'paddingLeft',   params.paddingLeft);
  if (params.paddingRight  !== undefined) await applySpacing(node, 'paddingRight',  params.paddingRight);
  // Explicit resize (width and/or height)
  if (params.width !== undefined || params.height !== undefined) {
    const w = params.width  !== undefined ? params.width  : node.width;
    const h = params.height !== undefined ? params.height : node.height;
    node.resize(w, h);
  }
  return { ok: true, width: node.width, height: node.height, warning: layoutWarning || undefined };
}

function handleResizeNode(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  const w = params.width  !== undefined ? params.width  : node.width;
  const h = params.height !== undefined ? params.height : node.height;
  node.resize(w, h);
  return { ok: true, width: node.width, height: node.height };
}

function handleGetSelection() {
  return {
    nodes: figma.currentPage.selection.map(n => ({
      id: n.id,
      name: n.name,
      type: n.type,
      width:  'width'  in n ? n.width  : null,
      height: 'height' in n ? n.height : null,
      x: 'x' in n ? n.x : null,
      y: 'y' in n ? n.y : null,
    })),
  };
}

function handleSelectNode(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
  return { ok: true };
}

function handleGetPageNodes() {
  return {
    nodes: figma.currentPage.children.map(n => ({
      id: n.id,
      name: n.name,
      type: n.type,
      x: n.x,
      y: n.y,
      width:  'width'  in n ? n.width  : null,
      height: 'height' in n ? n.height : null,
    })),
  };
}

function handleDeleteNode(params) {
  const node = figma.getNodeById(params.nodeId);
  if (node) node.remove();
  return { ok: true };
}

// Move a node to a specific index within its current parent (reorder).
// params: { nodeId, index }
function handleMoveNode(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  const parent = node.parent;
  if (!parent || !('insertChild' in parent)) throw new Error(`Parent of ${params.nodeId} does not support reordering`);
  parent.insertChild(params.index, node);
  // Force auto-layout reflow by toggling layoutMode (insertChild doesn't always trigger it)
  if (parent.layoutMode && parent.layoutMode !== 'NONE') {
    const mode = parent.layoutMode;
    parent.layoutMode = 'NONE';
    parent.layoutMode = mode;
  }
  return { ok: true };
}

// Directly set a VARIANT or BOOLEAN component property on an instance,
// bypassing the componentProperties guard in set_component_text.
// Use this when the target node is a nested instance inside another instance
// where componentProperties access throws "existing errors".
// params: { nodeId, propertyName, value }
function handleSetVariant(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  if (typeof node.setProperties !== 'function') throw new Error(`Node ${params.nodeId} does not support setProperties`);

  // Support both single-property and batch mode
  // Single: { property: "Size", value: "sm" }
  // Batch:  { properties: { "Size": "sm", "Hierarchy": "Link", "Icon leading": false } }
  var propsToSet = {};

  if (params.properties && typeof params.properties === 'object') {
    // Batch mode — set multiple properties at once (required for VARIANT combos)
    for (var pName in params.properties) {
      if (params.properties.hasOwnProperty(pName)) {
        propsToSet[pName] = params.properties[pName];
      }
    }
  } else {
    // Single property mode
    var propName = params.propertyName || params.property;
    if (!propName) throw new Error('No property name provided (use "property" or "propertyName", or "properties" for batch)');
    propsToSet[propName] = params.value;
  }

  // Resolve each property name to its actual key (with emoji prefix / #nodeId suffix)
  var allProps = node.componentProperties || {};
  var resolvedProps = {};
  var report = [];

  for (var requestedName in propsToSet) {
    if (!propsToSet.hasOwnProperty(requestedName)) continue;
    var val = propsToSet[requestedName];
    var actualKey = null;

    // Try exact match first
    if (allProps[requestedName] !== undefined) {
      actualKey = requestedName;
    } else {
      // Fuzzy match: strip emoji prefix and #nodeId suffix
      for (var key in allProps) {
        if (!allProps.hasOwnProperty(key)) continue;
        var clean = key.replace(/^[^\w]*\s*/, '').replace(/#\d+.*$/, '').trim();
        if (clean === requestedName) {
          actualKey = key;
          break;
        }
      }
    }

    if (!actualKey) {
      throw new Error('Property "' + requestedName + '" not found. Available: ' + Object.keys(allProps).join(', '));
    }

    // Coerce value based on property type
    var propDef = allProps[actualKey];
    if (propDef && propDef.type === 'BOOLEAN') {
      // Ensure actual boolean — JSON bridge may send string "true"/"false"
      if (val === 'true' || val === true) val = true;
      else if (val === 'false' || val === false) val = false;
    }

    resolvedProps[actualKey] = val;
    report.push({ requested: requestedName, resolved: actualKey, type: propDef ? propDef.type : 'unknown', value: val });
  }

  // Apply all resolved properties in one call
  node.setProperties(resolvedProps);
  return { ok: true, applied: report };
}

// Set layer visibility on any node.
// params: { nodeId, visible: boolean }
function handleSetVisibility(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  node.visible = params.visible;
  return { ok: true };
}

// Set session-level defaults for DS compliance.
// Called once at build start after preload_styles. DS-agnostic — the orchestrator
// discovers the right keys from the DS knowledge layer and passes them here.
// params: { textFillStyleKey?: string, textFillVariable?: string, fontFamily?: string, dsMode?: string }
async function handleSetSessionDefaults(params) {
  if (params.textFillStyleKey) {
    // Preload the color style so it's available in the cache
    try {
      var imported = await figma.importStyleByKeyAsync(params.textFillStyleKey);
      styleCache.set(params.textFillStyleKey, imported.id);
      sessionDefaults.textFillStyleKey = params.textFillStyleKey;
    } catch (e) {
      return { ok: false, error: 'Failed to import textFillStyleKey: ' + e.message };
    }
  }
  if (params.textFillVariable) {
    // DS variable path for default text fill — used when DS has variables but no color styles
    sessionDefaults.textFillVariable = params.textFillVariable;
  }
  if (params.fontFamily) {
    sessionDefaults.fontFamily = params.fontFamily;
  }
  if (params.dsMode === 'strict' || params.dsMode === 'permissive') {
    sessionDefaults.dsMode = params.dsMode;
  }
  return { ok: true, sessionDefaults: sessionDefaults };
}

// Read the resolved values of all local and library variables.
// Returns { variables: [{name, resolvedType, value, collectionName}] }
// For COLOR variables, value is a hex string. For FLOAT, value is the number.
async function handleReadVariableValues(params) {
  const results = [];

  function rgbToHex(r, g, b) {
    var toHex = function(c) { return Math.round(c * 255).toString(16).padStart(2, '0'); };
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }

  function resolveValue(v, raw, collMap) {
    if (v.resolvedType === 'COLOR' && typeof raw === 'object' && 'r' in raw) {
      return rgbToHex(raw.r, raw.g, raw.b);
    } else if (v.resolvedType === 'FLOAT') {
      return (typeof raw === 'object' && raw.type === 'VARIABLE_ALIAS') ? 'alias:' + raw.id : raw;
    } else if (v.resolvedType === 'STRING') {
      return (typeof raw === 'object' && raw.type === 'VARIABLE_ALIAS') ? 'alias:' + raw.id : raw;
    }
    return null;
  }

  // Strategy 1: Read local variables (works in library files)
  try {
    var localVars = await figma.variables.getLocalVariablesAsync();
    var localCollections = await figma.variables.getLocalVariableCollectionsAsync();
    var collMap = new Map(localCollections.map(function(c) { return [c.id, c]; }));

    for (var i = 0; i < localVars.length; i++) {
      var v = localVars[i];
      var coll = collMap.get(v.variableCollectionId);
      if (!coll) continue;
      var firstMode = coll.modes[0];
      if (!firstMode) continue;
      var modeId = firstMode.modeId;
      if (!modeId) continue;
      var raw = v.valuesByMode[modeId];
      if (raw === undefined) continue;

      var value = null;
      if (v.resolvedType === 'COLOR' && typeof raw === 'object' && raw.type === 'VARIABLE_ALIAS') {
        // Alias — need to resolve. Import the target and read its value.
        try {
          var target = await figma.variables.getVariableByIdAsync(raw.id);
          if (target) {
            var targetColl = collMap.get(target.variableCollectionId);
            var targetFirstMode = targetColl && targetColl.modes[0];
            var targetMode = targetFirstMode ? targetFirstMode.modeId : null;
            var targetRaw = targetMode ? target.valuesByMode[targetMode] : null;
            if (targetRaw && typeof targetRaw === 'object' && 'r' in targetRaw) {
              value = rgbToHex(targetRaw.r, targetRaw.g, targetRaw.b);
            } else {
              value = 'alias:' + target.name;
            }
          }
        } catch (_) {
          value = 'alias:' + raw.id;
        }
      } else {
        value = resolveValue(v, raw, collMap);
      }

      results.push({
        name: v.name,
        resolvedType: v.resolvedType,
        value: value,
        collectionName: coll.name,
        key: v.key || null,
      });
    }
  } catch (e) {
    // Local variables not available — try library path
  }

  // Strategy 2: If no local results, try importing library variables and reading their values
  if (results.length === 0) {
    try {
      var collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
      for (var ci = 0; ci < collections.length; ci++) {
        var col = collections[ci];
        var libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(col.key);
        for (var vi = 0; vi < libVars.length; vi++) {
          var lv = libVars[vi];
          try {
            var imported = await figma.variables.importVariableByKeyAsync(lv.key);
            // After import, the variable becomes local — we can read its valuesByMode
            var impColl = null;
            try {
              var impCollections = await figma.variables.getLocalVariableCollectionsAsync();
              for (var k = 0; k < impCollections.length; k++) {
                if (impCollections[k].id === imported.variableCollectionId) {
                  impColl = impCollections[k]; break;
                }
              }
            } catch(_) {}

            var impValue = null;
            if (impColl) {
              var impFirstMode = impColl.modes[0];
              var impModeId = impFirstMode ? impFirstMode.modeId : null;
              var impRaw = impModeId ? imported.valuesByMode[impModeId] : null;
              // Resolve alias chains (up to 10 levels deep)
              var depth = 0;
              while (impRaw && typeof impRaw === 'object' && impRaw.type === 'VARIABLE_ALIAS' && depth < 10) {
                try {
                  var aliasTarget = await figma.variables.getVariableByIdAsync(impRaw.id);
                  if (!aliasTarget) break;
                  var aliasColl = null;
                  for (var ac = 0; ac < impCollections.length; ac++) {
                    if (impCollections[ac].id === aliasTarget.variableCollectionId) { aliasColl = impCollections[ac]; break; }
                  }
                  if (!aliasColl) break;
                  var aliasMode = aliasColl.modes[0] ? aliasColl.modes[0].modeId : null;
                  impRaw = aliasMode ? aliasTarget.valuesByMode[aliasMode] : null;
                } catch(_) { break; }
                depth++;
              }
              if (impRaw !== null && impRaw !== undefined) {
                if (imported.resolvedType === 'COLOR' && typeof impRaw === 'object' && 'r' in impRaw) {
                  impValue = rgbToHex(impRaw.r, impRaw.g, impRaw.b);
                } else if (imported.resolvedType === 'FLOAT' && typeof impRaw === 'number') {
                  impValue = impRaw;
                } else if (imported.resolvedType === 'STRING' && typeof impRaw === 'string') {
                  impValue = impRaw;
                }
              }
            }

            results.push({
              name: lv.name,
              resolvedType: lv.resolvedType,
              value: impValue,
              collectionName: col.name,
              key: lv.key,
            });
          } catch (_) {
            // Import failed for this variable — skip
            results.push({
              name: lv.name,
              resolvedType: lv.resolvedType,
              value: null,
              collectionName: col.name,
              key: lv.key,
              error: 'import_failed',
            });
          }
        }
      }
    } catch (e) {
      return { variables: results, error: 'Library variable import failed: ' + e.message };
    }
  }

  // If still no resolved values, try the node-binding approach:
  // Create a temp frame, bind each COLOR variable to its fill, read the resolved RGB
  var unresolvedColors = [];
  for (var ui = 0; ui < results.length; ui++) {
    if (results[ui].value === null && results[ui].resolvedType === 'COLOR') {
      unresolvedColors.push(ui);
    }
  }

  if (unresolvedColors.length > 0) {
    var tempFrame = figma.createFrame();
    tempFrame.name = '__temp_color_reader__';
    tempFrame.resize(1, 1);
    tempFrame.visible = false;

    for (var ri = 0; ri < unresolvedColors.length; ri++) {
      var idx = unresolvedColors[ri];
      var entry = results[idx];
      try {
        var varObj = null;
        if (entry.key) {
          varObj = await figma.variables.importVariableByKeyAsync(entry.key);
        }
        if (varObj) {
          var boundPaint = figma.variables.setBoundVariableForPaint(
            { type: 'SOLID', color: { r: 0, g: 0, b: 0 } },
            'color',
            varObj
          );
          tempFrame.fills = [boundPaint];
          // Read the resolved color from the paint
          var resolvedFills = tempFrame.fills;
          if (resolvedFills && resolvedFills.length > 0 && resolvedFills[0].color) {
            var c = resolvedFills[0].color;
            entry.value = rgbToHex(c.r, c.g, c.b);
          }
        }
      } catch (_) {
        // Skip this variable
      }
    }

    tempFrame.remove();
  }

  return { variables: results, count: results.length };
}

// Replace an existing node with a new component instance at the same position in its parent.
// Deletes the target node, inserts a new instance of componentKey at the same parent index.
// Applies any additional layout sizing params after insertion.
// params: { nodeId, componentKey, fileKey?, layoutSizingHorizontal?, layoutSizingVertical?, height? }
async function handleReplaceComponent(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  const parent = node.parent;
  if (!parent || !('children' in parent)) throw new Error(`Node ${params.nodeId} has no valid parent`);

  // Record position
  const idx = Array.from(parent.children).indexOf(node);

  // Import the new component
  let component = null;
  try {
    component = await figma.importComponentByKeyAsync(params.componentKey);
  } catch(_) {}
  if (!component) {
    // Scan document for an existing instance with matching key
    function scan(n) {
      if (n.type === 'INSTANCE' && n.mainComponent && n.mainComponent.key === params.componentKey) return n.mainComponent;
      if ('children' in n) { for (const c of n.children) { const f = scan(c); if (f) return f; } }
      return null;
    }
    for (const page of figma.root.children) { component = scan(page); if (component) break; }
  }
  if (!component) throw new Error(`Component key ${params.componentKey} could not be resolved`);

  // Remove the old node
  node.remove();

  // Create new instance and insert at same index
  const instance = component.createInstance();
  if (idx >= 0 && idx <= parent.children.length) {
    parent.insertChild(idx, instance);
  } else {
    parent.appendChild(instance);
  }

  // Apply layout sizing
  applyLayoutSizing(instance, params);
  if (params.layoutSizingHorizontal !== undefined && 'layoutSizingHorizontal' in instance) {
    instance.layoutSizingHorizontal = params.layoutSizingHorizontal;
  }
  if (params.layoutSizingVertical !== undefined && 'layoutSizingVertical' in instance) {
    instance.layoutSizingVertical = params.layoutSizingVertical;
  }
  if (params.height !== undefined) instance.resize(instance.width, params.height);

  return { ok: true, nodeId: instance.id };
}

// Swap an INSTANCE_SWAP component property on an instance node.
// params: { nodeId, propertyName, componentKey }
// Tries three methods in order:
//  1. setProperties with the full property name (official INSTANCE_SWAP API)
//  2. setProperties with the base name (without #nodeId suffix)
//  3. Navigate to the child slot instance using the #nodeId suffix and swapMainComponent
async function handleSetInstanceSwap(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  if (node.type !== 'INSTANCE') throw new Error(`Node ${params.nodeId} is not INSTANCE (is ${node.type})`);
  const newComponent = await figma.importComponentByKeyAsync(params.componentKey);
  if (!newComponent) throw new Error(`Component key ${params.componentKey} could not be imported`);

  // Method 1: setProperties with ComponentNode (documented API)
  try {
    node.setProperties({ [params.propertyName]: newComponent });
    return { ok: true, method: 'setProperties-node' };
  } catch(_) {}

  // Method 2: setProperties with component node ID as string
  try {
    node.setProperties({ [params.propertyName]: newComponent.id });
    return { ok: true, method: 'setProperties-id' };
  } catch(_) {}

  // Method 3: setProperties with component key (SHA hash) as string
  try {
    node.setProperties({ [params.propertyName]: newComponent.key });
    return { ok: true, method: 'setProperties-key' };
  } catch(_) {}

  // Method 4: base name (without #suffix) + ComponentNode
  try {
    const baseName = params.propertyName.split('#')[0].trim();
    node.setProperties({ [baseName]: newComponent });
    return { ok: true, method: 'setProperties-base-node' };
  } catch(_) {}

  // Method 5: base name + component ID string
  try {
    const baseName = params.propertyName.split('#')[0].trim();
    node.setProperties({ [baseName]: newComponent.id });
    return { ok: true, method: 'setProperties-base-id' };
  } catch(e5) {
    throw new Error(`All swap methods failed. Last error: ${e5.message}`);
  }
}

// Set a fill or stroke variable on a node or — for instances — on the first
// vector-type descendant (the actual colored shape inside an icon instance).
// params: { nodeId, variablePath, hexFallback, target? }
// target: "fill" (default) | "stroke"
async function handleSetNodeFill(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  const useStroke = params.target === 'stroke';
  const vectorTypes = new Set(['VECTOR','ELLIPSE','RECTANGLE','POLYGON','STAR','LINE','BOOLEAN_OPERATION']);
  let applied = false;
  async function walk(n) {
    if (applied) return;
    if (vectorTypes.has(n.type)) {
      if (useStroke && 'strokes' in n) {
        await applyStroke(n, params.variablePath, params.hexFallback);
        applied = true;
      } else if (!useStroke && 'fills' in n) {
        await applyFill(n, params.variablePath, params.hexFallback);
        applied = true;
      }
      return;
    }
    if ('children' in n) {
      for (const child of n.children) { await walk(child); }
    }
  }
  await walk(node);
  // Fallback: apply directly to node if no vector descendant found
  if (!applied) {
    if (useStroke && 'strokes' in node) { await applyStroke(node, params.variablePath, params.hexFallback); applied = true; }
    else if (!useStroke && 'fills' in node) { await applyFill(node, params.variablePath, params.hexFallback); applied = true; }
  }
  return { ok: true, applied };
}

function handleGetNodeChildren(params) {
  let node = figma.getNodeById(params.nodeId);
  if (!node) node = figma.currentPage.children.find(n => n.id === params.nodeId) || null;
  if (!node) return { nodes: [] };
  let children = [];
  try { children = node.children || []; } catch(e) {}
  return {
    nodes: Array.from(children).map(n => ({
      id: n.id,
      name: n.name,
      type: n.type,
      x: n.x,
      y: n.y,
      width:  n.width  !== undefined ? n.width  : null,
      height: n.height !== undefined ? n.height : null,
    })),
  };
}

async function handleApplyEffectStyle(params) {
  let node = figma.getNodeById(params.nodeId);
  if (!node) node = figma.currentPage.children.find(n => n.id === params.nodeId) || null;
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  const key = (params.effectStyleKey || '').replace(/^S:/, '').split(',')[0];
  if (!key) throw new Error('effectStyleKey is required');
  const style = await figma.importStyleByKeyAsync(key);
  if (!style) throw new Error(`Effect style not found for key: ${key}`);
  node.effectStyleId = style.id;
  return { nodeId: node.id, effectStyleId: style.id };
}

// ---------------------------------------------------------------------------
// Batch execution
// ---------------------------------------------------------------------------

// Execute multiple operations in a single bridge round trip.
// Each operation: { type: string, params: object }
// Returns an array of results in the same order — failures are { ok: false, error }
// and do not stop subsequent operations.
async function handleBatch(params) {
  const operations = params.operations || [];
  const results = [];
  for (const op of operations) {
    var opType = op.type || op.tool;
    if (!opType) {
      results.push({ ok: false, error: 'Missing "type" or "tool" in batch operation' });
      continue;
    }
    const handler = HANDLERS[opType];
    if (!handler) {
      results.push({ ok: false, error: `Unknown instruction type: "${opType}"` });
      continue;
    }
    try {
      const result = await handler(op.params || {});
      results.push({ ok: true, result });
    } catch (e) {
      results.push({ ok: false, error: e.message, type: opType });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

// Returns componentProperties + all text layer names/values for a node — useful for
// discovering the right property names to pass to set_component_text.
// Set characters on a TEXT node by its direct node ID (including nested "I..." IDs).
// Use this to target specific sub-text-nodes inside a component instance.
async function handleSetText(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  if (node.type !== 'TEXT') throw new Error(`Node ${params.nodeId} is type ${node.type}, expected TEXT`);
  await figma.loadFontAsync(node.fontName);
  node.characters = params.value;
  return { ok: true };
}

function handleGetNodeParent(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  const parent = node.parent;
  if (!parent) return { parentId: null, parentType: null, parentName: null };
  const children = 'children' in parent ? parent.children.map(c => ({
    id: c.id, name: c.name, type: c.type,
    x: 'x' in c ? c.x : null, y: 'y' in c ? c.y : null,
    width: 'width' in c ? c.width : null, height: 'height' in c ? c.height : null,
  })) : [];
  return { parentId: parent.id, parentType: parent.type, parentName: parent.name, children };
}

function handleGetNodeProps(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);

  const result = { type: node.type, name: node.name, componentProperties: [], textLayers: [] };

  if ('componentProperties' in node) {
    for (const [key, val] of Object.entries(node.componentProperties)) {
      result.componentProperties.push({ key, type: val.type, value: val.value });
    }
  }

  function walk(n) {
    if (n.type === 'TEXT') {
      result.textLayers.push({ id: n.id, name: n.name, chars: n.characters.slice(0, 60) });
    }
    if ('children' in n) n.children.forEach(walk);
  }
  walk(node);

  return result;
}

async function handleDebugComponents(params) {
  const search = (params.search || '').toLowerCase();
  const results = [];
  try {
    const available = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    // getAvailableLibraryVariableCollections doesn't help for components
    // Use importable component search instead
  } catch(_) {}

  // Search local components first
  const local = figma.root.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] });
  for (const c of local) {
    if (!search || c.name.toLowerCase().includes(search)) {
      results.push({ source: 'local', id: c.id, name: c.name, key: 'key' in c ? c.key : null });
    }
    if (results.length >= 20) break;
  }
  return { results };
}

async function handleDebugVariables(params) {
  const result = { local: [], library: [], error: null };
  const search = params.search || null;
  try {
    const local = await figma.variables.getLocalVariablesAsync();
    result.local = local.slice(0, 5).map(v => v.name);
    const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    for (const col of collections) {
      const vars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(col.key);
      const names = vars.map(v => v.name);
      const filtered = search ? names.filter(n => n.toLowerCase().includes(search.toLowerCase())) : names.slice(0, 8);
      if (filtered.length > 0) {
        result.library.push({ collection: col.name, sample: filtered.slice(0, 20) });
      }
    }
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

// Returns all local text styles (id + name) for inspection
async function handleListTextStyles() {
  const styles = await figma.getLocalTextStylesAsync();
  return { styles: styles.map(s => ({ id: s.id, name: s.name, fontSize: s.fontSize })) };
}

// Discover ALL library text styles and color styles available to this file.
// Uses figma.teamLibrary API to enumerate across all enabled libraries.
// Returns style keys that can be passed to preload_styles / importStyleByKeyAsync.
async function handleDiscoverLibraryStyles(params) {
  const nameFilter = params.nameFilter || null;
  const textStyles = [];
  const colorStyles = [];
  const effectStyles = [];

  // Note: figma.teamLibrary does NOT have style enumeration methods
  // (getAvailableLibraryTextStylesAsync etc. don't exist).
  // Instead, we enumerate local styles which include any imported library styles.
  // For library style discovery, use the Figma MCP's search_design_system tool.

  try {
    const localText = await figma.getLocalTextStylesAsync();
    for (const s of localText) {
      if (nameFilter && !s.name.toLowerCase().includes(nameFilter.toLowerCase())) continue;
      textStyles.push({ id: s.id, name: s.name, key: s.key || null });
    }
  } catch (e) { /* no local text styles */ }

  try {
    const localColor = await figma.getLocalPaintStylesAsync();
    for (const s of localColor) {
      if (nameFilter && !s.name.toLowerCase().includes(nameFilter.toLowerCase())) continue;
      colorStyles.push({ id: s.id, name: s.name, key: s.key || null });
    }
  } catch (e) { /* no local color styles */ }

  try {
    const localEffect = await figma.getLocalEffectStylesAsync();
    for (const s of localEffect) {
      if (nameFilter && !s.name.toLowerCase().includes(nameFilter.toLowerCase())) continue;
      effectStyles.push({ id: s.id, name: s.name, key: s.key || null });
    }
  } catch (e) { /* no local effect styles */ }

  return {
    textStyles: textStyles,
    colorStyles: colorStyles,
    effectStyles: effectStyles,
    counts: { text: textStyles.length, color: colorStyles.length, effect: effectStyles.length },
    note: "Returns local/imported styles only. For library style discovery, use search_design_system from the Figma MCP.",
  };
}

// Discover ALL library variable collections and their variables.
// Returns variable keys grouped by collection, usable with importVariableByKeyAsync.
async function handleDiscoverLibraryVariables(params) {
  const nameFilter = params.nameFilter || null;
  const collections = [];

  try {
    const libCollections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    for (const col of libCollections) {
      const colData = { key: col.key, name: col.name, libraryName: col.libraryName || null, variables: [] };
      try {
        const vars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(col.key);
        for (const v of vars) {
          if (nameFilter && !v.name.toLowerCase().includes(nameFilter.toLowerCase())) continue;
          colData.variables.push({ key: v.key, name: v.name, resolvedType: v.resolvedType });
        }
      } catch (_) {}
      if (colData.variables.length > 0 || !nameFilter) {
        collections.push(colData);
      }
    }
  } catch (e) {
    return { collections: [], error: e.message };
  }

  return {
    collections: collections,
    totalVariables: collections.reduce((sum, c) => sum + c.variables.length, 0),
  };
}

// Get the published key of an INSTANCE node's main component
async function handleGetInstanceKey(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  if (node.type !== 'INSTANCE') throw new Error(`Node ${params.nodeId} is ${node.type}, expected INSTANCE`);
  const main = await node.getMainComponentAsync();
  if (!main) return { key: null, name: null, id: null };
  return { key: main.key, name: main.name, id: main.id };
}

// Swap the main component of a CHILD instance node found by walking a parent's subtree.
// Needed because figma.getNodeById("I…;…") returns a limited proxy that lacks swapMainComponent.
// Walking via .children gives the live InstanceNode with full API access.
// params: { parentNodeId, childMainComponentId, componentKey }
//   parentNodeId         — the top-level instance to walk (e.g. the badge table cell)
//   childMainComponentId — the mainComponent.id of the child instance to target (e.g. "1046:4847")
//   componentKey         — key of the new component to swap to
async function handleSwapChildComponent(params) {
  const parent = figma.getNodeById(params.parentNodeId);
  if (!parent) throw new Error(`Parent node ${params.parentNodeId} not found`);

  // Walk subtree to find the first INSTANCE whose mainComponent.id matches
  let target = null;
  async function walk(node) {
    if (target) return;
    if (node.type === 'INSTANCE') {
      const main = await node.getMainComponentAsync();
      if (main && main.id === params.childMainComponentId) {
        target = node;
        return;
      }
    }
    if ('children' in node) {
      for (const child of node.children) { await walk(child); }
    }
  }
  await walk(parent);

  if (!target) throw new Error(`No INSTANCE child with mainComponent.id="${params.childMainComponentId}" found under ${params.parentNodeId}`);

  const newComponent = await figma.importComponentByKeyAsync(params.componentKey);
  if (!newComponent) throw new Error(`Component key ${params.componentKey} could not be imported`);

  // Try swapMainComponent; fall back to setProperties INSTANCE_SWAP if available
  let swapped = false;
  if (typeof target.swapMainComponent === 'function') {
    target.swapMainComponent(newComponent);
    swapped = true;
  } else {
    // Fallback: look for an INSTANCE_SWAP component property and use setProperties
    const instSwapProps = Object.entries(target.componentProperties || {})
      .filter(([, v]) => v.type === 'INSTANCE_SWAP');
    if (instSwapProps.length > 0) {
      target.setProperties({ [instSwapProps[0][0]]: newComponent });
      swapped = true;
    }
  }
  if (!swapped) throw new Error(`swapMainComponent not a function and no INSTANCE_SWAP property found on target ${target.id}`);
  return { ok: true, swappedNodeId: target.id };
}

// Returns the .key of a COMPONENT or COMPONENT_SET node directly.
// params: { nodeId }
function handleGetNodeKey(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  if (!('key' in node)) throw new Error(`Node ${params.nodeId} (${node.type}) has no key property`);
  return { key: node.key, name: node.name, type: node.type };
}

// Returns all sibling variants in the same ComponentSet as the instance's main component.
// params: { nodeId } — must be an INSTANCE node (nested I... IDs supported)
async function handleGetComponentVariants(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  if (node.type !== 'INSTANCE') throw new Error(`Node ${params.nodeId} is ${node.type}, expected INSTANCE`);
  const main = await node.getMainComponentAsync();
  if (!main) throw new Error(`Could not resolve main component for ${params.nodeId}`);
  const parent = main.parent;
  if (!parent || parent.type !== 'COMPONENT_SET') {
    // Single component, no variants
    return { variants: [{ id: main.id, key: main.key, name: main.name }] };
  }
  const variants = parent.children.map(c => ({ id: c.id, key: c.key, name: c.name }));
  return { variants };
}

// Swap the main component of an INSTANCE node to a new component (by key).
// This changes which variant the instance is based on — bypasses setProperties entirely.
// params: { nodeId, componentKey }
async function handleSwapMainComponent(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  if (node.type !== 'INSTANCE') throw new Error(`Node ${params.nodeId} is ${node.type}, expected INSTANCE`);
  const component = await figma.importComponentByKeyAsync(params.componentKey);
  if (!component) throw new Error(`Component key ${params.componentKey} could not be imported`);
  node.swapMainComponent(component);
  return { ok: true, nodeId: node.id, componentKey: params.componentKey };
}

// Search for instances by component name on the current page
function handleFindInstances(params) {
  const search = (params.name || '').toLowerCase();
  const results = [];
  function walk(node) {
    if (node.type === 'INSTANCE' && node.name.toLowerCase().includes(search)) {
      results.push({ id: node.id, name: node.name });
    }
    if ('children' in node) node.children.forEach(walk);
    if (results.length >= 10) return;
  }
  figma.currentPage.children.forEach(walk);
  return { results };
}

// Resolve a variable ID to its name
async function handleResolveVariableId(params) {
  const v = await figma.variables.getVariableByIdAsync(params.variableId);
  if (!v) return { name: null, resolvedType: null };
  return { name: v.name, resolvedType: v.resolvedType, id: v.id };
}

// Get fill/stroke bound variables from any node
function handleGetFillInfo(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  const bv = node.boundVariables || {};
  return {
    type: node.type, name: node.name,
    fillVariables: bv.fills || null,
    strokeVariables: bv.strokes || null,
  };
}

// Get the textStyleId, fontName, fontSize, and fill variable of a TEXT node
function handleGetTextInfo(params) {
  const node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  if (node.type !== 'TEXT') throw new Error(`Node ${params.nodeId} is not TEXT (got ${node.type})`);
  const fillVar = node.boundVariables && node.boundVariables.fills
    ? node.boundVariables.fills[0] : null;
  return {
    textStyleId: node.textStyleId || null,
    fontName: node.fontName,
    fontSize: node.fontSize,
    characters: node.characters.slice(0, 40),
    fillVariable: fillVar,
  };
}

// ---------------------------------------------------------------------------
// Chart rendering
// ---------------------------------------------------------------------------

// Deterministic pseudo-random in [-0.5, 0.5) based on index + seed
function det(i, seed) {
  const v = Math.sin(i * seed) * 43758.5453123;
  return v - Math.floor(v) - 0.5;
}

// Chart DS context — set by handleCreateChart before delegating to chart-specific handlers.
// Contains DS variable/style references the chart should use instead of hardcoded values.
// If null, chart falls back to raw values (permissive mode only).
// Chart color fallbacks: when DS variables are not provided, use neutral grays.
// These are intentionally DS-agnostic — no specific DS's color palette is assumed.
// Neutral dark: #212121 (rgb 0.13), Neutral mid: #757575 (rgb 0.46), Neutral light: #F7F7F7 (rgb 0.97)
var chartDsContext = null;
var chartDsBound = { bg: false, radius: false }; // Track what makeChartOuter successfully bound

// Create the outer container frame for a chart (no auto-layout, optional clip)
// DS-aware: tries to bind bg fill and corner radius from chartDsContext.
async function makeChartOuter(name, parentNodeId, w, h) {
  const f = figma.createFrame();
  f.name = name;
  f.resize(w, h);
  f.fills = [];
  f.clipsContent = false;
  chartDsBound.bg = false;
  chartDsBound.radius = false;

  // DS: bind background and radius from chart context if available
  if (chartDsContext) {
    if (chartDsContext.bgVariable) {
      try {
        var bgResult = await applyFill(f, chartDsContext.bgVariable);
        if (bgResult && bgResult.bound) chartDsBound.bg = true;
      } catch(_) {}
    }
    if (chartDsContext.radiusVariable) {
      try {
        await applySpacing(f, 'cornerRadius', chartDsContext.radiusVariable);
        chartDsBound.radius = true;
      } catch(_) {}
    }
  }

  if (parentNodeId) {
    const p = figma.getNodeById(parentNodeId);
    if (p && 'appendChild' in p) {
      p.appendChild(f);
    } else {
      figma.currentPage.appendChild(f);
    }
  } else {
    figma.currentPage.appendChild(f);
  }
  return f;
}

// Append a 1px grid line rectangle to a frame
// DS-aware: tries to use grid color from chartDsContext.
async function gridLine(parent, x, y, w, h) {
  const r = figma.createRectangle();
  r.name = 'grid';
  r.resize(Math.max(1, w), Math.max(1, h));
  r.x = x; r.y = y;
  var gridBound = false;
  if (chartDsContext && chartDsContext.gridVariable) {
    try {
      var gridResult = await applyFill(r, chartDsContext.gridVariable);
      gridBound = gridResult && gridResult.bound;
    } catch(_) {}
  }
  if (!gridBound) {
    r.fills = [{ type: 'SOLID', color: { r: 0.906, g: 0.918, b: 0.933 } }];
  }
  r.strokes = [];
  parent.appendChild(r);
}

// Append a text label at (x, y). align: 'left' | 'center' | 'right'
// DS-aware: tries to apply text style and fill variable from chartDsContext.
async function chartLabel(parent, text, x, y, fontSize, colorRGB, align) {
  const node = figma.createText();
  var fontFamily = (chartDsContext && chartDsContext.fontFamily) || sessionDefaults.fontFamily || 'Inter';
  node.fontName = { family: fontFamily, style: 'Regular' };
  node.fontSize = fontSize || 11;
  node.characters = String(text);

  // DS: try text style and fill variable
  var fillBound = false;
  if (chartDsContext && chartDsContext.labelTextStyleId) {
    try {
      var styled = await applyTextStyle(node, chartDsContext.labelTextStyleId);
      if (styled) node.fontSize = fontSize || node.fontSize; // restore chart-specific size if needed
    } catch(_) {}
  }
  if (chartDsContext && chartDsContext.labelFillVariable) {
    try {
      var result = await applyFill(node, chartDsContext.labelFillVariable);
      fillBound = result && result.bound;
    } catch(_) {}
  }
  if (!fillBound) {
    node.fills = [{ type: 'SOLID', color: colorRGB || { r: 0.46, g: 0.46, b: 0.46 } }];
  }

  parent.appendChild(node);
  const a = align || 'left';
  if (a === 'center') node.x = x - node.width / 2;
  else if (a === 'right') node.x = x - node.width;
  else node.x = x;
  node.y = y;
  return node;
}

// ── Scatter / jitter chart ────────────────────────────────────────────────────
//
// params.data:          [{x: number, category: string}, ...]
// params.categories:    { "Correct": "#17B26A", "Failed": "#F97066" }
// params.categoryOrder: ["Correct", "Failed"]   (top → bottom)
// params.xDomain:       [0, 19]
// params.xTicks:        [0, 3.8, 7.6, ...]
// params.tickSuffix:    "s"
// params.xLabel:        "Response Latency"
// params.dotSize:       7
// params.jitter:        true

async function handleScatterChart(params) {
  const w            = params.width  || 1200;
  const h            = params.height || 320;
  const data         = params.data   || [];
  const categories   = params.categories   || {};
  const catOrder     = params.categoryOrder || Object.keys(categories);
  const xDomain      = params.xDomain  || [0, 1];
  const xTicks       = params.xTicks   || [];
  const tickSuffix   = params.tickSuffix !== undefined ? params.tickSuffix : '';
  const xLabel       = params.xLabel   || '';
  const dotR         = params.dotSize  !== undefined ? params.dotSize : 7;
  const doJitter     = params.jitter   !== false;
  const chartName    = params.name     || 'Scatter Chart';

  await figma.loadFontAsync({ family: sessionDefaults.fontFamily || 'Inter', style: 'Regular' });

  // Layout constants
  const PAD_L  = 58;
  const PAD_T  = 8;
  const PAD_R  = 16;
  const PAD_B  = 36;
  const LEG_H  = 24;

  const plotX = PAD_L;
  const plotY = PAD_T + LEG_H;
  const plotW = w - PAD_L - PAD_R;
  const plotH = h - PAD_T - LEG_H - PAD_B;

  const nCats = catOrder.length;
  const bandH = plotH / Math.max(nCats, 1);

  // Scales (relative to outer frame for labels; relative to plot frame for dots)
  const xNorm  = v => (v - xDomain[0]) / (xDomain[1] - xDomain[0]);
  const xAbs   = v => plotX + xNorm(v) * plotW;   // used for tick label x positions

  const yBandRel = cat => {                        // center of band, relative to plot frame
    const idx = catOrder.indexOf(cat);
    return (idx < 0 ? nCats / 2 : idx) * bandH + bandH / 2;
  };

  // Outer frame
  const outer = await makeChartOuter(chartName, params.parentNodeId, w, h);
  if (!chartDsBound.bg) outer.fills = [{ type: 'SOLID', color: { r: 0.97, g: 0.97, b: 0.97 } }];
  if (!chartDsBound.radius) outer.cornerRadius = 8;

  // ── Plot clip frame ────────────────────────────────────────────────────────
  const plot = figma.createFrame();
  plot.name = 'plot-area';
  plot.resize(plotW, plotH);
  plot.x = plotX;
  plot.y = plotY;
  plot.fills = [];
  plot.clipsContent = true;
  outer.appendChild(plot);

  // Horizontal grid lines at band boundaries (relative to plot)
  for (let i = 0; i <= nCats; i++) {
    await gridLine(plot, 0, i * bandH, plotW, 1);
  }
  // Vertical grid lines at x-ticks (relative to plot)
  for (const tick of xTicks) {
    await gridLine(plot, xNorm(tick) * plotW, 0, 1, plotH);
  }

  // Data dots (relative to plot)
  var catVars = params.categoryVariables || {};
  for (let i = 0; i < data.length; i++) {
    const pt    = data[i];
    const jx    = doJitter ? det(i, 127.1) * 5 : 0;
    const jy    = doJitter ? det(i, 311.7) * bandH * 0.38 : 0;
    const cx    = Math.min(Math.max(xNorm(pt.x) * plotW + jx, 0), plotW);
    const cy    = yBandRel(pt.category) + jy;
    const dot   = figma.createEllipse();
    dot.resize(dotR, dotR);
    dot.x = cx - dotR / 2;
    dot.y = cy - dotR / 2;
    // DS variable first, then hex fallback
    var dotVarPath = catVars[pt.category] || null;
    var dotHex = categories[pt.category] || '#888888';
    try {
      await applyFill(dot, dotVarPath, dotHex);
    } catch(_) {
      dot.fills = [{ type: 'SOLID', color: hexToRgb(dotHex), opacity: 0.85 }];
    }
    dot.strokes = [];
    plot.appendChild(dot);
  }

  // ── Labels outside the plot (relative to outer) ──────────────────────────
  // Y-axis category labels
  for (const cat of catOrder) {
    const yc = plotY + yBandRel(cat);
    await chartLabel(outer, cat, 4, yc - 8, 11);
  }

  // X-axis tick labels
  for (const tick of xTicks) {
    const xPos = xAbs(tick);
    const lbl  = tick === 0 ? '0ms' : String(tick) + tickSuffix;
    await chartLabel(outer, lbl, xPos, plotY + plotH + 8, 11, null, 'center');
  }

  // X-axis label
  if (xLabel) {
    await chartLabel(outer, xLabel, plotX + plotW / 2, h - 18, 12,
                     { r: 0.13, g: 0.13, b: 0.13 }, 'center');
  }

  // Legend (top-right, right → left)
  let lx = w - PAD_R;
  for (let li = catOrder.length - 1; li >= 0; li--) {
    const cat   = catOrder[li];
    const color = hexToRgb(categories[cat] || '#888888');

    const ltxt = figma.createText();
    ltxt.fontName = { family: sessionDefaults.fontFamily || 'Inter', style: 'Regular' };
    ltxt.fontSize = 11;
    ltxt.characters = cat;
    ltxt.fills = [{ type: 'SOLID', color: { r: 0.13, g: 0.13, b: 0.13 } }];
    outer.appendChild(ltxt);
    lx -= ltxt.width;
    ltxt.x = lx;
    ltxt.y = 5;

    const ldot = figma.createEllipse();
    ldot.resize(9, 9);
    ldot.fills   = [{ type: 'SOLID', color }];
    ldot.strokes = [];
    lx -= 13;
    ldot.x = lx;
    ldot.y = 5;
    outer.appendChild(ldot);
    lx -= 18;
  }

  return { nodeId: outer.id, name: outer.name };
}

// ── Line chart ────────────────────────────────────────────────────────────────
//
// params.series: [{name, color, data: [{x, y}], area: false, strokeWidth: 2}]
// params.xDomain / yDomain: [min, max]
// params.xTicks / yTicks: [...]
// params.xTickSuffix / yTickSuffix: string
// params.xLabel / yLabel: string

async function handleLineChart(params) {
  const w     = params.width  || 800;
  const h     = params.height || 300;
  const series    = params.series   || [];
  const xDomain   = params.xDomain  || [0, 1];
  const yDomain   = params.yDomain  || [0, 1];
  const xTicks    = params.xTicks   || [];
  const yTicks    = params.yTicks   || [];
  const xTickSfx  = params.xTickSuffix !== undefined ? params.xTickSuffix : '';
  const yTickSfx  = params.yTickSuffix !== undefined ? params.yTickSuffix : '';
  const xLabel    = params.xLabel  || '';
  const yLabel    = params.yLabel  || '';
  const chartName = params.name    || 'Line Chart';

  await figma.loadFontAsync({ family: sessionDefaults.fontFamily || 'Inter', style: 'Regular' });

  const PAD_L = 52;
  const PAD_T = 8;
  const PAD_R = 16;
  const PAD_B = 36;
  const LEG_H = 24;

  const plotX = PAD_L;
  const plotY = PAD_T + LEG_H;
  const plotW = w - PAD_L - PAD_R;
  const plotH = h - PAD_T - LEG_H - PAD_B;

  const xScale = v => plotX + (v - xDomain[0]) / (xDomain[1] - xDomain[0]) * plotW;
  const yScale = v => plotY + plotH - (v - yDomain[0]) / (yDomain[1] - yDomain[0]) * plotH;

  const outer = await makeChartOuter(chartName, params.parentNodeId, w, h);
  if (!chartDsBound.bg) outer.fills = [{ type: 'SOLID', color: { r: 0.97, g: 0.97, b: 0.97 } }];
  if (!chartDsBound.radius) outer.cornerRadius = 8;

  // Grid lines
  for (const tick of yTicks) await gridLine(outer, plotX, yScale(tick), plotW, 1);
  for (const tick of xTicks) await gridLine(outer, xScale(tick), plotY, 1, plotH);
  await gridLine(outer, plotX, plotY + plotH, plotW, 1); // x-axis baseline
  await gridLine(outer, plotX, plotY, 1, plotH);          // y-axis baseline

  // Axis tick labels
  for (const tick of yTicks) {
    await chartLabel(outer, String(tick) + yTickSfx, plotX - 4, yScale(tick) - 8, 11, null, 'right');
  }
  for (const tick of xTicks) {
    await chartLabel(outer, String(tick) + xTickSfx, xScale(tick), plotY + plotH + 8, 11, null, 'center');
  }

  if (xLabel) await chartLabel(outer, xLabel, plotX + plotW / 2, h - 18, 12, { r: 0.13, g: 0.13, b: 0.13 }, 'center');
  if (yLabel) await chartLabel(outer, yLabel, 4, plotY + plotH / 2, 12, { r: 0.13, g: 0.13, b: 0.13 }, 'left');

  // Series
  for (const s of series) {
    if (!s.data || s.data.length < 2) continue;
    const color = hexToRgb(s.color || '#6941C6');
    var seriesVarPath = s.colorVariable || null;
    const pts   = [...s.data].sort((a, b) => a.x - b.x)
                             .map(pt => ({ px: xScale(pt.x), py: yScale(pt.y) }));

    // Area fill
    if (s.area) {
      const by = plotY + plotH;
      let d = 'M ' + pts[0].px + ' ' + by;
      for (const p of pts) d += ' L ' + p.px + ' ' + p.py;
      d += ' L ' + pts[pts.length - 1].px + ' ' + by + ' Z';
      const av = figma.createVector();
      av.vectorPaths = [{ windingRule: 'NONZERO', data: d }];
      av.fills   = [{ type: 'SOLID', color, opacity: 0.15 }];
      av.strokes = [];
      outer.appendChild(av);
    }

    // Line (smooth cubic bezier)
    let d = 'M ' + pts[0].px + ' ' + pts[0].py;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1], curr = pts[i];
      const cpx  = (prev.px + curr.px) / 2;
      d += ' C ' + cpx + ' ' + prev.py + ' ' + cpx + ' ' + curr.py + ' ' + curr.px + ' ' + curr.py;
    }
    const lv = figma.createVector();
    lv.vectorPaths  = [{ windingRule: 'NONZERO', data: d }];
    lv.fills        = [];
    lv.strokes      = [{ type: 'SOLID', color }];
    lv.strokeWeight = s.strokeWidth !== undefined ? s.strokeWidth : 2;
    lv.strokeCap    = 'ROUND';
    lv.strokeJoin   = 'ROUND';
    outer.appendChild(lv);
  }

  // Legend (top-right)
  let lx = w - PAD_R;
  for (let li = series.length - 1; li >= 0; li--) {
    const s     = series[li];
    const color = hexToRgb(s.color || '#6941C6');
    const ltxt  = figma.createText();
    ltxt.fontName  = { family: sessionDefaults.fontFamily || 'Inter', style: 'Regular' };
    ltxt.fontSize  = 11;
    ltxt.characters = s.name || '';
    ltxt.fills = [{ type: 'SOLID', color: { r: 0.13, g: 0.13, b: 0.13 } }];
    outer.appendChild(ltxt);
    lx -= ltxt.width;
    ltxt.x = lx; ltxt.y = 5;

    const sw = figma.createRectangle();
    sw.resize(16, 3);
    sw.fills = [{ type: 'SOLID', color }];
    sw.cornerRadius = 2;
    lx -= 20;
    sw.x = lx; sw.y = 11;
    outer.appendChild(sw);
    lx -= 16;
  }

  return { nodeId: outer.id, name: outer.name };
}

// ── Donut / pie chart ─────────────────────────────────────────────────────────
//
// params.data:         [{label, value, color}, ...]
// params.size:         240  (outer diameter)
// params.innerRadius:  0.6  (0 = pie, 0.6 = donut)
// params.centerLabel / centerSubLabel: string (donut center text)
//
// Figma vectorPaths does NOT support SVG 'A' arc commands. Arcs are approximated
// with cubic bezier curves using the standard k = (4/3)*tan(dA/4) formula.
// Each arc is split into ≤90° segments for accuracy.

function arcToBezier(cx, cy, R, a0, a1) {
  const steps = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2)));
  const dA = (a1 - a0) / steps;
  const k  = (4 / 3) * Math.tan(dA / 4);
  const parts = [];
  for (let i = 0; i < steps; i++) {
    const sa = a0 + i * dA, ea = sa + dA;
    const cs = Math.cos(sa), ss = Math.sin(sa);
    const ce = Math.cos(ea), se = Math.sin(ea);
    const px = cx + R * cs, py = cy + R * ss;
    if (i === 0) parts.push('M ' + px + ' ' + py);
    parts.push('C ' + (px - k*R*ss) + ' ' + (py + k*R*cs) +
               ' ' + (cx + R*ce + k*R*se) + ' ' + (cy + R*se - k*R*ce) +
               ' ' + (cx + R*ce) + ' ' + (cy + R*se));
  }
  return parts.join(' ');
}

// Apply a text style by its full style ID (e.g. "S:abc123,7649:603") or key.
// Imports from library if not yet local.
async function applyTextStyle(node, styleIdOrKey) {
  if (!styleIdOrKey) return false;

  // Strategy 1: If it looks like a Figma style ID (contains ":" or starts with "S:"), assign directly
  if (styleIdOrKey.includes(':') || styleIdOrKey.startsWith('S:')) {
    try {
      node.textStyleId = styleIdOrKey;
      return true;
    } catch (_) { /* not a valid style ID — try as key */ }
  }

  // Strategy 2: Treat as a style key — import from library then assign
  // Time-bounded to prevent hanging when Figma API is slow
  const key = styleIdOrKey.replace(/^S:/, '').split(',')[0];
  try {
    const imported = await Promise.race([
      figma.importStyleByKeyAsync(key),
      new Promise((_, reject) => setTimeout(() => reject(new Error('style import timeout')), 20000)),
    ]);
    if (imported && imported.id) {
      node.textStyleId = imported.id;
      return true;
    }
  } catch (e) {
    // Import failed or timed out — fall through to raw
  }

  return false;
}

async function handleDonutChart(params) {
  const size        = params.size         || 240;
  const innerRatio  = params.innerRadius  !== undefined ? params.innerRadius : 0.6;
  const data        = params.data         || [];
  const centerLabel = params.centerLabel  || '';
  const centerSub   = params.centerSubLabel || '';
  const chartName   = params.name         || 'Donut Chart';
  const noLegend    = params.noLegend     || false;
  const legendPos   = params.legendPosition || 'right'; // 'right' or 'bottom'
  // Color variables for text (use discovered library variable paths)
  const centerColorVar    = params.centerColorVariable    || null;
  const centerSubColorVar = params.centerSubColorVariable || null;
  // Text style IDs — optional, pass via params.centerTextStyleId / params.centerSubTextStyleId
  const centerStyleId    = params.centerTextStyleId    || null;
  const centerSubStyleId = params.centerSubTextStyleId || null;

  await figma.loadFontAsync({ family: sessionDefaults.fontFamily || 'Inter', style: 'Regular' });
  if (centerLabel) await figma.loadFontAsync({ family: sessionDefaults.fontFamily || 'Inter', style: 'Bold' });

  const LEGEND_W = noLegend ? 0 : 160;
  const LEGEND_H_BELOW = noLegend ? 0 : (data.length * 22 + 20); // height when legend is below
  const PAD = noLegend ? 0 : 20;
  var totalW, totalH;
  if (noLegend) {
    totalW = size;
    totalH = size;
  } else if (legendPos === 'bottom') {
    totalW = size + PAD * 2;
    totalH = size + PAD * 2 + LEGEND_H_BELOW;
  } else {
    totalW = size + PAD + LEGEND_W;
    totalH = size + PAD * 2;
  }

  const outer = await makeChartOuter(chartName, params.parentNodeId, totalW, totalH);
  if (!chartDsBound.bg) outer.fills = [];
  if (params.x !== undefined) outer.x = params.x;
  if (params.y !== undefined) outer.y = params.y;

  const cx = (noLegend ? 0 : PAD) + size / 2;
  const cy = (noLegend ? 0 : PAD) + size / 2;
  const R  = size / 2;
  const r  = R * innerRatio;

  const total = data.reduce((s, d) => s + (d.value || 0), 0);
  if (total === 0) return { nodeId: outer.id };

  let startAngle = -Math.PI / 2; // start at 12 o'clock

  for (const seg of data) {
    if (!seg.value) continue;
    const angle    = (seg.value / total) * 2 * Math.PI;
    const endAngle = startAngle + angle;

    // Build slice path using cubic bezier arcs (Figma doesn't support SVG 'A')
    let d;
    if (innerRatio > 0) {
      const outerPath = arcToBezier(cx, cy, R, startAngle, endAngle);
      const innerPath = arcToBezier(cx, cy, r, endAngle, startAngle);
      const ix = cx + r * Math.cos(endAngle), iy = cy + r * Math.sin(endAngle);
      d = outerPath + ' L ' + ix + ' ' + iy + ' ' + innerPath.replace(/^M [^ ]+ [^ ]+ /, '') + ' Z';
    } else {
      const outerPath = arcToBezier(cx, cy, R, startAngle, endAngle);
      d = 'M ' + cx + ' ' + cy + ' L ' + outerPath.replace(/^M /, '').split(' C ')[0] +
          ' ' + outerPath.replace(/^M [^ ]+ [^ ]+ /, '') + ' Z';
    }

    const slice = figma.createVector();
    slice.name = seg.label || 'Slice';
    slice.vectorPaths = [{ windingRule: 'NONZERO', data: d }];
    // Apply fill: use variable if provided, fall back to hex color
    await applyFill(slice, seg.colorVariable || null, seg.color || '#888888');
    slice.strokes = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    slice.strokeWeight = 2;
    outer.appendChild(slice);

    startAngle = endAngle;
  }

  // Center text
  if (centerLabel) {
    const ct = figma.createText();
    ct.fontName  = { family: sessionDefaults.fontFamily || 'Inter', style: 'Bold' };
    ct.fontSize  = 22;
    ct.characters = centerLabel;
    await applyTextStyle(ct, centerStyleId);
    await applyFill(ct, centerColorVar, '#212121');
    outer.appendChild(ct);
    ct.x = cx - ct.width / 2;
    ct.y = cy - ct.height / 2 - (centerSub ? 10 : 0);

    if (centerSub) {
      const cs = figma.createText();
      cs.fontName  = { family: sessionDefaults.fontFamily || 'Inter', style: 'Regular' };
      cs.fontSize  = 12;
      cs.characters = centerSub;
      await applyTextStyle(cs, centerSubStyleId);
      await applyFill(cs, centerSubColorVar, '#757575');
      outer.appendChild(cs);
      cs.x = cx - cs.width / 2;
      cs.y = cy + 6;
    }
  }

  // Legend
  if (!noLegend) {
  var ly, lx;
  if (legendPos === 'bottom') {
    lx = PAD;
    ly = PAD + size + PAD;
  } else {
    lx = PAD + size + PAD;
    ly = PAD;
  }
  for (const seg of data) {
    const pct = Math.round((seg.value / total) * 100);

    const dot = figma.createEllipse();
    dot.resize(8, 8);
    await applyFill(dot, seg.colorVariable || null, seg.color || '#888888');
    dot.strokes = [];
    dot.x = lx; dot.y = ly + 1;
    outer.appendChild(dot);

    const lbl = figma.createText();
    lbl.fontName  = { family: sessionDefaults.fontFamily || 'Inter', style: 'Regular' };
    lbl.fontSize  = 12;
    lbl.characters = (seg.label || '') + '  ' + pct + '%';
    await applyTextStyle(lbl, params.legendTextStyleId || null);
    await applyFill(lbl, null, '#212121');
    outer.appendChild(lbl);
    lbl.x = lx + 12; lbl.y = ly;
    ly += 22;
  }
  } // end !noLegend

  return { nodeId: outer.id, name: outer.name };
}

// ── Bar / histogram chart ─────────────────────────────────────────────────────
//
// params.bars:         [{label: string, segments: [{category, value}, ...]}, ...]
// params.categories:   { "Correct": "#17B26A", "Failed": "#F04438" }
// params.yDomain:      [0, 100]
// params.yTicks:       [0, 25, 50, 75, 100]
// params.yTickSuffix:  ''
// params.xLabel:       'Response time (seconds)'
// params.yLabel:       'Prompts'  (shown top-left, no rotation)
// params.annotations:  [{type:'vline', barIndex: 4.8, label:'Median 4.8s', color:'#888'}]

async function handleBarChart(params) {
  const w           = params.width   || 800;
  const h           = params.height  || 300;
  const bars        = params.bars    || [];
  var   categories  = params.categories  || {};

  // Normalize flat bars → stacked segment format.
  // MCP sends: [{label, value, color}, ...] (simple bars)
  // Handler expects: [{label, segments: [{category, value}]}, ...] (stacked bars)
  var isFlatBars = false;
  for (var i = 0; i < bars.length; i++) {
    if (!bars[i].segments) {
      isFlatBars = true;
      var barColor = bars[i].color || '#888888';
      bars[i].segments = [{ category: barColor, value: bars[i].value || 0 }];
      if (!categories[barColor]) categories[barColor] = barColor;
    }
  }
  // For flat bars: skip the stacked-segment legend (hex codes aren't useful labels).
  // The bars are self-descriptive via their x-axis labels.
  // Keep categories for color lookup but suppress the legend.
  var suppressLegend = isFlatBars;
  const yDomain     = params.yDomain     || [0, 100];
  const yTicks      = params.yTicks      || [];
  const yTickSfx    = params.yTickSuffix !== undefined ? params.yTickSuffix : '';
  const xLabel      = params.xLabel  || '';
  const yLabel      = params.yLabel  || '';
  const chartName   = params.name    || 'Bar Chart';
  const annotations = params.annotations || [];

  await figma.loadFontAsync({ family: sessionDefaults.fontFamily || 'Inter', style: 'Regular' });

  const PAD_L    = 52;   // left padding for y-axis labels
  const PAD_R    = 16;
  const BAR_GAP  = 3;

  const nBars  = bars.length;
  const yRange = yDomain[1] - yDomain[0];
  const plotW  = w - PAD_L - PAD_R;
  const plotH  = h - 80;  // reserve space for legend row + label row + x-axis title

  // ── Outer frame: VERTICAL auto-layout ──────────────────────────────────────
  const outer = await makeChartOuter(chartName, params.parentNodeId, w, h);
  if (!chartDsBound.bg) outer.fills = [{ type: 'SOLID', color: { r: 0.97, g: 0.97, b: 0.97 } }];
  if (!chartDsBound.radius) outer.cornerRadius = 8;

  // Cleanup on failure: if anything below throws, remove the outer frame so
  // failed chart attempts don't leave orphaned nodes.
  try {
  outer.layoutMode            = 'VERTICAL';
  outer.primaryAxisAlignItems  = 'MIN';
  outer.counterAxisAlignItems  = 'MIN';
  outer.paddingTop    = 8;
  outer.paddingBottom = 8;
  outer.paddingLeft   = 0;
  outer.paddingRight  = PAD_R;
  outer.itemSpacing   = 4;
  outer.layoutSizingHorizontal = 'FIXED';
  outer.layoutSizingVertical   = 'FIXED';

  // ── Legend row (HORIZONTAL, right-aligned) ─────────────────────────────────
  const catEntries = Object.entries(categories);
  if (catEntries.length > 0 && !suppressLegend) {
    const legendRow = figma.createFrame();
    legendRow.name = 'legend';
    legendRow.layoutMode = 'HORIZONTAL';
    legendRow.primaryAxisAlignItems = 'MAX';   // push items to the right
    legendRow.counterAxisAlignItems = 'CENTER';
    legendRow.itemSpacing = 12;
    legendRow.fills = [];
    legendRow.layoutSizingVertical   = 'HUG';
    legendRow.paddingLeft = PAD_L;
    // Append to outer BEFORE setting FILL (Figma requires auto-layout parent)
    outer.appendChild(legendRow);
    legendRow.layoutSizingHorizontal = 'FILL';

    for (const [cat, hex] of catEntries) {
      const color = hexToRgb(hex);
      const entry = figma.createFrame();
      entry.name = 'legend-entry';
      entry.layoutMode = 'HORIZONTAL';
      entry.counterAxisAlignItems = 'CENTER';
      entry.itemSpacing = 4;
      entry.fills = [];
      entry.layoutSizingHorizontal = 'HUG';
      entry.layoutSizingVertical   = 'HUG';

      const sw = figma.createRectangle();
      sw.resize(10, 10);
      sw.cornerRadius = 2;
      sw.fills   = [{ type: 'SOLID', color }];
      sw.strokes = [];
      entry.appendChild(sw);

      const ltxt = figma.createText();
      ltxt.fontName  = { family: sessionDefaults.fontFamily || 'Inter', style: 'Regular' };
      ltxt.fontSize  = 11;
      ltxt.characters = cat;
      ltxt.fills = [{ type: 'SOLID', color: { r: 0.13, g: 0.13, b: 0.13 } }];
      entry.appendChild(ltxt);

      legendRow.appendChild(entry);
    }
    // legendRow already appended above
  }

  // ── Y-axis label (above the plot area) ─────────────────────────────────────
  if (yLabel) {
    const yLabelNode = figma.createText();
    yLabelNode.fontName = { family: sessionDefaults.fontFamily || 'Inter', style: 'Regular' };
    yLabelNode.fontSize = 10;
    yLabelNode.characters = yLabel;
    yLabelNode.fills = [{ type: 'SOLID', color: { r: 0.46, g: 0.46, b: 0.46 } }];
    const yLabelWrap = figma.createFrame();
    yLabelWrap.name = 'y-label';
    yLabelWrap.fills = [];
    yLabelWrap.layoutMode = 'HORIZONTAL';
    yLabelWrap.paddingLeft = PAD_L;
    yLabelWrap.layoutSizingVertical   = 'HUG';
    yLabelWrap.appendChild(yLabelNode);
    outer.appendChild(yLabelWrap);
    yLabelWrap.layoutSizingHorizontal = 'FILL';
  }

  // ── Plot area (absolute positioning for grid + y-labels; contains AL bar row)
  const plotArea = figma.createFrame();
  plotArea.name = 'plot-area';
  plotArea.resize(w - PAD_R, plotH);
  plotArea.fills = [];
  plotArea.clipsContent = true;
  plotArea.layoutSizingVertical   = 'FIXED';
  outer.appendChild(plotArea);
  plotArea.layoutSizingHorizontal = 'FILL';

  // Horizontal grid lines at y-ticks (absolute within plot area)
  for (const tick of yTicks) {
    const yPos = plotH - (tick - yDomain[0]) / yRange * plotH;
    await gridLine(plotArea, PAD_L, yPos, plotW, 1);
  }
  // Baseline + y-axis line
  await gridLine(plotArea, PAD_L, plotH, plotW, 1);
  await gridLine(plotArea, PAD_L, 0, 1, plotH);

  // Y-axis tick labels (absolute within plot area)
  for (const tick of yTicks) {
    const yPos = plotH - (tick - yDomain[0]) / yRange * plotH;
    await chartLabel(plotArea, String(tick) + yTickSfx, PAD_L - 4, yPos - 8, 11, null, 'right');
  }

  // ── Bar row: HORIZONTAL auto-layout, bottom-aligned ───────────────────────
  const barRow = figma.createFrame();
  barRow.name = 'bar-row';
  barRow.layoutMode = 'HORIZONTAL';
  barRow.counterAxisAlignItems = 'MAX';   // bottom-align bars
  barRow.primaryAxisAlignItems = 'MIN';
  barRow.itemSpacing = BAR_GAP;
  barRow.fills = [];
  barRow.resize(plotW, plotH);
  barRow.x = PAD_L;
  barRow.y = 0;
  barRow.layoutSizingHorizontal = 'FIXED';
  barRow.layoutSizingVertical   = 'FIXED';
  plotArea.appendChild(barRow);

  // Build bars — each bar column gets layoutGrow: 1
  var barCatVars = params.categoryVariables || {};
  for (let i = 0; i < nBars; i++) {
    const bar = bars[i];

    // Single-segment: just a rectangle with layoutGrow
    if (bar.segments.length === 1) {
      const seg    = bar.segments[0];
      const segHex = categories[seg.category] || '#888888';
      const segPx  = Math.max(1, seg.value / yRange * plotH);

      const rect = figma.createRectangle();
      rect.name  = bar.label || seg.category;
      rect.resize(10, Math.max(1, segPx));   // width overridden by layoutGrow
      rect.layoutGrow = 1;
      rect.topLeftRadius    = 2;
      rect.topRightRadius   = 2;
      rect.bottomLeftRadius = 0;
      rect.bottomRightRadius= 0;
      rect.strokes = [];

      var barVarPath = barCatVars[seg.category] || null;
      try {
        await applyFill(rect, barVarPath, segHex);
      } catch(_) {
        rect.fills = [{ type: 'SOLID', color: hexToRgb(segHex) }];
      }
      barRow.appendChild(rect);
    } else {
      // Stacked: VERTICAL column, segments bottom-to-top
      const col = figma.createFrame();
      col.name = bar.label || ('bar-' + i);
      col.layoutMode = 'VERTICAL';
      col.primaryAxisAlignItems = 'MAX';    // stack from bottom
      col.counterAxisAlignItems = 'STRETCH';
      col.itemSpacing = 0;
      col.fills = [];
      col.layoutGrow = 1;
      col.layoutSizingVertical = 'HUG';

      // Segments rendered top-to-bottom in the column (last segment on top = first child)
      for (let si = bar.segments.length - 1; si >= 0; si--) {
        const seg    = bar.segments[si];
        const segHex = categories[seg.category] || '#888888';
        const segPx  = Math.max(0, seg.value / yRange * plotH);
        if (segPx < 0.5) continue;

        const rect = figma.createRectangle();
        rect.name  = seg.category;
        rect.resize(10, Math.max(1, segPx));
        rect.layoutSizingHorizontal = 'FILL';
        rect.strokes = [];

        var barVarPath2 = barCatVars[seg.category] || null;
        try {
          await applyFill(rect, barVarPath2, segHex);
        } catch(_) {
          rect.fills = [{ type: 'SOLID', color: hexToRgb(segHex) }];
        }

        // Round top corners on the topmost segment (first child = top of stack)
        if (si === bar.segments.length - 1) {
          rect.topLeftRadius    = 2;
          rect.topRightRadius   = 2;
          rect.bottomLeftRadius = 0;
          rect.bottomRightRadius= 0;
        }
        col.appendChild(rect);
      }
      barRow.appendChild(col);
    }
  }

  // Annotation lines (absolute within plot area)
  for (const ann of annotations) {
    if (ann.type !== 'vline') continue;
    const bi    = ann.barIndex !== undefined ? ann.barIndex : 0;
    const barGroupW = nBars > 0 ? plotW / nBars : plotW;
    const ax    = PAD_L + bi * barGroupW;
    const color = hexToRgb(ann.color || '#757575');
    const line  = figma.createRectangle();
    line.name   = 'annotation-' + (ann.label || 'line');
    line.resize(1, plotH);
    line.x = ax;
    line.y = 0;
    line.fills   = [{ type: 'SOLID', color, opacity: 0.8 }];
    line.strokes = [];
    plotArea.appendChild(line);
    if (ann.label) {
      await chartLabel(plotArea, ann.label, ax + 3, 4, 10, color, 'left');
    }
  }

  // ── Labels row: HORIZONTAL, SPACE_BETWEEN ─────────────────────────────────
  if (nBars > 0) {
    const labelsRow = figma.createFrame();
    labelsRow.name = 'x-labels';
    labelsRow.layoutMode = 'HORIZONTAL';
    labelsRow.primaryAxisAlignItems = 'SPACE_BETWEEN';
    labelsRow.counterAxisAlignItems = 'MIN';
    labelsRow.fills = [];
    labelsRow.paddingLeft  = PAD_L;
    labelsRow.paddingRight = 0;
    labelsRow.layoutSizingVertical   = 'HUG';
    // Append to outer BEFORE setting FILL
    outer.appendChild(labelsRow);
    labelsRow.layoutSizingHorizontal = 'FILL';

    // Group consecutive bars under one label. A bar with a non-empty label starts
    // a new group; bars with empty labels extend the previous group.
    // Each group gets a wrapper frame with one layoutGrow:1 slot per bar it spans,
    // because Figma only allows layoutGrow = 0 or 1.
    var groups = [];
    for (let i = 0; i < nBars; i++) {
      if (bars[i].label) {
        groups.push({ label: bars[i].label, span: 1 });
      } else if (groups.length > 0) {
        groups[groups.length - 1].span++;
      } else {
        groups.push({ label: '', span: 1 });
      }
    }
    for (const g of groups) {
      if (g.span === 1) {
        // Single bar: just a text node with layoutGrow: 1
        const lbl = figma.createText();
        lbl.fontName  = { family: sessionDefaults.fontFamily || 'Inter', style: 'Regular' };
        lbl.fontSize  = 10;
        lbl.characters = g.label;
        lbl.fills = [{ type: 'SOLID', color: { r: 0.46, g: 0.46, b: 0.46 } }];
        lbl.textAlignHorizontal = 'CENTER';
        labelsRow.appendChild(lbl);
        lbl.layoutGrow = 1;
      } else {
        // Multi-bar group: wrapper frame that spans multiple bar slots
        const wrap = figma.createFrame();
        wrap.name = 'label-group';
        wrap.layoutMode = 'HORIZONTAL';
        wrap.primaryAxisAlignItems = 'CENTER';
        wrap.fills = [];
        labelsRow.appendChild(wrap);
        wrap.layoutGrow = 1;
        // Add empty spacers for extra bar slots so the wrapper grows proportionally
        for (let s = 1; s < g.span; s++) {
          const spacer = figma.createFrame();
          spacer.name = 'spacer';
          spacer.resize(1, 1);
          spacer.fills = [];
          labelsRow.appendChild(spacer);
          spacer.layoutGrow = 1;
        }
        const lbl = figma.createText();
        lbl.fontName  = { family: sessionDefaults.fontFamily || 'Inter', style: 'Regular' };
        lbl.fontSize  = 10;
        lbl.characters = g.label;
        lbl.fills = [{ type: 'SOLID', color: { r: 0.46, g: 0.46, b: 0.46 } }];
        lbl.textAlignHorizontal = 'CENTER';
        wrap.appendChild(lbl);
        lbl.layoutSizingHorizontal = 'FILL';
      }
    }
  }

  // ── X-axis title ──────────────────────────────────────────────────────────
  if (xLabel) {
    const xLabelNode = figma.createText();
    xLabelNode.fontName = { family: sessionDefaults.fontFamily || 'Inter', style: 'Regular' };
    xLabelNode.fontSize = 12;
    xLabelNode.characters = xLabel;
    xLabelNode.fills = [{ type: 'SOLID', color: { r: 0.13, g: 0.13, b: 0.13 } }];
    xLabelNode.textAlignHorizontal = 'CENTER';
    outer.appendChild(xLabelNode);
    xLabelNode.layoutSizingHorizontal = 'FILL';
  }

  return { nodeId: outer.id, name: outer.name };

  } catch (e) {
    // Cleanup: remove the partially-built chart frame
    try { outer.remove(); } catch (_) {}
    throw e;
  }
}

// ── Radar chart ───────────────────────────────────────────────────────────────
//
// params.data:        [{label: string, value: number (0–1)}, ...]  ← min 3 points
// params.size:        280   (total square frame size; labels fit within padding)
// params.color:       "#6941c6"   (data polygon fill+stroke color)
// params.gridColor:   "#E4E4E7"   (grid rings + axis lines)
// params.rings:       [0.25, 0.5, 0.75, 1.0]

async function handleRadarChart(params) {
  const data       = params.data       || [];
  const size       = params.size       || 280;
  const color      = params.color      || '#6941c6';
  const gridHex    = params.gridColor  || '#E4E4E7';
  const rings      = params.rings      || [0.25, 0.5, 0.75, 1.0];
  const chartName  = params.name       || 'Radar Chart';

  const n = data.length;
  if (n < 3) throw new Error('Radar chart requires at least 3 data points');

  await figma.loadFontAsync({ family: sessionDefaults.fontFamily || 'Inter', style: 'Regular' });

  const LABEL_PAD = 32;
  const maxR = size / 2 - LABEL_PAD;
  const cx   = size / 2;
  const cy   = size / 2;

  const outer = await makeChartOuter(chartName, params.parentNodeId, size, size);
  if (!chartDsBound.bg) outer.fills = [];

  function ptAt(i, r) {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  }

  function polygonPath(r) {
    return data.map((_, i) => {
      const p = ptAt(i, r);
      return `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
    }).join(' ') + ' Z';
  }

  const gridRgb = hexToRgb(gridHex);
  const dataRgb = hexToRgb(color);

  // Grid rings
  for (const frac of rings) {
    const ring = figma.createVector();
    ring.name = `ring-${Math.round(frac * 100)}pct`;
    ring.vectorPaths = [{ windingRule: 'NONE', data: polygonPath(maxR * frac) }];
    ring.fills = [];
    ring.strokes = [{ type: 'SOLID', color: gridRgb }];
    ring.strokeWeight = 1;
    outer.appendChild(ring);
  }

  // Axis lines (center → each vertex)
  for (let i = 0; i < n; i++) {
    const tip = ptAt(i, maxR);
    const axis = figma.createVector();
    axis.name = `axis-${i}`;
    axis.vectorPaths = [{ windingRule: 'NONE',
      data: `M ${cx.toFixed(2)} ${cy.toFixed(2)} L ${tip.x.toFixed(2)} ${tip.y.toFixed(2)}` }];
    axis.fills = [];
    axis.strokes = [{ type: 'SOLID', color: gridRgb }];
    axis.strokeWeight = 1;
    outer.appendChild(axis);
  }

  // Data polygon
  const dataPts = data.map((d, i) => ptAt(i, maxR * Math.max(0, Math.min(1, d.value))));
  const dataPath = dataPts.map((p, i) =>
    `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') + ' Z';
  const dataPoly = figma.createVector();
  dataPoly.name = 'data-polygon';
  dataPoly.vectorPaths = [{ windingRule: 'NONZERO', data: dataPath }];
  dataPoly.fills   = [{ type: 'SOLID', color: dataRgb, opacity: 0.12 }];
  dataPoly.strokes = [{ type: 'SOLID', color: dataRgb }];
  dataPoly.strokeWeight = 2;
  outer.appendChild(dataPoly);

  // Dots at each data point
  const dotR = 4;
  for (let i = 0; i < n; i++) {
    const p = dataPts[i];
    const dot = figma.createEllipse();
    dot.name = `dot-${i}`;
    dot.resize(dotR * 2, dotR * 2);
    dot.x = p.x - dotR;
    dot.y = p.y - dotR;
    dot.fills   = [{ type: 'SOLID', color: dataRgb }];
    dot.strokes = [];
    outer.appendChild(dot);
  }

  // Labels (beyond axis tip)
  for (let i = 0; i < n; i++) {
    const p = ptAt(i, maxR + 16);
    await chartLabel(outer, data[i].label, p.x, p.y - 7, 10, null, 'center');
  }

  return { nodeId: outer.id, name: outer.name };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

async function handleCreateChart(params) {
  const t = params.chartType || '';

  // Set up DS context for chart helpers.
  // These params allow the orchestrator to pass DS variable paths for chart elements.
  chartDsContext = {
    bgVariable:         params.bgVariable || null,         // Outer frame background (e.g., "Colors/Background/bg-secondary")
    radiusVariable:     params.radiusVariable || null,     // Outer frame radius (e.g., "Radius/radius-xl")
    gridVariable:       params.gridVariable || null,       // Grid line color (e.g., "Colors/Border/border-secondary")
    labelFillVariable:  params.labelFillVariable || null,  // Label text color (e.g., "Colors/Text/text-tertiary (600)")
    labelTextStyleId:   params.labelTextStyleId || null,   // Label text style key
    fontFamily:         params.fontFamily || null,          // Font family override for chart labels
  };

  // Translate MCP 'categories' object to 'data' array for donut/pie charts.
  // MCP schema exposes categories: { "Label": { value, color } }
  // Plugin handler reads data: [{ label, value, color }]
  if ((t === 'donut' || t === 'pie') && params.categories && !params.data) {
    const order = params.categoryOrder || Object.keys(params.categories);
    params.data = order.map(function(k) {
      return {
        label: k,
        value: (params.categories[k] || {}).value || 0,
        color: (params.categories[k] || {}).color || '#888888',
        colorVariable: (params.categories[k] || {}).colorVariable || null,
      };
    });
  }

  var result;
  if (t === 'scatter' || t === 'jitter')    result = await handleScatterChart(params);
  else if (t === 'line'    || t === 'area') result = await handleLineChart(params);
  else if (t === 'donut'   || t === 'pie')  result = await handleDonutChart(params);
  else if (t === 'bar'     || t === 'histogram') result = await handleBarChart(params);
  else if (t === 'radar')                        result = await handleRadarChart(params);
  else throw new Error('Unknown chartType "' + t + '". Supported: scatter, jitter, line, area, donut, pie, bar, histogram, radar');

  // Clean up chart DS context
  chartDsContext = null;
  return result;
}

// ---------------------------------------------------------------------------
// Page navigation
// ---------------------------------------------------------------------------

function handleGetPages() {
  return figma.root.children.map(p => ({ id: p.id, name: p.name }));
}

async function handleChangePage(params) {
  // params.pageId OR params.pageName
  let page;
  if (params.pageId) {
    page = figma.root.children.find(p => p.id === params.pageId);
  } else if (params.pageName) {
    page = figma.root.children.find(p => p.name === params.pageName);
  }
  if (!page) throw new Error(`Page not found: ${JSON.stringify(params)}`);
  await figma.setCurrentPageAsync(page);
  return { ok: true, pageId: page.id, pageName: page.name };
}

// ---------------------------------------------------------------------------
// Prototype wiring
// ---------------------------------------------------------------------------

async function handleSetReactions(params) {
  // params.nodeId: the source node
  // params.reactions: array of reaction objects (Figma ReactionJSON format)
  const node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  node.reactions = params.reactions;
  return { ok: true, nodeId: node.id, name: node.name };
}

async function handleSetPrototypeStart(params) {
  // params.nodeId: the frame to set as prototype start node
  const node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) throw new Error(`Node ${params.nodeId} not found`);
  figma.currentPage.prototypeStartNode = node;
  return { ok: true, nodeId: node.id, name: node.name };
}

// Preload DS styles — imports a batch of style keys in parallel chunks and caches their IDs.
// Call ONCE at the start of a build to avoid import queue congestion during rendering.
// Processes in chunks of 10 to balance throughput with Figma API stability.
async function handlePreloadStyles(params) {
  const keys = params.keys || [];
  const results = {};
  let loaded = 0;
  let failed = 0;
  const CHUNK_SIZE = 10;

  for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
    const chunk = keys.slice(i, i + CHUNK_SIZE);
    const chunkResults = await Promise.allSettled(
      chunk.map(async function(key) {
        if (styleCache.has(key)) { return { key, status: 'cached' }; }
        try {
          const imported = await Promise.race([
            figma.importStyleByKeyAsync(key),
            new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout')); }, 30000); }),
          ]);
          if (imported && imported.id) {
            styleCache.set(key, imported.id);
            return { key, status: 'loaded' };
          }
          return { key, status: 'not_found' };
        } catch (e) {
          return { key, status: e.message || 'error' };
        }
      })
    );
    for (const r of chunkResults) {
      if (r.status === 'fulfilled') {
        results[r.value.key] = r.value.status;
        if (r.value.status === 'loaded' || r.value.status === 'cached') loaded++;
        else failed++;
      } else {
        failed++;
      }
    }
  }

  return { loaded, failed, total: keys.length, results };
}

// Preload DS variables — walks library collections once and imports all variables
// matching the given path prefixes. Call at build start alongside preload_styles
// to warm the variable cache and avoid per-path timeouts during build.
// params: { prefixes: ["Colors", "spacing", "radius"] }
async function handlePreloadVariables(params) {
  const prefixes = params.prefixes || [];
  const keys = params.keys || [];
  const matchAll = prefixes.length === 0 && keys.length === 0;
  let loaded = 0;
  let failed = 0;
  let collectionsWalked = 0;

  // Initialize variable cache if needed
  if (!variableCache) {
    const vars = await figma.variables.getLocalVariablesAsync();
    variableCache = new Map(vars.map(v => [v.name, v]));
  }

  // Key-based import: bypass collection enumeration entirely.
  // Use this for community library variables that teamLibrary API can't enumerate.
  // Keys come from the Figma REST API (search_design_system).
  var importedNames = [];
  for (const entry of keys) {
    // Each entry: { key: "variableKey", name: "variable/path/name" }
    var vKey = typeof entry === 'string' ? entry : entry.key;
    var vName = typeof entry === 'string' ? null : entry.name;
    if (!vKey) continue;
    // Skip if already cached by name (but not if cached as null — that means a previous lookup failed)
    if (vName && variableCache.has(vName) && variableCache.get(vName) !== null) { loaded++; continue; }
    try {
      var imported = await figma.variables.importVariableByKeyAsync(vKey);
      if (imported) {
        variableCache.set(imported.name, imported);
        importedNames.push({ requested: vName, actual: imported.name, id: imported.id });
        // Also cache by the provided name if different (handles path aliases)
        if (vName && vName !== imported.name) variableCache.set(vName, imported);
        loaded++;
      } else {
        failed++;
      }
    } catch (_) {
      failed++;
    }
  }

  // Prefix-based import: walk team library collections (existing behavior).
  // This finds team-published libraries but NOT community libraries.
  if (prefixes.length > 0 || (matchAll && keys.length === 0)) {
  try {
    const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    for (const col of collections) {
      collectionsWalked++;
      let libVars;
      try {
        libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(col.key);
      } catch (_) { continue; }

      for (const lv of libVars) {
        if (variableCache.has(lv.name)) continue;
        const matches = matchAll || prefixes.some(p => lv.name.startsWith(p));
        if (!matches) continue;

        try {
          const imp = await figma.variables.importVariableByKeyAsync(lv.key);
          variableCache.set(lv.name, imp);
          loaded++;
        } catch (_) {
          failed++;
        }
      }
    }
  } catch (e) {
    return { loaded, failed, total: loaded + failed, collectionsWalked, error: e.message };
  }
  }

  return { loaded, failed, total: loaded + failed, collectionsWalked, importedNames };
}

// ---------------------------------------------------------------------------

// Restyle an entire artboard tree: walk all descendants and apply color/font/radius overrides.
// params: { nodeId, colorMap, fontFamily?, radiusScale?, spacingScale? }
// colorMap: { "#oldHex": "#newHex", ... } — keys are lowercase 6-char hex WITHOUT #
// Walks all descendants: FRAME fills/strokes, TEXT fills, RECTANGLE fills.
// For component INSTANCE children, walks their internal text nodes too.
async function handleRestyleArtboard(params) {
  var root = figma.getNodeById(params.nodeId);
  if (!root) throw new Error('Root node not found: ' + params.nodeId);

  var colorMap = params.colorMap || {};
  var fontFamily = params.fontFamily || null;
  var radiusScale = params.radiusScale || null;
  var spacingScale = params.spacingScale || null;
  var detachInstances = params.detachInstances !== false; // default true
  // Force text colors by role: { primary: "hex", secondary: "hex", accent: "hex" }
  var textColors = params.textColors || null;
  // Threshold: text >= this size uses primary, below uses secondary
  var textSizeThreshold = params.textSizeThreshold || 20;

  // Normalize color map
  var normalizedMap = {};
  var mapKeys = Object.keys(colorMap);
  for (var mi = 0; mi < mapKeys.length; mi++) {
    var mk = mapKeys[mi];
    normalizedMap[mk.replace('#', '').toLowerCase()] = colorMap[mk].replace('#', '').toLowerCase();
  }

  var stats = { detached: 0, frames: 0, texts: 0, rects: 0, fonts: 0, radius: 0, strokes: 0 };

  function hexToRgb(hex) {
    return {
      r: parseInt(hex.substring(0, 2), 16) / 255,
      g: parseInt(hex.substring(2, 4), 16) / 255,
      b: parseInt(hex.substring(4, 6), 16) / 255
    };
  }

  function rgbToHex(r, g, b) {
    return (
      Math.round(r * 255).toString(16).padStart(2, '0') +
      Math.round(g * 255).toString(16).padStart(2, '0') +
      Math.round(b * 255).toString(16).padStart(2, '0')
    ).toLowerCase();
  }

  function remapColor(hex) {
    return normalizedMap[hex] || null;
  }

  function makeSolidPaint(hexColor, opacity) {
    var rgb = hexToRgb(hexColor);
    return { type: 'SOLID', color: rgb, opacity: opacity !== undefined ? opacity : 1 };
  }

  // Remap an array of paints using the color map
  function remapPaints(paints) {
    if (!paints || !Array.isArray(paints)) return null;
    var changed = false;
    var newPaints = [];
    for (var i = 0; i < paints.length; i++) {
      var p = paints[i];
      if (p.type !== 'SOLID' || !p.color) { newPaints.push(p); continue; }
      var hex = rgbToHex(p.color.r, p.color.g, p.color.b);
      var mapped = remapColor(hex);
      if (mapped) {
        newPaints.push(makeSolidPaint(mapped, p.opacity));
        changed = true;
      } else {
        newPaints.push(p);
      }
    }
    return changed ? newPaints : null;
  }

  // Determine the text color to force based on font size/weight
  function getForceTextColor(fontSize, fontWeight) {
    if (!textColors) return null;
    // Check if this looks like an accent-colored text (we'll handle via color map instead)
    if (textColors.accent && fontWeight >= 600 && fontSize >= 14 && fontSize < textSizeThreshold) {
      return null; // let color map handle accent text
    }
    if (fontSize >= textSizeThreshold || fontWeight >= 600) {
      return textColors.primary || null;
    }
    return textColors.secondary || null;
  }

  // Get font weight as number from style string
  function styleToWeight(style) {
    if (!style) return 400;
    var s = style.toLowerCase();
    if (s.indexOf('black') >= 0 || s.indexOf('heavy') >= 0) return 900;
    if (s.indexOf('extrabold') >= 0 || s.indexOf('extra bold') >= 0) return 800;
    if (s.indexOf('bold') >= 0) return 700;
    if (s.indexOf('semibold') >= 0 || s.indexOf('semi bold') >= 0) return 600;
    if (s.indexOf('medium') >= 0) return 500;
    if (s.indexOf('light') >= 0) return 300;
    if (s.indexOf('thin') >= 0) return 100;
    return 400;
  }

  async function processTextNode(node) {
    var len = node.characters.length;
    if (len === 0) return;

    // Load current font(s) so we can modify the node
    var allFonts = node.getRangeAllFontNames(0, len);
    for (var fi = 0; fi < allFonts.length; fi++) {
      try { await figma.loadFontAsync(allFonts[fi]); } catch(_) {}
    }

    // Change font family if specified
    if (fontFamily) {
      for (var fi2 = 0; fi2 < allFonts.length; fi2++) {
        var oldFont = allFonts[fi2];
        var newFont = { family: fontFamily, style: oldFont.style };
        try {
          await figma.loadFontAsync(newFont);
        } catch(_) {
          // Fallback: try Regular style
          newFont = { family: fontFamily, style: 'Regular' };
          try { await figma.loadFontAsync(newFont); } catch(__) { continue; }
        }
        // Apply to matching ranges
        for (var ci = 0; ci < len; ci++) {
          try {
            var cf = node.getRangeFontName(ci, ci + 1);
            if (cf.family === oldFont.family && cf.style === oldFont.style) {
              node.setRangeFontName(ci, ci + 1, newFont);
            }
          } catch(_) {}
        }
        stats.fonts++;
      }
    }

    // Force text color
    if (textColors) {
      // Get font info for classification
      var fontSize = 16;
      var fontWeight = 400;
      try {
        var fn = node.getRangeFontName(0, 1);
        fontSize = node.getRangeFontSize(0, 1);
        fontWeight = styleToWeight(fn.style);
      } catch(_) {}

      var forceHex = getForceTextColor(fontSize, fontWeight);
      if (forceHex) {
        try {
          node.fills = [makeSolidPaint(forceHex)];
          stats.texts++;
          return; // skip color map for this text
        } catch(_) {}
      }
    }

    // Try color map on text fills
    try {
      var currentFills = JSON.parse(JSON.stringify(node.fills));
      if (Array.isArray(currentFills)) {
        var remapped = remapPaints(currentFills);
        if (remapped) {
          node.fills = remapped;
          stats.texts++;
        }
      }
    } catch(_) {}
  }

  async function walkNode(node) {
    // Step 1: Detach instances to make content editable
    if (detachInstances && node.type === 'INSTANCE') {
      try {
        node = node.detachInstance();
        stats.detached++;
      } catch(_) {
        // If detach fails, still recurse into children
      }
    }

    // Step 2: Process frame/rect fills via color map
    if (node.type !== 'TEXT' && 'fills' in node) {
      try {
        var currentFills = JSON.parse(JSON.stringify(node.fills));
        if (Array.isArray(currentFills)) {
          var remapped = remapPaints(currentFills);
          if (remapped) {
            node.fills = remapped;
            if (node.type === 'FRAME' || node.type === 'GROUP') stats.frames++;
            else stats.rects++;
          }
        }
      } catch(_) {}
    }

    // Step 3: Process strokes via color map
    if ('strokes' in node) {
      try {
        var currentStrokes = JSON.parse(JSON.stringify(node.strokes));
        if (Array.isArray(currentStrokes)) {
          var remappedS = remapPaints(currentStrokes);
          if (remappedS) { node.strokes = remappedS; stats.strokes++; }
        }
      } catch(_) {}
    }

    // Step 4: Process text (font + color)
    if (node.type === 'TEXT') {
      await processTextNode(node);
    }

    // Step 5: Corner radius
    if (radiusScale && 'cornerRadius' in node && typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
      try { node.cornerRadius = Math.round(node.cornerRadius * radiusScale); stats.radius++; } catch(_) {}
    }

    // Step 6: Spacing
    if (spacingScale && (node.type === 'FRAME' || node.type === 'GROUP')) {
      try {
        if (node.paddingTop > 0) node.paddingTop = Math.round(node.paddingTop * spacingScale);
        if (node.paddingBottom > 0) node.paddingBottom = Math.round(node.paddingBottom * spacingScale);
        if (node.paddingLeft > 0) node.paddingLeft = Math.round(node.paddingLeft * spacingScale);
        if (node.paddingRight > 0) node.paddingRight = Math.round(node.paddingRight * spacingScale);
        if (node.itemSpacing > 0) node.itemSpacing = Math.round(node.itemSpacing * spacingScale);
      } catch(_) {}
    }

    // Recurse into children
    if ('children' in node) {
      for (var i = 0; i < node.children.length; i++) {
        await walkNode(node.children[i]);
      }
    }
  }

  await walkNode(root);

  return {
    stats: stats,
    totalColorMappings: Object.keys(normalizedMap).length,
  };
}

// Fix all text in an artboard: force dark text to light (or vice versa).
// Walks all descendants, checks each TEXT node's current fill luminance,
// and overrides if it's on the wrong side of the threshold.
// params: { nodeId, mode: "dark" | "light", primaryColor, secondaryColor, accentColor?, sizeThreshold? }
// "dark" mode: text with luminance < 0.4 gets forced to primaryColor/secondaryColor
// "light" mode: text with luminance > 0.6 gets forced to primaryColor/secondaryColor
// Nuclear text fix: walks ALL text, loads fonts, uses setRangeFills to override range-level fills.
// Handles figma.mixed fills from detached instances.
async function handleFixTextColors(params) {
  var root = figma.getNodeById(params.nodeId);
  if (!root) throw new Error('Root not found: ' + params.nodeId);

  var mode = params.mode || 'dark'; // "dark" = dark bg, fix dark text to light
  var primaryHex = (params.primaryColor || 'f1f5f9').replace('#', '').toLowerCase();
  var secondaryHex = (params.secondaryColor || '94a3b8').replace('#', '').toLowerCase();
  var accentHex = params.accentColor ? params.accentColor.replace('#', '').toLowerCase() : null;
  var sizeThreshold = params.sizeThreshold || 20;

  // Also fix specific text content
  var textReplacements = params.textReplacements || {}; // { "old text": "new text" }

  function hexToRgb(hex) {
    return {
      r: parseInt(hex.substring(0, 2), 16) / 255,
      g: parseInt(hex.substring(2, 4), 16) / 255,
      b: parseInt(hex.substring(4, 6), 16) / 255
    };
  }

  function luminance(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  function styleToWeight(style) {
    if (!style) return 400;
    var s = style.toLowerCase();
    if (s.indexOf('bold') >= 0 || s.indexOf('black') >= 0 || s.indexOf('heavy') >= 0) return 700;
    if (s.indexOf('semibold') >= 0 || s.indexOf('semi bold') >= 0) return 600;
    if (s.indexOf('medium') >= 0) return 500;
    return 400;
  }

  var fixed = 0;
  var replaced = 0;

  async function walkNode(node) {
    if (node.type === 'TEXT') {
      var len = node.characters.length;
      if (len === 0) { return; }

      // Check text content for replacements
      var repKeys = Object.keys(textReplacements);
      for (var ri = 0; ri < repKeys.length; ri++) {
        if (node.characters.indexOf(repKeys[ri]) >= 0) {
          // Load font before changing text
          var allFonts = node.getRangeAllFontNames(0, len);
          for (var fi = 0; fi < allFonts.length; fi++) {
            try { await figma.loadFontAsync(allFonts[fi]); } catch(_) {}
          }
          try {
            node.characters = node.characters.replace(repKeys[ri], textReplacements[repKeys[ri]]);
            len = node.characters.length;
            replaced++;
          } catch(_) {}
          break;
        }
      }

      // Check current fill luminance — handle both normal and mixed fills
      try {
        // Load ALL fonts in this text node (required before any modification)
        var allFonts3 = node.getRangeAllFontNames(0, len);
        for (var f3 = 0; f3 < allFonts3.length; f3++) {
          try { await figma.loadFontAsync(allFonts3[f3]); } catch(_) {}
        }

        // Get fill from first character (works even when node.fills is mixed)
        var needsFix = false;
        try {
          var rangeFills = node.getRangeFills(0, 1);
          if (rangeFills && Array.isArray(rangeFills) && rangeFills.length > 0 && rangeFills[0].color) {
            var lum = luminance(rangeFills[0].color.r, rangeFills[0].color.g, rangeFills[0].color.b);
            if (mode === 'dark' && lum < 0.5) needsFix = true;
            if (mode === 'light' && lum > 0.5) needsFix = true;
          } else {
            // Can't read fills — force fix on dark mode since it's safer
            if (mode === 'dark') needsFix = true;
          }
        } catch(_) {
          // getRangeFills failed — force fix on dark mode
          if (mode === 'dark') needsFix = true;
        }

        if (needsFix) {
          // Determine which color to use based on font size/weight
          var fontSize = 16;
          var fontWeight = 400;
          try {
            fontSize = node.getRangeFontSize(0, 1);
            if (typeof fontSize !== 'number') fontSize = 16;
            var fn = node.getRangeFontName(0, 1);
            fontWeight = styleToWeight(fn.style);
          } catch(_) {}

          var targetHex;
          if (accentHex && fontWeight >= 600 && fontSize >= 14 && fontSize < sizeThreshold) {
            targetHex = accentHex;
          } else if (fontSize >= sizeThreshold || fontWeight >= 600) {
            targetHex = primaryHex;
          } else {
            targetHex = secondaryHex;
          }

          // Use setRangeFills to override range-level fills (handles mixed fills from detached instances)
          var newPaint = [{ type: 'SOLID', color: hexToRgb(targetHex), opacity: 1 }];
          node.setRangeFills(0, len, newPaint);
          fixed++;
        }
      } catch(_) {}
    }

    if ('children' in node) {
      for (var i = 0; i < node.children.length; i++) {
        await walkNode(node.children[i]);
      }
    }
  }

  await walkNode(root);
  return { fixed: fixed, replaced: replaced };
}

// ---------------------------------------------------------------------------
// Post-build DS compliance validation
// ---------------------------------------------------------------------------

async function handleValidateDsCompliance(params) {
  var node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error('Node ' + params.nodeId + ' not found');

  var violations = [];
  var stats = { total: 0, compliant: 0, rawFill: 0, rawText: 0, rawSpacing: 0, fixedSize: 0 };

  function checkFills(n) {
    if (!('fills' in n) || !Array.isArray(n.fills) || n.fills.length === 0) return;
    var bv = n.boundVariables;
    var hasBoundFill = bv && bv.fills && bv.fills.length > 0;
    var hasStyleId = n.fillStyleId && n.fillStyleId !== '';
    if (!hasBoundFill && !hasStyleId) {
      // Check if the fill is actually a color (not an image/gradient)
      var hasSolidFill = false;
      for (var i = 0; i < n.fills.length; i++) {
        if (n.fills[i].type === 'SOLID' && n.fills[i].visible !== false) hasSolidFill = true;
      }
      if (hasSolidFill) {
        stats.rawFill++;
        violations.push({
          nodeId: n.id,
          name: n.name,
          type: n.type,
          issue: 'RAW_FILL',
          detail: 'Solid fill not bound to DS variable or style',
        });
      }
    }
  }

  function checkText(n) {
    if (n.type !== 'TEXT') return;
    var hasStyle = n.textStyleId && n.textStyleId !== '';
    if (!hasStyle) {
      stats.rawText++;
      violations.push({
        nodeId: n.id,
        name: n.name,
        type: 'TEXT',
        issue: 'RAW_TEXT_STYLE',
        detail: 'Text node has no DS text style (textStyleId is empty). Font: ' +
          (n.fontName ? n.fontName.family + ' ' + n.fontName.style : 'mixed') +
          ', size: ' + (typeof n.fontSize === 'number' ? n.fontSize : 'mixed'),
      });
    }
  }

  function checkSpacing(n) {
    if (n.type !== 'FRAME' && n.type !== 'COMPONENT' && n.type !== 'INSTANCE') return;
    if (!n.layoutMode || n.layoutMode === 'NONE') return;
    var bv = n.boundVariables || {};
    // Check if spacing properties are bound to DS variables
    var spacingProps = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemSpacing'];
    for (var i = 0; i < spacingProps.length; i++) {
      var prop = spacingProps[i];
      var value = n[prop];
      if (value > 0 && (!bv[prop] || !bv[prop].id)) {
        stats.rawSpacing++;
        violations.push({
          nodeId: n.id,
          name: n.name,
          type: n.type,
          issue: 'RAW_SPACING',
          detail: prop + ' = ' + value + 'px without DS variable binding',
        });
        break; // One violation per node is enough
      }
    }
  }

  function checkSizing(n) {
    if (n.type !== 'FRAME' && n.type !== 'COMPONENT' && n.type !== 'INSTANCE') return;
    // Skip the root node (artboard) — it's allowed to be fixed
    if (n.id === params.nodeId) return;
    if (!n.layoutMode || n.layoutMode === 'NONE') return;
    // Check for FIXED sizing on frames that should be HUG or FILL
    if (n.layoutSizingHorizontal === 'FIXED' && n.layoutSizingVertical === 'FIXED') {
      stats.fixedSize++;
      violations.push({
        nodeId: n.id,
        name: n.name,
        type: n.type,
        issue: 'FIXED_SIZE',
        detail: 'Frame has FIXED sizing on both axes. Expected HUG or FILL.',
      });
    }
  }

  function walkTree(n) {
    stats.total++;
    // Skip nodes tagged as user-approved raw exceptions
    if (n.name && n.name.startsWith('[RAW-OK]')) return;
    checkFills(n);
    checkText(n);
    checkSpacing(n);
    checkSizing(n);
    if ('children' in n) {
      for (var i = 0; i < n.children.length; i++) {
        walkTree(n.children[i]);
      }
    }
  }

  walkTree(node);
  stats.compliant = stats.total - stats.rawFill - stats.rawText - stats.rawSpacing - stats.fixedSize;

  return {
    stats: stats,
    violations: violations,
    compliant: violations.length === 0,
    summary: violations.length === 0
      ? 'All ' + stats.total + ' nodes are DS-compliant.'
      : stats.rawFill + ' raw fills, ' + stats.rawText + ' raw text styles, ' +
        stats.rawSpacing + ' raw spacing, ' + stats.fixedSize + ' fixed-size frames out of ' + stats.total + ' nodes.',
  };
}

// Tag a node as a user-approved raw exception. Prefixes the name with [RAW-OK]
// so validate_ds_compliance can distinguish intentional exceptions from violations.
// params: { nodeId, reason }
function handleTagRawException(params) {
  var node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error('Node ' + params.nodeId + ' not found');
  var reason = params.reason || 'user-approved';
  if (!node.name.startsWith('[RAW-OK]')) {
    node.name = '[RAW-OK] ' + node.name;
  }
  // Store reason in plugin data (persists with the file)
  try {
    node.setPluginData('rawExceptionReason', reason);
  } catch(_) {}
  return { ok: true, nodeId: node.id, name: node.name };
}

const HANDLERS = {
  preload_styles:     handlePreloadStyles,
  preload_variables:  handlePreloadVariables,
  insert_component:   handleInsertComponent,
  debug_variables:    handleDebugVariables,
  debug_components:   handleDebugComponents,
  create_frame:       handleCreateFrame,
  create_text:        handleCreateText,
  create_rectangle:   handleCreateRectangle,
  create_ellipse:     handleCreateEllipse,
  set_component_text: handleSetComponentText,
  set_layout_sizing:  handleSetLayoutSizing,
  get_selection:      handleGetSelection,
  select_node:        handleSelectNode,
  get_page_nodes:     handleGetPageNodes,
  get_node_parent:    handleGetNodeParent,
  list_text_styles:   handleListTextStyles,
  discover_library_styles: handleDiscoverLibraryStyles,
  discover_library_variables: handleDiscoverLibraryVariables,
  get_text_info:      handleGetTextInfo,
  get_fill_info:      handleGetFillInfo,
  resolve_variable_id:  handleResolveVariableId,
  get_instance_key:     handleGetInstanceKey,
  find_instances:       handleFindInstances,
  delete_node:        handleDeleteNode,
  resize_node:        handleResizeNode,
  create_chart:       handleCreateChart,
  get_node_props:     handleGetNodeProps,
  set_text:           handleSetText,
  get_node_children:    handleGetNodeChildren,
  set_instance_swap:    handleSetInstanceSwap,
  set_node_fill:        handleSetNodeFill,
  apply_effect_style:   handleApplyEffectStyle,
  set_visibility:       handleSetVisibility,
  replace_component:    handleReplaceComponent,
  move_node:            handleMoveNode,
  set_variant:          handleSetVariant,
  get_component_variants: handleGetComponentVariants,
  swap_main_component:    handleSwapMainComponent,
  swap_child_component:   handleSwapChildComponent,
  get_node_key:           handleGetNodeKey,
  set_reactions:          handleSetReactions,
  set_prototype_start:    handleSetPrototypeStart,
  get_pages:              handleGetPages,
  change_page:            handleChangePage,
  batch:                  handleBatch,
  set_session_defaults:   handleSetSessionDefaults,
  read_variable_values:   handleReadVariableValues,
  validate_ds_compliance: handleValidateDsCompliance,
  tag_raw_exception:      handleTagRawException,
  restyle_artboard:       handleRestyleArtboard,
  fix_text_colors:        handleFixTextColors,
};

figma.ui.onmessage = async msg => {
  // Internal bridge connection events — no response needed
  if (msg.type === '__bridge_connected') {
    figma.notify('Mimic AI connected ✓', { timeout: 2000 });
    return;
  }
  if (msg.type === '__bridge_disconnected') return;

  const { id, type, params = {} } = msg;
  if (!id) return; // not a bridge instruction

  try {
    const handler = HANDLERS[type];
    if (!handler) throw new Error(`Unknown instruction type: "${type}"`);

    const result = await handler(params);
    figma.ui.postMessage({ id, ok: true, result });

  } catch (err) {
    figma.ui.postMessage({ id, ok: false, error: err.message });
  }
};
