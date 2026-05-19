class MimicError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
  toJSON() {
    return { error: this.error, message: this.message, ...this.details() };
  }
  details() { return {}; }
}

class DsRequired extends MimicError {
  constructor(property, available, recovery) {
    super(`DS token required for ${property}`);
    this.error = 'DS_REQUIRED';
    this.property = property;
    this.available = available;
    this.recovery = recovery;
  }
  details() {
    return { property: this.property, available: this.available, recovery: this.recovery };
  }
}

class PhaseError extends MimicError {
  constructor(attemptedPhase, requiredPhase, hint) {
    super(`Phase ${attemptedPhase} blocked — ${hint}`);
    this.error = 'PHASE_REQUIRED';
    this.currentPhase = attemptedPhase;
    this.requiredPhase = requiredPhase;
  }
  details() {
    return { currentPhase: this.currentPhase, requiredPhase: this.requiredPhase };
  }
}

class PluginError extends MimicError {
  constructor(operation, reason) {
    super(`Plugin: ${operation} failed — ${reason}`);
    this.error = 'PLUGIN_ERROR';
    this.operation = operation;
  }
  details() { return { operation: this.operation }; }
}

class BridgeError extends MimicError {
  constructor(reason) {
    super(`Bridge: ${reason}`);
    this.error = 'BRIDGE_ERROR';
  }
}

/**
 * Classify whether an error is an infrastructure failure (plugin/bridge problem)
 * vs a user error (wrong params, phase violation, invalid variable path).
 *
 * Infra failures should NOT count toward the circuit breaker — they punish
 * the user for tool/plugin problems outside their control.
 *
 * Returns true for infra errors, false for user errors.
 */
function isInfraError(err) {
  // Bridge-level errors are always infra
  if (err instanceof BridgeError) return true;

  // Bridge timeout pattern from bridge.js _dispatch
  if (err.message && /Bridge timeout/i.test(err.message)) return true;

  // Bridge shutting down
  if (err.message && /Bridge shutting down/i.test(err.message)) return true;

  // Plugin disconnected
  if (err.message && /plugin disconnected/i.test(err.message)) return true;

  // Parent node not found — node disappeared (plugin state issue)
  if (err.message && /Parent node not found/i.test(err.message)) return true;

  // Node not found in Figma (stale reference after plugin glitch)
  if (err.message && /node.*not found/i.test(err.message)
      && !/variable.*not found/i.test(err.message)
      && !/style.*not found/i.test(err.message)) return true;

  // Plugin-level errors relayed from the Figma plugin
  if (err.pluginError && typeof err.pluginError === 'object') {
    const msg = err.pluginError.message || '';
    if (/Parent node not found/i.test(msg)) return true;
    if (/not found/i.test(msg) && !/variable/i.test(msg) && !/style/i.test(msg)) return true;
  }

  // INSERT_TIMEOUT — the plugin timed out, not a user mistake
  if (err.message && /INSERT_TIMEOUT/i.test(err.message)) return true;

  // Connection refused / socket errors
  if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EPIPE') return true;

  // Everything else is a user error (bad variable path, phase error, DS_REQUIRED, etc.)
  return false;
}

module.exports = { MimicError, DsRequired, PhaseError, PluginError, BridgeError, isInfraError };
