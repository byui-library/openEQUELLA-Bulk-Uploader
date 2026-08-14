// src/core/ai/verify.ts
import { MONTH_NAMES } from '../extract/dates.js';
import { normaliseDate } from '../extract/rows.js';
import type { Profile } from '../extract/types.js';

/**
 * ONE CHECKABLE CLAIM THE DOCUMENT DOES NOT SUPPORT.
 *
 * `claim` is what the MODEL said, verbatim, so the operator can find it in the
 * quoted reply. `why` is one clause, ready to follow "...: " inside a longer
 * sentence -- no leading capital, no full stop.
 */
export interface UnsupportedClaim {
  kind: 'date' | 'number' | 'assertion';
  /** What the model said. */
  claim: string;
  /** One clause, operator-facing, ready to appear after "…: ". */
  why: string;
}

/*
 * ============================================================================
 * WHY THIS MODULE EXISTS
 * ============================================================================
 *
 * The shipped prompt says, in as many words, "Use only what the document
 * states. Do not invent names, dates, places or events." Run against a real
 * batch on 2026-08-14 with a small local model, TWO OF TEN generated
 * descriptions contained fabricated facts anyway:
 *
 * - A document stating no date of any kind -- it placed the death only by
 *   season and time of day -- drew a full ISO death date. Run three times at
 *   temperature zero it produced THREE DIFFERENT DATES, so nothing is being
 *   misread: a plausibly shaped value is being generated to fill a slot.
 * - Two documents mentioning no affiliated institution had one asserted, against
 *   a profile instruction saying to include that clause only where the document
 *   says so.
 *
 * The safety architecture worked -- every cell flagged, `_source=ai`, a note
 * asking the operator to check. BUT A FLAG IS NOT A GUARD. This tool writes to a
 * permanent catalogue with no moderation workflow, and a fabricated date is
 * indistinguishable from a real one to everyone downstream, for ever.
 *
 * THE PROMPT CANNOT BE THE DEFENCE. The design's premise is "any of the major
 * LLMs including local models", so the tool cannot know how capable the model
 * behind an endpoint is, and the one it was measured against ignored the
 * instruction. The model proposes; the tool verifies.
 *
 * ============================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 * ============================================================================
 *
 * **It knows nothing about any collection.** Not what an obituary is, not what a
 * death date is, not that any institution exists. Every rule below derives from
 * the profile's own configuration and the document's own text. This repository
 * spent an entire release removing institution-specific assumptions, and its
 * CLAUDE.md records the two occasions a hardcoded value made a check silently
 * examine nothing. A list of month names is a fact about the language the prompt
 * is already written in; a list of colleges would be a fact about one library.
 *
 * **It does not check free prose.** Paraphrase is legitimate description, and
 * eight of those ten outputs were fine -- a check that read prose for support
 * would have rejected them. A FALSE REJECTION IS EXPENSIVE: it discards a good
 * description and trains the operator to distrust the check.
 *
 * **It does not check proper nouns.** Declined by the operator, and rightly: OCR
 * damage in a source makes a real name look unsupported, so the value would be
 * refused for the wrong reason. The batch this feature exists for is scanned
 * pages.
 *
 * **It does not repair.** A claim that fails refuses the WHOLE value -- see
 * `fill.ts`. Stripping the offending clause would leave a half-removed sentence
 * that reads as complete while meaning something different, and this tool does
 * not edit generated prose.
 */

type Precision = 'year' | 'month' | 'day';

const RANK: Record<Precision, number> = { year: 1, month: 2, day: 3 };

/** A date found in a piece of text, with the span it occupies so the number
 *  check can leave it alone. */
interface DateMention {
  start: number;
  end: number;
  precision: Precision;
  /**
   * Every reading of this text, normalised. More than one only for the
   * separator forms, where `6/1/2024` is two different days depending on who
   * wrote it and the text does not say which -- see `SEPARATED` below.
   */
  values: string[];
}

/**
 * The month vocabulary, widened to the abbreviations a document actually uses.
 *
 * DERIVED FROM `MONTH_NAMES` rather than written out again, so the two
 * recognisers in this codebase cannot come to know different months. Each name
 * yields its full form, its three-letter stem, and the four-letter stem that
 * makes `Sept` work -- `Jan(?:uary|u)?`, `Sep(?:tember|t)?`, `May`. A trailing
 * full stop is optional.
 *
 * THE BREADTH IS OPPOSITE TO `dates.ts`'s ON PURPOSE, and that is not a
 * disagreement between them. There, a date is being read INTO a catalogue field,
 * so a wrong one is written down as fact and the pattern is conservative. Here a
 * date is being looked for as EVIDENCE, so a form the document uses and this
 * does not see refuses a description that was correct. Missing `Jan. 6, 2024`
 * would do exactly that.
 */
const MONTH = `(?:${MONTH_NAMES.map((name) => {
  const stem = name.slice(0, 3);
  const rest = name.slice(3);
  return rest === '' ? stem : `${stem}(?:${rest}|${rest[0]!})?`;
}).join('|')})\\.?`;

/** An ordinal suffix on a day of the month: "6th", "1st". */
const ORDINAL = '(?:st|nd|rd|th)?';

/**
 * Strip what `normaliseDate` cannot read from a spelled date: the abbreviating
 * full stop, and the ordinal suffix on the day.
 *
 * `new Date('Jan. 6, 2024')` happens to work and `new Date('January 6th, 2024')`
 * does not, so both are removed rather than only the one that must be.
 */
function readable(raw: string): string {
  return raw.replace(/\./g, ' ').replace(/(\d{1,2})(?:st|nd|rd|th)\b/gi, '$1');
}

/** Everything a value can be, with nulls dropped and duplicates removed. */
function readings(...values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))];
}

/**
 * The forms a date is written in, MOST SPECIFIC FIRST.
 *
 * Order is the whole of the precision logic: a span already claimed by an
 * earlier form is not offered to a later one, so `2024-01-06` is one day and not
 * also the year 2024, and `6 January 2024` is one day and not also the month
 * January 2024.
 *
 * NOTHING GOES THROUGH `normaliseDate` THAT DOES NOT SURVIVE IT. `new
 * Date('2024-01')` is parsed as UTC midnight and read back through local date
 * parts, which yields **2023-12-31** anywhere west of UTC -- the exact trap
 * `rows.ts#ISO_DATE` exists to avoid, measured here before it was written
 * around. So the two ISO forms are taken verbatim from their own captures, and
 * `normaliseDate` is used only where a month NAME has to be turned into a
 * number, which is the part there must be exactly one of.
 */
const FORMS: {
  pattern: string;
  precision: Precision;
  values: (match: RegExpExecArray) => string[];
}[] = [
  {
    // 2024-01-06
    pattern: '\\b(\\d{4})-(\\d{2})-(\\d{2})\\b',
    precision: 'day',
    values: (m) => readings(`${m[1]}-${m[2]}-${m[3]}`),
  },
  {
    // January 6, 2024 / January 6th 2024 / Jan. 6, 2024
    pattern: `\\b${MONTH}\\s+\\d{1,2}${ORDINAL}\\s*,?\\s*\\d{4}(?!\\d)`,
    precision: 'day',
    values: (m) => readings(normaliseDate(readable(m[0]))),
  },
  {
    // 6 January 2024
    pattern: `\\b\\d{1,2}${ORDINAL}\\s+${MONTH}\\s*,?\\s*\\d{4}(?!\\d)`,
    precision: 'day',
    values: (m) => readings(normaliseDate(readable(m[0]))),
  },
  {
    /*
     * 1/6/2024, 6-1-2024.
     *
     * BOTH READINGS ARE KEPT, because the text does not say which it means and
     * this module must not guess: 6 January and 1 June are equally good
     * readings of `6/1/2024`, and picking one would refuse a supported date at
     * whichever institution writes the other way round. A claim is supported
     * when it matches EITHER, which is the permissive direction and the correct
     * one -- the model read the same ambiguous string.
     */
    pattern: '\\b(\\d{1,2})[/-](\\d{1,2})[/-](\\d{4})\\b',
    precision: 'day',
    values: (m) =>
      readings(normaliseDate(`${m[1]}/${m[2]}/${m[3]}`), normaliseDate(`${m[2]}/${m[1]}/${m[3]}`)),
  },
  {
    // 2024-01, and never the first half of 2024-01-06 -- that span is taken.
    pattern: '\\b(\\d{4})-(\\d{2})(?![\\d-])',
    precision: 'month',
    values: (m) => readings(`${m[1]}-${m[2]}`),
  },
  {
    // January 2024
    pattern: `\\b${MONTH}\\s+\\d{4}(?!\\d)`,
    precision: 'month',
    // `normaliseDate` answers at day precision -- 2024-01-01 -- for a text that
    // states no day. Cut back to what was actually written.
    values: (m) => readings(normaliseDate(readable(m[0]))?.slice(0, 7) ?? null),
  },
  {
    // 1938
    pattern: '\\b(\\d{4})\\b',
    precision: 'year',
    values: (m) => readings(m[1] ?? null),
  },
];

/** A normalised date cut back to a coarser precision. */
function truncate(value: string, precision: Precision): string {
  if (precision === 'year') return value.slice(0, 4);
  if (precision === 'month') return value.slice(0, 7);
  return value;
}

/**
 * Every date a piece of text states, in one pass per form.
 *
 * A match overlapping a span an earlier form already took is dropped, which is
 * what keeps one date from being counted as three. A match no reading survives
 * -- `45/67/2024` -- is dropped too, and its span left free, so the digits are
 * still available to the number check rather than silently excused as a date.
 */
function dateMentions(text: string): DateMention[] {
  const taken: DateMention[] = [];
  for (const form of FORMS) {
    const pattern = new RegExp(form.pattern, 'gi');
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const start = match.index;
      const end = start + match[0].length;
      if (taken.some((t) => start < t.end && t.start < end)) continue;
      const values = form.values(match);
      if (values.length === 0) continue;
      taken.push({ start, end, precision: form.precision, values });
    }
  }
  return taken;
}

/** Whether the document states this date, states it less precisely, or does not
 *  state it at all. The middle case is a real answer, not a near miss: a day and
 *  a month the document never wrote are as invented as a date it never
 *  mentioned, and the operator is owed the difference. */
function dateSupport(
  claim: DateMention,
  stated: DateMention[],
): { supported: true } | { supported: false; nearest: string | null } {
  let nearest: string | null = null;
  for (const doc of stated) {
    if (RANK[doc.precision] >= RANK[claim.precision]) {
      for (const value of doc.values) {
        if (claim.values.includes(truncate(value, claim.precision))) return { supported: true };
      }
    } else {
      for (const value of doc.values) {
        if (claim.values.some((c) => truncate(c, doc.precision) === value)) nearest = value;
      }
    }
  }
  return { supported: false, nearest };
}

/**
 * A number written in digits, with or without thousands separators.
 *
 * The grouped alternative comes first so `1,200` is one number rather than a `1`
 * and a `200`.
 */
const DIGITS = /\d+(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/**
 * The cardinals a document writes out in words, so that turning them into digits
 * is not mistaken for inventing them.
 *
 * ONE DIRECTION ONLY -- the DOCUMENT's words support the OUTPUT's digits, never
 * the reverse. That asymmetry is the point: this list can only ever make the
 * check more permissive, so a gap in it costs nothing but a missed catch, while
 * a gap in a list used the other way round would refuse a good description.
 *
 * Stops at ninety-nine. "One hundred and twelve" needs a parser rather than a
 * table, and the numbers a document spells out in words are the small ones; a
 * document writing a large number writes it in digits, where the check already
 * sees it.
 */
const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** How a number is compared: by value, so `1,200`, `1200` and `1200.0` are one
 *  number and a separator convention is not a fabrication. */
function key(value: number): string {
  return String(value);
}

/** Every number the document offers, in digits or in words. */
function statedNumbers(text: string): Set<string> {
  const found = new Set<string>();

  for (const match of text.matchAll(DIGITS)) {
    const value = Number(match[0].replace(/,/g, ''));
    if (Number.isFinite(value)) found.add(key(value));
  }

  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  words.forEach((word, i) => {
    const tens = TENS[word];
    if (tens !== undefined) {
      found.add(key(tens));
      // "forty-seven" and "forty seven" are the same two words to this scan,
      // because the split is on letter runs.
      const unit = UNITS[words[i + 1] ?? ''];
      if (unit !== undefined && unit >= 1 && unit <= 9) found.add(key(tens + unit));
      return;
    }
    const unit = UNITS[word];
    if (unit !== undefined) found.add(key(unit));
  });

  return found;
}

/**
 * Below this, a number is not checked at all.
 *
 * A SMALL COUNT IS THE ONE NUMBER A MODEL CAN LEGITIMATELY PRODUCE WITHOUT
 * QUOTING ONE. "Survived by 4 children" over a document that names four is
 * arithmetic on what the document says, not an invention, and the digit it
 * reports appears nowhere in the text. Small numbers are also the ones prose
 * writes out in words, where a gap in `UNITS` above would refuse a good value.
 *
 * The cost of the exemption is bounded: a fabricated single digit is a wrong
 * count in a sentence a reviewer can check against the document, which is the
 * quality problem the flag on every model-written cell already covers. A
 * fabricated four-digit year is not.
 */
const SMALLEST_CHECKED = 10;

/** The text with every date span blanked, so the number check does not report
 *  the parts of a date the date check has already passed or failed. Without
 *  this, an accepted `2024-01-06` is hunted for as `2024`, `1` and `6` against a
 *  document that wrote "January 6, 2024", and a supported date is refused
 *  through the other door. */
function blank(text: string, spans: DateMention[]): string {
  const characters = [...text];
  for (const span of spans) {
    for (let i = span.start; i < span.end && i < characters.length; i++) characters[i] = ' ';
  }
  return characters.join('');
}

/**
 * The claims a document does not support.
 *
 * PURE, and it must stay so: no I/O, no network, no `node:*`. `src/core/extract/`
 * and its neighbours are what let an operator build a spreadsheet without
 * signing in to anything, and this may end up in the sandboxed renderer's import
 * graph.
 *
 * VERIFIED AGAINST THE WHOLE DOCUMENT, not against the slice that was sent. The
 * model cannot have read more than the slice, so a claim supported by the rest
 * of the file is a coincidence rather than a fabrication -- and checking against
 * the slice would make a supported value depend on the character budget, so
 * lowering a setting would start refusing descriptions that had been fine.
 *
 * EMPTY MEANS EVERY CHECKABLE CLAIM IS SUPPORTED. It does not mean the value is
 * true: prose is not checked, and nothing here can tell whether the sentence
 * around a supported date says the right thing about it. The cell stays flagged
 * either way.
 */
export function unsupportedClaims(
  generated: string,
  documentText: string,
  profile: Profile,
): UnsupportedClaim[] {
  const claims: UnsupportedClaim[] = [];

  const available = statedNumbers(documentText);

  // --- 1. Dates ------------------------------------------------------------
  const stated = dateMentions(documentText);
  const asserted = dateMentions(generated);
  for (const mention of asserted) {
    const text = generated.slice(mention.start, mention.end);
    const support = dateSupport(mention, stated);
    if (support.supported) continue;
    /*
     * A BARE FOUR-DIGIT RUN IS NOT NECESSARILY A YEAR. `1200` is a year to this
     * recogniser and a congregation to the document that wrote `1,200`, and
     * refusing a whole description over that reading would be the false
     * rejection this module is most careful about. So a year-precision claim
     * the dates do not support gets the number check's answer before it is
     * refused, and is refused only if the document supports it as NEITHER.
     * Nothing is lost: an invented year appears in the document in no form at
     * all, which is exactly what both checks then say.
     */
    if (mention.precision === 'year' && available.has(key(Number(text)))) continue;
    claims.push({
      kind: 'date',
      claim: text,
      why:
        support.nearest === null
          ? 'the document states no such date'
          : `the document is not that precise -- the nearest date it states is ${support.nearest}`,
    });
  }

  // --- 2. Numbers ----------------------------------------------------------
  for (const match of blank(generated, asserted).matchAll(DIGITS)) {
    const value = Number(match[0].replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    if (Number.isInteger(value) && Math.abs(value) < SMALLEST_CHECKED) continue;
    if (available.has(key(value))) continue;
    claims.push({
      kind: 'number',
      claim: match[0],
      why: 'this number appears nowhere in the document',
    });
  }

  // --- 3. Assertions the profile already has a check for --------------------
  /*
   * THE VOCABULARY IS THE PROFILE'S OWN. A `presence` source declares a trigger
   * list and the text to emit when the document contains one of them, which is
   * an operator saying "this collection cares whether the document evidences
   * this, and here is every way it might be written". So where the generated
   * text names one of those triggers and the document names none, the model has
   * asserted something a check this tool ALREADY RAN found no evidence for.
   *
   * TESTING THE ENTITY RATHER THAN THE SENTENCE is what makes it work: the
   * phrasing variants are caught too, and it works for any `presence` source any
   * institution writes. Nothing here knows what the triggers mean.
   *
   * A profile declaring no `presence` source gets no check, and NOTHING IS
   * SUBSTITUTED. A list of this module's own would be exactly the hardcoded
   * institutional assumption an entire release of this repository was spent
   * removing.
   *
   * Matched case-insensitively as a plain substring -- the same reading
   * `rows.ts` gives a `presence` source, so the check and the source cannot
   * disagree about whether the document mentions the thing.
   */
  const lowerDocument = documentText.toLowerCase();
  const lowerGenerated = generated.toLowerCase();
  for (const column of profile.columns) {
    for (const source of column.sources) {
      if (!('presence' in source)) continue;
      const triggers = source.presence.any.filter((phrase) => phrase.trim() !== '');
      if (triggers.length === 0) continue;
      if (triggers.some((phrase) => lowerDocument.includes(phrase.toLowerCase()))) continue;
      const mentioned = triggers.find((phrase) => lowerGenerated.includes(phrase.toLowerCase()));
      if (mentioned === undefined) continue;
      claims.push({
        kind: 'assertion',
        claim: mentioned,
        why: 'the document does not mention it, and this profile already checks for it',
      });
    }
  }

  // One claim per distinct thing said, however many times it was said. A note
  // naming the same invented date three times reads as three problems.
  const seen = new Set<string>();
  return claims.filter((claim) => {
    const identity = `${claim.kind} ${claim.claim}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
