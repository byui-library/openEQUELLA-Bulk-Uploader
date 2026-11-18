import { describe, it, expect } from 'vitest';
import { createIndexController } from '../../../../src/desktop/ui/seriesIndex/controller.js';
import { canBuild, initialIndexState } from '../../../../src/desktop/ui/seriesIndex/state.js';
import type { IndexPreview, OeqApi } from '../../../../src/desktop/ipc.js';

const preview = (over: Partial<IndexPreview> = {}): IndexPreview => ({
  buildId: 'b1',
  title: 'Fernbrook index',
  volumes: [{ heading: 'Vol 1', issues: ['Issue 1'] }],
  issueCount: 1,
  heldBack: [],
  notInSeries: [],
  existing: { kind: 'none' },
  ...over,
});

function setup(opts: { confirm?: boolean; exists?: boolean; p?: IndexPreview } = {}) {
  const calls: string[] = [];
  let saveAttempts = 0;
  const api = {
    indexTemplates: async () => [{ id: 'sre', label: 'Snake River Echoes' }],
    indexPreview: async () => (calls.push('preview'), opts.p ?? preview()),
    chooseFolder: async () => 'C:/out',
    indexSaveFiles: async (a: { replace: boolean }) => {
      calls.push(`save replace=${a.replace}`);
      saveAttempts += 1;
      return opts.exists && saveAttempts === 1 ? { kind: 'exists' as const, names: ['index.html'] } : { kind: 'saved' as const, paths: ['C:/out/index.html'] };
    },
    indexUpload: async (a: { draft: boolean }) => (calls.push(`upload draft=${a.draft}`), { kind: 'created' as const, url: 'https://x/items/n/0/index.html' }),
  } as unknown as OeqApi;
  const confirms: string[] = [];
  const c = createIndexController({
    api,
    instanceId: 'i',
    collectionUuid: 'c1',
    confirm: (text: string) => (confirms.push(text), opts.confirm ?? true),
    onExit: () => calls.push('exit'),
    render: () => {},
  });
  return { c, calls, confirms };
}

describe('index flow controller', () => {
  it('loads templates, previews the chosen one, and builds both destinations', async () => {
    const { c, calls } = setup();
    await c.start();
    expect(c.state().templates).toHaveLength(1);
    await c.setTemplate('sre');
    expect(c.state().preview?.buildId).toBe('b1');
    c.setSaveFiles(true);
    await c.chooseFolder();
    c.setUpload(true);
    expect(canBuild(c.state())).toBe(true);
    await c.build();
    expect(calls).toEqual(['preview', 'save replace=false', 'upload draft=true']);
    expect(c.state().done).toHaveLength(2);
  });

  it('asks before replacing files, and replaces only on yes', async () => {
    const { c, calls, confirms } = setup({ exists: true, confirm: true });
    await c.start();
    await c.setTemplate('sre');
    c.setSaveFiles(true);
    await c.chooseFolder();
    await c.build();
    expect(confirms[0]).toMatch(/index\.html/);
    expect(calls).toContain('save replace=true');
  });

  it('asks before publishing a NEW item, and uploads nothing on no', async () => {
    const { c, calls } = setup({ confirm: false });
    await c.start();
    await c.setTemplate('sre');
    c.setUpload(true);
    c.setDraft(false);
    await c.build();
    expect(calls.some((x) => x.startsWith('upload'))).toBe(false);
  });

  it('after creating the item, the preview says it exists, so a second click updates it', async () => {
    const { c } = setup();
    await c.start();
    await c.setTemplate('sre');
    c.setUpload(true);
    c.setDraft(false);
    await c.build();
    expect(c.state().preview?.existing).toEqual({ kind: 'one', status: 'live' });
  });

  it('cannot build an upload the server would refuse', () => {
    const s = { ...initialIndexState(), preview: preview({ existing: { kind: 'many', names: ['A', 'B'] } }), upload: true };
    expect(canBuild(s)).toBe(false);
  });
});
