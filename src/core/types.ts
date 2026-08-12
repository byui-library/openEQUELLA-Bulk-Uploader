/** One spreadsheet row: xpath -> cell value. Blank cells are present as ''. */
export interface Row {
  /** 1-based row number in the source sheet, for error messages. */
  rowNumber: number;
  /** Column header (xpath, or the reserved 'attachment name') -> cell text. */
  cells: Record<string, string>;
}

export interface Sheet {
  headers: string[];
  rows: Row[];
}

export type ItemState = 'draft' | 'published';

export type RowStatus =
  | 'pending'
  | 'uploading'
  | 'created'
  | 'incomplete'
  | 'failed'
  | 'skipped';

export interface ManifestEntry {
  rowNumber: number;
  /** Absolute path to the file on disk. */
  filePath: string;
  /** Filename as it should appear as the attachment. */
  fileName: string;
  /** Metadata xpath -> value(s). Repeated headers collapse into multiple values. */
  metadata: Record<string, string[]>;
  status: RowStatus;
  /** Populated once openEQUELLA returns it. The authoritative identity. */
  itemUuid?: string;
  /** openEQUELLA items are versioned; this is the version this row created. */
  itemVersion?: number;
  /** uuid of this row's single attachment, written back into ATTACHMENT_UUID_XPATH. */
  attachmentUuid?: string;
  error?: string;
  /** Cumulative attempts across all resumed runs; retry resets status, not this. */
  attempts: number;
}

export interface Manifest {
  version: 1;
  createdAt: string;
  baseUrl: string;
  collectionUuid: string;
  schemaUuid: string;
  itemState: ItemState;
  /** Reserved header naming the file on disk. */
  attachmentColumn: string;
  entries: ManifestEntry[];
  /** Non-fatal problems surfaced at plan time. */
  warnings: string[];
}

export const ATTACHMENT_COLUMN = 'attachment name';

/** Field that must receive the real attachment uuid, not the filename. */
export const ATTACHMENT_UUID_XPATH = 'BYUI_extended/attachments/attachment';

/**
 * The path BYU-Idaho's schema declares as the item name.
 *
 * A FALLBACK, not a fact. It applies only to a hand-made spreadsheet with no
 * schema behind it. Anything that can reach an instance -- or even a local
 * schema export -- must read the declared path instead: `parseSchema` in
 * discovery.ts for the REST representation, `extractItemNamePath` in schema.ts
 * for an _entity.xml export.
 *
 * Hardcoding this is what made duplicate detection silently blind anywhere but
 * BYU-Idaho: the `where` clause matched nothing, so every row came back clean
 * from a check that never looked. See findDuplicates -- an unknown title path
 * is `could-not-check`, never `clean`, and never this value.
 */
export const DEFAULT_TITLE_XPATH = 'MWDL/title';

/**
 * How this tool decides two filenames are the same file.
 *
 * Shared so there is one answer: `plan.ts` matches spreadsheet rows to files
 * on disk with it, and the duplicate check compares against an existing
 * item's attachments with it. Lives here rather than in `plan.ts` because
 * `plan.ts` reaches `node:fs` and the duplicate check is reached from the
 * sandboxed renderer, where a `node:` import blanks the window.
 */
export function sameFileName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
