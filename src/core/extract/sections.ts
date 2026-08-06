// src/core/extract/sections.ts

/**
 * Headings a description is commonly written under.
 *
 * A journal article marks it "Abstract"; a report marks it "Summary",
 * "Executive Summary" or "Overview". Reading the text under one of these is not
 * inference -- the document drew the boundary itself and this only follows it.
 *
 * Longest first, so "Executive Summary" is recognised as itself rather than as
 * a "Summary" preceded by a stray word.
 */
export const SECTION_HEADINGS = [
  'Executive Summary',
  'Abstract',
  'Summary',
  'Overview',
  'Description',
  'Purpose',
  'Scope',
] as const;

/**
 * Headings that end a section.
 *
 * Every start heading also ends one -- a document going straight from Summary
 * to Overview has finished the summary. The rest are what actually follows an
 * abstract in the material this was built against: eight of twelve real journal
 * PDFs end at Keywords, one at Methods, one at Introduction.
 */
/**
 * Endings that are not ordinary English, so they can be matched anywhere.
 *
 * Nobody writes "keywords" or "introduction" mid-sentence in an abstract, and
 * extracted PDF text frequently runs a heading straight on from the previous
 * sentence with no punctuation between — requiring a sentence boundary for
 * these missed the real end of two of twelve articles, and the section then ran
 * on to the length cap.
 */
const UNAMBIGUOUS_ENDINGS = ['Keywords', 'Keyword', 'Introduction', 'References'];

/**
 * Endings that ARE ordinary English and need to look like headings.
 *
 * "This is the summary." must not end a section at the word "summary". Every
 * start heading is here too: a document going straight from Summary to Overview
 * has finished the summary.
 */
const AMBIGUOUS_ENDINGS = [
  ...SECTION_HEADINGS,
  'Background',
  'Methods',
  'Method',
  'Materials',
  'Contents',
];

/**
 * How much text to take when a section never reaches another heading.
 *
 * Without a cap, a heading near the end of a file would swallow everything
 * after it -- which for a 68,000-character article means the whole paper landing
 * in a description cell.
 */
const MAX_SECTION = 4000;

function escaped(heading: string): string {
  return heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

/** A heading as its own word, not as part of a longer one. */
function headingPattern(heading: string): RegExp {
  return new RegExp(`\\b${escaped(heading)}\\b`, 'i');
}

/**
 * A heading in a position a heading can actually occupy: at the start, on a new
 * line, or after a sentence has ended.
 *
 * Without this, ordinary prose ends the section — "This is the summary." was cut
 * at the word "summary", because Summary is also a heading this recognises.
 * Several of these words are common English: summary, description, purpose,
 * scope, background, methods. Position is what separates the heading from the
 * word.
 */
function endingPattern(heading: string): RegExp {
  return new RegExp(`(?:^|[.:;!?\\n]\\s*)${escaped(heading)}\\b`, 'i');
}

/** Which known headings a document contains, in the order they appear. */
export function findSections(text: string): string[] {
  return SECTION_HEADINGS.map((heading) => ({ heading, at: text.search(headingPattern(heading)) }))
    .filter((h) => h.at !== -1)
    .sort((a, b) => a.at - b.at)
    .map((h) => h.heading);
}

export interface SectionText {
  /** The text under the heading. Empty when the heading is absent. */
  text: string;
  /**
   * True when the section ran to the cap instead of reaching another heading.
   *
   * Reported rather than swallowed because it is the signal that the match was
   * probably spurious: a benefits PDF matched "Summary" mid-page and produced
   * 3,996 characters of plan tables as its description. The caller keeps the
   * value and notes it, so the operator sees what happened.
   */
  capped: boolean;
}

/**
 * The text under `heading`, up to the next heading or the cap.
 *
 * Returns an empty string when the heading is absent or nothing follows it,
 * rather than guessing -- a blank cell is honest, and the operator can see it.
 */
export function readSection(text: string, heading: string): SectionText {
  const start = text.search(headingPattern(heading));
  if (start === -1) return { text: '', capped: false };

  const afterHeading = text.slice(start).replace(headingPattern(heading), '');
  // A leading colon or dash belongs to the heading, not to the text.
  const body = afterHeading.replace(/^\s*[:–—-]?\s*/, '');

  let end = body.length;

  for (const ending of UNAMBIGUOUS_ENDINGS) {
    const at = body.search(headingPattern(ending));
    if (at !== -1 && at < end) end = at;
  }

  for (const ending of AMBIGUOUS_ENDINGS) {
    const match = endingPattern(ending).exec(body);
    if (match !== null && match.index < end) {
      // The match may include the punctuation that preceded the heading; that
      // punctuation belongs to the section it closes, not to the heading.
      const offset = match[0].search(new RegExp(escaped(ending), 'i'));
      end = match.index + (offset > 0 ? offset : 0);
    }
  }

  const capped = end > MAX_SECTION;
  const section = body.slice(0, Math.min(end, MAX_SECTION)).trim();
  // If the cap cut it, stop at the last whole word rather than mid-word.
  return {
    text: capped ? section.slice(0, section.lastIndexOf(' ')).trim() : section,
    capped,
  };
}
