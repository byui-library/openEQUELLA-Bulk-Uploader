// src/desktop/indexHandlers.ts
import { randomUUID } from 'node:crypto';
import type { IpcMain } from 'electron';
import { CHANNELS, type IndexPreview, type IndexSaveResult, type IndexUploadResult, type OeqApi } from './ipc.js';
import type { CollectionItem, CollectionSummary, CurrentUser } from '../core/client.js';
import type { SchemaInfo } from '../core/discovery.js';
import { assertNotGuest } from '../core/identity.js';
import { ValidationError } from '../core/errors.js';
import { listTemplates, loadTemplate, type TemplateSummary } from '../core/extract/templates.js';
import { buildIndex, resolveIndexSchema, type IndexBuild } from '../core/seriesIndex/build.js';
import { saveIndexFiles } from '../core/seriesIndex/files.js';
import { publishIndex, type IndexClient } from '../core/seriesIndex/publish.js';
import { itemUrl } from '../core/seriesIndex/collect.js';
import { indexPageUrl, linkVolumes, type LinkResult } from '../core/seriesIndex/links.js';

/**
 * The series index's main-process side. The BUILD STAYS HERE, held by id, and
 * the renderer gets a summary: saving and uploading then use the exact bytes
 * the operator previewed, and a new preview supersedes the old id.
 */

export type IndexConnection = {
  client: IndexClient & {
    currentUser(): Promise<CurrentUser>;
    getCollection(uuid: string): Promise<CollectionSummary>;
    getSchema(uuid: string): Promise<SchemaInfo>;
    searchCollection(collectionUuid: string): Promise<CollectionItem[]>;
  };
  baseUrl: string;
  /** The schema Setup read for this site, for a collection that names none. */
  fallbackSchemaUuid: string;
};

export interface IndexHandlerDeps {
  templatesDir?: string;
  connect(instanceId: string): Promise<IndexConnection>;
  newId?: () => string;
}

export function createIndexHandlers(deps: IndexHandlerDeps) {
  const newId = deps.newId ?? randomUUID;
  let held: { id: string; build: IndexBuild; connection: IndexConnection } | null = null;

  const take = (buildId: string) => {
    if (held === null || held.id !== buildId) {
      throw new ValidationError('That index preview is no longer current. Preview again, then save or upload.');
    }
    return held;
  };

  return {
    async templates(): Promise<TemplateSummary[]> {
      const all = await listTemplates(deps.templatesDir);
      const usable: TemplateSummary[] = [];
      for (const t of all) {
        const p = await loadTemplate(t.id, deps.templatesDir);
        if (p.index && p.checks?.sequence) usable.push(t);
      }
      return usable;
    },

    async preview(args: Parameters<OeqApi['indexPreview']>[0]): Promise<IndexPreview> {
      held = null;
      const connection = await deps.connect(args.instanceId);
      const { client } = connection;
      assertNotGuest(await client.currentUser(), 'Sign in to this site again, then build the index.');
      const profile = await loadTemplate(args.templateId, deps.templatesDir);
      const schema = await resolveIndexSchema(client, args.collectionUuid, connection.fallbackSchemaUuid);
      const build = await buildIndex({
        client,
        baseUrl: connection.baseUrl,
        collectionUuid: args.collectionUuid,
        profile,
        schema,
      });
      const id = newId();
      held = { id, build, connection };
      const e = build.existing;
      return {
        buildId: id,
        title: build.record.title,
        volumes: build.index.volumes.map((v) => ({ heading: v.heading, issues: v.issues.map((i) => i.label) })),
        issueCount: build.index.volumes.reduce((n, v) => n + v.issues.length, 0),
        heldBack: build.index.heldBack.map((h) => ({ reason: h.reason, items: h.items.map((i) => i.name) })),
        notInSeries: build.index.notInSeries.map((l) => ({ name: l.name, reason: l.reason })),
        labels: { ...build.labels },
        existing:
          e.kind === 'one'
            ? { kind: 'one', status: e.status }
            : e.kind === 'many'
              ? { kind: 'many', names: e.items.map((i) => i.name) }
              : e,
      };
    },

    async saveFiles(args: Parameters<OeqApi['indexSaveFiles']>[0]): Promise<IndexSaveResult> {
      return saveIndexFiles(args.dir, take(args.buildId).build.files, args.replace);
    },

    async upload(args: Parameters<OeqApi['indexUpload']>[0]): Promise<IndexUploadResult> {
      const { build, connection } = take(args.buildId);
      const result = await publishIndex(connection.client, {
        collectionUuid: build.collectionUuid,
        record: build.record,
        files: build.files,
        existing: build.existing,
        draft: args.draft,
      });
      // The item now exists: a second upload from this same preview must update
      // it, not create a duplicate. `held` stays, so later steps can use it.
      build.existing = {
        kind: 'one',
        uuid: result.uuid,
        version: result.version,
        status:
          build.existing.kind === 'one' ? build.existing.status : args.draft ? 'draft' : 'live',
      };
      return { kind: result.kind, url: `${itemUrl(connection.baseUrl, result.uuid)}index.html` };
    },

    async linkVolumes(args: Parameters<OeqApi['indexLinkVolumes']>[0]): Promise<LinkResult> {
      const { build, connection } = take(args.buildId);
      // `existing` is 'one' when the item was found at preview time, or once
      // `upload` above has created it -- either way it names the item to link to.
      const e = build.existing;
      if (e.kind !== 'one') throw new ValidationError('Upload the index item first.');
      return linkVolumes(
        connection.client,
        build.index.volumes,
        indexPageUrl(connection.baseUrl, e.uuid),
        `Index of all ${build.labels.groups}`,
      );
    },
  };
}

export function registerIndexHandlers(ipcMain: IpcMain, deps: IndexHandlerDeps): void {
  const h = createIndexHandlers(deps);
  ipcMain.handle(CHANNELS.indexTemplates, () => h.templates());
  ipcMain.handle(CHANNELS.indexPreview, (_e, args: Parameters<OeqApi['indexPreview']>[0]) => h.preview(args));
  ipcMain.handle(CHANNELS.indexSaveFiles, (_e, args: Parameters<OeqApi['indexSaveFiles']>[0]) => h.saveFiles(args));
  ipcMain.handle(CHANNELS.indexUpload, (_e, args: Parameters<OeqApi['indexUpload']>[0]) => h.upload(args));
  ipcMain.handle(CHANNELS.indexLinkVolumes, (_e, args: Parameters<OeqApi['indexLinkVolumes']>[0]) =>
    h.linkVolumes(args),
  );
}
