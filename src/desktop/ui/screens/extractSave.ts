import { escapeHtml } from '../dom.js';

export interface ExtractSaveProps {
  fileCount: number;
  flagged: number;
  savedPath: string | null;
  busy: boolean;
  error: string | null;
  onSave(): void;
  onBack(): void;
  onOpenFolder(): void;
  onDone(): void;
}

/**
 * Step 3 of 3. There is deliberately no "use this now" button: the convenient
 * path must not be the one that skips opening the spreadsheet, because the
 * guesses are exactly what needs reviewing (spec, "Output model").
 */
export function renderExtractSave(root: HTMLElement, props: ExtractSaveProps): void {
  const done = props.savedPath !== null;

  root.innerHTML = `
    <section class="screen" aria-labelledby="extract-save-h">
      <h2 id="extract-save-h">Build a spreadsheet &mdash; step 3 of 3</h2>

      ${
        done
          ? `<p class="summary">Saved to <code>${escapeHtml(props.savedPath!)}</code></p>
             <p><strong>Open it in Excel and check it before uploading.</strong>
             The <code>_notes</code> column says which rows need a look, and
             <code>_source</code> says where each value came from. Delete both
             columns or leave them &mdash; the uploader ignores them.</p>`
          : `<p class="summary">
               <strong>${props.fileCount}</strong> row(s) will be written.
               ${
                 props.flagged === 0
                   ? 'None need review.'
                   : `<strong>${props.flagged}</strong> need review &mdash; see the <code>_notes</code> column.`
               }
             </p>`
      }

      ${props.error === null ? '' : `<p class="error" role="alert">${escapeHtml(props.error)}</p>`}

      <div class="actions">
        ${done ? '' : `<button id="extract-back" type="button">Back</button>`}
        ${
          done
            ? `<button id="extract-open-folder" type="button">Open containing folder</button>
               <button id="extract-done" type="button">Done</button>`
            : `<button id="extract-save" type="button" ${props.busy ? 'disabled' : ''}>
                 ${props.busy ? 'Writing&hellip;' : 'Save spreadsheet&hellip;'}
               </button>`
        }
      </div>
    </section>`;

  root.querySelector<HTMLButtonElement>('#extract-save')?.addEventListener('click', props.onSave);
  root.querySelector<HTMLButtonElement>('#extract-back')?.addEventListener('click', props.onBack);
  root.querySelector<HTMLButtonElement>('#extract-open-folder')?.addEventListener('click', props.onOpenFolder);
  root.querySelector<HTMLButtonElement>('#extract-done')?.addEventListener('click', props.onDone);
}
