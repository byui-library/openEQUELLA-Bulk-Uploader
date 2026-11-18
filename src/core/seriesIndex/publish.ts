// src/core/seriesIndex/publish.ts
import { randomUUID } from 'node:crypto';
import type { CollectionItem, CreateItemRequest, CreateItemResult } from '../client.js';
import { ValidationError } from '../errors.js';
import { buildMetadataXml, mergeMetadataXml } from '../metadata.js';
import type { IndexRecord } from './record.js';
import { INDEX_FILE_NAMES, type IndexFiles } from './types.js';
import { existingNote } from './words.js';

/**
 * The openEQUELLA destination. ONE index item per identifier: none -> create,
 * one -> update IN PLACE (checked live 2026-11-17), several -> refuse and name
 * them, because nothing here can know which one readers already link to.
 *
 * An update KEEPS THE ITEM'S STATE: it never publishes a draft or unpublishes
 * a live item. An edit copies the bean whole and changes what it names
 * (CLAUDE.md) -- so attachments other than the three index files stay, and
 * the record is MERGED: only the template's paths change.
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
  if (existing.kind === 'unavailable' || existing.kind === 'many') {
    throw new ValidationError(existingNote(existing).text);
  }

  const staging = await client.createStagingArea();
  try {
    for (const name of INDEX_FILE_NAMES) await client.uploadToStaging(staging, name, args.files[name]);

    const bean = existing.kind === 'one' ? await client.getItemBean(existing.uuid, existing.version) : null;
    const current =
      bean !== null && Array.isArray(bean['attachments']) ? (bean['attachments'] as Record<string, unknown>[]) : [];
    const names = new Set<unknown>(INDEX_FILE_NAMES);
    const isOurs = (a: Record<string, unknown>) => a['type'] === 'file' && names.has(a['filename']);
    const kept = new Map<unknown, string>();
    for (const a of current) {
      if (isOurs(a) && typeof a['uuid'] === 'string' && !kept.has(a['filename'])) kept.set(a['filename'], a['uuid']);
    }
    const ours = INDEX_FILE_NAMES.map((name) => ({
      type: 'file',
      filename: name,
      description: name,
      uuid: kept.get(name) ?? randomUUID(),
    }));

    if (existing.kind === 'none' || bean === null) {
      const created = await client.createItem({
        collectionUuid: args.collectionUuid,
        metadata: buildMetadataXml(args.record.fields),
        stagingUuid: staging,
        draft: args.draft,
        attachments: ours,
      });
      return { kind: 'created', uuid: created.uuid, version: created.version };
    }

    const attachments = [...ours, ...current.filter((a) => !isOurs(a))];
    // MERGED, never rebuilt: the item's other fields are a cataloguer's, not ours.
    const existingXml = typeof bean['metadata'] === 'string' ? bean['metadata'] : '';
    const metadata = mergeMetadataXml(existingXml, args.record.fields);
    await client.editItem(existing.uuid, existing.version, { ...bean, metadata, attachments }, staging);
    return { kind: 'updated', uuid: existing.uuid, version: existing.version };
  } catch (err) {
    // Best-effort: a failed cleanup must never replace the real error.
    await client.deleteStagingArea(staging).catch(() => {});
    throw err;
  }
}
