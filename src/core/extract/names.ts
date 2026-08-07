// src/core/extract/names.ts

/**
 * Words in the filename that the document does not contain.
 *
 * A real file was named "Brandon Lythoe Obituary.pdf" while the obituary said
 * "Lythgoe" throughout. The filename becomes the item's permanent title, so
 * that misspelling would have been catalogued and never noticed.
 *
 * WHOLE WORDS, not the whole name. "Clyde Williams" never appears contiguously
 * in its own document -- the text reads "Clyde L Williams" -- so requiring the
 * full name would flag nine of ten real files. Checking each word separately
 * flagged exactly one, the one that deserved it.
 *
 * It survives OCR damage for the same reason: middle names came out as
 * `!;eland`, `E>av1d` and `louther`, and none is a filename word, so none is
 * ever tested.
 *
 * `ignore` is supplied by the profile rather than known here -- "Obituary" is
 * meaningless to this function and specific to one collection.
 */
export function missingFilenameWords(
  filename: string,
  text: string,
  ignore: readonly string[],
): string[] {
  // A document with no text is already reported by buildRow's own note.
  // Listing every word as missing too would bury that under noise.
  if (text.trim() === '') return [];

  const haystack = text.toLowerCase();
  const skip = new Set(ignore.map((w) => w.toLowerCase()));

  return filename
    .replace(/\.[^.\\/]+$/, '')
    .split(/[^A-Za-z0-9']+/)
    .filter((word) => word.length > 1 && !skip.has(word.toLowerCase()))
    .filter((word) => !haystack.includes(word.toLowerCase()));
}
