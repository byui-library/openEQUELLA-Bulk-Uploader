// src/core/seriesIndex/assets.ts
/**
 * The page's stylesheet and script. CONSTANT, so a rebuild with nothing
 * changed produces identical files.
 *
 * The script is a PROGRESSIVE ENHANCEMENT: the page is complete without it.
 * It inserts the filter box itself, so with scripting off there is no dead
 * control. Outside a browser (no `document`) it exports its matching function
 * instead -- which is how the test runs the shipped text rather than a copy.
 */

export const INDEX_CSS = `:root { color-scheme: light dark; --fg: #1b1b1b; --bg: #ffffff; --muted: #555555; --link: #0b57a4; --rule: #d0d0d0; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececec; --bg: #161616; --muted: #b0b0b0; --link: #8cb8ff; --rule: #3a3a3a; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 1rem/1.5 system-ui, sans-serif; }
main { max-width: 48rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
h1 { font-size: 1.75rem; line-height: 1.25; }
h2 { font-size: 1.2rem; margin: 1.5rem 0 0.25rem; }
a { color: var(--link); }
a:focus-visible, input:focus-visible { outline: 3px solid var(--link); outline-offset: 2px; }
ul { margin: 0; padding-left: 1.25rem; }
section { border-top: 1px solid var(--rule); }
.note { color: var(--muted); }
.filter { margin: 1rem 0; }
.filter label { display: block; font-weight: 600; }
.filter input { width: 100%; max-width: 24rem; padding: 0.4rem; font: inherit; }
[hidden] { display: none; }
`;

export const INDEX_JS = `(function () {
  'use strict';
  function normalise(text) { return String(text).toLowerCase().replace(/\\s+/g, ' ').trim(); }
  function matches(query, text) {
    var q = normalise(query);
    return q === '' || normalise(text).indexOf(q) !== -1;
  }
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined') module.exports = { matches: matches };
    return;
  }
  var list = document.getElementById('volumes');
  var volumes = Array.prototype.slice.call(document.querySelectorAll('[data-volume]'));
  if (!list || volumes.length === 0) return;
  var box = document.createElement('div');
  box.className = 'filter';
  var label = document.createElement('label');
  label.htmlFor = 'filter-input';
  label.textContent = 'Filter by name, number or year';
  var input = document.createElement('input');
  input.type = 'search';
  input.id = 'filter-input';
  input.autocomplete = 'off';
  var status = document.createElement('p');
  status.className = 'note';
  status.setAttribute('aria-live', 'polite');
  box.appendChild(label);
  box.appendChild(input);
  box.appendChild(status);
  list.parentNode.insertBefore(box, list);
  var noun = list.getAttribute('data-groups') || 'volumes';
  function update() {
    var shown = 0;
    volumes.forEach(function (v) {
      var hit = matches(input.value, v.getAttribute('data-volume'));
      v.hidden = !hit;
      if (hit) shown += 1;
    });
    status.textContent = 'Showing ' + shown + ' of ' + volumes.length + ' ' + noun + '.';
  }
  input.addEventListener('input', update);
  update();
})();
`;
