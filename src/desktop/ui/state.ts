/**
 * Pure screen-routing logic for the renderer's app shell.
 *
 * Kept separate from app.ts (which does the actual DOM work and window.oeq
 * calls) so the transition rules -- what screen follows what event -- can be
 * unit tested without booting Electron or touching the DOM.
 */
export type Screen = 'setup' | 'signin' | 'choose' | 'review' | 'confirm' | 'progress' | 'results';

/** On launch: no saved credentials means first run. */
export function initialScreen(hasSettings: boolean): Screen {
  return hasSettings ? 'signin' : 'setup';
}

export type ScreenEvent =
  /**
   * `returnTo` is where the operator was when they left for Setup, when that
   * is somewhere worth putting them back. Only Choose is ever passed today --
   * see `settingsReturnTo`, which is the one place that decides it.
   */
  | { type: 'settingsSaved'; returnTo?: Screen }
  | { type: 'signedIn' }
  | { type: 'signedOut' }
  | { type: 'editSettings' }
  | { type: 'addCredentials' }
  /** A task screen's "Site settings…" link -- Setup for the selected site, clearing nothing. */
  | { type: 'siteSettings' }
  | { type: 'planChecked' }
  | { type: 'reviewApproved' }
  | { type: 'uploadStarted' }
  | { type: 'runFinished' }
  | { type: 'retryStarted' }
  /** Done -> Choose, to upload another spreadsheet without restarting the app. */
  | { type: 'anotherBatch' };

export function nextScreen(current: Screen, event: ScreenEvent): Screen {
  switch (event.type) {
    // Sign-in unless the operator came in from a screen worth returning them
    // to. They may have been mid-batch with a collection, a spreadsheet and a
    // folder already picked; sending them back through Sign-in to change one
    // setting is the friction that makes people skip the setting instead.
    case 'settingsSaved':
      return event.returnTo ?? 'signin';
    case 'signedIn':
      return 'choose';
    case 'signedOut':
      // However the user got here (Choose or Sign-in itself), signing out
      // always lands back on Sign-in -- never Setup, since the credentials
      // themselves are still valid and don't need re-entering.
      return 'signin';
    case 'editSettings':
      return 'setup';
    // Distinct from 'editSettings': this is the Sign-in screen's per-instance
    // "add credentials" prompt (see ui/signin.ts's signinMode), reached when
    // the selected instance has never been configured. It goes to the same
    // Setup screen but -- unlike 'editSettings' (the "Reset settings"
    // action) -- app.ts does NOT clear anything before firing it; the OTHER
    // instance's saved credentials, if any, must survive untouched.
    case 'addCredentials':
      return 'setup';
    // A THIRD route to Setup, and deliberately not a second origin for
    // 'addCredentials'. That one is Sign-in's "this site has no credentials
    // at all" prompt; an operator clicking "Site settings…" from Choose has
    // credentials, has a collection selected, and is adding nothing. Reusing
    // the event would leave this table -- the record of how the app moves --
    // describing the move as something it is not.
    //
    // Clearing nothing is what separates it from 'editSettings', which app.ts
    // fires only after wiping every saved site. Firing THAT from a task screen
    // is the mistake this event exists to make impossible to reach for by
    // accident.
    case 'siteSettings':
      return 'setup';
    // 'planChecked' deliberately does NOT change screen -- a successful
    // plan() from Review reveals the warnings/entry-count on the SAME
    // screen (spec: "Nothing uploads from this screen") so the user has a
    // real chance to read them before a second, separate click
    // ('reviewApproved') moves on. See handleReviewContinue in app.ts.
    case 'planChecked':
      return current;
    case 'reviewApproved':
      return 'confirm';
    case 'uploadStarted':
      return 'progress';
    case 'runFinished':
      return 'results';
    case 'retryStarted':
      return 'progress';
    // Back to Choose, not Sign-in: the credentials and the session are still
    // good, and the collection stays selected. Only the batch is finished.
    case 'anotherBatch':
      return 'choose';
    default:
      return current;
  }
}

/**
 * Where saving Setup should put the operator back, or undefined for the
 * default (Sign-in).
 *
 * Choose only, and only when the save landed on the very site the rest of the
 * app is pointed at. Setup can be aimed somewhere else while it is open --
 * its own instance dropdown, or simply editing the address, since the id is
 * derived from the address in the main process -- and returning to Choose
 * then would show a collection list, a selection and a spreadsheet belonging
 * to a site the app is no longer configured for. Sign-in is the honest
 * landing place for that: it is where the site is chosen.
 */
export function settingsReturnTo(args: {
  enteredFrom: Screen | null;
  savedInstanceId: string;
  activeInstanceId: string;
}): Screen | undefined {
  if (args.enteredFrom !== 'choose') return undefined;
  if (args.savedInstanceId !== args.activeInstanceId) return undefined;
  return 'choose';
}

/** What the Choose screen requires before Continue is enabled. */
export interface ChooseSelection {
  collectionUuid: string | null;
  sheetPath: string | null;
  folderPath: string | null;
}

export function canContinueChoose(s: ChooseSelection): boolean {
  return Boolean(s.collectionUuid && s.sheetPath && s.folderPath);
}
