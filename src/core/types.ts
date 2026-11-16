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

/** One file a row contributes, in upload order. */
export interface ManifestFile {
  /** Absolute path on disk. */
  path: string;
  /** Filename as it appears as the attachment. */
  name: string;
  /**
   * Bytes at plan time, so the run can tell a file was replaced. ABSENT on a
   * row planned by a version that did not record sizes (manifest v1): for
   * those the run checks presence only, and cannot tell a same-named
   * replacement. Never filled in at load -- that would compare a file against
   * itself.
   */
  size?: number;
}

export interface ManifestEntry {
  rowNumber: number;
  /** What `attachment name` said: a filename, or a folder name. The row's label. */
  source: string;
  /** Set only when `source` named a folder: its absolute path. Re-listed at run time. */
  folderPath?: string;
  /** One for a file row; every file in upload order for a folder row. Never empty. */
  files: ManifestFile[];
  /** Files in the folder that are never uploaded, shown in the plan. Folder rows only. */
  skippedFiles?: { name: string; reason: string }[];
  /** Metadata xpath -> value(s). Repeated headers collapse into multiple values. */
  metadata: Record<string, string[]>;
  status: RowStatus;
  /** Populated once openEQUELLA returns it. The authoritative identity. */
  itemUuid?: string;
  /** openEQUELLA items are versioned; this is the version this row created. */
  itemVersion?: number;
  /** One uuid per entry in `files`, in the same order, as they exist on the server. */
  attachmentUuids?: string[];
  error?: string;
  /** Cumulative attempts across all resumed runs; retry resets status, not this. */
  attempts: number;
}

export interface Manifest {
  version: 2;
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

/**
 * Reserved: a folder row's files in the order they are to be attached, joined
 * by semicolons. The extractor writes it from the template's issue patterns
 * (extract/issueChecks.ts#orderByIssue), because `plan` never sees a template;
 * staff may also edit it by hand. Absent or blank means name order. Never
 * metadata.
 */
export const ATTACHMENT_ORDER_COLUMN = 'attachment order';

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

/**
 * How a row is named to the operator everywhere: CLI, MCP, desktop and every
 * runner error. A file row is its filename, exactly as before; a folder row
 * says how many files it carries, so "Vol3 (6 files)" cannot be mistaken for
 * one file. Lives here because the renderer needs it and this module has no
 * node imports.
 */
export function rowLabel(entry: Pick<ManifestEntry, 'source' | 'folderPath' | 'files'>): string {
  if (entry.folderPath === undefined) return entry.source;
  const n = entry.files.length;
  return `${entry.source} (${n} file${n === 1 ? '' : 's'})`;
}
