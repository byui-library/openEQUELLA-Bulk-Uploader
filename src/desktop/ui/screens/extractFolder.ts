import { escapeHtml } from '../dom.js';
import type { ExtractScan } from '../../ipc.js';

export interface ExtractFolderProps {
  dir: string | null;
  scan: ExtractScan | null;
  busy: boolean;
  error: string | null;
  canContinue: boolean;
  onChooseFolder(): void;
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
        <strong>${props.scan.supported.length}</strong> file(s) can be read.
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
          ? `<p class="error" role="alert">Nothing in this folder can be read. The extractor handles PDF and .docx files.</p>`
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

      ${summary}
      ${props.error === null ? '' : `<p class="error" role="alert">${escapeHtml(props.error)}</p>`}

      <div class="actions">
        <button id="extract-cancel" type="button">Cancel</button>
        <button id="extract-continue" type="button" ${props.canContinue ? '' : 'disabled'}>Continue</button>
      </div>
    </section>`;

  root.querySelector<HTMLButtonElement>('#extract-choose-folder')?.addEventListener('click', props.onChooseFolder);
  root.querySelector<HTMLButtonElement>('#extract-continue')?.addEventListener('click', props.onContinue);
  root.querySelector<HTMLButtonElement>('#extract-cancel')?.addEventListener('click', props.onCancel);
}
