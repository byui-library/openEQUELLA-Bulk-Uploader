// src/desktop/ui/screens/extractColumns.ts
import { escapeHtml } from '../dom.js';
import { describeFilename } from '../extract/segments.js';
import { describeSource, sourceOptions } from '../extract/sources.js';
import { plainLabel } from '../extract/picker.js';
import type { ExtractedRow, Profile, Source } from '../../../core/extract/types.js';

export interface ExtractColumnsProps {
  profile: Profile;
  profilePath: string | null;
  sampleFilename: string;
  scan: { supported: string[]; skipped: { file: string; reason: string }[]; labels: string[]; properties: string[] };
  preview: ExtractedRow[];
  busy: boolean;
  error: string | null;
  onPatternChange(pattern: string): void;
  onSourceChange(path: string, source: Source | null): void;
  onDefaultChange(path: string, value: string): void;
  onRemove(path: string): void;
  onMove(path: string, delta: number): void;
  onAdd(): void;
  removed: { path: string } | null;
  onUndoRemove(): void;
  onOpenProfile(): void;
  onSaveProfile(): void;
  onContinue(): void;
  onBack(): void;
}

function columnRow(props: ExtractColumnsProps, path: string, index: number): string {
  const column = props.profile.columns.find((c) => c.path === path)!;
  const locked = column.locked === true;
  const options = sourceOptions(props.profile.pattern, props.scan);
  const current = column.sources[0];
  const currentLabel = current === undefined ? '' : describeSource(current);

  const optionHtml = [
    `<option value="">(nothing &mdash; fill in Excel)</option>`,
    ...options.map(
      (o, n) =>
        `<option value="${n}" ${o.label === currentLabel ? 'selected' : ''}>${escapeHtml(o.label)}</option>`,
    ),
  ].join('');

  return `
    <tr data-path="${escapeHtml(path)}" ${locked ? 'class="locked"' : ''}>
      <td class="handle">
        ${
          locked
            ? '<span aria-hidden="true">&nbsp;</span>'
            : `<button type="button" class="move-up" aria-label="Move ${escapeHtml(plainLabel(path))} up" ${index <= 1 ? 'disabled' : ''}>&uarr;</button>
               <button type="button" class="move-down" aria-label="Move ${escapeHtml(plainLabel(path))} down" ${index === props.profile.columns.length - 1 ? 'disabled' : ''}>&darr;</button>`
        }
      </td>
      <td class="name">
        <strong>${escapeHtml(plainLabel(path))}</strong>
        <code>${escapeHtml(path)}</code>
      </td>
      <td class="source">
        ${
          locked
            ? '<span class="fixed">the file itself</span>'
            : `<label class="sr-only" for="src-${index}">Source for ${escapeHtml(plainLabel(path))}</label>
               <select id="src-${index}" class="source-select">${optionHtml}</select>`
        }
      </td>
      <td class="default">
        ${
          locked
            ? ''
            : `<label class="sr-only" for="def-${index}">Value when blank, for ${escapeHtml(plainLabel(path))}</label>
               <input id="def-${index}" class="default-input" type="text" placeholder="when blank&hellip;"
                      value="${escapeHtml(column.default ?? '')}">`
        }
      </td>
      <td class="remove">
        ${
          locked
            ? '<span class="fixed" title="Required: this is how each row is matched to its file">required</span>'
            : `<button type="button" class="remove-column" aria-label="Remove ${escapeHtml(plainLabel(path))}">&times;</button>`
        }
      </td>
      <!--
        No "nothing fills this" warning here. The source dropdown already reads
        "(nothing -- fill in Excel)" for such a column, so the badge said the
        same thing twice, and said it in warning amber. An empty column is a
        deliberate, useful choice -- the starter profile ships description that
        way on purpose -- so warning about it fires on the default setup, and a
        warning that always fires is one people learn to ignore.
      -->
    </tr>`;
}

function previewTable(props: ExtractColumnsProps): string {
  const paths = props.profile.columns.map((c) => c.path);
  const head = paths.map((p) => `<th>${escapeHtml(p)}</th>`).join('');
  const body = props.preview
    .map(
      (row) =>
        `<tr>${paths
          .map((p) => {
            const value = row.cells[p] ?? '';
            return `<td>${value === '' ? '<span class="blank">(blank)</span>' : escapeHtml(value)}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  const flagged = props.preview.filter((r) => r.notes.length > 0).length;

  return `
    <h3>Preview &mdash; first ${props.preview.length} file(s)
      ${flagged > 0 ? `<span class="warn-inline">${flagged} need review</span>` : ''}
    </h3>
    <div class="preview-scroll"><table class="preview"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/**
 * Step 2 of 3. The column list IS the spreadsheet: what columns exist, in what
 * order, and where each value comes from. Every edit re-renders the preview, so
 * the consequence of a change is visible in the same glance as the change.
 */
export function renderExtractColumns(root: HTMLElement, props: ExtractColumnsProps): void {
  const described = describeFilename(props.profile.pattern, props.sampleFilename);
  const segments = described.matched
    ? described.parts
        .map((p) => `<span class="segment"><em>${escapeHtml(p.name)}</em>${escapeHtml(p.value)}</span>`)
        .join('<span class="sep">|</span>')
    : `<span class="warn-inline">This pattern does not match ${escapeHtml(props.sampleFilename)}</span>`;

  root.innerHTML = `
    <section class="screen wide" aria-labelledby="extract-columns-h">
      <h2 id="extract-columns-h">Build a spreadsheet &mdash; step 2 of 3</h2>

      <h3>Your files look like this</h3>
      <p class="sample"><code>${escapeHtml(props.sampleFilename)}</code></p>
      <p class="segments">${segments}</p>
      <details>
        <summary>Edit the pattern</summary>
        <label for="extract-pattern">Filename pattern</label>
        <input id="extract-pattern" type="text" value="${escapeHtml(props.profile.pattern)}">
        <p class="hint">Use <code>{name}</code> for each part you want to capture.</p>
      </details>

      <h3>Columns in your spreadsheet
        <button id="extract-add-column" type="button">+ Add column</button>
      </h3>
      <table class="columns"><tbody>
        ${props.profile.columns.map((c, i) => columnRow(props, c.path, i)).join('')}
      </tbody></table>

      ${
        props.removed === null
          ? ''
          : `<p class="undo" role="status">
               Removed <strong>${escapeHtml(props.removed.path)}</strong>.
               <button id="extract-undo" type="button">Undo</button>
             </p>`
      }

      ${previewTable(props)}
      ${props.error === null ? '' : `<p class="error" role="alert">${escapeHtml(props.error)}</p>`}

      <div class="actions">
        <button id="extract-back" type="button">Back</button>
        <button id="extract-open-profile" type="button">Load profile&hellip;</button>
        <button id="extract-save-profile" type="button">Save profile&hellip;</button>
        <button id="extract-continue" type="button" ${props.busy ? 'disabled' : ''}>Continue</button>
      </div>
    </section>`;

  const pathOf = (el: Element): string => el.closest('tr')?.getAttribute('data-path') ?? '';

  root.querySelectorAll<HTMLButtonElement>('.remove-column').forEach((b) =>
    b.addEventListener('click', () => props.onRemove(pathOf(b))),
  );
  root.querySelectorAll<HTMLButtonElement>('.move-up').forEach((b) =>
    b.addEventListener('click', () => props.onMove(pathOf(b), -1)),
  );
  root.querySelectorAll<HTMLButtonElement>('.move-down').forEach((b) =>
    b.addEventListener('click', () => props.onMove(pathOf(b), 1)),
  );
  root.querySelectorAll<HTMLSelectElement>('.source-select').forEach((s) =>
    s.addEventListener('change', () => {
      const options = sourceOptions(props.profile.pattern, props.scan);
      const chosen = s.value === '' ? null : (options[Number(s.value)]?.source ?? null);
      props.onSourceChange(pathOf(s), chosen);
    }),
  );
  root.querySelectorAll<HTMLInputElement>('.default-input').forEach((i) =>
    i.addEventListener('change', () => props.onDefaultChange(pathOf(i), i.value)),
  );

  root.querySelector<HTMLInputElement>('#extract-pattern')?.addEventListener('change', (e) =>
    props.onPatternChange((e.target as HTMLInputElement).value),
  );
  root.querySelector<HTMLButtonElement>('#extract-add-column')?.addEventListener('click', props.onAdd);
  root.querySelector<HTMLButtonElement>('#extract-undo')?.addEventListener('click', props.onUndoRemove);
  root.querySelector<HTMLButtonElement>('#extract-open-profile')?.addEventListener('click', props.onOpenProfile);
  root.querySelector<HTMLButtonElement>('#extract-save-profile')?.addEventListener('click', props.onSaveProfile);
  root.querySelector<HTMLButtonElement>('#extract-continue')?.addEventListener('click', props.onContinue);
  root.querySelector<HTMLButtonElement>('#extract-back')?.addEventListener('click', props.onBack);
}
