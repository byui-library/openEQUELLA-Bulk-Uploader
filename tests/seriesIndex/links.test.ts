import { describe, it, expect } from 'vitest';
import { linkVolumes, indexPageUrl, type LinkClient } from '../../src/core/seriesIndex/links.js';

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
