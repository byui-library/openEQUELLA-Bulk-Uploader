import { escapeHtml } from '../dom.js';

export interface ExtractSaveProps {
  fileCount: number;
  /** Rows with something genuinely wrong. See core/ai/review.ts -- a model
   *  write is not one of them, or this number would read 400 of 400. */
  flagged: number;
  /** Rows a language model wrote into. Its own sentence, because "needs review"
   *  and "a machine wrote this" are different things to tell somebody. */
  aiWritten: number;
  savedPath: string | null;
  busy: boolean;
  /**
   * What the model pass is doing right now, or null when it is not running.
   *
   * REPORTED BY THE OPERATOR as the app simply taking longer. It is: one call
   * per eligible cell, in sequence, and the first pays for the runtime to
   * load the model -- measured at 48 seconds on a real machine, against about
   * 4 for a warm one. A minute of silence with a disabled button reads as a
   * hang.
   */
  modelStatus: string | null;
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
          ? `<p class="summary">
               Saved <strong>${props.fileCount}</strong> row(s) to
               <code>${escapeHtml(props.savedPath!)}</code>.
               ${
                 props.flagged === 0
                   ? 'None need review.'
                   : `<strong>${props.flagged}</strong> need review &mdash; see the <code>_notes</code> column.`
               }
               ${
                 // Said separately, and only when it happened. A machine wrote
                 // text that is about to become a permanent catalogue record;
                 // folding it into "need review" would bury the rows that
                 // genuinely went wrong, and leaving it out altogether would
                 // hide the thing the operator most needs to check.
                 props.aiWritten === 0
                   ? ''
                   : `<strong>${props.aiWritten}</strong> had a value written by a language model &mdash;
                      every one is flagged. Check them against the documents before uploading.`
               }
             </p>
             <p><strong>Open it in Excel and check it before uploading.</strong>
             The <code>_notes</code> column says which rows need a look, and
             <code>_source</code> says where each value came from. Leave them or delete
             them &mdash; the uploader skips any column whose name starts with an
             underscore.</p>`
          : // Deliberately says nothing about how many rows need review. The
            // count comes from the real run, which has not happened yet -- it
            // is zero here for the whole life of this screen, so claiming
            // "None need review" before writing anything was simply false.
            `<p class="summary"><strong>${props.fileCount}</strong> row(s) will be written.</p>`
      }

      ${props.error === null ? '' : `<p class="error" role="alert">${escapeHtml(props.error)}</p>`}

      <div class="actions">
        ${done ? '' : `<button id="extract-back" type="button">Back</button>`}
        ${
          done
            ? `<button id="extract-open-folder" type="button">Open containing folder</button>
               <button id="extract-done" type="button">Done</button>`
            : `${props.modelStatus === null ? '' : `<p class="hint" id="extract-model-status">${escapeHtml(props.modelStatus)}</p>`}
               <button id="extract-save" type="button" ${props.busy ? 'disabled' : ''}>
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
