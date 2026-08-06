// tests/extract/cli-extract.test.ts
import { describe, it, expect } from 'vitest';
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
