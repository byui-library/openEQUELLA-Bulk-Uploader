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
