const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DsRequired, PluginError, PhaseError, BridgeError, isInfraError } = require('../../../src/utils/errors');

describe('Error types', () => {
  it('DsRequired includes property, available list, and recovery hint', () => {
    const err = new DsRequired('textStyle', ['Display xl', 'Text sm'], 'Pass textStyleId');
    assert.equal(err.error, 'DS_REQUIRED');
    assert.equal(err.property, 'textStyle');
    assert.deepStrictEqual(err.available, ['Display xl', 'Text sm']);
    assert.equal(err.recovery, 'Pass textStyleId');
    assert.ok(err.message.includes('textStyle'));
  });

  it('PhaseError blocks wrong-phase tool calls', () => {
    const err = new PhaseError(3, 1, 'Call mimic_discover_ds first');
    assert.equal(err.requiredPhase, 1);
    assert.equal(err.currentPhase, 3);
    assert.ok(err.message.includes('mimic_discover_ds'));
  });
});

describe('isInfraError classification', () => {
  it('classifies BridgeError as infra', () => {
    assert.strictEqual(isInfraError(new BridgeError('connection lost')), true);
  });

  it('classifies bridge timeout as infra', () => {
    assert.strictEqual(isInfraError(new Error('Bridge timeout after 30000ms for createFrame (abc123)')), true);
  });

  it('classifies bridge shutting down as infra', () => {
    assert.strictEqual(isInfraError(new Error('Bridge shutting down')), true);
  });

  it('classifies plugin disconnected as infra', () => {
    assert.strictEqual(isInfraError(new Error('Figma plugin disconnected. Run the plugin again to reconnect.')), true);
  });

  it('classifies parent node not found as infra', () => {
    assert.strictEqual(isInfraError(new Error('Parent node not found: 123:456')), true);
  });

  it('classifies parent not found from pluginError as infra', () => {
    const err = new Error('Plugin error');
    err.pluginError = { message: 'Parent node not found: 123:456' };
    assert.strictEqual(isInfraError(err), true);
  });

  it('classifies INSERT_TIMEOUT as infra', () => {
    assert.strictEqual(isInfraError(new Error('INSERT_TIMEOUT: component may have been created')), true);
  });

  it('classifies ECONNREFUSED as infra', () => {
    const err = new Error('connect failed');
    err.code = 'ECONNREFUSED';
    assert.strictEqual(isInfraError(err), true);
  });

  it('classifies ECONNRESET as infra', () => {
    const err = new Error('connection reset');
    err.code = 'ECONNRESET';
    assert.strictEqual(isInfraError(err), true);
  });

  it('classifies PhaseError as user error', () => {
    assert.strictEqual(isInfraError(new PhaseError(0, 2, 'Call discover first')), false);
  });

  it('classifies DsRequired as user error', () => {
    assert.strictEqual(isInfraError(new DsRequired('textStyle', [], 'Pass textStyleId')), false);
  });

  it('classifies generic parameter error as user error', () => {
    assert.strictEqual(isInfraError(new Error('Invalid parameter: width must be positive')), false);
  });

  it('classifies variable not found as user error (not infra)', () => {
    assert.strictEqual(isInfraError(new Error('variable "colors/blue-500" not found in cache')), false);
  });

  it('classifies style not found as user error (not infra)', () => {
    assert.strictEqual(isInfraError(new Error('style "Display xl" not found or not importable')), false);
  });
});
