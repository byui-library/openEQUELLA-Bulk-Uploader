import type { OeqApi, ColumnReport, InstanceChoice, PlanReport, RunProgress, RunReport } from '../ipc.js';
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
import { defaultChoice } from '../../core/duplicates.js';
import { rowsToSkip } from './duplicates.js';
import { clearedForNextBatch, type BatchState } from './batch.js';
import { canUpload } from './confirm.js';
import { collectionUrl } from './collectionUrl.js';
import { UI_INSTANCES } from './instances.js';
import { createExtractController } from './extract/controller.js';
import { renderExtract } from './extract/mount.js';

declare global {
  interface Window {
    oeq: OeqApi;
  }
}

/**
 * `extends BatchState` on purpose. Everything scoped to ONE batch is declared
 * once, in batch.ts, so "Upload another spreadsheet" cannot forget a field: a
 * new batch-scoped field has to be added there, and `clearedForNextBatch` will
 * not compile until it supplies a value for it. Declaring it here instead
 * would leave the reset silently incomplete and carry a stale plan into the
 * next upload.
 */
interface AppState extends BatchState {
  screen: Screen;
  // Every site the operator has added, read from the store at startup and
  // after every save. UI_INSTANCES (what the app SHIPS with) is empty; this
  // is the real list -- see ui/instances.ts.
  instances: InstanceChoice[];
  // The instance the rest of the app (Sign-in beyond the missing-credentials
  // prompt, Choose, Confirm, Progress, Results) acts against. '' until the
  // operator has one.
  instanceId: string;

  // Setup screen -- which instance is being configured, or '' for a site not
  // added yet. Deliberately a SEPARATE field from `instanceId`: credentials
  // are per instance (secrets.ts), and Setup must be able to configure one
  // site while the rest of the app is pointed at another.
  setupInstanceId: string;
  setupSaving: boolean;
  setupError: string | null;
  // Whether credentials written by an older version of the store were found
  // and discarded on this launch -- Setup says so rather than presenting a
  // blank form that reads as a broken app. See ui/setupNotice.ts.
  credentialsDropped: boolean;

  // Sign-in screen
  // Whether `instanceId` currently has credentials saved at all -- see
  // ui/signin.ts's signinMode. Refreshed whenever the selected instance
  // changes (checkInstanceState) so the screen can offer to add credentials
  // instead of presenting a "Sign in" button that can only fail.
  instanceHasSettings: boolean;
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
  starterKitSaving: boolean;
  starterKitMessage: string | null;

  // Review, Confirm, Progress and Results state all lives in BatchState.
}

// No instance is selected until the operator has added one, and none is
// chosen for them: the app ships knowing no addresses at all (ui/instances.ts),
// and a default pointed at somebody's live site is exactly what the instance
// banner exists to prevent.
function initialState(): AppState {
  return {
    screen: 'setup',
    instances: [...UI_INSTANCES],
    instanceId: '',
    setupInstanceId: '',
    setupSaving: false,
    setupError: null,
    credentialsDropped: false,
    instanceHasSettings: false,
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
    starterKitSaving: false,
    starterKitMessage: null,
    reviewLoadingColumns: false,
    reviewColumns: null,
    reviewOverrides: {},
    reviewChecking: false,
    reviewChecked: false,
    reviewPlan: null,
    reviewError: null,
    duplicates: [],
    duplicateChoices: {},
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

/**
 * The list the dropdowns show: whatever the app ships with (nothing --
 * ui/instances.ts) plus every site the operator has added. A saved entry wins
 * over a shipped one with the same id, since the operator's own credentials
 * and label are the newer truth.
 */
function withSaved(saved: InstanceChoice[]): InstanceChoice[] {
  return [...UI_INSTANCES.filter((s) => !saved.some((i) => i.id === s.id)), ...saved];
}

function instanceById(id: string): InstanceChoice | null {
  return state.instances.find((i) => i.id === id) ?? null;
}

function currentInstance(): InstanceChoice | null {
  return instanceById(state.instanceId);
}

function render(): void {
  // On Setup, the banner must reflect the instance being CONFIGURED
  // (setupInstanceId), not the app's separate action-flow instance -- a
  // form labelled "Client ID (Live)" under a banner naming another site
  // would look broken.
  renderBanner(
    requireEl('banner'),
    state.screen === 'setup' ? instanceById(state.setupInstanceId) : currentInstance(),
  );

  const app = requireEl('app');
  switch (state.screen) {
    case 'setup':
      renderSetup(app, {
        instances: state.instances,
        instanceId: state.setupInstanceId,
        credentialsDropped: state.credentialsDropped,
        error: state.setupError,
        saving: state.setupSaving,
        onInstanceChange: handleSetupInstanceChange,
        onSave: handleSaveSettings,
      });
      break;
    case 'signin':
      renderSignin(app, {
        instances: state.instances,
        instanceId: state.instanceId,
        instanceHasSettings: state.instanceHasSettings,
        user: state.user,
        checkingUser: state.checkingUser,
        signingIn: state.signingIn,
        error: state.signinError,
        onInstanceChange: handleInstanceChange,
        onSignIn: handleSignIn,
        onSignOut: handleSignOut,
        onContinue: handleSigninContinue,
        onAddCredentials: handleAddCredentials,
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
        starterKitSaving: state.starterKitSaving,
        starterKitMessage: state.starterKitMessage,
        onQueryChange: handleCollectionQueryChange,
        onSelectCollection: handleSelectCollection,
        onChooseSpreadsheet: handleChooseSpreadsheet,
        onChooseFolder: handleChooseFolder,
        onSaveStarterKit: handleSaveStarterKit,
        onContinue: handleChooseContinue,
        onExtract: () => {
          // The extract flow owns its own state and render loop; app.ts hands
          // over the root element and gets it back on exit. Deliberately not
          // folded into this file's state machine -- see the plan's rationale.
          const root = requireEl('app');
          const controller = createExtractController({
            api: window.oeq,
            onExit: () => render(),
            render: (s) => renderExtract(root, s, controller, (p) => window.oeq.openPath(p)),
          });
          renderExtract(root, controller.state(), controller, (p) => window.oeq.openPath(p));
        },
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
        duplicates: state.duplicates,
        duplicateChoices: state.duplicateChoices,
        onDuplicateChoice: (rowNumber, choice) => {
          // No re-render: the browser already reflects the click, nothing else
          // on this screen derives from it, and replacing innerHTML mid-group
          // throws focus to <body> so the operator cannot arrow through it.
          state.duplicateChoices[rowNumber] = choice;
        },
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
          collectionName: state.collectionName,
          retrying: state.retrying,
          error: state.resultsError,
          onRetryFailed: handleRetryFailed,
          onAnotherBatch: handleAnotherBatch,
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

function handleSetupInstanceChange(id: string): void {
  state.setupInstanceId = id;
  state.setupError = null;
  render();
}

async function handleSaveSettings(
  instance: { label: string; baseUrl: string },
  settings: { clientId: string; clientSecret: string; redirectUri: string },
): Promise<void> {
  if (instance.baseUrl === '') {
    state.setupError = 'Enter the address of your openEQUELLA site.';
    render();
    return;
  }
  if (settings.clientId === '' || settings.clientSecret === '' || settings.redirectUri === '') {
    state.setupError = 'Enter the client ID, client secret, and redirect URL.';
    render();
    return;
  }
  state.setupSaving = true;
  state.setupError = null;
  render();
  try {
    // The main process derives the id from the address (one rule for what an
    // address's key is) and hands it back, so the app selects exactly the
    // entry that was written -- including when the operator typed a spelling
    // that normalised onto a site they had already added.
    const saved = await window.oeq.saveInstance(instance, settings);
    state.instances = withSaved(await window.oeq.listInstances());
    state.setupSaving = false;
    state.setupError = null;
    state.setupInstanceId = saved.id;
    // Nothing left to explain: the discarded store has just been overwritten.
    state.credentialsDropped = false;
    // Point the rest of the app at the instance that was just configured --
    // landing back on Sign-in still pointed at a DIFFERENT (uncredentialed)
    // instance would look like nothing had happened.
    state.instanceId = saved.id;
    state.screen = nextScreen('setup', { type: 'settingsSaved' });
    render();
    void checkInstanceState();
  } catch (err) {
    state.setupSaving = false;
    state.setupError = errorMessage(err);
    render();
  }
}

// --- Sign-in ---------------------------------------------------------------

/**
 * Refreshes, for the currently selected instance, both whether it has saved
 * credentials at all (ui/signin.ts's signinMode -- missing credentials must
 * pre-empt attempting a sign-in) and whether a still-valid token already
 * exists. Both IPC calls fail soft (`Promise.allSettled`): a rejection from
 * either -- in practice only `currentUser()` can genuinely error, and even
 * its handler already swallows failures and resolves null (handlers.ts) --
 * is treated as "not signed in" / "no credentials confirmed", never thrown,
 * since "not signed in yet" is a normal result here, not an error condition.
 */
async function checkInstanceState(): Promise<void> {
  state.checkingUser = true;
  render();
  const instanceId = state.instanceId;
  const [hasSettingsResult, userResult] = await Promise.allSettled([
    window.oeq.hasSettings(instanceId),
    window.oeq.currentUser(instanceId),
  ]);
  // The instance may have changed while this was in flight; a stale result
  // for the previous instance must never be attributed to the new one.
  if (state.instanceId !== instanceId) return;
  state.instanceHasSettings = hasSettingsResult.status === 'fulfilled' ? hasSettingsResult.value : false;
  state.user = userResult.status === 'fulfilled' ? userResult.value : null;
  state.checkingUser = false;
  render();
}

function handleInstanceChange(id: string): void {
  state.instanceId = id;
  state.user = null;
  state.signinError = null;
  render();
  void checkInstanceState();
}

/**
 * Sign-in's "Add credentials for {instance}" prompt (ui/signin.ts's
 * signinMode === 'missing-credentials'). Unlike `handleResetSettings`, this
 * clears NOTHING -- it only points Setup at the instance that's missing
 * credentials so the OTHER instance's saved credentials, if any, are left
 * completely untouched.
 */
function handleAddCredentials(): void {
  state.setupInstanceId = state.instanceId;
  state.setupError = null;
  state.screen = nextScreen('signin', { type: 'addCredentials' });
  render();
}

async function handleSignIn(): Promise<void> {
  // Defensive: the Sign-in button is only ever rendered when credentials
  // exist for this instance (ui/signin.ts), but a doomed sign-in attempt
  // must never fire even if that invariant is ever violated.
  if (!state.instanceHasSettings) return;
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
  state.instanceHasSettings = false;
  state.signinError = null;
  state.setupError = null;
  // Every site was just wiped, addresses included -- Setup starts from the
  // blank form it shows on a fresh install.
  state.instances = [...UI_INSTANCES];
  state.instanceId = '';
  state.setupInstanceId = '';
  // The operator cleared this themselves; they do not need a notice telling
  // them their credentials are gone.
  state.credentialsDropped = false;
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
  state.starterKitSaving = false;
  state.starterKitMessage = null;
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

/**
 * Saves the bundled starter kit (template CSV + sample file) to a folder the
 * operator picks, then tells them plainly what to do with it: those two
 * files are enough to run one real test upload immediately, without having
 * to build their own spreadsheet first. A cancelled dialog (null) is not an
 * error -- same convention as handleChooseSpreadsheet/handleChooseFolder
 * above -- it just leaves the screen as it was.
 */
async function handleSaveStarterKit(): Promise<void> {
  state.starterKitSaving = true;
  state.starterKitMessage = null;
  state.chooseError = null;
  render();
  try {
    const destDir = await window.oeq.saveStarterKit();
    state.starterKitSaving = false;
    if (destDir) {
      state.starterKitMessage =
        `Saved to ${destDir}. Next: set the files folder above to ${destDir}, set the ` +
        `spreadsheet to upload-template.csv inside it, then Continue -- that runs one real ` +
        `test upload you can safely delete afterward.`;
    }
    render();
  } catch (err) {
    state.starterKitSaving = false;
    state.chooseError = errorMessage(err);
    render();
  }
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
  // Keyed by row number, which means something different in a different
  // spreadsheet. Cleared here and not only in clearedForNextBatch(), which is
  // reached only after a completed run -- Review -> Back -> Choose -> a new
  // sheet never passes through it.
  state.duplicates = [];
  state.duplicateChoices = {};
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
    state.duplicates = report.duplicates;
    state.reviewChecked = true;
    state.reviewChecking = false;
    state.screen = nextScreen(state.screen, { type: 'planChecked' });
    render();
  } catch (err) {
    state.reviewChecked = false;
    state.reviewPlan = null;
    state.duplicates = [];
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
  state.duplicates = [];
  render();
}

function handleReviewContinue(): void {
  if (!state.reviewColumns) return;
  if (state.reviewChecked && state.reviewPlan) {
    // Second click: the plan already succeeded for these exact overrides.
    // Freeze what the operator was actually shown. A row they left alone still
    // has a decision -- its tier's default -- and that decision must survive the
    // re-plan in handleUpload, which produces findings nobody sees.
    for (const d of state.duplicates) {
      state.duplicateChoices[d.rowNumber] ??= defaultChoice(d.tier);
    }
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

    // Applied here rather than at plan time: these are the operator's choices,
    // made after seeing the plan. A row left alone takes its tier's default,
    // which is why the default is computed here too rather than assumed.
    //
    // Deliberately NOT refreshed from the re-plan above: acting on findings the
    // operator never saw is how a row shown as "Skip" gets uploaded, or a row
    // never shown at all gets silently dropped. The reviewed set is the one
    // they agreed to.
    const skipRows = rowsToSkip(state.duplicates, state.duplicateChoices);
    if (skipRows.length > 0) {
      const marked = await window.oeq.applyDuplicateChoices({ manifestPath: report.manifestPath, skipRows });
      if (marked !== skipRows.length) {
        // Every skipRow should have matched a pending entry. A mismatch means
        // the manifest and the reviewed findings have drifted apart, and some
        // row the operator chose to skip is still going to be uploaded.
        console.warn(`asked to skip ${skipRows.length} row(s), marked ${marked}`);
      }
    }

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
/**
 * Finish this batch and go back to Choose for another spreadsheet.
 *
 * Done used to be a dead end -- a link to the collection and nothing else --
 * so a second spreadsheet meant closing and reopening the app. Reported by the
 * operator after a real run.
 *
 * Every batch-scoped field is replaced wholesale from `clearedForNextBatch()`
 * rather than reset by hand here, so a field added later cannot be forgotten
 * and quietly carried into the next upload. The instance, the signed-in user
 * and the chosen collection survive.
 */
function handleAnotherBatch(): void {
  Object.assign(state, clearedForNextBatch());
  state.screen = nextScreen('results', { type: 'anotherBatch' });
  render();
}

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
  renderBanner(requireEl('banner'), currentInstance());
  // Registered exactly once for the lifetime of the app: preload.cts's
  // onProgress adds a NEW ipcRenderer listener on every call, so calling
  // this more than once would fire the handler multiple times per event.
  window.oeq.onProgress(handleProgress);
  try {
    // "First run" means the operator has added no site at all. One who
    // configured a single site must land on Sign-in, not be sent back through
    // Setup -- and the app has no opinion about how many sites they ought to
    // have, because it ships knowing none (ui/instances.ts).
    const [instances, credentialsDropped] = await Promise.all([
      window.oeq.listInstances(),
      window.oeq.credentialsDropped(),
    ]);
    state.instances = withSaved(instances);
    state.credentialsDropped = credentialsDropped;
    // The first saved site is merely what the dropdown lands on, not a
    // judgement about which one is safe -- the app cannot know that any more.
    // The banner names the selected site and its address on every screen, and
    // it is loud for all of them for exactly this reason (ui/banner.ts).
    state.instanceId = state.instances[0]?.id ?? '';
    state.setupInstanceId = state.instanceId;
    state.screen = initialScreen(state.instances.length > 0);
    render();
    if (state.screen === 'signin') void checkInstanceState();
  } catch (err) {
    renderFatal(errorMessage(err));
  }
}

void init();

export {};
