// tests/extract/cli-extract.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExtract } from '../../src/cli/extract.js';
import { MODEL_DEFAULTS } from '../../src/core/ai/defaults.js';
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
   * A column that asked for a model, with none run, must SAY so. A silently
   * empty cell is a thing that could not run reported as if it had -- the shape
   * of failure this codebase has shipped four times.
   *
   * WHICH sentence is the other half of getting that right, and it is asserted
   * in "why a model column came out empty" below: on this surface the remedy is
   * `--ai`, because without the flag nothing is read from the environment at
   * all. "No model is configured" would send an operator who has one to the one
   * place the problem is not.
   */
  it('says an ai column was left for a model that never ran', async () => {
    const { dir, profilePath, out } = await withAi();
    await runExtract({ dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml' }, () => {}, {});
    expect(await readFile(out, 'utf8')).toMatch(/nothing was written here/i);
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

/**
 * ## Half an endpoint used to be enough to send document text
 *
 * `modelFromEnv` validated nothing. With `OEQ_MODEL_BASE_URL` set and
 * `OEQ_MODEL` unset, `--ai --yes` put every document on the wire with
 * `"model": ""` in the body -- all failing, all charged for by whatever a
 * gateway charges for accepting a request, from a typo in one variable name.
 * `--ai`'s own error told the operator to set `OEQ_MODEL`, and nothing enforced
 * it. The desktop refuses exactly this in `secrets.ts#assertUsableModel`; the
 * two stores differ and the RULE must not.
 *
 * And a bad number made the consent artifact itself nonsense: `OEQ_MODEL_CAP=eight`
 * rendered "About to send up to NaN model requests... Your limit is NaN". This
 * is the one path where the confirmation is the only thing between an operator
 * and a paid batch, and it was being generated from input the other front end
 * rejects outright.
 *
 * Every refusal below names the VARIABLE that is wrong, and fires before a
 * single file is read.
 */
describe('runExtract --ai and a half-configured environment', () => {
  const aiProfile: Profile = {
    version: 1,
    pattern: '{title}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
      { path: 'MWDL/description', sources: [{ ai: true }] },
    ],
  };

  const OK = {
    OEQ_MODEL_BASE_URL: 'https://api.openai.com/v1',
    OEQ_MODEL: 'gpt-4o-mini',
    OEQ_MODEL_KEY: 'sk-secret',
  };

  async function folder(): Promise<{ dir: string; profilePath: string; out: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-cli-env-'));
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

  /** Every refusal runs the same way: `--ai --yes`, a fetch that would answer
   *  if it were ever called, and an assertion that it never was. */
  async function refuses(env: NodeJS.ProcessEnv): Promise<Error> {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 }),
    );
    const { dir, profilePath, out } = await folder();
    const error = await runExtract(
      { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml', ai: true, yes: true },
      () => {},
      env,
      spy as unknown as typeof fetch,
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(error).not.toBeNull();
    return error!;
  }

  it('refuses a base url with no model name, naming OEQ_MODEL', async () => {
    const error = await refuses({ OEQ_MODEL_BASE_URL: OK.OEQ_MODEL_BASE_URL });
    expect(error.message).toContain('OEQ_MODEL');
  });

  it('refuses a blank model name the same way', async () => {
    const error = await refuses({ ...OK, OEQ_MODEL: '   ' });
    expect(error.message).toContain('OEQ_MODEL');
  });

  it('refuses a cap that is not a number, naming OEQ_MODEL_CAP', async () => {
    const error = await refuses({ ...OK, OEQ_MODEL_CAP: 'eight' });
    expect(error.message).toContain('OEQ_MODEL_CAP');
    expect(error.message).toContain('eight');
  });

  it('refuses a negative cap', async () => {
    const error = await refuses({ ...OK, OEQ_MODEL_CAP: '-1' });
    expect(error.message).toContain('OEQ_MODEL_CAP');
  });

  it('refuses a budget that is not a number, naming OEQ_MODEL_BUDGET', async () => {
    const error = await refuses({ ...OK, OEQ_MODEL_BUDGET: 'lots' });
    expect(error.message).toContain('OEQ_MODEL_BUDGET');
  });

  it('refuses a zero budget, which no document could survive', async () => {
    const error = await refuses({ ...OK, OEQ_MODEL_BUDGET: '0' });
    expect(error.message).toContain('OEQ_MODEL_BUDGET');
  });

  /**
   * `timeoutSecondsProblem` exists because multiplying by 1000 before checking
   * told an operator their value "must be between 1 and 2147483647" about a
   * number they did not type, in a unit they were never shown. Reaching that
   * seam through an environment variable does not make it better -- and it used
   * to report from the provider constructor, after every file had been read.
   */
  it('refuses a bad time limit in the unit the variable is named for', async () => {
    const error = await refuses({ ...OK, OEQ_MODEL_TIMEOUT_SECONDS: '0' });
    expect(error.message).toContain('OEQ_MODEL_TIMEOUT_SECONDS');
    expect(error.message).toMatch(/seconds/i);
    expect(error.message).not.toMatch(/milliseconds/i);
  });

  it('refuses an address that is not a usable endpoint, naming OEQ_MODEL_BASE_URL', async () => {
    const error = await refuses({ ...OK, OEQ_MODEL_BASE_URL: 'not a url' });
    expect(error.message).toContain('OEQ_MODEL_BASE_URL');
  });

  /** The rule that stops a bearer key crossing the network in clear, asked
   *  before a document is read rather than on the first row. */
  it('refuses a key over plain http to somewhere that is not this machine', async () => {
    const error = await refuses({ ...OK, OEQ_MODEL_BASE_URL: 'http://models.example.edu/v1' });
    expect(error.message).toMatch(/not encrypted|clear text/i);
  });

  /** A blank variable is not a mistake: it means "use the default". */
  it('takes the defaults when the numbers are unset', async () => {
    const lines: string[] = [];
    const { dir, profilePath, out } = await folder();
    await runExtract(
      { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml', ai: true, yes: true },
      (m) => lines.push(m),
      OK,
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: 'A description.' } }] }), {
            status: 200,
          }),
      ) as unknown as typeof fetch,
    );
    expect(lines.join('\n')).toContain(String(MODEL_DEFAULTS.cap));
  });

  /** The numbers the operator DID set are the ones quoted back and used. */
  it('uses the cap it was given, and says so', async () => {
    const lines: string[] = [];
    const { dir, profilePath, out } = await folder();
    await runExtract(
      { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml', ai: true, yes: true },
      (m) => lines.push(m),
      { ...OK, OEQ_MODEL_CAP: '7', OEQ_MODEL_BUDGET: '1234' },
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: 'A description.' } }] }), {
            status: 200,
          }),
      ) as unknown as typeof fetch,
    );
    expect(lines.join('\n')).toContain('7 model requests');
    expect(lines.join('\n')).toContain('1,234');
  });

  /** A cap of zero is a real instruction -- "make no requests" -- not a mistake. */
  it('accepts a cap of zero and sends nothing', async () => {
    const spy = vi.fn();
    const { dir, profilePath, out } = await folder();
    await runExtract(
      { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml', ai: true, yes: true },
      () => {},
      { ...OK, OEQ_MODEL_CAP: '0' },
      spy as unknown as typeof fetch,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * ## The diagnosis has to name the actual remedy
 *
 * An operator with both variables set who simply forgot `--ai` used to be told,
 * once per eligible cell, that no model is configured -- and pointed at the two
 * variables they had already set. The remedy was never mentioned. That is this
 * codebase's named failure shape, a diagnosis naming the one place the problem
 * is not, and it had a test pinning it.
 */
describe('why a model column came out empty', () => {
  const aiProfile: Profile = {
    version: 1,
    pattern: '{title}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
      { path: 'MWDL/description', sources: [{ ai: true }] },
    ],
  };

  async function csvFrom(env: NodeJS.ProcessEnv): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-cli-why-'));
    await writeFile(join(dir, 'Recital.pdf'), makePdf({ text: 'A programme.' }));
    const profilePath = join(dir, 'p.profile.json');
    await saveProfile(profilePath, aiProfile);
    const out = join(dir, 'out.csv');
    await runExtract({ dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml' }, () => {}, env);
    return readFile(out, 'utf8');
  }

  it('names --ai when the endpoint is configured and the flag was not given', async () => {
    const csv = await csvFrom({
      OEQ_MODEL_BASE_URL: 'https://api.openai.com/v1',
      OEQ_MODEL: 'gpt-4o-mini',
    });
    expect(csv).toContain('--ai');
    expect(csv).not.toMatch(/no model is configured/i);
  });

  /** The flag is what is missing whether or not an endpoint happens to be set:
   *  without --ai nothing is read from the environment at all. */
  it('names --ai when nothing is configured either', async () => {
    const csv = await csvFrom({});
    expect(csv).toContain('--ai');
  });

  /**
   * `--ai` on a profile no model could write is refused, exactly as `--ai` with
   * no endpoint is. Both are an explicit instruction that cannot be carried
   * out, and doing one silently while throwing on the other was an
   * inconsistency with nothing behind it.
   */
  it('refuses --ai on a profile where no column asks for a model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-cli-noai-'));
    await writeFile(join(dir, 'Recital.pdf'), makePdf({ text: 'A programme.' }));
    const profilePath = join(dir, 'p.profile.json');
    await saveProfile(profilePath, profile);
    await expect(
      runExtract(
        { dir, profile: profilePath, out: join(dir, 'out.csv'), schemaFile: 'schema/_entity.xml', ai: true },
        () => {},
        { OEQ_MODEL_BASE_URL: 'https://api.openai.com/v1', OEQ_MODEL: 'm' },
      ),
    ).rejects.toThrow(/no column|"ai": true/i);
  });
});

/**
 * ## The key must not reach a log line, an error, or the spreadsheet
 *
 * `tests/passwordAuth.test.ts` walks every string reachable from a thrown error
 * for the password; `tests/ai/provider.test.ts` searches every PREFIX of the
 * key, because a message cut to a length can leave up to 163 characters of a
 * 164-character key behind and a whole-string search finds none of it. Neither
 * of those covers this surface, and `OEQ_MODEL_KEY` sat in these fixtures
 * unasserted.
 *
 * The three outputs here are the ones an operator forwards when asking for help:
 * everything printed, the message of anything thrown, and the CSV itself.
 */
describe('the model key never leaves this surface', () => {
  /** Deliberately awkward, so the encoded forms differ from the literal. */
  const KEY = 'sk-Summer2026!pa ss';

  /**
   * Written out literally rather than computed with the helper the
   * implementation uses -- a bug in that helper would otherwise be mirrored
   * here and the test would agree with the defect instead of catching it.
   */
  const KEY_FORMS = [
    'sk-Summer2026!pa ss',
    'sk-Summer2026!pa%20ss',
    'sk-Summer2026%21pa+ss',
  ];

  it('has honest fixtures: the three forms really are distinct and correct', () => {
    const url = new URL('https://x/v1');
    url.searchParams.set('key', KEY);
    expect(KEY_FORMS).toEqual([KEY, encodeURIComponent(KEY), url.searchParams.toString().replace('key=', '')]);
    expect(new Set(KEY_FORMS).size).toBe(3);
  });

  /** Eight characters: below that a match is an accidental collision ("sk-"
   *  plus a few); above it, a real leak however the boundary fell. */
  const MIN_IDENTIFYING = 8;

  const FRAGMENTS = KEY_FORMS.flatMap((form) =>
    Array.from({ length: form.length - MIN_IDENTIFYING + 1 }, (_, i) =>
      form.slice(0, MIN_IDENTIFYING + i),
    ),
  );

  const leaks = (text: string): string | undefined => FRAGMENTS.find((f) => text.includes(f));

  const aiProfile: Profile = {
    version: 1,
    pattern: '{title}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
      { path: 'MWDL/description', sources: [{ ai: true }] },
    ],
  };

  /**
   * Runs a batch and returns everything an operator could forward: the log, the
   * message and stack of anything thrown, and the CSV.
   */
  async function surfaces(
    env: NodeJS.ProcessEnv,
    impl: typeof fetch,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-cli-key-'));
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
    const out = join(dir, 'out.csv');
    const lines: string[] = [];
    const thrown = await runExtract(
      { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml', ai: true, yes: true, ...over },
      (m) => lines.push(m),
      env,
      impl,
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );
    const csv = await readFile(out, 'utf8').catch(() => '');
    return [lines.join('\n'), thrown?.message ?? '', thrown?.stack ?? '', String(thrown), csv].join('\n');
  }

  const ENV = {
    OEQ_MODEL_BASE_URL: 'https://api.example.com/v1',
    OEQ_MODEL: 'gpt-4o-mini',
    OEQ_MODEL_KEY: KEY,
  };

  it('is absent from a successful run', async () => {
    const impl = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'A description.' } }] }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    expect(leaks(await surfaces(ENV, impl))).toBeUndefined();
  });

  /**
   * A GATEWAY ECHOING THE REQUEST BACK is how a key reaches an error body in
   * practice, and `fill.ts` writes the reason for a failed call straight into a
   * spreadsheet note -- the file operators email around asking for help.
   */
  it('is absent when the endpoint echoes the request back in an error', async () => {
    const impl = vi.fn(
      async (_i: string | URL, init?: RequestInit) =>
        new Response(
          `Bad request. Received headers: ${JSON.stringify(
            Object.fromEntries(new Headers(init?.headers).entries()),
          )}`,
          { status: 400 },
        ),
    ) as unknown as typeof fetch;
    expect(leaks(await surfaces(ENV, impl))).toBeUndefined();
  });

  it('is absent when the endpoint cannot be reached at all', async () => {
    const impl = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED for key ${KEY}`);
    }) as unknown as typeof fetch;
    expect(leaks(await surfaces(ENV, impl))).toBeUndefined();
  });

  /** The confirmation names the host and the model. It must not name the key --
   *  and a gateway's published URL can carry one in its path or query. */
  it('is absent from the confirmation, including one pasted into the address', async () => {
    const impl = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'A description.' } }] }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    const text = await surfaces(
      { ...ENV, OEQ_MODEL_BASE_URL: `https://api.example.com/v1?key=${KEY}` },
      impl,
    );
    expect(leaks(text)).toBeUndefined();
  });

  it('is absent from the refusal printed when --yes is missing', async () => {
    const impl = vi.fn() as unknown as typeof fetch;
    expect(leaks(await surfaces(ENV, impl, { yes: false }))).toBeUndefined();
  });

  /** And from the dry-run line, which names the endpoint. */
  it('is absent from the dry-run line', async () => {
    const impl = vi.fn() as unknown as typeof fetch;
    const text = await surfaces(
      { ...ENV, OEQ_MODEL_BASE_URL: `https://api.example.com/v1?key=${KEY}` },
      impl,
      { dryRun: true },
    );
    expect(leaks(text)).toBeUndefined();
  });

  /**
   * THE GUARD ITSELF IS GUARDED. A walker that never matches anything asserts
   * nothing, and this file would look identical whether or not the redaction
   * worked -- so one case proves the search can find what it is looking for.
   */
  it('would find the key if it were there', () => {
    expect(leaks(`something went wrong: ${KEY}`)).toBeDefined();
    expect(leaks(`truncated at the boundary: ${KEY.slice(0, 12)}`)).toBeDefined();
    expect(leaks('nothing to see here')).toBeUndefined();
  });
});
