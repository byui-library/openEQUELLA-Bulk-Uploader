/**
 * Best-effort deep link into openEQUELLA's collection, for the "open the
 * collection in your browser" link on the Results screen. Points at the New
 * UI's search page filtered to this collection.
 *
 * NOT verified against a live instance (unlike everything else in this
 * codebase's live-verified callouts) -- there is no established convention
 * for this link elsewhere in the repo. If it turns out to 404 or land on the
 * wrong page on a real instance, the base url on its own (already correct)
 * is still a safe fallback the user can navigate from by hand.
 */
export function collectionUrl(baseUrl: string, collectionUuid: string): string {
  return `${baseUrl}/page/search?collections=${encodeURIComponent(collectionUuid)}`;
}
