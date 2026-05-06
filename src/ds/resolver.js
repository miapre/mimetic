class DsResolver {
  constructor(cache) { this.cache = cache; }

  resolve(path) {
    const exact = this.cache.getVariable(path);
    if (exact) return exact;
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) {
      const suffix = segments.slice(i).join('/');
      const match = this.cache.getVariable(suffix);
      if (match) { this.cache.addVariable(path, match); return match; }
    }
    const lastSegment = segments[segments.length - 1];
    const match = this.cache.getVariable(lastSegment);
    if (match) { this.cache.addVariable(path, match); return match; }
    return null;
  }

  listByCategory(category) {
    const results = [];
    for (const [path, variable] of this.cache.variables) {
      if (variable.category === category) results.push({ path, ...variable });
    }
    return results;
  }

  findClosest(path, category) {
    const available = this.listByCategory(category);
    if (available.length === 0) return null;
    const needle = path.toLowerCase();
    return available.find(v => v.path.toLowerCase().includes(needle)) || available[0];
  }
}
module.exports = { DsResolver };
