// src/desktop/ui/extract/picker.ts

/**
 * Schema paths the operator may still add: everything valid, minus what is
 * already a column, narrowed by a search box. Sorted, because a hundred and
 * fifty-eight paths in schema order is a list nobody can scan.
 */
export function availablePaths(all: string[], used: string[], query: string): string[] {
  const taken = new Set(used);
  const needle = query.trim().toLowerCase();
  return all
    .filter((p) => !taken.has(p))
    .filter((p) => needle === '' || p.toLowerCase().includes(needle))
    .sort((a, b) => a.localeCompare(b));
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
