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

  /**
   * A source can be type-legal and loader-illegal at once: the `Source` union
   * in types.ts and the zod union here are two separate lists, and only the
   * `_sourcesAreExhaustive` guard ties them together. A profile the code
   * accepts and `parseProfile` rejects is a template that fails at load with
   * nothing pointing at the cause, so the loader is pinned directly.
   */
  it('accepts a column that asks for a model', () => {
    const columns = [
      GOOD.columns[0]!,
      { path: 'MWDL/description', sources: [{ opening: true }, { ai: true }] },
    ];
    expect(() => parseProfile({ ...GOOD, columns })).not.toThrow();
    // Parsed, not merely tolerated -- a union member that silently dropped the
    // source would also "not throw".
    expect(parseProfile({ ...GOOD, columns }).columns[1]?.sources).toStrictEqual([
      { opening: true },
      { ai: true },
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

/**
 * WHERE THE PROVENANCE PATH IS CHECKED, AND WHY IT IS CHECKED HERE.
 *
 * `csv.ts` writes a spreadsheet by walking `profile.columns`. A value written
 * into `row.cells` under a path that is not one of them is created and then
 * silently dropped -- the exact "reported as if it had run" failure this
 * codebase has shipped repeatedly, and one a row-level assertion cannot see,
 * because at row level the value is genuinely there.
 *
 * So the path must be a real, writable column, and that is settled at load time
 * rather than discovered after a batch has been sent to a paid endpoint. Being
 * a column also buys the schema check for free: `validateAgainstSchema` walks
 * `profile.columns`, so a provenance path the schema does not declare is
 * reported by the machinery that already reports every other undeclared path,
 * with no second validator and without `fill.ts` -- which must stay offline --
 * ever seeing a schema.
 */
describe('parseProfile and the provenance field', () => {
  const withProvenance = (over: Record<string, unknown>) => ({
    ...GOOD,
    columns: [...GOOD.columns, { path: 'MWDL/conversionSpecifications', sources: [] }],
    aiProvenance: { path: 'MWDL/conversionSpecifications', append: 'Written by {model}', ...over },
  });

  it('accepts a provenance field that is a declared column', () => {
    expect(() => parseProfile(withProvenance({}))).not.toThrow();
  });

  it('refuses a provenance path that is not a column, naming the problem', () => {
    const bad = { ...GOOD, aiProvenance: { path: 'MWDL/conversionSpecifications', append: 'x' } };
    expect(() => parseProfile(bad)).toThrow(/MWDL\/conversionSpecifications/);
    expect(() => parseProfile(bad)).toThrow(/column/i);
  });

  /** Dropped from the sheet by `csv.ts` on purpose, so writing here is the same
   *  silent no-op wearing a different hat. */
  it('refuses a composeOnly column, which never reaches the spreadsheet', () => {
    const bad = {
      ...GOOD,
      columns: [
        ...GOOD.columns,
        { path: 'MWDL/conversionSpecifications', sources: [], composeOnly: true, as: 'conv' },
      ],
      aiProvenance: { path: 'MWDL/conversionSpecifications', append: 'x' },
    };
    expect(() => parseProfile(bad)).toThrow(/composeOnly|spreadsheet/i);
  });

  /** It names the file on disk. Appending to it renames the attachment. */
  it('refuses the attachment column', () => {
    const bad = { ...GOOD, aiProvenance: { path: ATTACHMENT_COLUMN, append: 'x' } };
    expect(() => parseProfile(bad)).toThrow(/attachment name/i);
  });

  /**
   * A typo in a placeholder is not a typo in a log line. `{modle}` is written
   * verbatim into a permanent catalogue record with no moderation queue, on
   * every item in the batch, and nothing else would ever say so.
   */
  it('refuses an unknown placeholder rather than writing it out literally', () => {
    expect(() => parseProfile(withProvenance({ append: 'Written by {modle}' }))).toThrow(/modle/);
    expect(() => parseProfile(withProvenance({ append: 'Written by {modle}' }))).toThrow(/model/);
  });

  /** Naming no model at all is an honest disclosure, not a mistake. */
  it('accepts an append with no placeholder in it', () => {
    expect(() => parseProfile(withProvenance({ append: 'Description written by a language model' }))).not.toThrow();
  });

  /**
   * THE SCHEMA CHECK THE SPEC ASKS FOR, ALREADY DONE. Nothing in `fill.ts`
   * validates a path against a schema and nothing should: `src/core/extract/`
   * never touches the network. Being a column is what puts the provenance path
   * through the check every other path goes through.
   */
  it('reports a provenance column the schema does not declare, like any other', () => {
    const profile = parseProfile(withProvenance({}));
    const problems = validateAgainstSchema(profile, new Set(['MWDL/title']));
    expect(problems.map((p) => p.path)).toContain('MWDL/conversionSpecifications');
  });
});

/**
 * The placeholder check reads EVERY brace, not only the ones that look like a
 * name.
 *
 * `joinPlaceholders` matches `\{([A-Za-z][A-Za-z0-9_]*)\}`, which catches
 * `{modle}` and misses `{ model }`, `{model-name}` and `{2}` -- each a plausible
 * typo, and each written verbatim into every item in the batch, in a collection
 * with no moderation queue, with nothing downstream ever mentioning it.
 */
describe('parseProfile and a mistyped provenance placeholder', () => {
  const withAppend = (append: string) => ({
    ...GOOD,
    columns: [...GOOD.columns, { path: 'MWDL/conversionSpecifications', sources: [] }],
    aiProvenance: { path: 'MWDL/conversionSpecifications', append },
  });

  it('refuses a name with spaces inside the braces', () => {
    expect(() => parseProfile(withAppend('Written by { model }'))).toThrow(/not substituted/i);
  });

  it('refuses a hyphenated name', () => {
    expect(() => parseProfile(withAppend('Written by {model-name}'))).toThrow(/model-name/);
  });

  it('refuses a number', () => {
    expect(() => parseProfile(withAppend('Written by {2}'))).toThrow(/not substituted/i);
  });

  it('refuses an empty brace pair', () => {
    expect(() => parseProfile(withAppend('Written by {}'))).toThrow(/not substituted/i);
  });

  it('refuses the wrong case, which does not substitute either', () => {
    expect(() => parseProfile(withAppend('Written by {Model}'))).toThrow(/Model/);
  });

  it('still accepts the one that works', () => {
    expect(() => parseProfile(withAppend('Written by {model}'))).not.toThrow();
  });
});
