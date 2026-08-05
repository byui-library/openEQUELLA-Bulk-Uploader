// src/desktop/ui/screens/extractAddColumn.ts
import { escapeHtml, keepCaret } from '../dom.js';
import { availablePaths, groupPaths, plainLabel } from '../extract/picker.js';

export interface ExtractAddColumnProps {
  schemaPaths: string[];
  usedPaths: string[];
  query: string;
  onQueryChange(q: string): void;
  onPick(path: string): void;
  onCancel(): void;
}

/**
 * The Add-column picker. Offers only real schema paths, so an invalid column
 * cannot be expressed -- error prevention rather than an error message. The
 * plain-language name is shown beside the xpath, never instead of it: the
 * xpath is what the spreadsheet header must literally say.
 */
export function renderExtractAddColumn(root: HTMLElement, props: ExtractAddColumnProps): void {
  const matches = availablePaths(props.schemaPaths, props.usedPaths, props.query);

  // Every keystroke re-renders this screen, destroying and recreating the
  // search box. focusWhenNew also gives it focus the first time the dialog
  // opens, so the operator can type immediately.
  const restoreCaret = keepCaret(root, '#add-col-q', { focusWhenNew: true });

  root.innerHTML = `
    <section class="screen modal" role="dialog" aria-modal="true" aria-labelledby="add-col-h">
      <h2 id="add-col-h">Add a column</h2>
      <label for="add-col-q">Search the schema</label>
      <input id="add-col-q" type="text" value="${escapeHtml(props.query)}" autocomplete="off">
      ${
        matches.length === 0
          ? `<p class="muted">Nothing matches &ldquo;${escapeHtml(props.query)}&rdquo;.</p>`
          : // Every match is rendered, grouped under its schema, inside one
            // scrolling region. There is deliberately no cap: a plain sorted
            // list truncated at fifty rows put MWDL -- which holds the fields
            // most items need -- entirely out of reach, because BYUI_extended
            // alone supplies ninety-eight paths. Hiding the remainder is what
            // caused the problem, so nothing is hidden.
            `<div class="path-scroll">${groupPaths(matches)
              .map(
                (group) => `
                <h3 class="path-group">${escapeHtml(group.schema)}
                  <span class="muted">${group.paths.length}</span>
                </h3>
                <ul class="path-list">${group.paths
                  .map(
                    (p) =>
                      `<li><button type="button" class="pick" data-path="${escapeHtml(p)}">
                         <strong>${escapeHtml(plainLabel(p))}</strong> <code>${escapeHtml(p)}</code>
                       </button></li>`,
                  )
                  .join('')}</ul>`,
              )
              .join('')}</div>`
      }
      <div class="actions"><button id="add-col-cancel" type="button">Cancel</button></div>
    </section>`;

  const input = root.querySelector<HTMLInputElement>('#add-col-q');
  input?.addEventListener('input', () => props.onQueryChange(input.value));
  restoreCaret();

  root.querySelectorAll<HTMLButtonElement>('.pick').forEach((b) =>
    b.addEventListener('click', () => props.onPick(b.getAttribute('data-path') ?? '')),
  );
  root.querySelector<HTMLButtonElement>('#add-col-cancel')?.addEventListener('click', props.onCancel);
}
