import type { OeqApi, ColumnReport, PlanReport, RunProgress, RunReport } from '../ipc.js';
import type { CurrentUser, CollectionSummary } from '../../core/client.js';
import type { ItemState } from '../../core/types.js';
import { initialScreen, nextScreen, type Screen } from './state.js';
import { errorMessage } from './errors.js';
import { renderBanner } from './banner.js';
import { renderSetup } from './screens/setup.js';
import { renderSignin } from './screens/signin.js';
import { renderChoose } from './screens/choose.js';
import { renderReview } from './screens/review.js';
import { renderConfirm } from './screens/confirm.js';
import { renderProgress, type ProgressLogEntry } from './screens/progress.js';
import { renderResults, type InterruptedEntry } from './screens/results.js';
import { canContinueReview } from './review.js';
import { canUpload } from './confirm.js';
import { collectionUrl } from './collectionUrl.js';
import { UI_INSTANCES } from './instances.js';

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
  collectionName: string | null;
  sheetPath: string | null;
  folderPath: string | null;
  chooseError: string | null;
  readyMessage: string | null;

  // Review screen -- see ui/review.ts for why `reviewColumns` (from
  // validate() against the ORIGINAL sheet) rather than a plan() response is
  // the stable per-column identity `reviewOverrides` is keyed against.
  reviewLoadingColumns: boolean;
  reviewColumns: ColumnReport[] | null;
  reviewOverrides: Record<string, string>;
  reviewChecking: boolean;
  /** True once plan() has succeeded for the CURRENT overrides. */
  reviewChecked: boolean;
  reviewPlan: PlanReport | null;
  reviewError: string | null;

  // Confirm screen
  itemState: ItemState;
  typedCount: string;
  uploading: boolean;
  confirmError: string | null;

  // Progress screen
  progress: RunProgress | null;
  progressLog: ProgressLogEntry[];

  // Results screen
  runReport: RunReport | null;
  interruptedEntries: InterruptedEntry[];
  retrying: boolean;
  resultsError: string | null;
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
    collectionName: null,
    sheetPath: null,
    folderPath: null,
    chooseError: null,
    readyMessage: null,
    reviewLoadingColumns: false,
    reviewColumns: null,
    reviewOverrides: {},
    reviewChecking: false,
    reviewChecked: false,
    reviewPlan: null,
    reviewError: null,
    itemState: 'draft',
    typedCount: '',
    uploading: false,
    confirmError: null,
    progress: null,
    progressLog: [],
    runReport: null,
    interruptedEntries: [],
    retrying: false,
    resultsError: null,
  };
}

const state = initialState();

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id} in index.html`);
  return el as T;
}

function currentInstance() {
  return UI_INSTANCES.find((i) => i.id === state.instanceId);
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
    case 'review':
      renderReview(app, {
        columns: state.reviewColumns,
        overrides: state.reviewOverrides,
        checked: state.reviewChecked,
        report: state.reviewPlan,
        loadingColumns: state.reviewLoadingColumns,
        checking: state.reviewChecking,
        error: state.reviewError,
        onOverrideChange: handleReviewOverrideChange,
        onContinue: handleReviewContinue,
        onBack: handleReviewBack,
      });
      break;
    case 'confirm':
      renderConfirm(app, {
        instanceLabel: currentInstance()?.label ?? state.instanceId,
        collectionName: state.collectionName ?? state.collectionUuid ?? '(unknown collection)',
        itemCount: state.reviewPlan?.entryCount ?? 0,
        itemState: state.itemState,
        typedCount: state.typedCount,
        uploading: state.uploading,
        error: state.confirmError,
        onItemStateChange: handleItemStateChange,
        onTypedCountChange: handleTypedCountChange,
        onUpload: handleUpload,
        onBack: handleConfirmBack,
      });
      break;
    case 'progress':
      renderProgress(app, {
        done: state.progress?.done ?? 0,
        total: state.progress?.total ?? state.reviewPlan?.entryCount ?? 0,
        fileName: state.progress?.fileName ?? '',
        log: state.progressLog,
      });
      break;
    case 'results':
      if (state.runReport) {
        renderResults(app, {
          report: state.runReport,
          interrupted: state.interruptedEntries,
          collectionUrl: collectionUrl(currentInstance()?.baseUrl ?? '', state.collectionUuid ?? ''),
          retrying: state.retrying,
          error: state.resultsError,
          onRetryFailed: handleRetryFailed,
        });
      }
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
  state.collectionName = null;
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
  state.collectionName = state.collections?.find((c) => c.uuid === uuid)?.name ?? null;
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
  if (!state.collectionUuid || !state.sheetPath || !state.folderPath) return;
  state.screen = 'review';
  render();
  void loadReviewColumns();
}

// --- Review ------------------------------------------------------------

/**
 * Entry into Review: check the spreadsheet's headers against the schema
 * with `validate()` -- NOT `plan()`. `plan()` calls `buildManifest`, which
 * THROWS if any header is invalid rather than returning a partial report, so
 * calling it before the user has had a chance to fix anything would almost
 * always fail immediately on a real spreadsheet. `validate()` has no such
 * restriction; it just reports.
 */
async function loadReviewColumns(): Promise<void> {
  state.reviewLoadingColumns = true;
  state.reviewColumns = null;
  state.reviewOverrides = {};
  state.reviewChecked = false;
  state.reviewChecking = false;
  state.reviewPlan = null;
  state.reviewError = null;
  render();
  try {
    const columns = await window.oeq.validate({ instanceId: state.instanceId, sheetPath: state.sheetPath! });
    state.reviewColumns = columns;
    state.reviewLoadingColumns = false;
    render();
    // Nothing to fix: run the real check immediately so the warnings and
    // entry count are on screen without an extra click for the common case
    // of an already schema-clean spreadsheet.
    if (columns.every((c) => c.valid)) void runReviewCheck();
  } catch (err) {
    state.reviewLoadingColumns = false;
    state.reviewError = errorMessage(err);
    render();
  }
}

/**
 * Applies the current overrides and calls plan(). A SUCCESS is proof every
 * column is now valid (see loadReviewColumns's doc comment) and populates
 * the warnings/entry-count shown on this same screen; the user still has to
 * click again (now labelled "Continue to Confirm") to actually move on. A
 * FAILURE means some header -- original or overridden -- is still wrong;
 * `buildManifest`'s error message names exactly which, verbatim.
 */
async function runReviewCheck(): Promise<void> {
  state.reviewChecking = true;
  state.reviewError = null;
  render();
  try {
    const report = await window.oeq.plan({
      instanceId: state.instanceId,
      collectionUuid: state.collectionUuid!,
      sheetPath: state.sheetPath!,
      filesDir: state.folderPath!,
      // Placeholder -- Confirm's Upload re-plans with the REAL choice right
      // before run() (see handleUpload). What matters here is only that the
      // manifest builds and the warnings/duplicate-check are accurate, both
      // of which are itemState-independent.
      itemState: 'draft',
      overrides: { ...state.reviewOverrides },
    });
    state.reviewPlan = report;
    state.reviewChecked = true;
    state.reviewChecking = false;
    state.screen = nextScreen(state.screen, { type: 'planChecked' });
    render();
  } catch (err) {
    state.reviewChecked = false;
    state.reviewPlan = null;
    state.reviewChecking = false;
    state.reviewError = errorMessage(err);
    render();
  }
}

function handleReviewOverrideChange(header: string, xpath: string): void {
  const v = xpath.trim();
  if (v === '') delete state.reviewOverrides[header];
  else state.reviewOverrides[header] = v;
  // Any override edit invalidates the last successful check -- the manifest
  // on disk no longer necessarily matches what's displayed.
  state.reviewChecked = false;
  state.reviewPlan = null;
  render();
}

function handleReviewContinue(): void {
  if (!state.reviewColumns) return;
  if (state.reviewChecked && state.reviewPlan) {
    // Second click: the plan already succeeded for these exact overrides.
    state.typedCount = '';
    state.itemState = 'draft';
    state.confirmError = null;
    state.uploading = false;
    state.screen = nextScreen('review', { type: 'reviewApproved' });
    render();
    return;
  }
  if (!canContinueReview(state.reviewColumns, state.reviewOverrides)) return;
  void runReviewCheck();
}

function handleReviewBack(): void {
  state.screen = 'choose';
  render();
}

// --- Confirm ------------------------------------------------------------

function handleItemStateChange(s: ItemState): void {
  state.itemState = s;
  if (s === 'draft') state.typedCount = '';
  state.confirmError = null;
  render();
}

function handleTypedCountChange(v: string): void {
  state.typedCount = v;
  render();
}

function handleConfirmBack(): void {
  state.screen = 'review';
  render();
}

/**
 * Uploading re-plans one final time with the ACTUAL chosen item state
 * (Review's own plan() calls always use 'draft' as a placeholder -- see
 * runReviewCheck) so the manifest run() is about to process matches exactly
 * what Confirm showed the user, then calls run(). The Progress screen
 * appears the instant run() starts, driven by the onProgress subscription
 * registered once in init().
 */
async function handleUpload(): Promise<void> {
  if (!state.reviewPlan) return;
  if (!canUpload(state.itemState, state.reviewPlan.entryCount, state.typedCount)) return;
  state.uploading = true;
  state.confirmError = null;
  render();
  try {
    const report = await window.oeq.plan({
      instanceId: state.instanceId,
      collectionUuid: state.collectionUuid!,
      sheetPath: state.sheetPath!,
      filesDir: state.folderPath!,
      itemState: state.itemState,
      overrides: { ...state.reviewOverrides },
    });
    state.reviewPlan = report;
    state.uploading = false;
    state.progress = null;
    state.progressLog = [];
    state.runReport = null;
    state.interruptedEntries = [];
    state.resultsError = null;
    state.screen = nextScreen('confirm', { type: 'uploadStarted' });
    render();

    const runReport = await window.oeq.run({ manifestPath: report.manifestPath, instanceId: state.instanceId });
    await finishRun(report.manifestPath, runReport);
  } catch (err) {
    state.uploading = false;
    state.confirmError = errorMessage(err);
    // Whether the failure happened before run() started (the re-plan) or
    // during it, send the user back to Confirm rather than stranding them on
    // a dead Progress screen with no way forward.
    state.screen = 'confirm';
    render();
  }
}

// --- Progress ------------------------------------------------------------

function handleProgress(p: RunProgress): void {
  state.progress = p;
  state.progressLog.push({ fileName: p.fileName, status: p.status, error: p.error });
  // Cap memory for an unusually large batch; the log is a convenience, not a
  // record of truth -- the manifest on disk is that.
  if (state.progressLog.length > 500) state.progressLog.shift();
  if (state.screen === 'progress') render();
}

// --- Results ------------------------------------------------------------

/**
 * After a run finishes, also loads the manifest to list which rows (if any)
 * were left `interrupted` (status still `'uploading'` -- see core/runner.ts)
 * so the Results screen can name them, not just report a count.
 */
async function finishRun(manifestPath: string, report: RunReport): Promise<void> {
  state.runReport = report;
  state.resultsError = null;
  try {
    const manifest = await window.oeq.loadManifest(manifestPath);
    state.interruptedEntries = manifest.entries
      .filter((e) => e.status === 'uploading')
      .map((e) => ({ rowNumber: e.rowNumber, fileName: e.fileName }));
  } catch (err) {
    state.interruptedEntries = [];
    state.resultsError = errorMessage(err);
  }
  state.screen = nextScreen('progress', { type: 'runFinished' });
  render();
}

/**
 * Maps to the existing retry semantics: `failed` rows only, never
 * `interrupted` ones (retryFailed's handler resets only status === 'failed'
 * -- see handlers.ts). Re-invokes run() against the same manifest, which is
 * safe to call repeatedly (core/runner.ts: rows already created/skipped/
 * incomplete are left untouched).
 */
async function handleRetryFailed(): Promise<void> {
  if (!state.reviewPlan) return;
  const manifestPath = state.reviewPlan.manifestPath;
  state.retrying = true;
  state.resultsError = null;
  render();
  try {
    await window.oeq.retryFailed(manifestPath);
    state.progress = null;
    state.progressLog = [];
    state.retrying = false;
    state.screen = nextScreen('results', { type: 'retryStarted' });
    render();
    const runReport = await window.oeq.run({ manifestPath, instanceId: state.instanceId });
    await finishRun(manifestPath, runReport);
  } catch (err) {
    state.retrying = false;
    state.resultsError = errorMessage(err);
    state.screen = 'results';
    render();
  }
}

// --- Startup ---------------------------------------------------------------

async function init(): Promise<void> {
  requireEl('app').innerHTML = '<p class="muted">Starting…</p>';
  renderBanner(requireEl('banner'), state.instanceId);
  // Registered exactly once for the lifetime of the app: preload.cts's
  // onProgress adds a NEW ipcRenderer listener on every call, so calling
  // this more than once would fire the handler multiple times per event.
  window.oeq.onProgress(handleProgress);
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
