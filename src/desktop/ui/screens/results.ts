import type { RunReport } from '../../ipc.js';
import { escapeHtml } from '../dom.js';

export interface InterruptedEntry {
  rowNumber: number;
  fileName: string;
}

export interface ResultsProps {
  report: RunReport;
  interrupted: InterruptedEntry[];
  collectionUrl: string;
  /** Named in the "another spreadsheet" hint, so it is clear what is kept. */
  collectionName: string | null;
  /**
   * The operator's own name for the site this batch went to, for the two links
   * below. Named for the same reason Choose and Sign-in name it: a link reading
   * only "Settings" or "Sign out" leaves the operator guessing which site it
   * acts on, and this screen is where they are most likely to be about to
   * switch.
   */
  instanceLabel: string;
  retrying: boolean;
  error: string | null;
  onRetryFailed(): void;
  /** Back to Choose for another spreadsheet, without restarting the app. */
  onAnotherBatch(): void;
  /**
   * Setup for this site, clearing nothing -- app.ts's `handleSiteSettings`,
   * never the destructive "Change credentials…" route.
   */
  onSiteSettings(): void;
  /**
   * End this site's session and go back to Sign-in, through the SAME handler
   * Sign-in's own Sign out uses (app.ts's `handleSignOut`), which ends the
   * openEQUELLA session on the server and reports honestly when the site would
   * not confirm it.
   *
   * Safe here because the batch is over. The same control is on Choose, which
   * is pre-run, and deliberately on neither Progress nor anything between.
   */
  onSignOut(): void;
}

/**
 * Counts, per-row failures, a Retry failed action, and a link to the
 * collection. If anything was left `interrupted` by an earlier crashed run,
 * that gets its own plain-language explanation -- it is the runner
 * deliberately declining to guess, not an error (spec).
 */
export function renderResults(root: HTMLElement, props: ResultsProps): void {
  const r = props.report;

  const interruptedSection =
    r.interrupted > 0
      ? `
      <div class="danger-panel" role="status">
        <p>
          <strong>${r.interrupted} row(s) were left over from a previous run that stopped midway</strong>
          (a crash, a lost connection, or the app being closed while a file was uploading).
        </p>
        <p>
          For each one, the item may or may not have actually been created in
          openEQUELLA &mdash; check the collection by hand before reprocessing.
          These rows are <strong>not</strong> retried automatically or by the
          Retry failed button below.
        </p>
        ${
          props.interrupted.length > 0
            ? `<ul>${props.interrupted
                .map((e) => `<li>Row ${e.rowNumber}: ${escapeHtml(e.fileName)}</li>`)
                .join('')}</ul>`
            : ''
        }
      </div>`
      : '';

  const failureRows = r.failures
    .map(
      (f) => `
      <tr>
        <td>${f.rowNumber}</td>
        <td>${escapeHtml(f.fileName)}</td>
        <td>${escapeHtml(f.error)}</td>
      </tr>`,
    )
    .join('');

  const failuresSection =
    r.failures.length > 0
      ? `
      <fieldset>
        <legend>Failed rows (${r.failures.length})</legend>
        <table class="review-table">
          <thead><tr><th>Row</th><th>File</th><th>Reason</th></tr></thead>
          <tbody>${failureRows}</tbody>
        </table>
        <div class="button-row">
          <button id="results-retry-btn" type="button" ${props.retrying ? 'disabled' : ''}>
            ${props.retrying ? 'Retrying…' : 'Retry failed'}
          </button>
        </div>
      </fieldset>`
      : '';

  root.innerHTML = `
    <section class="screen">
      <h1>Done</h1>

      <dl class="confirm-summary">
        <dt>Created</dt><dd>${r.created}</dd>
        <dt>Failed</dt><dd>${r.failed}</dd>
        <dt>Skipped (already done or chosen to skip)</dt><dd>${r.skipped}</dd>
        <dt>Incomplete</dt><dd>${r.incomplete}</dd>
        <dt>Interrupted</dt><dd>${r.interrupted}</dd>
      </dl>

      ${interruptedSection}
      ${failuresSection}

      ${props.error ? `<p class="error" role="alert">${escapeHtml(props.error)}</p>` : ''}

      <p>
        <a id="results-open-collection" href="${escapeHtml(props.collectionUrl)}" target="_blank" rel="noopener noreferrer">
          Open the collection in openEQUELLA
        </a>
      </p>

      <div class="button-row">
        <button id="results-another-btn" type="button">
          Upload another spreadsheet
        </button>
      </div>
      <p class="hint">
        Keeps you signed in and keeps ${escapeHtml(props.collectionName || 'the same collection')}
        selected. You will choose a new spreadsheet and folder, and the draft/live
        choice starts again from Draft.
      </p>

      <p class="reset-row">
        <button id="results-site-settings" type="button" class="link-button">
          Site settings for ${escapeHtml(props.instanceLabel)}…
        </button>
        <button id="results-sign-out" type="button" class="link-button">
          Sign out of ${escapeHtml(props.instanceLabel)}…
        </button>
      </p>
      <p class="hint">
        Site settings: change the attachment ID field, the address or the sign-in details
        for this site. Your batch is finished, so nothing is uploaded again either way.
      </p>
      <p class="hint">
        Sign out: end this session and go back to the sign-in screen, where you can pick a
        different site. This summary is not kept, so open the collection above first if you
        still need it.
      </p>
    </section>
  `;

  root.querySelector<HTMLButtonElement>('#results-retry-btn')?.addEventListener('click', () => props.onRetryFailed());
  root
    .querySelector<HTMLButtonElement>('#results-another-btn')
    ?.addEventListener('click', () => props.onAnotherBatch());
  root
    .querySelector<HTMLButtonElement>('#results-site-settings')
    ?.addEventListener('click', () => props.onSiteSettings());
  root.querySelector<HTMLButtonElement>('#results-sign-out')?.addEventListener('click', () => props.onSignOut());
}
