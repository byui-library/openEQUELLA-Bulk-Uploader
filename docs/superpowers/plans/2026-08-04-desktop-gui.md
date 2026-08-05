# Desktop GUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the working bulk uploader as an Electron desktop application that non-technical Windows staff can double-click, with no prerequisites and nothing to configure except a client ID and secret delivered separately.

**Architecture:** The existing `src/core/` is reused **unchanged** — its 252 tests continue to apply and no wire-format, runner, or manifest behaviour is revisited. A new `src/desktop/` adds an Electron main process that owns all core calls and filesystem access, and a renderer with no Node integration that communicates over a typed IPC channel.

**Tech Stack:** Electron 33+, electron-builder, TypeScript, vitest (existing).

**Spec:** [../specs/2026-08-04-desktop-gui-design.md](../specs/2026-08-04-desktop-gui-design.md)

---

## Before you start

**Read the spec.** Then read these core modules — the plan calls them by exact signature and inventing a different one will not compile:

```text
src/core/types.ts      Manifest, ManifestEntry, ItemState, Sheet, ATTACHMENT_COLUMN
src/core/config.ts     Config, loadConfig(env), createAuthProvider(cfg, env, tokenStore?)
src/core/authCode.ts   AuthorizationCodeAuth(baseUrl, clientId, clientSecret, redirectUri, tokenStore?)
src/core/tokenStore.ts TokenStore, StoredToken, FileTokenStore
src/core/client.ts     OeqClient, CurrentUser, CollectionSummary
src/core/preflight.ts  runPreflight(cfg, auth, client, loginHint?)
src/core/plan.ts       buildManifest(sheet, filesDir, schemaPaths, opts), preflightDuplicates(client, manifest)
src/core/runner.ts     runManifest(client, manifestPath, opts), RunOptions, RunSummary
src/core/schema.ts     extractDefinition, parseSchemaPaths, validateHeaders, suggest
src/core/sheet.ts      readSheet(path)
```

**Conventions:** `moduleResolution: "nodenext"` — relative imports need `.js` extensions. `strict` + `noUncheckedIndexedAccess`. `npm run typecheck` covers `src/` and `tests/`. **All 252 existing tests must keep passing after every task.**

**Hard constraint:** do NOT modify anything under `src/core/`, `src/cli/`, `src/mcp/`, `schema/`, or `tests/` except to add new test files. If you believe a core change is needed, STOP and report rather than editing.

**Three behaviours that are not negotiable**, learned from live runs and unreachable from any mock:

1. Sign-in must establish the openEQUELLA session *before* navigating to `/oauth/authorise`, or SSO strips the query string and openEQUELLA reports `client_id (null)`.
2. `redirect_uri` is sent **verbatim**. Production registers it without a trailing slash, test with one. Never normalise.
3. Code capture must match on the instance's own **origin**. Signing in through SSO also produces a `?code=` on `id.churchofjesuschrist.org`; capturing that one yields an exchange that fails obscurely.

---

## File structure

```text
src/desktop/
  main.ts             Electron entry: window lifecycle, app events
  ipc.ts              Typed channel contract (shared by main and preload)
  preload.cts          contextBridge surface; the ONLY thing the renderer can call
  secrets.ts          safeStorage-backed secret + token storage
  session.ts          Builds Config/OeqClient/auth from stored settings
  signin.ts           Embedded sign-in window
  handlers.ts         IPC handler implementations (calls core)
  ui/
    index.html
    app.ts            Renderer entry; screen routing
    screens/*.ts      One module per screen
    styles.css
electron-builder.yml
tests/desktop/*.test.ts
```

---

## Task 1: Electron scaffolding

**Files:** Modify `package.json`, create `tsconfig.desktop.json`, `src/desktop/main.ts`, `src/desktop/preload.cts`, `src/desktop/ui/index.html`, `electron-builder.yml`

- [ ] **Step 1: Add dependencies**

```bash
npm install --save-dev electron@^33 electron-builder@^25
```

- [ ] **Step 2: Add scripts to `package.json`**

Merge into the existing `scripts` block; do not remove existing entries.

```json
{
  "main": "dist-desktop/desktop/main.js",
  "scripts": {
    "build:desktop": "tsc -p tsconfig.desktop.json",
    "desktop": "npm run build:desktop && electron dist-desktop/desktop/main.js",
    "dist": "npm run build:desktop && electron-builder"
  }
}
```

**The `main` field is required.** electron-builder uses it as the packaged
entry point and defaults to `index.js` when absent, so packaging fails without
it. This is invisible during development because `npm run desktop` passes the
path explicitly and never consults `main`. Leave the existing `bin` entry
pointing at `dist/cli/index.js` — the CLI is unaffected.

- [ ] **Step 3: Create `tsconfig.desktop.json`**

Separate from the main build because Electron code targets a different module layout and must include the renderer.

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist-desktop",
    "rootDir": "src",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"]
  },
  "include": ["src/desktop/**/*", "src/core/**/*"]
}
```

- [ ] **Step 4: Create `src/desktop/main.ts`**

```typescript
import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      // Security posture: the renderer gets no Node access and cannot import
      // core. It may only call what preload explicitly exposes. This is also
      // what stops the UI reaching around a safety rail.
      contextIsolation: true,
      nodeIntegration: false,
      // Keep the OS-level renderer sandbox ON. Sandboxed preloads still get a
      // polyfilled require() covering 'electron' itself, which is all the
      // bridge uses; everything touching the filesystem or core runs in the
      // main process. If a later task appears to need sandbox:false, that
      // means work is happening in the wrong process -- stop and report.
      sandbox: true,
      // NOTE .cjs, not .js. Under "type": "module" + nodenext, tsc emits ESM
      // for a .ts file, and Electron's preload loader accepts only CommonJS --
      // an ESM preload fails SILENTLY, leaving the UI stuck. The source is
      // therefore named preload.cts, which forces a .cjs emit.
      preload: join(here, 'preload.cjs'),
    },
  });
  void win.loadFile(join(here, 'ui', 'index.html'));
}

void app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

- [ ] **Step 5: Create a placeholder `src/desktop/preload.cts`**

**The `.cts` extension is required, not stylistic.** Under `"type": "module"`
with `nodenext`, `tsc` emits ESM for a plain `.ts` file, and Electron's preload
loader accepts only CommonJS. An ESM preload **fails silently** — the window
opens, the bridge never initialises, and the UI sits there looking like a
rendering bug. `.cts` forces a `.cjs` emit with `require()`.

```typescript
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('oeq', {
  ping: () => 'pong',
});
```

- [ ] **Step 6: Create `src/desktop/ui/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'" />
    <title>openEQUELLA Bulk Uploader</title>
  </head>
  <body>
    <h1>openEQUELLA Bulk Uploader</h1>
    <p id="status">loading…</p>
    <script type="module" src="./app.js"></script>
  </body>
</html>
```

- [ ] **Step 7: Create `src/desktop/ui/app.ts`**

```typescript
declare global {
  interface Window {
    oeq: { ping: () => string };
  }
}

const el = document.getElementById('status');
if (el) el.textContent = window.oeq.ping();

export {};
```

- [ ] **Step 8: Copy the HTML into the build output**

`tsc` does not copy `.html`/`.css`. Add a small copy step to `build:desktop`:

```json
"build:desktop": "tsc -p tsconfig.desktop.json && node scripts/copy-ui-assets.mjs"
```

Create `scripts/copy-ui-assets.mjs`:

```javascript
import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist-desktop/desktop/ui', { recursive: true });
for (const f of ['index.html', 'styles.css']) {
  await cp(`src/desktop/ui/${f}`, `dist-desktop/desktop/ui/${f}`).catch(() => {});
}
```

Create an empty `src/desktop/ui/styles.css` so the copy has something to find.

- [ ] **Step 9: Create `electron-builder.yml`**

```yaml
appId: edu.byui.oeq-bulk-uploader
productName: openEQUELLA Bulk Uploader
directories:
  output: release
files:
  - dist-desktop/**/*
  - node_modules/**/*
  - package.json
win:
  target:
    - portable
    - nsis
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
```

- [ ] **Step 10: Verify**

Run: `npm run desktop`
Expected: a window opens showing "openEQUELLA Bulk Uploader" and the status line reads `pong`.

Run: `npm test` — expected still 252 passing.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.desktop.json electron-builder.yml scripts/copy-ui-assets.mjs src/desktop
git commit -m "feat(desktop): electron scaffolding with a locked-down renderer"
```

---

## Task 2: Encrypted secret storage

**Files:** Create `src/desktop/secrets.ts`, `tests/desktop/secrets.test.ts`

Stores the client ID, client secret, and access token. The token matters as much as the secret: it authenticates fully as that person and openEQUELLA reports an expiry measured in weeks.

`safeStorage` is an Electron API, so the encryption must be **injectable** or the tests need a running Electron. Design for that.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretStore, type Cipher } from '../../src/desktop/secrets.js';

// Stand-in for Electron's safeStorage. Reversible and not secure -- the point
// is to exercise SecretStore's logic without booting Electron.
//
// It base64-transcodes rather than prefixing a marker, and that matters: a
// fake that merely prepends something (`enc:${s}`) leaves the plaintext bytes
// intact on disk, so the "never writes the secret in plaintext" test below can
// never pass no matter how correct the implementation is. The fake has to
// actually change the bytes for that assertion to mean anything.
const fakeCipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decrypt: (b) => Buffer.from(b.toString('utf8'), 'base64').toString('utf8'),
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oeq-secrets-'));
});

describe('SecretStore', () => {
  it('round-trips settings', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveSettings({ clientId: 'cid', clientSecret: 'shhh' });
    const got = await s.loadSettings();
    expect(got).toEqual({ clientId: 'cid', clientSecret: 'shhh' });
  });

  it('returns null when nothing is stored', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    expect(await s.loadSettings()).toBeNull();
  });

  it('never writes the secret in plaintext', async () => {
    const path = join(dir, 'settings.enc');
    const s = new SecretStore(path, fakeCipher);
    await s.saveSettings({ clientId: 'cid', clientSecret: 'sup3rs3cret' });
    const raw = await (await import('node:fs/promises')).readFile(path, 'utf8');
    expect(raw).not.toContain('sup3rs3cret');
  });

  it('treats a corrupt blob as absent rather than throwing', async () => {
    const path = join(dir, 'settings.enc');
    await (await import('node:fs/promises')).writeFile(path, 'not-valid', 'utf8');
    const s = new SecretStore(path, {
      ...fakeCipher,
      decrypt: () => {
        throw new Error('bad blob');
      },
    });
    expect(await s.loadSettings()).toBeNull();
  });

  it('clear() removes everything', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), fakeCipher);
    await s.saveSettings({ clientId: 'cid', clientSecret: 'x' });
    await s.clear();
    expect(await s.loadSettings()).toBeNull();
  });

  it('refuses to save when encryption is unavailable', async () => {
    const s = new SecretStore(join(dir, 'settings.enc'), { ...fakeCipher, isAvailable: () => false });
    await expect(s.saveSettings({ clientId: 'a', clientSecret: 'b' })).rejects.toThrow(/encryption/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/desktop/secrets.test.ts`
Expected: FAIL — cannot resolve `secrets.js`.

- [ ] **Step 3: Implement `src/desktop/secrets.ts`**

```typescript
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The subset of Electron's `safeStorage` this module needs, extracted as an
 * interface so tests can substitute a fake. On Windows the real
 * implementation encrypts via DPAPI -- the same OS mechanism that backs
 * Credential Manager -- scoped to the logged-in user.
 */
export interface Cipher {
  isAvailable(): boolean;
  encrypt(plainText: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

export interface Settings {
  clientId: string;
  clientSecret: string;
}

export class SecretStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: Cipher,
  ) {}

  async saveSettings(settings: Settings): Promise<void> {
    if (!this.cipher.isAvailable()) {
      throw new Error(
        'OS encryption is unavailable, so credentials cannot be stored safely. ' +
          'Refusing to write them in plaintext.',
      );
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const blob = this.cipher.encrypt(JSON.stringify(settings));
    await writeFile(this.filePath, blob);
  }

  async loadSettings(): Promise<Settings | null> {
    let blob: Buffer;
    try {
      blob = await readFile(this.filePath);
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(this.cipher.decrypt(blob)) as Partial<Settings>;
      if (typeof parsed.clientId !== 'string' || typeof parsed.clientSecret !== 'string') {
        return null;
      }
      return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
    } catch {
      // Corrupt, hand-edited, or written by a different OS user. Treat as
      // absent: the resulting "set up your credentials" prompt is the right
      // recovery either way.
      return null;
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/desktop/secrets.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add the encrypted `TokenStore`**

The core's `AuthorizationCodeAuth` takes a `TokenStore`. Implement one backed by the same cipher rather than the plaintext `FileTokenStore`, so the access token gets the same protection as the secret.

Add to `src/desktop/secrets.ts`:

```typescript
import type { StoredToken, TokenStore } from '../core/tokenStore.js';
import { unlinkSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * `TokenStore` backed by OS encryption instead of a plaintext JSON file.
 *
 * `clearSync` exists because `AuthProvider.invalidate()` is synchronous and
 * `client.ts` retries in the same tick -- an async clear would race that
 * retry. See the note in core/tokenStore.ts.
 */
export class EncryptedTokenStore implements TokenStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: Cipher,
  ) {}

  async save(data: StoredToken): Promise<void> {
    if (!this.cipher.isAvailable()) throw new Error('OS encryption unavailable; refusing to store a token.');
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, this.cipher.encrypt(JSON.stringify(data)));
  }

  async loadRaw(): Promise<StoredToken | null> {
    try {
      const parsed = JSON.parse(this.cipher.decrypt(readFileSync(this.filePath))) as Partial<StoredToken>;
      if (typeof parsed.accessToken !== 'string' || parsed.accessToken === '') return null;
      if (typeof parsed.baseUrl !== 'string' || parsed.baseUrl === '') return null;
      return {
        accessToken: parsed.accessToken,
        baseUrl: parsed.baseUrl,
        expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined,
      };
    } catch {
      return null;
    }
  }

  async load(baseUrl: string): Promise<string | null> {
    const raw = await this.loadRaw();
    if (!raw) return null;
    if (raw.baseUrl !== baseUrl) return null;
    if (raw.expiresAt !== undefined && raw.expiresAt <= Date.now()) return null;
    return raw.accessToken;
  }

  async clear(): Promise<void> {
    this.clearSync();
  }

  clearSync(): void {
    try {
      unlinkSync(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
```

Add tests mirroring the core `tokenStore` suite: round-trip; a token stored for one `baseUrl` is refused for another; corrupt blob reads as absent; `clearSync` removes it.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/desktop/secrets.ts tests/desktop/secrets.test.ts
git commit -m "feat(desktop): OS-encrypted credential and token storage"
```

---

## Task 3: Typed IPC contract

**Files:** Create `src/desktop/ipc.ts`, rewrite `src/desktop/preload.cts`

One place defining every call the renderer can make. If it is not here, the UI cannot do it.

- [ ] **Step 1: Create `src/desktop/ipc.ts`**

```typescript
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
  hasSettings(): Promise<boolean>;
  saveSettings(s: { clientId: string; clientSecret: string }): Promise<void>;
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
```

- [ ] **Step 2: Rewrite `src/desktop/preload.cts`**

**CONSTRAINT, verified live:** a sandboxed preload can `require()` only
Electron's own built-ins. A relative require of a local project file
(`require('./ipc.js')`) fails with `module not found`, and that **aborts the
entire preload silently** — `window.oeq` comes back `undefined`, which presents
as a broken UI rather than a module error.

So `preload.cts` may import **types** from `ipc.ts` (erased at compile time,
zero runtime cost) but must NOT import **values**. `CHANNELS` is therefore
duplicated as a literal in the preload, guarded by
`tests/desktop/preload-channels.test.ts`, which reads the preload as text and
asserts its channel strings match `Object.values(CHANNELS)` so the two cannot
drift apart unnoticed.

Both alternatives were rejected deliberately: `sandbox: false` gives up the
OS-level renderer sandbox for a convenience, and a bundler adds a build
dependency this project does not otherwise need. Any future preload addition
needing a runtime value from another module hits the same wall and needs the
same treatment.

Note `<T,>` rather than `<T>` on the generic below — in a `.cts` file the
latter parses as JSX and raises TS7060.

```typescript
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type OeqApi, type RunProgress } from './ipc.js';

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api: OeqApi = {
  hasSettings: () => invoke(CHANNELS.hasSettings),
  saveSettings: (s) => invoke(CHANNELS.saveSettings, s),
  clearSettings: () => invoke(CHANNELS.clearSettings),
  signIn: (instanceId) => invoke(CHANNELS.signIn, instanceId),
  signOut: () => invoke(CHANNELS.signOut),
  currentUser: (instanceId) => invoke(CHANNELS.currentUser, instanceId),
  listCollections: (instanceId) => invoke(CHANNELS.listCollections, instanceId),
  chooseSpreadsheet: () => invoke(CHANNELS.chooseSpreadsheet),
  chooseFolder: () => invoke(CHANNELS.chooseFolder),
  validate: (args) => invoke(CHANNELS.validate, args),
  plan: (args) => invoke(CHANNELS.plan, args),
  run: (args) => invoke(CHANNELS.run, args),
  retryFailed: (p) => invoke(CHANNELS.retryFailed, p),
  loadManifest: (p) => invoke(CHANNELS.loadManifest, p),
  onProgress: (cb) => {
    ipcRenderer.on(CHANNELS.progress, (_e, p: RunProgress) => cb(p));
  },
};

contextBridge.exposeInMainWorld('oeq', api);
```

- [ ] **Step 3: Verify and commit**

Run: `npm run build:desktop && npm run typecheck`

```bash
git add src/desktop/ipc.ts src/desktop/preload.cts
git commit -m "feat(desktop): typed IPC contract and preload bridge"
```

---

## Task 4: Session assembly

**Files:** Create `src/desktop/session.ts`, `tests/desktop/session.test.ts`

Builds a `Config`, `AuthorizationCodeAuth`, and `OeqClient` from stored settings plus a chosen instance. Reuses `loadConfig` for validation by synthesising an env-shaped object rather than duplicating its rules.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { buildConfig } from '../../src/desktop/session.js';
import { INSTANCES } from '../../src/desktop/ipc.js';

const settings = { clientId: 'cid', clientSecret: 'sec' };

describe('buildConfig', () => {
  it('uses the production redirect uri verbatim, with no trailing slash', () => {
    const cfg = buildConfig('production', settings, 'coll-uuid');
    expect(cfg.baseUrl).toBe('https://content.byui.edu');
    expect(cfg.redirectUri).toBe('https://content.byui.edu');
  });

  it('uses the test redirect uri verbatim, WITH its trailing slash', () => {
    const cfg = buildConfig('test', settings, 'coll-uuid');
    expect(cfg.redirectUri).toBe('https://content-test.byui.edu/');
  });

  it('carries the chosen collection through', () => {
    expect(buildConfig('production', settings, 'abc').collectionUuid).toBe('abc');
  });

  it('rejects an unknown instance id rather than guessing', () => {
    expect(() => buildConfig('staging', settings, 'x')).toThrow(/instance/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/desktop/session.test.ts` — FAIL, cannot resolve.

- [ ] **Step 3: Implement `src/desktop/session.ts`**

```typescript
import { loadConfig, type Config } from '../core/config.js';
import { AuthorizationCodeAuth } from '../core/authCode.js';
import { OeqClient } from '../core/client.js';
import { INSTANCES } from './ipc.js';
import type { Settings } from './secrets.js';
import type { TokenStore } from '../core/tokenStore.js';
import { ValidationError } from '../core/errors.js';

export function instanceById(id: string) {
  const found = INSTANCES.find((i) => i.id === id);
  if (!found) throw new ValidationError(`Unknown instance '${id}'.`);
  return found;
}

/**
 * Synthesises an env-shaped object and hands it to the core's own
 * `loadConfig`, so validation rules live in exactly one place. Note
 * OEQ_REDIRECT_URI is set explicitly per instance -- it is never derived from
 * the base url, because production registers it without a trailing slash and
 * test registers it with one.
 */
export function buildConfig(instanceId: string, settings: Settings, collectionUuid: string): Config {
  const inst = instanceById(instanceId);
  return loadConfig({
    OEQ_BASE_URL: inst.baseUrl,
    OEQ_CLIENT_ID: settings.clientId,
    OEQ_CLIENT_SECRET: settings.clientSecret,
    OEQ_COLLECTION_UUID: collectionUuid,
    OEQ_REDIRECT_URI: inst.redirectUri,
    OEQ_AUTH_MODE: 'code',
  });
}

export function buildAuth(cfg: Config, store: TokenStore): AuthorizationCodeAuth {
  return new AuthorizationCodeAuth(cfg.baseUrl, cfg.clientId, cfg.clientSecret, cfg.redirectUri, store);
}

export function buildClient(cfg: Config, auth: AuthorizationCodeAuth): OeqClient {
  return new OeqClient(cfg.baseUrl, auth);
}
```

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/desktop/session.test.ts` — PASS, 4 tests. Then `npm test`.

```bash
git add src/desktop/session.ts tests/desktop/session.test.ts
git commit -m "feat(desktop): session assembly reusing core config validation"
```

---

## Task 5: Embedded sign-in

**Files:** Create `src/desktop/signin.ts`

The part that gets dramatically better than the CLI. No pasting, no browser history, no localhost redirect to register.

- [ ] **Step 1: Implement `src/desktop/signin.ts`**

```typescript
import { BrowserWindow } from 'electron';
import type { AuthorizationCodeAuth } from '../core/authCode.js';
import { OeqError } from '../core/errors.js';

const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Opens openEQUELLA in a window and captures the OAuth code from its own
 * navigation events.
 *
 * Two behaviours here are load-bearing and were learned from live runs:
 *
 *  1. The session is established FIRST. Navigating straight to
 *     /oauth/authorise while logged out bounces through Okta, which returns
 *     the browser to a bare /oauth/authorise with the query string stripped;
 *     openEQUELLA then reports "client_id (null)".
 *  2. Capture matches on the instance's own ORIGIN. Signing in via SSO also
 *     produces a ?code= on id.churchofjesuschrist.org, and exchanging that
 *     one fails obscurely.
 */
export async function signInInteractive(
  baseUrl: string,
  auth: AuthorizationCodeAuth,
  parent?: BrowserWindow,
): Promise<void> {
  const origin = new URL(baseUrl).origin;
  const win = new BrowserWindow({
    width: 900,
    height: 800,
    parent,
    modal: Boolean(parent),
    title: 'Sign in to openEQUELLA',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const code = await new Promise<string>((resolve, reject) => {
    let armed = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new OeqError('Sign-in timed out.'));
      }
    }, SIGN_IN_TIMEOUT_MS);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const inspect = (url: string): void => {
      if (!armed) return;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      if (parsed.origin !== origin) return;
      if (parsed.pathname.startsWith('/oauth/authorise')) return;
      const found = parsed.searchParams.get('code');
      if (found) finish(() => resolve(found));
    };

    win.webContents.on('will-redirect', (_e, url) => inspect(url));
    win.webContents.on('did-navigate', (_e, url) => inspect(url));
    win.webContents.on('will-navigate', (_e, url) => inspect(url));

    win.on('closed', () => finish(() => reject(new OeqError('Sign-in window was closed before completing.'))));

    void (async () => {
      // Step 1: establish the session.
      await win.loadURL(baseUrl);

      const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
      while (Date.now() < deadline && !settled) {
        const isUser = await win.webContents
          .executeJavaScript(
            `fetch('/api/content/currentuser',{credentials:'include'})
               .then(r => r.ok ? r.json() : null)
               .then(u => !!u && u.guest === false)
               .catch(() => false)`,
          )
          .catch(() => false);
        if (isUser) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (settled) return;

      // Step 2: only now does the authorize URL keep its query string.
      armed = true;
      await win.loadURL(auth.getAuthorizeUrl());
    })().catch((err: unknown) => finish(() => reject(err)));
  }).finally(() => {
    if (!win.isDestroyed()) win.destroy();
  });

  await auth.exchangeCode(code);
}
```

- [ ] **Step 2: Verify it compiles and commit**

Run: `npm run build:desktop && npm run typecheck`

Note: this is not unit-tested — it is almost entirely Electron window orchestration, and a test would assert against mocks rather than behaviour. It is covered by the manual verification in Task 10.

```bash
git add src/desktop/signin.ts
git commit -m "feat(desktop): embedded sign-in with session-first and origin-matched capture"
```

---

## Task 6: IPC handlers

**Files:** Create `src/desktop/handlers.ts`, modify `src/desktop/main.ts`

- [ ] **Step 1: Implement `src/desktop/handlers.ts`**

Register one handler per channel. Each wraps a core call. Key requirements:

- Settings, token store, and manifests live under `app.getPath('userData')`.
- `plan` applies the renderer's `overrides` by rewriting the sheet's headers **in memory** before `buildManifest` — the user's file is never modified.
- `plan` runs `preflightDuplicates` and folds its warnings in, matching the CLI.
- `run` forwards `onProgress` to the renderer over `CHANNELS.progress`.
- Every handler catches and returns a readable message; `OeqError` text is surfaced verbatim rather than replaced.

**But "verbatim" needs work on the renderer side.** Electron wraps every error
that crosses IPC. Verified with a real `ipcMain.handle`/`ipcRenderer.invoke`
round-trip:

```text
handler throws : new OeqError('Sign-in timed out.')
renderer sees  : "Error invoking remote method 'oeq:signIn': OeqError: Sign-in timed out."
```

So reading `err.message` in the renderer is not sufficient — it must strip the
leading `Error invoking remote method '<channel>':` prefix (including the space
that follows it) and then the `<ClassName>:` prefix after
that. **Anchor the pattern to the start of the string:** real messages
contain colons (`Row 14 (Sears, Rivka 072126.MP4): POST /api/item failed`) and
must survive intact. This affects every error path in the app, including
sign-in timeout and window-closed-early.

**Escaping:** anything reaching the DOM from the server (collection names, user
names, error text) or from the user (the filter query, chosen file paths) must
be escaped, and escaping must cover **quotes** as well as angle brackets — those
values are interpolated into attributes as well as text. A demonstrated payload
(`uuid: 'evil" onmouseover="..." data-x="'`) broke out of an attribute and was
stopped only by the CSP. Do not rely on the CSP to cover an escaping bug.

```typescript
import { app, dialog, ipcMain, BrowserWindow } from 'electron';
import { safeStorage } from 'electron';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { CHANNELS, type ColumnReport, type PlanReport, type RunReport } from './ipc.js';
import { SecretStore, EncryptedTokenStore } from './secrets.js';
import { buildAuth, buildClient, buildConfig, instanceById } from './session.js';
import { readSheet } from '../core/sheet.js';
import { extractDefinition, parseSchemaPaths, suggest, validateHeaders } from '../core/schema.js';
import { buildManifest, preflightDuplicates } from '../core/plan.js';
import { saveManifest, loadManifest } from '../core/state.js';
import { runManifest } from '../core/runner.js';
import { signInInteractive } from './signin.js';
import { ATTACHMENT_COLUMN, type Sheet } from '../core/types.js';
import { OeqError } from '../core/errors.js';

const userData = () => app.getPath('userData');
const cipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s: string) => safeStorage.encryptString(s),
  decrypt: (b: Buffer) => safeStorage.decryptString(b),
};
const secrets = () => new SecretStore(join(userData(), 'settings.enc'), cipher);
const tokens = () => new EncryptedTokenStore(join(userData(), 'token.enc'), cipher);

async function requireSettings() {
  const s = await secrets().loadSettings();
  if (!s) throw new OeqError('No credentials saved yet. Enter your client ID and secret in Setup.');
  return s;
}

/**
 * Schema xpaths, read from the bundled reference export.
 *
 * Do NOT use `app.getAppPath()` for the development branch. Verified live:
 * when launched as `electron dist-desktop/desktop/main.js`, it resolves to
 * `dist-desktop/desktop` (Electron walks up looking for a package.json and
 * finds none), producing `ENOENT ...dist-desktop\desktop\schema\_entity.xml`.
 * Compute it from this module's own compiled location instead — two levels up
 * from `dist-desktop/desktop/` is the repo root.
 *
 * Packaged, the file lives under `process.resourcesPath` via the
 * `extraResources` entry added in Task 9.
 */
export function resolveSchemaPath(isPackaged: boolean, moduleDir: string, resourcesPath: string): string {
  return isPackaged
    ? join(resourcesPath, 'schema', '_entity.xml')
    : join(moduleDir, '..', '..', 'schema', '_entity.xml');
}

async function schemaPaths(): Promise<Set<string>> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const p = resolveSchemaPath(app.isPackaged, moduleDir, process.resourcesPath);
  return parseSchemaPaths(extractDefinition(await readFile(p, 'utf8')));
}

/** Apply UI remaps to a sheet's headers in memory. The file is never touched. */
function applyOverrides(sheet: Sheet, overrides: Record<string, string>): Sheet {
  if (Object.keys(overrides).length === 0) return sheet;
  const headers = sheet.headers.map((h) => overrides[h] ?? h);
  const rows = sheet.rows.map((r) => {
    const cells: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.cells)) cells[overrides[k] ?? k] = v;
    return { ...r, cells };
  });
  return { headers, rows };
}

export function registerHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(CHANNELS.hasSettings, async () => (await secrets().loadSettings()) !== null);

  ipcMain.handle(CHANNELS.saveSettings, async (_e, s: { clientId: string; clientSecret: string }) => {
    await secrets().saveSettings(s);
  });

  ipcMain.handle(CHANNELS.clearSettings, async () => {
    await secrets().clear();
    await tokens().clear();
  });

  ipcMain.handle(CHANNELS.signIn, async (_e, instanceId: string) => {
    const settings = await requireSettings();
    const cfg = buildConfig(instanceId, settings, 'unused-for-signin');
    const auth = buildAuth(cfg, tokens());
    await signInInteractive(cfg.baseUrl, auth, getWindow() ?? undefined);
    return buildClient(cfg, auth).currentUser();
  });

  ipcMain.handle(CHANNELS.signOut, async () => {
    await tokens().clear();
  });

  ipcMain.handle(CHANNELS.currentUser, async (_e, instanceId: string) => {
    const settings = await secrets().loadSettings();
    if (!settings) return null;
    const cfg = buildConfig(instanceId, settings, 'unused');
    const auth = buildAuth(cfg, tokens());
    try {
      return await buildClient(cfg, auth).currentUser();
    } catch {
      return null;
    }
  });

  ipcMain.handle(CHANNELS.listCollections, async (_e, instanceId: string) => {
    const settings = await requireSettings();
    const cfg = buildConfig(instanceId, settings, 'unused');
    const auth = buildAuth(cfg, tokens());
    // NOTE the signature: listCollections takes an OPTIONS OBJECT, not a
    // positional string. `listCollections('CREATE_ITEM')` does not compile.
    return buildClient(cfg, auth).listCollections({ privilege: 'CREATE_ITEM', length: 100 });
  });

  ipcMain.handle(CHANNELS.chooseSpreadsheet, async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Spreadsheets', extensions: ['xlsx', 'xls', 'csv'] }],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  ipcMain.handle(CHANNELS.chooseFolder, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  ipcMain.handle(CHANNELS.validate, async (_e, args: { sheetPath: string }) => {
    const sheet = await readSheet(args.sheetPath);
    const paths = await schemaPaths();
    const { invalid } = validateHeaders(sheet.headers, paths);
    const invalidSet = new Map(invalid.map((i) => [i.header, i.suggestions]));
    // Suggestions only for INVALID headers. Falling back to `suggest(h, paths)`
    // for a valid one makes the UI offer "did you mean…" against a column that
    // is already correct, which reads as though something is wrong with it.
    const reports: ColumnReport[] = sheet.headers.map((h) => ({
      header: h,
      valid: !invalidSet.has(h),
      suggestions: invalidSet.get(h) ?? [],
    }));
    return reports;
  });

  ipcMain.handle(CHANNELS.plan, async (_e, args): Promise<PlanReport> => {
    const settings = await requireSettings();
    const cfg = buildConfig(args.instanceId, settings, args.collectionUuid);
    const auth = buildAuth(cfg, tokens());
    const client = buildClient(cfg, auth);

    const sheet = applyOverrides(await readSheet(args.sheetPath), args.overrides ?? {});
    const paths = await schemaPaths();
    const manifest = await buildManifest(sheet, args.filesDir, paths, {
      baseUrl: cfg.baseUrl,
      collectionUuid: cfg.collectionUuid,
      schemaUuid: cfg.schemaUuid,
      itemState: args.itemState,
    });

    manifest.warnings.push(...(await preflightDuplicates(client, manifest)));

    const manifestPath = join(userData(), 'job.json');
    await saveManifest(manifestPath, manifest);

    // Report columns against the OVERRIDDEN headers, so a column the user
    // remapped shows as valid. Do not hard-code `valid: true` -- if an
    // override is itself wrong, the UI must still say so.
    const { invalid } = validateHeaders(sheet.headers, paths);
    const invalidSet = new Map(invalid.map((i) => [i.header, i.suggestions]));
    return {
      manifestPath,
      entryCount: manifest.entries.length,
      columns: sheet.headers.map((h) => ({
        header: h,
        valid: !invalidSet.has(h),
        suggestions: invalidSet.get(h) ?? [],
      })),
      invalidHeaders: invalid,
      warnings: manifest.warnings,
    };
  });

  ipcMain.handle(CHANNELS.run, async (_e, args): Promise<RunReport> => {
    const settings = await requireSettings();
    const manifest = await loadManifest(args.manifestPath);
    const cfg = buildConfig(args.instanceId, settings, manifest.collectionUuid);
    const auth = buildAuth(cfg, tokens());
    const client = buildClient(cfg, auth);

    const summary = await runManifest(client, args.manifestPath, {
      onProgress: (entry, done, total) => {
        getWindow()?.webContents.send(CHANNELS.progress, {
          done,
          total,
          fileName: entry.fileName,
          status: entry.status,
          error: entry.error,
        });
      },
    });

    const done = await loadManifest(args.manifestPath);
    return {
      ...summary,
      failures: done.entries
        .filter((e) => e.status === 'failed')
        .map((e) => ({ rowNumber: e.rowNumber, fileName: e.fileName, error: e.error ?? 'unknown' })),
    };
  });

  ipcMain.handle(CHANNELS.retryFailed, async (_e, manifestPath: string) => {
    const m = await loadManifest(manifestPath);
    for (const e of m.entries) {
      if (e.status === 'failed') {
        e.status = 'pending';
        e.attempts = 0;
        delete e.error;
      }
    }
    await saveManifest(manifestPath, m);
  });

  ipcMain.handle(CHANNELS.loadManifest, async (_e, p: string) => loadManifest(p));
}
```

- [ ] **Step 2: Wire into `main.ts`**

Call `registerHandlers(() => mainWindow)` after the window is created, keeping a module-level reference to it.

- [ ] **Step 3: Verify and commit**

Run: `npm run build:desktop && npm run typecheck && npm test`

```bash
git add src/desktop/handlers.ts src/desktop/main.ts
git commit -m "feat(desktop): IPC handlers over the existing core"
```

---

## Task 7: UI — Setup, Sign-in, Choose

**Files:** Create `src/desktop/ui/app.ts`, `src/desktop/ui/screens/*.ts`, `src/desktop/ui/styles.css`; update `index.html`

- [ ] **Step 1: Screen routing in `app.ts`**

A simple state machine: `setup → signin → choose → review → confirm → progress → results`. On launch, call `hasSettings()`; if false go to Setup, else Sign-in.

- [ ] **Step 2: Setup screen**

Two fields (client ID, secret), a Save button, and text explaining these come from the administrator and are stored encrypted for this Windows user only. Secret field is `type="password"`.

- [ ] **Step 3: Sign-in screen**

Instance dropdown from `INSTANCES`, a Sign in button, and the resulting "Signed in as \<name\>". Make explicit that this name is who will own the created items.

- [ ] **Step 4: Instance banner**

A persistent bar at the top of every screen naming the current instance. **Production is red**, Test is neutral. This exists because the collection uuid is identical on both instances, so the banner is the only durable visual cue.

- [ ] **Step 5: Choose screen**

Collection dropdown from `listCollections`, spreadsheet picker, folder picker, and a Continue button that stays disabled until all three are set.

- [ ] **Step 6: Verify and commit**

Run: `npm run desktop`, walk through Setup → Sign-in → Choose against the **test** instance.

```bash
git add src/desktop/ui
git commit -m "feat(desktop): setup, sign-in and choose screens"
```

---

## Task 8: UI — Review, Confirm, Progress, Results

**Files:** `src/desktop/ui/screens/*.ts`

- [ ] **Step 1: Review screen**

A table of every column: header, valid/invalid, and for invalid ones a dropdown of `suggestions` plus the full xpath list, writing into an `overrides` map. Below it, the plan warnings grouped into: rows whose file is missing, files with no row, and identifiers that may already exist.

Continue is disabled while any column is invalid and unmapped.

- [ ] **Step 2: Confirm screen**

Item count, instance, collection, and item state. Draft is selected by default.

**Publishing requires typing the item count** into a field, on a panel stating that this collection has no moderation workflow and items become visible immediately. The Upload button stays disabled until the typed number matches. A dialog with an OK button is not a safeguard.

- [ ] **Step 3: Progress screen**

Subscribe to `onProgress`. Show `done/total`, a bar, the current filename, and a scrolling log of completed rows.

- [ ] **Step 4: Results screen**

Counts, a table of failures with row number, file and reason, a **Retry failed** button, and a link that opens the collection in the default browser.

If `interrupted > 0`, explain plainly: a previous run stopped midway on those rows, the item may or may not exist, check the collection before reprocessing.

- [ ] **Step 5: Verify and commit**

Run a real end-to-end upload of two small files into the **test** collection.

```bash
git add src/desktop/ui
git commit -m "feat(desktop): review, confirm, progress and results screens"
```

---

## Task 9: Packaging

**Files:** `electron-builder.yml`, `docs/INSTALL.md`

- [ ] **Step 1: Ensure `schema/_entity.xml` is bundled**

`handlers.ts` reads it via `app.getAppPath()`. Add to `electron-builder.yml`:

```yaml
extraResources:
  - from: schema/_entity.xml
    to: schema/_entity.xml
```

and read it from `process.resourcesPath` when packaged. Verify both packaged and unpackaged paths work.

- [ ] **Step 2: Build**

Run: `npm run dist`
Expected: `release/` contains a portable `.exe` and an NSIS installer.

- [ ] **Step 3: Write `docs/INSTALL.md`**

Cover: copying from the network share; the SmartScreen warning with a screenshot and the exact click path (**More info → Run anyway**); entering the client ID and secret supplied separately; signing in; and that items are created as drafts which must be submitted in openEQUELLA.

State plainly that credentials are **not** included in the download and must come from the administrator.

- [ ] **Step 4: Commit**

```bash
git add electron-builder.yml docs/INSTALL.md
git commit -m "build(desktop): windows packaging and install instructions"
```

---

## Task 10: Verification

- [ ] **Step 1: Full suite**

Run: `npm test && npm run typecheck && npm run build && npm run build:desktop`
Expected: 252+ tests pass, both builds clean. Do not proceed if anything fails.

- [ ] **Step 2: Confirm no credentials in the artifact**

Search the built `release/` tree for the client ID and any `.env` content. Expected: nothing. This is the claim the whole distribution rests on.

- [ ] **Step 3: Clean-machine test**

Copy the portable build to a Windows machine with **no Node installed**. Verify: it launches; SmartScreen behaves as documented; Setup accepts credentials; sign-in completes in the embedded window; a two-file upload into the **test** collection succeeds; the items appear correctly in openEQUELLA.

This is the only way to prove the "zero prerequisites" claim, and no automated test in this repo can establish it.

- [ ] **Step 4: Confirm the safety rails by trying to defeat them**

- The instance banner is visible on every screen and red on Production.
- The collection dropdown offers only collections the signed-in user can contribute to.
- Publishing is impossible without typing the exact item count.
- Signing out and reopening requires signing in again.
- A token obtained on Test is refused after switching to Production.

- [ ] **Step 5: Commit and push**

---

## Self-review notes

**Spec coverage:** Electron app (1) · renderer isolation (1, 3) · OS-encrypted credentials and token (2) · instance dropdown with per-instance redirect URI (3, 4) · session-first, origin-matched sign-in (5) · collection picker from CREATE_ITEM (6, 7) · in-app column remapping without touching the file (6, 8) · duplicate pre-flight (6) · draft default with typed publish confirmation (8) · progress and per-row failures (8) · packaging and SmartScreen guidance (9) · clean-machine proof (10).

**Known gaps, deliberate:**

1. `signin.ts` has no unit test — it is Electron window orchestration, and a mock-based test would assert against the mock rather than the behaviour. Covered by Task 10 Step 3.
2. Column overrides are per-run and not persisted, per the spec. A saved mapping profile is v2.
3. No auto-update and no code signing. Signing is a build-config change when a certificate exists.
4. **Tasks 7 and 8 specify the UI by behaviour and data rather than by complete
   markup.** Every other task carries runnable code; these two would need
   several thousand lines of HTML/CSS to do the same, which would obscure the
   requirements rather than clarify them. What each screen must show, what it
   must disable, and which IPC calls it makes are stated precisely — the
   implementer chooses the markup. If a task feels underspecified while
   building it, that is a signal to ask rather than improvise, particularly
   around the Confirm screen's publish guard.

**Verified against the source while writing this plan:**

- `OeqClient.listCollections` takes an options object, not a positional
  privilege string. The first draft of Task 6 would not have compiled.
- `OeqClient.currentUser()` takes no arguments and returns
  `{ username, firstName, lastName }` — no `guest` field, so "am I signed in?"
  is answered by the call succeeding, not by inspecting a flag.
- `CollectionSummary` is `{ uuid, name }`, with `name` already resolved from
  openEQUELLA's untyped `I18NString` by the client.
