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

  it('accepts a declared date format', () => {
    const columns = [GOOD.columns[0]!, { path: 'MWDL/title', sources: [], transform: { date: 'MMDDYYYY' } }];
    expect(parseProfile({ ...GOOD, columns }).columns[1]?.transform).toEqual({ date: 'MMDDYYYY' });
  });

  // A malformed format compiles to a regex that never matches, so every row
  // would be quietly kept-as-found with nothing naming the profile as the
  // cause. Rejected at load instead.
  it('rejects a date format that omits a part', () => {
    const columns = [GOOD.columns[0]!, { path: 'MWDL/title', sources: [], transform: { date: 'MMYYYY' } }];
    expect(() => parseProfile({ ...GOOD, columns })).toThrow(/DD 0 times/);
  });

  it('rejects a date format that repeats a part', () => {
    const columns = [GOOD.columns[0]!, { path: 'MWDL/title', sources: [], transform: { date: 'MMDDMMYYYY' } }];
    expect(() => parseProfile({ ...GOOD, columns })).toThrow(/MM 2 times/);
  });

  it('refuses to compose the attachment column, which names the file on disk', () => {
    expect(() =>
      parseProfile({
        version: 1,
        pattern: '{a}.pdf',
        columns: [{ path: 'attachment name', sources: [{ compose: 'x' }], locked: true }],
      }),
    ).toThrow(/attachment name/);
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

describe('profiles using the new sources', () => {
  const base = (columns: unknown[]) => ({
    version: 1,
    pattern: '{a}.pdf',
    // parseProfile has always required this column; a fixture without it tests
    // that rule rather than the one each case is about.
    columns: [{ path: 'attachment name', sources: [{ filename: true }], locked: true }, ...columns],
  });

  it('accepts dateNear, datePair and compose', () => {
    expect(() =>
      parseProfile(
        base([
          { path: 'MWDL/date', as: 'death', sources: [{ dateNear: ['died'] }, { datePair: 'second' }] },
          { path: 'MWDL/description', sources: [{ compose: 'Died {death}' }] },
        ]),
      ),
    ).not.toThrow();
  });

  it('rejects an empty phrase list, which would match nothing', () => {
    expect(() => parseProfile(base([{ path: 'MWDL/date', sources: [{ dateNear: [] }] }]))).toThrow();
  });

  it('rejects a datePair that is neither first nor second', () => {
    expect(() =>
      parseProfile(base([{ path: 'MWDL/date', sources: [{ datePair: 'third' }] }])),
    ).toThrow();
  });

  /**
   * A template naming a column that does not exist would silently compose to
   * nothing on every row. Rejecting it at load matches how a malformed date
   * format is handled: fail before the batch, not part-way through.
   */
  it('rejects a compose naming a column that does not exist', () => {
    expect(() =>
      parseProfile(base([{ path: 'MWDL/description', sources: [{ compose: 'Died {nope}' }] }])),
    ).toThrow(/nope/);
  });

  /**
   * Composed columns are filled in a second pass from the first pass's values,
   * so one cannot read another. Forbidding it outright makes a cycle
   * impossible by construction rather than by detection.
   */
  it('rejects a compose naming another composed column', () => {
    expect(() =>
      parseProfile(
        base([
          { path: 'MWDL/abstract', as: 'a', sources: [{ compose: 'x' }] },
          { path: 'MWDL/description', sources: [{ compose: '{a}' }] },
        ]),
      ),
    ).toThrow();
  });

  it('rejects two columns claiming the same alias', () => {
    expect(() =>
      parseProfile(
        base([
          { path: 'MWDL/date', as: 'd', sources: [] },
          { path: 'MWDL/abstract', as: 'd', sources: [] },
        ]),
      ),
    ).toThrow(/Two columns both use/);
  });

  it('accepts a composeOnly column that has a name', () => {
    expect(() =>
      parseProfile(
        base([
          { path: 'MWDL/coverage', as: 'b', composeOnly: true, sources: [] },
          { path: 'MWDL/description', sources: [{ compose: '{b}' }] },
        ]),
      ),
    ).not.toThrow();
  });

  it('rejects a composeOnly column with no name, which nothing could read', () => {
    expect(() =>
      parseProfile(base([{ path: 'MWDL/coverage', composeOnly: true, sources: [] }])),
    ).toThrow(/no "as" name/);
  });

  /**
   * composeValue splits on ';' and handles [...] separately, so an unbalanced,
   * nested, or semicolon-split group leaks literal brackets into a permanent
   * catalogue record. Rejected at load, the same place a malformed date
   * format is rejected: fail before the batch, not part-way through.
   */
  it('rejects an unclosed optional group', () => {
    expect(() =>
      parseProfile(base([{ path: 'MWDL/date', as: 'd', sources: [] }, { path: 'MWDL/description', sources: [{ compose: 'Died {d}[: x' }] }])),
    ).toThrow(/unclosed/);
  });

  it('rejects nested optional groups', () => {
    expect(() =>
      parseProfile(base([{ path: 'MWDL/date', as: 'd', sources: [] }, { path: 'MWDL/description', sources: [{ compose: 'X[ a[ {d}] c]' }] }])),
    ).toThrow(/nested/);
  });

  it('rejects a semicolon inside an optional group, which would split it', () => {
    expect(() =>
      parseProfile(base([{ path: 'MWDL/date', as: 'd', sources: [] }, { path: 'MWDL/description', sources: [{ compose: '[Born {d}; Died {d}]' }] }])),
    ).toThrow(/;/);
  });

  it('accepts the filenameWordsInText check', () => {
    expect(() =>
      parseProfile({
        version: 1,
        pattern: '{a}.pdf',
        columns: [
          { path: 'attachment name', sources: [{ filename: true }], locked: true },
          { path: 'MWDL/title', sources: [] },
        ],
        checks: { filenameWordsInText: { ignore: ['Obituary'] } },
      }),
    ).not.toThrow();
  });

  it('rejects an unknown check rather than ignoring it', () => {
    expect(() =>
      parseProfile({
        version: 1,
        pattern: '{a}.pdf',
        columns: [
          { path: 'attachment name', sources: [{ filename: true }], locked: true },
          { path: 'MWDL/title', sources: [] },
        ],
        checks: { somethingElse: true },
      }),
    ).toThrow();
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
