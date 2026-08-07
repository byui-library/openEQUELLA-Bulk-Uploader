// src/core/extract/dates.ts

/**
 * A date written in words: "January 9, 2024".
 *
 * Deliberately tolerant of whitespace around the comma, and of the comma being
 * absent. OCR of a scanned newspaper clipping produced `January 11 , 2024`,
 * and the first version of this pattern missed it -- which made the tool
 * report that man's FUNERAL date as his date of death.
 *
 * Spelled-out dates are used rather than the numeric ones these documents also
 * carry, because letters survive OCR far better than digits: the same batch
 * yielded `04[031.193:5` for 3 April 1935 and `0:1` for a death date, while
 * every spelled date came through clean. Reading the prose took recovery from
 * 3 of 10 files to 9 of 10.
 */
const MONTH =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const DATE = `${MONTH}\\s+\\d{1,2}\\s*,?\\s*\\d{4}`;

/** How far past a phrase a date may sit and still belong to it. */
const WINDOW = 80;

/**
 * How much may separate the two halves of a name-and-dates line.
 *
 * No letter or digit may appear between them, so a dash, a space, or the
 * debris OCR leaves all qualify, while two dates in separate sentences do not.
 */
const PAIR_GAP = 12;

/**
 * The first date following any of `phrases`, within `WINDOW` characters.
 *
 * Phrases are tried in order, so the profile's ordering is its preference.
 * Looks only forwards: "January 4, 2024 was the year he died" must not yield a
 * date for the phrase "died".
 */
export function dateNear(text: string, phrases: readonly string[]): string {
  const haystack = text.toLowerCase();
  for (const phrase of phrases) {
    const needle = phrase.toLowerCase();
    // EVERY occurrence, not just the first. "died" often appears in a heading
    // before it appears in the sentence that carries the date, and stopping at
    // the first would report nothing while the answer sat further down.
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
      const from = at + needle.length;
      const found = new RegExp(DATE, 'i').exec(text.slice(from, from + WINDOW));
      if (found) return found[0];
    }
  }
  return '';
}

/**
 * One half of a name-and-dates line: `June 19, 1957 - January 6, 2024`.
 *
 * Four of ten real obituaries state the dates this way, with no phrase at all
 * to anchor on, so `dateNear` cannot see them. The two are combined by the
 * profile's ordered source list, not by either knowing about the other.
 */
export function datePair(text: string, which: 'first' | 'second'): string {
  const pair = new RegExp(`(${DATE})[^A-Za-z0-9]{0,${PAIR_GAP}}(${DATE})`, 'i').exec(text);
  if (!pair) return '';
  return (which === 'first' ? pair[1] : pair[2]) ?? '';
}
