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
  /** uuid of this row's single attachment, as it exists on the server. */
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
  /**
   * Metadata xpath that receives each item's attachment uuid, or absent/empty
   * for "write no such field" (the default -- see config.ts). Carried on the
   * manifest rather than read from the environment at run time so a batch
   * planned today runs the same way tomorrow, exactly like `collectionUuid`
   * and `itemState`.
   */
  attachmentUuidPath?: string;
  entries: ManifestEntry[];
  /** Non-fatal problems surfaced at plan time. */
  warnings: string[];
}

export const ATTACHMENT_COLUMN = 'attachment name';

/*
 * There is deliberately NO default attachment-uuid xpath here.
 *
 * `BYUI_extended/attachments/attachment` used to live at this spot, and the
 * runner wrote it on EVERY item it created. That node exists in one
 * institution's schema; anywhere else the tool was writing metadata to a path
 * outside the collection's schema on every contribution -- storing junk or
 * failing the create, with nothing in either outcome to point at the cause.
 *
 * It is configuration now (`OEQ_ATTACHMENT_UUID_PATH` -> `Config.attachmentUuidPath`
 * -> `Manifest.attachmentUuidPath`), defaulting to unset, and unset means the
 * field is omitted entirely rather than replaced by a guess. The attachment
 * itself is unaffected either way: attachments are linked through the
 * attachment API, and this field is only a convenience index that a schema may
 * or may not declare.
 */

/*
 * There is deliberately NO default title xpath here.
 *
 * `MWDL/title` used to live at this spot, and hardcoding it is what made
 * duplicate detection silently blind anywhere but BYU-Idaho: the `where`
 * clause matched nothing, so every row came back clean from a check that never
 * looked. It was briefly kept as a "fallback for a hand-made spreadsheet",
 * then removed once nothing referenced it -- a fallback nobody uses is just an
 * attractive nuisance, and `noUnusedLocals` is off here so nothing would flag
 * it.
 *
 * The path is READ, from whichever source is available: `parseSchema` in
 * discovery.ts for the REST representation, `extractItemNamePath` in schema.ts
 * for an `_entity.xml` export. When neither declares one, the answer is
 * `could-not-check` (see findDuplicates) -- never a guess, and never `clean`.
 */

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
