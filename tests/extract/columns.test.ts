// tests/extract/columns.test.ts
import { describe, it, expect } from 'vitest';
import { addColumn, removeColumn, moveColumn, setSources, setFirstSource, setDefault } from '../../src/core/extract/columns.js';
import { ATTACHMENT_COLUMN, type Profile } from '../../src/core/extract/types.js';

function profile(): Profile {
  return {
    version: 1,
    pattern: '{title}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
      { path: 'MWDL/date', sources: [] },
    ],
  };
}

/** A column with a source chain, as the shipped obituary template's description has. */
function withDescriptionChain(): Profile {
  return {
    version: 1,
    pattern: '{title}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/description', sources: [{ compose: '{birth_date}' }, { ai: true }] },
    ],
  };
}

/** Every field a `Column` may carry, so an editing operation that drops one fails. */
function richColumn(): Profile {
  return {
    version: 1,
    pattern: '{title}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      {
        path: 'MWDL/coverage',
        sources: [{ dateNear: ['born'] }],
        transform: 'date',
        as: 'birth_date',
        flagIfEmpty: true,
        composeOnly: true,
      },
    ],
  };
}

describe('addColumn', () => {
  it('appends a column with no sources', () => {
    const after = addColumn(profile(), 'MWDL/description');
    expect(after.columns.map((c) => c.path)).toEqual([
      ATTACHMENT_COLUMN, 'MWDL/title', 'MWDL/date', 'MWDL/description',
    ]);
    expect(after.columns.at(-1)).toEqual({ path: 'MWDL/description', sources: [] });
  });

  it('rejects a duplicate path', () => {
    expect(() => addColumn(profile(), 'MWDL/title')).toThrow(/already/i);
  });

  it('does not mutate the input', () => {
    const before = profile();
    addColumn(before, 'MWDL/description');
    expect(before.columns).toHaveLength(3);
  });
});

describe('removeColumn', () => {
  it('removes exactly one column', () => {
    const after = removeColumn(profile(), 'MWDL/title');
    expect(after.columns.map((c) => c.path)).toEqual([ATTACHMENT_COLUMN, 'MWDL/date']);
  });

  it('refuses to remove the locked attachment column', () => {
    expect(() => removeColumn(profile(), ATTACHMENT_COLUMN)).toThrow(/required/i);
  });

  it('throws on an unknown path', () => {
    expect(() => removeColumn(profile(), 'MWDL/nope')).toThrow(/not in this profile/i);
  });

  // Removal is by index, not by path equality. parseProfile rejects duplicate
  // paths, so this state should be unreachable -- but columns.ts does not
  // depend on that invariant and must not silently delete two columns if it
  // ever is. A mutation pass showed the suite could not tell the two
  // implementations apart. This is a data-loss guard.
  it('removes only one column even if a duplicate path somehow exists', () => {
    const withDuplicate: Profile = {
      ...profile(),
      columns: [...profile().columns, { path: 'MWDL/title', sources: [] }],
    };
    const after = removeColumn(withDuplicate, 'MWDL/title');
    expect(after.columns.filter((c) => c.path === 'MWDL/title')).toHaveLength(1);
  });
});

describe('moveColumn', () => {
  it('moves a column down', () => {
    const after = moveColumn(profile(), 'MWDL/title', 1);
    expect(after.columns.map((c) => c.path)).toEqual([ATTACHMENT_COLUMN, 'MWDL/date', 'MWDL/title']);
  });

  it('moves a column up', () => {
    const after = moveColumn(profile(), 'MWDL/date', -1);
    expect(after.columns.map((c) => c.path)).toEqual([ATTACHMENT_COLUMN, 'MWDL/date', 'MWDL/title']);
  });

  it('will not move a column above the locked attachment column', () => {
    const after = moveColumn(profile(), 'MWDL/title', -1);
    expect(after.columns.map((c) => c.path)).toEqual([ATTACHMENT_COLUMN, 'MWDL/title', 'MWDL/date']);
  });

  it('will not move past the end', () => {
    const after = moveColumn(profile(), 'MWDL/date', 5);
    expect(after.columns.map((c) => c.path)).toEqual([ATTACHMENT_COLUMN, 'MWDL/title', 'MWDL/date']);
  });

  it('refuses to move the locked attachment column', () => {
    expect(() => moveColumn(profile(), ATTACHMENT_COLUMN, 1)).toThrow(/required/i);
  });

  it('changes order without changing any column', () => {
    const before = profile();
    const after = moveColumn(before, 'MWDL/title', 1);
    expect([...after.columns].sort((a, b) => a.path.localeCompare(b.path)))
      .toEqual([...before.columns].sort((a, b) => a.path.localeCompare(b.path)));
  });
});

describe('setSources', () => {
  it('replaces the sources of one column', () => {
    const after = setSources(profile(), 'MWDL/date', [{ label: 'Date' }]);
    expect(after.columns[2]).toEqual({ path: 'MWDL/date', sources: [{ label: 'Date' }] });
  });

  it('refuses to retarget the locked attachment column', () => {
    expect(() => setSources(profile(), ATTACHMENT_COLUMN, [{ label: 'Name' }])).toThrow(/required/i);
  });
});

describe('setFirstSource', () => {
  it('sets the first source of a column that had none', () => {
    const after = setFirstSource(profile(), 'MWDL/date', { label: 'Date' });
    expect(after.columns[2]?.sources).toEqual([{ label: 'Date' }]);
  });

  /**
   * ## The dropdown governs element 0, and nothing else
   *
   * The columns screen shows ONE source per column, reads `sources[0]`, and
   * used to write back a one-element list -- so choosing anything from it
   * replaced the whole ordered chain. On the one template that ships, touching
   * the description column's dropdown silently switched the language model off:
   * `[{ compose }, { ai }]` became `[{ chosen }]`, with no message anywhere.
   *
   * The chain is the tiered design. A control that governs part of a value and
   * silently discards the rest is this codebase's recurring failure wearing a
   * smaller hat.
   */
  it('replaces the first source and leaves the rest of the chain alone', () => {
    const chained = withDescriptionChain();
    const after = setFirstSource(chained, 'MWDL/description', { section: 'Abstract' });
    expect(after.columns[1]?.sources).toEqual([{ section: 'Abstract' }, { ai: true }]);
  });

  it('removes only the first source when given null', () => {
    const after = setFirstSource(withDescriptionChain(), 'MWDL/description', null);
    expect(after.columns[1]?.sources).toEqual([{ ai: true }]);
  });

  it('leaves an already empty chain empty when given null', () => {
    expect(setFirstSource(profile(), 'MWDL/date', null).columns[2]?.sources).toEqual([]);
  });

  it('preserves every other field of the column', () => {
    const after = setFirstSource(richColumn(), 'MWDL/coverage', { label: 'Born' });
    expect(after.columns[1]).toEqual({ ...richColumn().columns[1], sources: [{ label: 'Born' }] });
  });

  it('refuses to retarget the locked attachment column', () => {
    expect(() => setFirstSource(profile(), ATTACHMENT_COLUMN, { label: 'Name' })).toThrow(/required/i);
  });

  it('does not mutate the input', () => {
    const before = withDescriptionChain();
    setFirstSource(before, 'MWDL/description', { section: 'Abstract' });
    expect(before.columns[1]?.sources).toEqual([{ compose: '{birth_date}' }, { ai: true }]);
  });
});

describe('setDefault', () => {
  it('sets a constant', () => {
    const after = setDefault(profile(), 'MWDL/date', '2026-01-01');
    expect(after.columns[2]?.default).toBe('2026-01-01');
  });

  it('clears the default when given an empty string', () => {
    const withDefault = setDefault(profile(), 'MWDL/date', 'x');
    expect(setDefault(withDefault, 'MWDL/date', '').columns[2]).not.toHaveProperty('default');
  });

  /**
   * ## Typing a default used to destroy half the column
   *
   * `Column` carries eight fields. This function rebuilt one preserving `path`,
   * `sources`, `transform`, `locked` and `default`, and silently dropped `as`,
   * `flagIfEmpty` and `composeOnly`. On the shipped Alumni Obituary template,
   * typing a default into `MWDL/coverage` destroyed its `as: birth_date` alias,
   * after which the description's `compose` template referred to a name that no
   * longer existed -- and the profile it saved would no longer load.
   *
   * Asserted as a whole-object comparison rather than field by field, so a
   * ninth field added to `Column` is covered by this test on the day it is
   * added rather than on the day someone remembers to extend the list.
   */
  it('preserves every other field of the column', () => {
    const after = setDefault(richColumn(), 'MWDL/coverage', 'unknown');
    expect(after.columns[1]).toEqual({ ...richColumn().columns[1], default: 'unknown' });
  });

  it('preserves every other field of the column when clearing the default', () => {
    const set = setDefault(richColumn(), 'MWDL/coverage', 'unknown');
    expect(setDefault(set, 'MWDL/coverage', '').columns[1]).toEqual(richColumn().columns[1]);
  });
});


/**
 * ## Removing the column an `aiProvenance` points at
 *
 * `parseProfile` refuses a provenance path that is not a writable column,
 * because `csv.ts` builds the sheet from `columns` and a value written anywhere
 * else is created and silently discarded. That runs at LOAD time. This function
 * rewrites the profile in memory and the desktop's `extractRun` never re-parses,
 * so without this the editor could produce a profile the loader would have
 * refused -- and the one disclosure that survives an upload would go quietly
 * nowhere on every item in the batch.
 *
 * `saveProfileAs` re-parses, so SAVING surfaced it. Running did not.
 */
describe('removeColumn and aiProvenance', () => {
  const withProvenance = (): Profile => ({
    ...profile(),
    columns: [...profile().columns, { path: 'MWDL/conversionSpecifications', sources: [] }],
    aiProvenance: { path: 'MWDL/conversionSpecifications', append: 'Written by {model}' },
  });

  it('drops a provenance setting whose column is being removed', () => {
    const after = removeColumn(withProvenance(), 'MWDL/conversionSpecifications');
    expect(after.aiProvenance).toBeUndefined();
  });

  /** Dropped, not refused: removing a column is an ordinary edit, and blocking
   *  it over a setting elsewhere would leave no way forward but hand-editing
   *  JSON. */
  it('still removes the column', () => {
    const after = removeColumn(withProvenance(), 'MWDL/conversionSpecifications');
    expect(after.columns.map((c) => c.path)).not.toContain('MWDL/conversionSpecifications');
  });

  it('leaves a provenance setting pointing at a different column alone', () => {
    const after = removeColumn(withProvenance(), 'MWDL/date');
    expect(after.aiProvenance).toEqual({
      path: 'MWDL/conversionSpecifications',
      append: 'Written by {model}',
    });
  });

  it('does not mutate the profile it was given', () => {
    const before = withProvenance();
    removeColumn(before, 'MWDL/conversionSpecifications');
    expect(before.aiProvenance).toBeDefined();
  });

  /** The result is a profile the loader would accept -- which is the whole
   *  property, since nothing re-parses it before a run. */
  it('leaves a profile parseProfile still accepts', async () => {
    const { parseProfile } = await import('../../src/core/extract/profile.js');
    const after = removeColumn(withProvenance(), 'MWDL/conversionSpecifications');
    expect(() => parseProfile(after)).not.toThrow();
  });
});
