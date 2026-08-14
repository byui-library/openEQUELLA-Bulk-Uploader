// tests/extract/cli-extract.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExtract } from '../../src/cli/extract.js';
import { saveProfile } from '../../src/core/extract/profile.js';
import { ATTACHMENT_COLUMN, type Profile } from '../../src/core/extract/types.js';
import { makePdf } from '../fixtures/extract/make.js';

const profile: Profile = {
  version: 1,
  pattern: '{title}.pdf',
  columns: [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
  ],
};

async function setup(): Promise<{ dir: string; profilePath: string; out: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-cli-extract-'));
  await writeFile(join(dir, 'Recital.pdf'), makePdf({ text: 'Programme for the evening' }));
  const profilePath = join(dir, 'p.profile.json');
  await saveProfile(profilePath, profile);
  return { dir, profilePath, out: join(dir, 'out.csv') };
}

describe('runExtract', () => {
  it('writes a CSV containing a row per file', async () => {
    const { dir, profilePath, out } = await setup();
    const lines: string[] = [];
    await runExtract({ dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml' }, (m) => lines.push(m));
    expect(await readFile(out, 'utf8')).toContain('Recital.pdf');
  });

  it('reports how many rows it wrote and where', async () => {
    const { dir, profilePath, out } = await setup();
    const lines: string[] = [];
    await runExtract({ dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml' }, (m) => lines.push(m));
    expect(lines.join('\n')).toMatch(/1 row/);
    expect(lines.join('\n')).toContain(out);
  });

  it('writes nothing on --dry-run', async () => {
    const { dir, profilePath, out } = await setup();
    const lines: string[] = [];
    await runExtract(
      { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml', dryRun: true },
      (m) => lines.push(m),
    );
    expect(await readdir(dir)).not.toContain('out.csv');
    expect(lines.join('\n')).toMatch(/dry run/i);
  });

  it('rejects a profile whose column is not a real schema xpath', async () => {
    const { dir, out } = await setup();
    const bad = join(dir, 'bad.profile.json');
    await saveProfile(bad, {
      ...profile,
      columns: [profile.columns[0]!, { path: 'MWDL/titel', sources: [] }],
    });
    await expect(
      runExtract({ dir, profile: bad, out, schemaFile: 'schema/_entity.xml' }, () => {}),
    ).rejects.toThrow(/MWDL\/titel/);
  });

  it('creates a starter profile with --init-profile and does not extract', async () => {
    const { dir, out } = await setup();
    const created = join(dir, 'new.profile.json');
    const lines: string[] = [];
    await runExtract(
      { dir, profile: created, out, schemaFile: 'schema/_entity.xml', initProfile: true },
      (m) => lines.push(m),
    );
    expect(JSON.parse(await readFile(created, 'utf8')).pattern).toBe('{part1}.pdf');
    expect(await readdir(dir)).not.toContain('out.csv');
  });

  it('lists skipped files so nothing disappears silently', async () => {
    const { dir, profilePath, out } = await setup();
    await writeFile(join(dir, 'notes.txt'), 'x');
    const lines: string[] = [];
    await runExtract({ dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml' }, (m) => lines.push(m));
    expect(lines.join('\n')).toContain('notes.txt');
  });
});

/**
 * --init-profile used to read only the FILENAMES, so the profile it wrote had
 * an empty description column and no table mappings. Every description fix
 * reached the desktop app and none of it reached the CLI. The round trip found
 * it: `extract` then `plan` produced 14 items with 0 descriptions.
 */
describe('runExtract --init-profile reading the documents', () => {
  async function initOn(files: Record<string, Uint8Array | string>) {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-cli-init-'));
    for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
    const profilePath = join(dir, 'p.profile.json');
    await runExtract(
      { dir, profile: profilePath, out: join(dir, 'o.csv'), schemaFile: 'schema/_entity.xml', initProfile: true },
      () => {},
    );
    return JSON.parse(await readFile(profilePath, 'utf8')) as Profile;
  }

  it('proposes the abstract it found, and the opening as a fallback', async () => {
    const written = await initOn({
      'Article.pdf': makePdf({ text: 'Abstract This paper measures jump height. Keywords sport' }),
    });
    const description = written.columns.find((c) => c.path === 'MWDL/description');
    expect(description?.sources).toEqual([{ section: 'Abstract' }, { opening: true }]);
  });

  it('still ends the title with the filename', async () => {
    const written = await initOn({ 'Article.pdf': makePdf({ text: 'Abstract A study. Keywords x' }) });
    expect(written.columns.find((c) => c.path === 'MWDL/title')?.sources).toContainEqual({
      filenameStem: true,
    });
  });

  it('produces a profile the loader accepts', async () => {
    const written = await initOn({ 'Article.pdf': makePdf({ text: 'Abstract A study. Keywords x' }) });
    const { parseProfile } = await import('../../src/core/extract/profile.js');
    expect(() => parseProfile(written)).not.toThrow();
  });

  it('does not fall over on a folder with nothing readable in it', async () => {
    const written = await initOn({ 'notes.txt': 'nothing here' });
    expect(written.columns.length).toBeGreaterThan(0);
  });
});

/**
 * ## The zero-prerequisite promise, at the surface a scheduled job uses
 *
 * An institution that never configures an endpoint must get EXACTLY today's
 * behaviour: no prompt, no error, no degraded mode, and nothing sent anywhere.
 * That is what lets this tool be adopted without a data review, and if these
 * tests ever fail the installer has stopped being safe to hand to a library
 * that has not had one.
 *
 * `runExtract` takes its environment and its `fetch` as arguments rather than
 * reading the globals, for the same reason every other module here does: a test
 * that has to mutate `process.env` can be broken by another test running beside
 * it, and a `fetch` nothing can see is a promise nothing can check.
 */
describe('runExtract and a column that asked for a model', () => {
  const aiProfile: Profile = {
    version: 1,
    pattern: '{title}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
      { path: 'MWDL/description', sources: [{ ai: true }] },
    ],
  };

  const CONFIGURED = {
    OEQ_MODEL_BASE_URL: 'https://api.openai.com/v1',
    OEQ_MODEL: 'gpt-4o-mini',
    OEQ_MODEL_KEY: 'sk-secret',
    OEQ_MODEL_BUDGET: '4000',
    OEQ_MODEL_CAP: '10',
  };

  /** A well-formed chat-completions answer, so a spy that IS called gets far
   *  enough to prove the whole path runs rather than dying at the parse. */
  const answers = (content: string) =>
    vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
    ) as unknown as typeof fetch;

  async function withAi(): Promise<{ dir: string; profilePath: string; out: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-cli-ai-'));
    await writeFile(
      join(dir, 'Recital.pdf'),
      makePdf({
        text:
          'This programme records what the college said about a long evening of music in a ' +
          'small hall, and what the players meant to it.',
      }),
    );
    const profilePath = join(dir, 'p.profile.json');
    await saveProfile(profilePath, aiProfile);
    return { dir, profilePath, out: join(dir, 'out.csv') };
  }

  it('extracts exactly as it does today when nothing is configured', async () => {
    const { dir, profilePath, out } = await setup();
    await runExtract({ dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml' }, () => {}, {});
    expect(await readFile(out, 'utf8')).toContain('Recital.pdf');
  });

  /**
   * A column that asked for a model, with none set up, must SAY so. A silently
   * empty cell is a thing that could not run reported as if it had -- the shape
   * of failure this codebase has shipped four times.
   */
  it('says an ai column needed a model that is not configured', async () => {
    const { dir, profilePath, out } = await withAi();
    await runExtract({ dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml' }, () => {}, {});
    expect(await readFile(out, 'utf8')).toMatch(/no model is configured/i);
  });

  /** Per cell, naming the column -- a batch-level warning cannot say which of
   *  eight columns was left unfilled. */
  it('names the column in the note', async () => {
    const { dir, profilePath, out } = await withAi();
    await runExtract({ dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml' }, () => {}, {});
    expect(await readFile(out, 'utf8')).toContain('MWDL/description');
  });

  it('sends nothing anywhere', async () => {
    const spy = vi.fn();
    const { dir, profilePath, out } = await withAi();
    await runExtract(
      { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml' },
      () => {},
      {},
      spy as unknown as typeof fetch,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * THE TEST THAT MAKES THE ONE ABOVE MEAN SOMETHING. A spy that is never
   * called can be a spy that was never wired to anything -- so one case has to
   * show the same argument reaching a real request. Without this, deleting the
   * model pass entirely would leave "sends nothing anywhere" green.
   */
  it('does send through that same fetch when a model is configured and approved', async () => {
    const spy = answers('A description of the evening.');
    const { dir, profilePath, out } = await withAi();
    await runExtract(
      { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml', ai: true, yes: true },
      () => {},
      CONFIGURED,
      spy,
    );
    expect(spy).toHaveBeenCalled();
    expect(await readFile(out, 'utf8')).toContain('A description of the evening.');
  });

  it('flags what the model wrote', async () => {
    const { dir, profilePath, out } = await withAi();
    await runExtract(
      { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml', ai: true, yes: true },
      () => {},
      CONFIGURED,
      answers('A description of the evening.'),
    );
    expect(await readFile(out, 'utf8')).toMatch(/written by a language model/i);
  });

  it('prints what it is about to send', async () => {
    const lines: string[] = [];
    const { dir, profilePath, out } = await withAi();
    await runExtract(
      { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml', ai: true, yes: true },
      (m) => lines.push(m),
      CONFIGURED,
      answers('A description.'),
    );
    expect(lines.join('\n')).toContain('api.openai.com');
    expect(lines.join('\n')).toContain('gpt-4o-mini');
  });

  /**
   * ## --ai without --yes, on a machine with nobody at the keyboard
   *
   * It refuses, shows what it would have sent, and stops. It does NOT read
   * stdin: a scheduled job's stdin is not a terminal, so a prompt there either
   * reads EOF and takes it as an answer nobody gave, or waits for ever holding
   * a nightly run open. Refusing is the only behaviour that is identical on a
   * terminal and off one, and the only one that can neither hang nor proceed
   * unconfirmed.
   */
  it('refuses --ai without --yes rather than waiting for an answer nobody will give', async () => {
    const spy = answers('x');
    const { dir, profilePath, out } = await withAi();
    await expect(
      runExtract(
        { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml', ai: true },
        () => {},
        CONFIGURED,
        spy,
      ),
    ).rejects.toThrow(/--yes/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('shows what would have been sent when it refuses, not merely that it refused', async () => {
    const { dir, profilePath, out } = await withAi();
    const error = await runExtract(
      { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml', ai: true },
      () => {},
      CONFIGURED,
      answers('x'),
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toContain('api.openai.com');
    expect(error?.message).toContain('gpt-4o-mini');
  });

  /** A local model sends nothing off the machine and bills nothing, so there is
   *  no confirmation to give -- exactly as the desktop shows no dialog. */
  it('needs no --yes for a model running on this computer', async () => {
    const spy = answers('A description.');
    const { dir, profilePath, out } = await withAi();
    await runExtract(
      { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml', ai: true },
      () => {},
      { ...CONFIGURED, OEQ_MODEL_BASE_URL: 'http://localhost:11434/v1', OEQ_MODEL_KEY: '' },
      spy,
    );
    expect(spy).toHaveBeenCalled();
  });

  /**
   * `--ai` is an explicit instruction. Quietly writing "no model is configured"
   * into four hundred rows would answer a request nobody could see had failed;
   * the operator asked for something the environment cannot do, and is told
   * which variable is missing.
   */
  it('refuses --ai with no endpoint configured, naming the variable', async () => {
    const { dir, profilePath, out } = await withAi();
    await expect(
      runExtract(
        { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml', ai: true },
        () => {},
        {},
      ),
    ).rejects.toThrow(/OEQ_MODEL_BASE_URL/);
  });

  /** The counter, at the surface that prints it. */
  it('does not count a model write as a row needing review', async () => {
    const lines: string[] = [];
    const { dir, profilePath, out } = await withAi();
    await runExtract(
      { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml', ai: true, yes: true },
      (m) => lines.push(m),
      CONFIGURED,
      answers('A description of the evening.'),
    );
    expect(lines.join('\n')).not.toMatch(/need review/);
    expect(lines.join('\n')).toMatch(/written by a language model/i);
  });

  /** And a column that could not be filled at all still counts. */
  it('counts a row whose model column could not be filled', async () => {
    const lines: string[] = [];
    const { dir, profilePath, out } = await withAi();
    await runExtract(
      { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml' },
      (m) => lines.push(m),
      {},
    );
    expect(lines.join('\n')).toMatch(/1 of 1 row\(s\) need review/);
  });
});

/**
 * `--dry-run` is the flag an operator reaches for to check a profile before
 * committing to anything, and it prints five rows. Sending four hundred
 * documents to a paid endpoint to show five of the answers is a bill nobody
 * asked for -- exactly the surprise the confirmation dialog exists to prevent,
 * arriving through a flag whose whole promise is that it does nothing.
 */
describe('runExtract --dry-run with --ai', () => {
  const aiProfile: Profile = {
    version: 1,
    pattern: '{title}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
      { path: 'MWDL/description', sources: [{ ai: true }] },
    ],
  };

  const CONFIGURED = {
    OEQ_MODEL_BASE_URL: 'https://api.openai.com/v1',
    OEQ_MODEL: 'gpt-4o-mini',
    OEQ_MODEL_KEY: 'sk-secret',
  };

  async function folder(): Promise<{ dir: string; profilePath: string; out: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-cli-dry-'));
    await writeFile(
      join(dir, 'Recital.pdf'),
      makePdf({
        text:
          'This programme records what the college said about a long evening of music in a ' +
          'small hall, and what the players meant to it.',
      }),
    );
    const profilePath = join(dir, 'p.profile.json');
    await saveProfile(profilePath, aiProfile);
    return { dir, profilePath, out: join(dir, 'out.csv') };
  }

  it('sends nothing', async () => {
    const spy = vi.fn();
    const { dir, profilePath, out } = await folder();
    await runExtract(
      { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml', ai: true, yes: true, dryRun: true },
      () => {},
      CONFIGURED,
      spy as unknown as typeof fetch,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  /** Not quietly. A blank column with nothing explaining it is a thing that
   *  could not run looking exactly like one that ran and found nothing. */
  it('says the model was not asked anything', async () => {
    const lines: string[] = [];
    const { dir, profilePath, out } = await folder();
    await runExtract(
      { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml', ai: true, yes: true, dryRun: true },
      (m) => lines.push(m),
      CONFIGURED,
    );
    expect(lines.join('\n')).toMatch(/dry run.*nothing was sent/i);
  });
});
