// tests/extract/profile.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProfile, loadProfile, saveProfile, validateAgainstSchema } from '../../src/core/extract/profile.js';
import { ATTACHMENT_COLUMN, type Profile } from '../../src/core/extract/types.js';

const GOOD = {
  version: 1,
  pattern: '{title}.pdf',
  columns: [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
  ],
};

describe('parseProfile', () => {
  it('accepts a valid profile', () => {
    expect(parseProfile(GOOD).pattern).toBe('{title}.pdf');
  });

  it('rejects an unknown version', () => {
    expect(() => parseProfile({ ...GOOD, version: 2 })).toThrow(/version/i);
  });

  it('rejects duplicate column paths', () => {
    const columns = [...GOOD.columns, { path: 'MWDL/title', sources: [] }];
    expect(() => parseProfile({ ...GOOD, columns })).toThrow(/duplicate/i);
  });

  it('requires the attachment column', () => {
    const columns = GOOD.columns.filter((c) => c.path !== ATTACHMENT_COLUMN);
    expect(() => parseProfile({ ...GOOD, columns })).toThrow(/attachment name/i);
  });

  it('requires the attachment column to be first', () => {
    const columns = [...GOOD.columns].reverse();
    expect(() => parseProfile({ ...GOOD, columns })).toThrow(/first/i);
  });

  it('rejects a source naming a placeholder the pattern does not have', () => {
    const columns = [GOOD.columns[0]!, { path: 'MWDL/title', sources: [{ placeholder: 'nope' }] }];
    expect(() => parseProfile({ ...GOOD, columns })).toThrow(/\{nope\}/);
  });

  it('rejects a join naming a placeholder the pattern does not have', () => {
    const columns = [GOOD.columns[0]!, { path: 'MWDL/title', sources: [{ join: '{a}, {b}' }] }];
    expect(() => parseProfile({ ...GOOD, columns })).toThrow(/\{a\}/);
  });

  it('rejects a column with an empty sources array missing entirely', () => {
    const columns = [GOOD.columns[0]!, { path: 'MWDL/title' }];
    expect(() => parseProfile({ ...GOOD, columns })).toThrow();
  });

  it('accepts a column with no sources and no default -- an empty column', () => {
    const columns = [GOOD.columns[0]!, { path: 'MWDL/description', sources: [] }];
    expect(parseProfile({ ...GOOD, columns }).columns).toHaveLength(2);
  });
});

describe('validateAgainstSchema', () => {
  const paths = new Set(['MWDL/title', 'MWDL/date']);

  it('passes when every path is real', () => {
    expect(validateAgainstSchema(parseProfile(GOOD), paths)).toEqual([]);
  });

  it('reports an unknown path with a suggestion', () => {
    const columns = [GOOD.columns[0]!, { path: 'MWDL/titel', sources: [] }];
    const problems = validateAgainstSchema(parseProfile({ ...GOOD, columns }), paths);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.path).toBe('MWDL/titel');
    expect(problems[0]!.suggestions).toContain('MWDL/title');
  });

  it('never complains about the attachment column', () => {
    expect(validateAgainstSchema(parseProfile(GOOD), new Set())).toEqual([
      { path: 'MWDL/title', suggestions: [] },
    ]);
  });
});

describe('loadProfile / saveProfile', () => {
  it('round-trips through a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-profile-'));
    const path = join(dir, 'p.profile.json');
    await saveProfile(path, parseProfile(GOOD) as Profile);
    expect((await loadProfile(path)).pattern).toBe('{title}.pdf');
  });

  it('writes readable, indented JSON a human can edit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-profile-'));
    const path = join(dir, 'p.profile.json');
    await saveProfile(path, parseProfile(GOOD) as Profile);
    expect(await readFile(path, 'utf8')).toContain('\n  "pattern"');
  });

  it('explains which file was bad when the JSON is malformed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-profile-'));
    const path = join(dir, 'bad.profile.json');
    await writeFile(path, '{ not json', 'utf8');
    await expect(loadProfile(path)).rejects.toThrow(/bad\.profile\.json/);
  });
});
