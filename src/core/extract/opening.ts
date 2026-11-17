// src/core/extract/opening.ts
import { DESCRIPTION_LIMIT, shortenText } from './length.js';

/**
 * The first substantial run of prose in a document.
 *
 * This is the last resort before an empty cell, and the only part of
 * description extraction that is a guess rather than a reading. A table cell
 * headed "Job Description" is the document stating its description; an
 * "Abstract" heading is the document drawing the boundary. This is neither --
 * it is the observation that documents tend to open by saying what they are.
 *
 * It is offered because "sometimes right and always visible" beats "always
 * empty". Every value it produces is flagged by the caller, without exception.
 */

/**
 * Lines that open a published document and say nothing about its content.
 *
 * Every one of these was in the first 400 characters of one of the operator's
 * own journal PDFs. Anchored at the start of the line: a DOI mentioned inside
 * a real sentence must not disqualify the sentence.
 */
const BOILERPLATE: RegExp[] = [
  /^\s*(?:©|\(c\)|copyright\b)/i,
  /^\s*doi\s*:/i,
  /^\s*https?:\/\//i,
  /^\s*(?:received|accepted|published|revised|submitted)\s*:/i,
  /^\s*citation\s*:/i,
  /^\s*(?:issn|isbn)\b/i,
  /^\s*academic\s+editor\s*:/i,
  /^\s*(?:all rights reserved|this is an open access article)/i,
];

/** Shorter than this is a heading, a caption or a fragment, not a paragraph. */
const MIN_PROSE = 60;

/** Words that are not entirely capitals, as a share of all words. */
function lowercaseShare(block: string): number {
  const words = block.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  if (words.length === 0) return 0;
  return words.filter((w) => w !== w.toUpperCase()).length / words.length;
}

/**
 * Whether a block reads as prose.
 *
 * A run of capitals is a banner, not a paragraph: the benefits PDF opens with
 * "MEDICAL BENEFITS SUMMARY PLAN DESCRIPTION", which is long enough to pass a
 * length test alone and is not a description of anything.
 */
function isProse(block: string): boolean {
  if (block.length < MIN_PROSE) return false;
  if (BOILERPLATE.some((pattern) => pattern.test(block))) return false;
  if (!/[.!?]/.test(block)) return false;
  // Enough real words, most of them not shouted.
  const words = block.split(/\s+/).filter((w) => /[A-Za-z]{2,}/.test(w));
  return words.length >= 10 && lowercaseShare(block) >= 0.6;
}

/**
 * The document's opening prose, or an empty string.
 *
 * Empty is a real answer: a document of headings and table fragments has no
 * opening paragraph, and a blank cell the operator can see beats a line of
 * timeline labels presented as a description.
 *
 * Cut to `limit` at a sentence end, because a PDF's extracted text often has
 * no line breaks at all and the whole document arrives as one block. The
 * extractor passes Infinity and cuts to the COLUMN's limit itself, so the cut
 * is noted and `maxLength` reaches this source too; the model's slice takes
 * the default.
 */
export function readOpening(text: string, limit: number = DESCRIPTION_LIMIT): string {
  for (const line of text.split(/\r?\n/)) {
    const block = line.trim();
    if (isProse(block)) return shortenText(block, limit).text;
  }
  return '';
}
