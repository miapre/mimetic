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
  frameFillStyleKey: null,  // NOT auto-applied — frames often have no fill intentionally
  strokeStyleKey: null,     // NOT auto-applied
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
            if (lv.name === path) {
              const imported = await figma.variables.importVariableByKeyAsync(lv.key);
              variableCache.set(path, imported);
              return imported;
            }
          }
        }
        return null;
      })(),
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
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
async function applySpacing(node, prop, value) {
  if (typeof value === 'string') {
    const variable = await getVariableByPath(value);
    if (variable) { node.setBoundVariable(prop, variable); return; }
    const n = parseFloat(value);
    if (!isNaN(n)) node[prop] = n;
  } else if (typeof value === 'number') {
    node[prop] = value;
  }
}

// Apply a fill (solid color) to a node using a variable or a hex fallback.
// Returns true if DS variable was bound, false otherwise.
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
      return true;
    }
  }
  if (hexFallback) {
    node.fills = [{ type: 'SOLID', color: hexToRgb(hexFallback) }];
    return false;
  }
  // Neither provided — leave fills as-is
  return false;
}

// Apply a stroke to a node using a variable or hex fallback.
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
  }
  if (hexFallback) {
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
      new Promise((_, reject) => setTimeout(() => reject(new Error('color style timeout')), 8000)),
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
function applyLayoutSizing(node, params) {
  if (params.layoutGrow !== undefined) node.layoutGrow = params.layoutGrow;
  if (params.layoutAlign)              node.layoutAlign = params.layoutAlign;
  if (params.primaryAxisSizingMode)    node.primaryAxisSizingMode = params.primaryAxisSizingMode;
  if (params.counterAxisSizingMode)    node.counterAxisSizingMode = params.counterAxisSizingMode;
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

// Pre-load Inter font weights used by the design system.
const FONT_STYLES = {
  400: 'Regular',
  500: 'Medium',
  600: 'Semi Bold',
  700: 'Bold',
};

async function loadFont(weight) {
  await figma.loadFontAsync({ family: 'Inter', style: FONT_STYLES[weight] || 'Regular' });
}

// ---------------------------------------------------------------------------
// Instruction handlers
// ---------------------------------------------------------------------------

async function handleInsertComponent(params) {
  let component = null;

  // Import timeout — prevents indefinite hangs when Figma API is unresponsive.
  // Normal imports complete in <2s. 15s is generous but bounded.
  const IMPORT_TIMEOUT_MS = 15000;

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
    try {
      // Try component import first (most common)
      component = await withTimeout(
        figma.importComponentByKeyAsync(params.componentKey),
        'importComponentByKeyAsync'
      );
    } catch (e1) {
      // Component import failed — try as component SET key
      try {
        const compSet = await withTimeout(
          figma.importComponentSetByKeyAsync(params.componentKey),
          'importComponentSetByKeyAsync'
        );
        if (compSet) component = compSet.defaultVariant || compSet.children[0];
      } catch (e2) {
        // Both failed — record the errors for diagnostics
        importError = `Component import: ${e1.message}. Set import: ${e2.message}`;
      }
    }

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

  // Layout sizing within parent (must be set AFTER appendChild)
  applyLayoutSizing(instance, params);

  if (params.x !== undefined) instance.x = params.x;
  if (params.y !== undefined) instance.y = params.y;
  if (params.width !== undefined && params.height !== undefined) {
    instance.resize(params.width, params.height);
  } else if (params.width !== undefined) {
    instance.resize(params.width, instance.height);
  }

  return { nodeId: instance.id, name: instance.name };
}

async function handleCreateFrame(params) {
  const frame = figma.createFrame();
  frame.name = params.name || 'Frame';

  // Size
  const w = params.width !== undefined ? params.width : 100;
  const h = params.height !== undefined ? params.height : 100;
  frame.resize(w, h);

  // Auto-layout — accept both "direction" and "layoutMode" as the mode param
  const layoutDir = params.direction || params.layoutMode;
  if (layoutDir && layoutDir !== 'NONE') {
    frame.layoutMode = layoutDir;
    if (params.gap !== undefined) await applySpacing(frame, 'itemSpacing', params.gap);
    else if (params.itemSpacing !== undefined) await applySpacing(frame, 'itemSpacing', params.itemSpacing);
    if (params.padding !== undefined) {
      await applySpacing(frame, 'paddingTop',    params.padding);
      await applySpacing(frame, 'paddingRight',  params.padding);
      await applySpacing(frame, 'paddingBottom', params.padding);
      await applySpacing(frame, 'paddingLeft',   params.padding);
    }
    if (params.paddingTop    !== undefined) await applySpacing(frame, 'paddingTop',    params.paddingTop);
    if (params.paddingRight  !== undefined) await applySpacing(frame, 'paddingRight',  params.paddingRight);
    if (params.paddingBottom !== undefined) await applySpacing(frame, 'paddingBottom', params.paddingBottom);
    if (params.paddingLeft   !== undefined) await applySpacing(frame, 'paddingLeft',   params.paddingLeft);
    if (params.primaryAxisSizingMode)  frame.primaryAxisSizingMode  = params.primaryAxisSizingMode;
    if (params.counterAxisSizingMode)  frame.counterAxisSizingMode  = params.counterAxisSizingMode;
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
    const bound = await applyFill(frame, params.fillVariable);
    frameDsCompliance.fill = bound ? 'ds_variable' : 'raw_fallback';
    if (!bound) frameDsCompliance.rawFillReason = 'variable_not_found:' + params.fillVariable;
  } else if (Array.isArray(params.fills)) {
    frame.fills = params.fills;
    frameDsCompliance.fill = 'raw_fallback';
  } else if (params.fillHex) {
    await applyFill(frame, null, params.fillHex);
    frameDsCompliance.fill = 'raw_fallback';
  } else {
    await applyFill(frame, params.fillVariable, params.fillHex);
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

  // Corner radius — supports variable path string (e.g. "radius-xl") or number
  if (params.cornerRadius !== undefined) await applySpacing(frame, 'cornerRadius', params.cornerRadius);

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
  applyLayoutSizing(frame, params);

  // Auto-fill: children of auto-layout parents should fill the parent's cross-axis by default.
  // In product UI, sections fill the container width. Skip only if explicit layoutAlign was set.
  if (parentRef && !params.layoutAlign) {
    try {
      // Modern Figma API: layoutSizingHorizontal/Vertical = 'FILL' makes child fill parent
      const parentNode = figma.getNodeById(parentRef);
      if (parentNode && parentNode.layoutMode === 'VERTICAL') {
        frame.layoutSizingHorizontal = 'FILL';
      } else if (parentNode && parentNode.layoutMode === 'HORIZONTAL') {
        frame.layoutSizingVertical = 'FILL';
      }
    } catch (_) {
      // Fallback for older API
      frame.layoutAlign = 'STRETCH';
    }
  }

  if (params.x !== undefined) frame.x = params.x;
  if (params.y !== undefined) frame.y = params.y;

  return { nodeId: frame.id, name: frame.name, dsCompliance: frameDsCompliance };
}

async function handleCreateText(params) {
  const weight = params.fontWeight !== undefined ? params.fontWeight : 400;
  await loadFont(weight);

  const text = figma.createText();
  // Must set fontName before characters (Figma requires a loaded font to set text)
  text.fontName = { family: 'Inter', style: FONT_STYLES[weight] || 'Regular' };
  text.characters = params.text !== undefined ? params.text : '';

  // DS compliance tracking
  const dsCompliance = { textStyle: 'unresolved', fill: 'unresolved' };

  // Typography: try DS text style. If it succeeds, it overrides raw font properties.
  // Apply AFTER characters are set. The style import sets fontName/fontSize/lineHeight
  // from the DS definition, replacing the raw values set above.
  let styleApplied = false;
  if (params.textStyleId) {
    styleApplied = await applyTextStyle(text, params.textStyleId);
    dsCompliance.textStyle = styleApplied ? 'ds_style' : 'style_failed';
    if (!styleApplied) dsCompliance.failedStyleId = params.textStyleId;
  }

  if (!styleApplied) {
    // Raw fallback — apply raw properties only when DS style is not available
    if (params.fontSize) text.fontSize = params.fontSize;
    if (params.lineHeight) text.lineHeight = { value: params.lineHeight, unit: 'PIXELS' };
    dsCompliance.textStyle = params.textStyleId ? 'style_failed' : 'raw_fallback';
    dsCompliance.rawFontSize = params.fontSize || null;
    dsCompliance.rawFontWeight = weight;
  }

  if (params.textAlignHorizontal) text.textAlignHorizontal = params.textAlignHorizontal;

  // Fill: DS style > DS variable > raw (flagged)
  if (params.fillStyleKey) {
    const applied = await applyColorStyle(text, 'fill', params.fillStyleKey);
    dsCompliance.fill = applied ? 'ds_style' : 'ds_style_unavailable';
    if (!applied && Array.isArray(params.fills)) text.fills = params.fills;
  } else if (params.fillVariable) {
    const bound = await applyFill(text, params.fillVariable);
    dsCompliance.fill = bound ? 'ds_variable' : 'raw_fallback';
    if (!bound) dsCompliance.rawFillReason = 'variable_not_found:' + params.fillVariable;
  } else if (Array.isArray(params.fills)) {
    text.fills = params.fills;
    dsCompliance.fill = 'raw_fallback';
  } else if (params.fillHex) {
    await applyFill(text, null, params.fillHex);
    dsCompliance.fill = 'raw_fallback';
  } else if (sessionDefaults.textFillStyleKey) {
    // No explicit fill — apply session default (text-primary from DS)
    var defaultApplied = await applyColorStyle(text, 'fill', sessionDefaults.textFillStyleKey);
    dsCompliance.fill = defaultApplied ? 'ds_session_default' : 'raw_fallback';
    if (!defaultApplied) dsCompliance.rawFillReason = 'session_default_failed';
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
  applyLayoutSizing(text, params);

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

  return { nodeId: text.id, dsCompliance: textDsCompliance };
}

async function handleCreateRectangle(params) {
  const rect = figma.createRectangle();
  rect.name = params.name || 'Rectangle';
  rect.resize(params.width, params.height);

  if (params.fillNone) {
    rect.fills = [];
  } else {
    await applyFill(rect, params.fillVariable, params.fillHex);
  }

  if (params.strokeVariable || params.strokeHex) {
    await applyStroke(rect, params.strokeVariable, params.strokeHex, params.strokeWidth);
  }

  if (params.cornerRadius !== undefined) rect.cornerRadius = params.cornerRadius;

  const rectParentRef = params.parentNodeId || params.parentId;
  if (rectParentRef) {
    const parent = figma.getNodeById(rectParentRef);
    if (!parent || !('appendChild' in parent)) throw new Error(`Parent ${rectParentRef} not found`);
    parent.appendChild(rect);
  } else {
    figma.currentPage.appendChild(rect);
  }

  // layoutAlign/layoutGrow must be set AFTER appendChild
  applyLayoutSizing(rect, params);

  if (params.x !== undefined) rect.x = params.x;
  if (params.y !== undefined) rect.y = params.y;

  return { nodeId: rect.id };
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
  applyLayoutSizing(node, params);
  // Newer Figma API: FILL / HUG / FIXED per axis (works on instances inside auto-layout)
  if (params.layoutSizingHorizontal !== undefined && 'layoutSizingHorizontal' in node) {
    node.layoutSizingHorizontal = params.layoutSizingHorizontal;
  }
  if (params.layoutSizingVertical !== undefined && 'layoutSizingVertical' in node) {
    node.layoutSizingVertical = params.layoutSizingVertical;
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
  return { ok: true, width: node.width, height: node.height };
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
// params: { textFillStyleKey?: string }
async function handleSetSessionDefaults(params) {
  if (params.textFillStyleKey) {
    // Preload the style so it's available in the cache
    try {
      var imported = await figma.importStyleByKeyAsync(params.textFillStyleKey);
      styleCache.set(params.textFillStyleKey, imported.id);
      sessionDefaults.textFillStyleKey = params.textFillStyleKey;
    } catch (e) {
      return { ok: false, error: 'Failed to import textFillStyleKey: ' + e.message };
    }
  }
  return { ok: true, sessionDefaults: sessionDefaults };
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
    if (useStroke && 'strokes' in node) await applyStroke(node, params.variablePath, params.hexFallback);
    else if (!useStroke && 'fills' in node) await applyFill(node, params.variablePath, params.hexFallback);
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
    if (!op.type) {
      results.push({ ok: false, error: 'Missing "type" in batch operation' });
      continue;
    }
    const handler = HANDLERS[op.type];
    if (!handler) {
      results.push({ ok: false, error: `Unknown instruction type: "${op.type}"` });
      continue;
    }
    try {
      const result = await handler(op.params || {});
      results.push({ ok: true, result });
    } catch (e) {
      results.push({ ok: false, error: e.message, type: op.type });
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

// Create the outer container frame for a chart (no auto-layout, optional clip)
function makeChartOuter(name, parentNodeId, w, h) {
  const f = figma.createFrame();
  f.name = name;
  f.resize(w, h);
  f.fills = [];
  f.clipsContent = false;
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
function gridLine(parent, x, y, w, h) {
  const r = figma.createRectangle();
  r.name = 'grid';
  r.resize(Math.max(1, w), Math.max(1, h));
  r.x = x; r.y = y;
  r.fills = [{ type: 'SOLID', color: { r: 0.906, g: 0.918, b: 0.933 } }];
  r.strokes = [];
  parent.appendChild(r);
}

// Append a text label at (x, y). align: 'left' | 'center' | 'right'
async function chartLabel(parent, text, x, y, fontSize, colorRGB, align) {
  const node = figma.createText();
  node.fontName = { family: 'Inter', style: 'Regular' };
  node.fontSize = fontSize || 11;
  node.characters = String(text);
  node.fills = [{ type: 'SOLID', color: colorRGB || { r: 0.427, g: 0.467, b: 0.549 } }];
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

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });

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
  const outer = makeChartOuter(chartName, params.parentNodeId, w, h);
  outer.fills = [{ type: 'SOLID', color: { r: 0.976, g: 0.980, b: 0.984 } }];
  outer.cornerRadius = 8;

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
    gridLine(plot, 0, i * bandH, plotW, 1);
  }
  // Vertical grid lines at x-ticks (relative to plot)
  for (const tick of xTicks) {
    gridLine(plot, xNorm(tick) * plotW, 0, 1, plotH);
  }

  // Data dots (relative to plot)
  for (let i = 0; i < data.length; i++) {
    const pt    = data[i];
    const color = hexToRgb(categories[pt.category] || '#888888');
    const jx    = doJitter ? det(i, 127.1) * 5 : 0;
    const jy    = doJitter ? det(i, 311.7) * bandH * 0.38 : 0;
    const cx    = Math.min(Math.max(xNorm(pt.x) * plotW + jx, 0), plotW);
    const cy    = yBandRel(pt.category) + jy;
    const dot   = figma.createEllipse();
    dot.resize(dotR, dotR);
    dot.x = cx - dotR / 2;
    dot.y = cy - dotR / 2;
    dot.fills   = [{ type: 'SOLID', color, opacity: 0.85 }];
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
                     { r: 0.063, g: 0.094, b: 0.157 }, 'center');
  }

  // Legend (top-right, right → left)
  let lx = w - PAD_R;
  for (let li = catOrder.length - 1; li >= 0; li--) {
    const cat   = catOrder[li];
    const color = hexToRgb(categories[cat] || '#888888');

    const ltxt = figma.createText();
    ltxt.fontName = { family: 'Inter', style: 'Regular' };
    ltxt.fontSize = 11;
    ltxt.characters = cat;
    ltxt.fills = [{ type: 'SOLID', color: { r: 0.063, g: 0.094, b: 0.157 } }];
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

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });

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

  const outer = makeChartOuter(chartName, params.parentNodeId, w, h);
  outer.fills = [{ type: 'SOLID', color: { r: 0.976, g: 0.980, b: 0.984 } }];
  outer.cornerRadius = 8;

  // Grid lines
  for (const tick of yTicks) gridLine(outer, plotX, yScale(tick), plotW, 1);
  for (const tick of xTicks) gridLine(outer, xScale(tick), plotY, 1, plotH);
  gridLine(outer, plotX, plotY + plotH, plotW, 1); // x-axis baseline
  gridLine(outer, plotX, plotY, 1, plotH);          // y-axis baseline

  // Axis tick labels
  for (const tick of yTicks) {
    await chartLabel(outer, String(tick) + yTickSfx, plotX - 4, yScale(tick) - 8, 11, null, 'right');
  }
  for (const tick of xTicks) {
    await chartLabel(outer, String(tick) + xTickSfx, xScale(tick), plotY + plotH + 8, 11, null, 'center');
  }

  if (xLabel) await chartLabel(outer, xLabel, plotX + plotW / 2, h - 18, 12, { r: 0.063, g: 0.094, b: 0.157 }, 'center');
  if (yLabel) await chartLabel(outer, yLabel, 4, plotY + plotH / 2, 12, { r: 0.063, g: 0.094, b: 0.157 }, 'left');

  // Series
  for (const s of series) {
    if (!s.data || s.data.length < 2) continue;
    const color = hexToRgb(s.color || '#6941C6');
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
    ltxt.fontName  = { family: 'Inter', style: 'Regular' };
    ltxt.fontSize  = 11;
    ltxt.characters = s.name || '';
    ltxt.fills = [{ type: 'SOLID', color: { r: 0.063, g: 0.094, b: 0.157 } }];
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
      new Promise((_, reject) => setTimeout(() => reject(new Error('style import timeout')), 8000)),
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
  // Color variables for text (use discovered library variable paths)
  const centerColorVar    = params.centerColorVariable    || null;
  const centerSubColorVar = params.centerSubColorVariable || null;
  // Text style IDs — optional, pass via params.centerTextStyleId / params.centerSubTextStyleId
  const centerStyleId    = params.centerTextStyleId    || null;
  const centerSubStyleId = params.centerSubTextStyleId || null;

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  if (centerLabel) await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });

  const LEGEND_W = noLegend ? 0 : 160;
  const PAD = noLegend ? 0 : 20;
  const totalW = noLegend ? size : size + PAD + LEGEND_W;
  const totalH = noLegend ? size : size + PAD * 2;

  const outer = makeChartOuter(chartName, params.parentNodeId, totalW, totalH);
  outer.fills = [];
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
    ct.fontName  = { family: 'Inter', style: 'Bold' };
    ct.fontSize  = 22;
    ct.characters = centerLabel;
    await applyTextStyle(ct, centerStyleId);
    await applyFill(ct, centerColorVar, '#101828');
    outer.appendChild(ct);
    ct.x = cx - ct.width / 2;
    ct.y = cy - ct.height / 2 - (centerSub ? 10 : 0);

    if (centerSub) {
      const cs = figma.createText();
      cs.fontName  = { family: 'Inter', style: 'Regular' };
      cs.fontSize  = 12;
      cs.characters = centerSub;
      await applyTextStyle(cs, centerSubStyleId);
      await applyFill(cs, centerSubColorVar, '#667085');
      outer.appendChild(cs);
      cs.x = cx - cs.width / 2;
      cs.y = cy + 6;
    }
  }

  // Legend
  if (!noLegend) {
  let ly = PAD;
  const lx = PAD + size + PAD;
  for (const seg of data) {
    const pct = Math.round((seg.value / total) * 100);

    const dot = figma.createEllipse();
    dot.resize(8, 8);
    await applyFill(dot, seg.colorVariable || null, seg.color || '#888888');
    dot.strokes = [];
    dot.x = lx; dot.y = ly + 1;
    outer.appendChild(dot);

    const lbl = figma.createText();
    lbl.fontName  = { family: 'Inter', style: 'Regular' };
    lbl.fontSize  = 12;
    lbl.characters = (seg.label || '') + '  ' + pct + '%';
    await applyTextStyle(lbl, params.legendTextStyleId || null);
    await applyFill(lbl, null, '#101828');
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
  const categories  = params.categories  || {};
  const yDomain     = params.yDomain     || [0, 100];
  const yTicks      = params.yTicks      || [];
  const yTickSfx    = params.yTickSuffix !== undefined ? params.yTickSuffix : '';
  const xLabel      = params.xLabel  || '';
  const yLabel      = params.yLabel  || '';
  const chartName   = params.name    || 'Bar Chart';
  const annotations = params.annotations || [];

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });

  const PAD_L    = 52;
  const PAD_T    = 8;
  const PAD_R    = 16;
  const PAD_B    = 36;
  const LEG_H    = 24;
  const BAR_GAP  = 3;

  const plotX = PAD_L;
  const plotY = PAD_T + LEG_H;
  const plotW = w - PAD_L - PAD_R;
  const plotH = h - PAD_T - LEG_H - PAD_B;

  const nBars     = bars.length;
  const barGroupW = nBars > 0 ? plotW / nBars : plotW;
  const barW      = Math.max(4, barGroupW - BAR_GAP);
  const yRange    = yDomain[1] - yDomain[0];

  const outer = makeChartOuter(chartName, params.parentNodeId, w, h);
  outer.fills = [{ type: 'SOLID', color: { r: 0.976, g: 0.980, b: 0.984 } }];
  outer.cornerRadius = 8;

  // Horizontal grid lines at y-ticks
  for (const tick of yTicks) {
    const yPos = plotY + plotH - (tick - yDomain[0]) / yRange * plotH;
    gridLine(outer, plotX, yPos, plotW, 1);
  }
  // Baseline
  gridLine(outer, plotX, plotY + plotH, plotW, 1);
  gridLine(outer, plotX, plotY, 1, plotH);

  // Y-axis tick labels
  for (const tick of yTicks) {
    const yPos = plotY + plotH - (tick - yDomain[0]) / yRange * plotH;
    await chartLabel(outer, String(tick) + yTickSfx, plotX - 4, yPos - 8, 11, null, 'right');
  }

  // Bars (stacked bottom-to-top)
  for (let i = 0; i < nBars; i++) {
    const bar = bars[i];
    const bx  = plotX + i * barGroupW + BAR_GAP / 2;
    let cumPx = 0;  // accumulated pixel height from baseline

    for (let si = 0; si < bar.segments.length; si++) {
      const seg   = bar.segments[si];
      const color = hexToRgb(categories[seg.category] || '#888888');
      const segPx = Math.max(0, seg.value / yRange * plotH);
      if (segPx < 0.5) continue;

      const rect = figma.createRectangle();
      rect.name  = seg.category;
      rect.resize(Math.max(1, barW), Math.max(1, segPx));
      rect.x = bx;
      rect.y = plotY + plotH - cumPx - segPx;
      rect.fills   = [{ type: 'SOLID', color }];
      rect.strokes = [];
      // Round top corners on the topmost segment only
      if (si === bar.segments.length - 1) {
        rect.topLeftRadius    = 2;
        rect.topRightRadius   = 2;
        rect.bottomLeftRadius = 0;
        rect.bottomRightRadius= 0;
      }
      outer.appendChild(rect);
      cumPx += segPx;
    }
  }

  // X-axis bucket labels (centered under each bar group)
  for (let i = 0; i < nBars; i++) {
    const bar     = bars[i];
    const centerX = plotX + i * barGroupW + barGroupW / 2;
    await chartLabel(outer, bar.label, centerX, plotY + plotH + 8, 10, null, 'center');
  }

  // Annotation lines (vertical, e.g. Median, P95)
  for (const ann of annotations) {
    if (ann.type !== 'vline') continue;
    const bi    = ann.barIndex !== undefined ? ann.barIndex : 0;
    const ax    = plotX + bi * barGroupW;
    const color = hexToRgb(ann.color || '#667085');
    const line  = figma.createRectangle();
    line.name   = 'annotation-' + (ann.label || 'line');
    line.resize(1, plotH);
    line.x = ax;
    line.y = plotY;
    line.fills   = [{ type: 'SOLID', color, opacity: 0.8 }];
    line.strokes = [];
    outer.appendChild(line);
    if (ann.label) {
      await chartLabel(outer, ann.label, ax + 3, plotY + 4, 10, color, 'left');
    }
  }

  // X-axis title
  if (xLabel) {
    await chartLabel(outer, xLabel, plotX + plotW / 2, h - 18, 12,
                     { r: 0.063, g: 0.094, b: 0.157 }, 'center');
  }

  // Y-axis label (top-left, horizontal — no rotation in Figma plugin API)
  if (yLabel) {
    await chartLabel(outer, yLabel, plotX, plotY - 4, 10, null, 'left');
  }

  // Legend (top-right, square swatch)
  const catEntries = Object.entries(categories);
  let lx = w - PAD_R;
  for (let li = catEntries.length - 1; li >= 0; li--) {
    const [cat, hex] = catEntries[li];
    const color = hexToRgb(hex);

    const ltxt = figma.createText();
    ltxt.fontName  = { family: 'Inter', style: 'Regular' };
    ltxt.fontSize  = 11;
    ltxt.characters = cat;
    ltxt.fills = [{ type: 'SOLID', color: { r: 0.063, g: 0.094, b: 0.157 } }];
    outer.appendChild(ltxt);
    lx -= ltxt.width;
    ltxt.x = lx;
    ltxt.y = 5;

    const sw = figma.createRectangle();
    sw.resize(10, 10);
    sw.cornerRadius = 2;
    sw.fills   = [{ type: 'SOLID', color }];
    sw.strokes = [];
    lx -= 14;
    sw.x = lx;
    sw.y = 6;
    outer.appendChild(sw);
    lx -= 16;
  }

  return { nodeId: outer.id, name: outer.name };
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

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });

  const LABEL_PAD = 32;
  const maxR = size / 2 - LABEL_PAD;
  const cx   = size / 2;
  const cy   = size / 2;

  const outer = makeChartOuter(chartName, params.parentNodeId, size, size);
  outer.fills = [];

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
  if (t === 'scatter' || t === 'jitter')  return handleScatterChart(params);
  if (t === 'line'    || t === 'area')    return handleLineChart(params);
  if (t === 'donut'   || t === 'pie')     return handleDonutChart(params);
  if (t === 'bar'     || t === 'histogram') return handleBarChart(params);
  if (t === 'radar')                        return handleRadarChart(params);
  throw new Error('Unknown chartType "' + t + '". Supported: scatter, jitter, line, area, donut, pie, bar, histogram, radar');
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

// Preload DS styles — imports a batch of style keys sequentially and caches their IDs.
// Call ONCE at the start of a build to avoid import queue congestion during rendering.
async function handlePreloadStyles(params) {
  const keys = params.keys || [];
  const results = {};
  let loaded = 0;
  let failed = 0;

  for (const key of keys) {
    if (styleCache.has(key)) { results[key] = 'cached'; loaded++; continue; }
    try {
      const imported = await Promise.race([
        figma.importStyleByKeyAsync(key),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
      ]);
      if (imported && imported.id) {
        styleCache.set(key, imported.id);
        results[key] = 'loaded';
        loaded++;
      } else {
        results[key] = 'not_found';
        failed++;
      }
    } catch (e) {
      results[key] = e.message || 'error';
      failed++;
    }
  }

  return { loaded, failed, total: keys.length, results };
}

// ---------------------------------------------------------------------------

const HANDLERS = {
  preload_styles:     handlePreloadStyles,
  insert_component:   handleInsertComponent,
  debug_variables:    handleDebugVariables,
  debug_components:   handleDebugComponents,
  create_frame:       handleCreateFrame,
  create_text:        handleCreateText,
  create_rectangle:   handleCreateRectangle,
  set_component_text: handleSetComponentText,
  set_layout_sizing:  handleSetLayoutSizing,
  get_selection:      handleGetSelection,
  select_node:        handleSelectNode,
  get_page_nodes:     handleGetPageNodes,
  get_node_parent:    handleGetNodeParent,
  list_text_styles:   handleListTextStyles,
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
