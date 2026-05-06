class DsCache {
  constructor() {
    this.textStyles = new Map();
    this.variables = new Map();
    this.components = new Map();
    this.failedKeys = new Set();
  }

  addTextStyle(key, style) { this.textStyles.set(key, style); }
  getTextStyle(key) { return this.textStyles.get(key) || null; }
  addVariable(path, variable) { this.variables.set(path, variable); }
  getVariable(path) { return this.variables.get(path) || null; }
  addComponent(key, component) { this.components.set(key, component); }
  getComponent(key) { return this.components.get(key) || null; }
  markFailed(key) { this.failedKeys.add(key); }
  hasFailed(key) { return this.failedKeys.has(key); }

  getEnforcementProfile() {
    const hasTextStyles = this.textStyles.size > 0;
    const hasTypographyVars = [...this.variables.values()].some(v =>
      v.collection && v.collection.toLowerCase().includes('font'));
    const colorVars = [...this.variables.values()].filter(v =>
      v.category === 'text' || v.category === 'background' || v.category === 'border' || v.category === 'foreground');
    const spacingVars = [...this.variables.values()].filter(v => v.category === 'spacing');
    const radiusVars = [...this.variables.values()].filter(v => v.category === 'radius');

    return {
      enforceTextStyles: hasTextStyles || hasTypographyVars,
      enforceColorVars: colorVars.length > 0,
      enforceSpacingVars: spacingVars.length > 0,
      enforceRadiusVars: radiusVars.length > 0,
      counts: { textStyles: this.textStyles.size, colorVars: colorVars.length, spacingVars: spacingVars.length, radiusVars: radiusVars.length }
    };
  }

  clear() {
    this.textStyles.clear();
    this.variables.clear();
    this.components.clear();
    this.failedKeys.clear();
  }
}
module.exports = { DsCache };
