# Add, Choose and Remove Sites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff can add a site from the Sign in screen, choose between their sites, and remove one site without wiping the others.

**Architecture:**
- Most of this exists already. Saving a new site in Setup already selects it and returns to Sign in. This plan adds:
  - a visible entry point on Sign in;
  - a per-site removal in the store, behind one IPC channel and a confirm on Setup.
- Removal ends that site's sessions first, then clears its token, then deletes its store entries. This is the same order `forgetPassword` uses.

**Tech Stack:**
- TypeScript, Electron (sandboxed renderer, typed IPC) and vitest.
- Source files are CRLF, so edit them with the Edit tool.
- Typecheck with `npm run typecheck`.

**Spec:** `docs/superpowers/specs/2026-11-19-add-and-remove-sites-design.md`

---

### Task 1: `SecretStore.removeInstance`

**Files:**
- Modify: `src/desktop/secrets.ts` (after `forgetModel`)
- Test: `tests/desktop/secrets.test.ts` (in the describe that defines `furnished`, after "reaches only the site it is given")

- [ ] **Step 1: Write the failing tests**

```ts
  it('removeInstance removes the site, its password, its OAuth client and its model', async () => {
    const s = await furnished();
    await s.removeInstance(instanceKey(LIVE));

    expect(await s.loadInstance(instanceKey(LIVE))).toBeNull();
    expect(await s.getPassword(instanceKey(LIVE))).toBeNull();
    expect(await s.getOAuth(instanceKey(LIVE))).toBeNull();
    expect(await s.getModel(instanceKey(LIVE))).toBeNull();
    expect(await s.listInstances()).toEqual([]);
  });

  it('removeInstance leaves every other site exactly as it was', async () => {
    const s = await furnished();
    await s.saveInstance({ label: 'Sandbox', baseUrl: SANDBOX }, OAUTH);
    await s.setPassword(instanceKey(SANDBOX), 'other.user', 'other-pass');
    await s.setModel(instanceKey(SANDBOX), MODEL);

    await s.removeInstance(instanceKey(LIVE));

    expect((await s.listInstances()).map((i) => i.label)).toEqual(['Sandbox']);
    expect(await s.getPassword(instanceKey(SANDBOX))).toEqual({ username: 'other.user', password: 'other-pass' });
    expect(await s.getOAuth(instanceKey(SANDBOX))).not.toBeNull();
    expect(await s.getModel(instanceKey(SANDBOX))).not.toBeNull();
  });

  it('removing a site that is not stored is not an error, and writes nothing', async () => {
    const file = join(dir, 'settings.enc');
    const s = new SecretStore(file, fakeCipher);
    await expect(s.removeInstance(instanceKey(LIVE))).resolves.toBeUndefined();
    await expect(readFile(file)).rejects.toThrow(/ENOENT/);
  });
```

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run tests/desktop/secrets.test.ts`
Expected: FAIL with "removeInstance is not a function".

- [ ] **Step 3: Implement**

```ts
  /**
   * Behind Setup's "Remove this site…": the site and EVERYTHING stored for it
   * -- its entry (address, name, per-site settings, any OAuth client, live or
   * dormant), its password and its model endpoint -- in one write, so a
   * failure leaves the site whole rather than half-removed. Every other site
   * is untouched. Removing what is absent is not an error and writes nothing.
   *
   * Ending the site's sessions and clearing its token is the IPC handler's
   * job (handlers.ts): this store holds neither.
   */
  async removeInstance(instanceId: InstanceId): Promise<void> {
    const { shape } = await this.loadAll();
    const present =
      shape.instances[instanceId] !== undefined ||
      shape.passwords[instanceId] !== undefined ||
      shape.models[instanceId] !== undefined;
    if (!present) return;
    delete shape.instances[instanceId];
    delete shape.passwords[instanceId];
    delete shape.models[instanceId];
    await this.write(shape);
  }
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `npx vitest run tests/desktop/secrets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** with `feat(desktop): SecretStore.removeInstance -- one site, everything stored for it`

### Task 2: The `removeInstance` IPC channel

**Files:**
- Modify:
  - `src/desktop/ipc.ts`: an `OeqApi` member beside `forgetPassword`, and `CHANNELS.removeInstance: 'oeq:removeInstance'`.
  - `src/desktop/preload.cts`: the channel constant and the bridge entry, beside `forgetModel`.
  - `src/desktop/handlers.ts`: the handler, after `forgetPassword`.
- Test: `tests/desktop/handlers.test.ts`, as a new describe after `describe('forgetPassword'`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('removeInstance', () => {
  const SITE = 'https://oeq.example.edu';
  const OTHER = 'https://oeq-test.example.edu';

  beforeEach(async () => {
    hoisted.userData = await mkdtemp(join(tmpdir(), 'oeq-remove-'));
    forgetLiveSessions();
  });

  const store = () => new SecretStore(join(hoisted.userData, 'settings.enc'), plainCipher);
  const tokenStore = () => new EncryptedTokenStore(join(hoisted.userData, 'token.enc'), plainCipher);
  const password = { authMode: 'password' as const, username: 'm.rowan', password: 'hunter2' };

  async function twoSites(): Promise<void> {
    await store().saveInstance({ label: 'Live', baseUrl: SITE }, password);
    await store().saveInstance({ label: 'Sandbox', baseUrl: OTHER }, password);
  }

  it('removes the site and leaves the other', async () => {
    await twoSites();
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());

    await ipc.call('oeq:removeInstance', SITE);

    expect((await store().listInstances()).map((i) => i.label)).toEqual(['Sandbox']);
  });

  it('ends the site’s session while it is still stored, then removes it', async () => {
    await twoSites();
    let storedDuringLogout: boolean | null = null;
    rememberSession(SITE, {
      logout: async () => {
        storedDuringLogout = (await store().loadInstance(SITE)) !== null;
      },
    });
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());

    await ipc.call('oeq:removeInstance', SITE);

    expect(storedDuringLogout).toBe(true);
    expect(await store().loadInstance(SITE)).toBeNull();
  });

  it('removes the site even when ending its session fails', async () => {
    await twoSites();
    rememberSession(SITE, {
      logout: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());

    await expect(ipc.call('oeq:removeInstance', SITE)).resolves.toBeUndefined();
    expect(await store().loadInstance(SITE)).toBeNull();
  });

  it('clears the sign-in token only when it is this site’s', async () => {
    await twoSites();
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, getWindowStub());

    await tokenStore().save({ accessToken: 't-other', baseUrl: OTHER });
    await ipc.call('oeq:removeInstance', SITE);
    expect(await tokenStore().loadRaw()).not.toBeNull();

    await tokenStore().save({ accessToken: 't-site', baseUrl: SITE });
    await ipc.call('oeq:removeInstance', OTHER);
    await store().saveInstance({ label: 'Live', baseUrl: SITE }, password);
    await ipc.call('oeq:removeInstance', SITE);
    expect(await tokenStore().loadRaw()).toBeNull();
  });
});
```

Before writing the token test, check that the token file name matches what `handlers.ts#tokens()` uses (`grep -n "token" src/desktop/handlers.ts`) and change `'token.enc'` if it differs. Compare token addresses with `sameOrigin` from `secrets.ts`, so that a trailing slash cannot defeat the match.

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run tests/desktop/handlers.test.ts -t removeInstance`
Expected: FAIL with "no handler for oeq:removeInstance".

- [ ] **Step 3: Implement**

In `ipc.ts`, inside `OeqApi`, after `forgetPassword`:

```ts
  /**
   * Behind Setup's "Remove this site…": end the site's sessions, clear its
   * sign-in token if the stored one is this site's, and delete everything
   * stored for it. Other sites are untouched. Removing what is absent is not
   * an error.
   */
  removeInstance(instanceId: string): Promise<void>;
```

In `CHANNELS` (ipc.ts) and the preload's channel copy: `removeInstance: 'oeq:removeInstance',`. Bridge entry in the preload: `removeInstance: (instanceId) => invoke(CHANNELS.removeInstance, instanceId),`.

In `handlers.ts`, after the `forgetPassword` handler (add `sameOrigin` to the existing `./secrets.js` import):

```ts
  /**
   * "Remove this site…". In the same order as forgetPassword, for the same
   * reason: the session is ended while the site is still stored, and a
   * logout that fails never stops the removal the operator asked for --
   * openEQUELLA times an abandoned session out regardless.
   */
  ipcMain.handle(
    CHANNELS.removeInstance,
    async (_e, instanceId: Parameters<OeqApi['removeInstance']>[0]) => {
      try {
        await endSessionsFor(instanceId);
      } catch {
        // Deliberately empty -- see forgetPassword.
      }
      const inst = await secrets().loadInstance(instanceId);
      const token = await tokens().loadRaw();
      if (inst !== null && token !== null && sameOrigin(token.baseUrl, inst.baseUrl)) await tokens().clear();
      await secrets().removeInstance(instanceId);
    },
  );
```

- [ ] **Step 4: Run the tests, including the preload channel check, and check they pass**

Run: `npx vitest run tests/desktop/handlers.test.ts tests/desktop/preload-channels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** with `feat(desktop): removeInstance channel -- ends the session, clears its token, removes the site`

### Task 3: Two screen events

**Files:**
- Modify: `src/desktop/ui/state.ts`
- Test: `tests/desktop/ui/state.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it('adding a site from Sign-in opens Setup; removing one lands on Sign-in', () => {
    expect(nextScreen('signin', { type: 'addSite' })).toBe('setup');
    expect(nextScreen('setup', { type: 'siteRemoved' })).toBe('signin');
  });
```

- [ ] **Step 2: Run it and check it fails** (it is a type error under `npm run typecheck`, and a FAIL under vitest).

- [ ] **Step 3: Implement.** Add the following to `ScreenEvent`:

```ts
  /** Sign-in's "Add another site…": Setup with a blank form, clearing nothing. */
  | { type: 'addSite' }
  /** Setup's "Remove this site…" done, with at least one site left to choose from. */
  | { type: 'siteRemoved' }
```

Then add these cases to `nextScreen`:

```ts
    // A FOURTH route to Setup. Not 'addCredentials' (a saved site with no
    // credentials) and not 'editSettings' (fired after wiping every site):
    // this adds a site and touches none of the existing ones.
    case 'addSite':
      return 'setup';
    // Sign-in is where a site is chosen, and the removed one may have been
    // the site a waiting Choose selection belonged to.
    case 'siteRemoved':
      return 'signin';
```

- [ ] **Step 4: Run the tests and check they pass.** Run: `npx vitest run tests/desktop/ui/state.test.ts`
- [ ] **Step 5: Commit** with `feat(desktop): addSite and siteRemoved screen events`

### Task 4: Sign in, a "Site" dropdown and "Add another site…"

**Files:**
- Modify: `src/desktop/ui/screens/signin.ts`. Split the template out of `renderSignin` into an exported `signinMarkup(props)`, the way `setupMarkup` is, so it can be asserted on without a DOM. Add `onAddSite(): void` to `SigninProps`.
- Test: `tests/desktop/ui/signin.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('signinMarkup', () => {
  const base: SigninProps = {
    instances: [
      { id: 'https://oeq.example.edu', label: 'Live', baseUrl: 'https://oeq.example.edu', authMode: 'password', attachmentUuidPath: '', live: true, collectionUuid: '', schemaUuid: '' },
      { id: 'https://oeq-test.example.edu', label: 'Sandbox', baseUrl: 'https://oeq-test.example.edu', authMode: 'password', attachmentUuidPath: '', live: false, collectionUuid: '', schemaUuid: '' },
    ],
    instanceId: 'https://oeq.example.edu',
    instanceHasSettings: true,
    user: null,
    checkingUser: false,
    signingIn: false,
    error: null,
    onInstanceChange: () => {},
    onSignIn: () => {},
    onSignOut: () => {},
    onContinue: () => {},
    onAddCredentials: () => {},
    onAddSite: () => {},
    onSiteSettings: () => {},
    onResetSettings: () => {},
  };

  it('labels the dropdown "Site" and lists every saved site', () => {
    const html = signinMarkup(base);
    expect(html).toMatch(/<label for="signin-instance">Site<\/label>/);
    expect(html).toContain('>Live</option>');
    expect(html).toContain('>Sandbox</option>');
  });

  /**
   * A BUTTON, NOT AN OPTION IN THE DROPDOWN: on Windows, arrowing through a
   * closed <select> fires `change` for every option passed, so an option that
   * navigates would drop an operator stepping between two sites into Setup.
   */
  it('offers "Add another site…" as a button, never as an option in the dropdown', () => {
    const html = signinMarkup(base);
    expect(html).toMatch(/<button id="add-site-btn" type="button"[^>]*>Add another site…<\/button>/);
    expect(html.match(/<select[\s\S]*?<\/select>/)![0]).not.toMatch(/Add another site/);
  });
});
```

Import `signinMarkup` and `type SigninProps` from `../../../src/desktop/ui/screens/signin.js`.

- [ ] **Step 2: Run them and check they fail.** Run: `npx vitest run tests/desktop/ui/signin.test.ts`

- [ ] **Step 3: Implement**
  - Move everything `renderSignin` builds up to and including the template string into `export function signinMarkup(props: SigninProps): string`. `renderSignin` becomes `root.innerHTML = signinMarkup(props);` followed by the existing listener wiring.
  - Change `<label for="signin-instance">Instance</label>` to `Site`.
  - Directly after the `<select>`, add:

```ts
      <p class="reset-row">
        <button id="add-site-btn" type="button" class="link-button">Add another site…</button>
      </p>
```

  - Wire it with the other listeners: `root.querySelector<HTMLButtonElement>('#add-site-btn')?.addEventListener('click', () => props.onAddSite());`

- [ ] **Step 4: Run the tests and the typecheck, and check both pass.** `app.ts` will fail the typecheck until Task 6 passes `onAddSite`. Add `onAddSite: handleAddSite` there with a stub `function handleAddSite(): void {}` if you need the typecheck green now. Task 6 replaces the stub.
- [ ] **Step 5: Commit** with `feat(desktop): Sign-in names its dropdown Site and offers Add another site…`

### Task 5: Setup, "Remove this site…"

**Files:**
- Modify: `src/desktop/ui/screens/setup.ts`
  - Add `onRemoveSite(): void` to `SetupProps`.
  - Export `removeSiteQuestion(label, baseUrl)`.
  - Render the button.
- Test: `tests/desktop/ui/setup.test.ts`. Add `onRemoveSite: () => {}` to the `props` helper.

- [ ] **Step 1: Write the failing tests**

```ts
describe('Remove this site…', () => {
  it('is offered for a saved site', () => {
    expect(setupMarkup(props())).toMatch(/<button id="setup-remove-site" type="button" class="secondary">\s*Remove this site…/);
  });

  it('is not offered while adding a new site', () => {
    expect(setupMarkup(props({ instanceId: '' }))).not.toContain('setup-remove-site');
  });

  it('asks a question naming the site, its address, and everything removed', () => {
    const q = removeSiteQuestion('Live', 'https://oeq.example.edu');
    expect(q).toContain('Live (https://oeq.example.edu)');
    expect(q).toMatch(/password or OAuth credentials/);
    expect(q).toMatch(/model settings/);
    expect(q).toMatch(/signs you out/);
    expect(q).toMatch(/other sites are not changed/i);
  });
});
```

- [ ] **Step 2: Run them and check they fail.** Run: `npx vitest run tests/desktop/ui/setup.test.ts`

- [ ] **Step 3: Implement**

```ts
/**
 * The confirm behind "Remove this site…". It names everything the removal
 * deletes and nothing it does not (cached schemas, which hold no
 * credentials, are left): a confirm that understates what it confirms
 * collects consent for something other than what happens.
 */
export function removeSiteQuestion(label: string, baseUrl: string): string {
  return (
    `Remove ${label} (${baseUrl}) from this computer? This deletes its saved password or OAuth ` +
    `credentials and its model settings, and signs you out of it. Your other sites are not ` +
    `changed. To use it again you would add it again.`
  );
}
```

In `setupMarkup`, after the closing `</div>` of the Back/Save `button-row`, render the button only when `selected` (the saved site the form is pointed at) exists:

```ts
        ${
          selected
            ? `<p class="reset-row">
          <button id="setup-remove-site" type="button" class="secondary">
            Remove this site…
          </button>
        </p>`
            : ''
        }
```

`type="button"` is load-bearing. The button is inside `#setup-form`, and a default-type button there would submit the form and save. Wire it with the other listeners: `root.querySelector<HTMLButtonElement>('#setup-remove-site')?.addEventListener('click', () => props.onRemoveSite());`

- [ ] **Step 4: Run the tests and check they pass.**
- [ ] **Step 5: Commit** with `feat(desktop): Setup offers Remove this site…, naming what it deletes`

### Task 6: Wire both handlers in `app.ts`

**Files:**
- Modify: `src/desktop/ui/app.ts`
  - Sign-in render: `onAddSite: handleAddSite`.
  - Setup render: `onRemoveSite: handleRemoveSite`.
  - The two handlers, after `handleSiteSettings`. Import `removeSiteQuestion` from `./screens/setup.js`.

- [ ] **Step 1: Implement**

```ts
/**
 * Sign-in's "Add another site…" -- Setup with a blank form, clearing nothing.
 *
 * WHY IT IS ON SIGN-IN. The only route used to be "Settings for {site}…" and
 * then Setup's own dropdown, and the operator could not find it on the day
 * they needed production (2026-11-19). Back returns to Sign-in having saved
 * nothing; Save selects the new site and lands on Sign-in (handleSaveSettings).
 */
function handleAddSite(): void {
  seedSetupForm('');
  // After the seed, which clears it: Back has somewhere to go.
  state.setupEnteredFrom = 'signin';
  state.screen = nextScreen('signin', { type: 'addSite' });
  render();
  void refreshStoredUsername();
  void refreshStoredOAuth();
  void refreshStoredModel();
  void refreshSetupCollections();
}

/**
 * Setup's "Remove this site…" -- the site Setup is pointed at, and everything
 * stored for it, after a confirm naming all of it. Other sites are untouched.
 *
 * Afterwards: Sign-in, on the site the app was using, or on the first one
 * left if that was the one removed. With none left, Setup as on first run.
 */
async function handleRemoveSite(): Promise<void> {
  const id = state.setupInstanceId;
  const site = instanceById(id);
  if (!site) return;
  if (!window.confirm(removeSiteQuestion(site.label, site.baseUrl))) return;
  try {
    await window.oeq.removeInstance(id);
  } catch (err) {
    state.setupError = errorMessage(err);
    render();
    return;
  }
  state.instances = withSaved(await window.oeq.listInstances());
  state.setupError = null;
  state.setupEnteredFrom = null;
  if (state.instanceId === id || instanceById(state.instanceId) === undefined) {
    state.instanceId = state.instances[0]?.id ?? '';
    state.user = null;
  }
  if (state.instanceId === '') {
    seedSetupForm('');
    state.screen = 'setup';
    render();
    return;
  }
  seedSetupForm(state.instanceId);
  state.signinError = null;
  state.screen = nextScreen('setup', { type: 'siteRemoved' });
  render();
  void checkInstanceState();
}
```

Before implementing, check two things:
- Read `withSaved` (`app.ts` around line 306) and `instanceById` to confirm their signatures.
- Check whether `listInstances` can throw. Wrap the re-list in the same try, so a failed re-list is shown as an error rather than leaving a stale list.

- [ ] **Step 2: Typecheck, run the whole suite, and run the renderer-purity test**

Run: `npm run typecheck` and `npx vitest run`
Expected: everything passes, including `tests/desktop/rendererPurity.test.ts`. `removeSiteQuestion` is pure and lives in a renderer module.

- [ ] **Step 3: Commit** with `feat(desktop): add a site from Sign-in; remove one from Setup`

### Task 7: Hand test in the desktop app, and docs

- [ ] **Step 1:** Run `npm run build:desktop`, then `Remove-Item Env:ELECTRON_RUN_AS_NODE` and `npm run desktop`. Then check:
  - Sign in shows "Site" and "Add another site…".
  - Adding a site and pressing Back changes nothing.
  - Adding a fake site (`https://oeq.example.edu`) and saving lands on Sign in with it selected.
  - Removing it on Setup shows the confirm naming its address, and you land on Sign in on the remaining site.
  - The test site is untouched throughout.
- [ ] **Step 2:** Update the docs:
  - CLAUDE.md's Status gains a short paragraph.
  - `docs/SESSION-HANDOFF.md` gains a RESUME HERE entry.
  - In the README, a sentence where it describes Sign in or Setup, if it does (`grep -n "Instance\|another site" README.md docs/INSTALL.md`).
- [ ] **Step 3: Commit** with `docs: adding and removing sites`, then push the branch.
