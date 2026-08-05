import type { ItemState, Manifest } from '../core/types.js';
import type { CollectionSummary, CurrentUser } from '../core/client.js';
import type { InvalidHeader } from '../core/schema.js';
import type { Profile } from '../core/extract/types.js';
import type { ExtractedRow } from '../core/extract/types.js';

export interface InstanceChoice {
  id: 'production' | 'test';
  label: string;
  baseUrl: string;
}

/**
 * Both instances are declared here rather than typed by the user. The
 * collection uuid is byte-identical on test and production, so the base url is
 * the ONLY thing distinguishing them -- a free-text field would be a footgun.
 *
 * `redirectUri` is deliberately NOT a field here. It used to be, hard-coded
 * per instance -- and been guessed wrong TWICE in this project: production
 * has no trailing slash, one test OAuth client had one, the operator's next
 * dedicated test client doesn't. It is registered per OAuth client by an
 * administrator and is not derivable from the base url at all, so it is now
 * per-instance STORED CONFIGURATION, collected in Setup alongside the client
 * ID/secret and persisted in secrets.ts's `Settings` (see that module's doc
 * comment for the migration story). `buildConfig` (session.ts) reads it from
 * there, never from here.
 */
export const INSTANCES: InstanceChoice[] = [
  { id: 'production', label: 'Production', baseUrl: 'https://content.byui.edu' },
  { id: 'test', label: 'Test', baseUrl: 'https://content-test.byui.edu' },
];

export interface ColumnReport {
  header: string;
  valid: boolean;
  suggestions: string[];
  /** Set when the user has remapped this column in the UI. */
  mappedTo?: string;
}

export interface PlanReport {
  manifestPath: string;
  entryCount: number;
  columns: ColumnReport[];
  invalidHeaders: InvalidHeader[];
  warnings: string[];
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
  hasSettings(instanceId: string): Promise<boolean>;
  saveSettings(
    instanceId: string,
    s: { clientId: string; clientSecret: string; redirectUri: string },
  ): Promise<void>;
  clearSettings(): Promise<void>;

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
}

export interface ExtractRunReport {
  outPath: string;
  written: number;
  flagged: number;
}

export const CHANNELS = {
  hasSettings: 'oeq:hasSettings',
  saveSettings: 'oeq:saveSettings',
  clearSettings: 'oeq:clearSettings',
  signIn: 'oeq:signIn',
  signOut: 'oeq:signOut',
  currentUser: 'oeq:currentUser',
  listCollections: 'oeq:listCollections',
  chooseSpreadsheet: 'oeq:chooseSpreadsheet',
  chooseFolder: 'oeq:chooseFolder',
  saveStarterKit: 'oeq:saveStarterKit',
  validate: 'oeq:validate',
  plan: 'oeq:plan',
  run: 'oeq:run',
  retryFailed: 'oeq:retryFailed',
  loadManifest: 'oeq:loadManifest',
  progress: 'oeq:progress',
  extractScan: 'oeq:extractScan',
  extractPreview: 'oeq:extractPreview',
  extractRun: 'oeq:extractRun',
  schemaPaths: 'oeq:schemaPaths',
  openProfile: 'oeq:openProfile',
  saveProfileAs: 'oeq:saveProfileAs',
  chooseCsvPath: 'oeq:chooseCsvPath',
  openPath: 'oeq:openPath',
} as const;
