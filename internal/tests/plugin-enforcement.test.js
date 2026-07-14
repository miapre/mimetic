'use strict';

/**
 * Real-handler tests for plugin/code.js's DS-enforcement gates and the
 * binding tracker they lean on. These execute the ACTUAL handler code
 * (via internal/tests/helpers/figma-stub.js), not a reimplementation —
 * plugin/code.js now exports `handlers` and `_state` through a UMD-style
 * footer guarded behind `typeof module !== 'undefined'`, which never runs
 * inside the real Figma plugin sandbox.
 *
 * enforceText is the DS-enforcement gate itself: the component whose
 * failure produces non-compliant output (per the audit, this exact gate
 * shipped 3 bugs this sprint). The critical regression case is #4 below —
 * fontSizeVariable alone must be REJECTED once real text styles exist,
 * because fontSizeVariable only binds size, not family/weight/line-height.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFigmaStub, loadPlugin } = require('./helpers/figma-stub');

describe('plugin/code.js — enforceText gate (real handler: create_text)', () => {
  let plugin;

  beforeEach(() => {
    plugin = loadPlugin(createFigmaStub());
  });

  it('does not gate when enforceTextStyles is off (default)', async () => {
    const result = await plugin.handlers.create_text({ characters: 'Hello' });
    assert.equal(result.type, 'TEXT');
  });

  it('rejects when enforceTextStyles is on, no text styles cached, and neither textStyleId nor fontSizeVariable given', async () => {
    plugin._state.enforcementProfile.enforceTextStyles = true;
    await assert.rejects(
      plugin.handlers.create_text({ characters: 'Hello' }),
      (err) => {
        assert.equal(err.error, 'DS_REQUIRED');
        assert.equal(err.property, 'textStyle');
        assert.match(err.message, /Text style or typography variable required/);
        return true;
      }
    );
  });

  it('accepts fontSizeVariable alone when NO text styles are cached (documented fallback)', async () => {
    plugin._state.enforcementProfile.enforceTextStyles = true;
    // styleCache is empty — fontSizeVariable-only is the legitimate fallback.
    const result = await plugin.handlers.create_text({
      characters: 'Hello',
      fontSizeVariable: 'spacing/text-size/md',
    });
    assert.equal(result.type, 'TEXT');
  });

  it('REJECTS fontSizeVariable alone once real text styles exist — the core regression (fontSizeVariable only sets size, not family/weight/line-height)', async () => {
    plugin._state.enforcementProfile.enforceTextStyles = true;
    plugin._state.styleCache.set('style-key-1', { id: 'S:1', name: 'Body/Regular', type: 'TEXT' });

    await assert.rejects(
      plugin.handlers.create_text({ characters: 'Hello', fontSizeVariable: 'spacing/text-size/md' }),
      (err) => {
        assert.equal(err.error, 'DS_REQUIRED');
        assert.equal(err.property, 'textStyle');
        assert.match(err.message, /textStyleId is required when DS text styles are available/);
        assert.match(err.message, /fontSizeVariable alone only sets size/);
        assert.deepEqual(err.available, ['Body/Regular']);
        return true;
      }
    );
  });

  it('accepts textStyleId even when text styles are cached', async () => {
    plugin._state.enforcementProfile.enforceTextStyles = true;
    plugin._state.styleCache.set('style-key-1', { id: 'S:1', name: 'Body/Regular', type: 'TEXT' });

    const result = await plugin.handlers.create_text({
      characters: 'Hello',
      textStyleId: 'style-key-1',
    });
    assert.equal(result.type, 'TEXT');
    assert.equal(result.textStyleName, 'Body/Regular');
  });

  it('lists up to 20 available style names in the recovery hint, not more', async () => {
    plugin._state.enforcementProfile.enforceTextStyles = true;
    for (let i = 0; i < 25; i++) {
      plugin._state.styleCache.set('k' + i, { id: 'S:' + i, name: 'Style' + i, type: 'TEXT' });
    }
    await assert.rejects(
      plugin.handlers.create_text({ characters: 'Hello' }),
      (err) => {
        assert.equal(err.available.length, 20);
        return true;
      }
    );
  });
});

describe('plugin/code.js — enforceColorFill gate (real handler: create_text / create_rectangle / create_ellipse)', () => {
  let plugin;

  beforeEach(() => {
    plugin = loadPlugin(createFigmaStub());
  });

  it('does not gate when enforceColorVars is off (default)', async () => {
    const result = await plugin.handlers.create_rectangle({ fill: '#ff0000' });
    assert.equal(result.type, 'RECTANGLE');
  });

  it('does not gate when no fill was requested at all', async () => {
    plugin._state.enforcementProfile.enforceColorVars = true;
    const result = await plugin.handlers.create_rectangle({});
    assert.equal(result.type, 'RECTANGLE');
  });

  it('rejects a raw fill when enforceColorVars is on and no fillVariable is given', async () => {
    plugin._state.enforcementProfile.enforceColorVars = true;
    await assert.rejects(
      plugin.handlers.create_rectangle({ fill: '#ff0000' }),
      (err) => {
        assert.equal(err.error, 'DS_REQUIRED');
        assert.equal(err.property, 'fill');
        assert.match(err.message, /Node type: RECTANGLE/);
        return true;
      }
    );
  });

  it('accepts fillVariable when enforceColorVars is on', async () => {
    plugin._state.enforcementProfile.enforceColorVars = true;
    const result = await plugin.handlers.create_rectangle({ fill: '#ff0000', fillVariable: 'color/bg/primary' });
    assert.equal(result.type, 'RECTANGLE');
  });

  it('gates create_ellipse the same way as create_rectangle', async () => {
    plugin._state.enforcementProfile.enforceColorVars = true;
    await assert.rejects(
      plugin.handlers.create_ellipse({ fillHex: '#00ff00' }),
      (err) => {
        assert.match(err.message, /Node type: ELLIPSE/);
        return true;
      }
    );
  });
});

describe('plugin/code.js — createBindingTracker applied/warnings/bindingFailures symmetry (real handler: create_frame)', () => {
  let plugin;

  beforeEach(() => {
    plugin = loadPlugin(createFigmaStub({
      localVariableCollections: [
        {
          id: 'VC:1',
          name: 'Colors',
          modes: [{ modeId: 'M:1', name: 'Light' }],
          _variables: [{ id: 'V:1', name: 'color/bg/primary', variableCollectionId: 'VC:1' }],
        },
      ],
    }));
  });

  it('reports applied=true and no warnings when a variable binding succeeds', async () => {
    const result = await plugin.handlers.create_frame({
      name: 'Card',
      fillVariable: 'color/bg/primary',
    });
    assert.equal(result.applied.fillVariable, true);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.bindingFailures, false);
  });

  it('reports applied=false, a warning, and bindingFailures=true when a variable path is not found', async () => {
    const result = await plugin.handlers.create_frame({
      name: 'Card',
      fillVariable: 'color/bg/does-not-exist',
    });
    assert.equal(result.applied.fillVariable, false);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /fillVariable/);
    assert.equal(result.bindingFailures, true);
  });

  it('bindingFailures is true if ANY tracked binding failed, even when others succeeded', async () => {
    const result = await plugin.handlers.create_frame({
      name: 'Card',
      fillVariable: 'color/bg/primary',       // succeeds
      gapVariable: 'spacing/does-not-exist',  // fails
    });
    assert.equal(result.applied.fillVariable, true);
    assert.equal(result.applied.gapVariable, false);
    assert.equal(result.bindingFailures, true);
    assert.equal(result.warnings.length, 1);
  });

  it('applied is empty and bindingFailures is false when no DS bindings were requested', async () => {
    const result = await plugin.handlers.create_frame({ name: 'Card' });
    assert.deepEqual(result.applied, {});
    assert.deepEqual(result.warnings, []);
    assert.equal(result.bindingFailures, false);
  });
});
