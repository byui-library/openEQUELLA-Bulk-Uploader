// src/core/seriesIndex/batchRecord.ts
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { ValidationError } from '../errors.js';
import { writeJsonAtomic } from '../state.js';
import { rowLabel, type ItemState, type Manifest, type RowStatus } from '../types.js';
import type { IndexHit } from './types.js';

/**
 * The batch record: what a run created, kept so an index can be built from it
 * without reading the collection (spec section 7). It is a PROJECTION of the
 * manifest, recomputed whole after every row -- never appended to -- so an
 * interrupted run leaves a record of exactly what it made.
 */

export interface RecordItem {
  row: number;
  uuid: string;
  version: number;
  title: string;
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
  itemState: ItemState;
  items: RecordItem[];
  leftOut: RecordLeftOut[];
}

/**
 * PURE. `titlePath` is the schema's declared name path in header form
 * (`DC/title`), or null when none is known; the row label stands in.
 */
export function recordFromManifest(manifest: Manifest, titlePath: string | null, now = new Date()): BatchRecord {
  const items: RecordItem[] = [];
  const leftOut: RecordLeftOut[] = [];
  for (const entry of manifest.entries) {
    if (entry.status === 'created' && entry.itemUuid) {
      const stated = titlePath === null ? '' : (entry.metadata[titlePath]?.[0] ?? '').trim();
      items.push({
        row: entry.rowNumber,
        uuid: entry.itemUuid,
        version: entry.itemVersion ?? 1,
        title: stated !== '' ? stated : rowLabel(entry),
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
    itemState: manifest.itemState,
    items,
    leftOut,
  };
}

/** Written whole, through a temporary file, so a reader never sees half of one. */
export async function writeBatchRecord(path: string, record: BatchRecord): Promise<void> {
  await writeJsonAtomic(path, record);
}

const siteOf = (url: string): string => url.replace(/\/+$/, '');

async function readOne(path: string): Promise<BatchRecord> {
  const name = basename(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new ValidationError(`Could not read the batch record ${name}: ${(err as Error).message}`);
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
    (r.itemState !== 'draft' && r.itemState !== 'published') ||
    !Array.isArray(r.items) ||
    !Array.isArray(r.leftOut)
  ) {
    throw new ValidationError(`${name} is a batch record with missing or damaged fields.`);
  }
  return r as BatchRecord;
}

/**
 * Several records combined into one, in the order given: a series uploaded in
 * batches, or a retry run. Refused, naming the file: anything that is not a
 * version-1 record, and records of different sites or collections. An item
 * two records carry is listed once; the result is draft if any record is.
 */
export async function readBatchRecords(paths: readonly string[]): Promise<BatchRecord> {
  if (paths.length === 0) throw new ValidationError('No batch record was given.');
  let combined: BatchRecord | null = null;
  const seen = new Set<string>();
  for (const path of paths) {
    const r = await readOne(path);
    if (combined === null) {
      combined = { ...r, baseUrl: siteOf(r.baseUrl), items: [], leftOut: [] };
    } else if (siteOf(r.baseUrl) !== combined.baseUrl) {
      throw new ValidationError(
        `${basename(path)} records a different site (${r.baseUrl}) from the first record (${combined.baseUrl}).`,
      );
    } else if (r.collectionUuid !== combined.collectionUuid) {
      throw new ValidationError(`${basename(path)} records a different collection from the first record.`);
    }
    if (r.itemState === 'draft') combined.itemState = 'draft';
    for (const item of r.items) {
      if (seen.has(item.uuid)) continue;
      seen.add(item.uuid);
      combined.items.push(item);
    }
    combined.leftOut.push(...r.leftOut);
  }
  return combined!;
}

/** The record's items as the hits `collectIndex` reads -- the same as a search would give. */
export function recordHits(record: BatchRecord): IndexHit[] {
  const status = record.itemState === 'published' ? 'live' : 'draft';
  return record.items.map((item) => ({
    uuid: item.uuid,
    version: item.version,
    status,
    name: item.title,
    files: item.files.map((f) => ({ filename: f.name, uuid: f.attachmentUuid })),
  }));
}
