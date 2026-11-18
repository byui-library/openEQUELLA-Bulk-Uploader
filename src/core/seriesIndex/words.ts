// src/core/seriesIndex/words.ts
// Imports nothing: the sandboxed renderer uses it as well as the CLI.

/** "1 volume", "2 volumes" -- a count with the template's own word for it. */
export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * How many items "not in the series" are named; the rest are counted. A
 * narrowed search may still bring back thousands, and a list that long
 * hides the held-back volumes beside it.
 */
export const NOT_IN_SERIES_SHOWN = 20;

/** "...and 3 more." when `total` passes the cap, else nothing. */
export const andMore = (total: number, shown = NOT_IN_SERIES_SHOWN): string =>
  total > shown ? `...and ${total - shown} more.` : '';

/**
 * What is known of the index item already in openEQUELLA, as far as anything
 * needs to SAY it. `publish.ts#ExistingIndex` fits it; so does the desktop's
 * preview, which carries no uuids to the renderer.
 */
export type ExistingView =
  | { kind: 'none' }
  | { kind: 'one'; status: string }
  | { kind: 'many'; items: readonly { name: string }[] }
  | { kind: 'unavailable'; reason: string };

/**
 * The one wording for the existing index item: the CLI prints `text`, the
 * desktop shows it (escaped) with `tone` as its class, and an upload refused
 * for it throws it. The desktop renders 'none' as a Draft/Publish choice instead.
 */
export function existingNote(e: ExistingView): { tone: 'note' | 'error'; text: string } {
  switch (e.kind) {
    case 'none':
      return { tone: 'note', text: 'Creates a new index item.' };
    case 'one':
      return { tone: 'note', text: `Updates the existing index item, which stays ${e.status}.` };
    case 'many':
      return {
        tone: 'error',
        text:
          `Cannot upload: ${e.items.length} items carry this index's identifier ` +
          `(${e.items.map((i) => i.name).join(', ')}). Remove the extra ones in openEQUELLA, then build again.`,
      };
    case 'unavailable':
      return { tone: 'error', text: `Cannot upload: ${e.reason}` };
  }
}
