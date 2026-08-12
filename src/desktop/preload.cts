// This file is `.cts` (not `.ts`) so that, under `moduleResolution:
// "nodenext"` in a `"type": "module"` package, tsc emits it as CommonJS
// (`preload.cjs`) rather than ESM. Electron's preload loader does not support
// loading an ES module via `webPreferences.preload` -- only CommonJS. The
// main process itself stays ESM; only this one bridge file needs the
// CommonJS extension. See main.ts, which points `preload` at `preload.cjs`.
import { contextBridge, ipcRenderer } from 'electron';
import type { OeqApi, RunProgress } from './ipc.js';

/**
 * CHANNELS is duplicated here rather than imported as a value from `ipc.ts`.
 * That is deliberate, not an oversight: with `sandbox: true` (main.ts), the
 * preload script runs through Electron's sandboxed module loader, which
 * polyfills `require()` for a small fixed set of built-ins (starting with
 * `'electron'`) but cannot resolve requires of arbitrary local project files
 * -- confirmed live via `npm run desktop`, where `require('./ipc.js')` here
 * failed at window-open time with "Error: module not found: ./ipc.js" from
 * `preloadRequire` (electron's `sandbox_bundle`), which silently aborted the
 * whole preload script and left `window.oeq` undefined. This is Electron's
 * documented sandboxed-preload limitation: a bundler (webpack/esbuild/etc.)
 * is the normal fix, but this repo intentionally has none, so the channel
 * *names* -- small, stable string literals -- are duplicated by hand
 * instead. The *types* (`OeqApi`, `RunProgress`) are still imported from
 * `ipc.ts` via `import type`, which TypeScript erases entirely at compile
 * time (no runtime `require` is emitted for a type-only import), so this
 * still gets compile-time checking that this object matches the real
 * contract. If CHANNELS in ipc.ts ever changes, update the copy below to
 * match -- there is no automated check tying the two together.
 */
const CHANNELS = {
  listInstances: 'oeq:listInstances',
  credentialsDropped: 'oeq:credentialsDropped',
  hasSettings: 'oeq:hasSettings',
  saveInstance: 'oeq:saveInstance',
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

const invoke = <T,>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api: OeqApi = {
  listInstances: () => invoke(CHANNELS.listInstances),
  credentialsDropped: () => invoke(CHANNELS.credentialsDropped),
  hasSettings: (instanceId) => invoke(CHANNELS.hasSettings, instanceId),
  saveInstance: (instance, s) => invoke(CHANNELS.saveInstance, instance, s),
  clearSettings: () => invoke(CHANNELS.clearSettings),
  signIn: (instanceId) => invoke(CHANNELS.signIn, instanceId),
  signOut: () => invoke(CHANNELS.signOut),
  currentUser: (instanceId) => invoke(CHANNELS.currentUser, instanceId),
  listCollections: (instanceId) => invoke(CHANNELS.listCollections, instanceId),
  chooseSpreadsheet: () => invoke(CHANNELS.chooseSpreadsheet),
  chooseFolder: () => invoke(CHANNELS.chooseFolder),
  saveStarterKit: () => invoke(CHANNELS.saveStarterKit),
  validate: (args) => invoke(CHANNELS.validate, args),
  plan: (args) => invoke(CHANNELS.plan, args),
  applyDuplicateChoices: (args) => invoke(CHANNELS.applyDuplicateChoices, args),
  run: (args) => invoke(CHANNELS.run, args),
  retryFailed: (p) => invoke(CHANNELS.retryFailed, p),
  loadManifest: (p) => invoke(CHANNELS.loadManifest, p),
  extractScan: (dir) => invoke(CHANNELS.extractScan, dir),
  extractPreview: (args) => invoke(CHANNELS.extractPreview, args),
  extractRun: (args) => invoke(CHANNELS.extractRun, args),
  schemaPaths: () => invoke(CHANNELS.schemaPaths),
  schemaNamePath: () => invoke(CHANNELS.schemaNamePath),
  listTemplates: () => invoke(CHANNELS.listTemplates),
  loadTemplate: (id) => invoke(CHANNELS.loadTemplate, id),
  openProfile: () => invoke(CHANNELS.openProfile),
  saveProfileAs: (profile) => invoke(CHANNELS.saveProfileAs, profile),
  chooseCsvPath: () => invoke(CHANNELS.chooseCsvPath),
  openPath: (path) => invoke(CHANNELS.openPath, path),
  onProgress: (cb) => {
    ipcRenderer.on(CHANNELS.progress, (_e, p: RunProgress) => cb(p));
  },
};

contextBridge.exposeInMainWorld('oeq', api);
