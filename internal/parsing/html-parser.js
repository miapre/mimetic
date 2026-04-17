/**
 * Mimic AI — HTML Parser
 *
 * Converts rendered HTML string into the parsed node tree format
 * expected by the component resolver and composite detector.
 *
 * Output node format:
 *   { tag, attributes, textContent, children, computedStyles }
 *
 * Rules:
 *   - Preserves DOM hierarchy and child order
 *   - Preserves text content exactly
 *   - Ignores non-UI nodes (script, style, meta, link, noscript)
 *   - Deterministic output for identical input
 *
 * Usage:
 *   import { parseHTML } from './html-parser.js';
 *   const nodes = parseHTML(htmlString);
 */

import { parse as parseHtml } from 'node-html-parser';

// Tags to skip — non-visual elements
const SKIP_TAGS = new Set([
  'script', 'style', 'meta', 'link', 'noscript', 'head', 'title',
  'base', 'template', 'slot', 'colgroup', 'col',
]);

// Tags that are structural but should be traversed (not output as nodes)
const PASSTHROUGH_TAGS = new Set(['html', 'body']);

// Attributes to capture (relevant for intent detection)
const CAPTURE_ATTRS = [
  'class', 'id', 'role', 'href', 'type', 'src', 'alt', 'name',
  'placeholder', 'value', 'disabled', 'checked', 'selected',
  'aria-label', 'aria-labelledby', 'aria-describedby',
  'aria-hidden', 'aria-expanded', 'aria-current',
  'data-testid', 'data-state', 'tabindex', 'target',
  'onclick', 'action', 'method', 'for',
];

/**
 * Extract relevant attributes from a parsed HTML element.
 */
function extractAttributes(element) {
  const attrs = {};
  for (const key of CAPTURE_ATTRS) {
    const val = element.getAttribute(key);
    if (val !== null && val !== undefined) {
      attrs[key] = val;
    }
  }
  return attrs;
}

/**
 * Get direct text content of an element (not including children's text).
 */
function getDirectText(element) {
  let text = '';
  for (const child of element.childNodes) {
    if (child.nodeType === 3) { // TEXT_NODE
      text += child.rawText;
    }
  }
  return text.trim();
}

/**
 * Get full text content of an element (including all descendants).
 */
function getFullText(element) {
  return (element.textContent || '').trim();
}

// Global counter for stable node IDs. Reset per parseHTML() call.
let _nodeIdCounter = 0;

/**
 * Convert a parsed HTML element into the Mimic node format.
 * Recursively processes children. Every node gets a stable _id.
 */
function convertNode(element, parentPath = '') {
  const tag = (element.tagName || '').toLowerCase();

  // Skip non-UI tags
  if (SKIP_TAGS.has(tag)) return null;

  // Skip hidden elements
  const ariaHidden = element.getAttribute('aria-hidden');
  if (ariaHidden === 'true') return null;
  const style = element.getAttribute('style') || '';
  if (style.includes('display:none') || style.includes('display: none')) return null;

  // Assign stable ID
  const nodeId = _nodeIdCounter++;
  const nodePath = parentPath ? `${parentPath}.${nodeId}` : `${nodeId}`;

  // Process children recursively
  const children = [];
  for (const child of element.childNodes) {
    if (child.nodeType === 1) { // ELEMENT_NODE
      const childTag = (child.tagName || '').toLowerCase();

      if (PASSTHROUGH_TAGS.has(childTag)) {
        for (const grandchild of child.childNodes) {
          if (grandchild.nodeType === 1) {
            const converted = convertNode(grandchild, nodePath);
            if (converted) children.push(converted);
          }
        }
      } else {
        const converted = convertNode(child, nodePath);
        if (converted) children.push(converted);
      }
    }
  }

  // Get text content
  const directText = getDirectText(element);
  const fullText = getFullText(element);
  // textContent rules:
  //   1. Direct text if present
  //   2. Full text for leaf nodes (no children)
  //   3. Full text for interactive elements (button, a, input) — these often
  //      have text in nested spans, and the resolver needs it for TEXT property matching
  const isInteractive = ['button', 'a', 'input', 'select', 'textarea'].includes(tag);
  const textContent = directText || (children.length === 0 || isInteractive ? fullText : '');

  return {
    _id: nodePath,
    tag,
    attributes: extractAttributes(element),
    textContent: textContent || '',
    fullText: fullText || '',
    children,
    computedStyles: null,
  };
}

/**
 * Parse an HTML string into a flat array of top-level UI nodes.
 *
 * @param {string} html — rendered HTML string
 * @param {Object} [options]
 * @param {boolean} [options.flat=false] — if true, return only direct children of body
 * @param {number}  [options.maxDepth=20] — maximum nesting depth to prevent infinite recursion
 * @returns {Array} parsed nodes in Mimic format
 */
export function parseHTML(html, options = {}) {
  _nodeIdCounter = 0; // Reset for deterministic IDs

  const root = parseHtml(html, {
    lowerCaseTagName: true,
    comment: false,
    fixNestedATags: true,
    parseNoneClosedTags: true,
  });

  // Find the body element (or use root if no body)
  let body = root.querySelector('body') || root;

  // Convert all direct children of body
  const nodes = [];
  for (const child of body.childNodes) {
    if (child.nodeType === 1) { // ELEMENT_NODE
      const tag = (child.tagName || '').toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;

      if (PASSTHROUGH_TAGS.has(tag)) {
        // Flatten passthrough containers
        for (const grandchild of child.childNodes) {
          if (grandchild.nodeType === 1) {
            const converted = convertNode(grandchild);
            if (converted) nodes.push(converted);
          }
        }
      } else {
        const converted = convertNode(child);
        if (converted) nodes.push(converted);
      }
    }
  }

  return nodes;
}

/**
 * Parse HTML and return a summary for quick inspection.
 */
export function parseHTMLSummary(html) {
  const nodes = parseHTML(html);

  function countNodes(nodeList) {
    let count = 0;
    for (const n of nodeList) {
      count++;
      if (n.children) count += countNodes(n.children);
    }
    return count;
  }

  const totalNodes = countNodes(nodes);
  const topLevelTags = nodes.map(n => n.tag);

  return {
    topLevelCount: nodes.length,
    totalNodes,
    topLevelTags,
  };
}
