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
  | { type: 'settingsSaved' }
  | { type: 'signedIn' }
  | { type: 'signedOut' }
  | { type: 'editSettings' }
  | { type: 'addCredentials' }
  | { type: 'planChecked' }
  | { type: 'reviewApproved' }
  | { type: 'uploadStarted' }
  | { type: 'runFinished' }
  | { type: 'retryStarted' };

export function nextScreen(current: Screen, event: ScreenEvent): Screen {
  switch (event.type) {
    case 'settingsSaved':
      return 'signin';
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
    default:
      return current;
  }
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
