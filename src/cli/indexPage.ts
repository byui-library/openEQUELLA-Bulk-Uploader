// src/cli/indexPage.ts
import { loadConfig, createAuthProvider } from '../core/config.js';
import { OeqClient } from '../core/client.js';
import { assertNotGuest } from '../core/identity.js';
import { ValidationError } from '../core/errors.js';
import { loadProfile } from '../core/extract/profile.js';
import { buildIndex, previewLines, resolveIndexSchema } from '../core/seriesIndex/build.js';
import { saveIndexFiles } from '../core/seriesIndex/files.js';
import { publishIndex } from '../core/seriesIndex/publish.js';
import { itemUrl } from '../core/seriesIndex/collect.js';

type Env = Record<string, string | undefined>;

export interface IndexCliOptions {
  template: string;
  out?: string;
  force?: boolean;
  upload?: boolean;
  draft?: boolean;
  publish?: boolean;
}

/** Flag rules, checked before any I/O. No destination is a preview -- the CLI's "preview first". */
export function checkIndexFlags(o: IndexCliOptions): { out: string | null; upload: { draft: boolean } | null } {
  if (o.force && !o.out) throw new ValidationError('--force replaces files in the --out folder, so it needs --out.');
  if ((o.draft || o.publish) && !o.upload) throw new ValidationError('--draft and --publish only mean something with --upload.');
  if (o.upload && Boolean(o.draft) === Boolean(o.publish)) {
    throw new ValidationError('--upload needs exactly one of --draft or --publish. Refusing to guess.');
  }
  return { out: o.out ?? null, upload: o.upload ? { draft: Boolean(o.draft) } : null };
}

export async function indexAction(o: IndexCliOptions, env: Env = process.env): Promise<number> {
  const flags = checkIndexFlags(o);
  const cfg = loadConfig(env);
  const client = new OeqClient(cfg.baseUrl, createAuthProvider(cfg, env));
  assertNotGuest(await client.currentUser(), 'Run `oeq-upload login` first.');

  const profile = await loadProfile(o.template);
  const schema = await resolveIndexSchema(client, cfg.collectionUuid, cfg.schemaUuid);
  const build = await buildIndex({ client, baseUrl: cfg.baseUrl, collectionUuid: cfg.collectionUuid, profile, schema });
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
      collectionUuid: cfg.collectionUuid,
      record: build.record,
      files: build.files,
      existing: build.existing,
      draft: flags.upload.draft,
    });
    console.log(`\n${result.kind === 'created' ? 'Created' : 'Updated'} the index item: ${itemUrl(cfg.baseUrl, result.uuid)}index.html`);
  }
  return code;
}
