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
 * Where several fields share a leaf name, one section wins: `MWDL/description`
 * rather than `BYUI_extended/…/description`. That section holds the
 * descriptive fields nearly every item needs; the others are specialised.
 *
 * WHICH section is not a constant. `preferSection` is the top-level section the
 * schema's own declared item-name path lives in -- `MWDL` at BYU-Idaho, so the
 * behaviour there is unchanged, and whatever the local schema calls its main
 * section anywhere else. Hardcoding `MWDL/` meant the tie-break simply never
 * fired at another institution, quietly falling through to the shortest match.
 * With no section to prefer that fallback is still what happens.
 */
export function matchSchemaPath(
  name: string,
  schemaPaths: Set<string>,
  preferSection?: string | null,
): string | null {
  const lastWord = name.trim().split(/\s+/).pop()?.toLowerCase();
  if (lastWord === undefined || lastWord === '') return null;

  const matches = [...schemaPaths].filter(
    (p) => (p.split('/').pop() ?? '').toLowerCase() === lastWord,
  );
  if (matches.length === 0) return null;

  const shortestFirst = (a: string, b: string): number => a.length - b.length;
  if (preferSection) {
    const preferred = matches.filter((p) => p.startsWith(`${preferSection}/`)).sort(shortestFirst);
    if (preferred[0]) return preferred[0];
  }
  return matches.sort(shortestFirst)[0]!;
}

/** What a scan of the folder found, for proposing mappings. */
export interface StarterEvidence {
  labels: string[];
  properties: string[];
  tableColumns: string[];
  /** Headings found in the documents, from `findSections`. */
  sections: string[];
}

/**
 * What the schema declares, as much of it as a starter profile needs.
 *
 * Structurally a subset of `discovery.ts#SchemaInfo`, so a fetched schema can
 * be passed straight in; a caller reading the bundled XML export instead builds
 * one from `schema.ts` (`extractItemNamePath`, `extractItemDescriptionPath`,
 * `parseSchemaPaths`). Declared here rather than imported so `src/core/extract/`
 * keeps owning its own inputs.
 */
export interface StarterSchema {
  /** The declared item name path, header form. Null when the schema declares none. */
  titleHeader: string | null;
  /** The declared description path, header form. Null when the schema declares none. */
  descriptionHeader: string | null;
  /** Every valid xpath, leaves only. */
  paths: Set<string>;
}

/** A declared path, but only if the schema really has a field there. */
function declaredColumn(header: string | null, paths: Set<string>): string | null {
  // Membership is checked, not assumed. A path that is declared but absent from
  // the definition is exactly the column the picker flags invalid, which is the
  // whole failure this reads the schema to avoid -- proposing it because the
  // schema named it would reproduce the bug from the other direction.
  return header && paths.has(header) ? header : null;
}

/** The top-level section a header sits in: `MWDL/title` -> `MWDL`. */
function topSection(header: string | null): string | null {
  return header?.split('/')[0] ?? null;
}

/**
 * A profile that is valid and runnable immediately.
 *
 * EVERY COLUMN COMES OUT OF THE SCHEMA HANDED IN. The three fields almost every
 * contribution needs used to be the literals `MWDL/title`,
 * `MWDL/creators/creator` and `MWDL/description` -- BYU-Idaho's, proposed
 * whatever schema this was given, so the extractor's very first output at any
 * other institution contained three columns the column picker immediately
 * flagged invalid. Title and description are read from what the schema declares
 * (`titleHeader`, `descriptionHeader`); the creator has no declared equivalent,
 * so it is matched against the schema's real paths by leaf name and OMITTED
 * when nothing matches. A missing column is the smaller harm: the operator adds
 * what they need and the picker already supports that, whereas an invented path
 * is a mistake they have to recognise first.
 *
 * With no evidence it proposes the attachment column plus those fields, wiring
 * title and creator to the document properties that state them.
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
export function starterProfile(
  filenames: string[],
  schema: StarterSchema,
  evidence?: StarterEvidence,
): Profile {
  const section = topSection(schema.titleHeader);
  const titlePath = declaredColumn(schema.titleHeader, schema.paths);
  const descriptionPath = declaredColumn(schema.descriptionHeader, schema.paths);
  // `creator` first, then `author`: both are real spellings of the same field
  // and a schema carrying both means the one it calls a creator. Leaf-name
  // matching finds `creators/creator` as readily as a bare `creator`.
  const creatorPath =
    matchSchemaPath('creator', schema.paths, section) ??
    matchSchemaPath('author', schema.paths, section);

  const columns: Column[] = [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
  ];
  // The filename last, so a document that states its title keeps it. Two of
  // twelve real journal PDFs state none, and this field becomes the item's
  // NAME -- an empty one contributes a nameless item.
  if (titlePath) {
    columns.push({ path: titlePath, sources: [{ property: 'title' }, { filenameStem: true }] });
  }
  if (creatorPath) {
    columns.push({ path: creatorPath, sources: [{ property: 'author' }], transform: 'people' });
  }
  if (descriptionPath) columns.push({ path: descriptionPath, sources: [] });

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
      path: matchSchemaPath(tableColumn, schema.paths, section) ?? '',
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
  // The schema's own declared description path, not a literal: a schema that
  // declares none gets no section sources and no opening fallback, because
  // there is no column for them to land in.
  const description = descriptionPath ? byPath.get(descriptionPath) : undefined;
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
