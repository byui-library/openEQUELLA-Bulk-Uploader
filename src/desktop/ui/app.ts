import type { OeqApi } from '../ipc.js';
import type { CurrentUser, CollectionSummary } from '../../core/client.js';
import { initialScreen, nextScreen, type Screen } from './state.js';
import { errorMessage } from './errors.js';
import { renderBanner } from './banner.js';
import { renderSetup } from './screens/setup.js';
import { renderSignin } from './screens/signin.js';
import { renderChoose } from './screens/choose.js';

declare global {
  interface Window {
    oeq: OeqApi;
  }
}

interface AppState {
  screen: Screen;
  instanceId: string;

  // Setup screen
  setupSaving: boolean;
  setupError: string | null;

  // Sign-in screen
  user: CurrentUser | null;
  checkingUser: boolean;
  signingIn: boolean;
  signinError: string | null;

  // Choose screen
  collections: CollectionSummary[] | null;
  collectionsError: string | null;
  collectionQuery: string;
  collectionUuid: string | null;
  sheetPath: string | null;
  folderPath: string | null;
  chooseError: string | null;
  readyMessage: string | null;
}

// Defaults to 'test' -- never Production -- so a user who has not yet made a
// deliberate choice is never one click away from the wrong environment. See
// the instance banner: it is red specifically because this default (and
// every subsequent choice) needs a durable, unmissable visual cue.
function initialState(): AppState {
  return {
    screen: 'setup',
    instanceId: 'test',
    setupSaving: false,
    setupError: null,
    user: null,
    checkingUser: false,
    signingIn: false,
    signinError: null,
    collections: null,
    collectionsError: null,
    collectionQuery: '',
    collectionUuid: null,
    sheetPath: null,
    folderPath: null,
    chooseError: null,
    readyMessage: null,
  };
}

const state = initialState();

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id} in index.html`);
  return el as T;
}

function render(): void {
  renderBanner(requireEl('banner'), state.instanceId);

  const app = requireEl('app');
  switch (state.screen) {
    case 'setup':
      renderSetup(app, {
        error: state.setupError,
        saving: state.setupSaving,
        onSave: handleSaveSettings,
      });
      break;
    case 'signin':
      renderSignin(app, {
        instanceId: state.instanceId,
        user: state.user,
        checkingUser: state.checkingUser,
        signingIn: state.signingIn,
        error: state.signinError,
        onInstanceChange: handleInstanceChange,
        onSignIn: handleSignIn,
        onSignOut: handleSignOut,
        onContinue: handleSigninContinue,
        onResetSettings: handleResetSettings,
      });
      break;
    case 'choose':
      renderChoose(app, {
        collections: state.collections,
        collectionsError: state.collectionsError,
        query: state.collectionQuery,
        collectionUuid: state.collectionUuid,
        sheetPath: state.sheetPath,
        folderPath: state.folderPath,
        error: state.chooseError,
        readyMessage: state.readyMessage,
        onQueryChange: handleCollectionQueryChange,
        onSelectCollection: handleSelectCollection,
        onChooseSpreadsheet: handleChooseSpreadsheet,
        onChooseFolder: handleChooseFolder,
        onContinue: handleChooseContinue,
      });
      break;
  }
}

function renderFatal(message: string): void {
  const app = requireEl('app');
  app.innerHTML = `
    <section class="screen">
      <h1>Something went wrong starting up</h1>
      <p class="error" role="alert"></p>
      <div class="button-row"><button id="retry-btn" type="button">Retry</button></div>
    </section>
  `;
  // Set via textContent, not the template, so the message can never be
  // mistaken for markup regardless of what a core error happens to contain.
  const p = app.querySelector('p.error');
  if (p) p.textContent = message;
  app.querySelector<HTMLButtonElement>('#retry-btn')?.addEventListener('click', () => void init());
}

// --- Setup ---------------------------------------------------------------

async function handleSaveSettings(clientId: string, clientSecret: string): Promise<void> {
  if (clientId === '' || clientSecret === '') {
    state.setupError = 'Enter both the client ID and the client secret.';
    render();
    return;
  }
  state.setupSaving = true;
  state.setupError = null;
  render();
  try {
    await window.oeq.saveSettings({ clientId, clientSecret });
    state.setupSaving = false;
    state.setupError = null;
    state.screen = nextScreen('setup', { type: 'settingsSaved' });
    render();
    void checkExistingUser();
  } catch (err) {
    state.setupSaving = false;
    state.setupError = errorMessage(err);
    render();
  }
}

// --- Sign-in ---------------------------------------------------------------

/**
 * Silently checks whether a still-valid token already exists for the
 * currently selected instance. `currentUser()`'s handler already swallows
 * its own errors and resolves null (handlers.ts) rather than throwing, so
 * this never needs to surface a failure -- "not signed in" is a normal
 * result, not an error condition.
 */
async function checkExistingUser(): Promise<void> {
  state.checkingUser = true;
  render();
  const instanceId = state.instanceId;
  let user: CurrentUser | null = null;
  try {
    user = await window.oeq.currentUser(instanceId);
  } catch {
    user = null;
  }
  // The instance may have changed while this was in flight; a stale result
  // for the previous instance must never be attributed to the new one.
  if (state.instanceId !== instanceId) return;
  state.user = user;
  state.checkingUser = false;
  render();
}

function handleInstanceChange(id: string): void {
  state.instanceId = id;
  state.user = null;
  state.signinError = null;
  render();
  void checkExistingUser();
}

async function handleSignIn(): Promise<void> {
  state.signingIn = true;
  state.signinError = null;
  render();
  try {
    const user = await window.oeq.signIn(state.instanceId);
    state.user = user;
    state.signingIn = false;
    render();
  } catch (err) {
    state.signingIn = false;
    // Covers both documented failure modes verbatim: the sign-in window
    // being closed before completing, and a sign-in timeout (signin.ts).
    state.signinError = errorMessage(err);
    render();
  }
}

async function handleSignOut(): Promise<void> {
  try {
    await window.oeq.signOut();
  } catch (err) {
    state.signinError = errorMessage(err);
  }
  state.user = null;
  state.screen = nextScreen(state.screen, { type: 'signedOut' });
  render();
}

/**
 * "Reset settings" (spec: "clears everything including the client
 * credentials") -- distinct from Sign out, which only clears the token.
 * Reachable from the Sign-in screen regardless of sign-in state, since the
 * scenario it exists for is a mistyped client ID/secret that never gets far
 * enough to produce a signed-in state at all. Confirmed via window.confirm
 * before clearing -- it discards the secret the administrator supplied, and
 * getting it again is a support request, so a click that can't be undone
 * needs a deliberate second step, not just a click that happens to land on
 * the wrong button.
 */
async function handleResetSettings(): Promise<void> {
  const confirmed = window.confirm(
    'This clears the saved client ID and secret for this Windows user. ' +
      "You'll need to enter them again -- ask your administrator if you no longer have them. Continue?",
  );
  if (!confirmed) return;
  try {
    await window.oeq.clearSettings();
  } catch (err) {
    state.signinError = errorMessage(err);
    render();
    return;
  }
  state.user = null;
  state.signinError = null;
  state.setupError = null;
  state.screen = nextScreen(state.screen, { type: 'editSettings' });
  render();
}

function handleSigninContinue(): void {
  state.screen = nextScreen('signin', { type: 'signedIn' });
  state.collections = null;
  state.collectionsError = null;
  state.collectionQuery = '';
  state.collectionUuid = null;
  state.sheetPath = null;
  state.folderPath = null;
  state.chooseError = null;
  state.readyMessage = null;
  render();
  void loadCollections();
}

// --- Choose ---------------------------------------------------------------

async function loadCollections(): Promise<void> {
  state.collections = null;
  state.collectionsError = null;
  render();
  try {
    state.collections = await window.oeq.listCollections(state.instanceId);
  } catch (err) {
    state.collections = [];
    state.collectionsError = errorMessage(err);
  }
  render();
}

function handleCollectionQueryChange(q: string): void {
  state.collectionQuery = q;
  render();
}

function handleSelectCollection(uuid: string): void {
  state.collectionUuid = uuid;
  // Whatever "ready" meant is now stale -- the collection just changed.
  state.readyMessage = null;
  render();
}

async function handleChooseSpreadsheet(): Promise<void> {
  try {
    const path = await window.oeq.chooseSpreadsheet();
    if (path) {
      state.sheetPath = path;
      state.readyMessage = null;
    }
  } catch (err) {
    state.chooseError = errorMessage(err);
  }
  render();
}

async function handleChooseFolder(): Promise<void> {
  try {
    const path = await window.oeq.chooseFolder();
    if (path) {
      state.folderPath = path;
      state.readyMessage = null;
    }
  } catch (err) {
    state.chooseError = errorMessage(err);
  }
  render();
}

function handleChooseContinue(): void {
  // Task 7 wires Setup -> Sign-in -> Choose only; the Review screen (Task 8)
  // is not built yet. Rather than route to a screen that doesn't exist, say
  // so plainly -- an unresponsive button would look broken.
  state.readyMessage =
    'Collection, spreadsheet and files folder are all set. The Review screen is not part of this build yet.';
  render();
}

// --- Startup ---------------------------------------------------------------

async function init(): Promise<void> {
  requireEl('app').innerHTML = '<p class="muted">Starting…</p>';
  renderBanner(requireEl('banner'), state.instanceId);
  try {
    const hasSettings = await window.oeq.hasSettings();
    state.screen = initialScreen(hasSettings);
    render();
    if (state.screen === 'signin') void checkExistingUser();
  } catch (err) {
    renderFatal(errorMessage(err));
  }
}

void init();

export {};
