import type { ColumnReport, PlanReport } from '../../ipc.js';
import { canContinueReview } from '../review.js';
import { categorizeWarnings } from '../warnings.js';
import { escapeHtml } from '../dom.js';

export interface ReviewProps {
  /** From validate() against the ORIGINAL sheet -- see review.ts's doc
   *  comment for why this, and not plan()'s response, is the stable
   *  identity every override is keyed against. Null only before the first
   *  validate() call resolves. */
  columns: ColumnReport[] | null;
  /** originalHeader -> the xpath the user picked to replace it with. */
  overrides: Record<string, string>;
  /** True once plan() has succeeded for the CURRENT overrides -- reveals the
   *  warnings/entry-count and turns the button into "Continue to Confirm".
   *  Reset to false by app.ts whenever an override changes after a success,
   *  since the plan on disk may now be stale. */
  checked: boolean;
  /** Populated once `checked` is true. */
  report: PlanReport | null;
  loadingColumns: boolean;
  checking: boolean;
  error: string | null;
  onOverrideChange(originalHeader: string, xpath: string): void;
  onContinue(): void;
  onBack(): void;
}

/**
 * The screen this app exists for (design spec). Every column from the
 * spreadsheet, marked valid/invalid; invalid ones get a dropdown of
 * `suggestions` (schema.ts#suggest, already ranked against the FULL set of
 * schema xpaths -- there is no separate IPC surface exposing that full list,
 * see the Task 8 report) plus a manual "type an xpath" escape hatch for the
 * rare column with no plausible suggestion at all.
 *
 * Nothing here calls run(). Continue calls plan() (which both writes the
 * manifest and returns the report -- see ipc.ts), and `buildManifest`
 * (core/plan.ts) THROWS if any header is still invalid after overrides are
 * applied, rather than returning a partial report. So a successful plan()
 * response is proof every column is now valid; that's what unlocks the
 * second "Continue to Confirm" click.
 */
export function renderReview(root: HTMLElement, props: ReviewProps): void {
  if (props.loadingColumns || props.columns === null) {
    root.innerHTML = `
      <section class="screen">
        <h1>Review</h1>
        <p class="muted">Checking your spreadsheet's columns against the schema…</p>
      </section>
    `;
    return;
  }

  const rows = props.columns
    .map((c) => {
      const override = props.overrides[c.header] ?? '';
      const hasOverride = override.trim() !== '';
      const isKnownSuggestion = hasOverride && c.suggestions.includes(override);
      const isCustom = hasOverride && !isKnownSuggestion;

      let statusCell: string;
      if (c.valid) {
        statusCell = `<span class="badge badge--valid">Valid</span>`;
      } else if (hasOverride && props.checked) {
        statusCell = `<span class="badge badge--valid">Mapped to '${escapeHtml(override)}' — checked</span>`;
      } else if (hasOverride) {
        statusCell = `<span class="badge badge--pending">Will map to '${escapeHtml(override)}' — not yet checked</span>`;
      } else {
        statusCell = `<span class="badge badge--invalid">Invalid</span>`;
      }

      let controlCell = '';
      if (!c.valid) {
        const options = [
          `<option value="">Choose a replacement…</option>`,
          ...c.suggestions.map(
            (s) => `<option value="${escapeHtml(s)}"${s === override ? ' selected' : ''}>${escapeHtml(s)}</option>`,
          ),
          `<option value="__custom__"${isCustom ? ' selected' : ''}>Other (type an xpath)…</option>`,
        ].join('');
        controlCell = `
          <select class="override-select" data-header="${escapeHtml(c.header)}">${options}</select>
          <input
            type="text"
            class="override-custom${isCustom ? '' : ' hidden'}"
            data-header="${escapeHtml(c.header)}"
            placeholder="Exact schema xpath"
            value="${isCustom ? escapeHtml(override) : ''}"
            spellcheck="false"
            autocomplete="off"
          />
        `;
      }

      return `
        <tr>
          <td class="col-header">${escapeHtml(c.header)}</td>
          <td>${statusCell}</td>
          <td>${controlCell}</td>
        </tr>
      `;
    })
    .join('');

  let warningsSection: string;
  if (!props.checked || !props.report) {
    if (props.columns.every((c) => c.valid)) {
      // All valid: app.ts kicks off an automatic check as soon as this is
      // true, so this is a brief transient state, not something the user
      // has to act on.
      warningsSection = props.checking ? `<p class="muted">Checking row-to-file matching and duplicates…</p>` : '';
    } else {
      warningsSection = `<p class="note">Fix the invalid columns above, then Continue to check row-to-file matching and possible duplicates.</p>`;
    }
  } else {
    const groups = categorizeWarnings(props.report.warnings);
    const section = (title: string, items: string[]): string =>
      items.length === 0
        ? ''
        : `
          <div class="warning-group">
            <h3>${escapeHtml(title)} (${items.length})</h3>
            <ul>${items.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
          </div>
        `;
    const allGroups =
      section('Rows whose file could not be found', groups.missingFile) +
      section('Files with no matching row', groups.unmatchedFile) +
      section('Identifiers that may already exist', groups.duplicateIdentifier) +
      section('Other warnings', groups.other);

    warningsSection = `
      <fieldset>
        <legend>Plan summary</legend>
        <p><strong>${props.report.entryCount}</strong> item(s) will be created from this spreadsheet.</p>
        ${allGroups || '<p class="note">No warnings -- every row matched a file with no issues found.</p>'}
      </fieldset>
    `;
  }

  const canContinue = canContinueReview(props.columns, props.overrides);
  const continueLabel = props.checking
    ? 'Checking…'
    : props.checked && props.report
      ? 'Continue to Confirm'
      : 'Continue';

  root.innerHTML = `
    <section class="screen">
      <h1>Review</h1>
      <p>
        Every column below must match a real field in the schema before you
        can continue. Nothing is uploaded from this screen.
      </p>

      <table class="review-table">
        <thead><tr><th>Column</th><th>Status</th><th>Replace with</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>

      ${warningsSection}

      ${props.error ? `<p class="error" role="alert">${escapeHtml(props.error)}</p>` : ''}

      <div class="button-row">
        <button id="review-back-btn" type="button" class="secondary">Back</button>
        <button id="review-continue-btn" type="button" ${canContinue && !props.checking ? '' : 'disabled'}>
          ${escapeHtml(continueLabel)}
        </button>
      </div>
    </section>
  `;

  root.querySelectorAll<HTMLSelectElement>('.override-select').forEach((select) => {
    select.addEventListener('change', () => {
      const header = select.dataset['header'] ?? '';
      const input = root.querySelector<HTMLInputElement>(`.override-custom[data-header="${cssEscape(header)}"]`);
      if (select.value === '__custom__') {
        // Reveal the input WITHOUT calling onOverrideChange yet. The caller
        // re-renders synchronously on every override change (app.ts calls
        // render() right after updating state), which would rebuild this
        // entire table from scratch; with nothing typed yet, overrides[header]
        // would still read as unmapped, so that rebuild would put the select
        // straight back to "Choose a replacement..." and hide this input
        // again -- from the user's perspective, picking "Other" would look
        // like it did nothing at all. Only notify once there's a real value
        // (the input's own 'change' listener below).
        input?.classList.remove('hidden');
        input?.focus();
      } else {
        input?.classList.add('hidden');
        if (input) input.value = '';
        props.onOverrideChange(header, select.value);
      }
    });
  });
  root.querySelectorAll<HTMLInputElement>('.override-custom').forEach((input) => {
    // 'change' (fires on blur/Enter), not 'input': onOverrideChange triggers
    // a full re-render of this table on every call (see above), which would
    // rebuild this very input out from under the keystroke that triggered it
    // -- losing focus and cursor position after every single character typed.
    // Firing once the user is done editing avoids that while still updating
    // the Continue gate as soon as they tab away or press Enter.
    input.addEventListener('change', () => {
      const header = input.dataset['header'] ?? '';
      props.onOverrideChange(header, input.value);
    });
  });

  root.querySelector<HTMLButtonElement>('#review-back-btn')?.addEventListener('click', () => props.onBack());
  root
    .querySelector<HTMLButtonElement>('#review-continue-btn')
    ?.addEventListener('click', () => props.onContinue());
}

/** Minimal CSS.escape stand-in: this app has no DOM lib types pulled in for
 *  it and the only characters ever appearing in a header (spreadsheet column
 *  names, schema xpaths) that need escaping for a `[data-header="..."]`
 *  selector are the quote itself and a backslash. */
function cssEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
