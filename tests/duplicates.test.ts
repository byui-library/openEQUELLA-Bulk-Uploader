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

  /**
   * The live search returns no `name` field at all. Dropping nameless hits
   * would make the entire duplicate check silently find nothing.
   */
  it('keeps a hit that carries no title of its own', () => {
    const v = verdictFor('Smith_Jane.pdf', 'Senior Recital', [hit('', ['Smith_Jane.pdf'])]);
    expect(v?.tier).toBe('near-certain');
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
  /**
   * Every manifest here puts its title at `MWDL/title`, so that is the path
   * these tests declare. It is passed explicitly rather than defaulted: the
   * whole point of this parameter is that no layer may assume a title path.
   */
  const TITLE_PATH = 'MWDL/title';

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
    const found = await findDuplicates(client, manifest, TITLE_PATH);
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
    const found = await findDuplicates(client, manifest, TITLE_PATH);
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
    const found = await findDuplicates(client, manifest, TITLE_PATH);
    expect(found.map((f) => f.tier).sort()).toEqual(['could-not-check', 'near-certain']);
  });

  it('says nothing at all when no row is flagged', async () => {
    const manifest = manifestOf([{ rowNumber: 2, fileName: 'a.pdf', title: 'Free' }]);
    const client = { searchByTitle: async () => [] };
    expect(await findDuplicates(client, manifest, TITLE_PATH)).toEqual([]);
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
    await findDuplicates(client, manifest, TITLE_PATH);
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
    await findDuplicates(client, manifest, TITLE_PATH);
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
    const found = await findDuplicates(client, manifest, TITLE_PATH);
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
    const found = await findDuplicates(client, manifestOf(rows), TITLE_PATH);
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
    await findDuplicates(client, manifestOf(rows), TITLE_PATH);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
  });
});

/**
 * `MWDL/title` is what BYU-Idaho's schema happens to declare, not a universal
 * truth. Reading it from anywhere but the schema makes the duplicate check
 * match nothing at any other institution -- and a check that matches nothing
 * reports every row clean, which is the exact failure
 * docs/superpowers/specs/2026-08-06-duplicate-prevention-design.md records this
 * codebase already shipping once.
 */
describe('the title path is read, not assumed', () => {
  /** Both title columns are present, with DIFFERENT values, so reading the
   *  wrong one is visible rather than coincidentally right. */
  function manifestWithTwoTitles(): Manifest {
    return {
      version: 1,
      createdAt: '2026-08-12T00:00:00.000Z',
      baseUrl: 'https://example.test',
      collectionUuid: 'c1',
      schemaUuid: 's1',
      itemState: 'draft',
      attachmentColumn: 'attachment name',
      warnings: [],
      entries: [
        {
          rowNumber: 2,
          filePath: '/files/thesis.pdf',
          fileName: 'thesis.pdf',
          metadata: { 'local/dc/title': ['A Thesis'], 'MWDL/title': ['WRONG'] },
          status: 'pending' as const,
          attempts: 0,
        },
      ],
    };
  }

  it('queries the path the schema declared, not MWDL/title', async () => {
    const asked: string[] = [];
    const client = {
      searchByTitle: async (_c: string, title: string) => {
        asked.push(title);
        return [];
      },
    };
    await findDuplicates(client, manifestWithTwoTitles(), 'local/dc/title');
    expect(asked).toEqual(['A Thesis']);
  });

  it('tells the searcher which path to match on, not just the value', async () => {
    const paths: string[] = [];
    const client = {
      searchByTitle: async (_c: string, _t: string, titleHeader: string) => {
        paths.push(titleHeader);
        return [];
      },
    };
    await findDuplicates(client, manifestWithTwoTitles(), 'local/dc/title');
    expect(paths).toEqual(['local/dc/title']);
  });

  /**
   * The whole point. With no declared path there is nothing to match on, and
   * saying "clean" would tell the operator their batch was checked when it
   * never was.
   */
  it('reports could-not-check when no title path is known, never clean', async () => {
    const client = { searchByTitle: async () => [] };
    const findings = await findDuplicates(client, manifestWithTwoTitles(), null);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.tier).toBe('could-not-check');
    expect(findings[0]?.rowNumber).toBe(2);
    expect(findings[0]?.fileName).toBe('thesis.pdf');
  });

  it('treats an empty title path the same as none at all', async () => {
    const client = { searchByTitle: async () => [] };
    const findings = await findDuplicates(client, manifestWithTwoTitles(), '');
    expect(findings[0]?.tier).toBe('could-not-check');
  });

  it('issues no search at all when it cannot know what to search for', async () => {
    let calls = 0;
    const client = {
      searchByTitle: async () => {
        calls += 1;
        return [];
      },
    };
    await findDuplicates(client, manifestWithTwoTitles(), null);
    expect(calls).toBe(0);
  });

  // A finding the operator cannot act on is only half a warning: it has to say
  // what to do, not merely that something was missing.
  it('says what to do about it', async () => {
    const client = { searchByTitle: async () => [] };
    const findings = await findDuplicates(client, manifestWithTwoTitles(), null);
    expect(findings[0]?.detail).toMatch(/title/i);
    expect(findings[0]?.detail).toMatch(/by hand/i);
  });

  it('leaves rows an earlier run already handled alone', async () => {
    const manifest = manifestWithTwoTitles();
    manifest.entries[0]!.status = 'created';
    const client = { searchByTitle: async () => [] };
    expect(await findDuplicates(client, manifest, null)).toEqual([]);
  });
});
