// src/core/extract/suggest.ts
import { extname } from 'node:path';
import { ATTACHMENT_COLUMN, type Profile } from './types.js';
import { isSupported } from './readers/index.js';

const SEPARATORS = ['_', '-', ' '] as const;

function majorityExtension(filenames: string[]): string {
  const counts = new Map<string, number>();
  for (const name of filenames) {
    const extension = extname(name).toLowerCase();
    if (extension === '') continue;
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  let best = '.pdf';
  let bestCount = 0;
  for (const [extension, count] of counts) {
    if (count > bestCount) {
      best = extension;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Propose a pattern from real filenames. Picks the separator that splits every
 * file into the same number of parts -- consistency is the signal that a
 * separator is structural rather than incidental. Falls back to one
 * placeholder covering the whole name, which always matches and is honest
 * about having found no structure.
 */
export function detectPattern(allFilenames: string[]): string {
  // Only files the extractor can actually read may influence the pattern. A
  // folder routinely contains other things -- the profile .json itself,
  // Thumbs.db, a stray .txt -- and letting those vote produced a pattern
  // built around the wrong extension entirely. Filtering here rather than in
  // each caller keeps every front end correct by construction.
  const filenames = allFilenames.filter(isSupported);
  const extension = majorityExtension(filenames);
  const stems = filenames
    .filter((n) => extname(n).toLowerCase() === extension)
    .map((n) => n.slice(0, n.length - extname(n).length));

  if (stems.length === 0) return `{part1}${extension}`;

  let bestSeparator: string | null = null;
  let bestCount = 1;
  for (const separator of SEPARATORS) {
    const counts = new Set(stems.map((s) => s.split(separator).length));
    if (counts.size !== 1) continue;
    const count = [...counts][0]!;
    if (count > bestCount) {
      bestSeparator = separator;
      bestCount = count;
    }
  }

  if (bestSeparator === null) return `{part1}${extension}`;

  const parts = Array.from({ length: bestCount }, (_, i) => `{part${i + 1}}`);
  return parts.join(bestSeparator) + extension;
}

/**
 * A profile that is valid and runnable immediately: the attachment column, plus
 * the three fields almost every contribution needs.
 *
 * Title and creator are wired to the document properties that state them.
 * That is not a guess -- a PDF's `/Info Title` and a Word file's `dc:creator`
 * say what they are. Wiring a filename part to a field WOULD be a guess: the
 * program can see a name has four parts but cannot know part 2 is a first
 * name rather than an accession number, so no filename part is mapped here and
 * the operator does that themselves.
 *
 * Description is offered as an empty column deliberately. No document property
 * means "description" unambiguously -- PDF's `/Subject` is close but not the
 * same thing -- and inventing one would put a wrong value somewhere nobody
 * would think to look. An empty column is a legitimate, useful thing: somewhere
 * to type in Excel.
 *
 * Every path here is checked against the real schema by a test, because a
 * profile naming a field that does not exist is rejected at load time and this
 * is the one profile nobody chose to write.
 */
export function starterProfile(filenames: string[]): Profile {
  return {
    version: 1,
    pattern: detectPattern(filenames),
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/title', sources: [{ property: 'title' }] },
      { path: 'MWDL/creators/creator', sources: [{ property: 'author' }] },
      { path: 'MWDL/description', sources: [] },
    ],
  };
}
