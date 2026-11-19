// src/core/seriesIndex/render.ts
import { INDEX_CSS, INDEX_JS } from './assets.js';
import type { IndexFiles, SeriesIndex } from './types.js';

/**
 * The three files. PURE and DETERMINISTIC -- no date, no counter -- so a
 * rebuild with nothing changed is byte-identical and a diff of two builds
 * shows only real changes.
 *
 * No inline style, no inline script, no event-handler attribute: the page
 * must work under a strict Content-Security-Policy on whatever server
 * receives it. Every value is escaped: names and file names come from
 * openEQUELLA and were typed by people.
 */

export interface PageText {
  title: string;
  description: string;
  /** The plural for the filter's status line: "volumes". */
  groups: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderIndex(index: SeriesIndex, page: PageText): IndexFiles {
  const volumes = index.volumes.map((v) => {
    const searchable = [v.heading, ...v.issues.map((i) => i.label)].join(' ');
    const issues = v.issues.map((i) => `<li><a href="${escapeHtml(i.url)}">${escapeHtml(i.label)}</a></li>`);
    return [
      `<section data-volume="${escapeHtml(searchable)}">`,
      `<h2><a href="${escapeHtml(v.itemUrl)}">${escapeHtml(v.heading)}</a></h2>`,
      '<ul>',
      ...issues,
      '</ul>',
      '</section>',
    ].join('\n');
  });

  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(page.title)}</title>`,
    '<link rel="stylesheet" href="index.css">',
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeHtml(page.title)}</h1>`,
    `<p>${escapeHtml(page.description)}</p>`,
    '<p class="note">Each heading opens the item in openEQUELLA; each entry beneath it opens that file.</p>',
    `<div id="volumes" data-groups="${escapeHtml(page.groups)}">`,
    ...volumes,
    '</div>',
    '</main>',
    '<script src="index.js"></script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');

  return { 'index.html': html, 'index.css': INDEX_CSS, 'index.js': INDEX_JS };
}
