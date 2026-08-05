// src/core/extract/types.ts

/** The reserved column naming the file on disk. Always first, never removable. */
export const ATTACHMENT_COLUMN = 'attachment name';

/** Document properties we read, normalised across PDF and .docx. */
export type DocumentProperty = 'title' | 'author' | 'subject' | 'keywords' | 'created';

export const DOCUMENT_PROPERTIES: readonly DocumentProperty[] = [
  'title',
  'author',
  'subject',
  'keywords',
  'created',
];

/**
 * Where a column's value can come from. Tried in the order they appear in
 * `Column.sources`; the first non-empty result wins and nothing later
 * overwrites it.
 */
export type Source =
  /** A single `{placeholder}` from the filename pattern. */
  | { placeholder: string }
  /** Several placeholders combined, e.g. "{last}, {first}". */
  | { join: string }
  /** A `Label:` line found in the document text. */
  | { label: string }
  /** An embedded document property. */
  | { property: DocumentProperty }
  /** The filename itself, verbatim. Only used by ATTACHMENT_COLUMN. */
  | { filename: true };

/** How a date column is normalised: automatically, or by a format the profile declares. */
export type DateTransform = 'date' | { date: string };

export interface Column {
  /** A schema xpath, or ATTACHMENT_COLUMN. Becomes the spreadsheet header. */
  path: string;
  sources: Source[];
  /** Used when every source came back empty. A column with no sources and a default is a constant. */
  default?: string;
  /**
   * Normalise a recognised date to YYYY-MM-DD. Never discards an unrecognised
   * value -- it is kept as found and noted.
   *
   * `'date'` recognises unambiguous forms only. A compact date such as
   * `12032025` is refused, because it reads as 3 December or 12 March
   * depending on who wrote it and the file does not say which.
   *
   * `{ date: 'MMDDYYYY' }` states the format, so the value can be read without
   * guessing. Tokens are YYYY, MM and DD, each exactly once, with any literal
   * separators: `MMDDYYYY`, `YYYYMMDD`, `DD-MM-YYYY`.
   */
  transform?: DateTransform;
  /** True only for ATTACHMENT_COLUMN. Blocks removal, reordering and retargeting. */
  locked?: boolean;
}

export interface Profile {
  version: 1;
  /** e.g. "{last}_{first}_{title}_{date}.pdf" */
  pattern: string;
  columns: Column[];
}

/** What a reader returns for one file. */
export interface DocumentData {
  /** Extracted text. Empty string when there is none. */
  text: string;
  /** False for a scanned PDF with no text layer. */
  hasTextLayer: boolean;
  properties: Partial<Record<DocumentProperty, string>>;
}

/** One output row, before serialisation. */
export interface ExtractedRow {
  /** Keyed by column path. Every column in the profile is present, possibly empty. */
  cells: Record<string, string>;
  /** Column path -> which source filled it. Only filled columns appear. */
  sources: Record<string, string>;
  /** Human-readable problems with this row. */
  notes: string[];
}

export interface ExtractResult {
  rows: ExtractedRow[];
  /** Files that could not be read at all, with the reason. */
  skipped: { file: string; reason: string }[];
}
