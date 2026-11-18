import { describe, it, expect } from 'vitest';
import { linkVolumes, indexPageUrl, linkLine, type LinkClient } from '../../src/core/seriesIndex/links.js';

const URL_ = 'https://oeq.example.edu/items/idx/0/index.html';

function fake(beans: Record<string, Record<string, unknown>>, failOn?: string) {
  const edits: { uuid: string; attachments: Record<string, unknown>[] }[] = [];
  const client: LinkClient = {
    async getItemBean(uuid) {
      if (uuid === failOn) throw new Error('server said no');
      return structuredClone(beans[uuid]!);
    },
    async editItem(uuid, _v, bean, staging) {
      expect(staging).toBeUndefined();
      edits.push({ uuid, attachments: bean['attachments'] as Record<string, unknown>[] });
    },
  };
  return { client, edits };
}
const file = (name: string) => ({ type: 'file', filename: name, uuid: `${name}-u` });

describe('linkVolumes', () => {
  it('puts the link first and keeps every other attachment', async () => {
    const f = fake({ v1: { uuid: 'v1', version: 1, attachments: [file('a.pdf'), file('b.pdf')] } });
    const r = await linkVolumes(f.client, [{ uuid: 'v1', version: 1, heading: 'Vol 1' }], URL_, 'Index of all volumes');
    expect(r).toEqual({ added: 1, alreadyThere: 0, failed: [] });
    expect(f.edits[0]!.attachments).toEqual([
      { type: 'url', url: URL_, description: 'Index of all volumes' },
      file('a.pdf'),
      file('b.pdf'),
    ]);
  });

  it('leaves a volume alone when the link is already first', async () => {
    const link = { type: 'url', url: URL_, description: 'Index of all volumes', uuid: 'l' };
    const f = fake({ v1: { attachments: [link, file('a.pdf')] } });
    const r = await linkVolumes(f.client, [{ uuid: 'v1', version: 1, heading: 'Vol 1' }], URL_, 'Index of all volumes');
    expect(r).toEqual({ added: 0, alreadyThere: 1, failed: [] });
    expect(f.edits).toEqual([]);
  });

  it('edits a first link whose description is stale, keeping its uuid', async () => {
    const link = { type: 'url', url: URL_, description: 'Old words', uuid: 'l' };
    const f = fake({ v1: { attachments: [link, file('a.pdf')] } });
    const r = await linkVolumes(f.client, [{ uuid: 'v1', version: 1, heading: 'Vol 1' }], URL_, 'Index of all volumes');
    expect(r).toEqual({ added: 1, alreadyThere: 0, failed: [] });
    expect(f.edits).toHaveLength(1);
    expect(f.edits[0]!.attachments).toEqual([{ ...link, description: 'Index of all volumes' }, file('a.pdf')]);
  });

  it('moves the link to first place, keeping its uuid, rather than adding a second', async () => {
    const link = { type: 'url', url: URL_, description: 'Old words', uuid: 'l' };
    const f = fake({ v1: { attachments: [file('a.pdf'), link] } });
    await linkVolumes(f.client, [{ uuid: 'v1', version: 1, heading: 'Vol 1' }], URL_, 'Index of all volumes');
    expect(f.edits[0]!.attachments).toEqual([{ ...link, description: 'Index of all volumes' }, file('a.pdf')]);
  });

  it('carries on past a failure and names the volume', async () => {
    const f = fake({ v2: { attachments: [file('a.pdf')] } }, 'v1');
    const r = await linkVolumes(
      f.client,
      [
        { uuid: 'v1', version: 1, heading: 'Vol 1' },
        { uuid: 'v2', version: 1, heading: 'Vol 2' },
      ],
      URL_,
      'Index of all volumes',
    );
    expect(r).toEqual({ added: 1, alreadyThere: 0, failed: [{ heading: 'Vol 1', reason: 'server said no' }] });
  });

  it('builds the index page address from the index item', () => {
    expect(indexPageUrl('https://oeq.example.edu/repo', 'idx')).toBe('https://oeq.example.edu/repo/items/idx/0/index.html');
  });
});

describe('linkLine', () => {
  const words = { group: 'volume', groups: 'volumes' };

  it('counts what was linked and what already had it', () => {
    expect(linkLine({ added: 3, alreadyThere: 1, failed: [] }, { ...words, heldBack: 0 })).toBe(
      'Linked 3 volumes to the index (1 already had it).',
    );
    expect(linkLine({ added: 1, alreadyThere: 0, failed: [] }, { ...words, heldBack: 0 })).toBe(
      'Linked 1 volume to the index (0 already had it).',
    );
  });

  it('names every volume that was not linked, and why', () => {
    const line = linkLine(
      { added: 1, alreadyThere: 0, failed: [{ heading: 'Vol 3', reason: 'server said no' }, { heading: 'Vol 4', reason: 'gone' }] },
      { ...words, heldBack: 0 },
    );
    expect(line).toBe('Linked 1 volume to the index (0 already had it). Not linked: Vol 3 -- server said no; Vol 4 -- gone.');
  });

  it('says held-back volumes were not linked', () => {
    expect(linkLine({ added: 2, alreadyThere: 0, failed: [] }, { ...words, heldBack: 1 })).toMatch(
      /Held-back volumes were not linked\.$/,
    );
  });
});
