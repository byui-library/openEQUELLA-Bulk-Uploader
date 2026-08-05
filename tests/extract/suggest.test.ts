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

  it('proposes only the attachment column, leaving the mapping to the operator', () => {
    const profile = starterProfile(['Smith_Jane_Recital.pdf']);
    expect(profile.columns).toHaveLength(1);
    expect(profile.pattern).toBe('{part1}_{part2}_{part3}.pdf');
  });

  it('is a valid profile', async () => {
    const { parseProfile } = await import('../../src/core/extract/profile.js');
    expect(() => parseProfile(starterProfile(['a_b.pdf']))).not.toThrow();
  });
});
