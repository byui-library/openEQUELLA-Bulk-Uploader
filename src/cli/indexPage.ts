// src/cli/indexPage.ts
import { loadConfig, createAuthProvider } from '../core/config.js';
import { OeqClient } from '../core/client.js';
import { assertNotGuest } from '../core/identity.js';
import { ValidationError } from '../core/errors.js';
import { loadProfile } from '../core/extract/profile.js';
import { buildIndex, previewLines, resolveIndexSchema, resolveIndexSource } from '../core/seriesIndex/build.js';
import { saveIndexFiles } from '../core/seriesIndex/files.js';
import { publishIndex } from '../core/seriesIndex/publish.js';
import { itemUrl } from '../core/seriesIndex/collect.js';
import { indexPageUrl, linkLine, linkVolumes } from '../core/seriesIndex/links.js';
import { indexLinkLabel } from '../core/seriesIndex/words.js';

type Env = Record<string, string | undefined>;

export interface IndexCliOptions {
  template: string;
  out?: string;
  force?: boolean;
  upload?: boolean;
  draft?: boolean;
  publish?: boolean;
  linkVolumes?: boolean;
  /** Batch records written by `run --index-record`: build from these, not a search of the collection. */
  fromRecord?: string[];
}

/** Flag rules, checked before any I/O. No destination is a preview -- the CLI's "preview first". */
export function checkIndexFlags(o: IndexCliOptions): {
  out: string | null;
  upload: { draft: boolean } | null;
  link: boolean;
  records: string[] | null;
} {
  if (o.fromRecord !== undefined && o.fromRecord.length === 0) {
    throw new ValidationError('--from-record needs at least one batch record file.');
  }
  if (o.force && !o.out) throw new ValidationError('--force replaces files in the --out folder, so it needs --out.');
  if ((o.draft || o.publish) && !o.upload) throw new ValidationError('--draft and --publish only mean something with --upload.');
  if (o.upload && Boolean(o.draft) === Boolean(o.publish)) {
    throw new ValidationError('--upload needs exactly one of --draft or --publish. Refusing to guess.');
  }
  // Strict: the upload is idempotent (an existing item is updated in place), so
  // requiring it costs nothing and guarantees the index item the links point at.
  if (o.linkVolumes && !o.upload) {
    throw new ValidationError('--link-volumes needs --upload: the links point at the index item, so it is uploaded first.');
  }
  return {
    out: o.out ?? null,
    upload: o.upload ? { draft: Boolean(o.draft) } : null,
    link: Boolean(o.linkVolumes),
    records: o.fromRecord ?? null,
  };
}

export async function indexAction(o: IndexCliOptions, env: Env = process.env): Promise<number> {
  const flags = checkIndexFlags(o);
  const cfg = loadConfig(env);
  // Before signing in: a record of another site is refused without a request.
  // OEQ_SCHEMA_UUID describes the CONFIGURED collection; it is never lent to a record's other one.
  const { collectionUuid, source, fallbackSchemaUuid } = await resolveIndexSource(flags.records, {
    baseUrl: cfg.baseUrl,
    collectionUuid: cfg.collectionUuid,
    configuredCollectionUuid: cfg.collectionUuid,
    configuredSchemaUuid: cfg.schemaUuid,
  });
  const client = new OeqClient(cfg.baseUrl, createAuthProvider(cfg, env));
  assertNotGuest(await client.currentUser(), 'Run `oeq-upload login` first.');

  const profile = await loadProfile(o.template);
  const schema = await resolveIndexSchema(client, collectionUuid, fallbackSchemaUuid);
  const build = await buildIndex({ client, baseUrl: cfg.baseUrl, collectionUuid, source, profile, schema });
  for (const line of previewLines(build)) console.log(line);

  if (!flags.out && !flags.upload) {
    console.log('\nPreview only. Add --out <dir> and/or --upload --draft|--publish to build.');
    return 0;
  }
  if (build.index.volumes.length === 0) {
    console.error('\nNothing to build: no volume could be listed.');
    return 1;
  }

  let code = 0;
  if (flags.out) {
    const saved = await saveIndexFiles(flags.out, build.files, Boolean(o.force));
    if (saved.kind === 'exists') {
      console.error(`\nNot saved: ${saved.names.join(', ')} already exist in ${flags.out}. Add --force to replace them.`);
      code = 1;
    } else {
      console.log(`\nSaved: ${saved.paths.join(', ')}`);
    }
  }
  if (flags.upload) {
    const result = await publishIndex(client, {
      collectionUuid,
      record: build.record,
      files: build.files,
      existing: build.existing,
      draft: flags.upload.draft,
    });
    console.log(`\n${result.kind === 'created' ? 'Created' : 'Updated'} the index item: ${itemUrl(cfg.baseUrl, result.uuid)}index.html`);
    if (flags.link) {
      // After the upload, so a newly created index item's uuid is known. Only
      // the LISTED volumes: a held-back one is not in the index it would point at.
      const linked = await linkVolumes(
        client,
        build.index.volumes,
        indexPageUrl(cfg.baseUrl, result.uuid),
        indexLinkLabel(build.labels),
      );
      const line = linkLine(linked, { ...build.labels, heldBack: build.index.heldBack.length });
      if (linked.failed.length > 0) {
        console.error(line);
        code = 1;
      } else {
        console.log(line);
      }
    }
  }
  return code;
}
