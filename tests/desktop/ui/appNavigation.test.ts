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
  calls: { clearSettings: number; confirm: number; saveInstance: number };
}

let harness: Harness;

/** Let every pending promise chain a handler kicked off actually settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Boot app.ts against a stand-in DOM and a stand-in bridge, with one saved
 * site whose credentials are already stored and a session already signed in --
 * the state an operator installing the tool is actually in.
 */
async function boot(over: Partial<InstanceChoice> = {}): Promise<Harness> {
  const dom = fakeDom();
  const calls = { clearSettings: 0, confirm: 0, saveInstance: 0 };
  let stored: InstanceChoice = { ...SITE, ...over };

  const oeq = {
    onProgress: () => {},
    listInstances: async () => [stored],
    credentialsDropped: async () => false,
    hasSettings: async () => true,
    currentUser: async () => ({
      id: 'u1',
      username: 'a.operator',
      firstName: 'A',
      lastName: 'Operator',
      guest: false,
    }),
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
  return { app: dom.app, calls };
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
