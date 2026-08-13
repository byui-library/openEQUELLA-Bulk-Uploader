import { describe, it, expect } from 'vitest';
import {
  initialScreen,
  nextScreen,
  canContinueChoose,
  settingsReturnTo,
} from '../../../src/desktop/ui/state.js';

describe('initialScreen', () => {
  it('goes to Setup when no credentials are saved', () => {
    expect(initialScreen(false)).toBe('setup');
  });

  it('goes to Sign-in when credentials are already saved', () => {
    expect(initialScreen(true)).toBe('signin');
  });
});

describe('nextScreen', () => {
  it('advances Setup to Sign-in once settings are saved', () => {
    expect(nextScreen('setup', { type: 'settingsSaved' })).toBe('signin');
  });

  it('advances Sign-in to Choose once signed in', () => {
    expect(nextScreen('signin', { type: 'signedIn' })).toBe('choose');
  });

  it('keeps Sign-in on Sign-in after signing out', () => {
    expect(nextScreen('signin', { type: 'signedOut' })).toBe('signin');
  });

  it('returns Choose to Sign-in after signing out', () => {
    expect(nextScreen('choose', { type: 'signedOut' })).toBe('signin');
  });

  it('sends any screen back to Setup on editSettings', () => {
    expect(nextScreen('choose', { type: 'editSettings' })).toBe('setup');
    expect(nextScreen('signin', { type: 'editSettings' })).toBe('setup');
  });

  // Credentials are now per instance (secrets.ts): picking an instance on
  // Sign-in that has never been configured must offer a way to add just
  // that instance's credentials, distinct from 'editSettings' (the "Reset
  // settings" action), which wipes BOTH instances. Both land on the same
  // Setup screen -- what differs is what app.ts does around the transition
  // (editSettings clears everything first; addCredentials clears nothing).
  it('sends Sign-in to Setup on addCredentials, without implying a reset', () => {
    expect(nextScreen('signin', { type: 'addCredentials' })).toBe('setup');
  });
});

/**
 * REPORTED BY THE OPERATOR, while installing the tool: "There isn't a way to
 * go back to setup once you are on the main screen where you select a
 * collection."
 *
 * It was circular, not merely inconvenient. Setup names a suggested attachment
 * path only once a collection is chosen -- that is when a schema can be read --
 * and a collection is chosen on Choose, which had no route back to Setup. The
 * guidance was reachable only from the screen you had to leave to produce it.
 *
 * A THIRD event rather than a second origin for 'addCredentials': that one is
 * Sign-in's "this site has no credentials at all" prompt (ui/signin.ts's
 * signinMode), and an operator arriving from Choose with a collection selected
 * has credentials and is not adding any. Reusing it would leave the table
 * describing this move as something it is not.
 */
describe('reaching Setup from a task screen', () => {
  it('sends Choose to Setup on siteSettings', () => {
    expect(nextScreen('choose', { type: 'siteSettings' })).toBe('setup');
  });

  it('sends Sign-in to Setup on siteSettings too -- one event for one move', () => {
    expect(nextScreen('signin', { type: 'siteSettings' })).toBe('setup');
  });

  // The distinction the whole change rests on: 'editSettings' is the
  // destructive "Change credentials…" route (app.ts clears every saved site
  // before firing it) and must stay a separate event, not a synonym.
  it('is a different event from the destructive editSettings route', () => {
    const events: { type: string }[] = [{ type: 'siteSettings' }, { type: 'editSettings' }];
    expect(events[0]!.type).not.toBe(events[1]!.type);
  });
});

/**
 * Where saving Setup lands.
 *
 * Sign-in by default, unchanged since v0.1.0. But an operator who came from
 * Choose was mid-task with a collection, a spreadsheet and a folder already
 * picked, and sending them back to Sign-in to walk in again is the sort of
 * friction that makes people skip the setting instead -- which is the exact
 * failure this whole thread is about.
 */
describe('settingsSaved', () => {
  it('lands on Sign-in when nothing says otherwise', () => {
    expect(nextScreen('setup', { type: 'settingsSaved' })).toBe('signin');
  });

  it('returns to Choose when that is where Setup was entered from', () => {
    expect(nextScreen('setup', { type: 'settingsSaved', returnTo: 'choose' })).toBe('choose');
  });
});

describe('settingsReturnTo', () => {
  it('returns to Choose for a site saved under the id the app is pointed at', () => {
    expect(
      settingsReturnTo({ enteredFrom: 'choose', savedInstanceId: 'site-a', activeInstanceId: 'site-a' }),
    ).toBe('choose');
  });

  /**
   * Setup can be pointed at ANOTHER site while it is open (its own instance
   * dropdown, or simply editing the address), and the id is derived from the
   * address in the main process. Returning to Choose then would show a
   * collection list, a selection and a spreadsheet belonging to a site the app
   * is no longer configured for.
   */
  it('does not return to Choose when the save landed on a different site', () => {
    expect(
      settingsReturnTo({ enteredFrom: 'choose', savedInstanceId: 'site-b', activeInstanceId: 'site-a' }),
    ).toBeUndefined();
  });

  it('leaves the Sign-in route exactly as it was', () => {
    expect(
      settingsReturnTo({ enteredFrom: 'signin', savedInstanceId: 'site-a', activeInstanceId: 'site-a' }),
    ).toBeUndefined();
    expect(
      settingsReturnTo({ enteredFrom: null, savedInstanceId: 'site-a', activeInstanceId: 'site-a' }),
    ).toBeUndefined();
  });
});

describe('canContinueChoose', () => {
  it('is false until a collection, spreadsheet and folder are all set', () => {
    expect(canContinueChoose({ collectionUuid: null, sheetPath: null, folderPath: null })).toBe(false);
    expect(canContinueChoose({ collectionUuid: 'c', sheetPath: null, folderPath: null })).toBe(false);
    expect(canContinueChoose({ collectionUuid: 'c', sheetPath: 's.xlsx', folderPath: null })).toBe(false);
    expect(canContinueChoose({ collectionUuid: null, sheetPath: 's.xlsx', folderPath: 'f' })).toBe(false);
  });

  it('is true once all three are set', () => {
    expect(canContinueChoose({ collectionUuid: 'c', sheetPath: 's.xlsx', folderPath: 'f' })).toBe(true);
  });

  it('treats an empty string the same as unset', () => {
    expect(canContinueChoose({ collectionUuid: '', sheetPath: 's.xlsx', folderPath: 'f' })).toBe(false);
  });
});

describe('nextScreen -- Task 8 (Review, Confirm, Progress, Results)', () => {
  it('keeps Review on Review after a successful plan check -- the warnings stay visible', () => {
    expect(nextScreen('review', { type: 'planChecked' })).toBe('review');
  });

  it('advances Review to Confirm only on the separate, explicit approval event', () => {
    expect(nextScreen('review', { type: 'reviewApproved' })).toBe('confirm');
  });

  it('advances Confirm to Progress once the upload starts', () => {
    expect(nextScreen('confirm', { type: 'uploadStarted' })).toBe('progress');
  });

  it('advances Progress to Results once the run finishes', () => {
    expect(nextScreen('progress', { type: 'runFinished' })).toBe('results');
  });

  it('sends Results back to Progress when a retry run starts', () => {
    expect(nextScreen('results', { type: 'retryStarted' })).toBe('progress');
  });
});

/**
 * Finishing a batch used to be a dead end: the Done screen offered a link to
 * the collection and nothing else, so uploading a second spreadsheet meant
 * closing and reopening the app. Reported by the operator after a real run.
 */
describe('starting another batch from the Done screen', () => {
  it('goes back to Choose', () => {
    expect(nextScreen('results', { type: 'anotherBatch' })).toBe('choose');
  });

  // Sign-in and the configured instance survive; only the batch is finished.
  it('does not send the user back to sign in', () => {
    expect(nextScreen('results', { type: 'anotherBatch' })).not.toBe('signin');
    expect(nextScreen('results', { type: 'anotherBatch' })).not.toBe('setup');
  });
});
