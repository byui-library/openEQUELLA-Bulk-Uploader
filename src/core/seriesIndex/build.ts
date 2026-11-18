// src/core/seriesIndex/build.ts
import type { CollectionItem, CollectionSummary } from '../client.js';
import type { SchemaInfo } from '../discovery.js';
import { ValidationError } from '../errors.js';
import { resolveLabels } from '../extract/sequenceChecks.js';
import type { Profile, SequenceLabels } from '../extract/types.js';
import { collectIndex } from './collect.js';
import { findExistingIndex, type ExistingIndex, type IndexClient } from './publish.js';
import { indexRecord, type IndexRecord, type IndexSchema } from './record.js';
import { renderIndex } from './render.js';
import type { IndexFiles, IndexHit, SeriesIndex } from './types.js';
import { andMore, existingNote, NOT_IN_SERIES_SHOWN, plural } from './words.js';
import { recordHits, type BatchRecord } from './batchRecord.js';

/**
 * ONE build, used by the CLI and the desktop alike, so the preview, the files
 * and the uploaded item are one set of bytes.
 */

export interface IndexBuild {
  collectionUuid: string;
  index: SeriesIndex;
  record: IndexRecord;
  files: IndexFiles;
  existing: ExistingIndex;
  /** The template's own words: "issue"/"issues", "volume"/"volumes". */
  labels: SequenceLabels;
  /** The batch record's rows the run did not create. Always empty for a collection build. */
  notCreated: { label: string; status: string; error?: string }[];
}

/**
 * Where the items come from: a search of the collection (narrowed by the
 * template's `index.search`), or the batch records of the runs that made them
 * -- which makes NO collection search at all (spec section 7).
 */
export type BuildSource = { kind: 'collection' } | { kind: 'record'; record: BatchRecord };

export interface BuildArgs {
  client: {
    searchCollection(collectionUuid: string, opts?: { q?: string }): Promise<CollectionItem[]>;
  } & Pick<IndexClient, 'findByField'>;
  baseUrl: string;
  collectionUuid: string;
  source: BuildSource;
  profile: Profile;
  schema: IndexSchema;
}

const toHit = (item: CollectionItem): IndexHit => ({
  uuid: item.uuid,
  version: item.version,
  status: item.status,
  name: item.name,
  files: item.attachments.filter((a) => a.type === 'file').map((a) => ({ filename: a.filename, uuid: a.uuid })),
});

export async function buildIndex(args: BuildArgs): Promise<IndexBuild> {
  const { profile } = args;
  if (!profile.index) throw new ValidationError('This template has no "index" section, so it cannot build an index.');
  const sequence = profile.checks?.sequence;
  if (!sequence) throw new ValidationError('This template has no file-name patterns to read volumes and issues with.');

  const record = indexRecord(profile.index, args.schema);
  // Found FIRST, so the index item -- or each of several -- is left out of the
  // listing: it lives in the collection it indexes, and is not "not in the series".
  const existing = await findExistingIndex(args.client, args.collectionUuid, record);
  const self = new Set(
    existing.kind === 'one' ? [existing.uuid] : existing.kind === 'many' ? existing.items.map((i) => i.uuid) : [],
  );
  const { source } = args;
  const search = profile.index.search;
  const hits =
    source.kind === 'record'
      ? recordHits(source.record)
      : (await args.client.searchCollection(args.collectionUuid, search ? { q: search } : {})).map(toHit);
  const notCreated =
    source.kind === 'record'
      ? source.record.leftOut.map((l) => ({ label: l.label, status: l.status, ...(l.error !== undefined ? { error: l.error } : {}) }))
      : [];
  const index = collectIndex(
    hits.filter((hit) => !self.has(hit.uuid)),
    { patterns: sequence.patterns, groupPatterns: profile.index.groupPatterns, labels: sequence.labels },
    args.baseUrl,
  );
  const labels = resolveLabels(sequence.labels);
  const files = renderIndex(index, { title: record.title, description: record.description, groups: labels.groups });
  return { collectionUuid: args.collectionUuid, index, record, files, existing, labels, notCreated };
}

/** The collection's schema, else the site's saved one, else a refusal naming both. */
export async function resolveIndexSchema(
  client: { getCollection(uuid: string): Promise<CollectionSummary>; getSchema(uuid: string): Promise<SchemaInfo> },
  collectionUuid: string,
  fallbackSchemaUuid: string,
): Promise<SchemaInfo> {
  const fromCollection = (await client.getCollection(collectionUuid)).schemaUuid ?? '';
  const uuid = fromCollection !== '' ? fromCollection : fallbackSchemaUuid;
  if (uuid === '') {
    throw new ValidationError(
      "openEQUELLA did not say which schema this collection uses, and none is known for it here, so the index's " +
        'title and description fields cannot be found. In the desktop app, choose this collection on Setup; ' +
        'on the command line, set OEQ_SCHEMA_UUID.',
    );
  }
  return client.getSchema(uuid);
}

/** What the preview says, as plain lines -- the CLI prints them; the desktop shows the same facts. */
export function previewLines(b: IndexBuild): string[] {
  const L = b.labels;
  const issues = b.index.volumes.reduce((n, v) => n + v.issues.length, 0);
  const lines = [`${plural(b.index.volumes.length, L.group, L.groups)}, ${plural(issues, L.part, L.parts)}.`];
  for (const h of b.index.heldBack) {
    lines.push(`Held back: ${h.reason} -- ${h.items.map((i) => i.name).join(', ')}`);
  }
  const left = b.index.notInSeries;
  if (left.length > 0) {
    const more = andMore(left.length);
    lines.push(
      `Not in the series (${left.length}): ` +
        left
          .slice(0, NOT_IN_SERIES_SHOWN)
          .map((l) => `${l.name} -- ${l.reason}`)
          .join('; ') +
        (more ? `; ${more}` : ''),
    );
  }
  if (b.notCreated.length > 0) {
    lines.push(
      `Not created by the run (${b.notCreated.length}): ` +
        b.notCreated.map((n) => `${n.label} -- ${n.status}${n.error ? ` (${n.error})` : ''}`).join('; '),
    );
  }
  lines.push(existingNote(b.existing).text);
  return lines;
}
