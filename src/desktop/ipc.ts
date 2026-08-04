import type { ItemState, Manifest } from '../core/types.js';
import type { CollectionSummary, CurrentUser } from '../core/client.js';
import type { InvalidHeader } from '../core/schema.js';

export interface InstanceChoice {
  id: 'production' | 'test';
  label: string;
  baseUrl: string;
  redirectUri: string;
}

/**
 * Both instances are declared here rather than typed by the user. The
 * collection uuid is byte-identical on test and production, so the base url is
 * the ONLY thing distinguishing them -- a free-text field would be a footgun.
 * `redirectUri` differs per instance and must match what is registered on the
 * OAuth client character for character; production has no trailing slash.
 */
export const INSTANCES: InstanceChoice[] = [
  {
    id: 'production',
    label: 'Production',
    baseUrl: 'https://content.byui.edu',
    redirectUri: 'https://content.byui.edu',
  },
  {
    id: 'test',
    label: 'Test',
    baseUrl: 'https://content-test.byui.edu',
    redirectUri: 'https://content-test.byui.edu/',
  },
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
  saveSettings(instanceId: string, s: { clientId: string; clientSecret: string }): Promise<void>;
  clearSettings(): Promise<void>;

  signIn(instanceId: string): Promise<CurrentUser>;
  signOut(): Promise<void>;
  currentUser(instanceId: string): Promise<CurrentUser | null>;

  listCollections(instanceId: string): Promise<CollectionSummary[]>;

  chooseSpreadsheet(): Promise<string | null>;
  chooseFolder(): Promise<string | null>;

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

  onProgress(cb: (p: RunProgress) => void): void;
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
  validate: 'oeq:validate',
  plan: 'oeq:plan',
  run: 'oeq:run',
  retryFailed: 'oeq:retryFailed',
  loadManifest: 'oeq:loadManifest',
  progress: 'oeq:progress',
} as const;
