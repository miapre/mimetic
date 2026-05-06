'use strict';

function register(server, context) {
  const { bridge, session, registerTool } = context;

  // ── figma_set_text ────────────────────────────────────────────
  registerTool(
    'figma_set_text',
    'Sets the text content of a text node.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Text node ID.' },
        content: { type: 'string', description: 'New text content.' },
      },
      required: ['nodeId', 'content'],
    },
    async (args) => {
      const result = await bridge.send('set_text', args);
      session.toolCallCount++;
      return { ...result };
    }
  );

  // ── figma_set_node_fill ───────────────────────────────────────
  registerTool(
    'figma_set_node_fill',
    'Sets the fill of a node to a DS color variable.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node ID.' },
        fillVariable: { type: 'string', description: 'DS variable path for the fill color.' },
      },
      required: ['nodeId', 'fillVariable'],
    },
    async (args) => {
      const result = await bridge.send('set_node_fill', args);
      session.toolCallCount++;
      return { ...result };
    }
  );

  // ── figma_set_layout_sizing ───────────────────────────────────
  registerTool(
    'figma_set_layout_sizing',
    'Updates layout sizing, padding, gap, and max width on a frame node.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Frame node ID.' },
        layoutSizingHorizontal: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'] },
        layoutSizingVertical: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'] },
        width: { type: 'number', description: 'Fixed width.' },
        height: { type: 'number', description: 'Fixed height.' },
        paddingVariable: { type: 'string', description: 'DS variable for uniform padding.' },
        paddingTopVariable: { type: 'string' },
        paddingBottomVariable: { type: 'string' },
        paddingLeftVariable: { type: 'string' },
        paddingRightVariable: { type: 'string' },
        gapVariable: { type: 'string', description: 'DS variable for item spacing.' },
        maxWidth: { type: 'number', description: 'Max width constraint.' },
      },
      required: ['nodeId'],
    },
    async (args) => {
      const result = await bridge.send('set_layout_sizing', args);
      session.toolCallCount++;
      return { ...result };
    }
  );

  // ── figma_set_visibility ──────────────────────────────────────
  registerTool(
    'figma_set_visibility',
    'Shows or hides a node.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node ID.' },
        visible: { type: 'boolean', description: 'True to show, false to hide.' },
      },
      required: ['nodeId', 'visible'],
    },
    async (args) => {
      const result = await bridge.send('set_visibility', args);
      session.toolCallCount++;
      return { ...result };
    }
  );

  // ── figma_set_variable_mode ───────────────────────────────────
  registerTool(
    'figma_set_variable_mode',
    'Sets the explicit variable mode on a node for a given collection. Required on every new artboard to render DS variables correctly.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node ID (typically the artboard).' },
        collectionName: { type: 'string', description: 'Variable collection name.' },
        modeIndex: { type: 'number', description: 'Mode index (typically 0 for default).' },
      },
      required: ['nodeId', 'collectionName', 'modeIndex'],
    },
    async (args) => {
      const result = await bridge.send('set_variable_mode', args);
      session.toolCallCount++;
      return {
        ...result,
        hint: 'Variable mode set. Without this, DS variables render as black.',
      };
    }
  );

  // ── figma_set_text_style ──────────────────────────────────────
  registerTool(
    'figma_set_text_style',
    'Applies a DS text style to a text node.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Text node ID.' },
        textStyleId: { type: 'string', description: 'DS text style key.' },
      },
      required: ['nodeId', 'textStyleId'],
    },
    async (args) => {
      const result = await bridge.send('set_text_style', args);
      session.toolCallCount++;
      return { ...result };
    }
  );

  // ── figma_move_node ───────────────────────────────────────────
  registerTool(
    'figma_move_node',
    'Moves a node to a new parent at the specified index.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node ID to move.' },
        parentId: { type: 'string', description: 'New parent node ID.' },
        index: { type: 'number', description: 'Insert index within the parent. Omit for end.' },
      },
      required: ['nodeId', 'parentId'],
    },
    async (args) => {
      const result = await bridge.send('move_node', args);
      session.toolCallCount++;
      return { ...result };
    }
  );

  // ── figma_delete_node ─────────────────────────────────────────
  registerTool(
    'figma_delete_node',
    'Deletes a node from the Figma document. Use carefully — never delete artboards.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node ID to delete.' },
      },
      required: ['nodeId'],
    },
    async (args) => {
      const result = await bridge.send('delete_node', args);
      session.toolCallCount++;
      return { ...result };
    }
  );

  // ── figma_restyle_artboard ────────────────────────────────────
  registerTool(
    'figma_restyle_artboard',
    'Updates styling properties on an existing artboard or frame.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Artboard/frame node ID.' },
        fillVariable: { type: 'string', description: 'DS variable for background fill.' },
        cornerRadiusVariable: { type: 'string', description: 'DS variable for corner radius.' },
        strokeVariable: { type: 'string', description: 'DS variable for stroke color.' },
        strokeWeight: { type: 'number', description: 'Stroke weight.' },
        paddingVariable: { type: 'string', description: 'DS variable for uniform padding.' },
        gapVariable: { type: 'string', description: 'DS variable for gap.' },
      },
      required: ['nodeId'],
    },
    async (args) => {
      const result = await bridge.send('restyle_artboard', args);
      session.toolCallCount++;
      return { ...result };
    }
  );
}

module.exports = { register };
