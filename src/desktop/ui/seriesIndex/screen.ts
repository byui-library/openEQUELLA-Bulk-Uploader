// src/desktop/ui/seriesIndex/screen.ts
import { escapeHtml } from '../dom.js';
import type { IndexPreview } from '../../ipc.js';
import { canBuild, canLinkVolumes, type IndexFlowState } from './state.js';
import type { IndexController } from './controller.js';
import { plural } from '../../../core/seriesIndex/words.js';

const isBusy = (s: IndexFlowState) => s.working || s.loading;

function existingMarkup(s: IndexFlowState, e: IndexPreview['existing']): string {
  const dis = isBusy(s) ? ' disabled' : '';
  switch (e.kind) {
    case 'one':
      return `<p class="note">Updates the existing index item, which stays ${escapeHtml(e.status)}.</p>`;
    case 'many':
      return `<p class="error">Cannot upload: ${e.names.length} items carry this index's identifier (${escapeHtml(e.names.join(', '))}). Remove the extra ones in openEQUELLA, then preview again.</p>`;
    case 'unavailable':
      return `<p class="error">Cannot upload: ${escapeHtml(e.reason)}</p>`;
    case 'none':
      return `
        <p>A new index item will be created as:</p>
        <label><input type="radio" name="index-state" id="index-draft"${dis} ${s.draft ? 'checked' : ''}> Draft</label>
        <label><input type="radio" name="index-state" id="index-publish"${dis} ${s.draft ? '' : 'checked'}> Published</label>`;
  }
}

function previewMarkup(s: IndexFlowState, p: IndexPreview): string {
  const dis = isBusy(s) ? ' disabled' : '';
  // The template's words, escaped once: they come from an operator-edited file.
  const L = {
    part: escapeHtml(p.labels.part),
    parts: escapeHtml(p.labels.parts),
    group: escapeHtml(p.labels.group),
    groups: escapeHtml(p.labels.groups),
  };
  const held = p.heldBack.length
    ? `<h2>Held back (${p.heldBack.length})</h2><ul>${p.heldBack
        .map((h) => `<li>${escapeHtml(`${h.reason}: ${h.items.join(', ')}`)}</li>`)
        .join('')}</ul><p class="hint">Remove the extra items in openEQUELLA, then preview again.</p>`
    : '';
  const left = p.notInSeries.length
    ? `<details><summary>Not in the series (${p.notInSeries.length})</summary><ul>${p.notInSeries
        .map((l) => `<li>${escapeHtml(`${l.name} -- ${l.reason}`)}</li>`)
        .join('')}</ul></details>`
    : '';
  const volumes = `<details><summary>Show the ${plural(p.volumes.length, L.group, L.groups)}</summary><ul>${p.volumes
    .map((v) => `<li>${escapeHtml(v.heading)}<ul>${v.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul></li>`)
    .join('')}</ul></details>`;
  return `
    <h2>${escapeHtml(p.title)}</h2>
    <p>${plural(p.volumes.length, L.group, L.groups)}, ${plural(p.issueCount, L.part, L.parts)}.</p>
    ${held}${left}${volumes}
    <fieldset>
      <legend>Where should it go?</legend>
      <label><input type="checkbox" id="index-save-files"${dis} ${s.saveFiles ? 'checked' : ''}> Save as files for a web server</label>
      ${s.saveFiles ? `<button id="index-folder"${dis} type="button">Choose folder…</button> <span class="path">${s.folder ? escapeHtml(s.folder) : 'No folder chosen yet.'}</span>` : ''}
      <label><input type="checkbox" id="index-upload"${dis} ${s.upload ? 'checked' : ''}> Create or update the openEQUELLA item</label>
      ${s.upload ? existingMarkup(s, p.existing) : ''}
      ${
        canLinkVolumes(s)
          ? `<label><input type="checkbox" id="index-link-volumes"${dis} ${s.linkVolumes ? 'checked' : ''}> Add a link to the index on every ${L.group} (edits ${plural(p.volumes.length, 'item', 'items')})</label>`
          : ''
      }
    </fieldset>
    <div class="button-row"><button id="index-build" type="button" ${canBuild(s) ? '' : 'disabled'}>${s.working ? 'Building…' : 'Build'}</button></div>`;
}

export function indexFlowMarkup(s: IndexFlowState): string {
  const templates =
    s.templates === null
      ? '<p class="note">Loading templates…</p>'
      : s.templates.length === 0
        ? s.error
          ? ''
          : '<p class="note">No template can build an index: it needs file-name patterns and an "index" section.</p>'
        : `<label for="index-template">Template</label>
           <select id="index-template"${isBusy(s) ? ' disabled' : ''}><option value="">Choose…</option>${s.templates
             .map((t) => `<option value="${escapeHtml(t.id)}" ${t.id === s.templateId ? 'selected' : ''}>${escapeHtml(t.label)}</option>`)
             .join('')}</select>`;
  return `
    <section class="screen">
      <h1>Build an index</h1>
      <p class="hint">One page listing every volume in this collection, each linking to its item and its issues to their files.</p>
      ${templates}
      ${s.loading ? '<p class="note">Searching the collection…</p>' : ''}
      ${s.preview ? previewMarkup(s, s.preview) : ''}
      ${s.done.map((d) => `<p class="note">${escapeHtml(d)}</p>`).join('')}
      ${s.error ? `<p class="error" role="alert">${escapeHtml(s.error)}</p>` : ''}
      <p class="reset-row"><button id="index-back"${isBusy(s) ? ' disabled' : ''} type="button" class="link-button">Back</button></p>
    </section>`;
}

export function renderIndexFlow(root: HTMLElement, s: IndexFlowState, c: IndexController): void {
  root.innerHTML = indexFlowMarkup(s);
  const on = (id: string, event: string, fn: (el: HTMLInputElement) => void) =>
    root.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener(event, (e) => fn(e.target as HTMLInputElement));
  on('index-template', 'change', (el) => {
    if (el.value) void c.setTemplate(el.value);
  });
  on('index-save-files', 'change', (el) => c.setSaveFiles(el.checked));
  on('index-upload', 'change', (el) => c.setUpload(el.checked));
  on('index-draft', 'change', () => c.setDraft(true));
  on('index-publish', 'change', () => c.setDraft(false));
  on('index-link-volumes', 'change', (el) => c.setLinkVolumes(el.checked));
  on('index-folder', 'click', () => void c.chooseFolder());
  on('index-build', 'click', () => void c.build());
  on('index-back', 'click', () => c.exit());
}
