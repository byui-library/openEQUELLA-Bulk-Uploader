// src/core/seriesIndex/batchRecord.ts
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { ValidationError } from '../errors.js';
import { describeReason } from '../errorReason.js';
import { sameSite } from '../instanceUrl.js';
import { parseManifest, writeJsonAtomic } from '../state.js';
import { rowLabel, type ItemState, type Manifest, type RowStatus } from '../types.js';
import type { IndexHit } from './types.js';

/**
 * The batch record: what a run created, kept so an index can be built from it
 * without reading the collection (spec section 7). It is a PROJECTION of the
 * manifest, recomputed whole after every row -- never appended to -- so an
 * interrupted run leaves a record of exactly what it made. A record already at
 * the path from an earlier run of the same spreadsheet is carried forward (see
 * `keepBatchRecord`), so a rerun adds to it rather than losing what it listed.
 */

export interface RecordItem {
  row: number;
  uuid: string;
  version: number;
  /** The value at the schema's declared name path; '' when none is stated. */
  title: string;
  /**
   * The entry's row label, so a combined record can tell that a row another
   * record left out was created after all.
   */
  label: string;
  /**
   * The state the item was created in. A record accumulates runs, and one
   * run's drafts must not make an earlier run's published items read as
   * drafts.
   */
  state: ItemState;
  /** In the item's upload order. */
  files: { name: string; attachmentUuid: string }[];
}

/** An entry the run did not create, named so the index's builder can see it. */
export interface RecordLeftOut {
  row: number;
  label: string;
  status: RowStatus;
  error?: string;
}

export interface BatchRecord {
  kind: 'oeq-batch-record';
  version: 1;
  savedAt: string;
  baseUrl: string;
  collectionUuid: string;
  items: RecordItem[];
  leftOut: RecordLeftOut[];
}

/**
 * PURE. `titlePath` is the schema's declared name path in header form
 * (`DC/title`), or null when none is known. With no title stated the item's
 * title is '' -- never the row label, which would become the index's heading
 * (`1972_Vol27 (6 files)`) in place of the index's own (`Volume 27`).
 *
 * An entry with an item is an item, `incomplete` included -- with one
 * exception. The runner marks a row incomplete for two reasons (runner.ts):
 * openEQUELLA assigned other attachment uuids than were sent, which does not
 * matter here because the index links by file name; or it reported FEWER
 * attachments than files were sent. That item lacks a file the record would
 * list, and the index would link to nothing, so it is left out instead --
 * with the runner's error, which says to check the item by hand.
 */
export function recordFromManifest(manifest: Manifest, titlePath: string | null, now = new Date()): BatchRecord {
  const items: RecordItem[] = [];
  const leftOut: RecordLeftOut[] = [];
  for (const entry of manifest.entries) {
    const lostFiles =
      entry.status === 'incomplete' &&
      entry.attachmentUuids !== undefined &&
      entry.attachmentUuids.length < entry.files.length;
    if (lostFiles) {
      leftOut.push({
        row: entry.rowNumber,
        label: rowLabel(entry),
        status: entry.status,
        error: entry.error ?? 'openEQUELLA kept fewer files than were sent',
      });
    } else if ((entry.status === 'created' || entry.status === 'incomplete') && entry.itemUuid) {
      items.push({
        row: entry.rowNumber,
        uuid: entry.itemUuid,
        version: entry.itemVersion ?? 1,
        title: titlePath === null ? '' : (entry.metadata[titlePath]?.[0] ?? '').trim(),
        label: rowLabel(entry),
        state: manifest.itemState,
        files: entry.files.map((f, i) => ({ name: f.name, attachmentUuid: entry.attachmentUuids?.[i] ?? '' })),
      });
    } else {
      leftOut.push({
        row: entry.rowNumber,
        label: rowLabel(entry),
        status: entry.status,
        ...(entry.error !== undefined ? { error: entry.error } : {}),
      });
    }
  }
  return {
    kind: 'oeq-batch-record',
    version: 1,
    savedAt: now.toISOString(),
    baseUrl: manifest.baseUrl,
    collectionUuid: manifest.collectionUuid,
    items,
    leftOut,
  };
}

/**
 * A left-out row that one of `items` is -- the same row number AND the same
 * label -- was created after all (a retry, a rerun), and is dropped: a record
 * must not list a row both as made and as not made.
 */
function dropResolved(leftOut: readonly RecordLeftOut[], items: readonly RecordItem[]): RecordLeftOut[] {
  const key = (row: number, label: string): string => `${row}\u0000${label}`;
  const made = new Set(items.map((i) => key(i.row, i.label)));
  return leftOut.filter((l) => !made.has(key(l.row, l.label)));
}

/**
 * This run's record on top of an earlier one at the same path: the earlier
 * items, then this run's, one per uuid (this run's version wins). Left out is
 * this run's alone, minus rows either run created. Each item keeps the state
 * it was made in (`RecordItem.state`), and that is what an index reads.
 */
function accumulate(earlier: BatchRecord, current: BatchRecord): BatchRecord {
  const items = laterWins([...earlier.items, ...current.items]);
  return {
    ...current,
    items,
    leftOut: dropResolved(current.leftOut, items),
  };
}

/**
 * One item per uuid, the LATER one winning and taking the later place: the
 * single rule for a uuid seen twice, whether a rerun's keeper or a reader
 * combining several records meets it.
 */
function laterWins(items: readonly RecordItem[]): RecordItem[] {
  const byUuid = new Map<string, RecordItem>();
  for (const item of items) {
    byUuid.delete(item.uuid);
    byUuid.set(item.uuid, item);
  }
  return [...byUuid.values()];
}

/** What a kept record came to: written (its last write landed), or the first thing that went wrong. */
export interface KeptRecord {
  written: boolean;
  /** The first failure, if any write or read failed. Null when none did. */
  error: unknown;
}

/** A row's status as the runner reports it, for `update` to tell whether anything changed. */
export interface RecordProgress {
  rowNumber: number;
  status: RowStatus;
}

/**
 * The keeper declined to touch what is already at the path. Its message says
 * so whole -- "It was left as it is, and no batch record was kept" -- and is
 * shown as it is, never wrapped as a write that failed.
 */
export class BatchRecordRefused extends ValidationError {}

/**
 * What is already at `file`, read once when a keeper starts: null when there
 * is nothing, the record when it is one of this site and collection, and a
 * refusal -- the file left as it is -- for anything else.
 */
function earlierRecord(file: string, manifest: Manifest): BatchRecord | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    // ENOTDIR: a folder on the way is a file, so nothing is at the path either;
    // the write then fails, and says so.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new BatchRecordRefused(
      `${file} already exists and could not be read (${describeReason(err)}). It was left as it is, ` +
        `and no batch record was kept for this run.`,
    );
  }
  let earlier: BatchRecord;
  try {
    earlier = parseBatchRecord(text, basename(file));
  } catch (err) {
    throw new BatchRecordRefused(
      `${file} already exists and is not a batch record this tool can read (${describeReason(err)}). ` +
        `It was left as it is, and no batch record was kept for this run.`,
    );
  }
  if (!sameSite(earlier.baseUrl, manifest.baseUrl)) {
    throw new BatchRecordRefused(
      `${file} is a batch record of another site (${earlier.baseUrl}). It was left as it is, and no ` +
        `batch record was kept for this run.`,
    );
  }
  if (earlier.collectionUuid !== manifest.collectionUuid) {
    throw new BatchRecordRefused(
      `${file} is a batch record of another collection. It was left as it is, and no batch record ` +
        `was kept for this run.`,
    );
  }
  return earlier;
}

/**
 * Keeps the batch record beside a run -- ONE implementation for the CLI and the
 * desktop. Call `update(entry, manifest)` from the runner's `onProgress` and
 * `update()` once at the end; the record is recomputed WHOLE each time, so an
 * interrupted run leaves a record of exactly what it made.
 *
 * The record is built from the manifest the runner HANDS to `onProgress`, never
 * read back from disk, and only from what it has reported: runner.ts saves the
 * manifest BEFORE it reports progress, so what a report carries is what is
 * saved. The manifest file is read once, here at the start -- for the statuses
 * already there, and for `update()` when nothing has been reported.
 *
 * A record already at `file` -- an earlier run of the same spreadsheet -- is
 * read once, here, and carried forward. Anything else there (not a record,
 * another site's, another collection's) is never overwritten: that is this
 * keeper's failure, and nothing is written.
 *
 * `update(entry, ...)` does nothing when that row's status is what it last saw
 * -- seeded from the manifest at the start -- so a retry's back-to-back reports
 * of already-finished rows cost nothing. `update()` always writes.
 *
 * Writes are chained so two never overlap, and coalesced: a queued write that
 * a later update has superseded is skipped, since only the latest record is
 * worth writing. Only the most recent update decides `written`: an earlier
 * write landing after a later failure does not.
 *
 * A failure NEVER fails the run -- the items exist either way. `onFirstFailure`
 * hears the first one; `settled()` never rejects.
 */
export function keepBatchRecord(
  manifestPath: string,
  file: string,
  titlePath: string | null,
  onFirstFailure: (err: unknown) => void = () => {},
) {
  let writes = Promise.resolve();
  let firstError: unknown = null;
  let written = false;
  let latest = 0;
  const fail = (err: unknown): void => {
    if (firstError !== null) return;
    firstError = err ?? new Error('unknown failure');
    onFirstFailure(err);
  };

  const seen = new Map<number, RowStatus>();
  let earlier: BatchRecord | null = null;
  let current: Manifest | null = null;
  let refused = false;
  try {
    current = parseManifest(readFileSync(manifestPath, 'utf8'), manifestPath);
    for (const e of current.entries) seen.set(e.rowNumber, e.status);
    earlier = earlierRecord(file, current);
  } catch (err) {
    refused = true;
    fail(err);
  }

  return {
    update(progress?: RecordProgress, manifest?: Manifest): void {
      if (refused) return;
      if (manifest !== undefined) current = manifest;
      if (progress !== undefined) {
        if (seen.get(progress.rowNumber) === progress.status) return;
        seen.set(progress.rowNumber, progress.status);
      }
      const seq = ++latest;
      let record: BatchRecord;
      try {
        const now = recordFromManifest(current!, titlePath);
        record = earlier === null ? now : accumulate(earlier, now);
      } catch (err) {
        written = false;
        fail(err);
        return;
      }
      writes = writes.then(async () => {
        if (seq !== latest) return; // superseded: a later record is queued
        try {
          await writeJsonAtomic(file, record);
          if (seq === latest) written = true;
        } catch (err) {
          if (seq === latest) written = false;
          fail(err);
        }
      });
    },
    /** Every queued write, settled. Never rejects. */
    async settled(): Promise<KeptRecord> {
      await writes;
      return { written: !refused && written, error: firstError };
    },
  };
}

/** Where a run keeps its record, and the schema's name path in header form that titles each item. */
export interface RecordTarget {
  path: string;
  titlePath: string | null;
}

/**
 * A run, keeping the batch record when one was asked for -- the ONE lifecycle
 * the CLI and the desktop share. `run` calls `afterRow` from the runner's
 * progress callback with the entry and the manifest it was handed; the record
 * is written once more at the end, and every write has settled before this
 * returns or throws.
 *
 * A RECORD THAT CANNOT BE WRITTEN NEVER FAILS THE RUN: the items exist either
 * way. It comes back as `indexRecordError`; `onFirstFailure` hears it as it
 * happens.
 */
export async function runKeepingRecord<S>(
  manifestPath: string,
  target: RecordTarget | undefined,
  run: (afterRow: (entry: RecordProgress, manifest: Manifest) => void) => Promise<S>,
  onFirstFailure?: (err: unknown) => void,
): Promise<{ summary: S; indexRecordPath?: string; indexRecordError?: string }> {
  const keeper = target ? keepBatchRecord(manifestPath, target.path, target.titlePath, onFirstFailure) : null;
  let summary: S;
  try {
    summary = await run((entry, manifest) => keeper?.update(entry, manifest));
  } finally {
    // Once more at the end -- a run that threw included -- so the record holds
    // what was made, and a batch with no rows to report still leaves one.
    keeper?.update();
    // Never rejects: a run that threw is not made to wait on, or hidden by, its record.
    await keeper?.settled();
  }
  if (keeper === null || target === undefined) return { summary };
  const kept = await keeper.settled();
  return kept.written
    ? { summary, indexRecordPath: target.path }
    : { summary, indexRecordError: describeReason(kept.error) };
}

/**
 * `readBatchRecords`, refusing records made on any site but `siteUrl`: the
 * index's links are built from that site's address, so a record of another
 * would publish links to the wrong server.
 */
export async function readBatchRecordsFor(paths: readonly string[], siteUrl: string): Promise<BatchRecord> {
  const record = await readBatchRecords(paths);
  if (!sameSite(record.baseUrl, siteUrl)) {
    throw new ValidationError(
      `The batch record was made on a different site (${record.baseUrl}) from the one in use here ` +
        `(${siteUrl}). Refusing: the index's links would point at the wrong server.`,
    );
  }
  return record;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function isRecordItem(v: unknown): v is RecordItem {
  return (
    isObject(v) &&
    typeof v['row'] === 'number' &&
    typeof v['uuid'] === 'string' &&
    typeof v['version'] === 'number' &&
    typeof v['title'] === 'string' &&
    typeof v['label'] === 'string' &&
    (v['state'] === 'draft' || v['state'] === 'published') &&
    Array.isArray(v['files']) &&
    v['files'].every((f) => isObject(f) && typeof f['name'] === 'string' && typeof f['attachmentUuid'] === 'string')
  );
}

function isLeftOut(v: unknown): v is RecordLeftOut {
  return (
    isObject(v) &&
    typeof v['row'] === 'number' &&
    typeof v['label'] === 'string' &&
    typeof v['status'] === 'string' &&
    (v['error'] === undefined || typeof v['error'] === 'string')
  );
}

/** A record's text, checked whole -- every item and left-out entry -- or a ValidationError naming `name`. */
function parseBatchRecord(text: string, name: string): BatchRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError(`${name} is not a batch record.`);
  }
  const r = parsed as Partial<BatchRecord> | null;
  if (typeof r !== 'object' || r === null || r.kind !== 'oeq-batch-record') {
    throw new ValidationError(`${name} is not a batch record.`);
  }
  if (r.version !== 1) {
    throw new ValidationError(
      `${name} is a batch record of version ${JSON.stringify(r.version)}, which this version of the tool cannot read.`,
    );
  }
  if (
    typeof r.baseUrl !== 'string' ||
    typeof r.collectionUuid !== 'string' ||
    !Array.isArray(r.items) ||
    !Array.isArray(r.leftOut) ||
    !r.items.every(isRecordItem) ||
    !r.leftOut.every(isLeftOut)
  ) {
    throw new ValidationError(`${name} is a batch record with missing or damaged fields.`);
  }
  return r as BatchRecord;
}

async function readOne(path: string): Promise<BatchRecord> {
  const name = basename(path);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new ValidationError(`Could not read the batch record ${name}: ${describeReason(err)}`);
  }
  return parseBatchRecord(text, name);
}

/**
 * Several records combined into one, in the order given: a series uploaded in
 * batches, or a retry run. Refused, naming the file: anything that is not a
 * version-1 record, and records of different sites or collections. An item
 * two records carry is listed once -- the later record's, as `keepBatchRecord`
 * resolves it -- and a row one record left out and another created is not
 * listed as left out.
 */
export async function readBatchRecords(paths: readonly string[]): Promise<BatchRecord> {
  if (paths.length === 0) throw new ValidationError('No batch record was given.');
  let combined: BatchRecord | null = null;
  for (const path of paths) {
    const r = await readOne(path);
    if (combined === null) {
      // The trailing slash comes off for display only; sites are compared by `sameSite`.
      combined = { ...r, baseUrl: r.baseUrl.replace(/\/+$/, ''), items: [], leftOut: [] };
    } else if (!sameSite(r.baseUrl, combined.baseUrl)) {
      throw new ValidationError(
        `${basename(path)} records a different site (${r.baseUrl}) from the first record (${combined.baseUrl}).`,
      );
    } else if (r.collectionUuid !== combined.collectionUuid) {
      throw new ValidationError(`${basename(path)} records a different collection from the first record.`);
    }
    combined.items = laterWins([...combined.items, ...r.items]);
    combined.leftOut.push(...r.leftOut);
  }
  combined!.leftOut = dropResolved(combined!.leftOut, combined!.items);
  return combined!;
}

/**
 * The record's items as the hits `collectIndex` reads -- the same as a search
 * would give. An untitled item has no name, so the index heads it as it heads
 * any unnamed hit; its row label still names it in the preview's listings,
 * which would otherwise show a bare uuid. Each item's status is its own state.
 */
export function recordHits(record: BatchRecord): IndexHit[] {
  return record.items.map((item) => ({
    uuid: item.uuid,
    version: item.version,
    status: item.state === 'published' ? 'live' : 'draft',
    name: item.title === '' ? null : item.title,
    label: item.label,
    files: item.files.map((f) => ({ filename: f.name, uuid: f.attachmentUuid })),
  }));
}
