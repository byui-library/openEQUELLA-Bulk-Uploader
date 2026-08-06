// tests/duplicates.test.ts
import { describe, it, expect } from 'vitest';
import { verdictFor, defaultChoice, findDuplicates, type ExistingItemHit } from '../src/core/duplicates.js';
import type { Manifest } from '../src/core/types.js';

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

  /**
   * If the server ignores the where clause and returns everything, this must
   * come back clean rather than flagging every row in the batch.
   */
  it('ignores a hit whose title is not actually the one searched for', () => {
    expect(verdictFor('Smith_Jane.pdf', 'Senior Recital', [hit('Something Else', ['Smith_Jane.pdf'])])).toBeNull();
  });

  it('accepts a hit that differs only in case', () => {
    expect(verdictFor('a.pdf', 'Senior Recital', [hit('SENIOR RECITAL', ['a.pdf'])])?.tier).toBe(
      'near-certain',
    );
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

describe('findDuplicates', () => {
  function manifestOf(rows: { rowNumber: number; fileName: string; title: string }[]): Manifest {
    return {
      version: 1,
      createdAt: '2026-08-06T00:00:00.000Z',
      baseUrl: 'https://example.test',
      collectionUuid: 'c1',
      schemaUuid: 's1',
      itemState: 'draft',
      attachmentColumn: 'attachment name',
      warnings: [],
      entries: rows.map((r) => ({
        rowNumber: r.rowNumber,
        filePath: `/files/${r.fileName}`,
        fileName: r.fileName,
        metadata: { 'MWDL/title': [r.title] },
        status: 'pending' as const,
        attempts: 0,
      })),
    };
  }

  it('reports one finding per flagged row, with its row number', async () => {
    const manifest = manifestOf([
      { rowNumber: 2, fileName: 'a.pdf', title: 'Taken' },
      { rowNumber: 3, fileName: 'b.pdf', title: 'Free' },
    ]);
    const client = {
      searchByTitle: async (_c: string, title: string) =>
        title === 'Taken'
          ? [{ uuid: 'i1', version: 1, name: 'Taken', attachmentNames: ['a.pdf'] }]
          : [],
    };
    const found = await findDuplicates(client, manifest);
    expect(found).toHaveLength(1);
    expect(found[0]?.rowNumber).toBe(2);
    expect(found[0]?.tier).toBe('near-certain');
  });

  /**
   * A failed check must never look like a clean one. This is the whole
   * difference between a check that helps and a check that misleads.
   */
  it('reports a failed request as could-not-check, not as clean', async () => {
    const manifest = manifestOf([{ rowNumber: 2, fileName: 'a.pdf', title: 'Taken' }]);
    const client = {
      searchByTitle: async () => {
        throw new Error('the server said 400');
      },
    };
    const found = await findDuplicates(client, manifest);
    expect(found[0]?.tier).toBe('could-not-check');
    expect(found[0]?.detail).toContain('the server said 400');
  });

  it('keeps checking the other rows after one fails', async () => {
    const manifest = manifestOf([
      { rowNumber: 2, fileName: 'a.pdf', title: 'Boom' },
      { rowNumber: 3, fileName: 'b.pdf', title: 'Taken' },
    ]);
    const client = {
      searchByTitle: async (_c: string, title: string) => {
        if (title === 'Boom') throw new Error('nope');
        return [{ uuid: 'i1', version: 1, name: 'Taken', attachmentNames: ['b.pdf'] }];
      },
    };
    const found = await findDuplicates(client, manifest);
    expect(found.map((f) => f.tier).sort()).toEqual(['could-not-check', 'near-certain']);
  });

  it('says nothing at all when no row is flagged', async () => {
    const manifest = manifestOf([{ rowNumber: 2, fileName: 'a.pdf', title: 'Free' }]);
    const client = { searchByTitle: async () => [] };
    expect(await findDuplicates(client, manifest)).toEqual([]);
  });

  // An entry already created or skipped by an earlier run is not going to be
  // uploaded, so checking it wastes a request and reports something the
  // operator can do nothing about.
  it('skips entries that are not pending', async () => {
    const manifest = manifestOf([{ rowNumber: 2, fileName: 'a.pdf', title: 'Taken' }]);
    manifest.entries[0]!.status = 'created';
    let calls = 0;
    const client = {
      searchByTitle: async () => {
        calls++;
        return [];
      },
    };
    await findDuplicates(client, manifest);
    expect(calls).toBe(0);
  });

  it('asks the collection named in the manifest, not some other one', async () => {
    const manifest = manifestOf([{ rowNumber: 2, fileName: 'a.pdf', title: 'T' }]);
    const seen: string[] = [];
    const client = {
      searchByTitle: async (collection: string) => {
        seen.push(collection);
        return [];
      },
    };
    await findDuplicates(client, manifest);
    expect(seen).toEqual(['c1']);
  });

  // A row with no title cannot be searched for at all; asking the server for
  // an empty title would be a wasted request and a meaningless answer.
  it('reports a titleless row without asking the server', async () => {
    const manifest = manifestOf([{ rowNumber: 2, fileName: 'a.pdf', title: '' }]);
    let calls = 0;
    const client = {
      searchByTitle: async () => {
        calls++;
        return [];
      },
    };
    const found = await findDuplicates(client, manifest);
    expect(calls).toBe(0);
    expect(found[0]?.tier).toBe('not-checkable');
    expect(found[0]?.rowNumber).toBe(2);
  });

  /**
   * Guards the batching loop. With CONCURRENCY at 5 and every other test
   * using one or two rows, the loop body ran exactly once in the whole
   * suite -- so truncating it to the first batch passed everything. That is
   * the same shape of failure as the bug this feature exists to fix.
   */
  it('checks every row of a batch larger than one concurrency window', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      rowNumber: i + 2,
      fileName: `f${i}.pdf`,
      title: `Title ${i}`,
    }));
    const asked: string[] = [];
    const client = {
      searchByTitle: async (_c: string, title: string) => {
        asked.push(title);
        return [{ uuid: 'i', version: 1, name: title, attachmentNames: [`f${asked.length - 1}.pdf`] }];
      },
    };
    const found = await findDuplicates(client, manifestOf(rows));
    expect(asked).toHaveLength(12);
    expect(found).toHaveLength(12);
    expect(found.map((f) => f.rowNumber)).toEqual(rows.map((r) => r.rowNumber));
  });

  it('keeps no more than the concurrency limit in flight at once', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      rowNumber: i + 2,
      fileName: `f${i}.pdf`,
      title: `Title ${i}`,
    }));
    let inFlight = 0;
    let peak = 0;
    const client = {
      searchByTitle: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return [];
      },
    };
    await findDuplicates(client, manifestOf(rows));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
  });
});
