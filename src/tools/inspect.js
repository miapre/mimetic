'use strict';

/**
 * v3.0.0 consolidation: 9 read/inspect tools (figma_get_node_props,
 * figma_get_node_children, figma_get_node_parent, figma_get_text_info,
 * figma_get_pages, figma_get_page_nodes, figma_get_selection,
 * figma_get_component_variants, mimic_find_node) are merged into ONE tool,
 * `figma_inspect`, dispatched by `target`. All of these were read-only —
 * figma_select_node and figma_change_page (also previously registered
 * here) were NOT merged in because they mutate Figma's active
 * selection/page and would break figma_inspect's readOnlyHint: true
 * contract; they now live on figma_update_node (see edit.js) as the
 * 'select' and 'page' ops.
 *
 * Each function below is a straight extraction of the former standalone
 * handler's body — figma_inspect's dispatch is a pure routing layer.
 */
function register(server, context) {
  const { bridge, buildManifest, session, registerTool } = context;

  async function inspectNode(args) {
    const result = await bridge.send('get_node_props', args);
    session.toolCallCount++;
    return { ...result };
  }

  async function inspectChildren(args) {
    const result = await bridge.send('get_node_children', { ...args, depth: args.depth ?? 1 });
    session.toolCallCount++;
    return { ...result };
  }

  async function inspectParent(args) {
    const result = await bridge.send('get_node_parent', args);
    session.toolCallCount++;
    return { ...result };
  }

  async function inspectPages() {
    const result = await bridge.send('get_pages', {});
    session.toolCallCount++;
    return { ...result };
  }

  async function inspectPageNodes() {
    const result = await bridge.send('get_page_nodes', {});
    session.toolCallCount++;
    return { ...result };
  }

  async function inspectVariants(args) {
    const result = await bridge.send('get_component_variants', args);
    session.toolCallCount++;
    return { ...result };
  }

  async function inspectText(args) {
    const result = await bridge.send('get_text_info', args);
    session.toolCallCount++;
    return { ...result };
  }

  async function inspectSelection() {
    const result = await bridge.send('get_selection', {});
    session.toolCallCount++;
    return { ...result };
  }

  function inspectSection(args) {
    const match = buildManifest.findBySection(args.sectionName);
    if (match) return { found: true, ...match };
    return { found: false, available: buildManifest.sections.map(s => s.htmlSection) };
  }

  // ── figma_inspect ──────────────────────────────────────────────
  registerTool(
    'figma_inspect',
    'Reads Figma document state — node properties, children, parent, text detail, pages, top-level page nodes, selection, component variants, or a build-manifest section lookup. Read-only, never blocked by phase gates. Use to verify state before/after edits, discover node IDs, or check what a component set supports. Params: target (required: "node"|"children"|"parent"|"text"|"pages"|"page"|"selection"|"variants"|"section") selects the read; nodeId (node/children/parent/text), depth (children, default 1), componentSetKey (variants), sectionName (section — HTML section name from the last build).',
    {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['node', 'children', 'parent', 'text', 'pages', 'page', 'selection', 'variants', 'section'],
          description: '"node"=full node props, "children"=child nodes, "parent"=parent node, "text"=text node detail, "pages"=all pages in the file, "page"=top-level nodes on the current page, "selection"=currently selected nodes, "variants"=all variants for a component set, "section"=find a node by its HTML section name from the last build.',
        },
        nodeId: { type: 'string', description: 'Node ID to inspect. Required for target: node, children, parent, text.' },
        depth: { type: 'number', description: 'How many levels deep to traverse. Only used with target="children". Default 1.' },
        componentSetKey: { type: 'string', description: 'Component set key. Required for target="variants".' },
        sectionName: { type: 'string', description: 'The HTML section to find (e.g., "header", "metrics row", "table"). Required for target="section".' },
      },
      required: ['target'],
    },
    async (args) => {
      switch (args.target) {
        case 'node': return inspectNode(args);
        case 'children': return inspectChildren(args);
        case 'parent': return inspectParent(args);
        case 'text': return inspectText(args);
        case 'pages': return inspectPages();
        case 'page': return inspectPageNodes();
        case 'selection': return inspectSelection();
        case 'variants': return inspectVariants(args);
        case 'section': return inspectSection(args);
        default:
          return { error: 'INVALID_TARGET', message: `Unknown target "${args.target}". Use node, children, parent, text, pages, page, selection, variants, or section.` };
      }
    },
    {
      annotations: { title: 'Inspect Figma document state', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    }
  );
}

module.exports = { register };
