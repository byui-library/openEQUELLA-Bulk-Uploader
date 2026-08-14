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
   * "passed away on November 4, 2211".
   */
  | { dateNear: string[] }
  /**
   * One half of a name-and-dates line: `March 9, 2146 - December 4, 2211`.
   * Four of ten real obituaries state the dates this way, with no phrase to
   * anchor on.
   */
  | { datePair: 'first' | 'second' }
  /**
   * Built from other columns' values rather than from the document. Referenced
   * columns are named by their `as`, and are filled in an earlier pass.
   */
  | { compose: string }
  /**
   * Fixed text, emitted when any of these phrases appears in the document.
   *
   * Reports a fact the document evidences rather than one it states in a
   * capturable form: an obituary mentions Ricks College a dozen ways, and none
   * of them is a field.
   */
  | { presence: { any: string[]; then: string } }
  /** The filename itself, verbatim. Only used by ATTACHMENT_COLUMN. */
  | { filename: true }
  /**
   * Ask a language model, in the async pass that runs after extraction.
   *
   * A MARKER, NOT A FETCH. `resolve` returns empty for it -- extraction is
   * synchronous, pure and offline, and stays that way. A later async pass
   * reads the finished rows and fills only what `eligibleColumns` permits;
   * that pass does not exist yet, and arrives as `core/ai/fill.ts` in Task 7
   * of docs/superpowers/plans/2026-08-14-llm-provider.md. Placed last in a
   * source list by convention; the rule does not depend on position.
   */
  | { ai: true };

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
  /**
   * Flag the row when this column comes out empty.
   *
   * For a templated collection there is usually one field the template exists
   * to find. Without this, the batch's one genuine failure is indistinguishable
   * from a row nobody expected anything from.
   */
  flagIfEmpty?: boolean;
  /**
   * Extracted so other columns can compose from it, but never written to the
   * spreadsheet and never uploaded.
   *
   * Some facts belong inside a description and nowhere else. A birth date is
   * one: the library's records put it in the description text, and the schema
   * has no birth-date field at all, so giving it a column would mean writing a
   * person's birth date into a field that means something else.
   */
  composeOnly?: boolean;
}

export interface Profile {
  version: 1;
  /** e.g. "{last}_{first}_{title}_{date}.pdf" */
  pattern: string;
  columns: Column[];
  /**
   * Where to record, IN THE ITEM ITSELF, that a language model wrote something.
   *
   * ABSENT BY DEFAULT AND THE TOOL NEVER PICKS IT. Choosing a path on an
   * institution's behalf is the assumption an entire release was spent removing;
   * a wrong one writes outside the schema on every item in the batch.
   *
   * IT IS THE ONLY DISCLOSURE THAT SURVIVES THE UPLOAD. Everything else
   * `core/ai/fill.ts` writes goes into `_notes`, which `plan.ts` drops with
   * every other annotation column before anything is contributed -- so a future
   * reader of the catalogue sees none of it. This is a value in a real column
   * and it is uploaded like any other.
   *
   * `path` MUST BE A DECLARED, WRITABLE COLUMN of this profile, and
   * `parseProfile` refuses one that is not. `csv.ts` builds the spreadsheet by
   * walking `columns`, so a value written anywhere else is created and silently
   * dropped -- and being a column is also what puts this path through
   * `validateAgainstSchema` along with every other one, which is the whole of
   * the schema check the design asks for.
   *
   * `append` may use `{model}` and nothing else; an unknown placeholder is
   * refused at load rather than written out literally into a permanent record.
   * Joined to whatever the column already holds with '; ', once per row.
   */
  aiProvenance?: { path: string; append: string };
  /**
   * House style for the model, passed through to the prompt. See
   * `core/ai/prompt.ts`.
   *
   * PROFILE-LEVEL, not per column, because it describes how this collection
   * writes rather than what one field holds -- and because v1 enables the model
   * on one column, so a per-column setting would be five ways to say the same
   * thing four of which are never read.
   */
  aiInstruction?: string;
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

/**
 * One cell a language model wrote, as the row remembers it.
 *
 * ## Why the kind of field is stored and not just the note
 *
 * `review.ts` subtracts a model write from the "rows needing review" count,
 * because an expected write is not a problem to triage. That reasoning holds
 * for PROSE and not for FACTS. The design puts them in different buckets and
 * says so: a fact field "stays flagged for review even when an operator enables
 * it". A description that reads oddly is a quality problem a cataloguer can fix;
 * an invented death date is indistinguishable from a real one to everyone
 * downstream, permanently, in a collection with no moderation queue.
 *
 * Without this flag the counter cannot tell them apart -- a batch in which a
 * model filled forty dates would report "None need review", and `fill.ts` has
 * already cleared `flagged` for each of them, so nothing else on the row says
 * otherwise either.
 *
 * IT IS NOT DERIVED AT COUNTING TIME, deliberately. `factKind` needs the
 * COLUMN, and the counter runs on three surfaces -- one of them a sandboxed
 * renderer -- two of which have a row and no profile. Recording the answer where
 * the answer is known keeps one judgement in one place, made by the code that
 * already had to make it in order to word the note.
 */
export interface AiWrite {
  /** The exact string pushed onto `notes` for this cell. Compared by identity,
   *  never matched as prose. */
  note: string;
  /**
   * True where the column holds a date, a name, or anything else a reader
   * cannot check by reading. See `factKind` in core/ai/fill.ts for what it can
   * and -- importantly -- cannot detect.
   */
  factField: boolean;
}

/** One output row, before serialisation. */
export interface ExtractedRow {
  /** Keyed by column path. Every column in the profile is present, possibly empty. */
  cells: Record<string, string>;
  /** Column path -> which source filled it. Only filled columns appear. */
  sources: Record<string, string>;
  /** Human-readable problems with this row. */
  notes: string[];
  /**
   * Column path -> the note the source attached, i.e. the source saying it was
   * not certain this is the right value for this column.
   *
   * `notes` above is a flat list for the operator to read. This is the same
   * information keyed so code can ask about ONE column, which is what the
   * model-fill rule needs: it may replace a value a source doubted, and must
   * never replace one no source questioned.
   *
   * ONLY FLAGGED COLUMNS APPEAR -- a column is absent, never present with an
   * empty or undefined value. Callers count these keys.
   *
   * NOT THE SAME "flagged" as `previewNotes` in
   * `desktop/ui/screens/extractColumns.ts`, whose local variable means "rows
   * carrying any note at all". A row can be flagged in that UI sense -- no
   * text layer, a filename that does not match the pattern -- with `flagged`
   * here still `{}`, because those notes belong to the row rather than to any
   * one cell.
   *
   * CLEARED FOR A COLUMN A MODEL HAS WRITTEN, and moved to `aiWritten` below.
   * Read this as "a source doubted this value AND nothing better has been
   * tried yet", which is precisely the question the fill rule asks. A cell the
   * model has already had its turn at is not a candidate for another turn, so
   * leaving it here would make a second pass re-send and re-charge for every
   * cell the first pass wrote. `flagged` being empty is therefore NOT a claim
   * that nothing on the row is a guess -- check `aiWritten` too.
   */
  flagged: Record<string, string>;
  /**
   * Column path -> the record of a language model having written that cell.
   *
   * EVERY MODEL WRITE APPEARS HERE, and `note` is the same string that was
   * pushed onto `notes`. Two things need that, and neither can be had by
   * reading note prose:
   *
   * 1. **Telling routine flags from real problems.** Both surfaces count "rows
   *    needing review" as `notes.length > 0`, and with a model enabled on one
   *    column EVERY row carries a note -- so the count reads "400 of 400" and
   *    the batch's one genuine failure becomes invisible. That is the exact
   *    loss `flagIfEmpty`'s docblock exists to prevent. Storing the note itself
   *    lets a counter subtract by identity -- `notes.filter(n => !written.has(n))`
   *    -- with no string matching and no arithmetic that drifts if a write ever
   *    pushes two notes.
   * 2. **Not asking twice.** With `flagged` cleared and this set, a second fill
   *    pass over the same rows finds nothing eligible and spends nothing.
   *
   * ONLY WRITTEN COLUMNS APPEAR. A cell the model was asked about and failed on
   * is absent, exactly like `flagged`.
   */
  aiWritten: Record<string, AiWrite>;
}

export interface ExtractResult {
  rows: ExtractedRow[];
  /** Files that could not be read at all, with the reason. */
  skipped: { file: string; reason: string }[];
}
