import type { ItemState, Manifest } from '../core/types.js';
import type { CollectionList, CurrentUser } from '../core/client.js';
import type { InvalidHeader } from '../core/schema.js';
import type { Profile } from '../core/extract/types.js';
import type { ExtractedRow } from '../core/extract/types.js';
import type { DuplicateFinding } from '../core/duplicates.js';
// `import type`, and it must stay that way: secrets.ts reaches `node:fs`, and
// this module is reachable from the sandboxed renderer. A type-only import is
// erased at compile time and never becomes a runtime require (see
// tests/desktop/rendererPurity.test.ts).
import type { ModelSettings, Settings, SettingsAuthMode } from './secrets.js';
// Also `import type`, and for the same reason: session.ts reaches the auth
// providers and the filesystem through them. The type is declared where it is
// produced (session.ts) and re-exported below, so the renderer can name what
// `signOut` answers with without importing a main-process module by path.
import type { SessionEndReport } from './session.js';

export type { SessionEndReport };

/**
 * One saved site, as the renderer sees it. Mirrors secrets.ts's `Instance`
 * exactly and carries NO credential: not the client secret, not the password.
 * See `toInstance` there for why the mapping is field-by-field.
 */
export interface InstanceChoice {
  /** `instanceKey` of the base url -- see core/instanceUrl.ts. */
  id: string;
  label: string;
  baseUrl: string;
  /**
   * How this site signs in. The renderer needs it for wording that would
   * otherwise be a lie -- Sign-in says "this opens an openEQUELLA sign-in
   * window", which is true of the authorization-code flow and false of
   * password mode, where the handler signs in directly with no browser.
   */
  authMode: SettingsAuthMode;
  /** Where the attachment uuid is written, or '' for no such field. See Instance. */
  attachmentUuidPath: string;
  /** Whether this is a live site. Drives the banner (ui/banner.ts). Defaults true. */
  live: boolean;
  /** The chosen collection's schema, or ''. The key to the offline schema cache. */
  schemaUuid: string;
}

/**
 * One site's stored model endpoint, as the renderer sees it.
 *
 * MIRRORS `ModelSettings` MINUS THE KEY, exactly as `InstanceChoice` mirrors
 * `Instance` minus the client secret and `getPassword` answers without the
 * password. The renderer needs three things from a stored endpoint -- enough to
 * say what is configured, the numbers the confirmation dialog is built from,
 * and the fact that there is a key to forget -- and none of those is the key
 * itself. It is written field by field for the same reason `toInstance` is: a
 * spread would carry a new secret into the renderer the day one was added to
 * `ModelSettings`, silently.
 */
export interface ModelChoice {
  baseUrl: string;
  model: string;
  budget: number;
  cap: number;
  timeoutMs: number;
  /** Whether a key is stored. The key itself never crosses this boundary. */
  hasApiKey: boolean;
}

/**
 * A fetched schema, flattened for the IPC boundary: `SchemaInfo.paths` is a
 * `Set`, and this crosses a process boundary where an array is the shape every
 * consumer can rely on.
 */
export interface SchemaSummary {
  uuid: string;
  /** As declared, with a leading slash: `/MWDL/title`. Null if undeclared. */
  namePath: string | null;
  /** The same path in spreadsheet-header form: `MWDL/title`. Null if undeclared. */
  titleHeader: string | null;
  /** Every valid xpath, leaves only, in spreadsheet-header form. */
  paths: string[];
}

/**
 * Instances that ship WITH the app. There are none, and that is the point:
 * this list used to declare BYU-Idaho's production and test addresses, and a
 * tool handed to another institution must not arrive knowing them. An
 * operator adds their own site on Setup and it is remembered per Windows
 * account (secrets.ts). `listInstances` below is where the app's real list
 * comes from.
 *
 * The empty literal and its mirror in ui/instances.ts are kept rather than
 * deleted: they are the mechanism by which anything ever shipped would reach
 * both the main process and the sandboxed renderer, and
 * tests/desktop/ui/instances.test.ts is the tripwire that stops the two
 * copies drifting.
 *
 * `redirectUri` is deliberately NOT a field here. It used to be, hard-coded
 * per instance -- and been guessed wrong TWICE in this project: one OAuth
 * client's registered value has no trailing slash, another's does. It is
 * registered per OAuth client by an administrator and is not derivable from
 * the base url at all, so it is per-instance STORED CONFIGURATION, collected
 * in Setup alongside the client ID/secret and persisted in secrets.ts's
 * `Settings` (see that module's doc comment). `buildConfig` (session.ts)
 * reads it from there, never from here.
 */
export const INSTANCES: InstanceChoice[] = [];

export interface ColumnReport {
  header: string;
  valid: boolean;
  suggestions: string[];
  /**
   * An annotation column such as `_source` or `_notes`: accepted, but never
   * uploaded as metadata. Reported separately so Review can say so, rather
   * than showing it as a valid metadata column and implying it gets sent.
   */
  ignored?: boolean;
  /** Set when the user has remapped this column in the UI. */
  mappedTo?: string;
}

export interface PlanReport {
  manifestPath: string;
  entryCount: number;
  columns: ColumnReport[];
  invalidHeaders: InvalidHeader[];
  warnings: string[];
  /** Rows that look like they have been uploaded to this collection before. */
  duplicates: DuplicateFinding[];
}

export interface RunProgress {
  done: number;
  total: number;
  fileName: string;
  status: string;
  error?: string;
}

export interface RunReport {
  created: number;
  failed: number;
  skipped: number;
  incomplete: number;
  interrupted: number;
  failures: { rowNumber: number; fileName: string; error: string }[];
}

export interface OeqApi {
  /** Every instance the operator has added, newest state from disk. Empty on a fresh install. */
  listInstances(): Promise<InstanceChoice[]>;
  /**
   * Whether credentials written by an older version of the store were found
   * and discarded on this launch, so Setup can explain the blank form rather
   * than looking broken. See secrets.ts's `credentialsDropped`.
   */
  credentialsDropped(): Promise<boolean>;
  hasSettings(instanceId: string): Promise<boolean>;
  /**
   * Add or update one instance, its per-site settings and its credentials. The
   * address comes from the operator; the id is derived from it in the main
   * process (one rule for what an address's key is) and returned, so the caller
   * can select what it just saved.
   *
   * The per-site fields are optional and an omitted one keeps whatever is
   * stored (secrets.ts). An explicit `''` attachment path is not an omission:
   * blank means "write no such field" and is stored as given.
   */
  saveInstance(
    instance: {
      label: string;
      baseUrl: string;
      attachmentUuidPath?: string;
      live?: boolean;
      schemaUuid?: string;
    },
    s: Settings,
  ): Promise<InstanceChoice>;
  clearSettings(): Promise<void>;

  /**
   * Store the openEQUELLA account for one instance. The password crosses into
   * the main process because the operator typed it here; it never comes back
   * -- see `getPassword`.
   */
  setPassword(args: { instanceId: string; username: string; password: string }): Promise<void>;
  /**
   * Who is signed in on this instance, or null when nothing is stored.
   *
   * DELIBERATELY NOT the password. Setup needs one thing from a stored
   * credential -- the name to show beside "Signed in as" and the fact that
   * there is something to forget -- and handing the renderer a plaintext
   * password it has no use for is an exposure with nothing bought for it. The
   * password stays in the main process, which is the only place that signs in
   * with it (session.ts's buildConfig).
   */
  getPassword(instanceId: string): Promise<{ username: string } | null>;
  /** Behind Setup's "Forget this password". Removing what is absent is not an error. */
  forgetPassword(instanceId: string): Promise<void>;

  /**
   * Store the language-model endpoint one site's extractions may use.
   *
   * REJECTS a budget, cap or time limit core's own guards refuse, with core's
   * own message -- see secrets.ts#setModel. That is what puts a mistyped box in
   * front of the operator on Setup instead of four hundred rows into a run.
   */
  setModel(args: { instanceId: string; settings: ModelSettings }): Promise<void>;
  /**
   * This site's model endpoint without its key, or null when none is stored.
   *
   * NULL IS WHAT MAKES THE FEATURE ABSENT, and every caller reads it that way:
   * no confirmation, no request, no mention. A site that has never been given
   * an endpoint behaves exactly as this tool did before the feature existed.
   */
  getModel(instanceId: string): Promise<ModelChoice | null>;
  /** Behind Setup's "Forget these model settings". Leaves the site alone. */
  forgetModel(instanceId: string): Promise<void>;

  /**
   * Sign in to one site and confirm who that made you.
   *
   * REJECTS on a guest session rather than resolving one. openEQUELLA answers
   * an unauthenticated request 200 as the guest identity, so a sign-in that
   * never took still produces a perfectly good `CurrentUser` -- and the app
   * would advance to the next screen reporting success. See handlers.ts's
   * `requireSignedIn`.
   */
  signIn(instanceId: string): Promise<CurrentUser>;
  /**
   * Sign out OF ONE SITE -- which ends the openEQUELLA session on the server,
   * then clears the cached token.
   *
   * `instanceId` is required, and is why this used to take no argument at all:
   * clearing the token is a complete logout only under the authorization-code
   * flow. Password mode never writes the token store, so the old handler
   * cleared a file that had never been written and left the session live while
   * the app returned to the sign-in screen. Only the renderer knows which site
   * it is on, so it has to say (handlers.ts).
   *
   * ANSWERS WITH WHAT IT COULD ESTABLISH, and never rejects for a failed
   * logout. `UsernamePasswordAuth.logout()` deliberately does not throw -- a
   * logout that failed is not worth interrupting anyone over, and the session
   * expires on its own -- but that must not be read as "it worked". The report
   * carries how many sessions were ended and how many the site never confirmed
   * (session.ts), so the renderer can tell the operator the truth instead of
   * showing the same signed-out screen either way (ui/signout.ts).
   */
  signOut(instanceId: string): Promise<SessionEndReport>;
  /**
   * Who is signed in on this instance, or null.
   *
   * NULL FOR A GUEST SESSION as well as for no token at all: this answers "is
   * anyone signed in", and guest is openEQUELLA's way of saying no. Returning
   * the guest user would put "Signed in as guest" and a Continue button in
   * front of the operator (ui/signin.ts).
   */
  currentUser(instanceId: string): Promise<CurrentUser | null>;

  /**
   * The collections this account can contribute to -- WITH the server's own
   * `available` count, not just the rows. An unauthenticated session gets 200
   * and an empty list, and the count is the only thing that tells that apart
   * from an account that genuinely holds CREATE_ITEM on nothing. See
   * `CollectionList.withheld`.
   */
  listCollections(instanceId: string): Promise<CollectionList>;

  /**
   * Read one schema from the site and remember it.
   *
   * Two jobs, on purpose. It answers Setup -- which needs the chosen
   * collection's valid xpaths to offer or check an attachment-uuid path
   * instead of making the operator know one -- and, on the way, it writes the
   * schema into the on-disk `SchemaCache` (core/schemaCache.ts). That cache is
   * what lets `src/core/extract/` validate the columns it produces WITHOUT a
   * network call, which is the whole reason the extract flow works for an
   * operator who has not signed in to anything.
   *
   * The schema uuid comes from the collection list entry
   * (`CollectionSummary.schemaUuid`), so choosing a collection resolves its
   * schema in one hop and nothing has to be configured twice.
   */
  fetchSchema(args: { instanceId: string; schemaUuid: string }): Promise<SchemaSummary>;

  chooseSpreadsheet(): Promise<string | null>;
  chooseFolder(): Promise<string | null>;

  /**
   * Copies the bundled starter-kit template CSV and sample file into a
   * folder the operator picks. Resolves to the destination path on success,
   * or null if the folder picker was cancelled -- same convention as
   * chooseSpreadsheet/chooseFolder above. Rejects (see handlers.ts) if the
   * destination already has either file, or can't be written to.
   */
  saveStarterKit(): Promise<string | null>;

  validate(args: { instanceId: string; sheetPath: string }): Promise<ColumnReport[]>;
  plan(args: {
    instanceId: string;
    collectionUuid: string;
    sheetPath: string;
    filesDir: string;
    itemState: ItemState;
    overrides: Record<string, string>;
  }): Promise<PlanReport>;

  /**
   * Mark rows as skipped in an already-planned manifest, just before running.
   * Returns how many were marked.
   *
   * Separate from `plan` because the operator makes these choices AFTER seeing
   * the plan. Re-planning to apply them would re-query every row for nothing.
   */
  applyDuplicateChoices(args: { manifestPath: string; skipRows: number[] }): Promise<number>;

  run(args: { manifestPath: string; instanceId: string }): Promise<RunReport>;
  retryFailed(manifestPath: string): Promise<void>;
  loadManifest(manifestPath: string): Promise<Manifest>;

  /**
   * Read a folder: what is there, and what can be mapped from. Samples the
   * first few documents. `instanceId` picks whose schema the proposed starter
   * profile is built against -- same cached-then-bundled resolution as
   * `schemaPaths`, so the starter and the Add-column picker cannot disagree
   * about which columns are valid.
   */
  extractScan(dir: string, instanceId?: string): Promise<ExtractScan>;
  /** First few rows for the live preview. Cheap enough to call on every edit. */
  extractPreview(args: { dir: string; profile: Profile }): Promise<ExtractedRow[]>;
  /**
   * Write the spreadsheet.
   *
   * `instanceId` says whose stored model endpoint the run may use, and is the
   * SAME id the renderer's confirmation was built from (`getModel`). Two reads
   * of one per-instance entry: without it the operator could be shown one
   * endpoint and their documents sent to another. Omitted, or naming an
   * instance with nothing stored, means no model -- and every column that asked
   * for one says so in `_notes`.
   */
  extractRun(args: {
    dir: string;
    profile: Profile;
    outPath: string;
    instanceId?: string;
    /**
     * That the operator has been shown what would be sent and agreed to it.
     *
     * THE SIDE THAT SENDS MUST KNOW SOMEBODY AGREED, and before this it did not:
     * the main process resolved the endpoint from its own read of the store and
     * sent, carrying no evidence of consent and unable to tell an approved run
     * from an unapproved one. The two sides are independent reads of the same
     * store WITH DIFFERENT FAILURE MODES -- the renderer treated a throw from
     * `getModel` as "no model, carry on without asking", the main process treats
     * a throw as "no model, send nothing" -- so a transient IPC failure on the
     * renderer's read produced a full hosted send with no dialog at any point.
     * They agreed on the interpretation; they did not agree on the observation,
     * and only the observation gated the send.
     *
     * ABSENT OR FALSE MEANS SEND NOTHING. The default is the safe direction, so
     * a caller that has not thought about consent cannot spend money by
     * omission, and the renderer's unreadable-store case now declines to send
     * rather than sending unasked.
     */
    modelApproved?: boolean;
  }): Promise<ExtractRunReport>;
  /**
   * Every valid schema xpath, for the Add-column picker.
   *
   * `instanceId` selects WHOSE schema. Given one whose schema has been fetched
   * and cached (see `fetchSchema`), extraction validates against that site's
   * real schema, offline. Without a cache -- a fresh install, another
   * institution's site, an operator who has not signed in -- it falls back to
   * the schema export bundled with the app rather than refusing: blocking the
   * offline half of the tool on a network call the operator did not ask for
   * would trade a real capability for a check.
   */
  schemaPaths(instanceId?: string): Promise<string[]>;
  /**
   * The xpath the schema declares as the item's name, or null if it declares
   * none. The Add-column picker offers that path's own section first, since it
   * holds the fields nearly every item needs. Parsed in the main process:
   * reading the schema reaches `node:fs`, which the renderer cannot. Same
   * cached-then-bundled resolution as `schemaPaths`.
   */
  schemaNamePath(instanceId?: string): Promise<string | null>;
  /** Templates shipped with the app, for the "start from" choice. */
  listTemplates(): Promise<{ id: string; label: string }[]>;
  /** A shipped template, validated, ready to use as the starting profile. */
  loadTemplate(id: string): Promise<Profile>;
  /** Open a profile the operator picks. Null if cancelled. */
  openProfile(): Promise<{ path: string; profile: Profile } | null>;
  /** Save a profile where the operator picks. Returns the path, or null if cancelled. */
  saveProfileAs(profile: Profile): Promise<string | null>;
  /** Ask where to write the spreadsheet. Null if cancelled. */
  chooseCsvPath(): Promise<string | null>;
  /** Reveal a file in the OS file manager. */
  openPath(path: string): Promise<void>;

  onProgress(cb: (p: RunProgress) => void): void;
}

/** What a folder actually contains, and what evidence is available to map from. */
export interface ExtractScan {
  /** Supported files, sorted. */
  supported: string[];
  /** Files that will not be read, each with a reason. */
  skipped: { file: string; reason: string }[];
  /** `Label:` names found in the sampled documents, deduplicated. */
  labels: string[];
  /** Document properties present in the sampled documents, e.g. ['title','created']. */
  properties: string[];
  /**
   * Table column headers found in the sampled documents. Word files from this
   * institution commonly hold their metadata as a header row and one row of
   * values rather than as `Label: value` prose.
   */
  tableColumns: string[];
  /** Headings found in the sampled documents that a description is often written under. */
  sections: string[];
  /**
   * A starter profile proposed for this folder.
   *
   * Built in the main process on purpose. It comes from
   * `core/extract/suggest.ts`, which reaches `node:path` and the document
   * readers -- and the renderer is sandboxed with no Node access, so importing
   * it there kills the whole module graph and the window renders blank. See
   * `tests/desktop/rendererPurity.test.ts`, which now fails the build rather
   * than letting that happen again.
   */
  starter: Profile;
}

export interface ExtractRunReport {
  outPath: string;
  written: number;
  /**
   * Rows with something genuinely wrong -- the triage number.
   *
   * A MODEL WRITE IS NOT COUNTED HERE. Every one carries a note, so counting
   * notes would report "400 of 400 need review" the moment a model is enabled
   * and bury the batch's one genuine failure, which is the loss `flagIfEmpty`
   * exists to prevent. See core/ai/review.ts.
   */
  flagged: number;
  /** Rows a language model wrote into. Its own number rather than hidden: a
   *  machine wrote text that is about to become a permanent record. */
  aiWritten: number;
}

export const CHANNELS = {
  listInstances: 'oeq:listInstances',
  credentialsDropped: 'oeq:credentialsDropped',
  hasSettings: 'oeq:hasSettings',
  saveInstance: 'oeq:saveInstance',
  clearSettings: 'oeq:clearSettings',
  setPassword: 'oeq:setPassword',
  getPassword: 'oeq:getPassword',
  forgetPassword: 'oeq:forgetPassword',
  setModel: 'oeq:setModel',
  getModel: 'oeq:getModel',
  forgetModel: 'oeq:forgetModel',
  signIn: 'oeq:signIn',
  signOut: 'oeq:signOut',
  currentUser: 'oeq:currentUser',
  listCollections: 'oeq:listCollections',
  fetchSchema: 'oeq:fetchSchema',
  chooseSpreadsheet: 'oeq:chooseSpreadsheet',
  chooseFolder: 'oeq:chooseFolder',
  saveStarterKit: 'oeq:saveStarterKit',
  validate: 'oeq:validate',
  plan: 'oeq:plan',
  applyDuplicateChoices: 'oeq:applyDuplicateChoices',
  run: 'oeq:run',
  retryFailed: 'oeq:retryFailed',
  loadManifest: 'oeq:loadManifest',
  progress: 'oeq:progress',
  extractScan: 'oeq:extractScan',
  extractPreview: 'oeq:extractPreview',
  extractRun: 'oeq:extractRun',
  schemaPaths: 'oeq:schemaPaths',
  schemaNamePath: 'oeq:schemaNamePath',
  listTemplates: 'oeq:listTemplates',
  loadTemplate: 'oeq:loadTemplate',
  openProfile: 'oeq:openProfile',
  saveProfileAs: 'oeq:saveProfileAs',
  chooseCsvPath: 'oeq:chooseCsvPath',
  openPath: 'oeq:openPath',
} as const;
