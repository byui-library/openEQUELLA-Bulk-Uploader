/**
 * Pure screen-routing logic for the renderer's app shell.
 *
 * Kept separate from app.ts (which does the actual DOM work and window.oeq
 * calls) so the transition rules -- what screen follows what event -- can be
 * unit tested without booting Electron or touching the DOM. Task 7 only
 * wires up setup, signin and choose; 'choose' is a terminal state here until
 * Task 8 adds review/confirm/progress/results.
 */
export type Screen = 'setup' | 'signin' | 'choose';

/** On launch: no saved credentials means first run. */
export function initialScreen(hasSettings: boolean): Screen {
  return hasSettings ? 'signin' : 'setup';
}

export type ScreenEvent =
  | { type: 'settingsSaved' }
  | { type: 'signedIn' }
  | { type: 'signedOut' }
  | { type: 'editSettings' };

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
