// src/cli/indexPage.ts
import { loadConfig, createAuthProvider } from '../core/config.js';
import { OeqClient } from '../core/client.js';
import { assertNotGuest } from '../core/identity.js';
import { ValidationError } from '../core/errors.js';
import { loadProfile } from '../core/extract/profile.js';
import { buildIndex, previewLines, resolveIndexSchema, type BuildSource } from '../core/seriesIndex/build.js';
import { readBatchRecords } from '../core/seriesIndex/batchRecord.js';
import { instanceEndpoint } from '../core/instanceUrl.js';
import { saveIndexFiles } from '../core/seriesIndex/files.js';
import { publishIndex } from '../core/seriesIndex/publish.js';
import { itemUrl } from '../core/seriesIndex/collect.js';
import { indexPageUrl, linkLine, linkVolumes } from '../core/seriesIndex/links.js';

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

/**
 * One spelling per site, for comparison only: `instanceEndpoint` lower-cases
 * the host and leaves exactly one trailing slash. Not `normaliseInstanceUrl`,
 * whose https rule is about sending a password and would answer a loopback
 * test site with a lecture instead of a comparison.
 */
function siteKey(url: string): string | null {
  try {
    return instanceEndpoint(url, '').href;
  } catch {
    return null;
  }
}

/**
 * Where the index's items come from. Without records, a search of the
 * configured collection. With them, the records -- combined -- in THEIR
 * collection, and only when they were made on the configured site: the
 * index's links are built from that site's address, so a record of another
 * would publish links to the wrong server.
 */
export async function indexSource(
  records: readonly string[] | null,
  cfg: { baseUrl: string; collectionUuid: string },
): Promise<{ collectionUuid: string; source: BuildSource }> {
  if (records === null) return { collectionUuid: cfg.collectionUuid, source: { kind: 'collection' } };
  const record = await readBatchRecords(records);
  const recorded = siteKey(record.baseUrl);
  if (recorded === null || recorded !== siteKey(cfg.baseUrl)) {
    throw new ValidationError(
      `The batch record was made on a different site (${record.baseUrl}) from the one configured here ` +
        `(${cfg.baseUrl}). Refusing: the index's links would point at the wrong server.`,
    );
  }
  return { collectionUuid: record.collectionUuid, source: { kind: 'record', record } };
}

export async function indexAction(o: IndexCliOptions, env: Env = process.env): Promise<number> {
  const flags = checkIndexFlags(o);
  const cfg = loadConfig(env);
  // Before signing in: a record of another site is refused without a request.
  const { collectionUuid, source } = await indexSource(flags.records, cfg);
  const client = new OeqClient(cfg.baseUrl, createAuthProvider(cfg, env));
  assertNotGuest(await client.currentUser(), 'Run `oeq-upload login` first.');

  const profile = await loadProfile(o.template);
  // OEQ_SCHEMA_UUID describes the CONFIGURED collection; never lend it to a record's other one.
  const schema = await resolveIndexSchema(client, collectionUuid, collectionUuid === cfg.collectionUuid ? cfg.schemaUuid : '');
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
        `Index of all ${build.labels.groups}`,
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
