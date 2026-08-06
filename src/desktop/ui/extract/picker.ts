// src/desktop/ui/extract/picker.ts

/**
 * Schema paths the operator may still add: everything valid, minus what is
 * already a column, narrowed by a search box. Sorted, because a hundred and
 * fifty-eight paths in schema order is a list nobody can scan.
 */
/**
 * Which schema a path belongs to, and in what order those schemas are offered.
 *
 * MWDL first because it holds the descriptive fields nearly every item needs --
 * the item's name comes from `MWDL/title` and its description from
 * `MWDL/description`. BYUI_extended is the larger set (98 paths against MWDL's
 * 34) but is local extension: specialised, and rarely the field someone is
 * looking for first.
 *
 * Sorting the paths plainly put all 98 BYUI_extended entries ahead of MWDL,
 * which pushed `MWDL/title` past the end of the rendered list entirely. It was
 * not merely inconvenient, it was unreachable by scrolling.
 */
const SCHEMA_ORDER = ['MWDL', 'BYUI_extended'];

function schemaOf(path: string): string {
  return path.split('/')[0] ?? path;
}

function rank(path: string): number {
  const index = SCHEMA_ORDER.indexOf(schemaOf(path));
  return index === -1 ? SCHEMA_ORDER.length : index;
}

export function availablePaths(all: string[], used: string[], query: string): string[] {
  const taken = new Set(used);
  const needle = query.trim().toLowerCase();
  return all
    .filter((p) => !taken.has(p))
    .filter((p) => needle === '' || p.toLowerCase().includes(needle))
    .sort((a, b) => {
      const byGroup = rank(a) - rank(b);
      if (byGroup !== 0) return byGroup;
      // Named schemas outside SCHEMA_ORDER still group together rather than
      // interleaving, so the list reads as sections even without headings.
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
