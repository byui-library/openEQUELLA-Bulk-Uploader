// tests/extract/columns.test.ts
import { describe, it, expect } from 'vitest';
import { addColumn, removeColumn, moveColumn, setSources, setDefault } from '../../src/core/extract/columns.js';
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

describe('setDefault', () => {
  it('sets a constant', () => {
    const after = setDefault(profile(), 'MWDL/date', '2026-01-01');
    expect(after.columns[2]?.default).toBe('2026-01-01');
  });

  it('clears the default when given an empty string', () => {
    const withDefault = setDefault(profile(), 'MWDL/date', 'x');
    expect(setDefault(withDefault, 'MWDL/date', '').columns[2]).not.toHaveProperty('default');
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
