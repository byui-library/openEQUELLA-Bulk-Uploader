// src/core/extract/rows.ts
import { applyPattern } from './pattern.js';
import { findLabels } from './labels.js';
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

/** A short name for where a value came from, written into the _source column. */
function sourceKind(source: Source): string {
  if ('filename' in source) return 'filename';
  if ('placeholder' in source || 'join' in source) return 'filename';
  if ('label' in source) return 'label';
  if ('tableColumn' in source) return 'table';
  return 'properties';
}

interface Context {
  filename: string;
  parts: Record<string, string> | null;
  labels: Map<string, string>;
  doc: DocumentData;
}

function resolve(source: Source, context: Context): string {
  if ('filename' in source) return context.filename;

  if ('placeholder' in source) return context.parts?.[source.placeholder] ?? '';

  if ('join' in source) {
    if (!context.parts) return '';
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
    return missing ? '' : joined;
  }

  if ('label' in source) return context.labels.get(source.label) ?? '';

  if ('tableColumn' in source) {
    const wanted = source.tableColumn.trim().toLowerCase();
    for (const table of context.doc.tables) {
      const index = table.headers.findIndex((h) => h.trim().toLowerCase() === wanted);
      // Only the FIRST data row. One document describes one item here, and
      // every real example has exactly one row under the header. Concatenating
      // several would invent a value nobody wrote.
      if (index !== -1) return table.rows[0]?.[index] ?? '';
    }
    return '';
  }

  return context.doc.properties[source.property] ?? '';
}

function fill(column: Column, context: Context, notes: string[]): { value: string; source?: string } {
  for (const source of column.sources) {
    const raw = resolve(source, context).trim();
    if (raw === '') continue;

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
  if (parts === null) {
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
  };

  const cells: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const column of profile.columns) {
    const { value, source } = fill(column, context, notes);
    cells[column.path] = column.path === ATTACHMENT_COLUMN ? filename : value;
    if (source !== undefined && cells[column.path] !== '') sources[column.path] = source;
  }

  return { cells, sources, notes };
}
