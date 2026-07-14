'use strict';

const { surfaceBindingFeedback } = require('../utils/binding-feedback');

// v1 rule, restored: container width controls wrapping in Figma, so a
// hardcoded \n / \r\n in text content fights auto-layout instead of letting
// it wrap. Strip line breaks before the content ever reaches the bridge —
// this is MCP-side, not a plugin/bridge concern. Scoped strictly to the
// 'text' op below; component text overrides (figma_component_text) are a
// different tool and are NOT touched by this helper.
function stripLineBreaks(content) {
  if (typeof content !== 'string' || !/[\r\n]/.test(content)) {
    return { content, stripped: false };
  }
  const normalized = content
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  return { content: normalized, stripped: true };
}

const PHASE_HINT = 'Edit ops modify existing nodes and validate against the cached DS — '
  + 'call mimic_discover_ds (and reach Phase 2) before editing.';

/**
 * v3.0.0 consolidation: figma_update_node merges 10 former standalone
 * tools into one op-dispatched tool: figma_set_text, figma_set_text_style,
 * figma_set_node_fill, figma_set_layout_sizing, figma_set_visibility,
 * figma_set_node_position, figma_restyle_artboard, figma_move_node (all
 * previously in this file), plus figma_select_node and figma_change_page
 * (previously in inspect.js). Each op function below is a straight
 * extraction of the former handler's body — same bridge calls, same
 * validation, same response shape.
 *
 * Phase gating: the original 8 mutation tools were gated centrally in
 * mcp.js's EDIT_TOOLS_REQUIRE_PHASE_2 set (edit.js used to be owned by a
 * different worker with no requirePhase() calls of its own — see the B21
 * comment there). figma_select_node/figma_change_page were NEVER gated.
 * Since one tool name can no longer express "gate some ops, not others"
 * in that centralized name Set, the gate now lives here instead — every
 * op below calls requirePhase(2, ...) directly EXCEPT 'select' and
 * 'page', preserving the exact original per-action behavior.
 */
function register(server, context) {
  const { bridge, dsCache, session, requirePhase, registerTool } = context;

  // ── op: text ─────────────────────────────────────────────────
  async function opText(args) {
    requirePhase(2, PHASE_HINT);
    const { content: strippedContent, stripped: linebreaksStripped } = stripLineBreaks(args.content);
    const payload = { nodeId: args.nodeId, content: strippedContent };
    const result = await bridge.send('set_text', payload);
    session.toolCallCount++;
    return {
      ...result,
      _textNote: linebreaksStripped
        ? 'Line breaks removed — container width controls wrapping.'
        : undefined,
    };
  }

  // ── op: text_style ───────────────────────────────────────────
  async function opTextStyle(args) {
    requirePhase(2, PHASE_HINT);
    const result = await bridge.send('set_text_style', { nodeId: args.nodeId, textStyleId: args.textStyleId });
    session.toolCallCount++;
    return { ...result };
  }

  // ── op: fill ─────────────────────────────────────────────────
  async function opFill(args) {
    requirePhase(2, PHASE_HINT);
    const payload = { nodeId: args.nodeId, fillStyleId: args.fillStyleId, fillVariable: args.fillVariable, fill: args.fill };
    if (payload.fillVariable) {
      const validation = dsCache.validateVariables(payload);
      if (!validation.valid) {
        return {
          error: 'INVALID_VARIABLE_PATHS',
          warnings: validation.warnings,
          message: 'Fix the variable paths and try again. Do not proceed with invalid paths.',
        };
      }
    } else if (!payload.fillStyleId && !payload.fill && !args.rawColor) {
      return {
        error: 'MISSING_COLOR',
        message: 'One of fillStyleId, fillVariable, or fill is required.',
      };
    }
    const result = await bridge.send('set_node_fill', payload);
    session.toolCallCount++;
    surfaceBindingFeedback(result, 'set_node_fill');
    return { ...result };
  }

  // ── op: layout ───────────────────────────────────────────────
  async function opLayout(args) {
    requirePhase(2, PHASE_HINT);
    const payload = {
      nodeId: args.nodeId,
      layoutSizingHorizontal: args.layoutSizingHorizontal,
      layoutSizingVertical: args.layoutSizingVertical,
      width: args.width,
      height: args.height,
      paddingVariable: args.paddingVariable,
      paddingTopVariable: args.paddingTopVariable,
      paddingBottomVariable: args.paddingBottomVariable,
      paddingLeftVariable: args.paddingLeftVariable,
      paddingRightVariable: args.paddingRightVariable,
      gapVariable: args.gapVariable,
      maxWidth: args.maxWidth,
      primaryAxisAlignItems: args.primaryAxisAlignItems,
      counterAxisAlignItems: args.counterAxisAlignItems,
    };
    const validation = dsCache.validateVariables(payload);
    if (!validation.valid) {
      return {
        error: 'INVALID_VARIABLE_PATHS',
        warnings: validation.warnings,
        message: 'Fix the variable paths and try again. Do not proceed with invalid paths.',
      };
    }
    const result = await bridge.send('set_layout_sizing', payload);
    session.toolCallCount++;
    surfaceBindingFeedback(result, 'set_layout_sizing');
    return { ...result };
  }

  // ── op: visibility ───────────────────────────────────────────
  async function opVisibility(args) {
    requirePhase(2, PHASE_HINT);
    const result = await bridge.send('set_visibility', { nodeId: args.nodeId, visible: args.visible });
    session.toolCallCount++;
    return { ...result };
  }

  // ── op: position ─────────────────────────────────────────────
  async function opPosition(args) {
    requirePhase(2, PHASE_HINT);
    const result = await bridge.send('set_node_position', { nodeId: args.nodeId, x: args.x, y: args.y });
    session.toolCallCount++;
    return { ...result };
  }

  // ── op: move ─────────────────────────────────────────────────
  async function opMove(args) {
    requirePhase(2, PHASE_HINT);
    const result = await bridge.send('move_node', { nodeId: args.nodeId, parentId: args.parentId, index: args.index });
    session.toolCallCount++;
    return { ...result };
  }

  // ── op: restyle ──────────────────────────────────────────────
  async function opRestyle(args) {
    requirePhase(2, PHASE_HINT);
    const payload = {
      nodeId: args.nodeId,
      fillVariable: args.fillVariable,
      cornerRadiusVariable: args.cornerRadiusVariable,
      strokeVariable: args.strokeVariable,
      strokeWeight: args.strokeWeight,
      paddingVariable: args.paddingVariable,
      gapVariable: args.gapVariable,
    };
    const validation = dsCache.validateVariables(payload);
    if (!validation.valid) {
      return {
        error: 'INVALID_VARIABLE_PATHS',
        warnings: validation.warnings,
        message: 'Fix the variable paths and try again. Do not proceed with invalid paths.',
      };
    }
    const result = await bridge.send('restyle_artboard', payload);
    session.toolCallCount++;
    surfaceBindingFeedback(result, 'restyle_artboard');
    return { ...result };
  }

  // ── op: select (ungated — was figma_select_node) ────────────
  async function opSelect(args) {
    const result = await bridge.send('select_node', { nodeId: args.nodeId });
    session.toolCallCount++;
    return { ...result };
  }

  // ── op: page (ungated — was figma_change_page) ──────────────
  async function opPage(args) {
    const result = await bridge.send('change_page', { pageName: args.pageName, pageId: args.pageId });
    session.toolCallCount++;
    return { ...result };
  }

  // ── figma_update_node ────────────────────────────────────────
  registerTool(
    'figma_update_node',
    'Mutates an existing Figma node or the editor\'s UI focus, dispatched by `op`. Ops: "text" (set text content), "text_style" (apply DS text style), "fill" (fillStyleId/fillVariable/raw fill), "layout" (sizing, padding, gap, alignment), "visibility" (show/hide), "position" (absolute x/y), "restyle" (artboard/frame fill+radius+stroke+padding+gap in one call), "move" (reparent via parentId+index), "select" (select+scroll into view), "page" (switch page by name/id). All ops except "select"/"page" require Phase 2 (DS discovered) and validate any *Variable path against the cached DS before sending. Use figma_delete_node (separate, destructive tool) to remove a node instead.',
    {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['text', 'text_style', 'fill', 'layout', 'visibility', 'position', 'restyle', 'move', 'select', 'page'],
          description: 'Which mutation to perform.',
        },
        nodeId: { type: 'string', description: 'Target node ID. Required for every op except "page".' },
        content: { type: 'string', description: 'New text content. op="text".' },
        textStyleId: { type: 'string', description: 'DS text style key. op="text_style".' },
        fillStyleId: { type: 'string', description: 'DS fill style key (from figma_list_ds). op="fill". Priority: fillStyleId → fillVariable → fill.' },
        fillVariable: { type: 'string', description: 'DS variable path for fill color. op="fill" or "restyle".' },
        fill: { description: 'Raw color as hex string ("#3b36f2") or RGB object. op="fill" fallback when no DS styles/variables available.' },
        layoutSizingHorizontal: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'], description: 'op="layout".' },
        layoutSizingVertical: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'], description: 'op="layout".' },
        width: { type: 'number', description: 'Fixed width. op="layout".' },
        height: { type: 'number', description: 'Fixed height. op="layout".' },
        paddingVariable: { type: 'string', description: 'DS variable for uniform padding. op="layout" or "restyle".' },
        paddingTopVariable: { type: 'string', description: 'op="layout".' },
        paddingBottomVariable: { type: 'string', description: 'op="layout".' },
        paddingLeftVariable: { type: 'string', description: 'op="layout".' },
        paddingRightVariable: { type: 'string', description: 'op="layout".' },
        gapVariable: { type: 'string', description: 'DS variable for item spacing. op="layout" or "restyle".' },
        maxWidth: { type: 'number', description: 'Max width constraint. op="layout".' },
        primaryAxisAlignItems: { type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'], description: 'op="layout".' },
        counterAxisAlignItems: { type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'BASELINE'], description: 'op="layout".' },
        visible: { type: 'boolean', description: 'True to show, false to hide. op="visibility".' },
        x: { type: 'number', description: 'Absolute x position. op="position".' },
        y: { type: 'number', description: 'Absolute y position. op="position".' },
        cornerRadiusVariable: { type: 'string', description: 'DS variable for corner radius. op="restyle".' },
        strokeVariable: { type: 'string', description: 'DS variable for stroke color. op="restyle".' },
        strokeWeight: { type: 'number', description: 'Stroke weight. op="restyle".' },
        parentId: { type: 'string', description: 'New parent node ID. op="move".' },
        index: { type: 'number', description: 'Insert index within the new parent. op="move". Omit for end.' },
        pageName: { type: 'string', description: 'Page name to switch to. op="page".' },
        pageId: { type: 'string', description: 'Page ID to switch to. op="page". Takes precedence over pageName.' },
      },
      required: ['op'],
    },
    async (args) => {
      switch (args.op) {
        case 'text': return opText(args);
        case 'text_style': return opTextStyle(args);
        case 'fill': return opFill(args);
        case 'layout': return opLayout(args);
        case 'visibility': return opVisibility(args);
        case 'position': return opPosition(args);
        case 'restyle': return opRestyle(args);
        case 'move': return opMove(args);
        case 'select': return opSelect(args);
        case 'page': return opPage(args);
        default:
          return { error: 'INVALID_OP', message: `Unknown op "${args.op}". Use text, text_style, fill, layout, visibility, position, restyle, move, select, or page.` };
      }
    },
    {
      annotations: { title: 'Update a Figma node or editor focus', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }
  );

  // ── figma_variable_modes ─────────────────────────────────────
  // v3.0.0: merges figma_set_variable_mode + figma_set_all_variable_modes.
  // Renamed (not just merged) — figma_set_all_variable_modes had already
  // subsumed figma_set_variable_mode's one-collection-at-a-time use case
  // for every practical purpose (CLAUDE.md's Artboard Setup step always
  // called the "all" variant); this tool keeps that as the default
  // behavior and exposes collectionName as an optional narrowing param.
  registerTool(
    'figma_variable_modes',
    'Sets the variable mode (e.g. light/dark) on a node — required on every new artboard, or DS variables render as black. By default sets the mode on ALL variable collections at once (pass modeIndex only). Pass collectionName to target a single collection instead. Params: nodeId (required, typically the artboard), modeIndex (required, 0=default/light, 1=dark), collectionName (optional). Requires Phase 2.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node ID (typically the artboard).' },
        modeIndex: { type: 'number', description: 'Mode index. 0 = default/light, 1 = dark (if available).' },
        collectionName: { type: 'string', description: 'Optional — variable collection name. Omit to set the mode on ALL collections at once (recommended).' },
      },
      required: ['nodeId', 'modeIndex'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      if (args.collectionName) {
        const result = await bridge.send('set_variable_mode', args);
        session.toolCallCount++;
        return {
          ...result,
          hint: 'Variable mode set. Without this, DS variables render as black.',
        };
      }
      const result = await bridge.send('set_all_variable_modes', { nodeId: args.nodeId, modeIndex: args.modeIndex });
      session.toolCallCount++;
      return {
        ...result,
        hint: 'Variable modes set on all collections. DS variables will now render correctly.',
      };
    },
    {
      annotations: { title: 'Set artboard variable mode(s)', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }
  );

  // ── figma_delete_node ─────────────────────────────────────────
  // Unchanged from v2.1.0 — kept standalone (destructive, never merged).
  // Still centrally gated via mcp.js's EDIT_TOOLS_REQUIRE_PHASE_2 (its
  // handler has no requirePhase() call of its own — see mcp.js comment).
  registerTool(
    'figma_delete_node',
    'Deletes a node from the Figma document. NEVER deletes artboards (top-level frames) — only child nodes within an artboard. To rebuild a screen, create a NEW artboard alongside the existing one. Destructive and irreversible via the API — verify the nodeId with figma_inspect first if unsure.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node ID to delete. Must NOT be a top-level artboard.' },
      },
      required: ['nodeId'],
    },
    async (args) => {
      // Guard: prevent deletion of top-level frames (artboards).
      // Artboards are never deleted — iterate or build new ones alongside.
      try {
        const parentInfo = await bridge.send('get_node_parent', { nodeId: args.nodeId });
        const parentType = parentInfo?.type || parentInfo?.parentType;
        if (parentType === 'PAGE') {
          return {
            error: 'ARTBOARD_DELETE_BLOCKED',
            nodeId: args.nodeId,
            message: 'Cannot delete a top-level artboard. Artboards are NEVER deleted — '
              + 'only users remove artboards. To rebuild, create a NEW artboard alongside '
              + 'the existing one. To iterate, edit the existing artboard in place.',
          };
        }
      } catch (_) {
        // If we can't check the parent, allow the delete — the node may
        // already be gone or deeply nested. The guard is best-effort.
      }
      const result = await bridge.send('delete_node', args);
      session.toolCallCount++;
      return { ...result };
    },
    {
      annotations: { title: 'Delete a Figma node', readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }
  );
}

module.exports = { register };
