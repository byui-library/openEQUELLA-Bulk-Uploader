import { ValidationError } from './errors.js';

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
    // A lone blank legitimately means "this optional field is empty" and
    // must still render as a self-closing tag. A blank inside a multi-value
    // list, though, is a spreadsheet-shape artifact (e.g. a ragged row), not
    // a real repeated element, so it's dropped — unless every value is
    // blank, in which case there's nothing left to distinguish it from the
    // lone-blank case, and it renders the same self-closing way.
    const rendered =
      node.values.length > 1 ? node.values.filter((v) => v !== '') : node.values;
    if (rendered.length === 0) return `<${name}/>`;
    return rendered
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
 *
 * `schema.ts#validateHeaders` normally guarantees every header is a leaf
 * xpath, which rules out a node ever needing to hold both a value and
 * children. This function has no caller-enforced guarantee of that, though
 * (it's plain core logic, not aware of who calls it), so it detects the
 * conflict itself — a node ending up with both a value and a longer path
 * beneath it — and throws rather than silently dropping one side. The
 * conflict can arise in either insertion order: the shorter path's value can
 * arrive before or after the longer path's descendants, so both directions
 * are checked.
 */
export function buildMetadataXml(fields: Record<string, string[]>): string {
  const root = newNode();
  for (const [xpath, values] of Object.entries(fields)) {
    let cursor = root;
    let pathSoFar = '';
    for (const segment of xpath.split('/').filter(Boolean)) {
      pathSoFar = pathSoFar ? `${pathSoFar}/${segment}` : segment;
      let next = cursor.children.get(segment);
      if (!next) {
        next = newNode();
        cursor.children.set(segment, next);
      } else if (next.values.length > 0) {
        // The node we're about to descend into already has a value from an
        // earlier (shorter) xpath, e.g. 'MWDL/creators' was set before
        // 'MWDL/creators/creator' is now trying to add a child beneath it.
        throw new ValidationError(
          `Conflicting metadata paths: '${pathSoFar}' has a value but is also a parent of '${xpath}'`,
        );
      }
      cursor = next;
    }
    cursor.values.push(...values);
    if (cursor.children.size > 0) {
      // The reverse order: this xpath's value arrives after a longer xpath
      // already populated children beneath it.
      const [firstChild] = cursor.children.keys();
      throw new ValidationError(
        `Conflicting metadata paths: '${xpath}' has a value but is also a parent of '${xpath}/${firstChild}'`,
      );
    }
  }
  const inner = [...root.children].map(([k, child]) => render(k, child)).join('');
  return `<xml>${inner}</xml>`;
}
