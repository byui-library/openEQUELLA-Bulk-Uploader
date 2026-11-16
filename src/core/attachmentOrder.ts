// src/core/attachmentOrder.ts

/**
 * THE `attachment order` cell, both halves in one module.
 *
 * The extractor WRITES a folder's order into the spreadsheet, `plan` READS it
 * back, and the desktop Review screen reorders against the same rule. Split
 * across three files -- a join in csv.ts, a split-and-trim in plan.ts, and the
 * extractor re-deriving which names the split could survive -- a change to
 * one half would have had the builder write lists the planner refuses. The
 * same reasoning as formulaGuard.ts: an encoding and its decoding live
 * together, with a round trip pinned in a test.
 *
 * PURE AND RENDERER-SAFE: no `node:` import, so the sandboxed Review screen
 * matches orders with exactly the rule the upload applies.
 */

/** What separates file names in the cell. Written with a space after it, for reading. */
export const ORDER_SEPARATOR = ';';

/** A folder's file names as the cell holds them. */
export function formatAttachmentOrder(names: readonly string[]): string {
  return names.join(`${ORDER_SEPARATOR} `);
}

/** The file names a cell lists; an empty list for a blank cell, which means name order. */
export function parseAttachmentOrder(cell: string): string[] {
  return cell
    .split(ORDER_SEPARATOR)
    .map((n) => n.trim())
    .filter((n) => n !== '');
}

/**
 * Whether a file name survives a trip through the cell. A name holding the
 * separator would be split, and one starting or ending with a space would be
 * trimmed -- either way `plan` could no longer match it.
 */
export function canWriteInOrder(name: string): boolean {
  return !name.includes(ORDER_SEPARATOR) && name.trim() === name;
}

/** Why `canWriteInOrder` refuses a name, in the words an operator reads -- kept beside the rule. */
export const UNWRITABLE_REASON = `contains '${ORDER_SEPARATOR}' or starts or ends with a space`;

/**
 * `listed` in the order `wanted` names them, or why that cannot be done. ONE
 * rule for every way an order arrives -- the spreadsheet cell and the Review
 * screen's arrows -- so neither can accept a list the other would refuse.
 *
 * Names match EXACTLY first, then case-blind, but only where the case-blind
 * spelling is unambiguous: on a case-sensitive disk `Scan.pdf` and `scan.pdf`
 * are two files, and a lowercase key alone would merge them and refuse every
 * order naming both. The folder's own spelling is what is kept. Every stray,
 * repeat and omission is reported at once, so one edit fixes it.
 */
export function reorderFiles<F extends { name: string }>(
  listed: readonly F[],
  wanted: readonly string[],
): { files: F[] } | { problem: string } {
  const exact = new Map(listed.map((f) => [f.name, f]));
  const byLower = new Map<string, F | null>();
  for (const f of listed) {
    const key = f.name.toLowerCase();
    byLower.set(key, byLower.has(key) ? null : f);
  }
  const files: F[] = [];
  const strays: string[] = [];
  const repeats: string[] = [];
  const seen = new Set<F>();
  for (const name of wanted) {
    const file = exact.get(name) ?? byLower.get(name.toLowerCase()) ?? undefined;
    if (file === undefined) strays.push(name);
    else if (seen.has(file)) repeats.push(name);
    else {
      seen.add(file);
      files.push(file);
    }
  }
  const missing = listed.filter((f) => !seen.has(f)).map((f) => f.name);

  const problems = [
    ...(strays.length > 0 ? [`not in the folder: ${strays.join(', ')}`] : []),
    ...(repeats.length > 0 ? [`listed twice: ${[...new Set(repeats)].join(', ')}`] : []),
    ...(missing.length > 0 ? [`missing from the order: ${missing.join(', ')}`] : []),
  ];
  return problems.length > 0 ? { problem: problems.join('; ') } : { files };
}
