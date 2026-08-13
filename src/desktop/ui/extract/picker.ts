// src/desktop/ui/extract/picker.ts

/**
 * Schema paths the operator may still add: everything valid, minus what is
 * already a column, narrowed by a search box. Sorted, because a hundred and
 * fifty-eight paths in schema order is a list nobody can scan.
 */
/**
 * Which schema a path belongs to, and in what order those schemas are offered.
 *
 * The leading section is DERIVED from the schema's own declared name path: the
 * section holding it (`/MWDL/title` -> `MWDL`) is the descriptive one nearly
 * every item needs, and the rest follow alphabetically. This used to be a
 * hardcoded `['MWDL', 'BYUI_extended']` -- correct at one institution, and
 * simply not matching anywhere else, where the order silently fell back to
 * alphabetical.
 *
 * The order matters, and not only cosmetically. Sorting the paths plainly put
 * all 98 of one section's entries ahead of the 34 that hold the title, the
 * creator and the date, which pushed them past the end of the rendered list
 * entirely: not merely inconvenient, unreachable by scrolling. Found by an
 * operator on the real screen.
 */
function schemaOf(path: string): string {
  return path.split('/')[0] ?? path;
}

/**
 * `namePath` is what the schema declares as the item's name, in either spelling
 * openEQUELLA uses (`/MWDL/title` from the REST field, `MWDL/title` from the
 * XML export). Null/absent -- a schema that declares none -- means there is
 * nothing to lead with, and the grouping is plainly alphabetical rather than a
 * guess about which section matters.
 */
export function availablePaths(
  all: string[],
  used: string[],
  query: string,
  namePath?: string | null,
): string[] {
  const leading = namePath ? schemaOf(namePath.replace(/^\/+/, '')) : '';
  const taken = new Set(used);
  const needle = query.trim().toLowerCase();
  return all
    .filter((p) => !taken.has(p))
    .filter((p) => needle === '' || p.toLowerCase().includes(needle))
    .sort((a, b) => {
      const rank = (p: string): number => (leading !== '' && schemaOf(p) === leading ? 0 : 1);
      const byGroup = rank(a) - rank(b);
      if (byGroup !== 0) return byGroup;
      // Every other schema still groups together rather than interleaving, so
      // the list reads as sections even without headings.
      const bySchema = schemaOf(a).localeCompare(schemaOf(b));
      return bySchema !== 0 ? bySchema : a.localeCompare(b);
    });
}

export interface PathGroup {
  schema: string;
  paths: string[];
}

/**
 * Split an already-ordered list into its schema groups, so the picker can put a
 * heading above each one. Order is preserved exactly -- this only inserts the
 * boundaries, it never re-sorts.
 */
export function groupPaths(paths: string[]): PathGroup[] {
  const groups: PathGroup[] = [];
  for (const path of paths) {
    const schema = schemaOf(path);
    const last = groups.at(-1);
    if (last !== undefined && last.schema === schema) last.paths.push(path);
    else groups.push({ schema, paths: [path] });
  }
  return groups;
}

/**
 * A readable name for an xpath, shown beside the path itself rather than
 * instead of it -- the path is what the spreadsheet header must literally say,
 * so hiding it would make the column list impossible to check against a
 * spreadsheet.
 */
export function plainLabel(path: string): string {
  const last = path.split('/').pop() ?? path;
  const spaced = last
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
