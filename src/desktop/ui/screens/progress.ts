import { progressPercent } from '../progress.js';
import { escapeHtml } from '../dom.js';

export interface ProgressLogEntry {
  fileName: string;
  status: string;
  error?: string;
}

export interface ProgressProps {
  done: number;
  total: number;
  fileName: string;
  /** Most recent last. app.ts caps this so a very large batch can't grow it
   *  unbounded in memory. */
  log: ProgressLogEntry[];
}

/**
 * A real batch is ~37 files over ~6 minutes (spec), so this screen is on
 * display for a while. It needs to look ALIVE, not frozen: a moving bar, the
 * file currently in flight named explicitly, and a scrolling log of what's
 * already finished -- rather than a bare spinner the operator has to take on
 * faith.
 */
export function progressMarkup(props: ProgressProps): string {
  const pct = progressPercent(props.done, props.total);
  const logItems = props.log
    .slice()
    .reverse()
    .map((e) => {
      const label = e.error ? `${e.status} — ${e.error}` : e.status;
      const cls = e.status === 'failed' ? ' log-line--failed' : '';
      return `<li class="log-line${cls}">${escapeHtml(e.fileName)}: ${escapeHtml(label)}</li>`;
    })
    .join('');

  return `
    <section class="screen">
      <h1>Uploading…</h1>
      <p class="muted">
        This can take several minutes for a large batch. Leave this window
        open until it finishes.
      </p>

      <p class="progress-count">${props.done} / ${props.total}</p>
      <!-- No style attribute here on purpose: index.html's CSP blocks inline
           styles, so the width is assigned in renderProgress below. -->
      <div class="progress-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
        <div class="progress-bar__fill"></div>
      </div>

      <p class="progress-current">
        ${props.done < props.total ? `Working on: <strong>${escapeHtml(props.fileName || '…')}</strong>` : 'Finishing up…'}
      </p>

      <ul class="progress-log">${logItems}</ul>
    </section>
  `;
}

export function renderProgress(root: HTMLElement, props: ProgressProps): void {
  root.innerHTML = progressMarkup(props);

  // The bar's width is set here, through the DOM API, rather than as a
  // `style="width: N%"` attribute in the markup above. index.html's CSP is
  // `default-src 'self'` with no `style-src`, so it inherits `'self'` and
  // Chromium refuses inline style attributes -- verified in Electron against
  // the shipped page, where setting `style="width: 42%"` on an element left
  // `style.width` as `""`. The attribute version shipped from v0.1.0 and the
  // bar never moved once. A CSP does not govern the DOM API, so this works,
  // and adding `'unsafe-inline'` instead would weaken a policy that guards a
  // UI rendering operator-supplied spreadsheet and document text.
  //
  // Done after the render for the same reason as every other screen's
  // listener wiring: the element does not exist until innerHTML is assigned.
  const fill = root.querySelector<HTMLElement>('.progress-bar__fill');
  if (fill) fill.style.width = `${progressPercent(props.done, props.total)}%`;
}
