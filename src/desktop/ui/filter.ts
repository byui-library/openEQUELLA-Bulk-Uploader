import type { CollectionSummary } from '../../core/client.js';

/**
 * Filters and sorts collections for the Choose screen's search box.
 *
 * Verified against production: `listCollections` returns 29 collections in
 * whatever order the server hands them back, with entries like "Sample" and
 * "Web Utilities" ahead of anything a real user is looking for. Sorting by
 * name is unconditional -- it applies even to an empty query -- so the box
 * degrades gracefully to "just a sorted list" rather than showing nothing
 * until the user types.
 */
export function filterCollections(
  collections: readonly CollectionSummary[],
  query: string,
): CollectionSummary[] {
  const q = query.trim().toLowerCase();
  const matches = q === '' ? collections : collections.filter((c) => c.name.toLowerCase().includes(q));
  return [...matches].sort((a, b) => a.name.localeCompare(b.name));
}
