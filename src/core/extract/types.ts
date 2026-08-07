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
  /**
   * A cell from a table, taken from the column whose header is this name.
   * Word documents commonly hold their metadata as a header row and one row of
   * values; this reads a named field out of that.
   */
  | { tableColumn: string }
  /**
   * Text under a heading, ending at the next heading. A journal article states
   * its description under "Abstract"; a report under "Summary" or "Overview".
   */
  | { section: string }
  /**
   * The document's first substantial paragraph.
   *
   * The only source that is a guess rather than a reading, so every value it
   * produces is flagged in `_notes`. Meant as the last thing tried before a
   * blank cell.
   */
  | { opening: true }
  /**
   * The filename with its extension removed.
   *
   * A poor title, but a real one. Two of twelve journal PDFs in a real batch
   * carry no title property, and `MWDL/title` becomes the item's NAME in
   * openEQUELLA -- so without this those two are contributed nameless.
   */
  | { filenameStem: true }
  /**
   * The first date written in words following any of these phrases.
   * "passed away on January 4, 2024".
   */
  | { dateNear: string[] }
  /**
   * One half of a name-and-dates line: `June 19, 1957 - January 6, 2024`.
   * Four of ten real obituaries state the dates this way, with no phrase to
   * anchor on.
   */
  | { datePair: 'first' | 'second' }
  /**
   * Built from other columns' values rather than from the document. Referenced
   * columns are named by their `as`, and are filled in an earlier pass.
   */
  | { compose: string }
  /** The filename itself, verbatim. Only used by ATTACHMENT_COLUMN. */
  | { filename: true };

/** How a date column is normalised: automatically, or by a format the profile declares. */
export type DateTransform = 'date' | { date: string };

/** How a column's raw value is normalised before it reaches the spreadsheet. */
export type Transform = DateTransform | 'people';

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
  transform?: Transform;
  /** True only for ATTACHMENT_COLUMN. Blocks removal, reordering and retargeting. */
  locked?: boolean;
  /**
   * A short name other columns' `compose` templates can refer to. Without one,
   * a column cannot be referenced -- xpaths are far too long to write inside a
   * template, and naming the reference explicitly means renaming a column
   * cannot silently break one.
   */
  as?: string;
}

export interface Profile {
  version: 1;
  /** e.g. "{last}_{first}_{title}_{date}.pdf" */
  pattern: string;
  columns: Column[];
  /** Checks that report on a row without producing a value. */
  checks?: {
    /**
     * Flag a row when a word from its filename does not appear in the
     * document. `ignore` lists words that carry no signal for this collection,
     * such as "Obituary" in every filename of an obituary batch.
     */
    filenameWordsInText?: { ignore?: string[] };
  };
}

/**
 * A table found in a document, as its header row and the rows beneath it.
 *
 * Word documents very often carry their metadata this way rather than as
 * `Label: value` prose -- a header row naming the fields and one row holding
 * the values. Flattening that to lines loses the cell boundaries entirely: a
 * cell containing four paragraphs becomes four lines with nothing marking where
 * the next field begins, so the structure has to survive the reader.
 */
export interface DocumentTable {
  headers: string[];
  rows: string[][];
}

/** What a reader returns for one file. */
export interface DocumentData {
  /** Extracted text. Empty string when there is none. */
  text: string;
  /** False for a scanned PDF with no text layer. */
  hasTextLayer: boolean;
  properties: Partial<Record<DocumentProperty, string>>;
  /** Tables found in the document, header row first. Empty for formats without them. */
  tables: DocumentTable[];
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
