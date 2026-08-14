// tests/desktop/extractHandlers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerExtractHandlers, __resetExtractCache } from '../../src/desktop/extractHandlers.js';
import { makeDocx, makePdf } from '../fixtures/extract/make.js';
import { ATTACHMENT_COLUMN, type Profile } from '../../src/core/extract/types.js';
import type { SchemaInfo } from '../../src/core/discovery.js';

/** A stand-in for Electron's ipcMain that just records the handlers. */
function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();
  return {
    handle(channel: string, fn: (event: unknown, ...args: any[]) => unknown) {
      handlers.set(channel, fn);
    },
    call<T>(channel: string, ...args: unknown[]): Promise<T> {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return Promise.resolve(fn({}, ...args) as T);
    },
    channels: () => [...handlers.keys()],
  };
}

const profile: Profile = {
  version: 1,
  pattern: '{title}.pdf',
  columns: [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
  ],
};

async function folder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-eh-'));
  await writeFile(join(dir, 'Recital.pdf'), makePdf({ text: 'Performer: Jane Smith' }));
  await writeFile(join(dir, 'notes.txt'), 'x');
  return dir;
}

describe('extract handlers', () => {
  beforeEach(() => __resetExtractCache());

  it('registers every extract channel', () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml', templatesDir: 'templates' });
    expect(ipc.channels()).toEqual(
      expect.arrayContaining([
        'oeq:extractScan', 'oeq:extractPreview', 'oeq:extractRun', 'oeq:schemaPaths',
        'oeq:schemaNamePath', 'oeq:listTemplates', 'oeq:loadTemplate',
      ]),
    );
  });

  /**
   * The picker leads with the section this path names. Parsed here, in the
   * main process, because reading the schema reaches `node:fs` -- an import
   * the sandboxed renderer cannot survive.
   */
  it('reports the xpath the schema declares as the item name', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml', templatesDir: 'templates' });
    expect(await ipc.call<string | null>('oeq:schemaNamePath')).toBe('MWDL/title');
  });

  it('scan reports supported files, skipped files and the labels it found', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml', templatesDir: 'templates' });
    const scan = await ipc.call<{ supported: string[]; skipped: { file: string }[]; labels: string[] }>(
      'oeq:extractScan', await folder(),
    );
    expect(scan.supported).toEqual(['Recital.pdf']);
    expect(scan.skipped.map((s) => s.file)).toEqual(['notes.txt']);
    expect(scan.labels).toContain('Performer');
  });

  /**
   * The whole point of the section tier, end to end: a PDF with an abstract and
   * nothing else must arrive with a description already filled in, without the
   * operator mapping anything. Twelve real journal PDFs came out blank before.
   */
  it('scan proposes an abstract as the description, and the preview fills it', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml', templatesDir: 'templates' });
    const dir = await mkdtemp(join(tmpdir(), 'oeq-eh-'));
    await writeFile(
      join(dir, 'Article.pdf'),
      makePdf({ text: 'Abstract This paper measures jump height. Keywords sport, jumping' }),
    );

    const scan = await ipc.call<{ sections: string[]; starter: Profile }>('oeq:extractScan', dir);
    expect(scan.sections).toContain('Abstract');
    expect(scan.starter.columns.find((c) => c.path === 'MWDL/description')?.sources).toEqual([
      { section: 'Abstract' },
      { opening: true },
    ]);

    const rows = await ipc.call<{ cells: Record<string, string> }[]>('oeq:extractPreview', {
      dir,
      profile: scan.starter,
    });
    expect(rows[0]?.cells['MWDL/description']).toBe('This paper measures jump height.');
  });

  it('preview returns rows without writing anything', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml', templatesDir: 'templates' });
    const dir = await folder();
    const rows = await ipc.call<{ cells: Record<string, string> }[]>('oeq:extractPreview', { dir, profile });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cells['MWDL/title']).toBe('Recital');
  });

  it('preview caps how many rows it builds', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml', templatesDir: 'templates' });
    const dir = await mkdtemp(join(tmpdir(), 'oeq-eh-'));
    for (let i = 0; i < 9; i++) await writeFile(join(dir, `f${i}.pdf`), makePdf({ text: 'x' }));
    const rows = await ipc.call<unknown[]>('oeq:extractPreview', { dir, profile });
    expect(rows).toHaveLength(5);
  });

  it('run writes the file and reports what needs review', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml', templatesDir: 'templates' });
    const dir = await folder();
    const outPath = join(dir, 'out.csv');
    const report = await ipc.call<{ written: number; flagged: number; outPath: string }>(
      'oeq:extractRun', { dir, profile, outPath },
    );
    expect(report.written).toBe(1);
    expect(report.outPath).toBe(outPath);
    const { readSheet } = await import('../../src/core/sheet.js');
    expect((await readSheet(outPath)).rows).toHaveLength(1);
  });

  it('schemaPaths returns the real schema leaf paths', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml', templatesDir: 'templates' });
    const paths = await ipc.call<string[]>('oeq:schemaPaths');
    expect(paths).toContain('MWDL/title');
    expect(paths.length).toBeGreaterThan(100);
  });
});

/**
 * `src/core/extract/` NEVER TOUCHES THE NETWORK -- that is what lets an
 * operator build a spreadsheet from a folder of files without signing in to
 * anything -- but the schema it validates columns against now comes from the
 * API. `SchemaCache` is what reconciles those: whoever signed in leaves the
 * schema on disk, and extraction reads it later, offline.
 */
describe('extract handlers and the cached schema', () => {
  beforeEach(() => __resetExtractCache());

  const cached: SchemaInfo = {
    uuid: 'schema-1',
    namePath: '/OTHER/name',
    titleHeader: 'OTHER/name',
    descriptionPath: '/OTHER/summary',
    descriptionHeader: 'OTHER/summary',
    paths: new Set(['OTHER/name', 'OTHER/summary']),
  };

  const withCache = (ipc: ReturnType<typeof fakeIpcMain>, fn: (id: string) => Promise<SchemaInfo | null>) =>
    registerExtractHandlers(ipc as never, {
      schemaFile: 'schema/_entity.xml',
      templatesDir: 'templates',
      cachedSchema: fn,
    });

  it('validates against the instance’s own cached schema, not the bundled export', async () => {
    const ipc = fakeIpcMain();
    withCache(ipc, async () => cached);
    const paths = await ipc.call<string[]>('oeq:schemaPaths', 'https://other.example.edu');
    expect(paths).toEqual(['OTHER/name', 'OTHER/summary']);
    // The bundled export is BYU-Idaho's, and correct nowhere else.
    expect(paths).not.toContain('MWDL/title');
  });

  it('reads the item name path from the cached schema too, in header form', async () => {
    const ipc = fakeIpcMain();
    withCache(ipc, async () => cached);
    expect(await ipc.call<string | null>('oeq:schemaNamePath', 'https://other.example.edu')).toBe('OTHER/name');
  });

  /**
   * THE REQUIREMENT THAT MATTERS MOST. A missing cache -- a fresh install,
   * another institution's site, an operator who has never signed in -- must
   * degrade to the bundled export, never to a refusal. Blocking the offline
   * half of the tool on a network call nobody asked for would trade a real
   * capability for a check.
   */
  it('still runs with no cache at all, falling back to the bundled export', async () => {
    const ipc = fakeIpcMain();
    withCache(ipc, async () => null);
    const paths = await ipc.call<string[]>('oeq:schemaPaths', 'https://oeq.example.edu');
    expect(paths).toContain('MWDL/title');
    expect(paths.length).toBeGreaterThan(100);
  });

  it('still runs when no instance is named at all', async () => {
    const ipc = fakeIpcMain();
    withCache(ipc, async () => cached);
    expect(await ipc.call<string[]>('oeq:schemaPaths')).toContain('MWDL/title');
  });

  // A cache lookup that throws is "no cache", for exactly the same reason.
  it('still runs when the cache lookup itself fails', async () => {
    const ipc = fakeIpcMain();
    withCache(ipc, async () => {
      throw new Error('disk gone');
    });
    const paths = await ipc.call<string[]>('oeq:schemaPaths', 'https://oeq.example.edu');
    expect(paths).toContain('MWDL/title');
  });

  /**
   * The scan's proposed starter profile is built against the SAME schema the
   * Add-column picker uses. Two different schemas here would have the starter
   * propose a column the picker then reports as invalid.
   *
   * A table heading is what exercises it: `starterProfile` maps a heading onto
   * a schema path by matching its last word (core/extract/suggest.ts), so
   * "Summary" resolves to `OTHER/summary` from the cached schema -- a path the
   * bundled BYU-Idaho export does not contain at all.
   */
  it('builds the starter profile against the cached schema', async () => {
    const ipc = fakeIpcMain();
    withCache(ipc, async () => cached);
    const dir = await mkdtemp(join(tmpdir(), 'oeq-eh-'));
    await writeFile(
      join(dir, 'Record.docx'),
      makeDocx({ table: [['Summary'], ['A short account of the thing.']] }),
    );

    const scan = await ipc.call<{ tableColumns: string[]; starter: Profile }>(
      'oeq:extractScan', dir, 'https://other.example.edu',
    );
    expect(scan.tableColumns).toContain('Summary');
    expect(scan.starter.columns.map((c) => c.path)).toContain('OTHER/summary');
  });

  it('builds it against the bundled export when there is no cache', async () => {
    const ipc = fakeIpcMain();
    withCache(ipc, async () => null);
    const dir = await mkdtemp(join(tmpdir(), 'oeq-eh-'));
    await writeFile(
      join(dir, 'Record.docx'),
      makeDocx({ table: [['Summary'], ['A short account of the thing.']] }),
    );

    const scan = await ipc.call<{ starter: Profile }>('oeq:extractScan', dir, 'https://other.example.edu');
    expect(scan.starter.columns.map((c) => c.path)).not.toContain('OTHER/summary');
  });
});

/**
 * ## The run is where the model pass happens, and where it must not
 *
 * `extractPreview` deliberately does not run it: the preview re-renders on
 * every column edit, and a paid call per keystroke is not a feature anyone
 * asked for. `extractRun` is the one place a document is read for real.
 *
 * The settings are RESOLVED HERE, in the main process, from an injected
 * resolver -- the same arrangement `cachedSchema` has, and for the same reason:
 * this module stays free of the secret store, and the API key never crosses the
 * IPC boundary into the renderer (see `ModelChoice` in ipc.ts, which is what the
 * renderer is actually given, and which has no key in it).
 */
describe('extract run and the model pass', () => {
  const aiProfile: Profile = {
    version: 1,
    pattern: '{title}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
      { path: 'MWDL/description', sources: [{ ai: true }] },
    ],
  };

  const SETTINGS = {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: 'sk-secret',
    budget: 4000,
    cap: 10,
    timeoutMs: 120_000,
  };

  const answers = (content: string) =>
    vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
    ) as unknown as typeof fetch;

  async function prose(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-eh-ai-'));
    await writeFile(
      join(dir, 'Recital.pdf'),
      makePdf({
        text:
          'This programme records what the college said about a long evening of music in a ' +
          'small hall, and what the players meant to it.',
      }),
    );
    return dir;
  }

  /**
   * THE ZERO-PREREQUISITE PROMISE, in the process that would do the sending. An
   * operator who never configured an endpoint gets today's behaviour and no
   * request leaves the machine.
   */
  it('sends nothing when no model is stored for the instance', async () => {
    const ipc = fakeIpcMain();
    const spy = vi.fn();
    registerExtractHandlers(ipc as never, {
      schemaFile: 'schema/_entity.xml',
      templatesDir: 'templates',
      modelFor: async () => null,
      fetchImpl: spy as unknown as typeof fetch,
    });
    const dir = await prose();
    await ipc.call('oeq:extractRun', {
      dir,
      profile: aiProfile,
      outPath: join(dir, 'out.csv'),
      instanceId: 'https://oeq.example.edu',
      modelApproved: true,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  /** And says so, per cell, rather than leaving a blank that looks like a
   *  document that had nothing to say. */
  it('says in the spreadsheet that the column asked for a model there was none of', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, {
      schemaFile: 'schema/_entity.xml',
      templatesDir: 'templates',
      modelFor: async () => null,
    });
    const dir = await prose();
    const out = join(dir, 'out.csv');
    await ipc.call('oeq:extractRun', {
      dir,
      profile: aiProfile,
      outPath: out,
      instanceId: 'https://oeq.example.edu',
      modelApproved: true,
    });
    expect(await readFile(out, 'utf8')).toMatch(/no model is configured/i);
  });

  it('writes what the model said, and flags it', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, {
      schemaFile: 'schema/_entity.xml',
      templatesDir: 'templates',
      modelFor: async () => SETTINGS,
      fetchImpl: answers('A description of the evening.'),
    });
    const dir = await prose();
    const out = join(dir, 'out.csv');
    await ipc.call('oeq:extractRun', {
      dir,
      profile: aiProfile,
      outPath: out,
      instanceId: 'https://oeq.example.edu',
      modelApproved: true,
    });
    const csv = await readFile(out, 'utf8');
    expect(csv).toContain('A description of the evening.');
    expect(csv).toMatch(/written by a language model/i);
  });

  /**
   * THE TWO HALVES MUST AGREE ABOUT WHAT WILL BE SENT. The renderer's
   * confirmation is built from `getModel(instanceId)` and this pass from
   * `modelFor(instanceId)` -- two reads of the same per-instance entry. If the
   * run resolved its settings from anywhere else, the operator would be shown
   * one endpoint and their documents sent to another.
   */
  it('resolves the settings for the instance the renderer confirmed against', async () => {
    const ipc = fakeIpcMain();
    const modelFor = vi.fn(async () => SETTINGS);
    registerExtractHandlers(ipc as never, {
      schemaFile: 'schema/_entity.xml',
      templatesDir: 'templates',
      modelFor,
      fetchImpl: answers('A description.'),
    });
    const dir = await prose();
    await ipc.call('oeq:extractRun', {
      dir,
      profile: aiProfile,
      outPath: join(dir, 'out.csv'),
      instanceId: 'https://oeq.example.edu',
      modelApproved: true,
    });
    expect(modelFor).toHaveBeenCalledWith('https://oeq.example.edu');
  });

  /** No column asked, so nothing is resolved and nothing is sent -- whatever is
   *  stored. Configuring an endpoint does not enable it on a profile. */
  it('asks for no settings and sends nothing when no column wants a model', async () => {
    const ipc = fakeIpcMain();
    const modelFor = vi.fn(async () => SETTINGS);
    const spy = vi.fn();
    registerExtractHandlers(ipc as never, {
      schemaFile: 'schema/_entity.xml',
      templatesDir: 'templates',
      modelFor,
      fetchImpl: spy as unknown as typeof fetch,
    });
    const dir = await prose();
    await ipc.call('oeq:extractRun', {
      dir,
      profile,
      outPath: join(dir, 'out.csv'),
      instanceId: 'https://oeq.example.edu',
      modelApproved: true,
    });
    expect(modelFor).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * THE COUNTER THIS UNBLOCKS. "N need review" is the operator's triage signal,
   * and with a model enabled on one column every row carries a note -- so it
   * would read 400 of 400 and the batch's one genuine failure would be
   * invisible. Reported by identity against `aiWritten`, never by matching the
   * note's prose.
   */
  it('does not report a model write as a row needing review', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, {
      schemaFile: 'schema/_entity.xml',
      templatesDir: 'templates',
      modelFor: async () => SETTINGS,
      fetchImpl: answers('A description of the evening.'),
    });
    const dir = await prose();
    const report = await ipc.call<{ flagged: number; aiWritten: number }>('oeq:extractRun', {
      dir,
      profile: aiProfile,
      outPath: join(dir, 'out.csv'),
      instanceId: 'https://oeq.example.edu',
      modelApproved: true,
    });
    expect(report.flagged).toBe(0);
    // Reported in its own number rather than hidden: a machine wrote into a
    // catalogue record, and the operator is told how many.
    expect(report.aiWritten).toBe(1);
  });

  it('still reports a row that could not be filled at all', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, {
      schemaFile: 'schema/_entity.xml',
      templatesDir: 'templates',
      modelFor: async () => null,
    });
    const dir = await prose();
    const report = await ipc.call<{ flagged: number; aiWritten: number }>('oeq:extractRun', {
      dir,
      profile: aiProfile,
      outPath: join(dir, 'out.csv'),
      instanceId: 'https://oeq.example.edu',
      modelApproved: true,
    });
    expect(report.flagged).toBe(1);
    expect(report.aiWritten).toBe(0);
  });

  /** The preview re-renders on every column edit. A paid call per keystroke is
   *  not a feature anybody asked for. */
  it('never runs the model for a preview', async () => {
    const ipc = fakeIpcMain();
    const spy = vi.fn();
    registerExtractHandlers(ipc as never, {
      schemaFile: 'schema/_entity.xml',
      templatesDir: 'templates',
      modelFor: async () => SETTINGS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    const dir = await prose();
    await ipc.call('oeq:extractPreview', { dir, profile: aiProfile });
    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * ## The side that sends has to know somebody agreed
 *
 * Before this, `extractRun` resolved the endpoint from its OWN read of the store
 * and sent -- carrying no evidence of consent and unable to tell an approved run
 * from an unapproved one. The renderer's read and this one are independent, and
 * they had DIFFERENT FAILURE MODES: a throw from `getModel` meant "no model,
 * carry on without asking" on one side and "no model, send nothing" on the
 * other. So a transient IPC failure on the renderer's read -- which is exactly
 * when no dialog is shown -- produced a full hosted send.
 *
 * They agreed on what an unreadable store MEANS. They were making different
 * observations, and only this side's observation gated the send.
 */
describe('extract run and consent', () => {
  const aiProfile: Profile = {
    version: 1,
    pattern: '{title}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
      { path: 'MWDL/description', sources: [{ ai: true }] },
    ],
  };

  const SETTINGS = {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: 'sk-secret',
    budget: 4000,
    cap: 10,
    timeoutMs: 120_000,
  };

  async function prose(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-eh-consent-'));
    await writeFile(
      join(dir, 'Recital.pdf'),
      makePdf({
        text:
          'This programme records what the college said about a long evening of music in a ' +
          'small hall, and what the players meant to it.',
      }),
    );
    return dir;
  }

  /** Runs one batch with a fully configured endpoint and whatever consent is
   *  given, and reports whether anything went out. */
  async function run(consent: { modelApproved?: boolean }) {
    const ipc = fakeIpcMain();
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'A description.' } }] }), {
          status: 200,
        }),
    );
    const modelFor = vi.fn(async () => SETTINGS);
    registerExtractHandlers(ipc as never, {
      schemaFile: 'schema/_entity.xml',
      templatesDir: 'templates',
      modelFor,
      fetchImpl: spy as unknown as typeof fetch,
    });
    const dir = await prose();
    const out = join(dir, 'out.csv');
    await ipc.call('oeq:extractRun', {
      dir,
      profile: aiProfile,
      outPath: out,
      instanceId: 'https://oeq.example.edu',
      ...consent,
    });
    return { spy, modelFor, csv: await readFile(out, 'utf8') };
  }

  it('sends nothing when consent was refused, however well configured the endpoint is', async () => {
    const { spy, csv } = await run({ modelApproved: false });
    expect(spy).not.toHaveBeenCalled();
    expect(csv).not.toContain('A description.');
  });

  /**
   * ABSENT MEANS NO. The default is the safe direction, so a caller that has
   * not thought about consent cannot spend money by omission -- and the
   * renderer's unreadable-store case, which shows no dialog, reaches here as an
   * absence rather than as an approval.
   */
  it('sends nothing when nothing said anyone agreed', async () => {
    const { spy } = await run({});
    expect(spy).not.toHaveBeenCalled();
  });

  /** It does not even LOOK at the store without consent: a read that could
   *  succeed here is exactly how this side used to overrule the other. */
  it('does not resolve the endpoint at all without consent', async () => {
    const { modelFor } = await run({ modelApproved: false });
    expect(modelFor).not.toHaveBeenCalled();
  });

  it('sends when the operator agreed', async () => {
    const { spy, csv } = await run({ modelApproved: true });
    expect(spy).toHaveBeenCalled();
    expect(csv).toContain('A description.');
  });

  /**
   * The cell still says why it is empty -- and says the right why. An operator
   * whose model settings are fine but whose run did not use them must not be
   * told the thing they configured is not configured: that is a diagnosis naming
   * the one place the problem is not.
   */
  it('says the model did not run, not that none is configured', async () => {
    const { csv } = await run({ modelApproved: false });
    expect(csv).toMatch(/no model was run for this batch/i);
    expect(csv).not.toMatch(/no model is configured/i);
  });

  it('says none is configured when consent was given and there was nothing to use', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, {
      schemaFile: 'schema/_entity.xml',
      templatesDir: 'templates',
      modelFor: async () => null,
    });
    const dir = await prose();
    const out = join(dir, 'out.csv');
    await ipc.call('oeq:extractRun', {
      dir,
      profile: aiProfile,
      outPath: out,
      instanceId: 'https://oeq.example.edu',
      modelApproved: true,
    });
    expect(await readFile(out, 'utf8')).toMatch(/no model is configured/i);
  });
});
