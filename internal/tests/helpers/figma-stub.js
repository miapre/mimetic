'use strict';

/**
 * FigmaStub — a minimal, growable stand-in for the Figma plugin sandbox's
 * global `figma` object, for executing the REAL plugin/code.js handlers
 * in Node (via loadPlugin() below) instead of testing a reimplementation.
 *
 * plugin/code.js has no module system at runtime (Figma loads it as a
 * single sandboxed script). It now ends with a UMD-style footer:
 *   if (typeof module !== 'undefined' && module.exports) { module.exports = {...} }
 * guarded so that block never runs inside the real plugin sandbox. To
 * execute it in Node, set `global.figma` to a FigmaStub instance BEFORE
 * requiring plugin/code.js (loadPlugin() does this + clears the require
 * cache so every caller gets a fresh module — fresh styleCache,
 * variableCache, enforcementProfile, loadedFontKeys).
 *
 * Grow this stub as new handlers need coverage — it intentionally only
 * implements what's been exercised so far, not the full Plugin API.
 */

const path = require('node:path');

let _idCounter = 0;
function nextId() {
  _idCounter += 1;
  return '1:' + _idCounter;
}

class FigmaNodeStub {
  constructor(type, registry) {
    this.id = nextId();
    this.type = type;
    this.name = type;
    this.children = [];
    this.parent = null;

    this.x = 0;
    this.y = 0;
    this.width = 100;
    this.height = 100;
    this.visible = true;
    this.opacity = 1;

    this.fills = [];
    this.strokes = [];
    this.strokeWeight = 1;
    this.strokeAlign = 'INSIDE';

    this.layoutMode = 'NONE';
    this.layoutSizingHorizontal = undefined;
    this.layoutSizingVertical = undefined;
    this.layoutPositioning = undefined;
    this.layoutWrap = undefined;
    this.primaryAxisAlignItems = undefined;
    this.counterAxisAlignItems = undefined;
    this.itemSpacing = 0;
    this.paddingTop = 0;
    this.paddingRight = 0;
    this.paddingBottom = 0;
    this.paddingLeft = 0;
    this.clipsContent = undefined;

    this.cornerRadius = 0;
    this.topLeftRadius = 0;
    this.topRightRadius = 0;
    this.bottomLeftRadius = 0;
    this.bottomRightRadius = 0;

    this.minWidth = undefined;
    this.maxWidth = undefined;
    this.minHeight = undefined;
    this.maxHeight = undefined;

    this.boundVariables = {};
    this._explicitModes = {};

    // TEXT-specific
    this.characters = '';
    this.fontName = { family: 'Inter', style: 'Regular' };
    this.fontSize = 12;
    this.textStyleId = '';
    this.textAutoResize = undefined;
    this.textTruncation = undefined;
    this.maxLines = undefined;
    this.textAlignHorizontal = undefined;
    this.textAlignVertical = undefined;
    // Set by a test to simulate node.fontName === figma.mixed:
    // array of { start, end, fontName }
    this._rangeFonts = null;

    // INSTANCE-specific
    this.componentProperties = undefined;
    this.mainComponent = undefined;
    this._propFailKeys = new Set();

    // ELLIPSE-specific
    this.arcData = undefined;

    this._registry = registry;
    if (registry) registry.set(this.id, this);
  }

  resize(w, h) {
    this.width = w;
    this.height = h;
  }

  appendChild(child) {
    if (child.parent) {
      const idx = child.parent.children.indexOf(child);
      if (idx !== -1) child.parent.children.splice(idx, 1);
    }
    child.parent = this;
    this.children.push(child);
  }

  insertChild(index, child) {
    if (child.parent) {
      const idx = child.parent.children.indexOf(child);
      if (idx !== -1) child.parent.children.splice(idx, 1);
    }
    child.parent = this;
    this.children.splice(index, 0, child);
  }

  remove() {
    if (this.parent) {
      const idx = this.parent.children.indexOf(this);
      if (idx !== -1) this.parent.children.splice(idx, 1);
      this.parent = null;
    }
    if (this._registry) this._registry.delete(this.id);
  }

  findAll(fn) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (fn(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  setBoundVariable(prop, variable) {
    if (!variable) throw new Error('Cannot bind undefined variable to ' + prop);
    this.boundVariables[prop] = { type: 'VARIABLE_ALIAS', id: variable.id };
  }

  setExplicitVariableModeForCollection(collection, modeId) {
    this._explicitModes[collection.id] = modeId;
  }

  setProperties(update) {
    for (const key of Object.keys(update)) {
      if (this._propFailKeys.has(key)) {
        throw new Error('setProperties failed for ' + key);
      }
      if (!this.componentProperties) this.componentProperties = {};
      if (!this.componentProperties[key]) {
        this.componentProperties[key] = { type: 'BOOLEAN', value: update[key] };
      } else {
        this.componentProperties[key].value = update[key];
      }
    }
  }

  getRangeFontName(start, end) {
    if (this._rangeFonts) {
      for (const r of this._rangeFonts) {
        if (start >= r.start && start < r.end) return r.fontName;
      }
    }
    return this.fontName;
  }

  swapComponent(comp) {
    this.mainComponent = comp;
  }
}

/**
 * A stand-in for an imported Component/ComponentSet-child returned by
 * figma.importComponentByKeyAsync / importComponentSetByKeyAsync.
 *
 * @param {object} spec
 * @param {string} [spec.name]
 * @param {string} [spec.key]
 * @param {object} [spec.componentProperties] - cloned onto every instance
 * @param {object} [spec.parent] - e.g. { type: 'COMPONENT_SET', variantGroupProperties: {...} }
 * @param {object} [spec.variantProperties] - current variant values
 * @param {Array}  [spec.textChildren] - [{ name, characters, fontName }] flat text nodes
 * @param {Array}  [spec.iconChildren] - [{ name }] flat INSTANCE nodes (icon slots)
 */
function makeComponentStub(registry, spec) {
  spec = spec || {};
  return {
    id: nextId(),
    type: 'COMPONENT',
    name: spec.name || 'Component',
    key: spec.key || ('key-' + (spec.name || 'component')),
    parent: spec.parent || null,
    variantProperties: spec.variantProperties || null,
    createInstance() {
      const inst = new FigmaNodeStub('INSTANCE', registry);
      inst.name = this.name;
      inst.mainComponent = this;
      if (spec.componentProperties) {
        inst.componentProperties = JSON.parse(JSON.stringify(spec.componentProperties));
      }
      for (const tc of spec.textChildren || []) {
        const t = new FigmaNodeStub('TEXT', registry);
        t.name = tc.name;
        t.characters = tc.characters || '';
        if (tc.fontName) t.fontName = tc.fontName;
        inst.appendChild(t);
      }
      for (const ic of spec.iconChildren || []) {
        const i = new FigmaNodeStub('INSTANCE', registry);
        i.name = ic.name;
        i.visible = ic.visible !== false;
        inst.appendChild(i);
      }
      return inst;
    },
  };
}

/**
 * Resolves a configured "importable" entry. `entry` may be:
 *   - undefined              -> rejects (NOT_FOUND)
 *   - a plain value/object   -> resolves immediately with that value
 *   - a function(key)        -> called, return value/promise used as-is
 *   - { value, delayMs, error } descriptor -> resolves/rejects after delayMs
 *     (delayMs uses the real/mocked setTimeout, so node:test mock timers
 *     control it deterministically in tests)
 */
function resolveImportable(map, key) {
  const entry = map ? map[key] : undefined;
  if (entry === undefined) {
    return Promise.reject(new Error('NOT_FOUND: ' + key));
  }
  if (typeof entry === 'function') {
    return Promise.resolve(entry(key));
  }
  if (entry && typeof entry === 'object' && ('delayMs' in entry || 'error' in entry || 'value' in entry)) {
    return new Promise((resolve, reject) => {
      const fire = () => {
        if (entry.error) reject(entry.error === true ? new Error('import failed: ' + key) : entry.error);
        else resolve(entry.value);
      };
      if (entry.delayMs) setTimeout(fire, entry.delayMs);
      else fire();
    });
  }
  return Promise.resolve(entry);
}

/**
 * Builds a fresh figma stub object.
 *
 * @param {object} [opts]
 * @param {Array} [opts.localVariableCollections] - [{ id, name, key, modes: [{modeId,name}], _variables: [Variable] }]
 * @param {Array} [opts.libraryVariableCollections] - same shape, returned via teamLibrary APIs
 * @param {object} [opts.components] - key -> importable entry, used by importComponentByKeyAsync
 * @param {object} [opts.componentSets] - key -> importable entry (object with .children[]), used by importComponentSetByKeyAsync
 * @param {object} [opts.importableVariables] - key -> Variable object, used by importVariableByKeyAsync
 * @param {object} [opts.importableStyles] - key -> style object, used by importStyleByKeyAsync
 * @param {Array} [opts.loadFontFailures] - ['Family::Style', ...] fonts that reject in loadFontAsync
 * @param {Map} [opts.registry] - reuse an existing node registry (e.g. one
 *   already passed to makeComponentStub() for component template nodes),
 *   so imported components' createInstance() registers into the SAME
 *   registry this stub's getNodeById()/currentPage use.
 */
function createFigmaStub(opts) {
  opts = opts || {};
  const registry = opts.registry || new Map();
  const page = new FigmaNodeStub('PAGE', registry);
  page.name = 'Page 1';

  const localCollections = opts.localVariableCollections || [];
  const libraryCollections = opts.libraryVariableCollections || [];
  // getVariableByPath (plugin/code.js) reads collection.variableIds and
  // resolves each via figma.variables.getVariableById — auto-derive
  // variableIds from the test-friendly `_variables` list so callers don't
  // have to keep both in sync by hand.
  for (const col of [...localCollections, ...libraryCollections]) {
    if (!col.variableIds) {
      col.variableIds = (col._variables || []).map((v) => v.id);
    }
  }
  const componentMap = opts.components || {};
  const componentSetMap = opts.componentSets || {};
  const importableVariables = opts.importableVariables || {};
  const importableStyles = opts.importableStyles || {};
  const loadFontFailures = new Set(opts.loadFontFailures || []);

  const loadFontCalls = [];
  const uiMessages = [];

  const figmaStub = {
    mixed: Symbol('figma.mixed'),
    currentPage: page,

    createFrame() {
      const n = new FigmaNodeStub('FRAME', registry);
      return n;
    },
    createText() {
      return new FigmaNodeStub('TEXT', registry);
    },
    createRectangle() {
      return new FigmaNodeStub('RECTANGLE', registry);
    },
    createEllipse() {
      return new FigmaNodeStub('ELLIPSE', registry);
    },

    getNodeById(id) {
      return registry.get(id) || null;
    },

    variables: {
      getLocalVariableCollections() {
        return localCollections;
      },
      getVariableById(id) {
        for (const col of [...localCollections, ...libraryCollections]) {
          for (const v of col._variables || []) {
            if (v.id === id) return v;
          }
        }
        return null;
      },
      async getVariableCollectionByIdAsync(id) {
        return [...localCollections, ...libraryCollections].find((c) => c.id === id) || null;
      },
      async importVariableByKeyAsync(key) {
        const entry = importableVariables[key];
        if (!entry) throw new Error('variable not found: ' + key);
        return entry;
      },
      setBoundVariableForPaint(paint, field, variable) {
        return Object.assign({}, paint, {
          boundVariables: { [field]: { type: 'VARIABLE_ALIAS', id: variable.id } },
        });
      },
    },

    teamLibrary: {
      async getAvailableLibraryVariableCollectionsAsync() {
        return libraryCollections;
      },
      async getVariablesInLibraryCollectionAsync(key) {
        const col = libraryCollections.find((c) => c.key === key);
        return (col && col._variables) || [];
      },
    },

    importComponentByKeyAsync(key) {
      return resolveImportable(componentMap, key);
    },
    importComponentSetByKeyAsync(key) {
      return resolveImportable(componentSetMap, key);
    },
    async importStyleByKeyAsync(key) {
      const s = importableStyles[key];
      if (!s) throw new Error('style not found: ' + key);
      return s;
    },
    getStyleById(id) {
      for (const s of Object.values(importableStyles)) {
        if (s.id === id) return s;
      }
      return null;
    },
    getLocalTextStyles() {
      return opts.localTextStyles || [];
    },
    getLocalPaintStyles() {
      return opts.localPaintStyles || [];
    },

    async loadFontAsync(fontName) {
      loadFontCalls.push(fontName);
      const key = (fontName && fontName.family || '') + '::' + (fontName && fontName.style || '');
      if (loadFontFailures.has(key)) {
        throw new Error('font not available: ' + key);
      }
      return undefined;
    },

    showUI() {},
    ui: {
      onmessage: undefined,
      postMessage(msg) {
        uiMessages.push(msg);
      },
    },
  };

  // Test-only inspection hooks (not part of the real Plugin API surface).
  figmaStub._registry = registry;
  figmaStub._page = page;
  figmaStub._loadFontCalls = loadFontCalls;
  figmaStub._uiMessages = uiMessages;

  return figmaStub;
}

/**
 * Requires plugin/code.js fresh against the given figma stub: clears the
 * require cache first so every call gets its own styleCache/variableCache/
 * enforcementProfile/loadedFontKeys (no cross-test state bleed), sets
 * global.figma (+ global.__html__, referenced by the guarded bootstrap
 * block) before requiring, and returns the module's exports.
 *
 * @param {object} figmaStub - from createFigmaStub()
 * @returns {{handlers: object, [k: string]: any}}
 */
function loadPlugin(figmaStub) {
  const pluginPath = path.join(__dirname, '..', '..', '..', 'plugin', 'code.js');
  const resolved = require.resolve(pluginPath);
  delete require.cache[resolved];

  global.figma = figmaStub;
  global.__html__ = '';

  return require(pluginPath);
}

module.exports = {
  FigmaNodeStub,
  makeComponentStub,
  createFigmaStub,
  loadPlugin,
};
