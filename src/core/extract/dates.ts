// src/core/extract/dates.ts

/**
 * The month vocabulary, as a list so a second recogniser can be built from the
 * SAME names rather than from a second copy of them.
 *
 * `core/ai/verify.ts` needs one -- it must find every date a document states,
 * anywhere, rather than the one date following a phrase -- and the two have
 * opposite cost asymmetries, so they are deliberately not the same pattern: a
 * WRONG date here would be written into a catalogue as fact, while a MISSED
 * date there refuses a description that was correct. What must never differ is
 * the vocabulary, because a month one recogniser knows and the other does not
 * is a disagreement about whether a document states a date at all.
 */
export const MONTH_NAMES: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const MONTH = `(?:${MONTH_NAMES.join('|')})`;

/**
 * A date written in words: "March 5, 2019".
 *
 * Deliberately tolerant of whitespace around the comma, and of the comma being
 * absent. OCR of a scanned newspaper clipping put a space before the comma, and
 * the first version of this pattern missed it -- which made the tool report a
 * man's FUNERAL date as his date of death.
 *
 * Spelled-out dates are used rather than the numeric ones these documents also
 * carry, because letters survive OCR far better than digits: in the same batch
 * a numeric birth date came back as an unreadable run of digits and brackets
 * and a numeric death date as two characters, while every spelled date came
 * through clean. Reading the prose took recovery from 3 of 10 files to 9 of 10.
 *
 * Both ends are anchored. Without a digit boundary after the year,
 * `February 11 12345` yielded "February 11 1234" -- a year of 1234, which
 * normalises cleanly and so would never have been flagged. OCR that mangles a
 * numeric date into a longer digit run makes that routine rather than
 * hypothetical.
 *
 * NO EXAMPLE HERE IS QUOTED FROM A SOURCE DOCUMENT. The garbled strings this
 * docblock used to reproduce were verbatim OCR of a real scanned obituary, and
 * one of them was annotated with the real birth date it decoded to. A real date
 * under an invented name still identifies someone, and this repository is
 * public. See the convention in CLAUDE.md.
 */
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
 * `He was born on April 5, 1954.\n\nOctober 2, 2019 funeral services` paired a
 * BIRTH date with a FUNERAL date -- the same failure the pattern above
 * memorialises, Hollis Bracken's funeral reported as his death, arriving by
 * another route.
 */
const PAIR_GAP = 12;

/**
 * The sentence terminators the gap above refuses, as regex-class contents.
 *
 * The rule was always stated as "no sentence terminator", but the class named
 * only the full stop, so a sentence ending in `!` or `?` reopened the very hole
 * the paragraph-break case closes: `...from April 5, 1954! October 2, 2019`
 * paired a BIRTH date with an unrelated later one. Widened to match what the
 * rule has always claimed, rather than narrowing the claim to match the code --
 * these documents are eulogies, and an exclamation mark is at home in one.
 */
const SENTENCE_END = '.!?';

/**
 * Every distinct date the phrases find, in the order encountered.
 *
 * More than one means the document states several dates near these phrases,
 * and an obituary very often does -- "preceded in death by his wife Ivy, who
 * passed away on November 8, 1994" sits in almost every one of them. There is no
 * reliable way to tell whose death a sentence describes, so this reports what
 * it found rather than choosing, and the caller flags the row.
 *
 * Phrases are tried in order, so the profile's ordering is its preference.
 * Looks only forwards: "September 8, 2019 was the year he died" must not yield a
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
 * One half of a name-and-dates line: `April 5, 1954 - October 2, 2019`.
 *
 * Four of ten real obituaries state the dates this way, with no phrase at all
 * to anchor on, so `dateNear` cannot see them. The two are combined by the
 * profile's ordered source list, not by either knowing about the other.
 */
export function datePair(text: string, which: 'first' | 'second'): string {
  const pair = new RegExp(
    `(${DATE})[^A-Za-z0-9${SENTENCE_END}\\n\\r]{0,${PAIR_GAP}}(${DATE})`,
    'i',
  ).exec(text);
  if (!pair) return '';
  return (which === 'first' ? pair[1] : pair[2]) ?? '';
}
