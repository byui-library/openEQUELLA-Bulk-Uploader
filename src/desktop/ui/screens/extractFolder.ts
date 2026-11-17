import { escapeHtml } from '../dom.js';
import type { ExtractScan } from '../../ipc.js';

export interface ExtractFolderProps {
  dir: string | null;
  scan: ExtractScan | null;
  busy: boolean;
  error: string | null;
  canContinue: boolean;
  /** Templates shipped with the app, for the "start from" choice. Empty if none are bundled. */
  templates: { id: string; label: string }[];
  /** The selected template's id, or '' for the generic scanned starter. */
  templateId: string;
  /** One row per subfolder rather than one per file. */
  perFolder: boolean;
  onChooseFolder(): void;
  onTemplateChange(id: string): void;
  onPerFolderChange(on: boolean): void;
  onContinue(): void;
  onCancel(): void;
}

/**
 * Step 1 of 3. Reports what is in the folder immediately on selection --
 * including, explicitly, what will NOT be read. A file silently missing from
 * the output is indistinguishable from a file that was never there, so it is
 * named here before anything else happens.
 */
export function renderExtractFolder(root: HTMLElement, props: ExtractFolderProps): void {
  const summary =
    props.scan === null
      ? ''
      : `
      <p class="summary">
        ${
          props.perFolder
            ? `<strong>${props.scan.supported.length}</strong> folder(s) will become items.`
            : `<strong>${props.scan.supported.length}</strong> file(s) can be read.`
        }
      </p>
      ${
        props.scan.skipped.length === 0
          ? ''
          : `<details class="warn" open>
               <summary>${props.scan.skipped.length} file(s) will be skipped</summary>
               <ul>${props.scan.skipped
                 .map((s) => `<li><code>${escapeHtml(s.file)}</code> &mdash; ${escapeHtml(s.reason)}</li>`)
                 .join('')}</ul>
             </details>`
      }
      ${
        props.scan.supported.length === 0
          ? props.perFolder
            ? `<p class="error" role="alert">No subfolder here can become an item. Each item needs a folder of its own, with files in it and no folders inside.</p>`
            : `<p class="error" role="alert">Nothing in this folder can be read. The extractor handles PDF and .docx files.</p>`
          : ''
      }`;

  root.innerHTML = `
    <section class="screen" aria-labelledby="extract-folder-h">
      <h2 id="extract-folder-h">Build a spreadsheet &mdash; step 1 of 3</h2>
      <p>Choose the folder holding the files you want to describe.</p>

      <div class="field">
        <button id="extract-choose-folder" type="button" ${props.busy ? 'disabled' : ''}>
          Choose folder&hellip;
        </button>
        <span class="path">${props.dir === null ? 'No folder chosen' : escapeHtml(props.dir)}</span>
      </div>

      ${
        props.dir === null
          ? ''
          : `<div class="field">
               <label for="extract-template">Start from</label>
               <select id="extract-template" ${props.busy ? 'disabled' : ''}>
                 <option value="" ${props.templateId === '' ? 'selected' : ''}>Generic &mdash; work it out from the files</option>
                 ${props.templates
                   .map(
                     (t) =>
                       `<option value="${escapeHtml(t.id)}" ${t.id === props.templateId ? 'selected' : ''}>${escapeHtml(t.label)}</option>`,
                   )
                   .join('')}
               </select>
               <p class="hint">
                 A template knows how one collection is written &mdash; where a date sits, what the
                 genre and rights always are. Generic reads whatever the files happen to offer.
               </p>
             </div>
             <div class="field">
               <label>
                 <input type="checkbox" id="extract-per-folder" ${props.perFolder ? 'checked' : ''} ${props.busy ? 'disabled' : ''}>
                 One row per subfolder
               </label>
               <p class="hint">
                 Each subfolder becomes one item, with every file in it attached in name order
                 &mdash; for a journal kept as one folder per volume. Rename files to change the
                 order; the Review screen shows it before anything is uploaded.
               </p>
             </div>`
      }

      ${summary}
      ${props.error === null ? '' : `<p class="error" role="alert">${escapeHtml(props.error)}</p>`}

      <div class="actions">
        <button id="extract-cancel" type="button">Cancel</button>
        <button id="extract-continue" type="button" ${props.canContinue ? '' : 'disabled'}>Continue</button>
      </div>
    </section>`;

  root.querySelector<HTMLButtonElement>('#extract-choose-folder')?.addEventListener('click', props.onChooseFolder);
  // No keepCaret here: a <select> fires 'change', not 'input', and its value
  // is restored on re-render by the `selected` attribute above -- keepCaret
  // exists for text inputs, which lose focus mid-word without it.
  root
    .querySelector<HTMLSelectElement>('#extract-template')
    ?.addEventListener('change', (e) => props.onTemplateChange((e.target as HTMLSelectElement).value));
  // Nor here: a checkbox fires 'change', and `checked` above restores it.
  root
    .querySelector<HTMLInputElement>('#extract-per-folder')
    ?.addEventListener('change', (e) => props.onPerFolderChange((e.target as HTMLInputElement).checked));
  root.querySelector<HTMLButtonElement>('#extract-continue')?.addEventListener('click', props.onContinue);
  root.querySelector<HTMLButtonElement>('#extract-cancel')?.addEventListener('click', props.onCancel);
}
