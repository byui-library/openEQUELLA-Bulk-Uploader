// src/core/extract/rows.ts
import { applyPattern } from './pattern.js';
import { findLabels } from './labels.js';
import { readSection } from './sections.js';
import { readOpening } from './opening.js';
import { datesNear, datePair } from './dates.js';
import { composeValue } from './compose.js';
import { missingFilenameWords } from './names.js';
import type { Column, DocumentData, ExtractedRow, Profile, Source } from './types.js';
import { ATTACHMENT_COLUMN } from './types.js';

/**
 * An ISO date, optionally followed by a time and offset. The date part is
 * taken verbatim and `Date` is never involved, because it must not be:
 * `new Date('2025-12-04T01:00:00Z')` read through local date parts yields
 * December the 3rd anywhere west of UTC. Word writes its `created` property
 * as a UTC timestamp, so that silently shifted the day on real documents --
 * with no note, because nothing had gone wrong as far as the code knew.
 */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;

/**
 * Normalise a recognised date to YYYY-MM-DD, or return null. Deliberately
 * conservative: only an ISO date or a form Date.parse handles unambiguously.
 * A wrong date is worse than an un-normalised one, and the caller keeps the
 * original either way.
 */
export function normaliseDate(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const iso = ISO_DATE.exec(trimmed);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // Require a four-digit year somewhere, so that "Recital_2026" and other
  // half-dates are rejected rather than coerced into January the 1st.
  if (!/\b\d{4}\b/.test(trimmed)) return null;
  if (/^\d{4}$/.test(trimmed)) return null;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;

  const year = String(parsed.getFullYear()).padStart(4, '0');
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parse a date using a format the profile declares, e.g. `MMDDYYYY`.
 *
 * A compact date is genuinely ambiguous -- `12032025` is 3 December to one
 * reader and 12 March to another, and nothing in the file says which. Rather
 * than guess, the operator states the convention once; they know it and the
 * document does not record it.
 *
 * Anything not matching the declared format returns null, so it is kept as
 * found and noted rather than coerced. Declaring a format buys precision, not
 * permissiveness.
 */
export function normaliseDateWithFormat(value: string, format: string): string | null {
  const order: ('Y' | 'M' | 'D')[] = [];
  let source = '^';

  for (let i = 0; i < format.length; ) {
    const rest = format.slice(i);
    if (rest.startsWith('YYYY')) {
      order.push('Y');
      source += '(\\d{4})';
      i += 4;
    } else if (rest.startsWith('MM')) {
      order.push('M');
      source += '(\\d{2})';
      i += 2;
    } else if (rest.startsWith('DD')) {
      order.push('D');
      source += '(\\d{2})';
      i += 2;
    } else {
      // Separators are literal. Escaping matters: a format of "MM.DD.YYYY"
      // must not quietly accept "12x03x2025".
      source += format[i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }

  const match = new RegExp(`${source}$`).exec(value.trim());
  if (!match) return null;

  const parts: Partial<Record<'Y' | 'M' | 'D', string>> = {};
  order.forEach((key, n) => {
    parts[key] = match[n + 1];
  });
  const { Y: year, M: month, D: day } = parts;
  if (year === undefined || month === undefined || day === undefined) return null;

  // Reject a value that fits the shape but is not a real date -- 02302025
  // matches MMDDYYYY perfectly. Built in UTC so no timezone can shift it.
  const asDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    asDate.getUTCFullYear() !== Number(year) ||
    asDate.getUTCMonth() !== Number(month) - 1 ||
    asDate.getUTCDate() !== Number(day)
  ) {
    return null;
  }

  return `${year}-${month}-${day}`;
}

/**
 * Separate a list of people into semicolon-delimited values, but only where
 * the string cannot be a single name.
 *
 * A comma means two different things in real author strings. "Dixon, Matt" is
 * one person written surname-first; "Dan Weaving, Ben Jones" is two people.
 * Both appear in the same folder, so no rule reading commas alone gets both
 * right — and inventing a second author in a permanent catalogue record is
 * exactly the kind of confident wrongness this tool avoids.
 *
 * So a split happens only on evidence:
 *
 * - the string contains " and ", which nobody writes inside one name; or
 * - it has three or more comma-separated parts, which no single name has.
 *
 * A two-part string is left exactly as found and reported as ambiguous, so the
 * row carries a note and a human decides. That is the common "Surname, Given"
 * case, and guessing at it would be wrong about half the time.
 */
export function splitPeople(value: string): { value: string; ambiguous: boolean } {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.includes(';')) return { value, ambiguous: false };

  const hasAnd = / and /i.test(trimmed);
  const parts = trimmed
    .split(/\s+and\s+|,/i)
    .map((p) => p.trim())
    .filter((p) => p !== '');

  if (hasAnd || parts.length >= 3) return { value: parts.join('; '), ambiguous: false };
  // Exactly two parts and no "and": "Dixon, Matt" or "Weaving, Dan" — one
  // person far more often than two, but not certainly, so say so.
  return { value, ambiguous: parts.length === 2 };
}

/** A short name for where a value came from, written into the _source column. */
function sourceKind(source: Source): string {
  if ('filename' in source || 'filenameStem' in source) return 'filename';
  if ('placeholder' in source || 'join' in source) return 'filename';
  if ('label' in source) return 'label';
  if ('tableColumn' in source) return 'table';
  if ('section' in source) return 'section';
  if ('opening' in source) return 'opening';
  if ('dateNear' in source) return 'dateNear';
  if ('datePair' in source) return 'datePair';
  if ('compose' in source) return 'compose';
  return 'properties';
}

interface Context {
  filename: string;
  parts: Record<string, string> | null;
  labels: Map<string, string>;
  doc: DocumentData;
  /** Alias -> finished value, from the first pass. Empty during that pass. */
  composed: Record<string, string>;
}

/**
 * What a source yielded, and anything the operator should know about how.
 *
 * `note` is attached to the value rather than pushed directly, so it is only
 * recorded if this source is the one that actually filled the cell -- an
 * earlier source winning must not leave a note about a later candidate, and a
 * candidate that yielded nothing has nothing to say.
 */
interface Resolved {
  value: string;
  note?: string;
}

function resolve(source: Source, context: Context): Resolved {
  if ('filename' in source) return { value: context.filename };

  if ('filenameStem' in source) {
    // Only the LAST extension. Titles in a real batch are full of dots --
    // "22. Salazar_proof_10pix1line_revised" -- and cutting at the first would
    // leave "22".
    return { value: context.filename.replace(/\.[^.\\/]+$/, '') };
  }

  if ('placeholder' in source) return { value: context.parts?.[source.placeholder] ?? '' };

  if ('join' in source) {
    if (!context.parts) return { value: '' };
    const parts = context.parts;
    let missing = false;
    const joined = source.join.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const value = parts[name] ?? '';
      if (value === '') missing = true;
      return value;
    });
    // A join with a hole in it produces "Smith, " -- worse than nothing,
    // because it looks deliberate. Treat it as no value and let the next
    // source have its turn.
    return { value: missing ? '' : joined };
  }

  if ('label' in source) return { value: context.labels.get(source.label) ?? '' };

  if ('section' in source) {
    const { text, capped, midSentence } = readSection(context.doc.text, source.section);
    let note: string | undefined;
    if (capped) {
      note = `the '${source.section}' section never ended and was cut short -- check it is really a description`;
    } else if (midSentence) {
      note = `'${source.section}' was a word in a sentence here, not a heading -- the sentence was taken instead`;
    }
    return { value: text, note };
  }

  if ('opening' in source) {
    // Always noted, without exception. This is the one source that infers
    // rather than reads, and a guess presented like a fact is the failure mode
    // this whole tool is built to avoid.
    return {
      value: readOpening(context.doc.text),
      note: 'taken from the start of the document, which may not be a description -- please check',
    };
  }

  if ('dateNear' in source) {
    const found = datesNear(context.doc.text, source.dateNear);
    return {
      value: found[0] ?? '',
      // An obituary almost always names someone else's death -- "preceded in
      // death by his wife Ivy, who passed away on November 8, 1994" appears in
      // nearly every one. Nothing can reliably tell whose death a sentence
      // describes, so the first is taken and the row says what else was there.
      note:
        found.length > 1
          ? `more than one date was found near those words (${found.join(', ')}); ` +
            `the first was used -- check it is the right one`
          : undefined,
    };
  }

  if ('presence' in source) {
    // Case-insensitive, because a scanned document capitalises headings and one
    // real obituary writes "Rick's College" with an apostrophe. Plain substring
    // rather than word boundaries: these phrases are multi-word proper nouns,
    // so the 'died' inside 'studied' trap that word boundaries exist to prevent
    // cannot arise here.
    const text = context.doc.text.toLowerCase();
    const present = source.presence.any.some((phrase) => text.includes(phrase.toLowerCase()));
    return { value: present ? source.presence.then : '' };
  }

  if ('datePair' in source) return { value: datePair(context.doc.text, source.datePair) };

  if ('compose' in source) return { value: composeValue(source.compose, context.composed) };

  if ('tableColumn' in source) {
    const wanted = source.tableColumn.trim().toLowerCase();
    for (const table of context.doc.tables) {
      const index = table.headers.findIndex((h) => h.trim().toLowerCase() === wanted);
      // Only the FIRST data row. One document describes one item here, and
      // every real example has exactly one row under the header. Concatenating
      // several would invent a value nobody wrote.
      if (index !== -1) return { value: table.rows[0]?.[index] ?? '' };
    }
    return { value: '' };
  }

  // A marker, not a fetch. `resolve` is synchronous and `src/core/extract/`
  // never touches the network -- the property that lets an operator build a
  // spreadsheet without signing in to anything. The async pass in
  // `core/ai/fill.ts` acts on the marker after the row is finished.
  if ('ai' in source) return { value: '' };

  return { value: context.doc.properties[source.property] ?? '' };
}

/**
 * `flagged` records the SAME note against the column it came from, so a
 * finished row can be asked about one cell rather than only read as prose.
 * Only a `Resolved` note counts: it is the tier saying "this value is a guess".
 * The transform notes below are about a value the document really did state --
 * an unrecognised date, an ambiguous name list -- so they stay out of it.
 */
function fill(
  column: Column,
  context: Context,
  notes: string[],
  flagged: Record<string, string>,
): { value: string; source?: string } {
  for (const source of column.sources) {
    const resolved = resolve(source, context);
    const raw = resolved.value.trim();
    if (raw === '') continue;
    if (resolved.note !== undefined) {
      notes.push(`${column.path}: ${resolved.note}`);
      flagged[column.path] = resolved.note;
    }

    if (column.transform === 'people') {
      const { value, ambiguous } = splitPeople(raw);
      if (ambiguous) {
        notes.push(
          `${column.path}: '${raw}' may be one name or two - separate them with a semicolon if it is two`,
        );
      }
      return { value, source: sourceKind(source) };
    }

    if (column.transform !== undefined) {
      const normalised =
        column.transform === 'date'
          ? normaliseDate(raw)
          : normaliseDateWithFormat(raw, column.transform.date);
      if (normalised === null) {
        notes.push(`${column.path}: '${raw}' was not recognised as a date and was left as found`);
        return { value: raw, source: sourceKind(source) };
      }
      return { value: normalised, source: sourceKind(source) };
    }

    return { value: raw, source: sourceKind(source) };
  }

  if (column.default !== undefined) return { value: column.default, source: 'default' };
  return { value: '' };
}

/**
 * Build one output row. Never throws and never omits a column: a file that
 * yields nothing usable still produces a row, flagged in `notes`. A file
 * missing from the output must be indistinguishable from a file that was
 * never in the folder -- so it never is.
 */
export function buildRow(profile: Profile, filename: string, doc: DocumentData): ExtractedRow {
  const notes: string[] = [];

  const parts = applyPattern(profile.pattern, filename);
  // Only worth saying if a column actually reads a piece of the filename. A
  // mixed folder gets one pattern carrying one extension, so a folder of 18
  // Word files and 12 PDFs flagged all twelve PDFs for not matching a `.docx`
  // pattern that nothing was reading -- twelve warnings, no consequence.
  const usesParts = profile.columns.some((column) =>
    column.sources.some((source) => 'placeholder' in source || 'join' in source),
  );
  if (parts === null && usesParts) {
    notes.push(`filename does not match the pattern '${profile.pattern}'`);
  }
  if (!doc.hasTextLayer) {
    notes.push('no text layer -- nothing could be read from inside this file');
  }

  const context: Context = {
    filename,
    parts,
    labels: findLabels(doc.text),
    doc,
    composed: {},
  };

  const cells: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const flagged: Record<string, string> = {};

  // Two passes, because a composed column reads other columns' FINISHED values
  // -- after their transforms, not the raw text they came from. Composed
  // columns cannot read each other; profile.ts rejects that at load, which is
  // what makes one extra pass sufficient and a cycle impossible.
  const isComposed = (c: Column) => c.sources.some((s) => 'compose' in s);

  for (const column of profile.columns.filter((c) => !isComposed(c))) {
    const { value, source } = fill(column, context, notes, flagged);
    const finished = column.path === ATTACHMENT_COLUMN ? filename : value;
    if (column.as !== undefined) context.composed[column.as] = finished;

    // A composeOnly column is extracted only so a compose template can read it.
    // It is named above and then dropped: giving it a cell would write the value
    // into a schema field that means something else, permanently.
    if (column.composeOnly) continue;

    cells[column.path] = finished;
    if (source !== undefined && finished !== '') sources[column.path] = source;
  }

  for (const column of profile.columns.filter(isComposed)) {
    const { value, source } = fill(column, context, notes, flagged);
    // The same override as the first pass. profile.ts rejects a composed
    // attachment column, but the two passes applying different rules is how
    // that got through review at all -- a row naming something that is not a
    // file breaks the one-file-one-item relationship the whole tool rests on.
    cells[column.path] = column.path === ATTACHMENT_COLUMN ? filename : value;
    if (source !== undefined && value !== '') sources[column.path] = source;
  }

  // For a templated collection there is usually one field the template exists
  // to find. Alden Larkspar -- the one obituary of ten with no date at all --
  // was flagged only because his filename happened to be misspelled too;
  // correct the filename and the batch's single genuine failure looked clean.
  for (const column of profile.columns) {
    if (column.flagIfEmpty && (cells[column.path] ?? '') === '') {
      // Says what to do, and that a blank may be the RIGHT answer. Alden
      // Larkspar's obituary states no date anywhere -- only "the early hours of
      // Saturday morning" -- so leaving his blank is correct, not a failure to
      // fix. A note that only reported the absence invited someone to invent a
      // value, which is the failure this whole tool is built to avoid. The
      // xpath stays so it is obvious which column to edit.
      notes.push(
        `nothing could be found for '${column.path}', which this template expects. ` +
          `Fill that cell in by hand, or leave it blank if the document genuinely does not say.`,
      );
    }
  }

  if (profile.checks?.filenameWordsInText) {
    const missing = missingFilenameWords(
      filename,
      doc.text,
      profile.checks.filenameWordsInText.ignore ?? [],
    );
    if (missing.length > 0) {
      // Says what to DO and why it matters, not just what was noticed. The
      // filename becomes this item's name in openEQUELLA, so a misspelling
      // here is catalogued permanently -- and the document, not the filename,
      // is the authority on how the person's name is spelled.
      notes.push(
        `check this filename: the document does not contain ` +
          `${missing.map((w) => `'${w}'`).join(', ')}, so '${filename}' may be misspelled. ` +
          `The filename becomes this item's title, so correct it before uploading if the ` +
          `document is right.`,
      );
    }
  }

  return { cells, sources, notes, flagged };
}
