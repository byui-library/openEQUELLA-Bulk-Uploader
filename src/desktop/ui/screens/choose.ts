import type { CollectionSummary } from '../../../core/client.js';
import { filterCollections } from '../filter.js';
import { canContinueChoose } from '../state.js';
import { escapeHtml } from '../dom.js';

export interface ChooseProps {
  /** null while listCollections() is in flight. */
  collections: CollectionSummary[] | null;
  collectionsError: string | null;
  query: string;
  collectionUuid: string | null;
  sheetPath: string | null;
  folderPath: string | null;
  error: string | null;
  readyMessage: string | null;
  /** True while saveStarterKit() is in flight -- disables the button so a slow dialog can't be double-fired. */
  starterKitSaving: boolean;
  /** Set after a successful save, telling the operator exactly what to do next. Cleared on any new pick. */
  starterKitMessage: string | null;
  onQueryChange(q: string): void;
  onSelectCollection(uuid: string): void;
  onChooseSpreadsheet(): void;
  onChooseFolder(): void;
  onSaveStarterKit(): void;
  onContinue(): void;
}

/**
 * Collection dropdown + spreadsheet/folder pickers. `listCollections`
 * returns 29 collections on production, unsorted, with entries like "Sample"
 * ahead of anything a real user wants -- filterCollections (ui/filter.ts,
 * unit tested) sorts by name and supports a live filter so the list is
 * usable rather than a wall of options to scroll through.
 */
export function renderChoose(root: HTMLElement, props: ChooseProps): void {
  let collectionSection: string;
  if (props.collectionsError) {
    collectionSection = `<p class="error" role="alert">${escapeHtml(props.collectionsError)}</p>`;
  } else if (props.collections === null) {
    collectionSection = `<p class="muted">Loading collections…</p>`;
  } else {
    const filtered = filterCollections(props.collections, props.query);
    const rows = filtered
      .map(
        (c) =>
          `<option value="${escapeHtml(c.uuid)}"${c.uuid === props.collectionUuid ? ' selected' : ''}>${escapeHtml(c.name)}</option>`,
      )
      .join('');
    collectionSection = `
      <label for="collection-filter">Filter</label>
      <input id="collection-filter" type="text" placeholder="Type to filter…" value="${escapeHtml(props.query)}" autocomplete="off" />
      <label for="collection-select">Collection (showing ${filtered.length} of ${props.collections.length})</label>
      <select id="collection-select" size="8">
        ${rows || '<option disabled>No collections match.</option>'}
      </select>
    `;
  }

  root.innerHTML = `
    <section class="screen">
      <h1>Choose what to upload</h1>

      <fieldset>
        <legend>1. Collection</legend>
        ${collectionSection}
      </fieldset>

      <fieldset>
        <legend>2. Spreadsheet</legend>
        <button id="choose-sheet" type="button">Choose spreadsheet…</button>
        <p class="path">${props.sheetPath ? escapeHtml(props.sheetPath) : 'No spreadsheet chosen yet.'}</p>
        <p class="muted">
          Don't have a spreadsheet yet?
          <button id="save-starter-kit" type="button" ${props.starterKitSaving ? 'disabled' : ''}>
            ${props.starterKitSaving ? 'Saving…' : 'Save a template and sample file…'}
          </button>
        </p>
        ${props.starterKitMessage ? `<p class="note">${escapeHtml(props.starterKitMessage)}</p>` : ''}
      </fieldset>

      <fieldset>
        <legend>3. Files folder</legend>
        <button id="choose-folder" type="button">Choose files folder…</button>
        <p class="path">${props.folderPath ? escapeHtml(props.folderPath) : 'No folder chosen yet.'}</p>
      </fieldset>

      ${props.error ? `<p class="error" role="alert">${escapeHtml(props.error)}</p>` : ''}
      ${props.readyMessage ? `<p class="note">${escapeHtml(props.readyMessage)}</p>` : ''}

      <div class="button-row">
        <button id="choose-continue-btn" type="button" ${canContinueChoose(props) ? '' : 'disabled'}>
          Continue
        </button>
      </div>
    </section>
  `;

  root.querySelector<HTMLInputElement>('#collection-filter')?.addEventListener('input', (e) => {
    props.onQueryChange((e.target as HTMLInputElement).value);
  });
  root.querySelector<HTMLSelectElement>('#collection-select')?.addEventListener('change', (e) => {
    props.onSelectCollection((e.target as HTMLSelectElement).value);
  });
  root
    .querySelector<HTMLButtonElement>('#choose-sheet')
    ?.addEventListener('click', () => props.onChooseSpreadsheet());
  root
    .querySelector<HTMLButtonElement>('#save-starter-kit')
    ?.addEventListener('click', () => props.onSaveStarterKit());
  root
    .querySelector<HTMLButtonElement>('#choose-folder')
    ?.addEventListener('click', () => props.onChooseFolder());
  root
    .querySelector<HTMLButtonElement>('#choose-continue-btn')
    ?.addEventListener('click', () => props.onContinue());
}
