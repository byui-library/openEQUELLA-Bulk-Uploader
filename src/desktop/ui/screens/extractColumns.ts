// src/desktop/ui/screens/extractColumns.ts
import { escapeHtml } from '../dom.js';
import { describeFilename } from '../extract/segments.js';
import { isCurrentOption, optionsForColumn, patternParts, restOfChain, type SourceEvidence } from '../extract/sources.js';
import { joinProblem } from '../../../core/extract/pattern.js';
import { plainLabel } from '../extract/picker.js';
import { ATTACHMENT_COLUMN, type ExtractedRow, type Profile, type Source } from '../../../core/extract/types.js';
import { countNeedingReview } from '../../../core/ai/review.js';

export interface ExtractColumnsProps {
  profile: Profile;
  profilePath: string | null;
  sampleFilename: string;
  /** One row per subfolder: the name split into parts is a FOLDER's, and the screen says so. */
  perFolder: boolean;
  /** Only the evidence the source dropdowns are built from. This screen reads
   * neither the file list nor the skipped list, and carrying them meant every
   * caller had to construct fields nobody looked at. */
  scan: SourceEvidence;
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
  // The column's OWN list: `sourceOptions` offers only what the files supply,
  // and a column configured with anything else -- every one in the shipped
  // obituary template -- matched nothing and rendered as "(nothing)".
  const options = optionsForColumn(props.profile.pattern, props.scan, column.sources);
  const current = column.sources[0];
  const rest = restOfChain(column.sources);

  const optionHtml = [
    `<option value="">(nothing &mdash; fill in Excel)</option>`,
    ...options.map(
      (o, n) =>
        `<option value="${n}" ${isCurrentOption(o, current) ? 'selected' : ''}>${escapeHtml(o.label)}</option>`,
    ),
  ].join('');

  // TEXT WITH PARTS OF THE NAME gets a box for its text, under the list. Saved
  // on `change` -- when the box is left -- not on every keystroke, so the
  // screen does not re-render mid-word and needs no caret restoring.
  const joinBox =
    current !== undefined && 'join' in current
      ? `<label class="hint" for="join-${index}">Text &mdash; put a part of the name in braces:
           ${patternParts(props.profile.pattern).map((n) => `<code>{${escapeHtml(n)}}</code>`).join(' ') || 'the pattern has no parts yet'}</label>
         <input id="join-${index}" class="join-input" type="text" value="${escapeHtml(current.join)}">
         <p id="join-${index}-problem" class="error join-error" role="alert"></p>`
      : '';

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
            ? `<span class="fixed">${props.perFolder ? 'the folder itself' : 'the file itself'}</span>`
            : `<label class="sr-only" for="src-${index}">Source for ${escapeHtml(plainLabel(path))}</label>
               <select id="src-${index}" class="source-select">${optionHtml}</select>
               ${joinBox}
               ${
                 rest === null
                   ? ''
                   : `<p class="hint chain-rest">This sets the first source; ${escapeHtml(rest)}. The rest is kept as it is &mdash; edit the profile file to change it.</p>`
               }`
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

/**
 * How to use the name's parts -- only when there are some, and with an example
 * built from THIS pattern's first part, so no collection's wording is shown to
 * another.
 */
function partsHint(described: ReturnType<typeof describeFilename>): string {
  const first = described.matched ? described.parts[0] : undefined;
  if (first === undefined) return '';
  return `
      <p class="hint">
        Any column can use these parts: choose <em>Part of the name</em>, or
        <em>Text with parts of the name&hellip;</em> to put your own words around one &mdash;
        e.g. <code>Your words {${escapeHtml(first.name)}}</code>.
      </p>`;
}

function previewTable(props: ExtractColumnsProps): string {
  const paths = props.profile.columns.map((c) => c.path);
  // A FOLDER BATCH SHOWS WHAT EACH ROW HOLDS, straight after the folder name.
  // Reported by the operator: a row named SRE_Vol1 gave no sign that it is one
  // item carrying four issues. Display only -- never a spreadsheet column.
  const folders = props.perFolder;
  // After the column that names the folder, wherever the profile put it.
  const filesAfter = Math.max(0, paths.indexOf(ATTACHMENT_COLUMN));
  const cell = (value: string) =>
    `<td>${value === '' ? '<span class="blank">(blank)</span>' : escapeHtml(value)}</td>`;
  const filesCell = (files: string[] | undefined) =>
    cell(files === undefined ? '' : `${files.length} file${files.length === 1 ? '' : 's'}: ${files.join(', ')}`);
  /** One row's cells, with the files cell spliced in for a folder batch. */
  const withFiles = (cells: string[], files: string) => {
    if (!folders) return cells.join('');
    const at = Math.min(filesAfter + 1, cells.length);
    return [...cells.slice(0, at), files, ...cells.slice(at)].join('');
  };
  const head = withFiles(
    paths.map((p) => `<th>${escapeHtml(p)}</th>`),
    '<th>Files attached, in order</th>',
  );
  const body = props.preview
    .map((row) => `<tr>${withFiles(paths.map((p) => cell(row.cells[p] ?? '')), filesCell(row.files))}</tr>`)
    .join('');
  const flagged = previewReviewCount(props.preview);

  return `
    <h3>Preview &mdash; first ${props.preview.length} ${folders ? 'folder(s)' : 'file(s)'}
      ${flagged > 0 ? `<span class="warn-inline">${flagged} need review</span>` : ''}
    </h3>
    <div class="preview-scroll"><table class="preview"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    ${previewNotes(props.preview)}`;
}

/**
 * How many previewed rows have something genuinely wrong.
 *
 * ## Why this is not `notes.length > 0` any more
 *
 * Every cell a language model writes is flagged, without exception -- that is
 * the safety property the feature rests on. So on a profile with a model column,
 * every row carries a note, and a count of noted rows reads "5 need review" for
 * a preview in which nothing at all went wrong. `countNeedingReview` subtracts
 * the model's own notes by identity against `aiWritten`, never by recognising
 * their wording; see core/ai/review.ts.
 *
 * ## And why it is applied here even though the preview cannot show one today
 *
 * `extractPreview` does not run the model pass -- it re-renders on every column
 * edit, and a paid call per keystroke is not a feature -- so `aiWritten` is
 * empty on this screen in practice. The subtraction is applied all the same,
 * because the alternative is a screen that starts miscounting the day anything
 * hands it a model-written row, and that is exactly how this defect reached the
 * run report. A reviewer flagged both surfaces; both are fixed the same way.
 *
 * `previewNotes` below deliberately does NOT subtract: the LIST keeps showing
 * every note, including the model's, because the flag on a model-written cell is
 * the whole argument for letting it write at all and hiding it at the moment of
 * decision would be worse than miscounting.
 *
 * Exported so it can be tested directly: this project has no DOM environment.
 */
export function previewReviewCount(preview: readonly ExtractedRow[]): number {
  return countNeedingReview(preview);
}

/**
 * The flagged rows, named, with their reasons.
 *
 * The heading above reports a COUNT, which told the operator that something
 * needed review without saying which row or why -- they had to save the
 * spreadsheet and open it in Excel to find out. A flag nobody can read at the
 * moment of decision is not much better than no flag.
 *
 * Exported so it can be tested: this project has no DOM environment, so the
 * pure markup is asserted as a string, as `ui/duplicates.ts` already does.
 */
export function previewNotes(preview: readonly ExtractedRow[]): string {
  const flagged = preview.filter((r) => r.notes.length > 0);
  if (flagged.length === 0) return '';

  const items = flagged
    .map((r) => {
      const name = r.cells[ATTACHMENT_COLUMN] ?? '';
      const notes = r.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('');
      return `<li><strong>${escapeHtml(name)}</strong><ul>${notes}</ul></li>`;
    })
    .join('');

  return `
    <div class="preview-notes">
      <h4>Needs review</h4>
      <ul>${items}</ul>
    </div>`;
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

      <h3>Your ${props.perFolder ? 'folders' : 'files'} look like this</h3>
      <p class="sample"><code>${escapeHtml(props.sampleFilename)}</code></p>
      <p class="segments">${segments}</p>
      ${partsHint(described)}
      <details>
        <summary>Edit the pattern</summary>
        <label for="extract-pattern">${props.perFolder ? 'Folder name pattern' : 'Filename pattern'}</label>
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
      // THE SAME LIST THE ROW WAS RENDERED FROM. The value is an index into
      // it, so a list built any other way here would resolve that index to a
      // different source -- a click on one thing storing another.
      const path = pathOf(s);
      const sources = props.profile.columns.find((c) => c.path === path)?.sources ?? [];
      const options = optionsForColumn(props.profile.pattern, props.scan, sources);
      const chosen = s.value === '' ? null : (options[Number(s.value)]?.source ?? null);
      props.onSourceChange(path, chosen);
    }),
  );
  root.querySelectorAll<HTMLInputElement>('.join-input').forEach((i) =>
    i.addEventListener('change', () => {
      // A blank box is ignored, not saved: an empty text could never fill
      // anything, and the profile loader refuses one.
      const text = i.value.trim();
      if (text === '') return;
      // CHECKED HERE, BEFORE SAVING, by the profile loader's own rule. A bad
      // text saved would be refused, and the re-render would put the OLD text
      // back in the box -- throwing the typing away. Not saving, and saying why
      // in the slot beside the box with no re-render, keeps every keystroke.
      const problem = joinProblem(text, patternParts(props.profile.pattern));
      const slot = root.querySelector<HTMLElement>(`#${i.id}-problem`);
      if (slot !== null) slot.textContent = problem ?? '';
      if (problem === null) props.onSourceChange(pathOf(i), { join: text });
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
