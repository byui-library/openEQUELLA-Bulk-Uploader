// src/core/extract/rows.ts
import { applyPattern } from './pattern.js';
import { findLabels } from './labels.js';
import { readSection } from './sections.js';
import { readOpening } from './opening.js';
import { dateNear, datePair } from './dates.js';
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

  if ('dateNear' in source) return { value: dateNear(context.doc.text, source.dateNear) };

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

  return { value: context.doc.properties[source.property] ?? '' };
}

function fill(column: Column, context: Context, notes: string[]): { value: string; source?: string } {
  for (const source of column.sources) {
    const resolved = resolve(source, context);
    const raw = resolved.value.trim();
    if (raw === '') continue;
    if (resolved.note !== undefined) notes.push(`${column.path}: ${resolved.note}`);

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

  // Two passes, because a composed column reads other columns' FINISHED values
  // -- after their transforms, not the raw text they came from. Composed
  // columns cannot read each other; profile.ts rejects that at load, which is
  // what makes one extra pass sufficient and a cycle impossible.
  const isComposed = (c: Column) => c.sources.some((s) => 'compose' in s);

  for (const column of profile.columns.filter((c) => !isComposed(c))) {
    const { value, source } = fill(column, context, notes);
    cells[column.path] = column.path === ATTACHMENT_COLUMN ? filename : value;
    if (source !== undefined && cells[column.path] !== '') sources[column.path] = source;
    if (column.as !== undefined) context.composed[column.as] = cells[column.path] ?? '';
  }

  for (const column of profile.columns.filter(isComposed)) {
    const { value, source } = fill(column, context, notes);
    cells[column.path] = value;
    if (source !== undefined && value !== '') sources[column.path] = source;
  }

  if (profile.checks?.filenameWordsInText) {
    const missing = missingFilenameWords(
      filename,
      doc.text,
      profile.checks.filenameWordsInText.ignore ?? [],
    );
    if (missing.length > 0) {
      notes.push(
        `the file is named '${filename}' but the document does not contain ` +
          `${missing.map((w) => `'${w}'`).join(', ')} -- check the spelling before uploading`,
      );
    }
  }

  return { cells, sources, notes };
}
