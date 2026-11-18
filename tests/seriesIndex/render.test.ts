import { describe, it, expect } from 'vitest';
import { renderIndex } from '../../src/core/seriesIndex/render.js';
import { INDEX_JS } from '../../src/core/seriesIndex/assets.js';
import type { SeriesIndex } from '../../src/core/seriesIndex/types.js';

const index: SeriesIndex = {
  volumes: [
    {
      group: 1,
      heading: 'Fernbrook <Quarterly> "One"',
      itemUrl: 'https://oeq.example.edu/items/u1/0/', uuid: 'u1', version: 1,
      issues: [{ label: 'Issue 1 (1971)', url: 'https://oeq.example.edu/items/u1/0/FQ_No2%263.pdf' }],
    },
  ],
  heldBack: [],
  notInSeries: [],
  missing: [],
  missingCount: 0,
};
const page = { title: 'Fernbrook & Co. index', description: 'Every volume <b>so far</b>.', groups: 'volumes' };

describe('renderIndex', () => {
  const files = renderIndex(index, page);
  const html = files['index.html'];

  it('escapes every value it writes', () => {
    expect(html).toContain('Fernbrook &lt;Quarterly&gt; &quot;One&quot;');
    expect(html).toContain('<title>Fernbrook &amp; Co. index</title>');
    expect(html).toContain('Every volume &lt;b&gt;so far&lt;/b&gt;.');
    expect(html).toContain('href="https://oeq.example.edu/items/u1/0/FQ_No2%263.pdf"');
  });

  it('has no inline style, no inline script and no event handler attributes', () => {
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
  });

  it('links the stylesheet and script beside it, relatively', () => {
    expect(html).toContain('<link rel="stylesheet" href="index.css">');
    expect(html).toContain('<script src="index.js"></script>');
  });

  it('gives each volume its searchable text for the filter', () => {
    expect(html).toContain('data-volume="Fernbrook &lt;Quarterly&gt; &quot;One&quot; Issue 1 (1971)"');
    expect(html).toContain('<div id="volumes" data-groups="volumes">');
  });

  it('is deterministic -- the same input gives the same bytes', () => {
    expect(renderIndex(index, page)).toEqual(files);
  });

  it('ships the constant CSS and JS', () => {
    expect(files['index.js']).toBe(INDEX_JS);
    expect(files['index.css']).toContain(':focus-visible');
  });
});

describe('the filter script', () => {
  // Run the shipped text as it is, outside a browser: with no `document` it
  // hands back its matching function instead of wiring up the page.
  const mod: { exports: { matches?: (q: string, t: string) => boolean } } = { exports: {} };
  new Function('module', INDEX_JS)(mod);
  const matches = mod.exports.matches!;

  it('matches case-blind on any part of the text', () => {
    expect(matches('vol 12', 'Fernbrook Vol 12 Issue 1 (1983)')).toBe(true);
    expect(matches('1983', 'Fernbrook Vol 12 Issue 1 (1983)')).toBe(true);
    expect(matches('1990', 'Fernbrook Vol 12 Issue 1 (1983)')).toBe(false);
  });

  it('treats an empty or blank box as matching everything', () => {
    expect(matches('   ', 'anything')).toBe(true);
  });
});
