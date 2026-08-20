import type { CollectionSummary } from '../../../core/client.js';
import { filterCollections } from '../filter.js';
import { canContinueChoose } from '../state.js';
import { escapeHtml, keepCaret } from '../dom.js';

export interface ChooseProps {
  /**
   * The operator's own name for the site this batch is going to, for the
   * settings link. Named for the same reason Sign-in names it: a link that
   * says only "Settings" leaves an operator guessing which site it will open
   * and what it will cost them.
   */
  instanceLabel: string;
  /** null while listCollections() is in flight. */
  collections: CollectionSummary[] | null;
  collectionsError: string | null;
  /**
   * The server said collections exist for this account and returned none of
   * them -- which means the session is not signed in, not that there are none.
   * See core/discovery.ts's `CollectionList.withheld`.
   */
  collectionsWithheld: boolean;
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
  onExtract(): void;
  /**
   * Back to Setup for this site, clearing nothing.
   *
   * REPORTED BY THE OPERATOR: "There isn't a way to go back to setup once you
   * are on the main screen where you select a collection." It was circular,
   * not merely inconvenient -- Setup names a suggested attachment path only
   * once a collection is chosen, because that is when its schema can be read,
   * and the collection is chosen HERE. The guidance was reachable only from
   * the screen the operator had to leave to produce it.
   *
   * Must be wired to the NON-DESTRUCTIVE route (app.ts's handleSiteSettings),
   * never to "Clear all credentials…", which wipes every saved site.
   */
  onSiteSettings(): void;
  /**
   * End this site's session and go back to Sign-in, which is where a different
   * site is chosen.
   *
   * THE BANNER'S MISSING HALF. The red bar at the top of every screen exists to
   * tell the operator which site they are pointed at, because a collection uuid
   * can be byte-identical on two of them and there is no undo. An operator who
   * read it, realised it was the wrong one and wanted to move had no route
   * short of restarting the app -- a safety cue with no corresponding action is
   * half a safety feature.
   *
   * Wired to app.ts's `handleSignOut`, the SAME handler Sign-in's own Sign out
   * uses: it ends the openEQUELLA session on the server and says so when the
   * site would not confirm it (ui/signout.ts). A second sign-out path that only
   * changed screen would leave a live session behind on a shared machine.
   *
   * Safe here because Choose is pre-run. It is deliberately absent from
   * Progress, where ending the session the runner is uploading through would
   * strand a half-created batch.
   */
  onSignOut(): void;
}

/**
 * What the collection section says when the server withheld the whole list.
 *
 * REPORTED BY THE OPERATOR, live. This screen showed "showing 0 of 0 -- No
 * collections match" for a session that was not signed in, which is
 * indistinguishable from an account that genuinely has no collections --
 * and nothing anywhere on the screen said they were not signed in.
 * openEQUELLA does not refuse an unauthenticated request; it answers 200 with
 * the true count and none of the rows.
 *
 * Exported as a string so it can be asserted on without a DOM (this project
 * has no jsdom), the same way the other screens' copy is.
 */
export const WITHHELD_COLLECTIONS_MESSAGE =
  'You are signed in as guest — these collections exist, but this session cannot see them. ' +
  'That means the sign-in did not take, not that you have no collections. Go back and sign in ' +
  'again, or check this site’s sign-in details in Setup.';

/**
 * Collection dropdown + spreadsheet/folder pickers. `listCollections`
 * returns 29 collections on production, unsorted, with entries like "Sample"
 * ahead of anything a real user wants -- filterCollections (ui/filter.ts,
 * unit tested) sorts by name and supports a live filter so the list is
 * usable rather than a wall of options to scroll through.
 */
/**
 * The collection half of the screen, as markup.
 *
 * Pulled out as a pure function so its states can be asserted without a DOM
 * -- this project has no jsdom, so `renderChoose` itself cannot be exercised
 * by a test at all, and "which state is this list actually in" is precisely
 * what shipped wrong. Same reasoning as `bannerClass` (ui/banner.ts) and
 * `setupMarkup` (screens/setup.ts).
 */
export function chooseCollectionSection(props: ChooseProps): string {
  if (props.collectionsError) {
    return `<p class="error" role="alert">${escapeHtml(props.collectionsError)}</p>`;
  }
  // BEFORE the empty-list branch below, and never rendered as a filter result:
  // an empty dropdown here would be the same silence that shipped.
  if (props.collectionsWithheld) {
    return `<p class="error" role="alert">${escapeHtml(WITHHELD_COLLECTIONS_MESSAGE)}</p>`;
  }
  if (props.collections === null) {
    return `<p class="muted">Loading collections…</p>`;
  }
  const filtered = filterCollections(props.collections, props.query);
  const rows = filtered
    .map(
      (c) =>
        `<option value="${escapeHtml(c.uuid)}"${c.uuid === props.collectionUuid ? ' selected' : ''}>${escapeHtml(c.name)}</option>`,
    )
    .join('');
  return `
      <label for="collection-filter">Filter</label>
      <input id="collection-filter" type="text" placeholder="Type to filter…" value="${escapeHtml(props.query)}" autocomplete="off" />
      <label for="collection-select">Collection (showing ${filtered.length} of ${props.collections.length})</label>
      <select id="collection-select" size="8">
        ${rows || '<option disabled>No collections match.</option>'}
      </select>
    `;
}

export function renderChoose(root: HTMLElement, props: ChooseProps): void {
  const collectionSection = chooseCollectionSection(props);

  const restoreCaret = keepCaret(root, '#collection-filter');

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
        <button id="choose-extract" type="button">I don't have a spreadsheet yet&hellip;</button>
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

      <p class="reset-row">
        <button id="choose-site-settings" type="button" class="link-button">
          Site settings for ${escapeHtml(props.instanceLabel)}…
        </button>
        <button id="choose-sign-out" type="button" class="link-button">
          Sign out of ${escapeHtml(props.instanceLabel)}…
        </button>
      </p>
      <p class="hint">
        Site settings: change the attachment ID field, the address or the sign-in details
        for this site. Your collection, spreadsheet and folder are kept.
      </p>
      <p class="hint">
        Sign out: end this session and go back to the sign-in screen, where you can pick a
        different site. Nothing has been uploaded yet, and you will choose the collection,
        spreadsheet and folder again.
      </p>
    </section>
  `;

  root.querySelector<HTMLInputElement>('#collection-filter')?.addEventListener('input', (e) => {
    props.onQueryChange((e.target as HTMLInputElement).value);
  });
  // Same as the Confirm screen: filtering re-renders, which recreated this
  // box and dropped focus after each character.
  restoreCaret();

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
  root.querySelector<HTMLButtonElement>('#choose-extract')?.addEventListener('click', props.onExtract);
  root
    .querySelector<HTMLButtonElement>('#choose-site-settings')
    ?.addEventListener('click', () => props.onSiteSettings());
  root.querySelector<HTMLButtonElement>('#choose-sign-out')?.addEventListener('click', () => props.onSignOut());
}
