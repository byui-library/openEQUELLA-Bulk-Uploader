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

/** A short name for where a value came from, written into the _source column. */
function sourceKind(source: Source): string {
  if ('filename' in source) return 'filename';
  if ('placeholder' in source || 'join' in source) return 'filename';
  if ('label' in source) return 'label';
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

  return context.doc.properties[source.property] ?? '';
}

function fill(column: Column, context: Context, notes: string[]): { value: string; source?: string } {
  for (const source of column.sources) {
    const raw = resolve(source, context).trim();
    if (raw === '') continue;

    if (column.transform === 'date') {
      const normalised = normaliseDate(raw);
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
