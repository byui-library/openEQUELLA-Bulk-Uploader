// src/core/seriesIndex/publish.ts
import { randomUUID } from 'node:crypto';
import type { CollectionItem, CreateItemRequest, CreateItemResult } from '../client.js';
import { ValidationError } from '../errors.js';
import { buildMetadataXml } from '../metadata.js';
import type { IndexRecord } from './record.js';
import { INDEX_FILE_NAMES, type IndexFiles } from './types.js';

/**
 * The openEQUELLA destination. ONE index item per identifier: none -> create,
 * one -> update IN PLACE (checked live 2026-11-17), several -> refuse and name
 * them, because nothing here can know which one readers already link to.
 *
 * An update KEEPS THE ITEM'S STATE: it never publishes a draft or unpublishes
 * a live item. An edit copies the bean whole and changes what it names
 * (CLAUDE.md) -- so attachments other than the three index files stay.
 */

export interface IndexClient {
  findByField(collectionUuid: string, path: string, value: string): Promise<CollectionItem[]>;
  createStagingArea(): Promise<string>;
  uploadToStaging(stagingUuid: string, filename: string, body: BodyInit): Promise<void>;
  deleteStagingArea(uuid: string): Promise<void>;
  createItem(req: CreateItemRequest): Promise<CreateItemResult>;
  getItemBean(uuid: string, version: number): Promise<Record<string, unknown>>;
  editItem(uuid: string, version: number, bean: Record<string, unknown>, stagingUuid?: string): Promise<void>;
}

export type ExistingIndex =
  | { kind: 'none' }
  | { kind: 'one'; uuid: string; version: number; status: string }
  | { kind: 'many'; items: { uuid: string; name: string }[] }
  | { kind: 'unavailable'; reason: string };

export async function findExistingIndex(
  client: Pick<IndexClient, 'findByField'>,
  collectionUuid: string,
  record: IndexRecord,
): Promise<ExistingIndex> {
  if (record.identifier === null) {
    return { kind: 'unavailable', reason: record.identifierProblem ?? 'The index has no identifier.' };
  }
  const found = await client.findByField(collectionUuid, record.identifier.path, record.identifier.value);
  if (found.length === 0) return { kind: 'none' };
  if (found.length === 1) {
    const one = found[0]!;
    return { kind: 'one', uuid: one.uuid, version: one.version, status: one.status };
  }
  return { kind: 'many', items: found.map((f) => ({ uuid: f.uuid, name: f.name ?? f.uuid })) };
}

export interface PublishArgs {
  collectionUuid: string;
  record: IndexRecord;
  files: IndexFiles;
  existing: ExistingIndex;
  /** For a NEW item only; an update keeps the item's state. */
  draft: boolean;
}

export type PublishResult = { kind: 'created' | 'updated'; uuid: string; version: number };

export async function publishIndex(client: IndexClient, args: PublishArgs): Promise<PublishResult> {
  const { existing } = args;
  if (existing.kind === 'unavailable') throw new ValidationError(existing.reason);
  if (existing.kind === 'many') {
    throw new ValidationError(
      `${existing.items.length} items already carry this index's identifier (${existing.items
        .map((i) => i.name)
        .join(', ')}). Remove the extra ones in openEQUELLA, then build again.`,
    );
  }

  const metadata = buildMetadataXml(args.record.fields);
  const staging = await client.createStagingArea();
  try {
    for (const name of INDEX_FILE_NAMES) await client.uploadToStaging(staging, name, args.files[name]);

    if (existing.kind === 'none') {
      const created = await client.createItem({
        collectionUuid: args.collectionUuid,
        metadata,
        stagingUuid: staging,
        draft: args.draft,
        attachments: INDEX_FILE_NAMES.map((name) => ({ filename: name, description: name, uuid: randomUUID() })),
      });
      return { kind: 'created', uuid: created.uuid, version: created.version };
    }

    const bean = await client.getItemBean(existing.uuid, existing.version);
    const current = Array.isArray(bean['attachments']) ? (bean['attachments'] as Record<string, unknown>[]) : [];
    const ours = new Set<string>(INDEX_FILE_NAMES);
    const uuidOf = (name: string) =>
      current.find((a) => a['type'] === 'file' && a['filename'] === name)?.['uuid'];
    const attachments = [
      ...INDEX_FILE_NAMES.map((name) => ({
        type: 'file',
        filename: name,
        description: name,
        uuid: typeof uuidOf(name) === 'string' ? (uuidOf(name) as string) : randomUUID(),
      })),
      ...current.filter((a) => !(a['type'] === 'file' && ours.has(String(a['filename'])))),
    ];
    await client.editItem(existing.uuid, existing.version, { ...bean, metadata, attachments }, staging);
    return { kind: 'updated', uuid: existing.uuid, version: existing.version };
  } catch (err) {
    // Best-effort: a failed cleanup must never replace the real error.
    await client.deleteStagingArea(staging).catch(() => {});
    throw err;
  }
}
