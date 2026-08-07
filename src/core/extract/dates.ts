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
 *
 * Both ends are anchored. Without a digit boundary after the year,
 * `January 11 12345` yielded "January 11 1234" -- a year of 1234, which
 * normalises cleanly and so would never have been flagged. The same OCR that
 * produced `01104/2024` and `04[031.193:5` makes a five-digit run routine
 * rather than hypothetical.
 */
const MONTH =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const DATE = `\\b${MONTH}\\s+\\d{1,2}\\s*,?\\s*\\d{4}(?!\\d)`;

/** How far past a phrase a date may sit and still belong to it. */
const WINDOW = 80;

/**
 * How much may separate the two halves of a name-and-dates line.
 *
 * No letter, digit, sentence terminator or line terminator may appear between
 * them, so a dash, a space, or the debris OCR leaves all qualify, while two
 * dates in separate sentences do not.
 *
 * Excluding only letters and digits was not enough: a full stop and two
 * newlines are three characters, well inside the gap, so
 * `He was born on June 19, 1957.\n\nJanuary 6, 2024 funeral services` paired a
 * BIRTH date with a FUNERAL date -- the same failure the pattern above
 * memorialises, Dean Ritchie's funeral reported as his death, arriving by
 * another route.
 */
const PAIR_GAP = 12;

/**
 * Every distinct date the phrases find, in the order encountered.
 *
 * More than one means the document states several dates near these phrases,
 * and an obituary very often does -- "preceded in death by his wife Ruth, who
 * passed away on March 2, 1998" sits in almost every one of them. There is no
 * reliable way to tell whose death a sentence describes, so this reports what
 * it found rather than choosing, and the caller flags the row.
 *
 * Phrases are tried in order, so the profile's ordering is its preference.
 * Looks only forwards: "January 4, 2024 was the year he died" must not yield a
 * date for the phrase "died".
 */
export function datesNear(text: string, phrases: readonly string[]): string[] {
  const haystack = text.toLowerCase();
  const found: string[] = [];
  for (const phrase of phrases) {
    const needle = phrase.toLowerCase();
    // EVERY occurrence, not just the first. "died" often appears in a heading
    // before it appears in the sentence that carries the date, and stopping at
    // the first would report nothing while the answer sat further down.
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
      // "died" is a substring of "studied", and this is an alumni collection
      // where "studied at Ricks College" is near-certain to appear. A raw
      // substring search read a man's MARRIAGE date as his date of death.
      const before = at === 0 ? '' : (haystack[at - 1] ?? '');
      const after = haystack[at + needle.length] ?? '';
      if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;

      const from = at + needle.length;
      const hit = new RegExp(DATE, 'i').exec(text.slice(from, from + WINDOW));
      // Two phrases reaching the same date state one fact, not two.
      if (hit && !found.includes(hit[0])) found.push(hit[0]);
    }
  }
  return found;
}

/**
 * The first date following any of `phrases`, within `WINDOW` characters.
 *
 * Callers that must not carry a wrong date should use `datesNear` and flag
 * anything that returns more than one; this keeps the single-value shape for
 * those that only ever want a best guess.
 */
export function dateNear(text: string, phrases: readonly string[]): string {
  return datesNear(text, phrases)[0] ?? '';
}

/**
 * One half of a name-and-dates line: `June 19, 1957 - January 6, 2024`.
 *
 * Four of ten real obituaries state the dates this way, with no phrase at all
 * to anchor on, so `dateNear` cannot see them. The two are combined by the
 * profile's ordered source list, not by either knowing about the other.
 */
export function datePair(text: string, which: 'first' | 'second'): string {
  const pair = new RegExp(`(${DATE})[^A-Za-z0-9.\\n\\r]{0,${PAIR_GAP}}(${DATE})`, 'i').exec(text);
  if (!pair) return '';
  return (which === 'first' ? pair[1] : pair[2]) ?? '';
}
