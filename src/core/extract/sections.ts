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
const UNAMBIGUOUS_ENDINGS = [
  'Keywords',
  'Keyword',
  // Two words in one of the twelve. Written as its own ending rather than by
  // loosening the one-word pattern, which would also match "keyword" inside
  // ordinary prose.
  'Key words',
  'Introduction',
  'References',
  // What a journal stamps after an abstract. Nobody writes this sentence
  // inside one, and without it a PeerJ article carried 700 characters of
  // citation, editor, copyright and licence text into its description.
  'How to cite this article',
];

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

/**
 * The running head a journal stamps on every page — a title, a volume, a DOI, a
 * page number. It lands in the extracted text wherever the page broke.
 *
 * Removed only from the END of a section. Two of the twelve articles carried
 * one as a tail; a third has one in the MIDDLE, with real abstract text on both
 * sides, so anything that truncated at the first URL would have cut that
 * abstract in half.
 */
const TRAILING_FURNITURE: RegExp[] = [
  // A final line that is a page marker: "Sports 2024 , 12 , 194 2 of 15".
  /\n[^\n]{0,80}\b\d{1,4}\s*(?:of|\/)\s*\d{1,4}\s*$/i,
  // A final line carrying a link.
  /\n[^\n]{0,200}(?:https?:\/\/|doi\.org\/|doi:)\S*[^\n]*$/i,
  // A link tacked onto the end of the last sentence, rather than onto a line
  // of its own. Anchored after a sentence end so it cannot eat real prose.
  /(?<=[.!?])\s*[^.!?\n]{0,120}(?:https?:\/\/|doi\.org\/|doi:)\S*[^\n]*$/i,
  /**
   * A running head left behind once its link is gone: "Sports 2024 , 12 , 194."
   *
   * The volume and issue numbers after the year are REQUIRED. Without them this
   * would also match an ordinary closing sentence that happens to end in a year
   * -- "The data were collected in 2024." -- and delete it.
   */
  /(?<=[.!?])\s*[A-Z][A-Za-z&.]*(?:\s+[A-Za-z&.]+){0,3}\s+\d{4}(?:\s*,\s*\d+){1,}\s*\.?\s*$/,
];

/** A word that means the next word is part of a sentence, not a heading. */
const DETERMINER = /\b(?:the|a|an|our|its|this)\s+$/i;

function trimFurniture(section: string): string {
  let text = section;
  // Repeated: an article can leave both a link line and a page-number line.
  for (let pass = 0; pass < TRAILING_FURNITURE.length; pass++) {
    const before = text;
    for (const pattern of TRAILING_FURNITURE) text = text.replace(pattern, '');
    text = text.trimEnd();
    if (text === before) break;
  }
  return text;
}

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
  /**
   * True when the heading turned out to be a word inside a sentence.
   *
   * "The purpose of this study was to describe..." is prose, not a heading, and
   * one real article has no `Purpose` heading at all — only that sentence.
   * Taking the text after the word alone produced a cell beginning "of this
   * study was to describe". The whole sentence is kept instead, and the caller
   * notes it: the value is usually right and the match was still not a heading.
   */
  midSentence: boolean;
}

/**
 * The text under `heading`, up to the next heading or the cap.
 *
 * Returns an empty string when the heading is absent or nothing follows it,
 * rather than guessing -- a blank cell is honest, and the operator can see it.
 */
export function readSection(text: string, heading: string): SectionText {
  const start = text.search(headingPattern(heading));
  if (start === -1) return { text: '', capped: false, midSentence: false };

  // A determiner in front means this is a word in a sentence, not a heading:
  // "The purpose of this study was to...". Keep the determiner and the heading
  // word, so the value reads as the sentence it actually is.
  //
  // Position is NOT usable for finding a heading, only for rejecting one this
  // way. Not one of the twelve real articles has its "Abstract" at a line start
  // or after a full stop -- every one follows an email address or an
  // affiliation with no punctuation between, so requiring a heading position
  // would have found nothing at all.
  const determiner = DETERMINER.exec(text.slice(0, start));
  const midSentence = determiner !== null;

  const body = midSentence
    ? text.slice(start - determiner[0].length)
    : // A leading colon or dash belongs to the heading, not to the text.
      text.slice(start).replace(headingPattern(heading), '').replace(/^\s*[:–—-]?\s*/, '');

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
  const whole = capped ? section.slice(0, section.lastIndexOf(' ')).trim() : section;

  return { text: trimFurniture(whole), capped, midSentence };
}
