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
}

export interface BuildArgs {
  client: { searchCollection(collectionUuid: string): Promise<CollectionItem[]> } & Pick<IndexClient, 'findByField'>;
  baseUrl: string;
  collectionUuid: string;
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
  const listing = await args.client.searchCollection(args.collectionUuid);
  const index = collectIndex(
    listing.map(toHit),
    { patterns: sequence.patterns, groupPatterns: profile.index.groupPatterns, labels: sequence.labels },
    args.baseUrl,
  );
  const labels = resolveLabels(sequence.labels);
  const files = renderIndex(index, { title: record.title, description: record.description, groups: labels.groups });
  const existing = await findExistingIndex(args.client, args.collectionUuid, record);
  return { collectionUuid: args.collectionUuid, index, record, files, existing, labels };
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
      "openEQUELLA did not say which schema this collection uses, and none is saved for this site, so the index's " +
        'title and description fields cannot be found. Choose the collection on Setup, or set OEQ_SCHEMA_UUID.',
    );
  }
  return client.getSchema(uuid);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the preview says, as plain lines -- the CLI prints them; the desktop shows the same facts. */
export function previewLines(b: IndexBuild): string[] {
  const L = b.labels;
  const issues = b.index.volumes.reduce((n, v) => n + v.issues.length, 0);
  const lines = [`${plural(b.index.volumes.length, L.group, L.groups)}, ${plural(issues, L.part, L.parts)}.`];
  for (const h of b.index.heldBack) {
    lines.push(`Held back: ${h.reason} -- ${h.items.map((i) => i.name).join(', ')}`);
  }
  if (b.index.notInSeries.length > 0) {
    lines.push(
      `Not in the series (${b.index.notInSeries.length}): ` +
        b.index.notInSeries.map((l) => `${l.name} -- ${l.reason}`).join('; '),
    );
  }
  lines.push(existingLine(b.existing));
  return lines;
}

export function existingLine(existing: ExistingIndex): string {
  switch (existing.kind) {
    case 'none':
      return 'openEQUELLA: creates a new index item.';
    case 'one':
      return `openEQUELLA: updates the existing index item, which stays ${existing.status}.`;
    case 'many':
      return `openEQUELLA: refused -- ${existing.items.length} items carry this identifier (${existing.items
        .map((i) => i.name)
        .join(', ')}).`;
    case 'unavailable':
      return `openEQUELLA: unavailable -- ${existing.reason}`;
  }
}
