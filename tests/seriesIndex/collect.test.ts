import { describe, it, expect } from 'vitest';
import { collectIndex, issueLabel, fileUrl, itemUrl } from '../../src/core/seriesIndex/collect.js';
import type { IndexHit } from '../../src/core/seriesIndex/types.js';

const BASE = 'https://oeq.example.edu/repo';
const RULE = {
  patterns: ['{year}_Vol{group}_No{part}'],
  groupPatterns: ['{year}_Vol{group}'],
  labels: { part: 'issue', group: 'volume' },
};

const hit = (uuid: string, files: string[], over: Partial<IndexHit> = {}): IndexHit => ({
  uuid,
  version: 1,
  status: 'live',
  name: `Fernbrook Quarterly ${uuid}`,
  files: files.map((filename, i) => ({ filename, uuid: `${uuid}-a${i}` })),
  ...over,
});

describe('collectIndex', () => {
  it('lists volumes in numeric order with issues in attachment order', () => {
    const index = collectIndex(
      [
        hit('v10', ['FQ_1981_Vol10_No1.pdf', 'FQ_1981_Vol10_No2.pdf']),
        hit('v2', ['FQ_1972_Vol2_No1.pdf', 'FQ_1972-73_Vol2_No2.pdf']),
      ],
      RULE,
      BASE,
    );
    expect(index.volumes.map((v) => v.group)).toEqual([2, 10]);
    expect(index.volumes[0]!.issues.map((i) => i.label)).toEqual(['Issue 1 (1972)', 'Issue 2 (1972–1973)']);
    expect(index.volumes[0]!.itemUrl).toBe(`${BASE}/items/v2/0/`);
    expect(index.volumes[0]!.issues[0]!.url).toBe(`${BASE}/items/v2/0/FQ_1972_Vol2_No1.pdf`);
  });

  it('lists draft and live alike', () => {
    const index = collectIndex([hit('a', ['FQ_1971_Vol1_No1.pdf'], { status: 'draft' })], RULE, BASE);
    expect(index.volumes).toHaveLength(1);
  });

  it('leaves out a withdrawn item, saying why', () => {
    const index = collectIndex([hit('a', ['FQ_1971_Vol1_No1.pdf'], { status: 'archived' })], RULE, BASE);
    expect(index.volumes).toEqual([]);
    expect(index.notInSeries).toEqual([{ uuid: 'a', name: 'Fernbrook Quarterly a', reason: 'its status is archived' }]);
  });

  it('holds back a volume two items claim, naming both', () => {
    const index = collectIndex(
      [hit('a', ['FQ_1971_Vol1_No1.pdf']), hit('b', ['FQ_1971_Vol1_No1.pdf']), hit('c', ['FQ_1972_Vol2_No1.pdf'])],
      RULE,
      BASE,
    );
    expect(index.volumes.map((v) => v.group)).toEqual([2]);
    expect(index.heldBack).toEqual([
      {
        group: 1,
        reason: '2 items claim volume 1',
        items: [
          { uuid: 'a', name: 'Fernbrook Quarterly a' },
          { uuid: 'b', name: 'Fernbrook Quarterly b' },
        ],
      },
    ]);
  });

  it('holds back an item whose files name different volumes', () => {
    const index = collectIndex([hit('a', ['FQ_1971_Vol1_No1.pdf', 'FQ_1972_Vol2_No1.pdf'])], RULE, BASE);
    expect(index.heldBack[0]).toEqual({
      group: null,
      reason: 'its files name more than one volume: 1, 2',
      items: [{ uuid: 'a', name: 'Fernbrook Quarterly a' }],
    });
  });

  it('lists an item no pattern fits as not in the series -- the index item itself lands here', () => {
    const index = collectIndex([hit('idx', ['index.html', 'index.css', 'index.js'])], RULE, BASE);
    expect(index.notInSeries).toEqual([
      { uuid: 'idx', name: 'Fernbrook Quarterly idx', reason: "none of its files fits the template's file-name patterns" },
    ]);
  });

  it('reads a one-file volume through a group pattern', () => {
    const index = collectIndex([hit('v20', ['FQ_1991_Vol20.pdf'])], RULE, BASE);
    expect(index.volumes[0]!.group).toBe(20);
    expect(index.volumes[0]!.issues[0]!.label).toBe('FQ_1991_Vol20');
  });

  it('labels an unnumbered file by its stem and keeps its position', () => {
    const index = collectIndex(
      [hit('v27', ['FQ_1998_Vol27_No1.pdf', 'FQ_1998_Vol27_No2.pdf', 'FQ_1998_Commemorative.pdf'])],
      RULE,
      BASE,
    );
    expect(index.volumes[0]!.issues.map((i) => i.label)).toEqual([
      'Issue 1 (1998)',
      'Issue 2 (1998)',
      'FQ_1998_Commemorative',
    ]);
  });

  it('falls back to the label when the server sent no name', () => {
    const index = collectIndex([hit('a', ['FQ_1971_Vol1_No1.pdf'], { name: null })], RULE, BASE);
    expect(index.volumes[0]!.heading).toBe('Volume 1');
  });

  it('encodes a file name in its URL', () => {
    expect(fileUrl(BASE, 'u1', 'FQ_1975_Vol4_No2&3.pdf')).toBe(`${BASE}/items/u1/0/FQ_1975_Vol4_No2%263.pdf`);
    expect(itemUrl(`${BASE}/`, 'u1')).toBe(`${BASE}/items/u1/0/`);
  });
});

describe('issueLabel', () => {
  const labels = { part: 'issue', parts: 'issues', group: 'volume', groups: 'volumes' };
  it('names a run of parts as a span', () => {
    expect(issueLabel({ parts: [2, 3], group: 4, years: { from: 1975, to: 1975 } }, 'x.pdf', labels)).toBe(
      'Issues 2–3 (1975)',
    );
  });
  it('lists parts that are not a run', () => {
    expect(issueLabel({ parts: [1, 3], group: 4, years: null }, 'x.pdf', labels)).toBe('Issues 1, 3');
  });
});
