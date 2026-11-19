// src/core/seriesIndex/build.ts
import { escapeWhereValue, type CollectionItem, type CollectionSummary } from '../client.js';
import type { SchemaInfo } from '../discovery.js';
import { ValidationError } from '../errors.js';
import { resolveLabels } from '../extract/sequenceChecks.js';
import type { Profile, SequenceLabels } from '../extract/types.js';
import { collectIndex } from './collect.js';
import { findExistingIndex, type ExistingIndex, type IndexClient } from './publish.js';
import { indexRecord, type IndexRecord, type IndexSchema } from './record.js';
import { renderIndex } from './render.js';
import type { IndexFiles, IndexHit, SeriesIndex } from './types.js';
import { andMore, existingNote, missingNote, NOT_IN_SERIES_SHOWN, notCreatedEntry, notInSeriesEntry, plural } from './words.js';
import { readBatchRecordsFor, recordHits, type BatchRecord, type RecordLeftOut } from './batchRecord.js';

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
  notCreated: RecordLeftOut[];
}

/**
 * Where the items come from: a search of the collection (narrowed by the
 * template's `index.titleStartsWith`), or the batch records of the runs that made them
 * -- which makes NO collection search at all (spec section 7).
 */
export type BuildSource = { kind: 'collection' } | { kind: 'record'; record: BatchRecord };

/** What an index is built from: batch records, or a search of one collection. */
export type IndexSourceChoice = { records: readonly string[] } | { collectionUuid: string };

export interface SourceSite {
  baseUrl: string;
  /** The collection the site's own schema was read from ('' when none), and that schema ('' when none). */
  configuredCollectionUuid: string;
  configuredSchemaUuid: string;
}

/**
 * Where an index's items come from -- ONE rule for the CLI and the desktop.
 * Without records, a search of the chosen collection. With them, the records
 * -- combined -- in THEIR collection, and only when they were made on this
 * site (`readBatchRecordsFor`): the index's links are built from this site's
 * address. Makes no request, so a record of another site is refused before
 * anything signs in.
 *
 * `fallbackSchemaUuid` is the configured schema only for the configured
 * collection: a site's collections can use different schemas, and another
 * collection borrowing it would write fields its schema lacks.
 */
export async function resolveIndexSource(
  choice: IndexSourceChoice,
  site: SourceSite,
): Promise<{ collectionUuid: string; source: BuildSource; fallbackSchemaUuid: string }> {
  let collectionUuid: string;
  let source: BuildSource;
  if ('collectionUuid' in choice) {
    collectionUuid = choice.collectionUuid;
    source = { kind: 'collection' };
  } else {
    const record = await readBatchRecordsFor(choice.records, site.baseUrl);
    collectionUuid = record.collectionUuid;
    source = { kind: 'record', record };
  }
  const configured = site.configuredCollectionUuid !== '' && collectionUuid === site.configuredCollectionUuid;
  return { collectionUuid, source, fallbackSchemaUuid: configured ? site.configuredSchemaUuid : '' };
}

export interface BuildArgs {
  client: {
    searchCollection(collectionUuid: string, opts?: { where?: string }): Promise<CollectionItem[]>;
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
  const prefix = profile.index.titleStartsWith;
  const { source } = args;
  let where: string | undefined;
  if (prefix !== undefined && source.kind === 'collection') {
    // Never fall back to reading everything: the template asked to narrow, and a
    // whole-collection read would list what it meant to leave out.
    if (args.schema.titleHeader === null) {
      throw new ValidationError(
        'The template narrows the index by "titleStartsWith", which needs the schema\'s title field, and ' +
          "this collection's schema declares no name path.",
      );
    }
    where = `/xml/${args.schema.titleHeader} LIKE '${escapeWhereValue(prefix)}%'`;
  }

  const record = indexRecord(profile.index, args.schema);
  // Sequential, never side by side: a lookup that fails must not leave the
  // paginated search below still paging in the background.
  const existing = await findExistingIndex(args.client, args.collectionUuid, record);
  const hits =
    source.kind === 'record'
      ? recordHits(source.record)
      : (await args.client.searchCollection(args.collectionUuid, { where })).map(toHit);
  // The index item -- or each of several -- is left out of the listing: it
  // lives in the collection it indexes, and is not "not in the series".
  const self = new Set(
    existing.kind === 'one' ? [existing.uuid] : existing.kind === 'many' ? existing.items.map((i) => i.uuid) : [],
  );
  const notCreated = source.kind === 'record' ? source.record.leftOut : [];
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
  const gaps = missingNote(b.index, L);
  if (gaps) lines.push(gaps);
  for (const h of b.index.heldBack) {
    lines.push(`Held back: ${h.reason} -- ${h.items.map((i) => i.name).join(', ')}`);
  }
  const left = b.index.notInSeries;
  if (left.length > 0) {
    const more = andMore(left.length);
    lines.push(
      `Not in the series (${left.length}): ` +
        left.slice(0, NOT_IN_SERIES_SHOWN).map(notInSeriesEntry).join('; ') +
        (more ? `; ${more}` : ''),
    );
  }
  if (b.notCreated.length > 0) {
    lines.push(`Not created by the run (${b.notCreated.length}): ` + b.notCreated.map(notCreatedEntry).join('; '));
  }
  lines.push(existingNote(b.existing).text);
  return lines;
}
