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
 * A collection's display label, from whatever shape the response put it in.
 *
 * `CollectionBean.name` (swagger.json) is typed only as `I18NString`, which is
 * itself documented as a bare `{ type: "object" }` -- no shape at all. In
 * practice openEQUELLA's REST responses serialise it as a plain string already
 * resolved to the session's locale; this defensively also accepts an
 * `I18NStrings`-shaped object (`{ strings: { [locale]: string } }`) in case a
 * deployment does something else, and falls back to the uuid rather than
 * letting a missing display label crash a caller over what is, worst case,
 * cosmetic.
 *
 * It lives here rather than in client.ts because BOTH readers of a collection
 * response need it and there must be exactly one of it: `client.getCollection`
 * imports it, and `parseCollections` below applies it to every list entry.
 */
export function displayName(name: unknown, fallback: string): string {
  if (typeof name === 'string' && name) return name;
  if (name && typeof name === 'object') {
    const strings = (name as { strings?: Record<string, string> }).strings;
    if (strings) {
      const first = Object.values(strings).find((v) => typeof v === 'string' && v);
      if (first) return first;
    }
  }
  return fallback;
}

/**
 * Read `GET /api/collection?privilege=CREATE_ITEM&full=true`.
 *
 * THE ONLY PARSER FOR THIS RESPONSE. `client.listCollections` used to have a
 * second, inline one that read the same body and dropped `schema.uuid` on the
 * floor -- so the one fact that turns a chosen collection into its schema in a
 * single hop was thrown away at exactly the call site that needed it. Two
 * parsers for one endpoint is two places for a field to go missing; this is
 * the one.
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
      name: displayName(row.name, row.uuid),
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
