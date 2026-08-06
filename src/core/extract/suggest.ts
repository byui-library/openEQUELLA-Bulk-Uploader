// src/core/extract/suggest.ts
import { extname } from 'node:path';
import { ATTACHMENT_COLUMN, type Column, type Profile, type Source } from './types.js';
import { isSupported } from './readers/index.js';
import { SECTION_HEADINGS } from './sections.js';

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
 * The schema field a human-written name refers to, or null.
 *
 * Real evidence is named for people: a Word table heading says "Job Title", not
 * "MWDL/title". Matching the LAST WORD of the name against the schema's leaf
 * element reads those without guessing at meaning — "Job Title" is a title,
 * "Job Description" is a description, and "Company" and "Pay" match nothing, so
 * nothing is proposed for them.
 *
 * Where several fields share a leaf name, MWDL wins: `MWDL/description` rather
 * than `MWDL/rights/description`. MWDL holds the descriptive fields nearly
 * every item needs; the others are specialised.
 */
export function matchSchemaPath(name: string, schemaPaths: Set<string>): string | null {
  const lastWord = name.trim().split(/\s+/).pop()?.toLowerCase();
  if (lastWord === undefined || lastWord === '') return null;

  const matches = [...schemaPaths].filter(
    (p) => (p.split('/').pop() ?? '').toLowerCase() === lastWord,
  );
  if (matches.length === 0) return null;

  const mwdl = matches.filter((p) => p.startsWith('MWDL/')).sort((a, b) => a.length - b.length);
  return mwdl[0] ?? matches.sort((a, b) => a.length - b.length)[0]!;
}

/** What a scan of the folder found, for proposing mappings. */
export interface StarterEvidence {
  labels: string[];
  properties: string[];
  tableColumns: string[];
  /** Headings found in the documents, from `findSections`. */
  sections: string[];
  schemaPaths: Set<string>;
}

/**
 * A profile that is valid and runnable immediately.
 *
 * With no evidence it proposes the attachment column plus the three fields
 * almost every contribution needs, wiring title and creator to the document
 * properties that state them.
 *
 * Given evidence from a scan it does better: a table heading or document label
 * whose name matches a schema field is mapped to it. That is what makes a real
 * batch useful straight away — the Word documents here keep their description
 * in a table cell headed "Job Description", and without this the description
 * column came out empty on every row of every run.
 *
 * A table column is preferred over a label for the same field: a table cell is
 * a stated field, whereas a label match is a line of prose that happened to
 * look like one.
 *
 * Nothing is proposed for a name with no schema counterpart. "Company" and
 * "Pay" are real headings in these documents and mean nothing to this schema,
 * so they are left alone rather than mapped somewhere plausible.
 */
export function starterProfile(filenames: string[], evidence?: StarterEvidence): Profile {
  const columns: Column[] = [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    // The filename last, so a document that states its title keeps it. Two of
    // twelve real journal PDFs state none, and this field becomes the item's
    // NAME -- an empty one contributes a nameless item.
    { path: 'MWDL/title', sources: [{ property: 'title' }, { filenameStem: true }] },
    { path: 'MWDL/creators/creator', sources: [{ property: 'author' }], transform: 'people' },
    { path: 'MWDL/description', sources: [] },
  ];

  if (evidence === undefined) return { version: 1, pattern: detectPattern(filenames), columns };

  const byPath = new Map(columns.map((c) => [c.path, c]));

  // ONLY table columns are mapped automatically. A table header is a stated
  // field: the document says "this cell is the Job Description". A `Label:`
  // match is a line of prose that happened to look like a field, and on real
  // documents that produced noise -- a "Citation" line in an academic paper
  // becoming a mapped column nobody asked for, and once a table row reading
  // "Budget: $250-750/month". Labels remain available in the dropdown, chosen
  // deliberately rather than proposed.
  const found: { source: Source; path: string }[] = evidence.tableColumns
    .map((tableColumn) => ({
      source: { tableColumn } as Source,
      path: matchSchemaPath(tableColumn, evidence.schemaPaths) ?? '',
    }))
    .filter((m) => m.path !== '' && m.path !== ATTACHMENT_COLUMN);

  for (const { source, path } of found) {
    const existing = byPath.get(path);
    if (existing) {
      // Prepended, NOT replacing. A mixed folder needs both: the Word files
      // carry their title in a table cell, the PDFs in a document property.
      // Replacing the property source left every PDF's title blank -- one
      // profile has to serve the whole folder, and that is what an ordered
      // source list is for.
      existing.sources = [source, ...existing.sources];
    } else {
      const column: Column = { path, sources: [source] };
      columns.push(column);
      byPath.set(path, column);
    }
  }

  // Sections go LAST, and only on the description.
  //
  // Last, because a stated field outranks a place a description usually lives:
  // a cell headed "Job Description" is the document saying what its description
  // is, whereas an abstract is a convention. Only the description, because a
  // section is a body of prose and no other field in this schema is.
  //
  // All of them, in the order SECTION_HEADINGS declares rather than the order
  // they happened to appear. One profile serves the whole folder, so a folder
  // where most files have an Abstract and one has only a Purpose is filled
  // completely -- per file, the first source with anything in it wins.
  const description = byPath.get('MWDL/description');
  if (description) {
    const ranked = SECTION_HEADINGS.filter((h) => evidence.sections.includes(h));
    description.sources = [
      ...description.sources,
      ...ranked.map((section) => ({ section })),
      // Behind everything, so it only ever competes with a blank cell -- and
      // it arrives with a note saying it was a guess. The description column
      // came out empty on every row of three real runs before this existed;
      // "sometimes right and always visible" beats "always empty".
      { opening: true },
    ];
  }

  return { version: 1, pattern: detectPattern(filenames), columns };
}
