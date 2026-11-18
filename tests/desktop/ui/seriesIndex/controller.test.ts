import { describe, it, expect } from 'vitest';
import { createIndexController } from '../../../../src/desktop/ui/seriesIndex/controller.js';
import { canBuild, initialIndexState } from '../../../../src/desktop/ui/seriesIndex/state.js';
import type { IndexPreview, OeqApi } from '../../../../src/desktop/ipc.js';
import type { IndexSourceArgs } from '../../../../src/desktop/ipc.js';

const preview = (over: Partial<IndexPreview> = {}): IndexPreview => ({
  buildId: 'b1',
  title: 'Fernbrook index',
  volumes: [{ heading: 'Vol 1', issues: ['Issue 1'] }],
  issueCount: 1,
  heldBack: [],
  notInSeries: [],
  missing: [],
  missingCount: 0,
  existing: { kind: 'none' },
  labels: { part: 'issue', parts: 'issues', group: 'volume', groups: 'volumes' },
  notCreated: [],
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
    indexUpload: async (a: { draft: boolean }) => (calls.push(`upload draft=${a.draft}`), { kind: 'created' as const, url: 'https://x/items/n/0/index.html', status: a.draft ? 'draft' : 'live' }),
  } as unknown as OeqApi;
  const confirms: string[] = [];
  const c = createIndexController({
    api,
    instanceId: 'i',
    source: { collectionUuid: 'c1' },
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
    const s = { ...initialIndexState(), preview: preview({ existing: { kind: 'many', items: [{ name: 'A' }, { name: 'B' }] } }), upload: true };
    expect(canBuild(s)).toBe(false);
  });
});

describe('index flow controller races', () => {
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  const make = (indexPreview: () => Promise<IndexPreview>, indexTemplates?: () => Promise<unknown>) => {
    let renders = 0;
    const api = { indexTemplates: indexTemplates ?? (async () => []), indexPreview } as unknown as OeqApi;
    const c = createIndexController({
      api,
      instanceId: 'i',
      source: { collectionUuid: 'c1' },
      confirm: () => true,
      onExit: () => {},
      render: () => {
        renders += 1;
      },
    });
    return { c, renders: () => renders };
  };

  it('does not render after exit', async () => {
    const d = deferred<IndexPreview>();
    const { c, renders } = make(() => d.promise);
    const p = c.setTemplate('sre');
    c.exit();
    const before = renders();
    d.resolve(preview());
    await p;
    expect(renders()).toBe(before);
  });

  it('lets only the latest setTemplate apply its preview', async () => {
    const first = deferred<IndexPreview>();
    const second = deferred<IndexPreview>();
    const queue = [first, second];
    const { c } = make(() => queue.shift()!.promise);
    const p1 = c.setTemplate('a');
    const p2 = c.setTemplate('b');
    second.resolve(preview({ buildId: 'second' }));
    await p2;
    first.resolve(preview({ buildId: 'first' }));
    await p1;
    expect(c.state().preview?.buildId).toBe('second');
    expect(c.state().loading).toBe(false);
  });

  it('keeps templates empty and records the error when start fails', async () => {
    const { c } = make(async () => preview(), async () => {
      throw new Error('boom');
    });
    await c.start();
    expect(c.state().templates).toEqual([]);
    expect(c.state().error).toMatch(/boom/);
  });
});

describe('index flow controller: volume links', () => {
  function linking(opts: { answers?: boolean[]; existing?: IndexPreview['existing']; heldBack?: IndexPreview['heldBack']; labels?: IndexPreview['labels']; failed?: boolean } = {}) {
    const calls: string[] = [];
    const answers = [...(opts.answers ?? [])];
    const confirms: string[] = [];
    const api = {
      indexTemplates: async () => [{ id: 'sre', label: 'Snake River Echoes' }],
      indexPreview: async () =>
        preview({
          volumes: [
            { heading: 'Vol 1', issues: ['Issue 1'] },
            { heading: 'Vol 2', issues: ['Issue 1'] },
          ],
          existing: opts.existing ?? { kind: 'none' },
          heldBack: opts.heldBack ?? [],
          ...(opts.labels ? { labels: opts.labels } : {}),
        }),
      indexUpload: async () => (calls.push('upload'), { kind: 'created' as const, url: 'https://x/items/n/0/index.html', status: 'draft' }),
      indexLinkVolumes: async (a: { buildId: string }) => (
        calls.push(`link ${a.buildId}`),
        { added: 1, updated: 0, alreadyThere: 0, failed: opts.failed === false ? [] : [{ heading: 'Vol 2', reason: 'server said no' }] }
      ),
    } as unknown as OeqApi;
    const c = createIndexController({
      api,
      instanceId: 'i',
      source: { collectionUuid: 'c1' },
      confirm: (text: string) => (confirms.push(text), answers.shift() ?? true),
      onExit: () => {},
      render: () => {},
    });
    return { c, calls, confirms };
  }

  it('asks, naming how many items it edits, then links AFTER the upload', async () => {
    const { c, calls, confirms } = linking();
    await c.start();
    await c.setTemplate('sre');
    c.setUpload(true);
    c.setLinkVolumes(true);
    await c.build();
    expect(calls).toEqual(['upload', 'link b1']);
    expect(confirms).toEqual([
      'The index item is uploaded. Now add a link to it on 2 volumes in openEQUELLA? ' +
        'Each volume gets one link, "Index of all volumes", listed first, above its files. ' +
        'Nothing else on them changes. A volume that already has the link is not given a second: ' +
        'its link is moved first if it is not, pointed at this index if it points elsewhere, ' +
        'and renamed "Index of all volumes" if it is named otherwise.',
    ]);
    expect(c.state().done[1]).toBe(
      'Linked 1 volume to the index (0 already had it). Not linked: Vol 2 -- server said no.',
    );
  });

  it("speaks the template's words in the confirm and the result", async () => {
    const { c, confirms } = linking({ labels: { part: 'folder', parts: 'folders', group: 'box', groups: 'boxes' }, failed: false });
    await c.start();
    await c.setTemplate('sre');
    c.setUpload(true);
    c.setLinkVolumes(true);
    await c.build();
    expect(confirms[0]).toBe(
      'The index item is uploaded. Now add a link to it on 2 boxes in openEQUELLA? ' +
        'Each box gets one link, "Index of all boxes", listed first, above its files. ' +
        'Nothing else on them changes. A box that already has the link is not given a second: ' +
        'its link is moved first if it is not, pointed at this index if it points elsewhere, ' +
        'and renamed "Index of all boxes" if it is named otherwise.',
    );
    expect(c.state().done[1]).toBe('Linked 1 box to the index (0 already had it).');
  });

  it('does not claim an upload it did not make: links only, to an index item already there', async () => {
    const { c, calls, confirms } = linking({ existing: { kind: 'one', status: 'draft' }, failed: false });
    await c.start();
    await c.setTemplate('sre');
    c.setLinkVolumes(true);
    await c.build();
    expect(calls).toEqual(['link b1']);
    expect(confirms[0]).toMatch(/^Add a link to it on 2 volumes in openEQUELLA\? /);
  });

  it('a failed link is an error on screen, not only a line in the list', async () => {
    const { c } = linking();
    await c.start();
    await c.setTemplate('sre');
    c.setUpload(true);
    c.setLinkVolumes(true);
    await c.build();
    expect(c.state().error).toBe('Some volumes were not linked -- see below.');
  });

  it('a clean link run sets no error', async () => {
    const { c } = linking({ failed: false });
    await c.start();
    await c.setTemplate('sre');
    c.setUpload(true);
    c.setLinkVolumes(true);
    await c.build();
    expect(c.state().error).toBeNull();
  });

  it('a no skips the links and says so', async () => {
    const { c, calls } = linking({ answers: [false] });
    await c.start();
    await c.setTemplate('sre');
    c.setUpload(true);
    c.setLinkVolumes(true);
    await c.build();
    expect(calls).toEqual(['upload']);
    expect(c.state().done).toContain('Volumes not linked: you chose not to edit them.');
  });

  it('links alone, with no other destination, when the index item already exists', async () => {
    const { c, calls } = linking({ existing: { kind: 'one', status: 'live' }, heldBack: [{ reason: 'two claim Vol 3', items: ['A', 'B'] }] });
    await c.start();
    await c.setTemplate('sre');
    c.setLinkVolumes(true);
    expect(canBuild(c.state())).toBe(true);
    await c.build();
    expect(calls).toEqual(['link b1']);
    expect(c.state().done[0]).toMatch(/Held-back volumes were not linked\.$/);
  });

  it('does not link when the new item was not uploaded', async () => {
    // Declining to publish a NEW item leaves nothing to link to.
    const { c, calls } = linking({ answers: [false] });
    await c.start();
    await c.setTemplate('sre');
    c.setUpload(true);
    c.setDraft(false);
    c.setLinkVolumes(true);
    await c.build();
    expect(calls).toEqual([]);
    expect(c.state().done).toContain('Volumes not linked: the index item was not uploaded.');
  });

  it('links alone are not buildable while the index item does not exist', () => {
    const s = { ...initialIndexState(), preview: preview(), linkVolumes: true };
    expect(canBuild(s)).toBe(false);
  });
});

describe('where the index flow reads from', () => {
  const sourced = (source: IndexSourceArgs) => {
    const asked: unknown[] = [];
    const api = {
      indexTemplates: async () => [{ id: 'sre', label: 'Snake River Echoes' }],
      indexPreview: async (args: unknown) => (asked.push(args), preview()),
    } as unknown as OeqApi;
    const c = createIndexController({ api, instanceId: 'i', source, onExit: () => {}, render: () => {} });
    return { c, asked };
  };

  it('previews from the batch records it was opened with, and from no collection', async () => {
    const { c, asked } = sourced({ recordPaths: ['C:/b/fernbrook-1.index.json', 'C:/b/fernbrook-2.index.json'] });
    await c.start();
    await c.setTemplate('sre');
    expect(asked).toEqual([
      { instanceId: 'i', templateId: 'sre', recordPaths: ['C:/b/fernbrook-1.index.json', 'C:/b/fernbrook-2.index.json'] },
    ]);
    expect(c.state().source).toEqual({ recordPaths: ['C:/b/fernbrook-1.index.json', 'C:/b/fernbrook-2.index.json'] });
  });

  it('still previews a search of the collection it was opened with', async () => {
    const { c, asked } = sourced({ collectionUuid: 'c1' });
    await c.start();
    await c.setTemplate('sre');
    expect(asked).toEqual([{ instanceId: 'i', templateId: 'sre', collectionUuid: 'c1' }]);
  });
});
