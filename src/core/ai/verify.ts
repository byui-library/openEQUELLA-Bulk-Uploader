// src/core/ai/verify.ts
import { MONTH_NAMES } from '../extract/dates.js';
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
 * A SECOND RUN, 2026-08-16, WITH A STRONGER MODEL SHARPENED ONE THING. It
 * produced usable output on eight of ten and fabricated on the same two; both
 * were refused and nothing ungrounded reached the spreadsheet. But it passed
 * the date checks partly because that model answers in ISO format, and an
 * earlier version of this file recognised a date only when a four-digit year sat
 * beside it -- so `He died on January 6.` over a dateless document was written
 * out as fact. A layer whose effectiveness turns on a model's formatting habit
 * is not a layer. See `FORMS`: a month name or a day-and-month pair is a claim
 * whether or not a year sits beside it.
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
 *
 * ============================================================================
 * IT READS ENGLISH DATES ONLY, AND NEVER SAYS OTHERWISE
 * ============================================================================
 *
 * `MONTH_NAMES` is English. `Falleció el 6 de enero de 2024` and `Er starb am
 * 6. Januar 2024` state a day, and this module sees only the year in them. A
 * correct day-precision description of either is therefore refused.
 *
 * REFUSING IS THE SAFE DIRECTION and stays. The failure that built this module
 * came from a genuinely dateless document, and a check that gave up quietly on
 * text it could not read would be the shape this codebase has shipped four
 * times: a successful-looking result from something that never ran.
 *
 * WHAT CHANGED IS THE WORDING. "The document states no such date" is a claim
 * ABOUT THE DOCUMENT, and this module is not entitled to it -- all it knows is
 * that no date IT CAN READ supports the value. Every `why` below is written to
 * that standard, and an institution cataloguing in another language meets the
 * limitation in the note itself as well as in the README. Adding a language is
 * adding its month names to `MONTH_NAMES` and its numeral words to `SMALL`;
 * nothing else here is English-specific except the preposition list guarding a
 * bare month name, and the ordinal suffixes.
 */

/**
 * ONE READING OF A DATE, decomposed into the parts the text actually stated.
 *
 * An ABSENT part is a part the text did not state, which is a different thing
 * from a part it stated as zero or unknown. `January 6` with no year is
 * `{ month, day }`, and a document giving only `2024` is `{ year }`; neither
 * supports the other, and `entails` below is the whole of that judgement.
 */
interface Reading {
  year?: string;
  month?: string;
  day?: string;
}

/** A date found in a piece of text, with the span it occupies so the number
 *  check can leave it alone. */
interface DateMention {
  start: number;
  end: number;
  /**
   * Every reading of this text. More than one where the text is genuinely
   * ambiguous and does not say which it means: `6/1/2024` is 6 January to one
   * writer and 1 June to another, and `4/2/98` is also either century. See the
   * separator forms in `FORMS`, which keep every reading rather than guessing.
   */
  readings: Reading[];
  /**
   * True only for a bare four-digit run -- `1938` -- which this module reads as
   * a year and the document may have meant as a quantity. It is the one date
   * shape that is not certainly a date, and both the number fallback and the
   * wording of the refusal depend on knowing that.
   */
  bare: boolean;
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

/**
 * A month name to its number, by three-letter stem.
 *
 * NOTHING GOES THROUGH `new Date` HERE ANY MORE, and that is deliberate rather
 * than tidying. `new Date('2024-01')` is parsed as UTC midnight and read back
 * through local date parts, which yields **2023-12-31** anywhere west of UTC --
 * the trap `rows.ts#ISO_DATE` exists to avoid, measured in this file before it
 * was written around. A month name is the only thing that ever needed
 * translating, and a table does it with no timezone, no locale and no
 * `January the 6th` unparseability to work around.
 *
 * THE STEM MUST STAY DISTINCT ACROSS `MONTH_NAMES`. It is for English; a
 * translated list whose months collide in three letters would need a longer
 * stem here and in `MONTH` above, which share the assumption.
 */
const MONTH_NUMBER = new Map<string, string>(
  MONTH_NAMES.map((name, index) => [name.slice(0, 3).toLowerCase(), pad2(index + 1)]),
);

/** An ordinal suffix on a day of the month: "6th", "1st". */
const ORDINAL = '(?:st|nd|rd|th)?';

/**
 * The words that make a bare month name a DATE rather than an ordinary English
 * word, on the claim side only.
 *
 * `May`, `March` and `August` are a modal verb, a verb and an adjective, and
 * `May he rest in peace` is a sentence a model writes about the very documents
 * this feature exists for. Refusing a whole description over it would be the
 * false rejection this module is most careful about, so a bare month name is
 * read as a claim only where one of these sits in front of it.
 *
 * THE DOCUMENT SIDE HAS NO SUCH GUARD, and the asymmetry is the module's usual
 * one: on the document side a month name is EVIDENCE, and seeing one the writer
 * did not mean as a date can only excuse a claim, never refuse a good one.
 */
const DATE_PREPOSITION = '(?:in|on|of|by|during|since|until|from|through|before|after|around)';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * A reading, or null where the text does not describe a real day.
 *
 * `45/67/2024` and `2024-02-30` return null, and the caller then leaves the span
 * FREE so its digits reach the number check rather than being silently excused
 * as a date.
 */
function reading(year: string | undefined, month?: string, day?: string): Reading | null {
  const built: Reading = {};
  if (year !== undefined) {
    if (!/^\d{4}$/.test(year)) return null;
    built.year = year;
  }
  if (month !== undefined) {
    const value = Number(month);
    if (!Number.isInteger(value) || value < 1 || value > 12) return null;
    built.month = pad2(value);
  }
  if (day !== undefined) {
    if (built.month === undefined) return null;
    const value = Number(day);
    // February with no year stated is given 29 days: the text did not say which
    // year, so this module may not rule the day out on a year it invented.
    const index = Number(built.month) - 1;
    const most =
      index === 1 && built.year !== undefined ? (isLeapYear(Number(built.year)) ? 29 : 28) : DAYS_IN_MONTH[index]!;
    if (!Number.isInteger(value) || value < 1 || value > most) return null;
    built.day = pad2(value);
  }
  return built;
}

/** The month number a captured month name stands for, or undefined. */
function monthOf(name: string): string | undefined {
  return MONTH_NUMBER.get(name.replace(/\./g, '').slice(0, 3).toLowerCase());
}

/** Readings with nulls dropped and duplicates removed. */
function readings(...values: (Reading | null)[]): Reading[] {
  const seen = new Set<string>();
  const kept: Reading[] = [];
  for (const value of values) {
    if (value === null) continue;
    const identity = canonical(value);
    if (seen.has(identity)) continue;
    seen.add(identity);
    kept.push(value);
  }
  return kept;
}

/**
 * A reading written out, for display and for deduplication.
 *
 * A year-less reading uses ISO 8601's truncated form -- `--01-06` -- rather than
 * inventing a year to fill the slot, which is the fabrication this module
 * exists to refuse.
 */
function canonical(value: Reading): string {
  const tail = [value.month, value.day].filter((part) => part !== undefined).join('-');
  if (value.year === undefined) return `--${tail}`;
  return tail === '' ? value.year : `${value.year}-${tail}`;
}

/** Which side of the check a text is being read for. */
type Role = 'claim' | 'evidence';

/**
 * The forms a date is written in, MOST SPECIFIC FIRST.
 *
 * Order is the whole of the precision logic: a span already claimed by an
 * earlier form is not offered to a later one, so `2024-01-06` is one day and not
 * also the year 2024, and `6 January 2024` is one day and not also the month
 * January 2024.
 *
 * ## A FORM THAT DOES NOT MATCH USED TO MEAN "NO CLAIM WAS MADE"
 *
 * That is the defect these forms were rebuilt around. There was no month-and-day
 * form and no separator form without a four-digit year, so `He died on January
 * 6.` over a document stating no date at all fell through every pattern and was
 * written into the catalogue -- and so did `Died in January of 2024.` over a
 * document giving only the year, because `of` broke the month form and the bare
 * `2024` that remained was supported. The rule now is that a MONTH NAME, or a
 * DAY-AND-MONTH PAIR, is a claim whether or not a year sits beside it; if it
 * cannot be resolved to something the document supports, it is refused.
 *
 * ## What is deliberately NOT read as a date
 *
 * - `6.1` and `1-6` with no year. Indistinguishable from a decimal and from a
 *   range, and reading them as dates would refuse `It ran 3.5 miles` and
 *   `pages 1-6`. Only `1/6` is taken, and only where at least one reading is a
 *   real calendar day -- `16/9` as an aspect ratio is the accepted cost, and it
 *   is stated here rather than discovered.
 * - A bare month name in the generated text with no date preposition in front
 *   of it. See `DATE_PREPOSITION`.
 */
const FORMS: {
  pattern: string;
  /** Absent means both sides. */
  only?: Role;
  bare?: true;
  readings: (match: RegExpExecArray) => Reading[];
}[] = [
  {
    // 2024-01-06, and 2024-01-06T00:00:00Z -- a routine model output shape, and
    // one the old `\b`-terminated pattern could not see at all: the `T` is a
    // word character, so there was no boundary after the `06`, and what survived
    // was a bare `2024` that a year-only document supported. Fabricated
    // precision, laundered by a timestamp suffix.
    pattern:
      '\\b(\\d{4})-(\\d{2})-(\\d{2})(?:[T ]\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)?(?!\\d)',
    readings: (m) => readings(reading(m[1], m[2], m[3])),
  },
  {
    // January 6, 2024 / January 6th 2024 / Jan. 6, 2024 / January the 6th, 2024
    pattern: `\\b(${MONTH})\\s+(?:the\\s+)?(\\d{1,2})${ORDINAL}\\s*,?\\s*(?:of\\s+)?(\\d{4})(?!\\d)`,
    readings: (m) => readings(reading(m[3], monthOf(m[1] ?? ''), m[2])),
  },
  {
    // 6 January 2024 / the 6th of January 2024
    pattern: `\\b(?:the\\s+)?(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?(${MONTH})\\s*,?\\s*(\\d{4})(?!\\d)`,
    readings: (m) => readings(reading(m[3], monthOf(m[2] ?? ''), m[1])),
  },
  {
    /*
     * 1/6/2024, 6-1-2024, 6.1.2024.
     *
     * BOTH READINGS ARE KEPT, because the text does not say which it means and
     * this module must not guess: 6 January and 1 June are equally good
     * readings of `6/1/2024`, and picking one would refuse a supported date at
     * whichever institution writes the other way round. A claim is supported
     * when it matches EITHER, which is the permissive direction and the correct
     * one -- the model read the same ambiguous string.
     *
     * The full stop belongs in the separator class: `6.1.2024` is how much of
     * the world writes a date, and without it that document supported nothing
     * while `Died 06.01.2024` in a reply was reported as the invented NUMBER
     * `06.01`. A decimal cannot be confused with this -- two separators and a
     * four-digit tail are required.
     */
    pattern: '\\b(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{4})(?!\\d)',
    readings: (m) => readings(reading(m[3], m[1], m[2]), reading(m[3], m[2], m[1])),
  },
  {
    /*
     * 4/2/98. BOTH CENTURIES ARE KEPT for the same reason both day orders are:
     * the text does not say, and a pivot year is a guess this module would then
     * refuse a correct description over. Four readings, any of which supports.
     */
    pattern: '\\b(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{2})(?!\\d)',
    readings: (m) =>
      readings(
        ...['19', '20'].flatMap((century) => [
          reading(`${century}${m[3]}`, m[1], m[2]),
          reading(`${century}${m[3]}`, m[2], m[1]),
        ]),
      ),
  },
  {
    // 2024-01, and never the first half of 2024-01-06 -- that span is taken.
    pattern: '\\b(\\d{4})-(\\d{2})(?![\\d-])',
    readings: (m) => readings(reading(m[1], m[2])),
  },
  {
    // January 2024 / January of 2024
    pattern: `\\b(${MONTH})\\s+(?:of\\s+)?(\\d{4})(?!\\d)`,
    readings: (m) => readings(reading(m[2], monthOf(m[1] ?? ''))),
  },
  {
    // January 6 / Jan. 6th, with no year anywhere near it.
    pattern: `\\b(${MONTH})\\s+(?:the\\s+)?(\\d{1,2})${ORDINAL}(?!\\d)`,
    readings: (m) => readings(reading(undefined, monthOf(m[1] ?? ''), m[2])),
  },
  {
    // 6 January / the 6th of January, with no year.
    pattern: `\\b(?:the\\s+)?(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?(${MONTH})(?![A-Za-z])`,
    readings: (m) => readings(reading(undefined, monthOf(m[2] ?? ''), m[1])),
  },
  {
    // 1/6, with no year. Both orders, and only where one of them is a real day.
    pattern: '\\b(\\d{1,2})/(\\d{1,2})(?![\\d/])',
    readings: (m) => readings(reading(undefined, m[1], m[2]), reading(undefined, m[2], m[1])),
  },
  {
    // 1938
    pattern: '\\b(\\d{4})\\b',
    bare: true,
    readings: (m) => readings(reading(m[1])),
  },
  {
    // "in January", "since March" -- a month with no day and no year. Only on
    // the claim side, and only behind a preposition. See `DATE_PREPOSITION`.
    pattern: `(?<=\\b${DATE_PREPOSITION}\\s{1,4})(${MONTH})(?![A-Za-z])`,
    only: 'claim',
    readings: (m) => readings(reading(undefined, monthOf(m[1] ?? ''))),
  },
  {
    // The same month, unguarded, as EVIDENCE. A month name in the document
    // supports a claim about that month however the sentence around it reads.
    pattern: `\\b(${MONTH})(?![A-Za-z])`,
    only: 'evidence',
    readings: (m) => readings(reading(undefined, monthOf(m[1] ?? ''))),
  },
];

/**
 * Every date a piece of text states, in one pass per form.
 *
 * A match overlapping a span an earlier form already took is dropped, which is
 * what keeps one date from being counted as three. A match no reading survives
 * -- `45/67/2024` -- is dropped too, and its span left free, so the digits are
 * still available to the number check rather than silently excused as a date.
 *
 * Overlap is tested against a per-character mask rather than by scanning the
 * spans taken so far, which was quadratic in the four-digit runs of a long
 * document. The mask is indexed in UTF-16 code units, the same units
 * `RegExpExecArray.index` and `String.length` are in -- see `blank`, which got
 * that wrong.
 */
function dateMentions(text: string, role: Role): DateMention[] {
  const taken: DateMention[] = [];
  const covered = new Uint8Array(text.length);
  for (const form of FORMS) {
    if (form.only !== undefined && form.only !== role) continue;
    const pattern = new RegExp(form.pattern, 'gi');
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const start = match.index;
      const end = start + match[0].length;
      let clash = false;
      for (let i = start; i < end; i++) {
        if (covered[i] === 1) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      const found = form.readings(match);
      if (found.length === 0) continue;
      for (let i = start; i < end; i++) covered[i] = 1;
      taken.push({ start, end, readings: found, bare: form.bare === true });
    }
  }
  return taken;
}

/**
 * Whether one stated reading supports one claimed reading.
 *
 * EVERY PART THE CLAIM STATES MUST BE STATED, AND EQUAL, IN THE DOCUMENT'S. A
 * part the claim leaves out is not checked, so `2024` is supported by
 * `2024-01-06`; a part the claim states and the document does not is
 * unsupported, so `2024-01-06` is NOT supported by `2024`, and `January 6` is
 * not supported by `2024` either. That second case is the founding failure at a
 * finer grain: a day and a month the document never wrote are as invented as a
 * date it never mentioned.
 *
 * READINGS ARE NOT COMBINED ACROSS MENTIONS. A document stating `1938-2024` in
 * one place and `January 6` in another does not, here, support `2024-01-06`;
 * joining two mentions is an inference about which fact belongs to which, and
 * this module does not make inferences. The cost is a false rejection on a
 * document written that way, and the operator is told the nearest date it did
 * find.
 */
function entails(stated: Reading, claim: Reading): boolean {
  if (claim.year !== undefined && stated.year !== claim.year) return false;
  if (claim.month !== undefined && stated.month !== claim.month) return false;
  if (claim.day !== undefined && stated.day !== claim.day) return false;
  return true;
}

/** How many parts two readings state in common and agree on, or -1 where they
 *  disagree on any part they both state. */
function agreement(stated: Reading, claim: Reading): number {
  let shared = 0;
  for (const part of ['year', 'month', 'day'] as const) {
    const a = stated[part];
    const b = claim[part];
    if (a === undefined || b === undefined) continue;
    if (a !== b) return -1;
    shared += 1;
  }
  return shared;
}

/** Whether the document states this date, states something near it, or states
 *  nothing bearing on it at all. The middle case is a real answer, not a near
 *  miss, and the operator is owed the difference: it says where to look. */
function dateSupport(
  claim: DateMention,
  stated: readonly DateMention[],
): { supported: true } | { supported: false; nearest: string | null } {
  let nearest: string | null = null;
  let best = 0;
  for (const mention of stated) {
    for (const document of mention.readings) {
      for (const asserted of claim.readings) {
        if (entails(document, asserted)) return { supported: true };
        const shared = agreement(document, asserted);
        if (shared > best) {
          best = shared;
          nearest = canonical(document);
        }
      }
    }
  }
  return { supported: false, nearest };
}

/**
 * A number written in digits, as it appears in a MODEL'S REPLY.
 *
 * The grouped alternative comes first so `1,200` is one number rather than a `1`
 * and a `200`. Deliberately narrower than `DOCUMENT_DIGITS` below: see the
 * asymmetry recorded there.
 */
const DIGITS = /\d+(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/**
 * The space characters a thousands group may be joined by, as regex-class
 * contents: the ordinary space, the no-break space and the narrow no-break
 * space, which is what a European document actually uses.
 *
 * WRITTEN AS ESCAPES, NEVER AS THE CHARACTERS THEMSELVES. A no-break space in
 * a character class is indistinguishable from the ordinary space beside it in
 * every editor, and a non-ASCII byte in this file is how the dedupe separator
 * below once made the whole module invisible to `grep`. `tests/ai/verify.test.ts`
 * fails the build if one comes back.
 */
const SPACES = ' \\u00a0\\u202f';

/**
 * A number in digits as it appears in a DOCUMENT -- widened to every grouping
 * convention a real one uses.
 *
 * `1.200` and `1 200` are `1,200` written by somebody else, and a document using
 * either supported nothing: `1200 people` in a correct description was refused
 * as an invented DATE, because a bare four-digit run is read as a year first.
 * Two of the twelve confirmed false rejections were exactly this.
 *
 * THE WIDENING IS ON THE DOCUMENT SIDE ONLY, like the spelled-out numerals
 * below and for the same reason: another reading of the DOCUMENT can only ever
 * excuse a value, while another reading of the REPLY could merge two numbers the
 * model wrote separately into one it never wrote, and refuse over the join.
 */
const DOCUMENT_DIGITS = new RegExp(
  `\\d{1,3}(?:[${SPACES}]\\d{3})+(?!\\d)|\\d+(?:,\\d{3})+(?:\\.\\d+)?|\\d{1,3}(?:\\.\\d{3})+(?!\\d)|\\d+(?:\\.\\d+)?`,
  'g',
);

/** Grouped by any of the conventions, i.e. every group after the first is
 *  exactly three digits. */
const THOUSANDS = new RegExp(`^\\d{1,3}(?:[,.${SPACES}]\\d{3})+$`);

/** Every grouping separator, and every one but the full stop -- which has to
 *  survive so `1.200` can still be read as the decimal 1.2. */
const GROUPING = new RegExp(`[,.${SPACES}]`, 'g');
const GROUPING_KEEPING_POINT = new RegExp(`[,${SPACES}]`, 'g');

/**
 * Every value a document's number token can be read as.
 *
 * `1.200` is 1200 to a German cataloguer and 1.2 to an English one, and the text
 * does not say which -- the same ambiguity the separator date forms keep both
 * readings of. The individual groups are kept too, so `three 200-metre races`
 * written `3 200` still offers both 3 and 200 rather than only 3200.
 */
function numberReadings(token: string): number[] {
  const values: number[] = [];
  if (THOUSANDS.test(token)) {
    values.push(Number(token.replace(GROUPING, '')));
    for (const group of token.split(GROUPING)) values.push(Number(group));
  }
  values.push(Number(token.replace(GROUPING_KEEPING_POINT, '')));
  return values.filter((value) => Number.isFinite(value));
}

/**
 * The cardinals a document writes out in words, so that turning them into digits
 * is not mistaken for inventing them.
 *
 * ONE DIRECTION ONLY -- the DOCUMENT's words support the OUTPUT's digits, never
 * the reverse.
 *
 * ## A GAP IN THIS LIST IS A FALSE REJECTION, NOT A MISSED CATCH
 *
 * This comment used to say the opposite: that the asymmetry meant a gap "can
 * only ever make the check more permissive, so it costs nothing but a missed
 * catch". It feeds `statedNumbers`, which is the SUPPORTING set -- so a number
 * the document spells out and this table cannot read is a number the document
 * does not offer, and the digit in a correct description is refused. It costs
 * exactly what that sentence said it could not, and four of the twelve confirmed
 * false rejections were words missing from here: `two hundred`, `a thousand`,
 * `a dozen`, `twenty-first`, `three and a half`.
 *
 * The old ceiling of ninety-nine came with it -- "a document writing a large
 * number writes it in digits" -- which is a domain judgement drawn from obituary
 * prose, in a module whose entire premise is that it knows nothing about any
 * collection, and it failed in the expensive direction. `SCALES` and the
 * accumulator in `addSpelledNumbers` lift it.
 *
 * Ordinals are here because `the twenty-first reunion` and `the 21st reunion`
 * are the same fact; `second`, `third` and `fourth` earn their place as numbers
 * even though they are ordinary words, since an extra entry in a supporting set
 * can only excuse.
 */
const SMALL: Record<string, number> = {
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
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
  fortieth: 40,
  fiftieth: 50,
  sixtieth: 60,
  seventieth: 70,
  eightieth: 80,
  ninetieth: 90,
};

/** The multipliers that take the table above past ninety-nine. `dozen` is one:
 *  a document writing "a dozen books" states twelve of them. */
const SCALES: Record<string, number> = {
  hundred: 100,
  hundreds: 100,
  thousand: 1000,
  thousands: 1000,
  million: 1_000_000,
  millions: 1_000_000,
  billion: 1_000_000_000,
  dozen: 12,
  dozens: 12,
};

/** How a number is compared: by value, so `1,200`, `1200` and `1200.0` are one
 *  number and a separator convention is not a fabrication. */
function key(value: number): string {
  return String(value);
}

/**
 * Numbers a document spells out, including the compounds a table alone cannot
 * hold: `two hundred`, `a thousand`, `one hundred and twelve`, `three and a
 * half`.
 *
 * EVERY PART IS RECORDED AS WELL AS THE WHOLE. "Two hundred" offers 2 and 200,
 * because a description may legitimately quote either, and this set can only
 * excuse.
 *
 * A unit attaches to what precedes it only after a tens word, a scale word or
 * `and`, so `six seven` is 6 and 7 rather than 13.
 */
function addSpelledNumbers(text: string, found: Set<string>): void {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  let total = 0; // completed scale groups: thousands and above
  let current = 0; // the group being built
  let open = false; // anything at all under construction
  let attach = false; // a small number joins `current` rather than starting anew

  const record = (value: number): void => {
    if (Number.isFinite(value)) found.add(key(value));
  };
  const close = (): void => {
    if (open) record(total + current);
    total = 0;
    current = 0;
    open = false;
    attach = false;
  };

  for (const word of words) {
    const small = SMALL[word];
    if (small !== undefined) {
      record(small);
      if (open && attach) current += small;
      else {
        close();
        current = small;
        open = true;
      }
      attach = small >= 20 && small % 10 === 0;
      continue;
    }

    const scale = SCALES[word];
    if (scale !== undefined) {
      const multiplicand = open && current > 0 ? current : 1;
      if (scale >= 1000) {
        total += multiplicand * scale;
        current = 0;
      } else {
        current = multiplicand * scale;
      }
      open = true;
      record(total + current);
      attach = true;
      continue;
    }

    // "one hundred and twelve", "three and a half": neither word ends the
    // number being built, and `a` may itself be the one in "a thousand".
    if (word === 'and' && open) {
      attach = true;
      continue;
    }
    if (word === 'a' || word === 'an') continue;
    if (word === 'half') {
      if (open) record(total + current + 0.5);
      record(0.5);
      close();
      continue;
    }

    close();
  }
  close();
}

/**
 * A negative sign the model actually wrote, told apart from a hyphen joining two
 * numbers.
 *
 * `-40` was reported as the claim `40`, which the operator then could not find
 * in the quoted reply -- a note naming something that is not there. A `-` counts
 * as a sign only where what precedes it is not itself part of a number, so the
 * `2024` of `1938-2024` stays positive.
 */
function withSign(text: string, index: number, token: string): string {
  if (index === 0 || text[index - 1] !== '-') return token;
  const before = index >= 2 ? (text[index - 2] ?? '') : '';
  if (/[\d./-]/.test(before)) return token;
  return `-${token}`;
}

/** Every number the document offers, in digits or in words. */
function statedNumbers(text: string): Set<string> {
  const found = new Set<string>();

  for (const match of text.matchAll(DOCUMENT_DIGITS)) {
    const token = withSign(text, match.index, match[0]);
    for (const value of numberReadings(token.replace(/^-/, ''))) {
      found.add(key(value));
      // Both signs, so a document writing -40 supports 40 and vice versa. The
      // supporting set is permissive by design.
      if (token.startsWith('-')) found.add(key(-value));
    }
  }

  addSpelledNumbers(text, found);

  return found;
}

/**
 * Below this, a number is not checked at all.
 *
 * A SMALL COUNT IS THE ONE NUMBER A MODEL CAN LEGITIMATELY PRODUCE WITHOUT
 * QUOTING ONE. "Survived by 4 children" over a document that names four is
 * arithmetic on what the document says, not an invention, and the digit it
 * reports appears nowhere in the text. Small numbers are also the ones prose
 * writes out in words, where a gap in `SMALL` above would refuse a good value.
 *
 * The cost of the exemption is bounded: a fabricated single digit is a wrong
 * count in a sentence a reviewer can check against the document, which is the
 * quality problem the flag on every model-written cell already covers. A
 * fabricated four-digit year is not.
 *
 * THE EXEMPTION IS FOR INTEGERS ONLY, so `3.5` IS checked however small it is.
 * An earlier version of this comment said numbers below the threshold are "not
 * checked at all", full stop, which is not what the code does and not what it
 * should do: a fabricated measurement is not arithmetic on anything the document
 * lists, and nothing writes 3.5 out in words except the `three and a half` the
 * table above now reads.
 */
const SMALLEST_CHECKED = 10;

/** The text with every date span blanked, so the number check does not report
 *  the parts of a date the date check has already passed or failed. Without
 *  this, an accepted `2024-01-06` is hunted for as `2024`, `1` and `6` against a
 *  document that wrote "January 6, 2024", and a supported date is refused
 *  through the other door.
 *
 *  SPLIT INTO UTF-16 CODE UNITS, NOT CODE POINTS. `span.start` and `span.end`
 *  come from `RegExpExecArray.index`, which counts code units, so `[...text]`
 *  indexed the mask by something else entirely: one astral character earlier in
 *  the reply shifted every window after it. Ten emoji moved the mask far enough
 *  to leave a fabricated number unmasked and written; two exposed the `20` of a
 *  `2024` already checked as a date and refused a good description as an
 *  invented number. `quoted()` in `fill.ts` is correctly code-point-based and is
 *  NOT the same problem: it cuts a string for display, where splitting a
 *  surrogate pair leaves half a character in a spreadsheet cell. One counts
 *  characters for a human, this one addresses offsets a regex produced. */
function blank(text: string, spans: DateMention[]): string {
  const characters = text.split('');
  for (const span of spans) {
    for (let i = span.start; i < span.end && i < characters.length; i++) characters[i] = ' ';
  }
  return characters.join('');
}

/**
 * Everything a document offers as support, derived once.
 *
 * HOISTED BECAUSE IT IS PER DOCUMENT AND THE CHECK IS PER CELL. Every enabled
 * column on a row re-derived every date and every number in the whole file,
 * which is the repeated work `fill.ts` already goes to explicit trouble to avoid
 * for the slice. Opaque on purpose: a caller holds one and passes it back, and
 * cannot assemble one that disagrees with what the document says.
 */
export interface DocumentEvidence {
  readonly text: string;
  readonly lower: string;
  readonly dates: readonly DateMention[];
  readonly numbers: ReadonlySet<string>;
}

/** Read a document once, for as many cells as the row has. */
export function documentEvidence(documentText: string): DocumentEvidence {
  return {
    text: documentText,
    lower: documentText.toLowerCase(),
    dates: dateMentions(documentText, 'evidence'),
    numbers: statedNumbers(documentText),
  };
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
 *
 * The document may be given as text or as a `DocumentEvidence` read from it
 * earlier; the two answer identically, and the second exists only to stop a row
 * paying to read the same file once per column.
 */
export function unsupportedClaims(
  generated: string,
  document: string | DocumentEvidence,
  profile: Profile,
): UnsupportedClaim[] {
  const evidence = typeof document === 'string' ? documentEvidence(document) : document;
  const claims: UnsupportedClaim[] = [];

  // --- 1. Dates ------------------------------------------------------------
  const asserted = dateMentions(generated, 'claim');
  for (const mention of asserted) {
    const text = generated.slice(mention.start, mention.end);
    const support = dateSupport(mention, evidence.dates);
    if (support.supported) continue;
    /*
     * A BARE FOUR-DIGIT RUN IS NOT NECESSARILY A YEAR. `1200` is a year to this
     * recogniser and a congregation to the document that wrote `1,200`, and
     * refusing a whole description over that reading would be the false
     * rejection this module is most careful about. So a bare run the dates do
     * not support gets the number check's answer before it is refused, and is
     * refused only if the document supports it as NEITHER.
     *
     * THE EQUIVALENCE IS SYMMETRIC, AND THAT IS NOT GUARDED. The docblock used
     * to justify only one direction. Both hold: `Enrolment reached 2019.` is
     * supported by a document saying `He died in 2019`, and `Born in 1938.` is
     * supported by one saying `He owned 1938 books`, because a bare four-digit
     * run is ambiguous on BOTH sides and nothing context-free can tell a year
     * from a count. Guarding it would need to know which the sentence meant,
     * which is reading prose -- the thing this module refuses to do. So it is
     * stated rather than fixed: a fabricated four-digit value that happens to
     * equal an unrelated one in the document passes, and the cell stays flagged
     * for the reviewer who can tell.
     */
    if (mention.bare && evidence.numbers.has(key(Number(text)))) continue;
    claims.push({
      kind: 'date',
      claim: text,
      why: unsupportedDateReason(mention, support.nearest),
    });
  }

  // --- 2. Numbers ----------------------------------------------------------
  const masked = blank(generated, asserted);
  for (const match of masked.matchAll(DIGITS)) {
    const token = withSign(masked, match.index, match[0]);
    const value = Number(token.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    if (Number.isInteger(value) && Math.abs(value) < SMALLEST_CHECKED) continue;
    if (evidence.numbers.has(key(value))) continue;
    claims.push({
      kind: 'number',
      claim: token,
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
   *
   * THE EMPTY-STRING FILTER IS LOAD-BEARING, not tidying. `includes('')` is
   * true of every string, so one blank entry in a profile's `any` list would
   * make the document look as though it evidenced the trigger, and this check
   * would report success on every row without having run -- the exact failure
   * this module exists to prevent, sitting inside it.
   */
  const lowerGenerated = generated.toLowerCase();
  for (const column of profile.columns) {
    for (const source of column.sources) {
      if (!('presence' in source)) continue;
      const triggers = source.presence.any.filter((phrase) => phrase.trim() !== '');
      if (triggers.length === 0) continue;
      if (triggers.some((phrase) => evidence.lower.includes(phrase.toLowerCase()))) continue;
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
  //
  // The separator below is WRITTEN AS AN ESCAPE, NEVER AS A RAW 0x00. A literal
  // NUL byte there made git and ripgrep classify this entire file as binary, so
  // every content search over it silently returned nothing -- including the
  // grep offered as evidence that this module names no institution. Re-run
  // properly the conclusion held, but the check had never run: the exact
  // failure this module exists to prevent, sitting inside this module.
  const seen = new Set<string>();
  return claims.filter((claim) => {
    const identity = `${claim.kind}\u0000${claim.claim}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/**
 * Why one date claim failed, in one clause.
 *
 * NONE OF THESE SAYS WHAT THE DOCUMENT CONTAINS. "The document states no such
 * date" is a claim about the document, and this module is only entitled to a
 * claim about itself: no date IT CAN READ supports the value. At a Spanish- or
 * German-language institution every day-precision claim is refused, and the
 * operator reading the note has to be able to tell that from a document that
 * really states nothing.
 *
 * A BARE FOUR-DIGIT RUN GETS ITS OWN SENTENCE, because it has just failed two
 * checks rather than one. Sending an operator to look for a missing DATE when
 * the model wrote a congregation size is this codebase's named failure shape --
 * a diagnosis naming the one place the problem is not -- inside the one sentence
 * they act on.
 */
function unsupportedDateReason(mention: DateMention, nearest: string | null): string {
  if (nearest !== null) {
    return `the document is not that precise -- the nearest date this tool can read there is ${nearest}`;
  }
  if (mention.bare) {
    return `the document gives it as neither a date nor a number this tool can read`;
  }
  return (
    `no date this tool can read in the document supports it -- it recognises English month ` +
    `names and numeric date forms only`
  );
}
