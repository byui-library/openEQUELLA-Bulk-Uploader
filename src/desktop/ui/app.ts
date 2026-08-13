import type { OeqApi, ColumnReport, InstanceChoice, PlanReport, RunProgress, RunReport } from '../ipc.js';
import type { CurrentUser, CollectionSummary } from '../../core/client.js';
import type { ItemState } from '../../core/types.js';
import { initialScreen, nextScreen, settingsReturnTo, type Screen } from './state.js';
import { errorMessage } from './errors.js';
import { renderBanner } from './banner.js';
import {
  attachmentPathToFill,
  renderSetup,
  type SetupFields,
  type SetupTextField,
} from './screens/setup.js';
// `import type`: secrets.ts reaches `node:fs` and this module runs in the
// sandboxed renderer, where a runtime import of it would blank the window.
import type { Settings, SettingsAuthMode } from '../secrets.js';
import { signOutNotice } from './signout.js';
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
  // Which screen Setup was opened FROM, so saving can put the operator back
  // there. Null for the ordinary route, which lands on Sign-in as it always
  // has. Reset by seedSetupForm, so pointing Setup at another site drops it
  // and the return falls back to Sign-in (see settingsReturnTo).
  setupEnteredFrom: Screen | null;
  // Everything typed on Setup. Held here rather than in the DOM because the
  // screen re-renders on every keystroke and on every change of sign-in
  // method, and an innerHTML re-render destroys the inputs (screens/setup.ts).
  setupFields: SetupFields;
  // Whether the operator has edited the redirect URL themselves. Until they
  // do it follows the address, which is the only starting point non-technical
  // staff can be given for a field they cannot derive.
  setupRedirectTouched: boolean;
  // The username of the account stored for `setupInstanceId`, or null. The
  // password itself never comes back from the main process (ipc.ts).
  setupStoredUsername: string | null;
  // The collections `setupInstanceId` can contribute to, and why they could
  // not be read. Null is "not read"; an EMPTY ARRAY is "this account can
  // create nothing", which is a real state the screen states plainly rather
  // than rendering as an empty dropdown (screens/setup.ts).
  setupCollections: CollectionSummary[] | null;
  setupCollectionsError: string | null;
  // Whether the server said collections exist and handed none over -- which
  // means this session is not signed in, not that there are none. See
  // core/discovery.ts's CollectionList.withheld.
  setupCollectionsWithheld: boolean;
  // Every valid xpath in the chosen collection's schema, or null for "not
  // checked". Fetched through window.oeq.fetchSchema, which also leaves the
  // schema in the on-disk cache extraction reads offline (ipc.ts).
  setupSchemaPaths: string[] | null;
  // Whether the attachment path in the form was put there by this tool rather
  // than typed, so the screen can say so (screens/setup.ts's `filled` verdict).
  //
  // IT IS ALSO THE ONLY RECORD THAT A FILL HAS HAPPENED. Nothing else can tell
  // "filled and then cleared" from "never filled": both are an empty box beside
  // a schema with one candidate. Set only by handleSetupCollectionChange, and
  // cleared the moment the operator touches the field.
  setupAttachmentPathFilled: boolean;
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
  // As setupCollectionsWithheld: an empty list from a session that is not
  // signed in is not an empty list, and the dropdown said "No collections
  // match" to an operator who was not signed in at all.
  collectionsWithheld: boolean;
  collectionQuery: string;
  collectionUuid: string | null;
  collectionName: string | null;
  starterKitSaving: boolean;
  starterKitMessage: string | null;

  // Review, Confirm, Progress and Results state all lives in BatchState.
}

/**
 * An empty Setup form. `authMode: 'password'` is the default because an
 * ordinary openEQUELLA account is what a new institution can use immediately;
 * OAuth is for the SSO-backed sites and lives behind Advanced.
 *
 * No credential is ever seeded from the store -- not the client secret, and
 * not the password. A stored password is shown as "Signed in as ..." with a
 * Forget button (screens/setup.ts) and never rendered back into a field.
 */
function blankSetupFields(): SetupFields {
  return {
    baseUrl: '',
    label: '',
    authMode: 'password',
    clientId: '',
    clientSecret: '',
    redirectUri: '',
    username: '',
    password: '',
    // Blank means "write no such field" -- a choice, not an unfilled box, and
    // never guessed at from nothing. It is filled in only once a collection has
    // been chosen and its schema turns out to declare exactly one such field
    // (handleSetupCollectionChange), which is evidence rather than a guess.
    attachmentUuidPath: '',
    collectionUuid: '',
    // A new site is assumed LIVE until the operator says otherwise: being
    // warned about a sandbox is a nuisance; not being warned about production
    // is an unrecoverable batch (ui/banner.ts).
    live: true,
  };
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
    setupEnteredFrom: null,
    setupFields: blankSetupFields(),
    setupRedirectTouched: false,
    setupStoredUsername: null,
    setupCollections: null,
    setupCollectionsError: null,
    setupCollectionsWithheld: false,
    setupSchemaPaths: null,
    setupAttachmentPathFilled: false,
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
    collectionsWithheld: false,
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
        fields: state.setupFields,
        storedUsername: state.setupStoredUsername,
        collections: state.setupCollections,
        collectionsError: state.setupCollectionsError,
        collectionsWithheld: state.setupCollectionsWithheld,
        schemaPaths: state.setupSchemaPaths,
        attachmentPathFilled: state.setupAttachmentPathFilled,
        error: state.setupError,
        saving: state.setupSaving,
        // Null on first run and after "Change credentials…", where there is
        // nowhere behind Setup and no Back is rendered at all.
        returnTo: state.setupEnteredFrom,
        onBack: handleSetupBack,
        onInstanceChange: handleSetupInstanceChange,
        onFieldChange: handleSetupFieldChange,
        onAuthModeChange: handleSetupAuthModeChange,
        onCollectionChange: handleSetupCollectionChange,
        onLiveChange: handleSetupLiveChange,
        onForgetPassword: handleForgetPassword,
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
        onSiteSettings: () => handleSiteSettings('signin'),
        onResetSettings: handleResetSettings,
      });
      break;
    case 'choose':
      renderChoose(app, {
        instanceLabel: currentInstance()?.label ?? state.instanceId,
        collections: state.collections,
        collectionsError: state.collectionsError,
        collectionsWithheld: state.collectionsWithheld,
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
        // The NON-DESTRUCTIVE route, exactly as Sign-in's own settings link.
        // Wiring this to handleResetSettings would wipe every saved site from
        // the middle of a batch.
        onSiteSettings: () => handleSiteSettings('choose'),
        // The SAME handler Sign-in's Sign out uses -- it ends the openEQUELLA
        // session on the server, not just the local token, and says so when the
        // site would not confirm it. A second sign-out path written for this
        // screen is exactly how a live session gets left behind.
        onSignOut: handleSignOut,
        onExtract: () => {
          // The extract flow owns its own state and render loop; app.ts hands
          // over the root element and gets it back on exit. Deliberately not
          // folded into this file's state machine -- see the plan's rationale.
          const root = requireEl('app');
          const controller = createExtractController({
            api: window.oeq,
            // So the columns are validated against THIS site's schema when one
            // has been cached, rather than the bundled export -- which is
            // BYU-Idaho's, and correct nowhere else.
            instanceId: state.instanceId,
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
          instanceLabel: currentInstance()?.label ?? state.instanceId,
          retrying: state.retrying,
          error: state.resultsError,
          onRetryFailed: handleRetryFailed,
          onAnotherBatch: handleAnotherBatch,
          // Both non-destructive, both the same handlers Choose uses. Done was
          // a dead end: another spreadsheet, a collection link, and nothing
          // else -- so changing a setting or moving to another site meant
          // closing and reopening the app.
          onSiteSettings: () => handleSiteSettings('results'),
          onSignOut: handleSignOut,
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

/**
 * Point Setup at another saved site (or at "Add another site…").
 *
 * The form is reseeded from that site's own address and name, and every
 * credential field is cleared: a client secret or a password belonging to one
 * site must never be left sitting in a form that is about to be saved against
 * a different one.
 */
function seedSetupForm(id: string): void {
  state.setupInstanceId = id;
  state.setupError = null;
  // Whoever is sending the operator to Setup says where they came from, right
  // after this call. Cleared here so pointing Setup at a DIFFERENT site drops
  // the return: the collection, spreadsheet and folder waiting on Choose
  // belong to the site the app was pointed at, not to this one.
  state.setupEnteredFrom = null;
  // Both belong to whichever site was previously selected. Left standing they
  // would have the attachment path checked against another site's schema, and
  // a wrong "found in the schema" is worse than no answer at all.
  state.setupCollections = null;
  state.setupCollectionsError = null;
  state.setupSchemaPaths = null;
  // The path below is about to be seeded from this site's own saved settings,
  // which this tool did not fill in on this pass -- it read it back off disk.
  state.setupAttachmentPathFilled = false;
  const selected = instanceById(id);
  state.setupFields = {
    ...blankSetupFields(),
    baseUrl: selected?.baseUrl ?? '',
    label: selected?.label ?? '',
    // Per-site settings, seeded from what was stored. `live` falls back to
    // TRUE for a site not saved yet -- assumed live until said otherwise.
    attachmentUuidPath: selected?.attachmentUuidPath ?? '',
    live: selected?.live ?? true,
    // Sensible starting point for a field non-technical staff cannot fill in
    // from nothing: the site's own address. Pre-filled into the form, where
    // the operator can see and correct it before saving -- never substituted
    // behind their back at sign-in time, which is how this value got
    // hard-coded wrong twice (see secrets.ts's OAuthSettings.redirectUri).
    redirectUri: selected?.baseUrl ?? '',
  };
  state.setupRedirectTouched = false;
  state.setupStoredUsername = null;
}

function handleSetupInstanceChange(id: string): void {
  seedSetupForm(id);
  render();
  void refreshStoredUsername();
  void refreshSetupCollections();
}

/**
 * The collections the site Setup is pointed at can actually be contributed
 * to, for the dropdown that replaced a uuid box.
 *
 * Only for a SAVED site: the list comes from openEQUELLA and needs stored
 * credentials to ask for it, so a site being added for the first time simply
 * has no list yet -- the screen says so rather than showing an error for a
 * request that was never sensible to make.
 *
 * A failure is recorded as a failure, never as an empty list. "This account
 * can create nothing" and "the list could not be read" have no fix in common
 * (an administrator grants a privilege; the other is a host that cannot be
 * reached), and the same distinction is made in core/preflight.ts.
 */
async function refreshSetupCollections(): Promise<void> {
  const instanceId = state.setupInstanceId;
  if (instanceId === '') {
    state.setupCollections = null;
    state.setupCollectionsError = null;
    return;
  }
  state.setupCollections = null;
  state.setupCollectionsError = null;
  state.setupCollectionsWithheld = false;
  render();
  let collections: CollectionSummary[] | null = null;
  let withheld = false;
  let error: string | null = null;
  try {
    const list = await window.oeq.listCollections(instanceId);
    collections = list.collections;
    withheld = list.withheld;
  } catch (err) {
    error = errorMessage(err);
  }
  // The operator may have switched sites while this was in flight; another
  // site's collections must never be attributed to the one now on screen.
  if (state.setupInstanceId !== instanceId) return;
  state.setupCollections = collections;
  state.setupCollectionsError = error;
  state.setupCollectionsWithheld = withheld;
  render();
}

/**
 * Picking a collection reads its schema -- and that read is what leaves the
 * schema in the on-disk cache `src/core/extract/` later validates against
 * offline (ipc.ts's fetchSchema). The schema uuid comes off the collection's
 * own list entry, so this costs one request and nothing has to be configured
 * twice.
 *
 * A schema that cannot be read leaves `setupSchemaPaths` null, which the
 * screen reports as "not checked" -- never as a path that turned out to be
 * fine.
 *
 * THIS IS ALSO THE ONE PLACE THE ATTACHMENT PATH IS FILLED IN, and it is here
 * rather than in the renderer for a reason that is easy to get wrong. Setup
 * re-renders on every keystroke anywhere on it, so a fill performed while
 * rendering would run again immediately after the operator cleared the box --
 * they would clear it, type a character in the site's name, and watch the path
 * come back. Recording nothing on purpose would be impossible.
 *
 * Arriving with the schema makes it a consequence of CHOOSING A COLLECTION,
 * which happens once, is something the operator did, and is the only moment new
 * evidence about the field exists.
 */
function handleSetupCollectionChange(uuid: string): void {
  state.setupFields = { ...state.setupFields, collectionUuid: uuid };
  state.setupSchemaPaths = null;
  // Whatever is in the box now belongs to the previous collection's schema, if
  // anything filled it at all. Nothing here empties the FIELD -- a value the
  // operator can see is theirs to keep or clear -- only the claim that this
  // tool put it there.
  state.setupAttachmentPathFilled = false;
  render();
  const chosen = state.setupCollections?.find((c) => c.uuid === uuid);
  const schemaUuid = chosen?.schemaUuid ?? '';
  if (schemaUuid === '') return;
  const instanceId = state.setupInstanceId;
  void window.oeq.fetchSchema({ instanceId, schemaUuid }).then(
    (schema) => {
      if (state.setupInstanceId !== instanceId || state.setupFields.collectionUuid !== uuid) return;
      state.setupSchemaPaths = schema.paths;
      // Null unless the schema declares exactly one such field AND the box is
      // empty; screens/setup.ts's attachmentPathToFill holds both rules and
      // says why each one is there.
      const fill = attachmentPathToFill(schema.paths, state.setupFields.attachmentUuidPath);
      if (fill !== null) {
        state.setupFields = { ...state.setupFields, attachmentUuidPath: fill };
        state.setupAttachmentPathFilled = true;
      }
      render();
    },
    () => {
      // Unread stays unread, and unread fills nothing. See the doc comment.
    },
  );
}

function handleSetupLiveChange(live: boolean): void {
  state.setupFields = { ...state.setupFields, live };
  render();
}

function handleSetupFieldChange(field: SetupTextField, value: string): void {
  state.setupFields = { ...state.setupFields, [field]: value };
  if (field === 'redirectUri') state.setupRedirectTouched = true;
  // Once they have touched it, it is theirs -- whether they changed it, or
  // cleared it to record nothing. Clearing this is what stops the screen
  // claiming to have filled in a value the operator has since edited, and
  // nothing sets it again short of another collection change.
  if (field === 'attachmentUuidPath') state.setupAttachmentPathFilled = false;
  // Keep the redirect URL following the address until the operator edits it
  // themselves, so what is saved is always exactly what is on screen.
  if (field === 'baseUrl' && !state.setupRedirectTouched) {
    state.setupFields.redirectUri = value.trim().replace(/\/+$/, '');
  }
  render();
}

function handleSetupAuthModeChange(mode: SettingsAuthMode): void {
  state.setupFields = { ...state.setupFields, authMode: mode };
  state.setupError = null;
  render();
}

/**
 * Whether the instance Setup is pointed at has an account stored, and whose.
 *
 * Fails soft: "nobody is signed in" is the honest answer when the store cannot
 * say otherwise, and it is also the safe one -- it shows the password fields
 * rather than a Forget button for a credential that may not exist.
 */
async function refreshStoredUsername(): Promise<void> {
  const instanceId = state.setupInstanceId;
  if (instanceId === '') {
    state.setupStoredUsername = null;
    return;
  }
  let stored: { username: string } | null = null;
  try {
    stored = await window.oeq.getPassword(instanceId);
  } catch {
    stored = null;
  }
  // The operator may have switched sites while this was in flight; a stale
  // answer for the previous site must never be attributed to the new one.
  if (state.setupInstanceId !== instanceId) return;
  state.setupStoredUsername = stored?.username ?? null;
  // A stored account is also the honest default for HOW this site signs in:
  // it is the one thing Setup can see about a saved credential.
  if (stored) state.setupFields = { ...state.setupFields, authMode: 'password' };
  render();
}

/**
 * "Forget this password". Removes the stored account for this site and puts
 * the username and password fields back, so the operator can enter another.
 * Distinct from "Reset settings", which wipes every site the app knows.
 */
async function handleForgetPassword(): Promise<void> {
  try {
    await window.oeq.forgetPassword(state.setupInstanceId);
  } catch (err) {
    state.setupError = errorMessage(err);
    render();
    return;
  }
  state.setupStoredUsername = null;
  state.setupFields = { ...state.setupFields, username: '', password: '' };
  state.setupError = null;
  render();
}

async function handleSaveSettings(
  instance: {
    label: string;
    baseUrl: string;
    attachmentUuidPath: string;
    live: boolean;
    schemaUuid: string;
  },
  settings: Settings,
): Promise<void> {
  if (instance.baseUrl === '') {
    state.setupError = 'Enter the address of your openEQUELLA site.';
    render();
    return;
  }
  if (settings.authMode === 'password') {
    // An empty password is allowed only when one is already stored, which is
    // the case the form shows as "Signed in as ..." with no password box at
    // all -- secrets.ts then leaves the stored one alone.
    if (settings.username === '' || (settings.password === '' && state.setupStoredUsername === null)) {
      state.setupError = 'Enter the username and password for your openEQUELLA account.';
      render();
      return;
    }
  } else if (settings.clientId === '' || settings.clientSecret === '' || settings.redirectUri === '') {
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
    // Decided BEFORE state.instanceId is repointed below, because the question
    // is whether this save stayed on the site the waiting Choose selections
    // belong to. A save that landed somewhere else goes to Sign-in, where a
    // site is chosen, rather than back to a batch built against another one.
    const returnTo = settingsReturnTo({
      enteredFrom: state.setupEnteredFrom,
      savedInstanceId: saved.id,
      activeInstanceId: state.instanceId,
    });
    state.setupEnteredFrom = null;
    state.instances = withSaved(await window.oeq.listInstances());
    state.setupSaving = false;
    state.setupError = null;
    state.setupInstanceId = saved.id;
    // Neither secret stays in the renderer once it has been stored. Setup
    // shows a saved password as "Signed in as ..." (refreshed below), never
    // back in a field, and the client secret has never been rendered back.
    state.setupFields = { ...state.setupFields, password: '', clientSecret: '' };
    void refreshStoredUsername();
    // The credentials this site needed may only just have arrived, so the
    // collections it can contribute to are askable for the first time.
    void refreshSetupCollections();
    // Nothing left to explain: the discarded store has just been overwritten.
    state.credentialsDropped = false;
    // Point the rest of the app at the instance that was just configured --
    // landing back on Sign-in still pointed at a DIFFERENT (uncredentialed)
    // instance would look like nothing had happened.
    state.instanceId = saved.id;
    state.screen = nextScreen('setup', { type: 'settingsSaved', returnTo });
    render();
    // Back on Choose, the collection list is re-read rather than trusted: the
    // address, the account or the credentials may have just changed under it.
    // The chosen uuid survives in state, so the dropdown comes back with the
    // same collection selected, and the spreadsheet and folder never moved.
    if (returnTo === 'choose') void loadCollections();
    else void checkInstanceState();
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
 * STORES nothing and DELETES nothing -- it only points Setup at the instance
 * that's missing credentials, seeding the form from that site's own address,
 * so the OTHER instance's saved credentials, if any, are left completely
 * untouched.
 */
function handleAddCredentials(): void {
  seedSetupForm(state.instanceId);
  state.screen = nextScreen('signin', { type: 'addCredentials' });
  render();
  void refreshStoredUsername();
  void refreshSetupCollections();
}

/**
 * "Settings for {site}…" / "Site settings for {site}…" -- Setup for the
 * selected site, with nothing cleared.
 *
 * NON-DESTRUCTIVE, and that is the whole point of it existing separately from
 * `handleResetSettings` below: the per-site settings (which collection's
 * schema, where the attachment uuid goes, whether it is live) live on Setup,
 * and the only other route there was "Change credentials…", which wipes every
 * saved site first. A setting an operator can only change by destroying their
 * credentials is a setting they will not change.
 *
 * `from` is the screen the operator is standing on, passed rather than assumed
 * because there are now two of them. It is what the transition table is told
 * (state.ts is the record of how this app moves, and hardcoding 'signin' from
 * Choose would make that record a lie) and it is what decides where saving
 * puts them back -- see `settingsReturnTo`.
 *
 * REACHABLE FROM CHOOSE because the operator found the gap circular while
 * installing the tool: Setup can only suggest an attachment path once a
 * collection has been chosen, since that is when a schema can be read, and the
 * collection is chosen on Choose -- which had no way back.
 */
function handleSiteSettings(from: Screen): void {
  seedSetupForm(state.instanceId);
  state.setupEnteredFrom = from;
  state.screen = nextScreen(from, { type: 'siteSettings' });
  render();
  void refreshStoredUsername();
  void refreshSetupCollections();
}

/**
 * Setup's Back: leave for the screen the operator came in from, saving nothing.
 *
 * SETUP WAS A ONE-WAY DOOR. "Save credentials" was its only control, so an
 * operator who opened it from Choose to check one setting could leave only by
 * saving -- which is what somebody who came to LOOK does not want to do, and
 * which repoints the whole app at whatever site the form happens to name.
 *
 * NOTHING IS CLEARED AND NOTHING IS WRITTEN. Not the store, not the stored
 * password, not the instance list. The typed form IS discarded, and the button
 * says so; every other route out of a screen in this app that discards typed
 * work (Review's Back, Confirm's Back) reads the same way.
 *
 * NOT ROUTED THROUGH `nextScreen`, and deliberately: it moves to a screen
 * carried in state rather than one the transition table decides, which is
 * exactly what `handleReviewBack` and `handleConfirmBack` already do. An event
 * whose answer is "whatever the caller was holding" would add a row to that
 * table that describes nothing.
 *
 * `setupEnteredFrom` is null on first run and after "Change credentials…", and
 * the button is not rendered in either case (screens/setup.ts). The guard is
 * belt and braces for a click that arrives anyway.
 */
function handleSetupBack(): void {
  const back = state.setupEnteredFrom;
  if (back === null) return;
  state.setupEnteredFrom = null;
  // A validation message about a save that is no longer happening.
  state.setupError = null;
  state.screen = back;
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

/**
 * Sign out of the site currently selected, and go back to the sign-in screen.
 *
 * `state.instanceId` is passed because the main process cannot know it: sign
 * out now ends the openEQUELLA session for that one site, not just the cached
 * token, and the token store holds no instance of its own (handlers.ts).
 *
 * THE SCREEN CHANGES EVEN IF THE HANDLER THROWS. The operator asked to be
 * signed out, and leaving them on a screen that says they are signed in would
 * be the same lie in the other direction; the error is surfaced on the sign-in
 * screen they land on.
 *
 * A throw here does NOT mean the logout PUT failed -- that case cannot reach
 * this catch, and is handled in the paragraph below. This catches the
 * unexpected: the IPC call itself rejecting, or clearing the local token store
 * failing. Both leave the operator signed out on this machine regardless,
 * which is why the screen still changes.
 *
 * AND IT CHANGES WHEN THE LOGOUT WAS MERELY UNCONFIRMED -- with a notice. That
 * case does not throw and never will (core/passwordAuth.ts's `logout()` is
 * deliberately never-throwing), so it used to arrive here indistinguishable
 * from success and the operator read "signed out" over a session that might
 * still be live. `signOutNotice` turns the report into the one sentence they
 * can act on, in the same place the sign-out error already appears, so nothing
 * blocks and nothing is claimed that has not been established.
 */
async function handleSignOut(): Promise<void> {
  // NEVER MID-BATCH. Sign out is now offered from Choose and Results as well as
  // Sign-in, and the runner uploads through the very session this ends: cutting
  // it half way through a batch strands rows in `uploading` -- the status the
  // runner deliberately refuses to guess about, which then has to be checked by
  // hand in openEQUELLA, item by item, with no undo available for the ones that
  // did land.
  //
  // The real protection is that the Progress screen renders no such control
  // (screens/progress.ts has no buttons at all, and a test pins that). This is
  // the second line: a stale listener surviving a re-render, or a control added
  // to that screen later by somebody applying the pattern uniformly, still
  // cannot end the session under a running batch. Same shape as the
  // `instanceHasSettings` guard in handleSignIn above.
  if (state.screen === 'progress' || state.uploading) return;
  try {
    // Null on a clean sign-out, which also clears any error left from an
    // earlier attempt -- see ui/signout.ts.
    state.signinError = signOutNotice(await window.oeq.signOut(state.instanceId));
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
  seedSetupForm('');
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
  state.collectionsWithheld = false;
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
  state.collectionsWithheld = false;
  render();
  try {
    const list = await window.oeq.listCollections(state.instanceId);
    state.collections = list.collections;
    // An empty list the server admits it withheld is not an empty list. The
    // dropdown used to read "showing 0 of 0 -- No collections match" for a
    // session that was not signed in at all (screens/choose.ts).
    state.collectionsWithheld = list.withheld;
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
    seedSetupForm(state.instanceId);
    state.screen = initialScreen(state.instances.length > 0);
    render();
    if (state.screen === 'signin') void checkInstanceState();
    else void refreshStoredUsername();
  } catch (err) {
    renderFatal(errorMessage(err));
  }
}

void init();

export {};
