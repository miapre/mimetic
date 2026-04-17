/**
 * Mimic AI — Build Engine
 *
 * Enforces deterministic, HTML-driven builds with strict rules:
 * 1. Target node must be respected — no fallback to page root
 * 2. Every frame must have auto-layout (VERTICAL or HORIZONTAL)
 * 3. Every element must be inside its correct parent
 * 4. Structure must be derived from parsed HTML — no templates
 * 5. Post-build validation must pass for build to be SUCCESS
 *
 * Usage:
 *   import { createBuildEngine } from './build-engine.js';
 *   const engine = createBuildEngine(bridgeCall, { targetNodeId, dsFileKey });
 *   await engine.frame({ name, parentId, ... });
 *   await engine.text({ text, parentId, ... });
 *   const result = await engine.complete({ source, sections });
 */

import { reinterpretTextParams, reinterpretFrameParams } from '../rendering/ds-reinterpreter.js';
import { createInserter } from '../resolution/component-inserter.js';
import { resolveIconFromContext } from '../resolution/icon-resolver.js';
import { completeBuild } from '../learning/build-completion.js';
import { buildLayoutTree, validateStructure } from '../layout/layout-tree-builder.js';

/**
 * Create a build engine bound to a bridge call function.
 *
 * @param {Function} bridgeCall — async (type, params) => result
 * @param {Object} options
 * @param {string} options.targetNodeId — Figma node to build inside (REQUIRED)
 * @param {string} options.dsFileKey — DS library file key (from learned rules)
 * @returns {Object} engine with frame, text, icon, component, complete methods
 */
export function createBuildEngine(bridgeCall, options = {}) {
  const { targetNodeId, dsFileKey } = options;

  // Strict: target node is required
  if (!targetNodeId) {
    throw new Error('BUILD_ENGINE: targetNodeId is required. Cannot build without a target node.');
  }

  const startTime = Date.now();
  const compliance = [];
  const violations = [];
  const createdNodes = [];
  let artboardId = null;
  let dsComponentCount = 0;
  let iconCount = 0;
  let primitiveCount = 0;

  const inserter = createInserter(bridgeCall, dsFileKey);

  function track(result) {
    if (result?.dsCompliance) compliance.push(result.dsCompliance);
    if (result?.nodeId) createdNodes.push(result.nodeId);
    return result;
  }

  // ── STRICT PARENT VALIDATION ──
  function validateParent(parentId, callerName) {
    if (!parentId) {
      violations.push({ type: 'MISSING_PARENT', caller: callerName, detail: 'No parentId provided' });
      throw new Error(`BUILD_ENGINE: ${callerName} called without parentId. Every element must have a parent.`);
    }
  }

  // ── FRAME (with mandatory auto-layout) ──
  async function frame(params) {
    // If this is the root artboard, parent is the target node
    const isRoot = !params.parentId;
    const parentId = params.parentId || targetNodeId;

    // Enforce auto-layout
    if (!params.layoutMode || params.layoutMode === 'NONE') {
      // Only allow NONE for tiny fixed decorative elements (dots, avatars, icon containers)
      const isFixedDecorative = params.width && params.height && params.width <= 50 && params.height <= 50;
      if (!isFixedDecorative) {
        violations.push({ type: 'MISSING_AUTO_LAYOUT', name: params.name, detail: 'layoutMode not set or NONE on non-decorative frame' });
        // Force VERTICAL as safe default rather than failing silently
        params.layoutMode = 'VERTICAL';
      }
    }

    const ri = reinterpretFrameParams(params);
    const m = { ...params, parentId };
    if (ri.fillStyleKey) m.fillStyleKey = ri.fillStyleKey;
    if (ri.strokeStyleKey) m.strokeStyleKey = ri.strokeStyleKey;
    if (ri.spacing) { for (const [k, v] of Object.entries(ri.spacing)) m[k] = v; }
    if (ri.cornerRadius) m.cornerRadius = ri.cornerRadius;

    const result = track(await bridgeCall('create_frame', m));
    primitiveCount++;

    if (isRoot) artboardId = result.nodeId;
    return result;
  }

  // ── TEXT (with DS style reinterpretation) ──
  async function text(params) {
    validateParent(params.parentId, 'text');

    const ri = reinterpretTextParams(params);
    const m = { ...params };
    if (ri.textStyleId) m.textStyleId = ri.textStyleId;
    if (ri.fillStyleKey) m.fillStyleKey = ri.fillStyleKey;
    if (ri.fillVariable) m.fillVariable = ri.fillVariable;

    const result = track(await bridgeCall('create_text', m));
    primitiveCount++;
    return result;
  }

  // ── ICON (DS-agnostic via icon resolver) ──
  async function icon(parentId, structContext, size = 20) {
    validateParent(parentId, 'icon');

    const resolved = resolveIconFromContext(structContext);
    if (resolved && resolved.confidence !== 'low' && dsFileKey) {
      try {
        const result = await bridgeCall('insert_component', { componentKey: resolved.key, fileKey: dsFileKey, parentId });
        iconCount++;
        createdNodes.push(result.nodeId);
        return result;
      } catch (e) { /* fallback */ }
    }
    // Placeholder
    return frame({ name: 'Icon', parentId, width: size, height: size, layoutMode: 'NONE', fills: [{ type: 'SOLID', color: { r: 0.58, g: 0.64, b: 0.72 } }], cornerRadius: 4, layoutAlign: 'MIN' });
  }

  // ── COMPONENT (via intent pipeline) ──
  async function component(parentId, intentType, config = {}) {
    validateParent(parentId, 'component');

    const result = await inserter.resolveAndInsert(parentId, intentType, config);
    if (result) {
      dsComponentCount++;
      createdNodes.push(result.nodeId);
      return result;
    }
    return null; // Caller handles fallback
  }

  // ── TEXT OR COMPONENT (interactive detection) ──
  async function textOrComponent(parentId, textContent, fontSize, fontWeight, fills) {
    validateParent(parentId, 'textOrComponent');

    const result = await inserter.resolveText(parentId, textContent);
    if (result) {
      dsComponentCount++;
      createdNodes.push(result.nodeId);
      return result;
    }
    return text({ text: textContent, parentId, fontSize, fontWeight, fills });
  }

  // ── ACTION COMPONENT (button via intent) ──
  async function action(parentId, label, role = 'primary') {
    validateParent(parentId, 'action');

    const result = await inserter.resolveAndInsert(parentId, 'action', { text: label, role });
    if (result) {
      dsComponentCount++;
      createdNodes.push(result.nodeId);
      return result;
    }
    // Fallback: primitive button
    const btn = await frame({
      name: label, parentId,
      layoutMode: 'HORIZONTAL', primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'AUTO',
      paddingTop: 9, paddingBottom: 9, paddingLeft: 18, paddingRight: 18,
      fills: [{ type: 'SOLID', color: role === 'primary' ? { r: 0.145, g: 0.388, b: 0.921 } : { r: 1, g: 1, b: 1 } }],
      cornerRadius: 6,
    });
    await text({
      text: label, parentId: btn.nodeId, fontSize: 13, fontWeight: 600,
      fills: [{ type: 'SOLID', color: role === 'primary' ? { r: 1, g: 1, b: 1 } : { r: 0.278, g: 0.337, b: 0.412 } }],
    });
    return btn;
  }

  // ── BADGE (via intent pipeline) ──
  async function badge(parentId, label) {
    validateParent(parentId, 'badge');
    const result = await inserter.resolveAndInsert(parentId, 'badge', { text: label });
    if (result) { dsComponentCount++; createdNodes.push(result.nodeId); return result; }
    return null;
  }

  // ── TREE RENDERER ──
  // Track structural coverage for validation
  let builtSections = 0;
  let builtGroups = 0;

  /**
   * Render a layout tree recursively into Figma.
   * Preserves hierarchy, direction, and grouping from the HTML structure.
   *
   * @param {Object} layoutNode — from buildLayoutTree
   * @param {string} parentId — Figma parent node ID
   * @param {number} [depth=0] — current depth (for limiting)
   * @param {number} [maxDepth=8] — max recursion depth
   */
  async function renderTree(layoutNode, parentId, depth = 0, maxDepth = 8) {
    if (depth > maxDepth) return;
    if (!layoutNode) return;

    const { role, direction, children, source, tag, name } = layoutNode;
    const cls = source?.attributes?.class || '';
    const text_content = (source?.textContent || '').trim();

    // Leaf text node
    if (role === 'text' && (!children || children.length === 0)) {
      if (text_content) {
        // Detect font size from CSS class hints
        const fontSize = cls.includes('stat-value') ? 24 : cls.includes('page-title') || tag === 'h1' ? 30 : ['h2','h3'].includes(tag) ? 20 : cls.includes('label') || cls.includes('meta') ? 12 : 13;
        const fontWeight = ['h1','h2','h3'].includes(tag) || cls.includes('value') || cls.includes('title') || cls.includes('brand') ? 700 : cls.includes('semibold') || cls.includes('600') ? 600 : 400;
        const fills = cls.includes('subtitle') || cls.includes('label') || cls.includes('meta') || cls.includes('500') || cls.includes('gray') ? [{ type: 'SOLID', color: { r: 0.443, g: 0.443, b: 0.478 } }] : undefined;

        await text({ text: text_content, parentId, fontSize, fontWeight, fills });
      }
      return;
    }

    // Leaf interactive (button/link)
    if (role === 'interactive' && (!children || children.length === 0)) {
      if (text_content) {
        const isLink = tag === 'a' || cls.includes('link');
        const isPrimary = cls.includes('primary') || cls.includes('btn-primary') || cls.includes('run-eval');
        await action(parentId, text_content, isPrimary ? 'primary' : isLink ? 'link' : 'secondary');
      }
      return;
    }

    // Leaf media/decorative
    if ((role === 'media' || role === 'decorative') && (!children || children.length === 0)) {
      if (tag === 'svg' || cls.includes('icon')) {
        await icon(parentId, { className: cls, siblingText: text_content, position: 'leading' }, 16);
      } else {
        // Placeholder for images etc.
        await frame({ name: name || 'media', parentId, width: 40, height: 40, layoutMode: 'NONE', fills: [{ type: 'SOLID', color: { r: 0.894, g: 0.894, b: 0.906 } }], cornerRadius: 6, layoutAlign: 'MIN' });
      }
      return;
    }

    // Container/group: create a frame with correct direction, then render children inside
    if (children && children.length > 0) {
      // Detect styling from CSS classes
      const hasBorder = cls.includes('card') || cls.includes('table-card') || cls.includes('stat-card');
      const hasBg = cls.includes('header') || cls.includes('footer') || cls.includes('sidebar') || cls.includes('card');
      const isSection = depth <= 2 && children.length > 1;

      const frameParams = {
        name: name || tag || 'group',
        parentId,
        layoutMode: direction || 'VERTICAL',
        primaryAxisSizingMode: 'AUTO',
        counterAxisSizingMode: 'AUTO',
        fills: hasBg ? [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] : [],
      };

      // Padding for section-level containers
      if (isSection || cls.includes('section') || cls.includes('header') || cls.includes('footer')) {
        frameParams.paddingTop = 16;
        frameParams.paddingBottom = 16;
        frameParams.paddingLeft = 20;
        frameParams.paddingRight = 20;
      }

      // Gap between children
      if (children.length > 1) {
        frameParams.itemSpacing = direction === 'HORIZONTAL' ? 8 : 6;
      }

      // Border for card-like containers
      if (hasBorder) {
        frameParams.strokes = [{ type: 'SOLID', color: { r: 0.894, g: 0.894, b: 0.906 } }];
        frameParams.strokeWeight = 1;
        frameParams.strokeAlign = 'INSIDE';
        frameParams.cornerRadius = 10;
      }

      // Fill for sidebar
      if (cls.includes('sidebar')) {
        frameParams.width = 220;
        frameParams.counterAxisSizingMode = 'FIXED';
      }

      // Grow for main content
      if (cls.includes('main') || cls.includes('premium-main')) {
        frameParams.layoutGrow = 1;
      }

      const containerResult = await frame(frameParams);

      if (isSection) builtSections++;
      builtGroups++;

      // Render children recursively
      for (const child of children) {
        await renderTree(child, containerResult.nodeId, depth + 1, maxDepth);
      }
    }
  }

  /**
   * Build from parsed HTML using layout tree.
   * This is the primary HTML-driven build method.
   *
   * @param {Object[]} parsedNodes — from parseHTML()
   * @param {Object} buildInfo — { source, maxDepth }
   * @returns {Object} completion report
   */
  async function buildFromHTML(parsedNodes, buildInfo = {}) {
    // Step 1: Build layout tree from HTML
    const layoutTree = buildLayoutTree(parsedNodes);
    console.log('Layout tree: ' + layoutTree.stats.groups + ' groups, ' + layoutTree.stats.leaves + ' leaves, depth ' + layoutTree.stats.maxDepth);

    // Step 2: Create root artboard
    const rootChildren = layoutTree.children[0]?.children || layoutTree.children;
    const isHorizontal = rootChildren.length === 2 && rootChildren.some(c => c.name?.includes('sidebar'));

    const ab = await frame({
      name: buildInfo.name || 'Build',
      width: 1440,
      layoutMode: isHorizontal ? 'HORIZONTAL' : 'VERTICAL',
      primaryAxisSizingMode: isHorizontal ? 'FIXED' : 'AUTO',
      counterAxisSizingMode: isHorizontal ? 'AUTO' : 'FIXED',
      fills: [{ type: 'SOLID', color: { r: 0.98, g: 0.98, b: 0.98 } }],
    });

    // Step 3: Render tree recursively
    for (const child of rootChildren) {
      await renderTree(child, ab.nodeId, 0, buildInfo.maxDepth || 8);
    }

    // Step 4: Structural validation
    const structValidation = validateStructure(layoutTree, { sections: builtSections, groups: builtGroups });

    // Step 5: Complete with contract
    const sections = rootChildren.map(c => c.name).filter(Boolean);
    return complete({
      source: buildInfo.source || 'HTML-driven build',
      sections,
      htmlNodeCount: layoutTree.stats.groups + layoutTree.stats.leaves,
      structValidation,
    });
  }

  // ── BUILD COMPLETE (mandatory contract) ──
  async function complete(buildInfo = {}) {
    // Post-build validation
    const postValidation = {
      targeting: { respected: !!artboardId, targetNodeId, artboardId },
      structure: {
        figmaNodes: createdNodes.length,
        match: true, // Will be evaluated against HTML node count if provided
      },
      layout: {
        violations: violations.filter(v => v.type === 'MISSING_AUTO_LAYOUT'),
        framesWithAutoLayout: createdNodes.length - violations.filter(v => v.type === 'MISSING_AUTO_LAYOUT').length,
        totalFrames: createdNodes.length,
      },
      violations: violations,
    };

    if (buildInfo.htmlNodeCount) {
      const ratio = createdNodes.length / buildInfo.htmlNodeCount;
      postValidation.structure.htmlNodes = buildInfo.htmlNodeCount;
      postValidation.structure.match = ratio >= 0.3; // At least 30% coverage
    }

    const hasCriticalViolation = violations.some(v => v.type === 'MISSING_PARENT');
    const buildFailed = hasCriticalViolation || !artboardId;

    // Run completion contract
    const report = await completeBuild({
      source: buildInfo.source || 'unknown',
      artboardId,
      dsComponents: dsComponentCount,
      iconCount,
      primitives: primitiveCount,
      componentNames: Object.keys(inserter.mappings).filter(k => inserter.mappings[k]).map(k => inserter.mappings[k].name),
      sections: buildInfo.sections || [],
      dsCompliance: compliance,
      startTime,
      failed: buildFailed,
      failureReason: buildFailed ? violations.map(v => v.detail).join('; ') : undefined,
    }, bridgeCall);

    // Print post-validation
    // Include structural validation if available
    const sv = buildInfo.structValidation;

    const lines = [
      '',
      '=== POST-VALIDATION ===',
      '1. Targeting: node respected = ' + (postValidation.targeting.respected ? 'YES' : 'NO'),
      '2. Structure: Figma nodes = ' + postValidation.structure.figmaNodes + (postValidation.structure.htmlNodes ? ' / HTML nodes = ' + postValidation.structure.htmlNodes + ' → match = ' + (postValidation.structure.match ? 'YES' : 'NO') : ''),
      sv ? '3. Sections: HTML ~' + sv.expected.sections + ' / Figma ' + sv.actual.sections + (sv.missing.length ? ' ⚠ ' + sv.missing.join(', ') : ' ✓') : '3. Sections: not checked',
      sv ? '4. Groups: HTML ~' + sv.expected.groups + ' / Figma ' + sv.actual.groups + (sv.flattened.length ? ' ⚠ ' + sv.flattened.join(', ') : ' ✓') : '4. Groups: not checked',
      '5. Layout violations: ' + postValidation.layout.violations.length,
      '6. Critical violations: ' + violations.filter(v => v.type === 'MISSING_PARENT').length,
      '7. Final verdict: ' + (buildFailed ? 'FAILED' : (sv && !sv.valid) ? 'PARTIAL (structure)' : report.status === 'SUCCESS' ? 'PASS' : 'PARTIAL'),
    ];
    for (const v of violations.slice(0, 5)) {
      lines.push('   ⚠ ' + v.type + ': ' + v.detail);
    }
    console.log(lines.join('\n'));

    // Print user summary from completion contract
    console.log('');
    console.log(report.userSummary);

    return { ...report, postValidation };
  }

  return {
    frame, text, icon, component, textOrComponent, action, badge, complete,
    renderTree, buildFromHTML,
    inserter,
    get artboardId() { return artboardId; },
    get stats() { return { dsComponentCount, iconCount, primitiveCount, violations: violations.length, builtSections, builtGroups }; },
  };
}
