import type { ItemState, Manifest } from '../core/types.js';
import type { CollectionSummary, CurrentUser } from '../core/client.js';
import type { InvalidHeader } from '../core/schema.js';
import type { Profile } from '../core/extract/types.js';
import type { ExtractedRow } from '../core/extract/types.js';
import type { DuplicateFinding } from '../core/duplicates.js';
// `import type`, and it must stay that way: secrets.ts reaches `node:fs`, and
// this module is reachable from the sandboxed renderer. A type-only import is
// erased at compile time and never becomes a runtime require (see
// tests/desktop/rendererPurity.test.ts).
import type { Settings } from './secrets.js';

export interface InstanceChoice {
  /** `instanceKey` of the base url -- see core/instanceUrl.ts. */
  id: string;
  label: string;
  baseUrl: string;
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
   * Add or update one instance and its credentials. The address comes from
   * the operator; the id is derived from it in the main process (one rule for
   * what an address's key is) and returned, so the caller can select what it
   * just saved.
   */
  saveInstance(instance: { label: string; baseUrl: string }, s: Settings): Promise<InstanceChoice>;
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

  signIn(instanceId: string): Promise<CurrentUser>;
  signOut(): Promise<void>;
  currentUser(instanceId: string): Promise<CurrentUser | null>;

  listCollections(instanceId: string): Promise<CollectionSummary[]>;

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

  /** Read a folder: what is there, and what can be mapped from. Samples the first few documents. */
  extractScan(dir: string): Promise<ExtractScan>;
  /** First few rows for the live preview. Cheap enough to call on every edit. */
  extractPreview(args: { dir: string; profile: Profile }): Promise<ExtractedRow[]>;
  /** Write the spreadsheet. */
  extractRun(args: { dir: string; profile: Profile; outPath: string }): Promise<ExtractRunReport>;
  /** Every valid schema xpath, for the Add-column picker. */
  schemaPaths(): Promise<string[]>;
  /**
   * The xpath the schema declares as the item's name, or null if it declares
   * none. The Add-column picker offers that path's own section first, since it
   * holds the fields nearly every item needs. Parsed in the main process:
   * reading the schema reaches `node:fs`, which the renderer cannot.
   */
  schemaNamePath(): Promise<string | null>;
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
  flagged: number;
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
  signIn: 'oeq:signIn',
  signOut: 'oeq:signOut',
  currentUser: 'oeq:currentUser',
  listCollections: 'oeq:listCollections',
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
