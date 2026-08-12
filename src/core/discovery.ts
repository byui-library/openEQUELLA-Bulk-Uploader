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
