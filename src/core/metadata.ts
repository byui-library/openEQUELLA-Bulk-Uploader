interface Node {
  children: Map<string, Node>;
  /** Terminal values at this path. Multiple values become sibling elements. */
  values: string[];
}

const newNode = (): Node => ({ children: new Map(), values: [] });

/**
 * Escapes the five predefined XML entities. `'` -> `&apos;` is technically
 * only required inside single-quoted attribute values (never in element text
 * or in double-quoted attributes), and this module emits no attributes at
 * all — but escaping it unconditionally is cheap, always valid here, and
 * keeps this function a total, context-free escaper rather than one that has
 * to know where its output will land. That matters because it makes the
 * round-trip property (escape then parse recovers the original string)
 * trivially true for every character, including a literal apostrophe in a
 * name like "O'Brien".
 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function render(name: string, node: Node): string {
  // A node carrying values is terminal; emit one element per value.
  if (node.values.length > 0) {
    return node.values
      .map((v) => (v === '' ? `<${name}/>` : `<${name}>${escapeXml(v)}</${name}>`))
      .join('');
  }
  const inner = [...node.children].map(([k, child]) => render(k, child)).join('');
  return inner === '' ? `<${name}/>` : `<${name}>${inner}</${name}>`;
}

/**
 * Build openEQUELLA item metadata from xpath-keyed values.
 *
 * Insertion order of the input determines element order, so the output follows
 * the spreadsheet's column order. Blank values emit empty tags, matching what
 * the openEQUELLA wizard produces.
 */
export function buildMetadataXml(fields: Record<string, string[]>): string {
  const root = newNode();
  for (const [xpath, values] of Object.entries(fields)) {
    let cursor = root;
    for (const segment of xpath.split('/').filter(Boolean)) {
      let next = cursor.children.get(segment);
      if (!next) {
        next = newNode();
        cursor.children.set(segment, next);
      }
      cursor = next;
    }
    cursor.values.push(...values);
  }
  const inner = [...root.children].map(([k, child]) => render(k, child)).join('');
  return `<xml>${inner}</xml>`;
}
