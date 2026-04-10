/**
 * figma-write-mcp / mcp.js
 *
 * MCP server (stdio transport). Exposes Figma write tools to Claude.
 * Communicates with the local bridge server which forwards instructions
 * to the Figma desktop plugin.
 *
 * Configured in ~/.claude/settings.json — see README.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:3055';

// ---------------------------------------------------------------------------
// Bridge communication
// ---------------------------------------------------------------------------

async function callBridge(type, params = {}) {
  let res;
  try {
    res = await fetch(`${BRIDGE_URL}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, params }),
    });
  } catch (e) {
    throw new Error(
      `Could not reach the bridge server at ${BRIDGE_URL}. ` +
      'Is it running? Start it with: node bridge.js'
    );
  }

  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Bridge returned an error');
  return data.result;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'figma_insert_component',
    description:
      'Insert a library component instance into a Figma frame by node ID. ' +
      'Use this to insert any published component from your design system library — ' +
      'navigation bars, headers, footers, section titles, cards, and so on. ' +
      'This inserts the real library instance — not a recreation.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId:       { type: 'string', description: 'Component node ID, e.g. "1234:56789"' },
        fileKey:      { type: 'string', description: 'Figma file key from the URL of your design system file.' },
        parentNodeId: { type: 'string', description: 'Node ID of the parent frame. Omit to place on current page.' },
        x:            { type: 'number' },
        y:            { type: 'number' },
        width:        { type: 'number', description: 'Resize instance to this width after insertion.' },
        height:       { type: 'number', description: 'Resize instance to this height after insertion.' },
      },
      required: ['nodeId', 'fileKey'],
    },
  },

  {
    name: 'figma_create_frame',
    description:
      'Create an auto-layout frame. Use for application shells, content containers, cards, rows, columns.',
    inputSchema: {
      type: 'object',
      properties: {
        name:         { type: 'string', description: 'Layer name' },
        parentNodeId: { type: 'string', description: 'Append to this parent. Omit to place on current page.' },
        width:        { type: 'number' },
        height:       { type: 'number' },
        direction: {
          type: 'string',
          enum: ['HORIZONTAL', 'VERTICAL', 'NONE'],
          description: 'Auto-layout direction. NONE = no auto-layout.',
        },
        gap:           { type: 'number', description: 'Gap between children in px.' },
        padding:       { type: 'number', description: 'Uniform padding on all sides in px.' },
        paddingTop:    { type: 'number' },
        paddingRight:  { type: 'number' },
        paddingBottom: { type: 'number' },
        paddingLeft:   { type: 'number' },
        primaryAxisSizingMode: {
          type: 'string', enum: ['FIXED', 'AUTO'],
          description: 'AUTO = hug contents along primary axis.',
        },
        counterAxisSizingMode: {
          type: 'string', enum: ['FIXED', 'AUTO'],
          description: 'AUTO = hug contents along counter axis.',
        },
        primaryAxisAlignItems: {
          type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'],
        },
        counterAxisAlignItems: {
          type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'BASELINE'],
        },
        fillVariable: {
          type: 'string',
          description: 'Design token variable path for background fill, e.g. "Colors/Background/bg-primary". The plugin resolves this to the actual Figma variable.',
        },
        fillHex: {
          type: 'string',
          description: 'Fallback hex color if fillVariable is not available, e.g. "#F9FAFB".',
        },
        fillNone:     { type: 'boolean', description: 'Set true for no fill (transparent).' },
        strokeVariable: { type: 'string', description: 'Variable path for border color.' },
        strokeHex:    { type: 'string', description: 'Fallback hex for border color.' },
        strokeWidth:  { type: 'number', description: 'Border width in px.' },
        cornerRadius: { type: 'number', description: 'Corner radius in px.' },
        clipsContent: { type: 'boolean' },
        layoutGrow:   { type: 'number', description: '1 = fill remaining space in parent.' },
        layoutAlign:  { type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'STRETCH', 'INHERIT'] },
        x:            { type: 'number' },
        y:            { type: 'number' },
      },
      required: ['name'],
    },
  },

  {
    name: 'figma_create_text',
    description: 'Create a text node with font and color tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        text:         { type: 'string', description: 'Text content.' },
        parentNodeId: { type: 'string' },
        fillVariable: { type: 'string', description: 'Color token path, e.g. "Colors/Text/text-primary (900)"' },
        fillHex:      { type: 'string', description: 'Fallback hex color, e.g. "#101828".' },
        fontSize:     { type: 'number' },
        fontWeight:   { type: 'number', enum: [400, 500, 600, 700] },
        lineHeight:   { type: 'number', description: 'Line height in px.' },
        textAlignHorizontal: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT'] },
        width:        { type: 'number', description: 'Fixed width — text wraps at this width.' },
        layoutGrow:   { type: 'number' },
        layoutAlign:  { type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'STRETCH', 'INHERIT'] },
        x:            { type: 'number' },
        y:            { type: 'number' },
      },
      required: ['text'],
    },
  },

  {
    name: 'figma_create_rectangle',
    description: 'Create a rectangle. Useful for dividers (e.g. 1px tall), image placeholders, colored blocks.',
    inputSchema: {
      type: 'object',
      properties: {
        name:         { type: 'string' },
        width:        { type: 'number' },
        height:       { type: 'number' },
        parentNodeId: { type: 'string' },
        fillVariable: { type: 'string' },
        fillHex:      { type: 'string' },
        fillNone:     { type: 'boolean' },
        strokeVariable: { type: 'string' },
        strokeHex:    { type: 'string' },
        strokeWidth:  { type: 'number' },
        cornerRadius: { type: 'number' },
        layoutGrow:   { type: 'number' },
        x:            { type: 'number' },
        y:            { type: 'number' },
      },
      required: ['width', 'height'],
    },
  },

  {
    name: 'figma_set_component_text',
    description:
      'Set a text property on a component instance. ' +
      'Use after inserting SECTION_TITLE to set its title text.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId:       { type: 'string', description: 'Node ID of the component instance.' },
        propertyName: { type: 'string', description: 'Component property name or text layer name to set.' },
        value:        { type: 'string', description: 'New text value.' },
      },
      required: ['nodeId', 'propertyName', 'value'],
    },
  },

  {
    name: 'figma_set_layout_sizing',
    description: 'Adjust layout sizing and alignment of a node within its auto-layout parent.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId:                { type: 'string' },
        layoutGrow:            { type: 'number', description: '0 = fixed, 1 = fill container.' },
        layoutAlign:           { type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'STRETCH', 'INHERIT'] },
        primaryAxisSizingMode: { type: 'string', enum: ['FIXED', 'AUTO'] },
        counterAxisSizingMode: { type: 'string', enum: ['FIXED', 'AUTO'] },
      },
      required: ['nodeId'],
    },
  },

  {
    name: 'figma_get_selection',
    description: 'Get the currently selected nodes in Figma. Returns node IDs, names, and dimensions.',
    inputSchema: { type: 'object', properties: {} },
  },

  {
    name: 'figma_select_node',
    description: 'Select a node in Figma and scroll it into view.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
      },
      required: ['nodeId'],
    },
  },

  {
    name: 'figma_get_page_nodes',
    description: 'List all top-level nodes on the current Figma page (names, IDs, positions, dimensions).',
    inputSchema: { type: 'object', properties: {} },
  },

  {
    name: 'figma_delete_node',
    description: 'Delete a node from the Figma document.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
      },
      required: ['nodeId'],
    },
  },

  {
    name: 'figma_create_chart',
    description:
      'Render a chart directly in Figma. All data is sent in one call — no per-element round trips. ' +
      'Supported chart types:\n' +
      '  • scatter / jitter — scatter plot with categorical Y bands (e.g. Correct vs Failed vs latency)\n' +
      '  • line — line chart with optional area fill, smooth curves, multi-series\n' +
      '  • donut / pie — donut or pie chart with legend and optional center label\n' +
      '  • bar / histogram — vertical bar chart with optional stacked segments per bucket; supports annotation vlines',
    inputSchema: {
      type: 'object',
      properties: {
        chartType: {
          type: 'string',
          enum: ['scatter', 'jitter', 'line', 'area', 'donut', 'pie', 'bar', 'histogram'],
          description: 'Type of chart to render.',
        },
        parentNodeId: { type: 'string', description: 'Parent frame to insert the chart into.' },
        name:         { type: 'string', description: 'Layer name for the chart frame.' },
        width:        { type: 'number', description: 'Total chart width in px.' },
        height:       { type: 'number', description: 'Total chart height in px (scatter/line).' },

        // ── bar / histogram ──
        bars: {
          type: 'array',
          description:
            'bar: [{label: string, segments: [{category: string, value: number}, ...]}, ...] — one entry per bucket.',
        },
        annotations: {
          type: 'array',
          description:
            'bar: [{type: "vline", barIndex: number, label: string, color: hex}] — vertical annotation lines.',
        },

        // ── scatter / jitter ──
        data: {
          type: 'array',
          description:
            'scatter: [{x: number, category: string}, ...] — one entry per data point.\n' +
            'donut/pie: [{label: string, value: number, color: hex}, ...]',
        },
        xDomain:       { type: 'array', items: { type: 'number' }, description: '[min, max] for x-axis.' },
        categories: {
          type: 'object',
          description: 'scatter: category name → hex fill color. E.g. {"Correct":"#17B26A","Failed":"#F97066"}.',
        },
        categoryOrder: {
          type: 'array',
          items: { type: 'string' },
          description: 'scatter: top-to-bottom order of category bands.',
        },
        dotSize:     { type: 'number', description: 'Dot diameter in px. Default 7.' },
        jitter:      { type: 'boolean', description: 'Add deterministic jitter to scatter dots. Default true.' },
        xTicks:      { type: 'array', description: 'Values to draw grid lines and labels at on X axis.' },
        tickSuffix:  { type: 'string', description: 'scatter: suffix for x tick labels, e.g. "s".' },
        xLabel:      { type: 'string', description: 'X-axis title.' },

        // ── line ──
        series: {
          type: 'array',
          description:
            'line: [{name, color, data: [{x, y}, ...], area: boolean, strokeWidth: number}, ...]',
        },
        yDomain:       { type: 'array', items: { type: 'number' }, description: '[min, max] for y-axis (line).' },
        yTicks:        { type: 'array', description: 'Y-axis tick values (line).' },
        xTickSuffix:   { type: 'string', description: 'line: suffix for x tick labels.' },
        yTickSuffix:   { type: 'string', description: 'line: suffix for y tick labels.' },
        yLabel:        { type: 'string', description: 'Y-axis title (line).' },

        // ── donut / pie ──
        size:           { type: 'number', description: 'donut: outer diameter in px. Default 240.' },
        innerRadius:    { type: 'number', description: 'donut: 0 = pie, 0.6 = donut. Default 0.6.' },
        centerLabel:    { type: 'string', description: 'donut: large text in the center hole.' },
        centerSubLabel: { type: 'string', description: 'donut: small subtitle below center label.' },
      },
      required: ['chartType'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool → bridge instruction mapping
// ---------------------------------------------------------------------------

const DIRECT_PASS = new Set([
  'figma_create_frame',
  'figma_create_text',
  'figma_create_rectangle',
  'figma_set_component_text',
  'figma_set_layout_sizing',
  'figma_get_selection',
  'figma_select_node',
  'figma_get_page_nodes',
  'figma_delete_node',
  'figma_create_chart',
]);

// Strip "figma_" prefix to get the bridge instruction type
function bridgeType(toolName) {
  return toolName.replace(/^figma_/, '');
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'figma-write-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result;

    if (name === 'figma_insert_component') {
      result = await callBridge('insert_component', args);
    } else if (DIRECT_PASS.has(name)) {
      result = await callBridge(bridgeType(name), args);
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };

  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
