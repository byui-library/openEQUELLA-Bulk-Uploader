// tests/extract/suggest.test.ts
import { describe, it, expect } from 'vitest';
import { detectPattern, starterProfile } from '../../src/core/extract/suggest.js';
import { ATTACHMENT_COLUMN } from '../../src/core/extract/types.js';

describe('detectPattern', () => {
  it('detects underscore-separated parts', () => {
    expect(detectPattern(['Smith_Jane_Recital.pdf', 'Lee_Anna_Jury.pdf'])).toBe('{part1}_{part2}_{part3}.pdf');
  });

  it('detects hyphen-separated parts', () => {
    expect(detectPattern(['a-b-c.pdf', 'd-e-f.pdf'])).toBe('{part1}-{part2}-{part3}.pdf');
  });

  it('prefers the separator that gives a consistent part count', () => {
    expect(detectPattern(['a-1_b.pdf', 'c-2_d.pdf'])).toBe('{part1}_{part2}.pdf');
  });

  it('falls back to a single placeholder when parts are inconsistent', () => {
    expect(detectPattern(['a_b.pdf', 'c_d_e.pdf', 'f.pdf'])).toBe('{part1}.pdf');
  });

  it('uses the extension the files actually have', () => {
    expect(detectPattern(['a_b.docx'])).toBe('{part1}_{part2}.docx');
  });

  it('falls back to .pdf when given nothing', () => {
    expect(detectPattern([])).toBe('{part1}.pdf');
  });

  it('ignores files whose extension differs from the majority', () => {
    expect(detectPattern(['a_b.pdf', 'c_d.pdf', 'notes.txt'])).toBe('{part1}_{part2}.pdf');
  });

  // Only readable files may vote on the pattern. A real folder contains the
  // profile .json itself, Thumbs.db, stray notes -- and when unreadable files
  // were counted, a single .json alongside a single .pdf won the tie and
  // produced "{part1}.json". Found by the CLI's --init-profile test.
  it('ignores unreadable files even when they outnumber the readable ones', () => {
    expect(detectPattern(['Recital.pdf', 'p.profile.json'])).toBe('{part1}.pdf');
    expect(detectPattern(['a_b.pdf', 'x.json', 'y.json', 'Thumbs.db'])).toBe('{part1}_{part2}.pdf');
  });
});

describe('starterProfile', () => {
  it('always starts with the locked attachment column', () => {
    const profile = starterProfile(['Smith_Jane_Recital.pdf']);
    expect(profile.columns[0]).toEqual({
      path: ATTACHMENT_COLUMN,
      sources: [{ filename: true }],
      locked: true,
    });
  });

  it('proposes the three fields almost every item needs', () => {
    const profile = starterProfile(['Smith_Jane_Recital.pdf']);
    expect(profile.columns.map((c) => c.path)).toEqual([
      ATTACHMENT_COLUMN,
      'MWDL/title',
      'MWDL/creators/creator',
      'MWDL/description',
    ]);
    expect(profile.pattern).toBe('{part1}_{part2}_{part3}.pdf');
  });

  // Reading a title out of a document's own Title property is not a guess --
  // the document says so. Reading it out of filename part 2 would be, which is
  // why no filename part is wired up here.
  it('wires title and creator to the document properties that state them', () => {
    const columns = starterProfile(['a.pdf']).columns;
    expect(columns.find((c) => c.path === 'MWDL/title')?.sources).toEqual([{ property: 'title' }]);
    expect(columns.find((c) => c.path === 'MWDL/creators/creator')?.sources).toEqual([
      { property: 'author' },
    ]);
  });

  // Description is offered as an empty column on purpose. No document property
  // means "description" unambiguously -- PDF's /Subject is close but not the
  // same thing -- and inventing one would put a wrong value somewhere nobody
  // would think to check.
  it('leaves description empty, as a column to fill in by hand', () => {
    const description = starterProfile(['a.pdf']).columns.find((c) => c.path === 'MWDL/description');
    expect(description?.sources).toEqual([]);
    expect(description?.default).toBeUndefined();
  });

  it('proposes nothing that is not a real schema path', async () => {
    const { readFile } = await import('node:fs/promises');
    const { extractDefinition, parseSchemaPaths } = await import('../../src/core/schema.js');
    const paths = parseSchemaPaths(extractDefinition(await readFile('schema/_entity.xml', 'utf8')));
    for (const column of starterProfile(['a.pdf']).columns) {
      if (column.path === ATTACHMENT_COLUMN) continue;
      expect(paths.has(column.path), `${column.path} is not in the schema`).toBe(true);
    }
  });

  it('is a valid profile', async () => {
    const { parseProfile } = await import('../../src/core/extract/profile.js');
    expect(() => parseProfile(starterProfile(['a_b.pdf']))).not.toThrow();
  });
});
