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
 * as "Clear all credentials…" -- wipes every saved site, blanks the form and
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
  collectionUuid: '',
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
    /** What `window.confirm` was last asked. A count cannot see a warning
     *  that understates what it is warning about. */
    confirmedWith: string | null;
    saveInstance: number;
    savedInstance: Record<string, unknown> | null;
    /** Every instance id `window.oeq.forgetOAuth` was called with, in order. */
    forgetOAuth: string[];
    /** Every instance id `window.oeq.signIn` was called with, in order.
     *  Setup edits `setupInstanceId`, which is NOT the action flow's
     *  `instanceId` -- signing in to the wrong site would be silent. */
    signIn: string[];
    /** Every instance id the collection list was asked for, in order. */
    listCollections: string[];
    /** Every endpoint `window.oeq.listModels` was asked about, in order. */
    listModels: { baseUrl: string; apiKey: string }[];
    /** Every instance id `window.oeq.signOut` was called with, in order. */
    signOut: string[];
    /**
     * Every endpoint `window.oeq.setModel` was actually handed, in order.
     *
     * A COUNT WOULD NOT DO. The question these tests ask is what reached the
     * store, and the defect they pin is a save that reported success while
     * storing something other than what the operator typed -- or nothing at all.
     */
    modelSaves: { baseUrl: string; model: string; budget: number }[];
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
  /** The model endpoint stored for the site. Defaults to none, the shipped state. */
  model?: {
    baseUrl: string;
    model: string;
    budget: number;
    cap: number;
    timeoutMs: number;
    hasApiKey: boolean;
  } | null;
  /** Make storing the model endpoint reject, as a mistyped cap does. */
  setModelFails?: boolean;
  /** Leave run() unresolved, so the app stays on the Progress screen. */
  holdRun?: boolean;
  /**
   * What the chosen collection's schema declares. Defaults to a schema with no
   * attachment field at all, so nothing is filled in unless a test asks for it.
   */
  schemaPaths?: string[];
  /** What `getPassword` reports for the site. `null` means no password is
   *  stored, which is the real state of a site that signs in with OAuth. */
  storedPassword?: { username: string } | null;
  /** The OAuth credential stored for the site, minus the secret. */
  storedOAuth?: { clientId: string; redirectUri: string; hasSecret: boolean } | null;
  /** Where this build keeps its settings. Defaults to a packaged install. */
  storage?: { path: string; appName: string; packaged: boolean };
  /** Whether a usable OAuth token is stored for the site. Only a code-mode
   *  site can lack one; password mode signs in on every call. */
  hasToken?: boolean;
  /**
   * A SECOND saved site, so Setup can be pointed somewhere other than the site
   * the action flow is using. With one site those two ids are equal and a test
   * cannot tell them apart -- a mutation that signed in to the wrong one passed
   * every assertion until this existed.
   */
  secondSite?: InstanceChoice;
  /** Make the collection list fail, as a refused token or a server fault does. */
  listCollectionsFails?: string;
  /** What `currentUser` reports. `null` means no usable session -- which is
   *  what a REFUSED token looks like, and what a server fault does not. */
  signedIn?: boolean;
  /** Make the sign-in reject, as a closed window or a timeout does. */
  signInFails?: string;
  /** What the model endpoint reports it can run. */
  models?: string[];
  /** Make the ask fail, as an endpoint without a model list does. */
  modelsError?: string;
  /** Make the schema read fail, which leaves the path unchecked. */
  schemaUnreadable?: boolean;
}

/**
 * Boot app.ts against a stand-in DOM and a stand-in bridge, with one saved
 * site whose credentials are already stored and a session already signed in --
 * the state an operator installing the tool is actually in.
 */
async function boot(options: BootOptions = {}): Promise<Harness> {
  const dom = fakeDom();
  const calls = {
    clearSettings: 0,
    confirm: 0,
    confirmedWith: null as string | null,
    saveInstance: 0,
    savedInstance: null as Record<string, unknown> | null,
    signOut: [] as string[],
    forgetOAuth: [] as string[],
    listCollections: [] as string[],
    signIn: [] as string[],
    listModels: [] as { baseUrl: string; apiKey: string }[],
    modelSaves: [] as Harness['calls']['modelSaves'],
  };
  let stored: InstanceChoice = { ...SITE, ...options.site };
  /** Sites signed in to during this run. See the `signIn` fake below. */
  const tokenHolders = new Set<string>();
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
    listInstances: async () =>
      options.fresh === true ? [] : [stored, ...(options.secondSite ? [options.secondSite] : [])],
    credentialsDropped: async () => false,
    hasSettings: async () => true,
    currentUser: async () => (options.signedIn === false ? null : USER),
    signIn: async (instanceId: string) => {
      calls.signIn.push(instanceId);
      if (options.signInFails !== undefined) throw new Error(options.signInFails);
      // A SUCCESSFUL SIGN-IN LEAVES A TOKEN. exchangeCode writes token.enc, so
      // hasToken starts answering true from here on. A fake that stayed false
      // would have forced the screen to clear its own notice by assumption
      // instead of re-asking -- which is the bug this whole plan is about.
      tokenHolders.add(instanceId);
      return USER;
    },
    listCollections: async (instanceId: string) => {
      calls.listCollections.push(instanceId);
      if (options.listCollectionsFails !== undefined) throw new Error(options.listCollectionsFails);
      return { collections: COLLECTIONS, withheld: false };
    },
    hasToken: async (instanceId: string) => (options.hasToken ?? true) || tokenHolders.has(instanceId),
    fetchSchema: async () => {
      if (options.schemaUnreadable === true) throw new Error('schema unreadable');
      return { uuid: 'schema-1', name: 'Schema', paths: options.schemaPaths ?? ['MWDL/title'] };
    },
    getPassword: async () =>
      options.storedPassword === undefined ? { username: 'a.operator' } : options.storedPassword,
    listModels: async (args: { baseUrl: string; apiKey: string }) => {
      calls.listModels.push({ baseUrl: args.baseUrl, apiKey: args.apiKey });
      if (options.modelsError !== undefined) throw new Error(options.modelsError);
      return options.models ?? [];
    },
    getOAuth: async () => (options.storedOAuth === undefined ? null : options.storedOAuth),
    forgetOAuth: async (instanceId: string) => {
      calls.forgetOAuth.push(instanceId);
    },
    getStorageInfo: async () =>
      options.storage ?? {
        path: 'C:\Users\someone\AppData\Roaming\oeq-bulk-uploader',
        appName: 'oeq-bulk-uploader',
        packaged: true,
      },
    getModel: async () => options.model ?? null,
    setModel: async (args: { settings: { baseUrl: string; model: string; budget: number } }) => {
      if (options.setModelFails === true) {
        throw new Error('The model run limit must be zero or a positive number, but it was \'-1\'.');
      }
      calls.modelSaves.push(args.settings);
    },
    forgetModel: async () => {},
    chooseSpreadsheet: async () => 'C:\\batch\\upload.csv',
    chooseFolder: async () => 'C:\\batch\\files',
    clearSettings: async () => {
      calls.clearSettings += 1;
    },
    saveInstance: async (instance: Record<string, unknown>) => {
      calls.saveInstance += 1;
      // The WHOLE payload, not a count: what reached the store is the question
      // when a setting comes back missing.
      calls.savedInstance = instance;
      stored = { ...stored, ...(instance as Partial<InstanceChoice>) };
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
    confirm: (message?: string) => {
      calls.confirm += 1;
      calls.confirmedWith = message ?? null;
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
describe('Clear all credentials… (the destructive route)', () => {
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

  it('destroys no credentials on the way -- this is not "Clear all credentials…"', async () => {
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
   * ...and absent after "Clear all credentials…" too, which wipes every saved site
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
 * FILLING THE ATTACHMENT FIELD IN, asked for by the operator: "Is there a way
 * that we can have the system populate that field based on the schema, similar
 * to how we're able to get a list of collections? That way, the user doesn't
 * have to try to figure out what it is and put it in manually."
 *
 * DRIVEN THROUGH app.ts AND NOT THE SCREEN, because the whole risk is in the
 * TIMING rather than in the value. Filling on every render would make a
 * deliberately-cleared field impossible to keep clear -- clear it, the screen
 * re-renders on the next keystroke anywhere on it, and the path is back. That
 * is invisible to any assertion on `setupMarkup`, which is a pure function of
 * props and cannot show when it is called.
 */
describe('the attachment field, filled from the schema', () => {
  const ONE = ['MWDL/title', 'local/attachments/attachment'];

  /** The value attribute actually rendered into the attachment box. */
  function attachmentValue(app: FakeElement): string {
    const input = /<input[^>]*id="setup-attachment-path"[^>]*>/.exec(app.innerHTML)?.[0];
    expect(input).toBeDefined();
    return /value="([^"]*)"/.exec(input ?? '')?.[1] ?? '';
  }

  /** Choose -> Setup, with the collections listed and nothing chosen yet. */
  async function reachSetup(app: FakeElement): Promise<void> {
    await reachChoose(app);
    app.fire('#choose-site-settings');
    await flush();
  }

  async function chooseCollection(app: FakeElement): Promise<void> {
    app.fire('#setup-collection', 'change', { target: { value: 'coll-1' } });
    await flush();
  }

  it('fills the empty box in when the schema declares exactly one such field', async () => {
    harness = await boot({ schemaPaths: ONE });
    await reachSetup(harness.app);
    expect(attachmentValue(harness.app)).toBe('');

    await chooseCollection(harness.app);
    expect(attachmentValue(harness.app)).toBe('local/attachments/attachment');
  });

  it('says it filled it in, and where that came from', async () => {
    harness = await boot({ schemaPaths: ONE });
    await reachSetup(harness.app);
    await chooseCollection(harness.app);

    expect(harness.app.innerHTML).toContain('verdict--filled');
    expect(harness.app.innerHTML).toMatch(/filled in for you/i);
    expect(harness.app.innerHTML).toMatch(/change it or clear it/i);
  });

  // It is a form field, so it saves like one -- the operator does not have to
  // retype what was filled in for them.
  it('saves what was filled in', async () => {
    let saved = '';
    harness = await boot({ schemaPaths: ONE });
    await reachSetup(harness.app);
    await chooseCollection(harness.app);
    // Read back off the rendered form, which is what submit assembles from.
    saved = attachmentValue(harness.app);
    harness.app.fire('#setup-form', 'submit');
    await flush();
    expect(saved).toBe('local/attachments/attachment');
    expect(harness.calls.saveInstance).toBe(1);
  });

  /**
   * NEVER OVER WHAT THE OPERATOR TYPED. What they entered is the only evidence
   * on this screen about what their site really uses.
   */
  it('leaves a path the operator typed alone', async () => {
    harness = await boot({ schemaPaths: ONE });
    await reachSetup(harness.app);
    harness.app.fire('#setup-attachment-path', 'input', { target: { value: 'MWDL/mine' } });
    await flush();

    await chooseCollection(harness.app);
    expect(attachmentValue(harness.app)).toBe('MWDL/mine');
  });

  /**
   * THE BUG THIS FEATURE MOST EASILY BECOMES. An operator who clears the box
   * has said "record nothing", and every subsequent render must respect it --
   * including the renders caused by typing anywhere else on the screen.
   */
  it('stays cleared once the operator clears it', async () => {
    harness = await boot({ schemaPaths: ONE });
    await reachSetup(harness.app);
    await chooseCollection(harness.app);
    expect(attachmentValue(harness.app)).toBe('local/attachments/attachment');

    harness.app.fire('#setup-attachment-path', 'input', { target: { value: '' } });
    await flush();
    expect(attachmentValue(harness.app)).toBe('');

    // An unrelated re-render: a keystroke in the site's name.
    harness.app.fire('#setup-label', 'input', { target: { value: 'Library archive' } });
    await flush();
    expect(attachmentValue(harness.app)).toBe('');
    // ...and it is not still claiming to have filled anything in.
    expect(harness.app.innerHTML).not.toContain('verdict--filled');
  });

  /**
   * TWO CANDIDATES IS A CHOICE THAT BELONGS TO THE OPERATOR. Guessing between
   * them would be this tool inventing an institution's answer.
   */
  it('fills nothing when the schema declares several, and names them', async () => {
    harness = await boot({ schemaPaths: ['MWDL/title', 'a/attachment', 'b/attachments/attachment'] });
    await reachSetup(harness.app);
    await chooseCollection(harness.app);

    expect(attachmentValue(harness.app)).toBe('');
    expect(harness.app.innerHTML).toMatch(/more than one/i);
    expect(harness.app.innerHTML).toContain('a/attachment');
    expect(harness.app.innerHTML).toContain('b/attachments/attachment');
  });

  /**
   * NO CANDIDATE LEAVES IT BLANK and says why -- a fact about this schema, not
   * the reassurance about schemas in general the operator read as evasion.
   */
  it('fills nothing when the schema declares no such field, and says so', async () => {
    harness = await boot({ schemaPaths: ['MWDL/title', 'MWDL/description'] });
    await reachSetup(harness.app);
    await chooseCollection(harness.app);

    expect(attachmentValue(harness.app)).toBe('');
    expect(harness.app.innerHTML).toMatch(/declares no field/i);
    expect(harness.app.innerHTML).not.toMatch(/most schemas/i);
  });

  /**
   * A SCHEMA THAT COULD NOT BE READ FILLS NOTHING. Unread has never been
   * reported as clean here and must not start by writing a value.
   */
  it('fills nothing when the schema could not be read', async () => {
    harness = await boot({ schemaPaths: ONE, schemaUnreadable: true });
    await reachSetup(harness.app);
    await chooseCollection(harness.app);

    expect(attachmentValue(harness.app)).toBe('');
    expect(harness.app.innerHTML).toMatch(/not been checked/i);
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

/**
 * The optional model endpoint, driven through app.ts rather than asserted as
 * markup -- because both faults this covers are in the WIRING, and a markup
 * assertion cannot see either. One is a container that forgets it was opened;
 * the other is a screen reached by a route that never asked what was stored.
 */
describe('the model section on Setup', () => {
  const STORED = {
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3',
    budget: 4321,
    cap: 77,
    timeoutMs: 300_000,
    hasApiKey: false,
  };

  /**
   * THE `keepCaret` FAILURE CLASS, ARRIVING THROUGH THE CONTAINER.
   *
   * Setup re-renders by replacing `innerHTML` on every keystroke. With the
   * disclosure's `open` derived from what is STORED, an operator who expands
   * the section to configure their first endpoint loses it on the first
   * character they type: the fresh `<details>` has no `open`, the section snaps
   * shut, and `keepCaret`'s `focus()` lands on an element inside a closed
   * `<details>`, which is not focusable -- so the caret goes too.
   *
   * That is the whole of the path that turns the feature on, and it is the one
   * state in which nothing is stored. `#setup-advanced` does not have this
   * because its `open` comes from `authMode`, which is app state and does not
   * change while typing.
   */
  it('stays open once the operator opens it, through every keystroke', async () => {
    const { app } = await boot({ fresh: true });
    expect(app.innerHTML).toMatch(/<details id="setup-model"(?!\s+open)/);

    app.fire('#setup-model', 'toggle', { target: { open: true } });
    app.fire('#setup-model-base-url', 'input', { target: { value: 'h' } });
    await flush();

    expect(app.innerHTML).toMatch(/<details id="setup-model" open/);
    expect(app.innerHTML).toContain('value="h"');
  });

  /** And closes when they close it -- state, not a one-way latch. Deriving
   *  `open` from "something is stored" would spring it back open here. */
  it('stays closed once the operator closes it', async () => {
    const { app } = await boot({ model: STORED });
    app.fire('#site-settings-btn');
    await flush();
    expect(app.innerHTML).toMatch(/<details id="setup-model" open/);

    app.fire('#setup-model', 'toggle', { target: { open: false } });
    app.fire('#setup-label', 'input', { target: { value: 'Renamed' } });
    await flush();

    expect(app.innerHTML).toMatch(/<details id="setup-model"(?!\s+open)/);
  });

  /**
   * "Site settings for {site}…" exists precisely so a setting can be changed
   * without destroying credentials (CLAUDE.md). Reached that way with an
   * endpoint stored and nothing asking the store what it holds:
   *
   *  - the "Forget these model settings" button is not rendered at all, so the
   *    only route to it is switching the dropdown to another site and back,
   *    which nobody will find; and
   *  - the boxes hold the DEFAULTS, so an operator who corrects the address
   *    and saves silently resets their budget, cap and time limit. The raised
   *    time limit is the setting a slow local model needs, which is the whole
   *    reason that field is stored rather than fixed.
   */
  it.each([
    ['Site settings, from Choose', async (app: FakeElement) => {
      await reachChoose(app);
      app.fire('#choose-site-settings');
    }],
    ['Site settings, from Sign-in', async (app: FakeElement) => {
      app.fire('#site-settings-btn');
    }],
  ])('reads what is stored when Setup is reached by %s', async (_label, go) => {
    const { app } = await boot({ model: STORED });
    await go(app);
    await flush();

    expect(app.has('#setup-model-forget')).toBe(true);
    expect(app.innerHTML).toContain('llama3');
    // The stored numbers, not MODEL_FIELD_DEFAULTS. 300000ms shows as 300s.
    expect(app.innerHTML).toContain('value="4321"');
    expect(app.innerHTML).toContain('value="77"');
    expect(app.innerHTML).toContain('value="300"');
    expect(app.innerHTML).not.toContain('value="8000"');
  });

  /** First run lands straight on Setup without passing through the dropdown,
   *  so `init` has to ask as well. A site with an endpoint that reaches Setup
   *  this way is otherwise shown a blank, defaulted section. */
  it('reads what is stored when Setup is the launch screen', async () => {
    const { app } = await boot({ model: STORED, site: {}, fresh: false });
    // Sign-in is the launch screen with a saved site, so go to Setup the way
    // an operator with no credentials would.
    app.fire('#site-settings-btn');
    await flush();
    expect(app.has('#setup-model-forget')).toBe(true);
  });

  /** Nothing stored is the shipped state: no card, nothing to forget, and the
   *  section closed. */
  it('offers nothing to forget when no endpoint is stored', async () => {
    const { app } = await boot();
    app.fire('#site-settings-btn');
    await flush();
    expect(app.has('#setup-model-forget')).toBe(false);
    expect(app.innerHTML).toMatch(/<details id="setup-model"(?!\s+open)/);
  });
});

/**
 * ## Typed input must never be discarded in silence
 *
 * REPORTED BY HAND-TESTING. The operator expanded the model section, typed a
 * model name, left the address blank, and clicked Save credentials. The save
 * reported success. They navigated away, came back, and both boxes were empty.
 *
 * The mechanism was `modelFrom` answering `null` for a half-filled section --
 * the SAME `null` it answers for an untouched one -- so `app.ts` stored nothing
 * and ran the ordinary success path. A step that could not run, reported as
 * though it had, is this codebase's own recurring defect (CLAUDE.md: the
 * duplicate check, the identifier check, `guest: true`, the cookie jar).
 *
 * Asserted here rather than only against `modelEntryProblem`'s string, because
 * the failure was never the wording: it was that no wording reached a screen.
 */
describe('a half-filled model section', () => {
  /** Type into the model section without completing it. */
  async function typeHalf(app: FakeElement, over: Record<string, string>): Promise<void> {
    app.fire('#site-settings-btn');
    await flush();
    app.fire('#setup-model', 'toggle', { target: { open: true } });
    for (const [selector, value] of Object.entries(over)) {
      app.fire(selector, 'input', { target: { value } });
    }
    app.fire('#setup-form', 'submit');
    await flush();
  }

  it('refuses the save and names the box that is empty', async () => {
    const { app } = await boot();
    await typeHalf(app, { '#setup-model-name': 'llama3' });

    expect(app.innerHTML).toMatch(/nothing has been saved/i);
    expect(app.innerHTML).toContain('Model address');
  });

  it('names the model-name box when only the address was typed', async () => {
    const { app } = await boot();
    await typeHalf(app, { '#setup-model-base-url': 'http://localhost:11434/v1' });

    expect(app.innerHTML).toMatch(/nothing has been saved/i);
    expect(app.innerHTML).toContain('Model name at that address');
  });

  /** NOTHING IS WRITTEN. The old path stored the site and reported success;
   *  the correction is worthless if it only adds a sentence to that. */
  it('writes neither the site nor the model settings', async () => {
    const { app, calls } = await boot();
    await typeHalf(app, { '#setup-model-name': 'llama3' });

    expect(calls.saveInstance).toBe(0);
    expect(calls.modelSaves).toEqual([]);
  });

  /** And the typed value is still on screen, so the refusal costs a keystroke
   *  rather than the work. This is what "discarded in silence" cost. */
  it('leaves the operator on Setup with what they typed still in the box', async () => {
    const { app } = await boot();
    await typeHalf(app, { '#setup-model-name': 'llama3' });

    expect(app.has('#setup-form')).toBe(true);
    expect(app.innerHTML).toContain('value="llama3"');
  });

  /** The message names a field, and `<details>` can be closed over the field it
   *  names -- a refusal pointing at a box the operator cannot see reads as the
   *  app refusing for no reason. */
  it('opens the model section, so the box it names is visible', async () => {
    const { app } = await boot();
    app.fire('#site-settings-btn');
    await flush();
    app.fire('#setup-model', 'toggle', { target: { open: true } });
    app.fire('#setup-model-name', 'input', { target: { value: 'llama3' } });
    // Closed again, as an operator who tidied up before saving would leave it.
    app.fire('#setup-model', 'toggle', { target: { open: false } });
    app.fire('#setup-form', 'submit');
    await flush();

    expect(app.innerHTML).toMatch(/<details id="setup-model" open/);
  });

  /** A key with no endpoint is the same silent discard, and the key is the one
   *  box whose contents cannot be recovered by looking at the screen. */
  it('refuses a key typed with no address and no model name', async () => {
    const { app, calls } = await boot();
    await typeHalf(app, { '#setup-model-key': 'sk-typed' });

    expect(app.innerHTML).toMatch(/nothing has been saved/i);
    expect(calls.saveInstance).toBe(0);
    expect(app.innerHTML).toContain('value="sk-typed"');
  });

  /**
   * THE ZERO-PREREQUISITE CASE, AND THE ONE THIS CHANGE MOST EASILY BREAKS.
   * An operator who never touched the section must see no change whatsoever --
   * no prompt, no error, no mention of a model. The three numbers arrive
   * pre-filled, so a check that read them as intent would fire here.
   */
  it('says nothing, and saves normally, when the section was never touched', async () => {
    const { app, calls } = await boot();
    app.fire('#site-settings-btn');
    await flush();
    app.fire('#setup-form', 'submit');
    // SYNCHRONOUSLY, BEFORE THE SAVE CAN RESOLVE. A refusal renders and returns
    // with no await in front of it, so this is the one moment at which a message
    // that should not exist would be on screen -- after the flush below the
    // screen has moved on and its absence proves nothing.
    expect(app.innerHTML).not.toMatch(/nothing has been saved/i);
    expect(app.innerHTML).not.toMatch(/class="error"/);
    await flush();

    expect(calls.saveInstance).toBe(1);
    expect(calls.modelSaves).toEqual([]);
    // Left Setup, as an ordinary save does.
    expect(app.has('#setup-form')).toBe(false);
  });

  /** Both boxes filled in stores normally, which is the case the refusal must
   *  not have swallowed. */
  it('stores the endpoint when both boxes are filled in', async () => {
    const { app, calls } = await boot();
    app.fire('#site-settings-btn');
    await flush();
    app.fire('#setup-model', 'toggle', { target: { open: true } });
    app.fire('#setup-model-base-url', 'input', { target: { value: 'http://localhost:11434/v1' } });
    app.fire('#setup-model-name', 'input', { target: { value: 'llama3' } });
    app.fire('#setup-form', 'submit');
    await flush();

    expect(calls.modelSaves).toHaveLength(1);
    expect(calls.modelSaves[0]).toMatchObject({ baseUrl: 'http://localhost:11434/v1', model: 'llama3' });
    expect(app.has('#setup-form')).toBe(false);
  });
});

/**
 * The variant that would have been worse than the reported one: an endpoint is
 * already stored and the operator returns to Setup to change ONE number.
 *
 * If the address and model-name boxes came back BLANK, saving after changing
 * only the budget would hand `modelFrom` a half-filled section -- so with the
 * old code the endpoint was silently left stale, and with a naive fix it would
 * be refused with a message about boxes the operator was never shown filled.
 *
 * They do not come back blank: `refreshStoredModel` (app.ts) puts the stored
 * address, model name and all three numbers back into the form on every route
 * into Setup, and withholds only the key. These tests pin that, because the
 * refusal added above depends on it -- repopulation is what makes "the address
 * box is empty" mean the operator emptied it.
 */
describe('changing one number on a stored endpoint', () => {
  const STORED_ENDPOINT = {
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3',
    budget: 4321,
    cap: 77,
    timeoutMs: 300_000,
    hasApiKey: true,
  };

  it('shows the stored address and model name in the boxes, not blank ones', async () => {
    const { app } = await boot({ model: STORED_ENDPOINT });
    app.fire('#site-settings-btn');
    await flush();

    expect(app.innerHTML).toContain('value="http://localhost:11434/v1"');
    expect(app.innerHTML).toContain('value="llama3"');
  });

  /** The key is the exception, and stays the exception: a stored secret is
   *  never rendered back where it can be read off the screen. */
  it('still withholds the stored key', async () => {
    const { app } = await boot({ model: STORED_ENDPOINT });
    app.fire('#site-settings-btn');
    await flush();

    expect(app.innerHTML).not.toContain('sk-');
    expect(app.innerHTML).toMatch(/key is stored/i);
  });

  it('saves the changed number without disturbing the address or the model name', async () => {
    const { app, calls } = await boot({ model: STORED_ENDPOINT });
    app.fire('#site-settings-btn');
    await flush();
    app.fire('#setup-model-budget', 'input', { target: { value: '2000' } });
    app.fire('#setup-form', 'submit');
    await flush();

    expect(calls.modelSaves).toEqual([
      expect.objectContaining({
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3',
        budget: 2000,
        cap: 77,
        timeoutMs: 300_000,
      }),
    ]);
    // Nothing was refused, so Setup was left as an ordinary save leaves it.
    expect(app.has('#setup-form')).toBe(false);
  });

  /** Clearing the address on a stored endpoint is a deliberate act, and it is
   *  now answered rather than silently ignored -- the endpoint is neither
   *  updated nor removed, and the operator is told which box to fix. */
  it('refuses a save that empties the address of a stored endpoint', async () => {
    const { app, calls } = await boot({ model: STORED_ENDPOINT });
    app.fire('#site-settings-btn');
    await flush();
    app.fire('#setup-model-base-url', 'input', { target: { value: '' } });
    app.fire('#setup-form', 'submit');
    await flush();

    expect(app.innerHTML).toMatch(/nothing has been saved/i);
    expect(app.innerHTML).toContain('Model address');
    expect(calls.modelSaves).toEqual([]);
    expect(calls.saveInstance).toBe(0);
    // And Forget is still the only way to remove one.
    expect(app.has('#setup-model-forget')).toBe(true);
  });
});

/**
 * Saving the site and saving its model endpoint are two writes, and the second
 * can fail on its own.
 */
describe('when the site saves but the model settings do not', () => {
  /** Fill in enough of Setup to make `modelFrom` produce an endpoint. */
  function typeAnEndpoint(app: FakeElement): void {
    app.fire('#setup-model', 'toggle', { target: { open: true } });
    app.fire('#setup-model-base-url', 'input', { target: { value: 'https://api.openai.com/v1' } });
    app.fire('#setup-model-name', 'input', { target: { value: 'gpt-4o-mini' } });
  }

  /**
   * `saveInstance` COMMITS BEFORE `setModel` RUNS, so a rejection there is not
   * a failed save -- it is half a save. Reported as a total failure, the
   * operator read "nothing was saved" while a site that really did exist was
   * missing from the dropdown, and the form was still pointed at nothing.
   */
  it('says which half was saved, rather than reporting a total failure', async () => {
    const { app } = await boot({ setModelFails: true });
    app.fire('#site-settings-btn');
    await flush();
    typeAnEndpoint(app);
    app.fire('#setup-form', 'submit');
    await flush();

    expect(app.innerHTML).toMatch(/were saved/i);
    expect(app.innerHTML).toMatch(/model settings were not/i);
    // Core's own words about the setting at fault, carried through.
    expect(app.innerHTML).toMatch(/run limit/i);
  });

  /** Left on the screen the box is on, so the mistake can be corrected --
   *  not carried off to Choose as a success. */
  it('stays on Setup', async () => {
    const { app } = await boot({ setModelFails: true });
    app.fire('#site-settings-btn');
    await flush();
    typeAnEndpoint(app);
    app.fire('#setup-form', 'submit');
    await flush();

    expect(app.has('#setup-model-base-url')).toBe(true);
    expect(app.has('#setup-form')).toBe(true);
  });

  /** The site half really did commit, so the app's own picture of what exists
   *  has to catch up with the disk whatever happened to the second write. */
  it('still refreshes the saved-site list', async () => {
    const { app, calls } = await boot({ setModelFails: true });
    app.fire('#site-settings-btn');
    await flush();
    typeAnEndpoint(app);
    app.fire('#setup-form', 'submit');
    await flush();

    expect(calls.saveInstance).toBe(1);
    expect(app.innerHTML).toContain('Library');
  });

  /** The typed key is the one thing the operator cannot get back by looking at
   *  the screen. It is cleared only once it has actually reached the store. */
  it('keeps the typed key so the retry does not need it typed again', async () => {
    const { app } = await boot({ setModelFails: true });
    app.fire('#site-settings-btn');
    await flush();
    typeAnEndpoint(app);
    app.fire('#setup-model-key', 'input', { target: { value: 'sk-typed' } });
    app.fire('#setup-form', 'submit');
    await flush();

    expect(app.innerHTML).toContain('value="sk-typed"');
  });

  /** And the ordinary path is unchanged: both writes succeed, Setup is left. */
  it('leaves Setup as usual when both halves save', async () => {
    const { app } = await boot();
    app.fire('#site-settings-btn');
    await flush();
    typeAnEndpoint(app);
    app.fire('#setup-form', 'submit');
    await flush();

    expect(app.has('#setup-model-base-url')).toBe(false);
  });
});

/**
 * The one setting whose box and whose rule speak different units.
 *
 * Setup asks for SECONDS; `ProviderConfig.timeoutMs` and every guard behind it
 * work in milliseconds, and `modelFrom` multiplies before anything is checked.
 * Left to come back from the store, the refusal named a unit the operator was
 * never shown and quoted a number they never typed.
 */
describe('a mistyped time limit', () => {
  function typeAnEndpoint(app: FakeElement, seconds: string): void {
    app.fire('#setup-model', 'toggle', { target: { open: true } });
    app.fire('#setup-model-base-url', 'input', { target: { value: 'http://localhost:11434/v1' } });
    app.fire('#setup-model-name', 'input', { target: { value: 'llama3' } });
    app.fire('#setup-model-timeout', 'input', { target: { value: seconds } });
  }

  it('is refused in seconds, on the screen the box is on', async () => {
    const { app } = await boot();
    app.fire('#site-settings-btn');
    await flush();
    typeAnEndpoint(app, '5000000');
    app.fire('#setup-form', 'submit');
    await flush();

    expect(app.innerHTML).toMatch(/seconds/);
    expect(app.innerHTML).not.toMatch(/millisecond/i);
    // Never the converted number, which is what the old message quoted.
    expect(app.innerHTML).not.toContain('5000000000');
  });

  it('is refused for a blank box without ever showing the word NaN', async () => {
    const { app } = await boot();
    app.fire('#site-settings-btn');
    await flush();
    typeAnEndpoint(app, '   ');
    app.fire('#setup-form', 'submit');
    await flush();

    expect(app.innerHTML).toMatch(/seconds/);
    expect(app.innerHTML).not.toContain('NaN');
  });

  /** Nothing is written, so the site is not half-saved on the way to a message
   *  about a text box. */
  it('saves nothing at all', async () => {
    const { app, calls } = await boot();
    app.fire('#site-settings-btn');
    await flush();
    typeAnEndpoint(app, '0');
    app.fire('#setup-form', 'submit');
    await flush();

    expect(calls.saveInstance).toBe(0);
  });

  it('accepts an ordinary value and saves', async () => {
    const { app, calls } = await boot();
    app.fire('#site-settings-btn');
    await flush();
    typeAnEndpoint(app, '300');
    app.fire('#setup-form', 'submit');
    await flush();

    expect(calls.saveInstance).toBe(1);
  });
});

/**
 * THE SAME DEFECT, WEARING ANOTHER FACE, found while fixing the first one.
 *
 * The reported bug was typed input discarded on save. This one discards it a
 * beat later, on the one path that most needs it kept: `setModel` fails, the
 * screen says so and asks the operator to correct a setting -- and
 * `refreshStoredModel`, fired unconditionally after every save, then puts the
 * STORED address and model name back into the boxes. Nothing was written, so
 * what it restores is the OLD endpoint, replacing the correction in the very
 * fields the error message is pointing at.
 *
 * Reachable only with an endpoint already stored AND the write failing, which is
 * why the existing "keeps the typed key" test never saw it: that one boots with
 * nothing stored, so `refreshStoredModel` finds null and touches no field.
 */
describe('a failed model write with an endpoint already stored', () => {
  const OLD = {
    baseUrl: 'http://old.example.test/v1',
    model: 'old-model',
    budget: 4321,
    cap: 77,
    timeoutMs: 300_000,
    hasApiKey: false,
  };

  async function correctAndSave(): Promise<FakeElement> {
    const { app } = await boot({ setModelFails: true, model: OLD });
    app.fire('#site-settings-btn');
    await flush();
    app.fire('#setup-model-base-url', 'input', { target: { value: 'http://new.example.test/v1' } });
    app.fire('#setup-model-name', 'input', { target: { value: 'new-model' } });
    app.fire('#setup-form', 'submit');
    await flush();
    return app;
  }

  it('leaves the operator’s correction in the boxes', async () => {
    const app = await correctAndSave();
    expect(app.innerHTML).toContain('value="http://new.example.test/v1"');
    expect(app.innerHTML).toContain('value="new-model"');
  });

  it('does not restore the endpoint that is still on disk over it', async () => {
    const app = await correctAndSave();
    expect(app.innerHTML).not.toContain('value="http://old.example.test/v1"');
    expect(app.innerHTML).not.toContain('value="old-model"');
  });

  /** The card still describes what is actually stored, because that is what is
   *  actually stored -- the failed write changed nothing. */
  it('still describes the stored endpoint, and still offers to forget it', async () => {
    const app = await correctAndSave();
    expect(app.innerHTML).toContain('old-model');
    expect(app.has('#setup-model-forget')).toBe(true);
  });

  /** And the half-a-save message is unchanged: the site really did commit. */
  it('still says which half was saved', async () => {
    const app = await correctAndSave();
    expect(app.innerHTML).toMatch(/were saved/i);
    expect(app.innerHTML).toMatch(/model settings were not/i);
  });
});

/**
 * ## Setup must show how the site ACTUALLY signs in
 *
 * REPORTED BY THE OPERATOR, and it blocked the app entirely: they entered an
 * OAuth client ID and secret, saved, reopened Site settings, and both boxes
 * were empty with "Use OAuth client credentials" no longer selected. The app
 * meanwhile kept signing in with the stored OAuth client, and openEQUELLA
 * refused the token -- a 403 with an empty body, which is what a rejected
 * access token looks like and nothing else does.
 *
 * The cause: `Instance` carries `authMode` and it reaches the renderer, but
 * `seedSetupForm` rebuilt the form as `blankSetupFields()` plus five instance
 * fields and dropped it, and `blankSetupFields` hardcodes 'password'.
 *
 * THE SAME DEFECT CLASS AS `setDefault`: a form that rebuilds a record from
 * defaults and silently discards the fields it does not display. Here the
 * discarded field is how you sign in, so the operator cannot see the truth and
 * a later save can silently change it.
 */
describe('Setup shows the sign-in method the site is stored with', () => {
  /** The whole `<input>` for a radio, which spans several lines of markup. */
  const radio = (html: string, id: string): string =>
    new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '';

  it('selects OAuth for a site stored as OAuth', async () => {
    harness = await boot({ site: { authMode: 'code' }, storedPassword: null });
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();

    const html = harness.app.innerHTML;
    expect(radio(html, 'setup-auth-code')).toContain('checked');
    expect(radio(html, 'setup-auth-password')).not.toContain('checked');
  });

  /** A control the operator has to open to discover their own configuration
   *  has failed at showing it. */
  it('opens the Advanced section for a site stored as OAuth', async () => {
    harness = await boot({ site: { authMode: 'code' }, storedPassword: null });
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();

    expect(/<details[^>]*id="setup-advanced"[^>]*open/.test(harness.app.innerHTML)).toBe(true);
  });

  it('still selects password for a site stored with a password', async () => {
    harness = await boot({ site: { authMode: 'password' } });
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();

    const html = harness.app.innerHTML;
    expect(radio(html, 'setup-auth-password')).toContain('checked');
    expect(radio(html, 'setup-auth-code')).not.toContain('checked');
  });

  /** "Add another site…" is not a site: nothing is stored, so the default
   *  stands -- an ordinary account is what an institution has on day one. */
  it('defaults a brand-new site to password', async () => {
    harness = await boot({ fresh: true, storedPassword: null });
    await flush();

    const html = harness.app.innerHTML;
    expect(radio(html, 'setup-auth-password')).toContain('checked');
    expect(radio(html, 'setup-auth-code')).not.toContain('checked');
  });
});

/**
 * ## A leftover password must not redecide how the site signs in
 *
 * `refreshStoredPassword` used to force password mode whenever a stored
 * account came back, on the reasoning that "it is the one thing Setup can see
 * about a saved credential". That reasoning expired the moment the form
 * started reading the site's real `authMode`: it runs asynchronously, lands
 * after the form is seeded, and would put the radio back.
 *
 * The case is real rather than theoretical -- a site set up with a password and
 * later switched to OAuth keeps its password entry until somebody presses
 * "Forget this password".
 */
describe('a stored password does not override the stored sign-in method', () => {
  const radio = (html: string, id: string): string =>
    new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '';

  it('keeps OAuth selected for an OAuth site that still has a password stored', async () => {
    harness = await boot({
      site: { authMode: 'code' },
      storedPassword: { username: 'a.operator' },
    });
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();

    const html = harness.app.innerHTML;
    expect(radio(html, 'setup-auth-code')).toContain('checked');
    expect(radio(html, 'setup-auth-password')).not.toContain('checked');
  });
});

/**
 * ## A configured OAuth site must not look unconfigured
 *
 * REPORTED BY THE OPERATOR: they entered a client ID and secret, saved,
 * reopened Site settings and found both boxes empty. Nothing was lost -- the
 * values were stored correctly -- but no IPC could read them back, so Setup
 * showed blanks and there was no way to tell a configured site from an empty
 * one. They re-entered credentials against a form that did not reflect reality
 * while the app went on signing in with the stored ones.
 *
 * The secret is deliberately NOT shown. It gets what the password already
 * gets: the fact that one is stored, and a button to forget it.
 */
describe('Setup shows a stored OAuth credential', () => {
  const OAUTH = { clientId: 'the-client-id', redirectUri: 'https://library.example.test/', hasSecret: true };

  /**
   * The VALUE a field renders with, read from the markup.
   *
   * `fakeDom` hands out unparented stubs whose `.value` is always '', so
   * asking the element is asking the stand-in about itself. The markup is
   * what the real DOM would be built from.
   */
  const rendered = (html: string, id: string): string =>
    new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)?.[0].match(/value="([^"]*)"/)?.[1] ?? '(no value attribute)';

  const openSetup = async (): Promise<string> => {
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();
    return harness.app.innerHTML;
  };

  it('fills the client ID back in', async () => {
    harness = await boot({ site: { authMode: 'code' }, storedPassword: null, storedOAuth: OAUTH });
    const html = await openSetup();
    expect(rendered(html, 'setup-client-id')).toBe('the-client-id');
  });

  it('fills the redirect URL back in, verbatim', async () => {
    harness = await boot({ site: { authMode: 'code' }, storedPassword: null, storedOAuth: OAUTH });
    const html = await openSetup();
    expect(rendered(html, 'setup-redirect-uri')).toBe('https://library.example.test/');
  });

  it('says a secret is stored instead of showing an empty box', async () => {
    harness = await boot({ site: { authMode: 'code' }, storedPassword: null, storedOAuth: OAUTH });
    const html = await openSetup();
    expect(html).toMatch(/client secret .*stored/i);
    expect(harness.app.has('#setup-forget-oauth')).toBe(true);
  });

  /** The value must never reach the renderer, so it cannot reach the markup. */
  it('never puts the secret in the page', async () => {
    harness = await boot({ site: { authMode: 'code' }, storedPassword: null, storedOAuth: OAUTH });
    const html = await openSetup();
    expect(html).not.toContain('hasSecret');
    expect(JSON.stringify(OAUTH)).toContain('hasSecret');
  });

  it('forgets the credential when asked, for the site being edited', async () => {
    harness = await boot({ site: { authMode: 'code' }, storedPassword: null, storedOAuth: OAUTH });
    await openSetup();
    harness.app.fire('#setup-forget-oauth');
    await flush();
    expect(harness.calls.forgetOAuth).toEqual(['library-example-test']);
  });

  /** Nothing stored means the ordinary empty boxes, not a Forget button for a
   *  credential that does not exist. */
  it('offers no Forget button for a site with no stored credential', async () => {
    harness = await boot({ site: { authMode: 'code' }, storedPassword: null, storedOAuth: null });
    const html = await openSetup();
    expect(harness.app.has('#setup-forget-oauth')).toBe(false);
    expect(rendered(html, 'setup-client-id')).toBe('');
  });
});

/**
 * ## Which settings store this build is using
 *
 * A development run does NOT share a store with the installed app: Electron
 * derives userData from the app name, and `electron dist-desktop/...` has no
 * package.json at its root, so it falls back to the default name and writes
 * somewhere else entirely.
 *
 * THE ISOLATION IS RIGHT AND STAYS -- a dev build must not be able to overwrite
 * the credentials staff use, and one already did during this investigation.
 * What was wrong is that it was invisible: saves looked lost because the file
 * being watched was the other one, and 'this used to work' was true of a
 * configuration the dev build could not see.
 */
describe('Setup says which settings store is in use', () => {
  const DEV = {
    path: 'C:\Users\someone\AppData\Roaming\Electron',
    appName: 'Electron',
    packaged: false,
  };

  it('warns that a development build keeps its own settings, and names the folder', async () => {
    harness = await boot({ storage: DEV });
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();

    const html = harness.app.innerHTML;
    expect(html).toMatch(/development build/i);
    expect(html).toMatch(/separate/i);
    expect(html).toContain('AppData');
    expect(html).toContain('Electron');
  });

  /** An installed copy is the ordinary case and must not shout about it. */
  it('says nothing of the kind in a packaged build', async () => {
    harness = await boot();
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();

    expect(harness.app.innerHTML).not.toMatch(/development build/i);
  });
});
/**
 * ## Which model is on the other end
 *
 * REPORTED BY THE OPERATOR: "in the ollama settings I can't tell which ollama
 * model I have". The name is typed, and a tag that is nearly right --
 * `llama3.1` where the machine holds `llama3.1:8b` -- does not fail as a
 * settings mistake. It fails later, in the middle of a batch.
 *
 * ADVISORY, NOT A GATE. Endpoints that serve completions without a model list
 * are common; when the ask fails, the message says so and the typed name is
 * still usable. A convenience that becomes an obstacle is worse than none.
 */
describe('asking the model endpoint what it can run', () => {
  const setup = async (): Promise<void> => {
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();
  };

  it('lists what the endpoint offers', async () => {
    harness = await boot({ models: ['llama3.1:8b', 'deepseek-r1:14b'] });
    await setup();
    harness.app.fire('#setup-list-models');
    await flush();

    expect(harness.app.innerHTML).toContain('llama3.1:8b');
    expect(harness.app.innerHTML).toContain('deepseek-r1:14b');
  });

  it('asks about the address in the box, not a remembered one', async () => {
    harness = await boot({ models: ['m'] });
    await setup();
    harness.app.fire('#setup-model-base-url', 'input', { target: { value: 'http://127.0.0.1:9999/v1' } });
    await flush();
    harness.app.fire('#setup-list-models');
    await flush();

    expect(harness.calls.listModels.at(-1)?.baseUrl).toBe('http://127.0.0.1:9999/v1');
  });

  /** Reachable and holding nothing is a real answer, and a different one from
   *  "could not ask". */
  it('says so when the endpoint offers none', async () => {
    harness = await boot({ models: [] });
    await setup();
    harness.app.fire('#setup-list-models');
    await flush();

    expect(harness.app.innerHTML).toMatch(/no models/i);
  });

  it('reports a refusal without losing the typed name', async () => {
    harness = await boot({ modelsError: 'does not offer a list of models' });
    await setup();
    harness.app.fire('#setup-model-name', 'input', { target: { value: 'typed-by-hand' } });
    await flush();
    harness.app.fire('#setup-list-models');
    await flush();

    const html = harness.app.innerHTML;
    expect(html).toMatch(/does not offer a list of models/i);
    expect(new RegExp('<input[^>]*id="setup-model-name"[^>]*>').exec(html)?.[0]).toContain('typed-by-hand');
  });
});

/**
 * ## A site that cannot list collections yet
 *
 * REPORTED BY THE OPERATOR, who switched a site to OAuth and read this in the
 * collection field: "No cached OAuth token for https://content-test.byui.edu."
 *
 * The list needs a signed-in session. In password mode every call signs in, so
 * it works. Under OAuth it cannot work until `exchangeCode` has run once and
 * written a token -- which happens on a DIFFERENT screen. So Setup asked,
 * failed, and reported the failure as a problem with the collection list,
 * when the truth is that the site has not been signed in to yet.
 *
 * ASKED, NOT INFERRED FROM A FAILURE. Reading the state is what lets the screen
 * say something BEFORE the operator acts; catching the error only ever explains
 * it afterwards.
 */
describe('a site that cannot list collections yet', () => {
  /**
   * Reaching Setup goes THROUGH Choose, which lists collections for its own
   * dropdown and is entitled to. The question here is only what SETUP asks, so
   * the count is taken at the door.
   */
  const openSetup = async (): Promise<number> => {
    await reachChoose(harness.app);
    const before = harness.calls.listCollections.length;
    harness.app.fire('#choose-site-settings');
    await flush();
    return harness.calls.listCollections.length - before;
  };

  it('says an OAuth site needs signing in, without having to fail first', async () => {
    harness = await boot({
      site: { authMode: 'code' },
      storedPassword: null,
      storedOAuth: { clientId: 'c', redirectUri: 'https://x/', hasSecret: true },
      hasToken: false,
    });
    const asked = await openSetup();

    expect(harness.app.innerHTML).toMatch(/sign in to this site/i);
    // The point of the whole task: it did not have to try and fail to know.
    expect(asked).toBe(0);
  });

  it('lists collections for a password site with no sign-in step at all', async () => {
    harness = await boot({ site: { authMode: 'password' }, hasToken: false });
    const asked = await openSetup();

    expect(asked).toBeGreaterThan(0);
    expect(harness.app.innerHTML).not.toMatch(/sign in to this site/i);
  });

  it('lists collections for an OAuth site that has been signed in to', async () => {
    harness = await boot({
      site: { authMode: 'code' },
      storedPassword: null,
      storedOAuth: { clientId: 'c', redirectUri: 'https://x/', hasSecret: true },
      hasToken: true,
    });
    const asked = await openSetup();

    expect(asked).toBeGreaterThan(0);
    expect(harness.app.innerHTML).not.toMatch(/sign in to this site/i);
  });
});

/**
 * ## Signing in from where the operator is standing
 *
 * Task 1 made Setup SAY that an OAuth site needs signing in. Saying it is only
 * half the job: the operator is on Site settings, the sign-in button is on the
 * screen before it, and being told to go back is worse than being able to act.
 *
 * THE SITE SETUP IS EDITING IS NOT NECESSARILY THE ONE THE APP IS USING.
 * `state.instanceId` belongs to the action flow; Setup edits
 * `state.setupInstanceId`, and the operator can point it at another site. A
 * button that signed in to the wrong one would do so silently and look like it
 * had worked, which is why the id is asserted rather than the call count.
 */
describe('signing in to a site from Setup', () => {
  const OAUTH_SITE = {
    site: { authMode: 'code' as const },
    storedPassword: null,
    storedOAuth: { clientId: 'c', redirectUri: 'https://x/', hasSecret: true },
  };

  const openSetup = async (): Promise<void> => {
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();
  };

  it('offers the button for an OAuth site with no token', async () => {
    harness = await boot({ ...OAUTH_SITE, hasToken: false });
    await openSetup();
    expect(harness.app.has('#setup-sign-in')).toBe(true);
  });

  it('offers it for nothing else', async () => {
    harness = await boot({ ...OAUTH_SITE, hasToken: true });
    await openSetup();
    expect(harness.app.has('#setup-sign-in')).toBe(false);

    harness = await boot({ site: { authMode: 'password' }, hasToken: false });
    await openSetup();
    expect(harness.app.has('#setup-sign-in')).toBe(false);
  });

  it('signs in to the site Setup is editing', async () => {
    harness = await boot({ ...OAUTH_SITE, hasToken: false });
    await openSetup();
    harness.app.fire('#setup-sign-in');
    await flush();

    expect(harness.calls.signIn).toEqual(['library-example-test']);
  });

  /** The whole point: the list appears without leaving the screen. */
  it('lists the collections once the sign-in returns', async () => {
    harness = await boot({ ...OAUTH_SITE, hasToken: false });
    await openSetup();
    const before = harness.calls.listCollections.length;

    harness.app.fire('#setup-sign-in');
    await flush();

    expect(harness.calls.listCollections.length).toBeGreaterThan(before);
    expect(harness.app.has('#setup-sign-in')).toBe(false);
    expect(harness.app.has('#setup-form')).toBe(true);
  });

  /**
   * A sign-in window that was closed, or timed out, is a documented failure
   * (signin.ts). It must be reported on the screen the operator is standing on,
   * and must not throw them out of Setup.
   */
  it('stays on Setup and says why when the sign-in fails', async () => {
    harness = await boot({
      ...OAUTH_SITE,
      hasToken: false,
      signInFails: 'Sign-in window was closed before completing.',
    });
    await openSetup();
    harness.app.fire('#setup-sign-in');
    await flush();

    expect(harness.app.has('#setup-form')).toBe(true);
    expect(harness.app.innerHTML).toContain('closed before completing');
  });
});

/**
 * ## The site Setup is editing is not always the site the app is using
 *
 * `state.instanceId` belongs to the action flow; `state.setupInstanceId` is
 * whatever Setup is pointed at, and the operator can change it with the "These
 * credentials are for" selector.
 *
 * THIS EXISTS BECAUSE A MUTATION SURVIVED. Reading `state.instanceId` in the
 * Setup sign-in handler passed every test in the block above, because the
 * harness had a single site and the two ids were equal. The assertion claimed
 * to guard against signing in to the wrong site and could not.
 */
describe('Setup signs in to the site it is pointed at', () => {
  const OTHER: InstanceChoice = {
    id: 'other-example-test',
    label: 'Other',
    baseUrl: 'https://other.example.test',
    authMode: 'code',
    attachmentUuidPath: '',
    live: false,
    collectionUuid: '',
    schemaUuid: 'schema-2',
  };

  it('signs in to the site chosen on Setup, not the one the app is signed in to', async () => {
    harness = await boot({
      site: { authMode: 'code' },
      storedPassword: null,
      storedOAuth: { clientId: 'c', redirectUri: 'https://x/', hasSecret: true },
      hasToken: false,
      secondSite: OTHER,
    });
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();

    // Point Setup at the other site, which is NOT the action flow's.
    harness.app.fire('#setup-instance', 'change', { target: { value: OTHER.id } });
    await flush();

    harness.app.fire('#setup-sign-in');
    await flush();

    expect(harness.calls.signIn).toEqual([OTHER.id]);
  });
});

/**
 * ## Saving an OAuth site whose secret is already stored
 *
 * REPORTED BY THE OPERATOR: client ID filled, secret shown as stored, redirect
 * URL filled, collections listed — and "Enter the client ID, client secret, and
 * redirect URL." refusing the save.
 *
 * Introduced by the stored-secret card itself. The secret is never rendered
 * back into a field, so `settingsFrom` reports it as empty, and the OAuth
 * branch read an empty secret as "not entered". The PASSWORD branch has carried
 * the exception for this all along -- an empty password is allowed when one is
 * stored -- and the OAuth branch was written without it.
 *
 * The store already does the right thing: a blank secret on save means keep the
 * one that is there (secrets.ts#saveInstance). Only the screen disagreed.
 */
describe('saving an OAuth site that already has a secret', () => {
  const OAUTH = { clientId: 'c', redirectUri: 'https://x/', hasSecret: true };

  const openSetupAndSave = async (): Promise<void> => {
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();
    harness.app.fire('#setup-form', 'submit');
    await flush();
  };

  it('saves without asking for a secret it is deliberately not showing', async () => {
    harness = await boot({ site: { authMode: 'code' }, storedPassword: null, storedOAuth: OAUTH });
    await openSetupAndSave();

    expect(harness.app.innerHTML).not.toMatch(/Enter the client ID/i);
    expect(harness.calls.saveInstance).toBeGreaterThan(0);
  });

  /** Nothing stored means it really has not been entered, and the refusal stands. */
  it('still refuses when no secret is stored and none was typed', async () => {
    harness = await boot({ site: { authMode: 'code' }, storedPassword: null, storedOAuth: null });
    await openSetupAndSave();

    expect(harness.app.innerHTML).toMatch(/Enter the client ID/i);
  });
});

/**
 * ## Setup remembers which collection it read the schema from
 *
 * REPORTED BY THE OPERATOR: choose a collection on Site settings, save, come
 * back, and nothing is selected. The choice was genuinely not kept.
 *
 * It is not the batch collection -- that is chosen on Choose, per batch,
 * because it decides where real items land. This is the collection whose SCHEMA
 * the attachment field was checked against, and a screen that cannot show which
 * one it read leaves a saved setting looking exactly like a lost one. This app
 * has had enough of the latter for that to matter.
 */
describe('the collection a site was set up against', () => {
  it('is sent when the site is saved', async () => {
    harness = await boot({ site: { authMode: 'password' } });
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();

    harness.app.fire('#setup-collection', 'change', { target: { value: 'coll-2' } });
    await flush();
    harness.app.fire('#setup-form', 'submit');
    await flush();

    expect(harness.calls.savedInstance?.collectionUuid).toBe('coll-2');
  });

  it('comes back selected when Setup is reopened', async () => {
    harness = await boot({ site: { authMode: 'password', collectionUuid: 'coll-2' } });
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();

    const select = /<select[^>]*id="setup-collection"[^>]*>([\s\S]*?)<\/select>/.exec(harness.app.innerHTML)?.[1] ?? '';
    const selected = /<option value="([^"]*)"[^>]*selected/.exec(select)?.[1];
    expect(selected).toBe('coll-2');
  });
});

/**
 * ## A token the server refuses must offer a way out
 *
 * `hasToken` reads the STORE. A token that exists and is REFUSED looks exactly
 * like a good one to it, so Task 1 saw no reason to warn and Task 2 hid the
 * sign-in button -- leaving a failing collection list and no control that could
 * fix it. That is the state the operator was stranded in for two sessions.
 *
 * The signal is `currentUser`, which answers null for a session openEQUELLA
 * will not honour. TYPED, not the prose of an error: this codebase has been
 * bitten by matching message text, and a 403 with an empty body has no prose to
 * match anyway.
 *
 * The discrimination that matters is the second test. A server fault is not a
 * reason to sign in again, and offering it would send the operator through a
 * browser flow that cannot help.
 */
describe('a collection list that fails because the session is not honoured', () => {
  const OAUTH = {
    site: { authMode: 'code' as const },
    storedPassword: null,
    storedOAuth: { clientId: 'c', redirectUri: 'https://x/', hasSecret: true },
    hasToken: true,
  };

  /**
   * Reached from SIGN-IN, not from Choose. Choose cannot be reached in these
   * states -- the collection list it needs is the thing that is failing, and a
   * session that is not honoured never gets that far. Site settings is offered
   * on Sign-in for exactly this.
   */
  const openSetup = async (): Promise<void> => {
    harness.app.fire('#site-settings-btn');
    await flush();
  };

  it('offers the sign-in button even though a token is stored', async () => {
    harness = await boot({
      ...OAUTH,
      listCollectionsFails: 'GET /api/collection failed: 403',
      signedIn: false,
    });
    await openSetup();

    expect(harness.app.has('#setup-sign-in')).toBe(true);
  });

  it('still says what went wrong, rather than replacing it with the offer', async () => {
    harness = await boot({
      ...OAUTH,
      listCollectionsFails: 'GET /api/collection failed: 403',
      signedIn: false,
    });
    await openSetup();

    expect(harness.app.innerHTML).toContain('403');
  });

  /** A server fault is not a reason to sign in again. */
  it('offers nothing when the session is fine and the server is not', async () => {
    harness = await boot({
      ...OAUTH,
      listCollectionsFails: 'GET /api/collection failed: 500 Internal Server Error',
      signedIn: true,
    });
    await openSetup();

    expect(harness.app.has('#setup-sign-in')).toBe(false);
    expect(harness.app.innerHTML).toContain('500');
  });
});

/**
 * ## A password site is never sent through the browser flow
 *
 * Rows 9 and 10 of the state table: a site that has been switched between the
 * two modes leaves the other mode's artefacts behind, and what matters is that
 * they are IGNORED rather than acted on.
 *
 * The live case is one this branch introduced. Offering "Sign in to this site"
 * whenever the session is refused is right under OAuth and wrong under a
 * password: the notice beside that button says, in as many words, that the site
 * signs in with OAuth, and the button drives a browser flow a password site has
 * no use for. A password site whose credentials the server refuses would have
 * been told something false about how it signs in and handed a control that
 * cannot help -- the same shape of dead end the button exists to remove.
 *
 * What a password site needs is the error, which it already gets: the fields
 * that would fix it are on this screen.
 */
describe('a password site whose session is refused', () => {
  const PASSWORD = {
    site: { authMode: 'password' as const },
    hasToken: false,
  };

  const openSetup = async (): Promise<void> => {
    harness.app.fire('#site-settings-btn');
    await flush();
  };

  it('is not offered the OAuth sign-in button', async () => {
    harness = await boot({
      ...PASSWORD,
      listCollectionsFails: 'POST /api/auth/login failed: 401 Unauthorized',
      signedIn: false,
    });
    await openSetup();

    expect(harness.app.has('#setup-sign-in')).toBe(false);
  });

  /** And is not told the wrong thing about how it signs in. */
  it('is not told that the site signs in with OAuth', async () => {
    harness = await boot({
      ...PASSWORD,
      listCollectionsFails: 'POST /api/auth/login failed: 401 Unauthorized',
      signedIn: false,
    });
    await openSetup();

    expect(harness.app.innerHTML).not.toContain('Sign in to this site first.');
  });

  it('still says what went wrong', async () => {
    harness = await boot({
      ...PASSWORD,
      listCollectionsFails: 'POST /api/auth/login failed: 401 Unauthorized',
      signedIn: false,
    });
    await openSetup();

    expect(harness.app.innerHTML).toContain('401');
  });
});

/**
 * ## A refusal that names only one way out is a dead end
 *
 * REPORTED BY THE OPERATOR, 2026-08-20: open Advanced, leave the client ID and
 * secret empty, save, and the screen asks for three values. True, and no help
 * to somebody who does not have them and never needed them -- the operator who
 * opened Advanced to look, or who read OAuth as the more thorough choice.
 *
 * Username and password is the DEFAULT for the reason this refusal should say:
 * it is what an institution can use on the day it installs this tool, with
 * nothing to request from an administrator. OAuth exists for the sites where
 * sign-in goes through single sign-on and a client ID is the only way in.
 *
 * So the message names the other control as well -- and says what OAuth is FOR,
 * because "use the other one instead" is wrong at exactly the institutions that
 * cannot.
 */
describe('the refusal when OAuth credentials are missing', () => {
  const openSetupAndSave = async (): Promise<void> => {
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();
    harness.app.fire('#setup-form', 'submit');
    await flush();
  };

  /**
   * THE ERROR LINE, NOT THE WHOLE SCREEN. Every assertion below passed against
   * `innerHTML` before a word of the message changed: "username and password"
   * labels the radio a few lines up, and "single sign-on" appears in the
   * Advanced section's own explanation. A test that cannot fail is worse than
   * no test, and this project has been caught by that exact shape before.
   */
  const refusal = async (): Promise<string> => {
    harness = await boot({ site: { authMode: 'code' }, storedPassword: null, storedOAuth: null });
    await openSetupAndSave();
    const errors = harness.app.innerHTML.match(/<p class="error"[\s\S]*?<\/p>/g) ?? [];
    return errors.join(' ');
  };

  it('still names the three values it is asking for', async () => {
    const text = await refusal();
    expect(text).toMatch(/client ID/i);
    expect(text).toMatch(/client secret/i);
    expect(text).toMatch(/redirect URL/i);
  });

  it('names the other way in as well', async () => {
    expect(await refusal()).toMatch(/username and password/i);
  });

  /**
   * And does not tell an SSO institution to do something it cannot. The offer
   * carries its condition, or it is advice that fails precisely where OAuth was
   * the right choice all along.
   */
  it('says what OAuth is for, rather than presenting the other as simply better', async () => {
    expect(await refusal()).toMatch(/single sign-on/i);
  });

  /** The save is still refused. Nothing here relaxes the requirement. */
  it('refuses the save', async () => {
    harness = await boot({ site: { authMode: 'code' }, storedPassword: null, storedOAuth: null });
    await openSetupAndSave();
    expect(harness.calls.saveInstance).toBe(0);
  });
});

/**
 * ## The most destructive control in the app must say what it destroys
 *
 * Row 14. `clearSettings` unlinks `settings.enc` outright and clears the token
 * store: every site the operator added, their addresses and labels, every
 * password, every OAuth client, every chosen collection and attachment path,
 * and every model endpoint. Nothing survives it.
 *
 * The warning described one site's OAuth credential -- "the saved client ID and
 * secret for this Windows user". An operator signed in with a username and
 * password would read that as describing something they do not even have, and
 * agree to it. A confirm that understates what it is confirming is worse than
 * no confirm: it collects consent for something other than what happens.
 *
 * These assert the CLAIMS the warning must make, not its phrasing. Each names a
 * distinct thing the operator loses and would not otherwise expect.
 */
describe('the warning before every saved site is wiped', () => {
  const warning = async (): Promise<string> => {
    harness.app.fire('#reset-settings-btn');
    await flush();
    return harness.calls.confirmedWith ?? '';
  };

  /** Every site, not the one on screen. */
  it('says it clears every site rather than this one', async () => {
    expect(await warning()).toMatch(/every|all/i);
  });

  /** A password-mode operator has no client secret to lose, and lost one anyway. */
  it('says passwords go too', async () => {
    expect(await warning()).toMatch(/password/i);
  });

  /**
   * The site LIST goes, which is the surprise: the addresses were typed by the
   * operator and are not a credential, so nothing about "credentials" warns
   * that they will have to be entered again.
   */
  it('says the sites themselves have to be added again', async () => {
    expect(await warning()).toMatch(/site/i);
  });

  /** And still confirms, and still clears. */
  it('remains a confirm before a wipe', async () => {
    harness.app.fire('#reset-settings-btn');
    await flush();
    expect(harness.calls.confirm).toBe(1);
    expect(harness.calls.clearSettings).toBe(1);
  });
});

/**
 * ## Forgetting must leave the screen agreeing with the store
 *
 * Row 11. `secrets.ts#forgetOAuth` clears all three OAuth fields, the redirect
 * URL included. The screen cleared two of them and left the redirect URL in its
 * box, so the form showed a value the store no longer held -- and this is
 * exactly the class of disagreement that produced the "Enter the client ID,
 * client secret, and redirect URL" refusal on a fully configured site: the
 * screen and the store holding different opinions about the same credential.
 */
describe('forgetting an OAuth credential', () => {
  const forget = async (): Promise<void> => {
    harness = await boot({
      site: { authMode: 'code' },
      storedPassword: null,
      storedOAuth: { clientId: 'c-1', redirectUri: 'https://oeq.example.test/', hasSecret: true },
    });
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();
    harness.app.fire('#setup-forget-oauth');
    await flush();
  };

  it('empties the redirect URL box, as the store empties the stored one', async () => {
    await forget();
    expect(harness.app.innerHTML).not.toContain('https://oeq.example.test/');
  });

  it('asks the store to forget it', async () => {
    await forget();
    expect(harness.calls.forgetOAuth).toEqual([SITE.id]);
  });
});

/**
 * ## The label has to carry the warning too
 *
 * DECIDED BY THE OPERATOR, 2026-08-20. "Clear all credentials…" reads like an
 * edit — you click it expecting a form — and what it does is unlink the whole
 * store. The confirm now discloses that before anything happens, but a label is
 * what somebody clicks and a dialog is what they skim, so the disclosure should
 * not depend entirely on the second one being read.
 *
 * "Clear" says destruction and "all" says the reach. It still does not say the
 * SITES go as well as the credentials; the confirm carries that, and a button
 * long enough to say it would not be a button.
 */
describe('the label on the destructive route', () => {
  it('says it clears, rather than changes', async () => {
    expect(harness.app.innerHTML).toMatch(/Clear all credentials/i);
  });

  it('no longer offers to "change" them', async () => {
    expect(harness.app.innerHTML).not.toMatch(/Change credentials/i);
  });
});
