// src/core/extract/names.ts

/**
 * What counts as part of a word, on BOTH sides of the comparison: the class
 * the filename is split on below, and the class a match in the document may
 * not be flanked by. Keeping the two halves identical is the point -- an
 * apostrophe is part of a filename word ("O'Brien"), so it has to be part of a
 * document word too, or the two sides would disagree about where words end.
 *
 * Every character in the class is a regex literal, so a word cut out by the
 * split can never carry a metacharacter into the pattern built from it.
 */
const WORD_CHARS = "A-Za-z0-9'";
const WORD_CHAR = `[${WORD_CHARS}]`;
const NOT_WORD_CHAR = `[^${WORD_CHARS}]`;

/**
 * True when `word` appears in `haystack` as a whole word.
 *
 * A plain `haystack.includes(word)` was the original implementation and it
 * contradicted everything this file says about whole words: it counted "Ann"
 * as present in a document whose only "ann" was inside "Anniversary", so a
 * filename that genuinely disagreed with its document was never flagged. The
 * check exists precisely to catch that disagreement.
 */
function containsWholeWord(haystack: string, word: string): boolean {
  return new RegExp(`(?<!${WORD_CHAR})${word}(?!${WORD_CHAR})`, 'i').test(haystack);
}

/**
 * Words in the filename that the document does not contain.
 *
 * A real file was named "Alden Larkspar Obituary.pdf" while the obituary said
 * "Larkspur" throughout. The filename becomes the item's permanent title, so
 * that misspelling would have been catalogued and never noticed.
 *
 * WHOLE WORDS, not the whole name. "Marcus Fennel" never appears contiguously
 * in its own document -- the text reads "Marcus T Fennel" -- so requiring the
 * full name would flag nine of ten real files. Checking each word separately
 * flagged exactly one, the one that deserved it.
 *
 * Whole in the document too, which this did not used to be: a substring test
 * found "Ann" inside "Anniversary" and reported nothing.
 *
 * It survives OCR damage for the same reason: middle names came out as
 * `!;ennick`, `E>or1an` and `olwyn`, and none is a filename word, so none is
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

  const skip = new Set(ignore.map((w) => w.toLowerCase()));

  return filename
    .replace(/\.[^.\\/]+$/, '')
    .split(new RegExp(`${NOT_WORD_CHAR}+`))
    .filter((word) => word.length > 1 && !skip.has(word.toLowerCase()))
    .filter((word) => !containsWholeWord(text, word));
}
