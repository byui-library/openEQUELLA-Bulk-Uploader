import { describe, it, expect } from 'vitest';
import { indexFlowMarkup } from '../../../../src/desktop/ui/seriesIndex/screen.js';
import { initialIndexState } from '../../../../src/desktop/ui/seriesIndex/state.js';
import type { NotCreatedRow } from '../../../../src/desktop/ipc.js';

const preview = {
  buildId: 'b1',
  title: 'Fernbrook <index>',
  volumes: [{ heading: 'Vol 1', issues: ['Issue 1', 'Issue 2'] }],
  issueCount: 2,
  heldBack: [{ reason: '2 items claim volume 3', items: ['A', 'B'] }],
  notInSeries: [{ name: 'Fernbrook index', reason: 'none of its files fits' }],
  missing: [] as number[],
  missingCount: 0,
  existing: { kind: 'one' as const, status: 'draft' },
  labels: { part: 'issue', parts: 'issues', group: 'volume', groups: 'volumes' },
  notCreated: [] as NotCreatedRow[],
};

describe('index flow markup', () => {
  it('offers only usable templates, and says so when there are none', () => {
    expect(indexFlowMarkup({ ...initialIndexState(), templates: [] })).toContain('No template can build an index');
  });

  it('shows counts, what was held back and why, escaped', () => {
    const html = indexFlowMarkup({ ...initialIndexState(), templates: [{ id: 'sre', label: 'SRE' }], preview });
    expect(html).toContain('1 volume, 2 issues');
    expect(html).toContain('2 items claim volume 3: A, B');
    expect(html).toContain('Fernbrook &lt;index&gt;');
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('names the volumes nothing lists, under the counts, in the template words, escaped', () => {
    const labels = { part: 'issue', parts: 'issues', group: 'box', groups: 'b<o>xes' };
    const html = indexFlowMarkup({ ...initialIndexState(), templates: [], preview: { ...preview, labels, missing: [10, 11], missingCount: 2 } });
    expect(html).toContain('<p class="note">No b&lt;o&gt;xes found for 10, 11.</p>');
    expect(html.indexOf('No b&lt;o&gt;xes found')).toBeGreaterThan(html.indexOf('1 box, 2 issues'));
    const one = indexFlowMarkup({ ...initialIndexState(), templates: [], preview: { ...preview, missing: [10], missingCount: 1 } });
    expect(one).toContain('<p class="note">No volume found for 10.</p>');
    expect(indexFlowMarkup({ ...initialIndexState(), templates: [], preview })).not.toContain('found for');
  });

  it('names at most 20 missing numbers, and counts the rest', () => {
    const missing = Array.from({ length: 20 }, (_, i) => 39 + i);
    const html = indexFlowMarkup({
      ...initialIndexState(),
      templates: [],
      preview: { ...preview, missing, missingCount: 231 },
    });
    expect(html).toContain(`<p class="note">No volumes found for ${missing.slice(0, 20).join(', ')}. ...and 211 more.</p>`);
  });

  it('names at most 20 items not in the series, and counts the rest', () => {
    const notInSeries = Array.from({ length: 23 }, (_, i) => ({ name: `Stray ${i}`, reason: 'none of its files fits' }));
    const html = indexFlowMarkup({ ...initialIndexState(), templates: [], preview: { ...preview, notInSeries } });
    expect(html).toContain('Not in the series (23)');
    expect(html).toContain('Stray 19 --');
    expect(html).not.toContain('Stray 20 --');
    expect(html).toContain('...and 3 more.');
  });

  it('says an update keeps the item as it is instead of offering Draft/Publish', () => {
    const html = indexFlowMarkup({ ...initialIndexState(), templates: [], preview, upload: true });
    expect(html).toContain('Updates the existing index item, which stays draft');
    expect(html).not.toContain('id="index-publish"');
  });

  it('offers Draft/Publish for a new item', () => {
    const html = indexFlowMarkup({
      ...initialIndexState(),
      templates: [],
      preview: { ...preview, existing: { kind: 'none' } },
      upload: true,
    });
    expect(html).toContain('id="index-publish"');
  });
});

describe('index flow markup while busy or failed', () => {
  const tpl = [{ id: 'sre', label: 'SRE' }];
  it('disables the controls while working', () => {
    const html = indexFlowMarkup({
      ...initialIndexState(),
      templates: tpl,
      preview: { ...preview, existing: { kind: 'none' } },
      saveFiles: true,
      upload: true,
      working: true,
    });
    for (const id of ['index-template', 'index-save-files', 'index-upload', 'index-draft', 'index-publish', 'index-folder', 'index-back']) {
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*disabled`));
    }
  });

  it('does not say no template exists beside a real error', () => {
    const html = indexFlowMarkup({ ...initialIndexState(), templates: [], error: 'network down' });
    expect(html).toContain('network down');
    expect(html).not.toContain('No template can build an index');
  });
});

describe('index flow markup: volume links', () => {
  const none = { ...preview, existing: { kind: 'none' as const } };

  it('does not offer the link when there is no index item and no upload', () => {
    const html = indexFlowMarkup({ ...initialIndexState(), templates: [], preview: none });
    expect(html).not.toContain('id="index-link-volumes"');
  });

  it('offers it when the new item is being uploaded, naming how many items it edits', () => {
    const html = indexFlowMarkup({ ...initialIndexState(), templates: [], preview: none, upload: true });
    expect(html).toContain('id="index-link-volumes"');
    expect(html).toContain('Add a link to the index on every volume (edits 1 item)');
  });

  it('offers it when the index item already exists, with or without upload', () => {
    expect(indexFlowMarkup({ ...initialIndexState(), templates: [], preview })).toContain('id="index-link-volumes"');
    const html = indexFlowMarkup({ ...initialIndexState(), templates: [], preview, linkVolumes: true, working: true });
    expect(html).toMatch(/id="index-link-volumes"[^>]*disabled[^>]*checked/);
  });
});

describe("index flow markup in the template's words", () => {
  const boxes = {
    ...preview,
    volumes: [
      { heading: 'Box 1', issues: ['Folder 1'] },
      { heading: 'Box 2', issues: ['Folder 1', 'Folder 2'] },
    ],
    issueCount: 3,
    labels: { part: 'folder', parts: 'folders', group: 'box', groups: 'boxes' },
  };

  it('counts and offers the link in boxes, not volumes', () => {
    const html = indexFlowMarkup({ ...initialIndexState(), templates: [], preview: boxes });
    expect(html).toContain('2 boxes, 3 folders.');
    expect(html).toContain('Show the 2 boxes');
    expect(html).toContain('Add a link to the index on every box (edits 2 items)');
  });
});

describe('index flow markup: where it reads from', () => {
  it('says it searches the collection', () => {
    const html = indexFlowMarkup({ ...initialIndexState({ collectionUuid: 'c1' }), templates: [] });
    expect(html).toContain('From a search of this collection.');
  });

  it('says how many batch records it reads', () => {
    expect(indexFlowMarkup({ ...initialIndexState({ recordPaths: ['a.json', 'b.json'] }), templates: [] })).toContain(
      'From 2 batch records.',
    );
    expect(indexFlowMarkup({ ...initialIndexState({ recordPaths: ['a.json'] }), templates: [] })).toContain(
      'From a batch record.',
    );
  });

  it('says it is reading the records, not searching, while it previews', () => {
    const html = indexFlowMarkup({ ...initialIndexState({ recordPaths: ['a.json'] }), templates: [], loading: true });
    expect(html).toContain('Reading the batch records…');
    expect(html).not.toContain('Searching the collection…');
  });

  it('lists what the run did not create, escaped', () => {
    const notCreated: NotCreatedRow[] = [
      { label: 'FQ_1972_<Vol2>.pdf', status: 'failed', error: 'server said no' },
      { label: 'FQ_1973_Vol3', status: 'pending' },
    ];
    const html = indexFlowMarkup({ ...initialIndexState(), templates: [], preview: { ...preview, notCreated } });
    expect(html).toContain('Not created by the run (2)');
    expect(html).toContain('FQ_1972_&lt;Vol2&gt;.pdf -- failed (server said no)');
    expect(html).toContain('FQ_1973_Vol3 -- pending');
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('says nothing of it when every row was created', () => {
    expect(indexFlowMarkup({ ...initialIndexState(), templates: [], preview })).not.toContain('Not created by the run');
  });
});
