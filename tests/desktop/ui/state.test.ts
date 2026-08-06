import { describe, it, expect } from 'vitest';
import { initialScreen, nextScreen, canContinueChoose } from '../../../src/desktop/ui/state.js';

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
