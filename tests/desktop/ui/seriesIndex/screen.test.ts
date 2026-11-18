import { describe, it, expect } from 'vitest';
import { indexFlowMarkup } from '../../../../src/desktop/ui/seriesIndex/screen.js';
import { initialIndexState } from '../../../../src/desktop/ui/seriesIndex/state.js';

const preview = {
  buildId: 'b1',
  title: 'Fernbrook <index>',
  volumes: [{ heading: 'Vol 1', issues: ['Issue 1', 'Issue 2'] }],
  issueCount: 2,
  heldBack: [{ reason: '2 items claim volume 3', items: ['A', 'B'] }],
  notInSeries: [{ name: 'Fernbrook index', reason: 'none of its files fits' }],
  existing: { kind: 'one' as const, status: 'draft' },
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
