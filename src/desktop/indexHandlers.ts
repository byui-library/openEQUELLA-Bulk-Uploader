// src/desktop/indexHandlers.ts
import { randomUUID } from 'node:crypto';
import type { IpcMain } from 'electron';
import { CHANNELS, type IndexPreview, type IndexSaveResult, type IndexUploadResult, type OeqApi } from './ipc.js';
import type { CollectionItem, CollectionSummary, CurrentUser } from '../core/client.js';
import type { SchemaInfo } from '../core/discovery.js';
import { assertNotGuest } from '../core/identity.js';
import { ValidationError } from '../core/errors.js';
import { describeReason } from '../core/errorReason.js';
import { listTemplates, loadTemplate, type TemplateSummary } from '../core/extract/templates.js';
import { buildIndex, resolveIndexSchema, resolveIndexSource, type IndexBuild } from '../core/seriesIndex/build.js';
import { saveIndexFiles } from '../core/seriesIndex/files.js';
import { findExistingIndex, publishIndex, type IndexClient } from '../core/seriesIndex/publish.js';
import { itemUrl } from '../core/seriesIndex/collect.js';
import { indexPageUrl, linkVolumes, type LinkResult } from '../core/seriesIndex/links.js';
import { indexLinkLabel } from '../core/seriesIndex/words.js';

/**
 * The series index's main-process side. The BUILD STAYS HERE, held by id, and
 * the renderer gets a summary: saving and uploading then use the exact bytes
 * the operator previewed, and a new preview supersedes the old id.
 *
 * WHAT IS HELD IS THE BUILD, NEVER THE SESSION. Every write -- upload, link --
 * connects afresh and checks it is not a guest: a session openEQUELLA has
 * since expired is answered as the guest with 200 and empty data, never a 401
 * (CLAUDE.md). And the upload asks again which index item exists, because one
 * may have been made since the preview -- by another operator, or by the CLI.
 */

export type IndexConnection = {
  client: IndexClient & {
    currentUser(): Promise<CurrentUser>;
    getCollection(uuid: string): Promise<CollectionSummary>;
    getSchema(uuid: string): Promise<SchemaInfo>;
    searchCollection(collectionUuid: string, opts?: { where?: string }): Promise<CollectionItem[]>;
  };
  baseUrl: string;
  /** The schema Setup read for this site, for a collection that names none. */
  fallbackSchemaUuid: string;
  /**
   * The collection Setup read `fallbackSchemaUuid` FROM. The fallback is used
   * for that collection only: a site's collections can use different schemas,
   * and another collection borrowing it would write fields its schema lacks.
   */
  setupCollectionUuid: string;
};

export interface IndexHandlerDeps {
  templatesDir?: string;
  connect(instanceId: string): Promise<IndexConnection>;
  newId?: () => string;
}

type IndexItem = { uuid: string; version: number; status: string };

export function createIndexHandlers(deps: IndexHandlerDeps) {
  const newId = deps.newId ?? randomUUID;
  let held: {
    id: string;
    build: IndexBuild;
    instanceId: string;
    /**
     * The index item, as last known: the one the preview found, or the one an
     * upload from this preview created or updated. Kept because search may not
     * list a just-created item yet; `build.existing` stays what the preview saw.
     */
    item: IndexItem | null;
  } | null = null;
  /** How many previews have STARTED; see preview. */
  let previews = 0;

  /** A fresh session for one step (preview, upload, link), refused if openEQUELLA answers it as the guest. */
  const signedIn = async (instanceId: string, action: string): Promise<IndexConnection> => {
    const connection = await deps.connect(instanceId);
    assertNotGuest(await connection.client.currentUser(), `Sign in to this site again, then ${action}.`);
    return connection;
  };

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
        // One broken template must not hide every other: it is skipped and
        // named on the terminal, and the rest are still offered.
        let p;
        try {
          p = await loadTemplate(t.id, deps.templatesDir);
        } catch (err) {
          console.warn(`Series index: skipped the '${t.id}' template -- ${describeReason(err)}`);
          continue;
        }
        if (p.index && p.checks?.sequence) usable.push(t);
      }
      return usable;
    },

    /**
     * Only the LATEST-STARTED preview may be held. One started earlier that
     * finishes later still returns its summary, but under an id that is not
     * held -- so saving or uploading it says "Preview again" rather than
     * writing a build the operator has already moved past.
     */
    async preview(args: Parameters<OeqApi['indexPreview']>[0]): Promise<IndexPreview> {
      const ticket = ++previews;
      held = null;
      // Not `signedIn`: the record is read and its site checked BETWEEN
      // connecting and the guest check, so a record of another site is refused
      // before anything is asked of the server.
      const connection = await deps.connect(args.instanceId);
      // The index's links are built from THIS site's address, so a record of
      // another would point them at the wrong server. The record's collection
      // then drives everything below -- the schema, the existing-item search
      // and the upload.
      const { collectionUuid, source, fallbackSchemaUuid } = await resolveIndexSource(
        'recordPaths' in args ? { records: args.recordPaths } : { collectionUuid: args.collectionUuid },
        {
          baseUrl: connection.baseUrl,
          configuredCollectionUuid: connection.setupCollectionUuid,
          configuredSchemaUuid: connection.fallbackSchemaUuid,
        },
      );
      const { client } = connection;
      assertNotGuest(await client.currentUser(), 'Sign in to this site again, then build the index.');
      const profile = await loadTemplate(args.templateId, deps.templatesDir);
      const schema = await resolveIndexSchema(client, collectionUuid, fallbackSchemaUuid);
      const build = await buildIndex({
        client,
        baseUrl: connection.baseUrl,
        collectionUuid,
        source,
        profile,
        schema,
      });
      const id = newId();
      const e = build.existing;
      if (ticket === previews) {
        const item = e.kind === 'one' ? { uuid: e.uuid, version: e.version, status: e.status } : null;
        held = { id, build, instanceId: args.instanceId, item };
      }
      return {
        buildId: id,
        title: build.record.title,
        volumes: build.index.volumes.map((v) => ({ heading: v.heading, issues: v.issues.map((i) => i.label) })),
        issueCount: build.index.volumes.reduce((n, v) => n + v.issues.length, 0),
        heldBack: build.index.heldBack.map((h) => ({ reason: h.reason, items: h.items.map((i) => i.name) })),
        notInSeries: build.index.notInSeries.map((l) => ({ name: l.name, reason: l.reason })),
        missing: build.index.missing,
        missingCount: build.index.missingCount,
        labels: { ...build.labels },
        existing:
          e.kind === 'one'
            ? { kind: 'one', status: e.status }
            : e.kind === 'many'
              ? { kind: 'many', items: e.items.map(({ name }) => ({ name })) }
              : e,
        notCreated: build.notCreated.map((n) => ({
          label: n.label,
          status: n.status,
          ...(n.error !== undefined ? { error: n.error } : {}),
        })),
      };
    },

    async saveFiles(args: Parameters<OeqApi['indexSaveFiles']>[0]): Promise<IndexSaveResult> {
      return saveIndexFiles(args.dir, take(args.buildId).build.files, args.replace);
    },

    async upload(args: Parameters<OeqApi['indexUpload']>[0]): Promise<IndexUploadResult> {
      const h = take(args.buildId);
      const { build } = h;
      const connection = await signedIn(h.instanceId, 'upload the index');
      // Asked again, not trusted from the preview: an item made since then is
      // updated, never duplicated; several now, or none findable, is refused by
      // publishIndex. The one exception is the item already known here --
      // search may not list a just-created one yet, and "none" must not
      // duplicate it.
      let existing = await findExistingIndex(connection.client, build.collectionUuid, build.record);
      if (existing.kind === 'none' && h.item !== null) existing = { kind: 'one', ...h.item };
      const result = await publishIndex(connection.client, {
        collectionUuid: build.collectionUuid,
        record: build.record,
        files: build.files,
        existing,
        draft: args.draft,
      });
      // The item now exists: a second upload from this same preview must update
      // it, not create a duplicate. `held` stays, so later steps can use it.
      const status = existing.kind === 'one' ? existing.status : args.draft ? 'draft' : 'live';
      h.item = { uuid: result.uuid, version: result.version, status };
      return { kind: result.kind, url: `${itemUrl(connection.baseUrl, result.uuid)}index.html`, status };
    },

    async linkVolumes(args: Parameters<OeqApi['indexLinkVolumes']>[0]): Promise<LinkResult> {
      const h = take(args.buildId);
      const { build, item } = h;
      if (item === null) throw new ValidationError('Upload the index item first.');
      const connection = await signedIn(h.instanceId, 'link the volumes');
      return linkVolumes(
        connection.client,
        build.index.volumes,
        indexPageUrl(connection.baseUrl, item.uuid),
        indexLinkLabel(build.labels),
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
