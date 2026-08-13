import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeDom, type FakeElement } from '../../helpers/fakeDom.js';
import type { InstanceChoice } from '../../../src/desktop/ipc.js';

/**
 * The route from Choose back to Setup, driven through app.ts itself.
 *
 * REPORTED BY THE OPERATOR while installing the tool: "There isn't a way to go
 * back to setup once you are on the main screen where you select a
 * collection." It was circular -- Setup names a suggested attachment path only
 * once a collection is chosen (that is when a schema can be read), and the
 * collection is chosen on Choose, which had no route back.
 *
 * WHY THIS TEST EXISTS AT THE APP LEVEL AND NOT AS MARKUP. There are two ways
 * into Setup and only one of them is safe here: `handleSiteSettings` clears
 * nothing, while `handleResetSettings` -- offered a few pixels away on Sign-in
 * as "Change credentials…" -- wipes every saved site, blanks the form and
 * un-selects the instance. Which of the two a link is wired to is invisible to
 * a markup assertion, and it is the whole difference between "change one
 * setting" and "lose your credentials". Nothing in this repo had ever
 * exercised app.ts's wiring before; every screen test asserts the string a
 * renderer returns (tests/helpers/fakeDom.ts explains the stand-in DOM).
 */

const SITE: InstanceChoice = {
  id: 'library-example-test',
  label: 'Library',
  baseUrl: 'https://library.example.test',
  authMode: 'password',
  attachmentUuidPath: '',
  live: false,
  schemaUuid: 'schema-1',
};

const COLLECTIONS = [
  { uuid: 'coll-1', name: 'Faculty Content', schemaUuid: 'schema-1' },
  { uuid: 'coll-2', name: 'Theses', schemaUuid: 'schema-1' },
];

interface Harness {
  app: FakeElement;
  calls: {
    clearSettings: number;
    confirm: number;
    saveInstance: number;
    /** Every instance id `window.oeq.signOut` was called with, in order. */
    signOut: string[];
  };
  /** Lets run() resolve, when the harness was booted holding it open. */
  finishRun(): void;
}

let harness: Harness;

/** Let every pending promise chain a handler kicked off actually settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const PLAN = {
  manifestPath: 'C:\\batch\\manifest.json',
  entryCount: 2,
  columns: [],
  invalidHeaders: [],
  warnings: [],
  duplicates: [],
};

const RUN = { created: 2, failed: 0, skipped: 0, incomplete: 0, interrupted: 0, failures: [] };

interface BootOptions {
  /** Overrides for the one saved site. */
  site?: Partial<InstanceChoice>;
  /** No saved site at all -- first run, which lands on Setup. */
  fresh?: boolean;
  /** What signOut reports back. Defaults to one session, cleanly ended. */
  signOutReport?: { sessions: number; unconfirmed: number };
  /** Leave run() unresolved, so the app stays on the Progress screen. */
  holdRun?: boolean;
}

/**
 * Boot app.ts against a stand-in DOM and a stand-in bridge, with one saved
 * site whose credentials are already stored and a session already signed in --
 * the state an operator installing the tool is actually in.
 */
async function boot(options: BootOptions = {}): Promise<Harness> {
  const dom = fakeDom();
  const calls = { clearSettings: 0, confirm: 0, saveInstance: 0, signOut: [] as string[] };
  let stored: InstanceChoice = { ...SITE, ...options.site };
  let releaseRun: () => void = () => {};

  const USER = {
    id: 'u1',
    username: 'a.operator',
    firstName: 'A',
    lastName: 'Operator',
    guest: false,
  };

  const oeq = {
    onProgress: () => {},
    listInstances: async () => (options.fresh === true ? [] : [stored]),
    credentialsDropped: async () => false,
    hasSettings: async () => true,
    currentUser: async () => USER,
    signIn: async () => USER,
    listCollections: async () => ({ collections: COLLECTIONS, withheld: false }),
    fetchSchema: async () => ({ uuid: 'schema-1', name: 'Schema', paths: ['MWDL/title'] }),
    getPassword: async () => ({ username: 'a.operator' }),
    chooseSpreadsheet: async () => 'C:\\batch\\upload.csv',
    chooseFolder: async () => 'C:\\batch\\files',
    clearSettings: async () => {
      calls.clearSettings += 1;
    },
    saveInstance: async (instance: { label: string; baseUrl: string }) => {
      calls.saveInstance += 1;
      stored = { ...stored, ...instance };
      return stored;
    },
    signOut: async (instanceId: string) => {
      calls.signOut.push(instanceId);
      return options.signOutReport ?? { sessions: 1, unconfirmed: 0 };
    },
    // Enough of the upload path to reach the Done screen, which is the other
    // dead end this change closes.
    validate: async () => [{ header: 'MWDL/title', valid: true, suggestions: [] }],
    plan: async () => PLAN,
    applyDuplicateChoices: async () => 0,
    run: async () =>
      options.holdRun === true
        ? new Promise((resolve) => {
            releaseRun = () => resolve(RUN);
          })
        : RUN,
    retryFailed: async () => {},
    loadManifest: async () => ({ entries: [] }),
  };

  const globals = globalThis as unknown as Record<string, unknown>;
  globals['document'] = dom.document;
  globals['window'] = {
    oeq,
    confirm: () => {
      calls.confirm += 1;
      return true;
    },
  };

  vi.resetModules();
  await import('../../../src/desktop/ui/app.js');
  await flush();
  return { app: dom.app, calls, finishRun: () => releaseRun() };
}

/** Sign-in -> Choose, with a collection, a spreadsheet and a folder picked. */
async function reachChoose(app: FakeElement): Promise<void> {
  app.fire('#continue-btn');
  await flush();
  app.fire('#collection-select', 'change', { target: { value: 'coll-1' } });
  app.fire('#choose-sheet');
  await flush();
  app.fire('#choose-folder');
  await flush();
}

/** Choose -> Review -> Confirm -> Progress. A held run leaves it there. */
async function reachProgress(app: FakeElement): Promise<void> {
  await reachChoose(app);
  app.fire('#choose-continue-btn');
  await flush();
  app.fire('#review-continue-btn');
  await flush();
  app.fire('#confirm-upload-btn');
  await flush();
}

/** ...and on to the Done screen, with the run finished. */
async function reachResults(app: FakeElement): Promise<void> {
  await reachProgress(app);
  await flush();
}

beforeEach(async () => {
  harness = await boot();
});

afterEach(() => {
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals['document'];
  delete globals['window'];
});

describe('the harness itself', () => {
  it('starts on Sign-in with a saved, signed-in site', () => {
    expect(harness.app.innerHTML).toContain('Sign in');
    expect(harness.app.has('#continue-btn')).toBe(true);
  });

  it('reaches Choose with all three inputs picked', async () => {
    await reachChoose(harness.app);
    expect(harness.app.innerHTML).toContain('Choose what to upload');
    expect(harness.app.innerHTML).toContain('upload.csv');
    expect(harness.app.has('#choose-continue-btn')).toBe(true);
  });
});

describe('Choose -> Setup', () => {
  it('reaches Setup', async () => {
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();
    expect(harness.app.has('#setup-form')).toBe(true);
  });

  /**
   * THE POINT OF THE WHOLE CHANGE. Wire this link to `handleResetSettings`
   * instead and every assertion below fails: it confirms, calls
   * clearSettings(), empties the instance list and reseeds the form from
   * blank.
   */
  it('clears nothing on the way -- the destructive route stays separate', async () => {
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();

    expect(harness.calls.clearSettings).toBe(0);
    expect(harness.calls.confirm).toBe(0);
    // The form is seeded from the selected site, not blanked...
    expect(harness.app.innerHTML).toContain('value="https://library.example.test"');
    expect(harness.app.innerHTML).toContain('value="Library"');
    // ...the site is still in the dropdown and still selected...
    expect(harness.app.innerHTML).toContain(`value="${SITE.id}" selected`);
    // ...and the stored password is still there, so no credential was touched.
    expect(harness.app.innerHTML).toContain('a.operator');
  });

  it('offers the attachment field, which is what the operator came for', async () => {
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();
    expect(harness.app.has('#setup-attachment-path')).toBe(true);
  });
});

/**
 * Where saving lands. An operator who came from Choose had a collection, a
 * spreadsheet and a folder picked; making them walk in from Sign-in again to
 * change one setting is the friction that makes people skip the setting -- the
 * exact failure this thread is about.
 */
describe('Setup -> back where the operator came from', () => {
  it('returns to Choose with the collection, spreadsheet and folder intact', async () => {
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();

    harness.app.fire('#setup-form', 'submit');
    await flush();

    expect(harness.calls.saveInstance).toBe(1);
    expect(harness.app.innerHTML).toContain('Choose what to upload');
    expect(harness.app.innerHTML).toContain('value="coll-1" selected');
    expect(harness.app.innerHTML).toContain('upload.csv');
    expect(harness.app.innerHTML).toContain('C:\\batch\\files');
  });

  it('leaves the Sign-in route landing on Sign-in, as it always has', async () => {
    harness.app.fire('#site-settings-btn');
    await flush();
    expect(harness.app.has('#setup-form')).toBe(true);
    expect(harness.calls.clearSettings).toBe(0);

    harness.app.fire('#setup-form', 'submit');
    await flush();
    expect(harness.app.innerHTML).toContain('Sign in');
    expect(harness.app.innerHTML).not.toContain('Choose what to upload');
  });
});

/**
 * The destructive route must keep working, and keep being destructive: it is
 * the only way out of a mistyped address, and confirming it is what stops a
 * misplaced click from costing an administrator-issued secret.
 */
describe('Change credentials… (the destructive route)', () => {
  it('still confirms and still clears', async () => {
    harness.app.fire('#reset-settings-btn');
    await flush();
    expect(harness.calls.confirm).toBe(1);
    expect(harness.calls.clearSettings).toBe(1);
    expect(harness.app.has('#setup-form')).toBe(true);
    // Blanked, not seeded -- the opposite of the Choose route above.
    expect(harness.app.innerHTML).not.toContain('value="https://library.example.test"');
  });
});

/**
 * GAP 1, AND THE SERIOUS ONE. The red banner's entire purpose is to tell an
 * operator which site they are pointed at; an operator who reads it, realises
 * it is the wrong one, and wants to move had no route short of restarting the
 * app. `nextScreen('choose', signedOut)` already returned 'signin' and was
 * already tested -- nothing on the screen fired it, which made the transition a
 * claim the app did not honour.
 *
 * IT GOES THROUGH THE EXISTING HANDLER, not a second sign-out path. That one
 * ends the openEQUELLA session on the server for this site and reports honestly
 * when the site never confirmed it (ui/signout.ts). A "sign out" that only
 * changed screen would leave a live session behind on a shared machine.
 */
describe('Choose -> Sign-in', () => {
  it('signs out of the selected site and lands on Sign-in', async () => {
    await reachChoose(harness.app);
    harness.app.fire('#choose-sign-out');
    await flush();

    expect(harness.calls.signOut).toEqual([SITE.id]);
    expect(harness.app.innerHTML).toContain('Sign in');
    expect(harness.app.innerHTML).not.toContain('Choose what to upload');
  });

  it('destroys no credentials on the way -- this is not "Change credentials…"', async () => {
    await reachChoose(harness.app);
    harness.app.fire('#choose-sign-out');
    await flush();

    expect(harness.calls.clearSettings).toBe(0);
    expect(harness.calls.confirm).toBe(0);
    // The site is still saved, still selected, and can be signed into again.
    expect(harness.app.innerHTML).toContain(`value="${SITE.id}" selected`);
  });

  /**
   * PROOF IT IS THE EXISTING HANDLER AND NOT A LOOKALIKE. Only that one turns
   * `SessionEndReport.unconfirmed` into a sentence; a fresh sign-out path
   * written for this screen would show the same signed-out screen either way,
   * which is the exact defect ui/signout.ts exists to prevent.
   */
  it('carries the unconfirmed-logout notice through to Sign-in', async () => {
    harness = await boot({ signOutReport: { sessions: 1, unconfirmed: 1 } });
    await reachChoose(harness.app);
    harness.app.fire('#choose-sign-out');
    await flush();

    expect(harness.app.innerHTML).toContain('did not confirm');
  });

  // The operator arrives on a site they can pick again -- and the batch they
  // walked away from is not carried into the next one.
  it('starts the next batch clean when they sign back in', async () => {
    await reachChoose(harness.app);
    harness.app.fire('#choose-sign-out');
    await flush();
    harness.app.fire('#signin-btn');
    await flush();
    harness.app.fire('#continue-btn');
    await flush();

    expect(harness.app.innerHTML).toContain('Choose what to upload');
    expect(harness.app.innerHTML).toContain('No spreadsheet chosen yet');
    expect(harness.app.innerHTML).toContain('No folder chosen yet');
  });
});

/**
 * GAP 2. Setup's only control was "Save credentials", so an operator who opened
 * it from Choose to check one setting could leave only by saving.
 */
describe('Setup -> Back', () => {
  it('returns to Choose with the collection, spreadsheet and folder intact', async () => {
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();
    harness.app.fire('#setup-back');
    await flush();

    expect(harness.app.innerHTML).toContain('Choose what to upload');
    expect(harness.app.innerHTML).toContain('value="coll-1" selected');
    expect(harness.app.innerHTML).toContain('upload.csv');
    expect(harness.app.innerHTML).toContain('C:\\batch\\files');
  });

  // The whole point: it is not a save, and it is not the destructive route
  // either. Nothing is written and nothing is wiped.
  it('saves nothing and clears nothing', async () => {
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();
    harness.app.fire('#setup-back');
    await flush();

    expect(harness.calls.saveInstance).toBe(0);
    expect(harness.calls.clearSettings).toBe(0);
    expect(harness.calls.confirm).toBe(0);
    // ...and the stored password is untouched, so the site still signs in.
    harness.app.fire('#choose-site-settings');
    await flush();
    expect(harness.app.innerHTML).toContain('a.operator');
  });

  it('returns to Sign-in when that is where Setup was opened from', async () => {
    harness.app.fire('#site-settings-btn');
    await flush();
    harness.app.fire('#setup-back');
    await flush();

    expect(harness.app.innerHTML).toContain('Sign in');
    expect(harness.app.innerHTML).not.toContain('Choose what to upload');
    expect(harness.calls.saveInstance).toBe(0);
  });

  /**
   * NOT ON FIRST RUN. Setup is the launch screen when no site has been added,
   * and there is genuinely nothing behind it -- a Back there would either do
   * nothing or invent a destination.
   */
  it('is absent on first run, where Setup is the launch screen', async () => {
    harness = await boot({ fresh: true });
    expect(harness.app.has('#setup-form')).toBe(true);
    expect(harness.app.has('#setup-back')).toBe(false);
  });

  /**
   * ...and absent after "Change credentials…" too, which wipes every saved site
   * and puts the operator in the same position as a fresh install. Sending them
   * "back" to a Sign-in screen listing no sites would be a route to nowhere.
   */
  it('is absent after the destructive route, which leaves nothing behind either', async () => {
    harness.app.fire('#reset-settings-btn');
    await flush();
    expect(harness.app.has('#setup-form')).toBe(true);
    expect(harness.app.has('#setup-back')).toBe(false);
  });
});

/**
 * GAP 3. Done offered "Upload another spreadsheet", a link to the collection,
 * and nothing else -- so an operator who finished a batch and then wanted a
 * different site, or one setting changed, had to close and reopen the app.
 */
describe('Results -> everywhere else', () => {
  it('reaches Done through a real run first', async () => {
    await reachResults(harness.app);
    expect(harness.app.innerHTML).toContain('Done');
    expect(harness.app.has('#results-another-btn')).toBe(true);
  });

  it('signs out of the selected site and lands on Sign-in', async () => {
    await reachResults(harness.app);
    harness.app.fire('#results-sign-out');
    await flush();

    expect(harness.calls.signOut).toEqual([SITE.id]);
    expect(harness.app.innerHTML).toContain('Sign in');
  });

  it('reaches Setup, clearing nothing, and comes back to the summary', async () => {
    await reachResults(harness.app);
    harness.app.fire('#results-site-settings');
    await flush();

    expect(harness.app.has('#setup-form')).toBe(true);
    expect(harness.calls.clearSettings).toBe(0);
    expect(harness.calls.confirm).toBe(0);
    expect(harness.app.innerHTML).toContain('Back to the upload summary');

    harness.app.fire('#setup-back');
    await flush();
    expect(harness.app.innerHTML).toContain('Done');
    expect(harness.calls.saveInstance).toBe(0);
  });

  // Still the primary route, and still the one that keeps the collection.
  it('still uploads another spreadsheet', async () => {
    await reachResults(harness.app);
    harness.app.fire('#results-another-btn');
    await flush();
    expect(harness.app.innerHTML).toContain('Choose what to upload');
    expect(harness.app.innerHTML).toContain('value="coll-1" selected');
  });
});

/**
 * THE ONE SCREEN THAT MUST STAY A DEAD END. Signing out under a running batch
 * would end the openEQUELLA session the runner is uploading through, mid-file,
 * with items already created and no undo. Progress is between the two screens
 * that now carry the control, so this is where a uniformly-applied pattern
 * would do real damage.
 *
 * Driven with run() held open, which is the only moment the app is genuinely on
 * this screen.
 */
describe('Progress carries none of it', () => {
  it('offers no sign-out and no settings route while a run is in flight', async () => {
    harness = await boot({ holdRun: true });
    await reachProgress(harness.app);

    expect(harness.app.innerHTML).toContain('Uploading');
    expect(harness.app.has('#choose-sign-out')).toBe(false);
    expect(harness.app.has('#results-sign-out')).toBe(false);
    expect(harness.app.has('#choose-site-settings')).toBe(false);
    expect(harness.app.has('#results-site-settings')).toBe(false);
    expect(harness.calls.signOut).toEqual([]);

    harness.finishRun();
    await flush();
  });

  /**
   * Belt and braces behind the rendering rule above: the handler itself refuses
   * while a batch is running. Fired through the Choose button's OWN listener,
   * captured before the run started and invoked after -- which is what a stale
   * reference surviving a re-render, or a control added to this screen by
   * somebody applying the pattern uniformly, would amount to.
   */
  it('refuses a sign-out fired from a control that is no longer on screen', async () => {
    harness = await boot({ holdRun: true });
    await reachChoose(harness.app);
    const stale = harness.app.querySelector('#choose-sign-out');
    expect(stale).not.toBeNull();

    harness.app.fire('#choose-continue-btn');
    await flush();
    harness.app.fire('#review-continue-btn');
    await flush();
    harness.app.fire('#confirm-upload-btn');
    await flush();
    expect(harness.app.innerHTML).toContain('Uploading');

    for (const fn of stale!.listeners.get('click') ?? []) fn({ target: stale });
    await flush();

    expect(harness.calls.signOut).toEqual([]);
    expect(harness.app.innerHTML).toContain('Uploading');

    harness.finishRun();
    await flush();
  });
});
