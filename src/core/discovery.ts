//
// Pure parsing of openEQUELLA's collection and schema responses. Nothing here
// fetches: the caller owns the request so this stays testable against recorded
// fixtures, which is how every response shape in this codebase has been pinned
// down. See tests/fixtures/api/, recorded from content.byui.edu 2026-08-12.

export interface CollectionSummary {
  uuid: string;
  name: string;
  /** From the list entry itself -- see parseCollections. '' when undeclared. */
  schemaUuid: string;
}

/**
 * Read `GET /api/collection?privilege=CREATE_ITEM&full=true`.
 *
 * Each entry carries `schema: { uuid }`, so choosing a collection also
 * determines its schema with no further request. That was verified by probe,
 * not assumed.
 *
 * An empty list is a legitimate answer meaning "this account can create
 * nothing", so it is returned rather than thrown. Entries missing a uuid are
 * dropped: an option that cannot be selected is worse than an absent one.
 */
export function parseCollections(body: unknown): CollectionSummary[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const collections: CollectionSummary[] = [];
  for (const entry of results) {
    const row = entry as { uuid?: unknown; name?: unknown; schema?: { uuid?: unknown } };
    if (typeof row?.uuid !== 'string' || !row.uuid) continue;
    collections.push({
      uuid: row.uuid,
      name: typeof row.name === 'string' && row.name ? row.name : row.uuid,
      schemaUuid: typeof row.schema?.uuid === 'string' ? row.schema.uuid : '',
    });
  }
  return collections.sort((a, b) => a.name.localeCompare(b.name));
}

export interface SchemaInfo {
  uuid: string;
  /** As declared, with a leading slash: `/MWDL/title`. Null if undeclared. */
  namePath: string | null;
  /** The same path in spreadsheet-header form: `MWDL/title`. Null if undeclared. */
  titleHeader: string | null;
  /** Every valid xpath, leaves only, in spreadsheet-header form. */
  paths: Set<string>;
}

/**
 * Read `GET /api/schema/{uuid}`.
 *
 * THE NAME PATH IS THE POINT. An openEQUELLA schema declares which node
 * becomes an item's name. This tool used to hardcode `MWDL/title` -- correct
 * for BYU-Idaho only because that is what BYUI's schema happens to declare,
 * and wrong everywhere else. Duplicate detection matches on this path, so a
 * wrong value makes every row report clean from a check that never looked.
 *
 * When no path is declared this returns null and does NOT fall back to a
 * guess. See findDuplicates: undeclared means "could not check", never
 * "clean".
 *
 * The REST field is `namePath`; the XML export spells the same thing
 * `itemNamePath`. Both are accepted so a caller can pass either source.
 */
export function parseSchema(body: unknown): SchemaInfo {
  const raw = body as {
    uuid?: unknown;
    namePath?: unknown;
    itemNamePath?: unknown;
    definition?: unknown;
  } | null;
  const declared =
    typeof raw?.namePath === 'string' && raw.namePath
      ? raw.namePath
      : typeof raw?.itemNamePath === 'string' && raw.itemNamePath
        ? raw.itemNamePath
        : null;

  // Paths live under an `xml` root node; `namePath` omits it, and so do
  // spreadsheet headers. Walking from `definition` itself would prefix
  // everything with `xml/`.
  const root = (raw?.definition as { xml?: unknown } | undefined)?.xml;

  const paths = new Set<string>();
  collectLeaves(root, '', paths);

  return {
    uuid: typeof raw?.uuid === 'string' ? raw.uuid : '',
    namePath: declared,
    titleHeader: declared ? declared.replace(/^\/+/, '') : null,
    paths,
  };
}

/**
 * Walk the definition tree into `a/b/c` leaf paths, matching the form
 * `parseSchemaPaths` produces from the XML export so the two sources are
 * interchangeable downstream.
 *
 * Leaves only: a node with children is a container, and openEQUELLA cannot
 * store a value at one. Emitting containers would offer an operator a column
 * header whose upload fails.
 *
 * `@x` is an attribute and IS addressable, contributing the segment `x`.
 * `_x` is node metadata (`_type`, `_indexed`, `_field`) and is not a path.
 */
function collectLeaves(node: unknown, prefix: string, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  const children = Object.keys(node as Record<string, unknown>).filter((k) => !k.startsWith('_'));
  if (children.length === 0) {
    if (prefix) out.add(prefix);
    return;
  }
  for (const key of children) {
    const segment = key.startsWith('@') ? key.slice(1) : key;
    collectLeaves(
      (node as Record<string, unknown>)[key],
      prefix ? `${prefix}/${segment}` : segment,
      out,
    );
  }
}
