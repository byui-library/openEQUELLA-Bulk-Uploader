// tests/duplicates.test.ts
import { describe, it, expect } from 'vitest';
import { verdictFor, defaultChoice, type ExistingItemHit } from '../src/core/duplicates.js';

const hit = (title: string, attachmentNames: string[] = []): ExistingItemHit => ({
  uuid: 'i1',
  version: 1,
  name: title,
  attachmentNames,
});

describe('verdictFor', () => {
  it('reports nothing when the collection has no item with this title', () => {
    expect(verdictFor('Smith_Jane.pdf', 'Senior Recital', [])).toBeNull();
  });

  it('calls it near-certain when an existing item holds the same file', () => {
    const v = verdictFor('Smith_Jane.pdf', 'Senior Recital', [hit('Senior Recital', ['Smith_Jane.pdf'])]);
    expect(v?.tier).toBe('near-certain');
  });

  /**
   * Two students genuinely can have "Senior Recital". A title match alone is
   * not proof, and treating it as proof would silently drop real items.
   */
  it('calls it only possible when the title matches but the file differs', () => {
    const v = verdictFor('Smith_Jane.pdf', 'Senior Recital', [hit('Senior Recital', ['Lee_Anna.pdf'])]);
    expect(v?.tier).toBe('possible');
  });

  it('matches a filename ignoring case and surrounding space', () => {
    const v = verdictFor('Smith_Jane.pdf', 'T', [hit('T', ['  SMITH_JANE.PDF  '])]);
    expect(v?.tier).toBe('near-certain');
  });

  it('is near-certain if ANY hit holds the file, not just the first', () => {
    const v = verdictFor('Smith_Jane.pdf', 'T', [hit('T', ['other.pdf']), hit('T', ['Smith_Jane.pdf'])]);
    expect(v?.tier).toBe('near-certain');
  });

  it('handles a hit with no attachments at all', () => {
    expect(verdictFor('Smith_Jane.pdf', 'T', [hit('T', [])])?.tier).toBe('possible');
  });

  /**
   * A row with no title cannot be checked this way. Saying so is the point:
   * a check that quietly reports nothing teaches the operator that silence
   * means safety.
   */
  it('reports a row with no title as not checkable, never as clean', () => {
    const v = verdictFor('Smith_Jane.pdf', '', []);
    expect(v?.tier).toBe('not-checkable');
    expect(v?.detail).toMatch(/no title/i);
  });

  it('treats a whitespace-only title as no title', () => {
    expect(verdictFor('a.pdf', '   ', [])?.tier).toBe('not-checkable');
  });

  it('carries the existing items through so the operator can look at them', () => {
    const v = verdictFor('Smith_Jane.pdf', 'T', [hit('T', ['Smith_Jane.pdf'])]);
    expect(v?.existing).toEqual([
      { uuid: 'i1', version: 1, title: 'T', attachmentNames: ['Smith_Jane.pdf'] },
    ]);
  });
});

describe('defaultChoice', () => {
  // A filename match is near-proof; re-uploading is almost never wanted.
  it('skips a near-certain duplicate by default', () => {
    expect(defaultChoice('near-certain')).toBe('skip');
  });

  /**
   * Uploads by default, deliberately. A silent omission is worse than a
   * visible duplicate: the operator can delete a duplicate they can see, but
   * cannot notice an item that never arrived.
   */
  it('uploads a merely possible duplicate by default', () => {
    expect(defaultChoice('possible')).toBe('upload');
  });

  it('uploads when the row could not be checked, rather than dropping it', () => {
    expect(defaultChoice('not-checkable')).toBe('upload');
    expect(defaultChoice('could-not-check')).toBe('upload');
  });
});
