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

module.exports = { MimicError, DsRequired, PhaseError, PluginError, BridgeError };
