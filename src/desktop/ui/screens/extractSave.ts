import { escapeHtml } from '../dom.js';
import type { ProblemsSummary } from '../../../core/extract/types.js';

export interface ExtractSaveProps {
  fileCount: number;
  /** Rows with something genuinely wrong. See core/ai/review.ts -- a model
   *  write is not one of them, or this number would read 400 of 400. */
  flagged: number;
  /** Rows a language model wrote into. Its own sentence, because "needs review"
   *  and "a machine wrote this" are different things to tell somebody. */
  aiWritten: number;
  savedPath: string | null;
  /**
   * The problems log of a one-row-per-subfolder run, or null when there was
   * none. `heldBack` folders are NOT in the spreadsheet and will not be
   * uploaded until fixed -- the one thing on this screen an operator must not
   * miss, so it is said before anything else.
   */
  problems: ProblemsSummary | null;
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
  onOpenProblems(): void;
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
             ${problemsSection(props.problems)}
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
  root.querySelector<HTMLButtonElement>('#extract-open-problems')?.addEventListener('click', props.onOpenProblems);
}

/** What the problems log holds, and the way to it. Empty when there is no log. */
function problemsSection(problems: ExtractSaveProps['problems']): string {
  if (problems === null) return '';
  const held =
    problems.heldBack === 0
      ? ''
      : `<p class="warn"><strong>${problems.heldBack}</strong> folder(s) were held back and are not
           in the spreadsheet, so they will not be uploaded. The problem list says what is wrong with
           each and how to fix it; fix the folders, then build the spreadsheet again.</p>`;
  const loose =
    problems.looseFiles === 0
      ? ''
      : `<p class="warn"><strong>${problems.looseFiles}</strong> file(s) lie loose beside the
           folders, so they are not in the spreadsheet and will not be uploaded. Move each into the
           folder it belongs to, then build the spreadsheet again.</p>`;
  // Neutral wording: the problem list itself speaks the template's own words
  // (issue, folio, ...), and this summary must not contradict it.
  const notes =
    problems.notes === 0
      ? ''
      : `<p><strong>${problems.notes}</strong> note(s) to check &mdash; such as a file with no number
           in its name, a gap in the numbering, or dates out of order. Those folders are in the
           spreadsheet.</p>`;
  // Clean only when NOTHING is listed: a summary reading "no problems" over a
  // log that holds a held-back line is a check reporting success it did not have.
  const clean =
    problems.heldBack === 0 && problems.looseFiles === 0 && problems.notes === 0
      ? '<p>No problems were found in the folders.</p>'
      : '';
  return `
    ${held}${loose}${notes}${clean}
    <p>
      <button id="extract-open-problems" type="button">Show problem list</button>
      <code>${escapeHtml(problems.path)}</code>
    </p>`;
}
