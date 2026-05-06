'use strict';

class DsDiscovery {
  /**
   * @param {import('../bridge')} bridge - WebSocket bridge to Figma plugin
   * @param {import('./cache').DsCache} dsCache - DS cache instance
   * @param {import('../knowledge/store').KnowledgeStore} knowledgeStore - Knowledge store instance
   */
  constructor(bridge, dsCache, knowledgeStore) {
    this.bridge = bridge;
    this.dsCache = dsCache;
    this.knowledgeStore = knowledgeStore;
  }

  /**
   * Enumerate all available library components and styles from the plugin.
   * Calls bridge to get plugin's view of the library.
   */
  async enumerateLibrary() {
    const status = await this.bridge.send('get_plugin_status');
    if (!status.connected) {
      throw new Error('Plugin not connected. Open Figma, go to Plugins → Development → Mimic AI → Run.');
    }

    // The actual library enumeration happens via the Figma MCP (read channel)
    // or via the plugin's local variable/style enumeration.
    // For now, return the plugin status — full enumeration will use
    // the official Figma MCP tools during the build.
    return {
      fileName: status.fileName,
      currentPage: status.currentPage || status.currentPageName,
      enforcementProfile: status.enforcementProfile,
    };
  }

  /**
   * Search for a DS component matching the given element type.
   * First checks the knowledge store (cached mappings), then
   * searches the dsCache if not found.
   *
   * @param {string} elementType - e.g., 'button', 'tab', 'badge', 'header'
   * @returns {{ found: boolean, componentKey?: string, variant?: object, source?: string } | { found: false, searchTerms: string[] }}
   */
  searchComponent(elementType) {
    // Check knowledge store first
    const knownComponents = this.knowledgeStore.data.components;
    for (const [id, recipe] of Object.entries(knownComponents)) {
      if (id.toLowerCase().includes(elementType.toLowerCase())) {
        return {
          found: true,
          componentKey: recipe.componentKey,
          variant: recipe.variant,
          recipe,
          source: 'knowledge_store',
          confidence: recipe.confidence || 'moderate',
        };
      }
    }

    // Generate search terms for the element type
    const searchTerms = this.getSearchTerms(elementType);

    // Search dsCache.components
    for (const [key, component] of this.dsCache.components) {
      const name = (component.name || '').toLowerCase();
      if (searchTerms.some(term => name.includes(term))) {
        return {
          found: true,
          componentKey: key,
          componentName: component.name,
          source: 'ds_cache',
          confidence: 'new',
        };
      }
    }

    return {
      found: false,
      searchTerms,
      message: `No DS component found for "${elementType}". Searched: ${searchTerms.join(', ')}`,
    };
  }

  /**
   * Generate search terms for an element type.
   * Returns multiple variations to handle different naming conventions.
   */
  getSearchTerms(elementType) {
    const base = elementType.toLowerCase().trim();
    const terms = [base];

    const aliases = {
      'button': ['btn', 'cta', 'action'],
      'input': ['text field', 'textfield', 'text input', 'form field'],
      'dropdown': ['select', 'menu', 'combobox', 'picker'],
      'tab': ['tabs', 'tab bar', 'tab group'],
      'badge': ['tag', 'chip', 'pill', 'label'],
      'card': ['tile', 'panel'],
      'table': ['data table', 'grid', 'list'],
      'pagination': ['pager', 'page nav'],
      'header': ['nav', 'navigation', 'top bar', 'app bar', 'navbar'],
      'footer': ['bottom bar'],
      'sidebar': ['side nav', 'sidenav', 'side navigation', 'drawer'],
      'avatar': ['profile', 'user icon'],
      'tooltip': ['popover', 'hint'],
      'modal': ['dialog', 'alert dialog', 'sheet'],
      'checkbox': ['check', 'checkmark'],
      'radio': ['radio button', 'option'],
      'toggle': ['switch'],
      'breadcrumb': ['breadcrumbs', 'path'],
      'divider': ['separator', 'line'],
      'progress': ['progress bar', 'loader', 'spinner'],
      'alert': ['banner', 'notification', 'toast', 'snackbar'],
    };

    if (aliases[base]) {
      terms.push(...aliases[base]);
    }

    return terms;
  }

  /**
   * Build a complete component map from an HTML section inventory.
   *
   * @param {string[]} elementTypes - e.g., ['header', 'button', 'tab', 'table', 'badge', 'footer']
   * @returns {Object} Map of elementType → search result
   */
  buildComponentMap(elementTypes) {
    const map = {};
    for (const type of elementTypes) {
      map[type] = this.searchComponent(type);
    }
    return map;
  }

  /**
   * Compare current DS fingerprint with stored one.
   * Returns change detection info.
   */
  detectChanges(currentFingerprint) {
    const stored = this.knowledgeStore.data.dsFingerprint;
    if (!stored) {
      return { changed: false, firstBuild: true };
    }
    if (stored !== currentFingerprint) {
      return { changed: true, previousFingerprint: stored, currentFingerprint };
    }
    return { changed: false };
  }
}

module.exports = { DsDiscovery };
