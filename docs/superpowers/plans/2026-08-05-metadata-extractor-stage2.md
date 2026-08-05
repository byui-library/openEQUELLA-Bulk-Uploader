# Metadata Extractor — Stage 2 (desktop screens) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the desktop app a three-step Extract flow that builds the upload spreadsheet from a folder of files, with the spreadsheet's columns fully editable.

**Architecture:** All extraction logic already exists in `src/core/extract/` and is not touched. This stage adds seven IPC channels over it, five pure logic modules under `src/desktop/ui/extract/`, and three screens. The renderer stays sandboxed with no Node access, so every filesystem operation crosses IPC.

**Tech Stack:** TypeScript on Node 22, Electron 33, vitest. No jsdom — screens stay thin and all testable logic lives in plain modules.

**Spec:** [../specs/2026-08-05-metadata-extractor-design.md](../specs/2026-08-05-metadata-extractor-design.md), sections "User interface" and "Delivery order".

**Depends on:** Stage 1 (`feature/metadata-extractor`, PR #2). Do not start until it is merged.

**Branch:** create `feature/extractor-desktop` from `main` after PR #2 merges.

---

## Things you must know before starting

You know nothing about this codebase. None of this is optional background.

1. **Relative imports need a `.js` extension**, even from `.ts` files (`moduleResolution: nodenext`). The file on disk is `state.ts`; you import `'./state.js'`.
2. **`strict` and `noUncheckedIndexedAccess` are on.** `arr[0]` is `T | undefined`.
3. **The renderer is sandboxed and has no Node access.** No `fs`, no `path`, no `require`. Anything touching disk goes through IPC. If a screen seems to need Node, the work is in the wrong process.
4. **`CHANNELS` is duplicated in `src/desktop/preload.cts`** as a literal, because a sandboxed preload can only `require` Electron's own built-ins — importing a value from a local module aborts the whole preload silently and leaves `window.oeq` undefined. `tests/desktop/preload-channels.test.ts` guards the two copies against drift. **Every channel you add must be added in both places** or that test fails.
5. **There is no jsdom.** Screens are thin `render*(root, props)` functions that build `innerHTML`; they are not unit tested directly. All logic worth testing lives in separate modules under `src/desktop/ui/extract/` and is tested as pure functions.
6. **`escapeHtml` from `src/desktop/ui/dom.ts` wraps EVERY interpolated value**, in text and attribute contexts alike. A previous version escaped too little and a collection uuid carrying `evil" onmouseover="..."` rendered a live attribute. Do not add a second escaper and do not skip it "because this value is safe".
7. **Do not add screens or state to `src/desktop/ui/app.ts`.** It is 802 lines and no test imports it. The extract flow owns its own controller; `app.ts` gains a handful of lines only.
8. Run `npm run typecheck` before every commit. Run tests with `NO_COLOR=1 npx vitest run <path>` so counts are readable.

## File structure

| File | Responsibility |
| --- | --- |
| `src/desktop/ui/extract/state.ts` | The flow's state and its transitions. Pure. |
| `src/desktop/ui/extract/segments.ts` | Split a sample filename by a pattern, for the "your files look like this" display |
| `src/desktop/ui/extract/sources.ts` | Build each column's source dropdown from evidence actually found in the folder |
| `src/desktop/ui/extract/picker.ts` | Schema paths available to add, with plain-language labels |
| `src/desktop/ui/extract/controller.ts` | Owns the flow; the only thing `app.ts` calls |
| `src/desktop/ui/screens/extractFolder.ts` | Step 1 — pick the folder, report what is in it |
| `src/desktop/ui/screens/extractColumns.ts` | Step 2 — the column editor and live preview |
| `src/desktop/ui/screens/extractSave.ts` | Step 3 — summary and save |

Tasks 1–8 build the plumbing and the two simple screens. Tasks 9–16 build the column editor, wire it up, and document it. `requireEl` referenced in Task 14 is a local helper already inside `app.ts` — it is not exported and does not need to be.

---

## Task 1: IPC contract

**Files:**
- Modify: `src/desktop/ipc.ts`
- Modify: `src/desktop/preload.cts`
- Test: `tests/desktop/preload-channels.test.ts` (already exists; it must keep passing)

- [ ] **Step 1: Add the types and channels to `src/desktop/ipc.ts`**

Add near the other imports:

```ts
import type { Profile } from '../core/extract/types.js';
import type { ExtractedRow } from '../core/extract/types.js';
```

Add these interfaces above `export const CHANNELS`:

```ts
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
```

Add to the `OeqApi` interface, after `loadManifest`:

```ts
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
```

Add to `CHANNELS`:

```ts
  extractScan: 'oeq:extractScan',
  extractPreview: 'oeq:extractPreview',
  extractRun: 'oeq:extractRun',
  schemaPaths: 'oeq:schemaPaths',
  openProfile: 'oeq:openProfile',
  saveProfileAs: 'oeq:saveProfileAs',
  chooseCsvPath: 'oeq:chooseCsvPath',
```

- [ ] **Step 2: Mirror them in `src/desktop/preload.cts`**

Add the same seven entries to the `CHANNELS` literal there, and add to the `api` object:

```ts
  extractScan: (dir) => invoke(CHANNELS.extractScan, dir),
  extractPreview: (args) => invoke(CHANNELS.extractPreview, args),
  extractRun: (args) => invoke(CHANNELS.extractRun, args),
  schemaPaths: () => invoke(CHANNELS.schemaPaths),
  openProfile: () => invoke(CHANNELS.openProfile),
  saveProfileAs: (profile) => invoke(CHANNELS.saveProfileAs, profile),
  chooseCsvPath: () => invoke(CHANNELS.chooseCsvPath),
```

- [ ] **Step 3: Run the drift guard**

Run: `NO_COLOR=1 npx vitest run tests/desktop/preload-channels.test.ts`
Expected: PASS. If it fails, the two `CHANNELS` copies disagree — fix the copy, do not weaken the test. That test exists because a mismatched preload fails silently: the window opens normally and `window.oeq` is simply undefined.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add src/desktop/ipc.ts src/desktop/preload.cts
git commit -m "feat(desktop): IPC contract for the extract flow"
```

---

## Task 2: Handlers

**Files:**
- Modify: `src/desktop/handlers.ts`
- Test: `tests/desktop/extractHandlers.test.ts`

**Note on the cache:** the preview is called on every edit, and re-reading a 300-file folder each time would make the UI unusable. Documents are read once per folder and cached in the main process. The cache is keyed by directory and cleared when a different folder is scanned — it is a preview accelerator, not a correctness mechanism, and `extractRun` always reads fresh.

- [ ] **Step 1: Write the failing test**

```ts
// tests/desktop/extractHandlers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerExtractHandlers, __resetExtractCache } from '../../src/desktop/extractHandlers.js';
import { makePdf } from '../fixtures/extract/make.js';
import { ATTACHMENT_COLUMN, type Profile } from '../../src/core/extract/types.js';

/** A stand-in for Electron's ipcMain that just records the handlers. */
function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();
  return {
    handle(channel: string, fn: (event: unknown, ...args: any[]) => unknown) {
      handlers.set(channel, fn);
    },
    call<T>(channel: string, ...args: unknown[]): Promise<T> {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return Promise.resolve(fn({}, ...args) as T);
    },
    channels: () => [...handlers.keys()],
  };
}

const profile: Profile = {
  version: 1,
  pattern: '{title}.pdf',
  columns: [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
  ],
};

async function folder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-eh-'));
  await writeFile(join(dir, 'Recital.pdf'), makePdf({ text: 'Performer: Jane Smith' }));
  await writeFile(join(dir, 'notes.txt'), 'x');
  return dir;
}

describe('extract handlers', () => {
  beforeEach(() => __resetExtractCache());

  it('registers every extract channel', () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml' });
    expect(ipc.channels()).toEqual(
      expect.arrayContaining([
        'oeq:extractScan', 'oeq:extractPreview', 'oeq:extractRun', 'oeq:schemaPaths',
      ]),
    );
  });

  it('scan reports supported files, skipped files and the labels it found', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml' });
    const scan = await ipc.call<{ supported: string[]; skipped: { file: string }[]; labels: string[] }>(
      'oeq:extractScan', await folder(),
    );
    expect(scan.supported).toEqual(['Recital.pdf']);
    expect(scan.skipped.map((s) => s.file)).toEqual(['notes.txt']);
    expect(scan.labels).toContain('Performer');
  });

  it('preview returns rows without writing anything', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml' });
    const dir = await folder();
    const rows = await ipc.call<{ cells: Record<string, string> }[]>('oeq:extractPreview', { dir, profile });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cells['MWDL/title']).toBe('Recital');
  });

  it('preview caps how many rows it builds', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml' });
    const dir = await mkdtemp(join(tmpdir(), 'oeq-eh-'));
    for (let i = 0; i < 9; i++) await writeFile(join(dir, `f${i}.pdf`), makePdf({ text: 'x' }));
    const rows = await ipc.call<unknown[]>('oeq:extractPreview', { dir, profile });
    expect(rows).toHaveLength(5);
  });

  it('run writes the file and reports what needs review', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml' });
    const dir = await folder();
    const outPath = join(dir, 'out.csv');
    const report = await ipc.call<{ written: number; flagged: number; outPath: string }>(
      'oeq:extractRun', { dir, profile, outPath },
    );
    expect(report.written).toBe(1);
    expect(report.outPath).toBe(outPath);
    const { readSheet } = await import('../../src/core/sheet.js');
    expect((await readSheet(outPath)).rows).toHaveLength(1);
  });

  it('schemaPaths returns the real schema leaf paths', async () => {
    const ipc = fakeIpcMain();
    registerExtractHandlers(ipc as never, { schemaFile: 'schema/_entity.xml' });
    const paths = await ipc.call<string[]>('oeq:schemaPaths');
    expect(paths).toContain('MWDL/title');
    expect(paths.length).toBeGreaterThan(100);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NO_COLOR=1 npx vitest run tests/desktop/extractHandlers.test.ts`
Expected: FAIL — cannot find module `extractHandlers.js`.

- [ ] **Step 3: Implement**

```ts
// src/desktop/extractHandlers.ts
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { IpcMain } from 'electron';
import { dialog } from 'electron';
import { extractDefinition, parseSchemaPaths } from '../core/schema.js';
import { extractFolder } from '../core/extract/extract.js';
import { readDocument, isSupported } from '../core/extract/readers/index.js';
import { findLabels } from '../core/extract/labels.js';
import { buildRow } from '../core/extract/rows.js';
import { writeCsv } from '../core/extract/csv.js';
import { loadProfile, saveProfile, parseProfile } from '../core/extract/profile.js';
import { DOCUMENT_PROPERTIES, type DocumentData, type ExtractedRow, type Profile } from '../core/extract/types.js';
import { CHANNELS, type ExtractScan, type ExtractRunReport } from './ipc.js';

const PREVIEW_ROWS = 5;
/** How many documents to open when scanning, to learn what can be mapped from. */
const SAMPLE_DOCS = 5;

interface CacheEntry {
  dir: string;
  docs: { filename: string; doc: DocumentData }[];
}
let cache: CacheEntry | null = null;

/** Exported for tests. The cache is a preview accelerator, never a source of truth. */
export function __resetExtractCache(): void {
  cache = null;
}

async function sample(dir: string, filenames: string[]): Promise<CacheEntry> {
  if (cache?.dir === dir) return cache;
  const docs: { filename: string; doc: DocumentData }[] = [];
  for (const filename of filenames.slice(0, Math.max(PREVIEW_ROWS, SAMPLE_DOCS))) {
    try {
      docs.push({ filename, doc: await readDocument(join(dir, filename)) });
    } catch {
      // A file that will not open is reported by extractScan's skipped list;
      // it must not stop the sample, or one bad file blanks the whole preview.
    }
  }
  cache = { dir, docs };
  return cache;
}

export interface ExtractHandlerOptions {
  /** Path to the schema export. Resolved by the caller, which knows if the app is packaged. */
  schemaFile: string;
}

export function registerExtractHandlers(ipcMain: IpcMain, options: ExtractHandlerOptions): void {
  ipcMain.handle(CHANNELS.extractScan, async (_e, dir: string): Promise<ExtractScan> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort((a, b) => a.localeCompare(b));
    const supported = files.filter(isSupported);

    const skipped = files
      .filter((f) => !isSupported(f))
      .map((file) => ({
        file,
        reason: file.toLowerCase().endsWith('.doc')
          ? 'Word 2003 and earlier (.doc) cannot be read -- save as .docx first'
          : 'unsupported file type',
      }));

    cache = null;
    const { docs } = await sample(dir, supported);

    const labels = new Set<string>();
    const properties = new Set<string>();
    for (const { doc } of docs) {
      for (const label of findLabels(doc.text).keys()) labels.add(label);
      for (const key of DOCUMENT_PROPERTIES) if (doc.properties[key] !== undefined) properties.add(key);
    }

    return { supported, skipped, labels: [...labels].sort(), properties: [...properties] };
  });

  ipcMain.handle(
    CHANNELS.extractPreview,
    async (_e, args: { dir: string; profile: Profile }): Promise<ExtractedRow[]> => {
      const entries = await readdir(args.dir, { withFileTypes: true });
      const supported = entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .filter(isSupported)
        .sort((a, b) => a.localeCompare(b));

      const { docs } = await sample(args.dir, supported);
      return docs
        .slice(0, PREVIEW_ROWS)
        .map(({ filename, doc }) => buildRow(args.profile, filename, doc));
    },
  );

  ipcMain.handle(
    CHANNELS.extractRun,
    async (_e, args: { dir: string; profile: Profile; outPath: string }): Promise<ExtractRunReport> => {
      // Deliberately does NOT use the preview cache: the real run reads every
      // file fresh, so what is written can never be stale relative to disk.
      const result = await extractFolder(args.dir, args.profile);
      await writeCsv(args.outPath, args.profile, result.rows);
      return {
        outPath: args.outPath,
        written: result.rows.length,
        flagged: result.rows.filter((r) => r.notes.length > 0).length,
      };
    },
  );

  ipcMain.handle(CHANNELS.schemaPaths, async (): Promise<string[]> => {
    const xml = await readFile(options.schemaFile, 'utf8');
    return [...parseSchemaPaths(extractDefinition(xml))].sort();
  });

  ipcMain.handle(CHANNELS.openProfile, async (): Promise<{ path: string; profile: Profile } | null> => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Extraction profile', extensions: ['json'] }],
    });
    const path = r.canceled ? null : (r.filePaths[0] ?? null);
    if (path === null) return null;
    return { path, profile: await loadProfile(path) };
  });

  ipcMain.handle(CHANNELS.saveProfileAs, async (_e, profile: Profile): Promise<string | null> => {
    const r = await dialog.showSaveDialog({
      defaultPath: 'extraction.profile.json',
      filters: [{ name: 'Extraction profile', extensions: ['json'] }],
    });
    if (r.canceled || r.filePath === undefined) return null;
    // Re-validated on the way out so a profile assembled in the UI cannot be
    // saved in a state the loader would later refuse.
    await saveProfile(r.filePath, parseProfile(profile));
    return r.filePath;
  });

  ipcMain.handle(CHANNELS.chooseCsvPath, async (): Promise<string | null> => {
    const r = await dialog.showSaveDialog({
      defaultPath: 'extracted.csv',
      filters: [{ name: 'Spreadsheet', extensions: ['csv'] }],
    });
    return r.canceled || r.filePath === undefined ? null : r.filePath;
  });
}
```

`noUnusedLocals` is on — if you end up not using an import, remove it rather than leaving it.

- [ ] **Step 4: Run the tests**

Run: `NO_COLOR=1 npx vitest run tests/desktop/extractHandlers.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Register from `handlers.ts`**

In `src/desktop/handlers.ts`, add the import at the top:

```ts
import { registerExtractHandlers } from './extractHandlers.js';
```

and inside the existing registration function, after the last `ipcMain.handle(...)` call, add:

```ts
  // Extract flow. Kept in its own module so this file does not keep growing,
  // and so the schema path is resolved once, here, where packaging is known.
  registerExtractHandlers(ipcMain, {
    schemaFile: resolveResourcePath(opts, 'schema', '_entity.xml'),
  });
```

`resolveResourcePath` already exists in `handlers.ts` and is exported; `opts` is
the `{ isPackaged, appPath, resourcesPath }` object the surrounding registration
function already receives. Do not re-derive the packaged/unpackaged branch — its
doc comment explains why `appPath` is not `app.getAppPath()`, and getting it
wrong fails only in the packaged build.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/desktop/extractHandlers.ts src/desktop/handlers.ts tests/desktop/extractHandlers.test.ts
git commit -m "feat(desktop): main-process handlers for the extract flow"
```

---

## Task 3: Flow state

**Files:**
- Create: `src/desktop/ui/extract/state.ts`
- Test: `tests/desktop/ui/extract/state.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/desktop/ui/extract/state.test.ts
import { describe, it, expect } from 'vitest';
import { initialExtractState, canContinue, type ExtractState } from '../../../../src/desktop/ui/extract/state.js';
import { ATTACHMENT_COLUMN, type Profile } from '../../../../src/core/extract/types.js';

const profile: Profile = {
  version: 1,
  pattern: '{a}.pdf',
  columns: [{ path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true }],
};

function state(over: Partial<ExtractState> = {}): ExtractState {
  return { ...initialExtractState(), ...over };
}

describe('initialExtractState', () => {
  it('starts on the folder step with nothing chosen', () => {
    const s = initialExtractState();
    expect(s.step).toBe('folder');
    expect(s.dir).toBeNull();
    expect(s.profile).toBeNull();
  });
});

describe('canContinue', () => {
  it('is false on the folder step until a folder with supported files is chosen', () => {
    expect(canContinue(state())).toBe(false);
    expect(canContinue(state({ dir: 'C:/x', scan: { supported: [], skipped: [], labels: [], properties: [] } }))).toBe(false);
  });

  it('is true once the folder holds at least one supported file', () => {
    expect(
      canContinue(state({ dir: 'C:/x', scan: { supported: ['a.pdf'], skipped: [], labels: [], properties: [] } })),
    ).toBe(true);
  });

  it('is false on the columns step without a profile', () => {
    expect(canContinue(state({ step: 'columns' }))).toBe(false);
  });

  it('is true on the columns step with a profile', () => {
    expect(canContinue(state({ step: 'columns', profile }))).toBe(true);
  });

  it('is false while a run is in flight, on any step', () => {
    expect(canContinue(state({ step: 'columns', profile, busy: true }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NO_COLOR=1 npx vitest run tests/desktop/ui/extract/state.test.ts`
Expected: FAIL — cannot find module `state.js`.

- [ ] **Step 3: Implement**

```ts
// src/desktop/ui/extract/state.ts
import type { ExtractScan } from '../../ipc.js';
import type { ExtractedRow, Profile } from '../../../core/extract/types.js';

export type ExtractStep = 'folder' | 'columns' | 'save';

export interface ExtractState {
  step: ExtractStep;
  dir: string | null;
  scan: ExtractScan | null;
  profile: Profile | null;
  /** Where the profile came from, shown so the operator knows what they are editing. */
  profilePath: string | null;
  preview: ExtractedRow[];
  /** Every valid schema xpath, for the Add-column picker. */
  schemaPaths: string[];
  /** True while an IPC call is in flight. Disables the controls rather than stacking calls. */
  busy: boolean;
  error: string | null;
  /** Set once the spreadsheet has been written. */
  savedPath: string | null;
  savedFlagged: number;
}

export function initialExtractState(): ExtractState {
  return {
    step: 'folder',
    dir: null,
    scan: null,
    profile: null,
    profilePath: null,
    preview: [],
    schemaPaths: [],
    busy: false,
    error: null,
    savedPath: null,
    savedFlagged: 0,
  };
}

/**
 * Whether the current step's Continue is enabled. Kept here rather than in the
 * screens so the rule is testable without a DOM, matching how ui/confirm.ts
 * holds the upload gate for the Confirm screen.
 */
export function canContinue(state: ExtractState): boolean {
  if (state.busy) return false;
  switch (state.step) {
    case 'folder':
      return state.dir !== null && (state.scan?.supported.length ?? 0) > 0;
    case 'columns':
      return state.profile !== null;
    case 'save':
      return state.savedPath === null;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `NO_COLOR=1 npx vitest run tests/desktop/ui/extract/state.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/desktop/ui/extract/state.ts tests/desktop/ui/extract/state.test.ts
git commit -m "feat(desktop): extract flow state"
```

---

## Task 4: Filename segment display

**Files:**
- Create: `src/desktop/ui/extract/segments.ts`
- Test: `tests/desktop/ui/extract/segments.test.ts`

**What this is for:** the "Your files look like this" display at the top of the columns screen shows a real filename with each placeholder's captured text underneath. This computes that, so nobody has to read a `{template}` and imagine what it does.

- [ ] **Step 1: Write the failing test**

```ts
// tests/desktop/ui/extract/segments.test.ts
import { describe, it, expect } from 'vitest';
import { describeFilename } from '../../../../src/desktop/ui/extract/segments.js';

describe('describeFilename', () => {
  it('pairs each placeholder with what it captured', () => {
    expect(describeFilename('{last}_{first}.pdf', 'Smith_Jane.pdf')).toEqual({
      matched: true,
      parts: [
        { name: 'last', value: 'Smith' },
        { name: 'first', value: 'Jane' },
      ],
    });
  });

  it('reports no match without throwing, and still lists the placeholder names', () => {
    expect(describeFilename('{last}_{first}.pdf', 'nomatch.pdf')).toEqual({
      matched: false,
      parts: [
        { name: 'last', value: '' },
        { name: 'first', value: '' },
      ],
    });
  });

  it('reports no match for a pattern that is not valid', () => {
    expect(describeFilename('{a}_{a}.pdf', 'x_y.pdf')).toEqual({ matched: false, parts: [] });
  });

  it('handles a pattern with no placeholders', () => {
    expect(describeFilename('report.pdf', 'report.pdf')).toEqual({ matched: true, parts: [] });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NO_COLOR=1 npx vitest run tests/desktop/ui/extract/segments.test.ts`
Expected: FAIL — cannot find module `segments.js`.

- [ ] **Step 3: Implement**

```ts
// src/desktop/ui/extract/segments.ts
import { applyPattern, placeholders } from '../../../core/extract/pattern.js';

export interface FilenameDescription {
  matched: boolean;
  parts: { name: string; value: string }[];
}

/**
 * Show what a pattern actually does to a real filename, so the operator can
 * see the result rather than reason about the template. A pattern that is
 * itself invalid (a repeated placeholder) reports no match rather than
 * throwing: this runs on every keystroke while the pattern is being edited,
 * and half-typed input is normal, not exceptional.
 */
export function describeFilename(pattern: string, filename: string): FilenameDescription {
  let names: string[];
  try {
    names = placeholders(pattern);
  } catch {
    return { matched: false, parts: [] };
  }

  const captured = applyPattern(pattern, filename);
  if (captured === null) {
    return { matched: false, parts: names.map((name) => ({ name, value: '' })) };
  }
  return { matched: true, parts: names.map((name) => ({ name, value: captured[name] ?? '' })) };
}
```

- [ ] **Step 4: Run the tests**

Run: `NO_COLOR=1 npx vitest run tests/desktop/ui/extract/segments.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/desktop/ui/extract/segments.ts tests/desktop/ui/extract/segments.test.ts
git commit -m "feat(desktop): show what a pattern does to a real filename"
```

---

## Task 5: Step 1 screen — choose the folder

**Files:**
- Create: `src/desktop/ui/screens/extractFolder.ts`
- Test: none directly (no jsdom); its logic is Task 3's `canContinue`

- [ ] **Step 1: Implement the screen**

```ts
// src/desktop/ui/screens/extractFolder.ts
import { escapeHtml } from '../dom.js';
import type { ExtractScan } from '../../ipc.js';

export interface ExtractFolderProps {
  dir: string | null;
  scan: ExtractScan | null;
  busy: boolean;
  error: string | null;
  canContinue: boolean;
  onChooseFolder(): void;
  onContinue(): void;
  onCancel(): void;
}

/**
 * Step 1 of 3. Reports what is in the folder immediately on selection --
 * including, explicitly, what will NOT be read. A file silently missing from
 * the output is indistinguishable from a file that was never there, so it is
 * named here before anything else happens.
 */
export function renderExtractFolder(root: HTMLElement, props: ExtractFolderProps): void {
  const summary =
    props.scan === null
      ? ''
      : `
      <p class="summary">
        <strong>${props.scan.supported.length}</strong> file(s) can be read.
      </p>
      ${
        props.scan.skipped.length === 0
          ? ''
          : `<details class="warn" open>
               <summary>${props.scan.skipped.length} file(s) will be skipped</summary>
               <ul>${props.scan.skipped
                 .map((s) => `<li><code>${escapeHtml(s.file)}</code> &mdash; ${escapeHtml(s.reason)}</li>`)
                 .join('')}</ul>
             </details>`
      }
      ${
        props.scan.supported.length === 0
          ? `<p class="error" role="alert">Nothing in this folder can be read. The extractor handles PDF and .docx files.</p>`
          : ''
      }`;

  root.innerHTML = `
    <section class="screen" aria-labelledby="extract-folder-h">
      <h2 id="extract-folder-h">Build a spreadsheet &mdash; step 1 of 3</h2>
      <p>Choose the folder holding the files you want to describe.</p>

      <div class="field">
        <button id="extract-choose-folder" type="button" ${props.busy ? 'disabled' : ''}>
          Choose folder&hellip;
        </button>
        <span class="path">${props.dir === null ? 'No folder chosen' : escapeHtml(props.dir)}</span>
      </div>

      ${summary}
      ${props.error === null ? '' : `<p class="error" role="alert">${escapeHtml(props.error)}</p>`}

      <div class="actions">
        <button id="extract-cancel" type="button">Cancel</button>
        <button id="extract-continue" type="button" ${props.canContinue ? '' : 'disabled'}>Continue</button>
      </div>
    </section>`;

  root.querySelector<HTMLButtonElement>('#extract-choose-folder')?.addEventListener('click', props.onChooseFolder);
  root.querySelector<HTMLButtonElement>('#extract-continue')?.addEventListener('click', props.onContinue);
  root.querySelector<HTMLButtonElement>('#extract-cancel')?.addEventListener('click', props.onCancel);
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck
git add src/desktop/ui/screens/extractFolder.ts
git commit -m "feat(desktop): extract step 1, choose a folder"
```

---

## Task 6: Step 3 screen — save

**Files:**
- Create: `src/desktop/ui/screens/extractSave.ts`

Built before step 2 deliberately: it is small, and having both ends in place makes the middle screen's job obvious.

- [ ] **Step 1: Implement the screen**

```ts
// src/desktop/ui/screens/extractSave.ts
import { escapeHtml } from '../dom.js';

export interface ExtractSaveProps {
  fileCount: number;
  flagged: number;
  savedPath: string | null;
  busy: boolean;
  error: string | null;
  onSave(): void;
  onBack(): void;
  onOpenFolder(): void;
  onDone(): void;
}

/**
 * Step 3 of 3. There is deliberately no "use this now" button: the convenient
 * path must not be the one that skips opening the spreadsheet, because the
 * guesses are exactly what needs reviewing (spec, "Output model").
 */
export function renderExtractSave(root: HTMLElement, props: ExtractSaveProps): void {
  const done = props.savedPath !== null;

  root.innerHTML = `
    <section class="screen" aria-labelledby="extract-save-h">
      <h2 id="extract-save-h">Build a spreadsheet &mdash; step 3 of 3</h2>

      ${
        done
          ? `<p class="summary">Saved to <code>${escapeHtml(props.savedPath!)}</code></p>
             <p><strong>Open it in Excel and check it before uploading.</strong>
             The <code>_notes</code> column says which rows need a look, and
             <code>_source</code> says where each value came from. Delete both
             columns or leave them &mdash; the uploader ignores them.</p>`
          : `<p class="summary">
               <strong>${props.fileCount}</strong> row(s) will be written.
               ${
                 props.flagged === 0
                   ? 'None need review.'
                   : `<strong>${props.flagged}</strong> need review &mdash; see the <code>_notes</code> column.`
               }
             </p>`
      }

      ${props.error === null ? '' : `<p class="error" role="alert">${escapeHtml(props.error)}</p>`}

      <div class="actions">
        ${done ? '' : `<button id="extract-back" type="button">Back</button>`}
        ${
          done
            ? `<button id="extract-open-folder" type="button">Open containing folder</button>
               <button id="extract-done" type="button">Done</button>`
            : `<button id="extract-save" type="button" ${props.busy ? 'disabled' : ''}>
                 ${props.busy ? 'Writing&hellip;' : 'Save spreadsheet&hellip;'}
               </button>`
        }
      </div>
    </section>`;

  root.querySelector<HTMLButtonElement>('#extract-save')?.addEventListener('click', props.onSave);
  root.querySelector<HTMLButtonElement>('#extract-back')?.addEventListener('click', props.onBack);
  root.querySelector<HTMLButtonElement>('#extract-open-folder')?.addEventListener('click', props.onOpenFolder);
  root.querySelector<HTMLButtonElement>('#extract-done')?.addEventListener('click', props.onDone);
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck
git add src/desktop/ui/screens/extractSave.ts
git commit -m "feat(desktop): extract step 3, save the spreadsheet"
```

---

## Task 7: Source options from evidence

**Files:**
- Create: `src/desktop/ui/extract/sources.ts`
- Test: `tests/desktop/ui/extract/sources.test.ts`

**Why "from evidence":** the per-column source dropdown offers only sources that actually exist for these files. A `Performer:` label is offered only if it was found while scanning. Offering every conceivable source would invite the operator to map something that will always be blank.

- [ ] **Step 1: Write the failing test**

```ts
// tests/desktop/ui/extract/sources.test.ts
import { describe, it, expect } from 'vitest';
import { sourceOptions, describeSource } from '../../../../src/desktop/ui/extract/sources.js';

const scan = { supported: ['a.pdf'], skipped: [], labels: ['Performer'], properties: ['title', 'created'] };

describe('sourceOptions', () => {
  it('offers one option per placeholder in the pattern', () => {
    const options = sourceOptions('{last}_{first}.pdf', scan);
    expect(options.filter((o) => 'placeholder' in o.source).map((o) => o.label))
      .toEqual(['Filename part: last', 'Filename part: first']);
  });

  it('offers only labels that were actually found', () => {
    expect(sourceOptions('{a}.pdf', scan).some((o) => o.label === 'Label in document: Performer')).toBe(true);
    expect(sourceOptions('{a}.pdf', scan).some((o) => o.label.includes('Composer'))).toBe(false);
  });

  it('offers only properties that were actually present', () => {
    const labels = sourceOptions('{a}.pdf', scan).map((o) => o.label);
    expect(labels).toContain('Document property: title');
    expect(labels).not.toContain('Document property: author');
  });

  it('offers nothing from an empty scan except the placeholders', () => {
    const empty = { supported: [], skipped: [], labels: [], properties: [] };
    expect(sourceOptions('{a}.pdf', empty).map((o) => o.label)).toEqual(['Filename part: a']);
  });

  it('ignores an invalid pattern instead of throwing', () => {
    expect(() => sourceOptions('{a}_{a}.pdf', scan)).not.toThrow();
  });
});

describe('describeSource', () => {
  it('names each kind of source in plain language', () => {
    expect(describeSource({ placeholder: 'last' })).toBe('Filename part: last');
    expect(describeSource({ join: '{last}, {first}' })).toBe('Filename parts joined as "{last}, {first}"');
    expect(describeSource({ label: 'Performer' })).toBe('Label in document: Performer');
    expect(describeSource({ property: 'title' })).toBe('Document property: title');
    expect(describeSource({ filename: true })).toBe('The file itself');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NO_COLOR=1 npx vitest run tests/desktop/ui/extract/sources.test.ts`
Expected: FAIL — cannot find module `sources.js`.

- [ ] **Step 3: Implement**

```ts
// src/desktop/ui/extract/sources.ts
import { placeholders } from '../../../core/extract/pattern.js';
import type { DocumentProperty, Source } from '../../../core/extract/types.js';
import type { ExtractScan } from '../../ipc.js';

export interface SourceOption {
  label: string;
  source: Source;
}

/** Plain-language name for a source, used in the dropdown and the column list. */
export function describeSource(source: Source): string {
  if ('filename' in source) return 'The file itself';
  if ('placeholder' in source) return `Filename part: ${source.placeholder}`;
  if ('join' in source) return `Filename parts joined as "${source.join}"`;
  if ('label' in source) return `Label in document: ${source.label}`;
  return `Document property: ${source.property}`;
}

/**
 * The sources worth offering for THESE files. Only placeholders the pattern
 * defines, labels actually found while scanning, and properties actually
 * present. Offering everything conceivable would invite mapping a column to
 * something that is always blank.
 */
export function sourceOptions(pattern: string, scan: ExtractScan): SourceOption[] {
  let names: string[] = [];
  try {
    names = placeholders(pattern);
  } catch {
    // A half-typed pattern is normal while editing; offer no filename parts
    // rather than failing the whole dropdown.
    names = [];
  }

  const options: SourceOption[] = names.map((name) => ({
    label: `Filename part: ${name}`,
    source: { placeholder: name },
  }));

  for (const label of scan.labels) {
    options.push({ label: `Label in document: ${label}`, source: { label } });
  }
  for (const property of scan.properties) {
    options.push({
      label: `Document property: ${property}`,
      source: { property: property as DocumentProperty },
    });
  }
  return options;
}
```

- [ ] **Step 4: Run the tests**

Run: `NO_COLOR=1 npx vitest run tests/desktop/ui/extract/sources.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/desktop/ui/extract/sources.ts tests/desktop/ui/extract/sources.test.ts
git commit -m "feat(desktop): offer only sources these files actually have"
```

---

## Task 8: Add-column picker

**Files:**
- Create: `src/desktop/ui/extract/picker.ts`
- Test: `tests/desktop/ui/extract/picker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/desktop/ui/extract/picker.test.ts
import { describe, it, expect } from 'vitest';
import { availablePaths, plainLabel } from '../../../../src/desktop/ui/extract/picker.js';

const all = ['MWDL/title', 'MWDL/date', 'MWDL/creators/creator', 'MWDL/rights/description'];

describe('availablePaths', () => {
  it('excludes paths already used by a column', () => {
    expect(availablePaths(all, ['MWDL/title'], '')).toEqual([
      'MWDL/creators/creator', 'MWDL/date', 'MWDL/rights/description',
    ]);
  });

  it('filters case-insensitively on any part of the path', () => {
    expect(availablePaths(all, [], 'creat')).toEqual(['MWDL/creators/creator']);
    expect(availablePaths(all, [], 'TITLE')).toEqual(['MWDL/title']);
  });

  it('returns everything unused when the query is blank', () => {
    expect(availablePaths(all, [], '   ')).toHaveLength(4);
  });

  it('returns nothing when the query matches nothing', () => {
    expect(availablePaths(all, [], 'zzz')).toEqual([]);
  });
});

describe('plainLabel', () => {
  it('uses the last path segment, spaced and capitalised', () => {
    expect(plainLabel('MWDL/title')).toBe('Title');
    expect(plainLabel('MWDL/creators/creator')).toBe('Creator');
    expect(plainLabel('BYUI_extended/BYUI_information/go_live_date/status')).toBe('Status');
  });

  it('splits camelCase into words', () => {
    expect(plainLabel('MWDL/alternativeTitles/alternativeTitle')).toBe('Alternative title');
  });

  it('leaves a reserved column alone', () => {
    expect(plainLabel('attachment name')).toBe('Attachment name');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NO_COLOR=1 npx vitest run tests/desktop/ui/extract/picker.test.ts`
Expected: FAIL — cannot find module `picker.js`.

- [ ] **Step 3: Implement**

```ts
// src/desktop/ui/extract/picker.ts

/**
 * Schema paths the operator may still add: everything valid, minus what is
 * already a column, narrowed by a search box. Sorted, because a hundred and
 * fifty-eight paths in schema order is a list nobody can scan.
 */
export function availablePaths(all: string[], used: string[], query: string): string[] {
  const taken = new Set(used);
  const needle = query.trim().toLowerCase();
  return all
    .filter((p) => !taken.has(p))
    .filter((p) => needle === '' || p.toLowerCase().includes(needle))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * A readable name for an xpath, shown beside the path itself rather than
 * instead of it -- the path is what the spreadsheet header must literally say,
 * so hiding it would make the column list impossible to check against a
 * spreadsheet.
 */
export function plainLabel(path: string): string {
  const last = path.split('/').pop() ?? path;
  const spaced = last
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
```

- [ ] **Step 4: Run the tests**

Run: `NO_COLOR=1 npx vitest run tests/desktop/ui/extract/picker.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/desktop/ui/extract/picker.ts tests/desktop/ui/extract/picker.test.ts
git commit -m "feat(desktop): searchable picker for adding a column"
```

**Phase A ends here.** Everything the columns screen needs now exists and is tested.

---

## Task 9: Step 2 screen — the column editor

**Files:**
- Create: `src/desktop/ui/screens/extractColumns.ts`

The largest screen. It renders three things: the filename structure, the editable column list, and the live preview.

- [ ] **Step 1: Implement the screen**

```ts
// src/desktop/ui/screens/extractColumns.ts
import { escapeHtml } from '../dom.js';
import { describeFilename } from '../extract/segments.js';
import { describeSource, sourceOptions } from '../extract/sources.js';
import { plainLabel } from '../extract/picker.js';
import type { ExtractedRow, Profile, Source } from '../../../core/extract/types.js';

export interface ExtractColumnsProps {
  profile: Profile;
  profilePath: string | null;
  sampleFilename: string;
  scan: { supported: string[]; skipped: { file: string; reason: string }[]; labels: string[]; properties: string[] };
  preview: ExtractedRow[];
  busy: boolean;
  error: string | null;
  onPatternChange(pattern: string): void;
  onSourceChange(path: string, source: Source | null): void;
  onDefaultChange(path: string, value: string): void;
  onRemove(path: string): void;
  onMove(path: string, delta: number): void;
  onAdd(): void;
  onOpenProfile(): void;
  onSaveProfile(): void;
  onContinue(): void;
  onBack(): void;
}

function columnRow(props: ExtractColumnsProps, path: string, index: number): string {
  const column = props.profile.columns.find((c) => c.path === path)!;
  const locked = column.locked === true;
  const options = sourceOptions(props.profile.pattern, props.scan);
  const current = column.sources[0];
  const currentLabel = current === undefined ? '' : describeSource(current);
  const unfilled = !locked && column.sources.length === 0 && column.default === undefined;

  const optionHtml = [
    `<option value="">(nothing &mdash; fill in Excel)</option>`,
    ...options.map(
      (o, n) =>
        `<option value="${n}" ${o.label === currentLabel ? 'selected' : ''}>${escapeHtml(o.label)}</option>`,
    ),
  ].join('');

  return `
    <tr data-path="${escapeHtml(path)}" ${locked ? 'class="locked"' : ''}>
      <td class="handle">
        ${
          locked
            ? '<span aria-hidden="true">&nbsp;</span>'
            : `<button type="button" class="move-up" aria-label="Move ${escapeHtml(plainLabel(path))} up" ${index <= 1 ? 'disabled' : ''}>&uarr;</button>
               <button type="button" class="move-down" aria-label="Move ${escapeHtml(plainLabel(path))} down" ${index === props.profile.columns.length - 1 ? 'disabled' : ''}>&darr;</button>`
        }
      </td>
      <td class="name">
        <strong>${escapeHtml(plainLabel(path))}</strong>
        <code>${escapeHtml(path)}</code>
      </td>
      <td class="source">
        ${
          locked
            ? '<span class="fixed">the file itself</span>'
            : `<label class="sr-only" for="src-${index}">Source for ${escapeHtml(plainLabel(path))}</label>
               <select id="src-${index}" class="source-select">${optionHtml}</select>`
        }
      </td>
      <td class="default">
        ${
          locked
            ? ''
            : `<label class="sr-only" for="def-${index}">Value when blank, for ${escapeHtml(plainLabel(path))}</label>
               <input id="def-${index}" class="default-input" type="text" placeholder="when blank&hellip;"
                      value="${escapeHtml(column.default ?? '')}">`
        }
      </td>
      <td class="remove">
        ${
          locked
            ? '<span class="fixed" title="Required: this is how each row is matched to its file">required</span>'
            : `<button type="button" class="remove-column" aria-label="Remove ${escapeHtml(plainLabel(path))}">&times;</button>`
        }
      </td>
      <td class="flag">${unfilled ? '<span class="warn-inline">nothing fills this</span>' : ''}</td>
    </tr>`;
}

function previewTable(props: ExtractColumnsProps): string {
  const paths = props.profile.columns.map((c) => c.path);
  const head = paths.map((p) => `<th>${escapeHtml(p)}</th>`).join('');
  const body = props.preview
    .map(
      (row) =>
        `<tr>${paths
          .map((p) => {
            const value = row.cells[p] ?? '';
            return `<td>${value === '' ? '<span class="blank">(blank)</span>' : escapeHtml(value)}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  const flagged = props.preview.filter((r) => r.notes.length > 0).length;

  return `
    <h3>Preview &mdash; first ${props.preview.length} file(s)
      ${flagged > 0 ? `<span class="warn-inline">${flagged} need review</span>` : ''}
    </h3>
    <div class="preview-scroll"><table class="preview"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/**
 * Step 2 of 3. The column list IS the spreadsheet: what columns exist, in what
 * order, and where each value comes from. Every edit re-renders the preview, so
 * the consequence of a change is visible in the same glance as the change.
 */
export function renderExtractColumns(root: HTMLElement, props: ExtractColumnsProps): void {
  const described = describeFilename(props.profile.pattern, props.sampleFilename);
  const segments = described.matched
    ? described.parts
        .map((p) => `<span class="segment"><em>${escapeHtml(p.name)}</em>${escapeHtml(p.value)}</span>`)
        .join('<span class="sep">|</span>')
    : `<span class="warn-inline">This pattern does not match ${escapeHtml(props.sampleFilename)}</span>`;

  root.innerHTML = `
    <section class="screen wide" aria-labelledby="extract-columns-h">
      <h2 id="extract-columns-h">Build a spreadsheet &mdash; step 2 of 3</h2>

      <h3>Your files look like this</h3>
      <p class="sample"><code>${escapeHtml(props.sampleFilename)}</code></p>
      <p class="segments">${segments}</p>
      <details>
        <summary>Edit the pattern</summary>
        <label for="extract-pattern">Filename pattern</label>
        <input id="extract-pattern" type="text" value="${escapeHtml(props.profile.pattern)}">
        <p class="hint">Use <code>{name}</code> for each part you want to capture.</p>
      </details>

      <h3>Columns in your spreadsheet
        <button id="extract-add-column" type="button">+ Add column</button>
      </h3>
      <table class="columns"><tbody>
        ${props.profile.columns.map((c, i) => columnRow(props, c.path, i)).join('')}
      </tbody></table>

      ${previewTable(props)}
      ${props.error === null ? '' : `<p class="error" role="alert">${escapeHtml(props.error)}</p>`}

      <div class="actions">
        <button id="extract-back" type="button">Back</button>
        <button id="extract-open-profile" type="button">Load profile&hellip;</button>
        <button id="extract-save-profile" type="button">Save profile&hellip;</button>
        <button id="extract-continue" type="button" ${props.busy ? 'disabled' : ''}>Continue</button>
      </div>
    </section>`;

  const pathOf = (el: Element): string => el.closest('tr')?.getAttribute('data-path') ?? '';

  root.querySelectorAll<HTMLButtonElement>('.remove-column').forEach((b) =>
    b.addEventListener('click', () => props.onRemove(pathOf(b))),
  );
  root.querySelectorAll<HTMLButtonElement>('.move-up').forEach((b) =>
    b.addEventListener('click', () => props.onMove(pathOf(b), -1)),
  );
  root.querySelectorAll<HTMLButtonElement>('.move-down').forEach((b) =>
    b.addEventListener('click', () => props.onMove(pathOf(b), 1)),
  );
  root.querySelectorAll<HTMLSelectElement>('.source-select').forEach((s) =>
    s.addEventListener('change', () => {
      const options = sourceOptions(props.profile.pattern, props.scan);
      const chosen = s.value === '' ? null : (options[Number(s.value)]?.source ?? null);
      props.onSourceChange(pathOf(s), chosen);
    }),
  );
  root.querySelectorAll<HTMLInputElement>('.default-input').forEach((i) =>
    i.addEventListener('change', () => props.onDefaultChange(pathOf(i), i.value)),
  );

  root.querySelector<HTMLInputElement>('#extract-pattern')?.addEventListener('change', (e) =>
    props.onPatternChange((e.target as HTMLInputElement).value),
  );
  root.querySelector<HTMLButtonElement>('#extract-add-column')?.addEventListener('click', props.onAdd);
  root.querySelector<HTMLButtonElement>('#extract-open-profile')?.addEventListener('click', props.onOpenProfile);
  root.querySelector<HTMLButtonElement>('#extract-save-profile')?.addEventListener('click', props.onSaveProfile);
  root.querySelector<HTMLButtonElement>('#extract-continue')?.addEventListener('click', props.onContinue);
  root.querySelector<HTMLButtonElement>('#extract-back')?.addEventListener('click', props.onBack);
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck
git add src/desktop/ui/screens/extractColumns.ts
git commit -m "feat(desktop): extract step 2, the column editor"
```

---

## Task 10: Controller

**Files:**
- Create: `src/desktop/ui/extract/controller.ts`
- Test: `tests/desktop/ui/extract/controller.test.ts`

**Why a controller and not `app.ts`:** `app.ts` is 802 lines and no test imports it. The extract flow owns its own state, its own render loop, and its own root element. `app.ts` will gain one call.

- [ ] **Step 1: Write the failing test**

```ts
// tests/desktop/ui/extract/controller.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createExtractController } from '../../../../src/desktop/ui/extract/controller.js';
import { ATTACHMENT_COLUMN, type Profile } from '../../../../src/core/extract/types.js';

const profile: Profile = {
  version: 1,
  pattern: '{part1}.pdf',
  columns: [{ path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true }],
};

function api(over: Record<string, unknown> = {}) {
  return {
    chooseFolder: vi.fn(async () => 'C:/files'),
    extractScan: vi.fn(async () => ({ supported: ['a.pdf'], skipped: [], labels: [], properties: [] })),
    extractPreview: vi.fn(async () => []),
    extractRun: vi.fn(async () => ({ outPath: 'C:/files/out.csv', written: 1, flagged: 0 })),
    schemaPaths: vi.fn(async () => ['MWDL/title']),
    openProfile: vi.fn(async () => null),
    saveProfileAs: vi.fn(async () => null),
    chooseCsvPath: vi.fn(async () => 'C:/files/out.csv'),
    ...over,
  };
}

describe('createExtractController', () => {
  it('starts on the folder step', () => {
    const c = createExtractController({ api: api() as never, onExit: vi.fn(), render: vi.fn() });
    expect(c.state().step).toBe('folder');
  });

  it('scans the folder after one is chosen, and proposes a starter profile', async () => {
    const a = api();
    const c = createExtractController({ api: a as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    expect(a.extractScan).toHaveBeenCalledWith('C:/files');
    expect(c.state().dir).toBe('C:/files');
    expect(c.state().profile?.columns[0]?.path).toBe(ATTACHMENT_COLUMN);
  });

  it('does not advance when the folder holds nothing readable', async () => {
    const a = api({ extractScan: vi.fn(async () => ({ supported: [], skipped: [{ file: 'x.txt', reason: 'r' }], labels: [], properties: [] })) });
    const c = createExtractController({ api: a as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    expect(c.state().step).toBe('folder');
  });

  it('refreshes the preview when a column changes', async () => {
    const a = api();
    const c = createExtractController({ api: a as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    a.extractPreview.mockClear();
    await c.addColumn('MWDL/title');
    expect(a.extractPreview).toHaveBeenCalled();
    expect(c.state().profile?.columns.map((x) => x.path)).toEqual([ATTACHMENT_COLUMN, 'MWDL/title']);
  });

  it('refuses to remove the locked attachment column and surfaces why', async () => {
    const c = createExtractController({ api: api() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    await c.removeColumn(ATTACHMENT_COLUMN);
    expect(c.state().profile?.columns).toHaveLength(1);
    expect(c.state().error).toMatch(/required/i);
  });

  it('writes the spreadsheet and records where it went', async () => {
    const a = api();
    const c = createExtractController({ api: a as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    await c.continue();
    await c.save();
    expect(a.extractRun).toHaveBeenCalled();
    expect(c.state().savedPath).toBe('C:/files/out.csv');
  });

  it('does nothing when the save dialog is cancelled', async () => {
    const a = api({ chooseCsvPath: vi.fn(async () => null) });
    const c = createExtractController({ api: a as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    await c.continue();
    await c.save();
    expect(a.extractRun).not.toHaveBeenCalled();
    expect(c.state().savedPath).toBeNull();
  });

  it('surfaces an IPC failure instead of throwing', async () => {
    const a = api({ extractScan: vi.fn(async () => { throw new Error("Error invoking remote method 'oeq:extractScan': ValidationError: boom"); }) });
    const c = createExtractController({ api: a as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    expect(c.state().error).toBe('boom');
  });

  it('re-renders after every transition', async () => {
    const render = vi.fn();
    const c = createExtractController({ api: api() as never, onExit: vi.fn(), render });
    await c.chooseFolder();
    expect(render).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NO_COLOR=1 npx vitest run tests/desktop/ui/extract/controller.test.ts`
Expected: FAIL — cannot find module `controller.js`.

- [ ] **Step 3: Implement**

```ts
// src/desktop/ui/extract/controller.ts
import type { OeqApi } from '../../ipc.js';
import { addColumn, removeColumn, moveColumn, setSources, setDefault } from '../../../core/extract/columns.js';
import { starterProfile } from '../../../core/extract/suggest.js';
import type { Profile, Source } from '../../../core/extract/types.js';
import { stripElectronWrapper } from '../errors.js';
import { initialExtractState, canContinue, type ExtractState } from './state.js';

export interface ExtractControllerOptions {
  api: OeqApi;
  /** Called when the operator leaves the flow. */
  onExit(): void;
  /** Called after every state change; the caller decides which screen to draw. */
  render(state: ExtractState): void;
}

export interface ExtractController {
  state(): ExtractState;
  chooseFolder(): Promise<void>;
  continue(): Promise<void>;
  back(): void;
  setPattern(pattern: string): Promise<void>;
  addColumn(path: string): Promise<void>;
  removeColumn(path: string): Promise<void>;
  moveColumn(path: string, delta: number): Promise<void>;
  setSource(path: string, source: Source | null): Promise<void>;
  setDefault(path: string, value: string): Promise<void>;
  openProfile(): Promise<void>;
  saveProfile(): Promise<void>;
  save(): Promise<void>;
  exit(): void;
}

export function createExtractController(options: ExtractControllerOptions): ExtractController {
  let state = initialExtractState();

  const set = (patch: Partial<ExtractState>): void => {
    state = { ...state, ...patch };
    options.render(state);
  };

  /**
   * Every IPC call goes through here. Electron wraps errors crossing IPC as
   * "Error invoking remote method '<channel>': <Class>: <real message>";
   * stripElectronWrapper removes that so the operator sees the real message.
   */
  const guard = async (work: () => Promise<Partial<ExtractState>>): Promise<void> => {
    set({ busy: true, error: null });
    try {
      set({ ...(await work()), busy: false });
    } catch (error) {
      set({ busy: false, error: stripElectronWrapper((error as Error).message) });
    }
  };

  const refreshPreview = async (profile: Profile): Promise<Partial<ExtractState>> => {
    if (state.dir === null) return { profile };
    return { profile, preview: await options.api.extractPreview({ dir: state.dir, profile }) };
  };

  /** Apply a pure column operation, then refresh the preview from the result. */
  const edit = (fn: (p: Profile) => Profile) => async (): Promise<void> => {
    if (state.profile === null) return;
    await guard(async () => refreshPreview(fn(state.profile!)));
  };

  return {
    state: () => state,

    async chooseFolder() {
      const dir = await options.api.chooseFolder();
      if (dir === null) return;
      await guard(async () => {
        const scan = await options.api.extractScan(dir);
        const schemaPaths = await options.api.schemaPaths();
        // A starter profile holds only the attachment column: the program can
        // see a filename has four parts but cannot know part 2 is a first name.
        const profile = state.profile ?? starterProfile(scan.supported);
        return { dir, scan, schemaPaths, profile };
      });
    },

    async continue() {
      if (!canContinue(state)) return;
      if (state.step === 'folder' && state.profile !== null) {
        await guard(async () => ({ step: 'columns' as const, ...(await refreshPreview(state.profile!)) }));
        return;
      }
      if (state.step === 'columns') set({ step: 'save' });
    },

    back() {
      if (state.step === 'save') set({ step: 'columns', error: null });
      else if (state.step === 'columns') set({ step: 'folder', error: null });
      else options.onExit();
    },

    async setPattern(pattern) {
      await edit((p) => ({ ...p, pattern }))();
    },

    async addColumn(path) {
      await edit((p) => addColumn(p, path))();
    },
    async removeColumn(path) {
      await edit((p) => removeColumn(p, path))();
    },
    async moveColumn(path, delta) {
      await edit((p) => moveColumn(p, path, delta))();
    },
    async setSource(path, source) {
      await edit((p) => setSources(p, path, source === null ? [] : [source]))();
    },
    async setDefault(path, value) {
      await edit((p) => setDefault(p, path, value))();
    },

    async openProfile() {
      const opened = await options.api.openProfile();
      if (opened === null) return;
      await guard(async () => ({
        profilePath: opened.path,
        ...(await refreshPreview(opened.profile)),
      }));
    },

    async saveProfile() {
      if (state.profile === null) return;
      await guard(async () => {
        const path = await options.api.saveProfileAs(state.profile!);
        return path === null ? {} : { profilePath: path };
      });
    },

    async save() {
      if (state.dir === null || state.profile === null) return;
      const outPath = await options.api.chooseCsvPath();
      if (outPath === null) return;
      await guard(async () => {
        const report = await options.api.extractRun({ dir: state.dir!, profile: state.profile!, outPath });
        return { savedPath: report.outPath, savedFlagged: report.flagged };
      });
    },

    exit: options.onExit,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `NO_COLOR=1 npx vitest run tests/desktop/ui/extract/controller.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/desktop/ui/extract/controller.ts tests/desktop/ui/extract/controller.test.ts
git commit -m "feat(desktop): extract flow controller"
```

---

## Task 11: Wire the controller to the screens

**Files:**
- Create: `src/desktop/ui/extract/mount.ts`
- Test: `tests/desktop/ui/extract/mount.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/desktop/ui/extract/mount.test.ts
import { describe, it, expect } from 'vitest';
import { screenFor } from '../../../../src/desktop/ui/extract/mount.js';
import { initialExtractState } from '../../../../src/desktop/ui/extract/state.js';

describe('screenFor', () => {
  it('maps each step to its screen', () => {
    expect(screenFor({ ...initialExtractState(), step: 'folder' })).toBe('folder');
    expect(screenFor({ ...initialExtractState(), step: 'columns' })).toBe('columns');
    expect(screenFor({ ...initialExtractState(), step: 'save' })).toBe('save');
  });

  it('falls back to the folder step when a profile is somehow missing on the columns step', () => {
    expect(screenFor({ ...initialExtractState(), step: 'columns', profile: null })).toBe('folder');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NO_COLOR=1 npx vitest run tests/desktop/ui/extract/mount.test.ts`
Expected: FAIL — cannot find module `mount.js`.

- [ ] **Step 3: Implement**

```ts
// src/desktop/ui/extract/mount.ts
import { renderExtractFolder } from '../screens/extractFolder.js';
import { renderExtractColumns } from '../screens/extractColumns.js';
import { renderExtractSave } from '../screens/extractSave.js';
import { canContinue, type ExtractState } from './state.js';
import type { ExtractController } from './controller.js';

/**
 * Which screen a state draws. Guards the invariant the screens rely on: the
 * columns and save screens require a profile, and rendering them without one
 * would throw inside the renderer, where there is no stack to read.
 */
export function screenFor(state: ExtractState): 'folder' | 'columns' | 'save' {
  if (state.step !== 'folder' && state.profile === null) return 'folder';
  return state.step;
}

export function renderExtract(
  root: HTMLElement,
  state: ExtractState,
  controller: ExtractController,
  onOpenFolder: (path: string) => void,
): void {
  switch (screenFor(state)) {
    case 'folder':
      renderExtractFolder(root, {
        dir: state.dir,
        scan: state.scan,
        busy: state.busy,
        error: state.error,
        canContinue: canContinue(state),
        onChooseFolder: () => void controller.chooseFolder(),
        onContinue: () => void controller.continue(),
        onCancel: () => controller.exit(),
      });
      return;

    case 'columns':
      renderExtractColumns(root, {
        profile: state.profile!,
        profilePath: state.profilePath,
        sampleFilename: state.scan?.supported[0] ?? '',
        scan: state.scan ?? { supported: [], skipped: [], labels: [], properties: [] },
        preview: state.preview,
        busy: state.busy,
        error: state.error,
        onPatternChange: (p) => void controller.setPattern(p),
        onSourceChange: (path, source) => void controller.setSource(path, source),
        onDefaultChange: (path, v) => void controller.setDefault(path, v),
        onRemove: (path) => void controller.removeColumn(path),
        onMove: (path, d) => void controller.moveColumn(path, d),
        onAdd: () => {
          const path = window.prompt('Schema path to add (e.g. MWDL/description)');
          if (path !== null && path.trim() !== '') void controller.addColumn(path.trim());
        },
        onOpenProfile: () => void controller.openProfile(),
        onSaveProfile: () => void controller.saveProfile(),
        onContinue: () => void controller.continue(),
        onBack: () => controller.back(),
      });
      return;

    case 'save':
      renderExtractSave(root, {
        fileCount: state.scan?.supported.length ?? 0,
        flagged: state.savedFlagged,
        savedPath: state.savedPath,
        busy: state.busy,
        error: state.error,
        onSave: () => void controller.save(),
        onBack: () => controller.back(),
        onOpenFolder: () => {
          if (state.savedPath !== null) onOpenFolder(state.savedPath);
        },
        onDone: () => controller.exit(),
      });
  }
}
```

**Note on `window.prompt` for Add column:** this is a deliberate placeholder for the first working version — it is replaced by the searchable picker in Task 12. Leave it exactly as written; Task 12 removes it.

- [ ] **Step 4: Run the tests**

Run: `NO_COLOR=1 npx vitest run tests/desktop/ui/extract/mount.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/desktop/ui/extract/mount.ts tests/desktop/ui/extract/mount.test.ts
git commit -m "feat(desktop): map extract state to its screens"
```

---

## Task 12: The Add-column picker screen

**Files:**
- Create: `src/desktop/ui/screens/extractAddColumn.ts`
- Modify: `src/desktop/ui/extract/state.ts` — add `adding: boolean` and `addQuery: string`
- Modify: `src/desktop/ui/extract/controller.ts` — add `openAdd()`, `setAddQuery()`, `closeAdd()`
- Modify: `src/desktop/ui/extract/mount.ts` — render the picker when `adding` is true, replacing `window.prompt`
- Test: `tests/desktop/ui/extract/picker.test.ts` (already covers `availablePaths`; add controller tests below)

- [ ] **Step 1: Add the state fields**

In `src/desktop/ui/extract/state.ts`, add to `ExtractState`:

```ts
  /** True while the Add-column picker is open. */
  adding: boolean;
  /** The picker's search box. */
  addQuery: string;
```

and to `initialExtractState()`'s returned object:

```ts
    adding: false,
    addQuery: '',
```

- [ ] **Step 2: Write the failing controller tests**

Append to `tests/desktop/ui/extract/controller.test.ts`:

```ts
describe('add-column picker', () => {
  it('opens and closes', async () => {
    const c = createExtractController({ api: api() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    c.openAdd();
    expect(c.state().adding).toBe(true);
    c.closeAdd();
    expect(c.state().adding).toBe(false);
  });

  it('clears the query when it closes, so it does not reopen pre-filtered', async () => {
    const c = createExtractController({ api: api() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    c.openAdd();
    c.setAddQuery('title');
    c.closeAdd();
    expect(c.state().addQuery).toBe('');
  });

  it('closes after adding a column', async () => {
    const c = createExtractController({ api: api() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    c.openAdd();
    await c.addColumn('MWDL/title');
    expect(c.state().adding).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `NO_COLOR=1 npx vitest run tests/desktop/ui/extract/controller.test.ts`
Expected: FAIL — `c.openAdd is not a function`.

- [ ] **Step 4: Implement the controller methods**

Add to the `ExtractController` interface:

```ts
  openAdd(): void;
  setAddQuery(query: string): void;
  closeAdd(): void;
```

Add to the returned object in `createExtractController`:

```ts
    openAdd: () => set({ adding: true, addQuery: '' }),
    setAddQuery: (addQuery) => set({ addQuery }),
    closeAdd: () => set({ adding: false, addQuery: '' }),
```

and change `addColumn` so it closes the picker:

```ts
    async addColumn(path) {
      await edit((p) => addColumn(p, path))();
      set({ adding: false, addQuery: '' });
    },
```

- [ ] **Step 5: Implement the picker screen**

```ts
// src/desktop/ui/screens/extractAddColumn.ts
import { escapeHtml } from '../dom.js';
import { availablePaths, plainLabel } from '../extract/picker.js';

export interface ExtractAddColumnProps {
  schemaPaths: string[];
  usedPaths: string[];
  query: string;
  onQueryChange(q: string): void;
  onPick(path: string): void;
  onCancel(): void;
}

/**
 * The Add-column picker. Offers only real schema paths, so an invalid column
 * cannot be expressed -- error prevention rather than an error message. The
 * plain-language name is shown beside the xpath, never instead of it: the
 * xpath is what the spreadsheet header must literally say.
 */
export function renderExtractAddColumn(root: HTMLElement, props: ExtractAddColumnProps): void {
  const matches = availablePaths(props.schemaPaths, props.usedPaths, props.query);

  root.innerHTML = `
    <section class="screen modal" role="dialog" aria-modal="true" aria-labelledby="add-col-h">
      <h2 id="add-col-h">Add a column</h2>
      <label for="add-col-q">Search the schema</label>
      <input id="add-col-q" type="text" value="${escapeHtml(props.query)}" autocomplete="off">
      ${
        matches.length === 0
          ? `<p class="muted">Nothing matches &ldquo;${escapeHtml(props.query)}&rdquo;.</p>`
          : `<ul class="path-list">${matches
              .slice(0, 50)
              .map(
                (p) =>
                  `<li><button type="button" class="pick" data-path="${escapeHtml(p)}">
                     <strong>${escapeHtml(plainLabel(p))}</strong> <code>${escapeHtml(p)}</code>
                   </button></li>`,
              )
              .join('')}</ul>
             ${matches.length > 50 ? `<p class="muted">${matches.length - 50} more &mdash; keep typing to narrow.</p>` : ''}`
      }
      <div class="actions"><button id="add-col-cancel" type="button">Cancel</button></div>
    </section>`;

  const input = root.querySelector<HTMLInputElement>('#add-col-q');
  input?.addEventListener('input', () => props.onQueryChange(input.value));
  input?.focus();

  root.querySelectorAll<HTMLButtonElement>('.pick').forEach((b) =>
    b.addEventListener('click', () => props.onPick(b.getAttribute('data-path') ?? '')),
  );
  root.querySelector<HTMLButtonElement>('#add-col-cancel')?.addEventListener('click', props.onCancel);
}
```

- [ ] **Step 6: Replace `window.prompt` in `mount.ts`**

Add the import:

```ts
import { renderExtractAddColumn } from '../screens/extractAddColumn.js';
```

At the top of `renderExtract`, before the `switch`, add:

```ts
  if (state.adding && state.profile !== null) {
    renderExtractAddColumn(root, {
      schemaPaths: state.schemaPaths,
      usedPaths: state.profile.columns.map((c) => c.path),
      query: state.addQuery,
      onQueryChange: (q) => controller.setAddQuery(q),
      onPick: (path) => void controller.addColumn(path),
      onCancel: () => controller.closeAdd(),
    });
    return;
  }
```

and change the columns screen's `onAdd` from the `window.prompt` block to:

```ts
        onAdd: () => controller.openAdd(),
```

- [ ] **Step 7: Run the tests**

Run: `NO_COLOR=1 npx vitest run tests/desktop/ui/extract/`
Expected: PASS — all extract UI tests, including the three new picker tests.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add src/desktop/ui/screens/extractAddColumn.ts src/desktop/ui/extract/state.ts src/desktop/ui/extract/controller.ts src/desktop/ui/extract/mount.ts tests/desktop/ui/extract/controller.test.ts
git commit -m "feat(desktop): searchable Add-column picker"
```

---

## Task 13: Undo a removed column

**Files:**
- Modify: `src/desktop/ui/extract/state.ts` — add `removed`
- Modify: `src/desktop/ui/extract/controller.ts` — record the removal, add `undoRemove()`
- Modify: `src/desktop/ui/screens/extractColumns.ts` — render the undo message
- Test: `tests/desktop/ui/extract/controller.test.ts`

**Why this exists:** the spec calls for an inline **Undo** rather than a
confirmation dialog. A modal in front of a reversible action is friction
pretending to be safety — it trains people to click through, and it is the
irreversible actions that then get clicked through too. Removing a column
destroys nothing, so it should be cheap to do and cheap to take back.

Restoring must put the column back **at its original index**, not on the end.
A column list is ordered and the order is the spreadsheet's column order, so an
undo that reorders is not an undo.

- [ ] **Step 1: Add the state field**

In `src/desktop/ui/extract/state.ts`, add to `ExtractState`:

```ts
  /** The most recently removed column, kept so it can be put back where it was. */
  removed: { column: Column; index: number } | null;
```

Add the import:

```ts
import type { Column, ExtractedRow, Profile } from '../../../core/extract/types.js';
```

and add to `initialExtractState()`'s returned object:

```ts
    removed: null,
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/desktop/ui/extract/controller.test.ts`:

```ts
describe('undo a removed column', () => {
  const withColumns = () => api({
    schemaPaths: vi.fn(async () => ['MWDL/title', 'MWDL/date']),
  });

  it('remembers what was removed, and from where', async () => {
    const c = createExtractController({ api: withColumns() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    await c.addColumn('MWDL/title');
    await c.addColumn('MWDL/date');
    await c.removeColumn('MWDL/title');
    expect(c.state().removed?.column.path).toBe('MWDL/title');
    expect(c.state().removed?.index).toBe(1);
  });

  it('puts the column back at its original index, not on the end', async () => {
    const c = createExtractController({ api: withColumns() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    await c.addColumn('MWDL/title');
    await c.addColumn('MWDL/date');
    await c.removeColumn('MWDL/title');
    await c.undoRemove();
    expect(c.state().profile?.columns.map((x) => x.path)).toEqual([
      ATTACHMENT_COLUMN, 'MWDL/title', 'MWDL/date',
    ]);
  });

  it('clears the undo once it has been used, so it cannot fire twice', async () => {
    const c = createExtractController({ api: withColumns() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    await c.addColumn('MWDL/title');
    await c.removeColumn('MWDL/title');
    await c.undoRemove();
    expect(c.state().removed).toBeNull();
    await c.undoRemove();
    expect(c.state().profile?.columns.filter((x) => x.path === 'MWDL/title')).toHaveLength(1);
  });

  it('does not record an undo for a removal that was refused', async () => {
    const c = createExtractController({ api: withColumns() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    await c.removeColumn(ATTACHMENT_COLUMN);
    expect(c.state().removed).toBeNull();
  });

  it('forgets the undo when a different edit is made', async () => {
    const c = createExtractController({ api: withColumns() as never, onExit: vi.fn(), render: vi.fn() });
    await c.chooseFolder();
    await c.continue();
    await c.addColumn('MWDL/title');
    await c.removeColumn('MWDL/title');
    await c.addColumn('MWDL/date');
    expect(c.state().removed).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `NO_COLOR=1 npx vitest run tests/desktop/ui/extract/controller.test.ts`
Expected: FAIL — `c.undoRemove is not a function`.

- [ ] **Step 4: Implement**

In `src/desktop/ui/extract/controller.ts`, add to the `ExtractController` interface:

```ts
  undoRemove(): Promise<void>;
```

Change the `edit` helper so every ordinary edit forgets a pending undo — an
undo offered after three other changes is a trap, not a convenience:

```ts
  const edit = (fn: (p: Profile) => Profile) => async (): Promise<void> => {
    if (state.profile === null) return;
    await guard(async () => ({ ...(await refreshPreview(fn(state.profile!))), removed: null }));
  };
```

Replace `removeColumn` so it records what it took out, and only on success:

```ts
    async removeColumn(path) {
      if (state.profile === null) return;
      const index = state.profile.columns.findIndex((c) => c.path === path);
      const column = state.profile.columns[index];
      await guard(async () => {
        // removeColumn throws for the locked attachment column. Computing the
        // next state BEFORE recording the undo means a refused removal leaves
        // no undo behind, which would otherwise offer to restore a column
        // that was never taken away.
        const next = removeColumn(state.profile!, path);
        return {
          ...(await refreshPreview(next)),
          removed: column === undefined ? null : { column, index },
        };
      });
    },
```

Add `undoRemove`:

```ts
    async undoRemove() {
      const pending = state.removed;
      if (pending === null || state.profile === null) return;
      await guard(async () => {
        const columns = [...state.profile!.columns];
        // Spliced back at its original index: the order IS the spreadsheet's
        // column order, so an undo that appends is not an undo.
        columns.splice(Math.min(pending.index, columns.length), 0, pending.column);
        return { ...(await refreshPreview({ ...state.profile!, columns })), removed: null };
      });
    },
```

- [ ] **Step 5: Render the undo message**

In `src/desktop/ui/screens/extractColumns.ts`, add to `ExtractColumnsProps`:

```ts
  removed: { path: string } | null;
  onUndoRemove(): void;
```

Add this immediately after the `</table>` that closes the columns table:

```ts
      ${
        props.removed === null
          ? ''
          : `<p class="undo" role="status">
               Removed <strong>${escapeHtml(props.removed.path)}</strong>.
               <button id="extract-undo" type="button">Undo</button>
             </p>`
      }
```

and register the listener beside the others:

```ts
  root.querySelector<HTMLButtonElement>('#extract-undo')?.addEventListener('click', props.onUndoRemove);
```

`role="status"` rather than `role="alert"`: this is an offer, not a problem, and
should not interrupt a screen reader mid-sentence.

In `src/desktop/ui/extract/mount.ts`, add to the columns screen's props:

```ts
        removed: state.removed === null ? null : { path: state.removed.column.path },
        onUndoRemove: () => void controller.undoRemove(),
```

- [ ] **Step 6: Run the tests**

Run: `NO_COLOR=1 npx vitest run tests/desktop/ui/extract/`
Expected: PASS, including the five new undo tests.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/desktop/ui/extract/state.ts src/desktop/ui/extract/controller.ts src/desktop/ui/extract/mount.ts src/desktop/ui/screens/extractColumns.ts tests/desktop/ui/extract/controller.test.ts
git commit -m "feat(desktop): undo a removed column, restoring its position"
```

---

## Task 14: Entry point from the Choose screen

**Files:**
- Modify: `src/desktop/ui/screens/choose.ts` — add one button
- Modify: `src/desktop/ui/app.ts` — the ONLY change to this file

- [ ] **Step 1: Add the button to `choose.ts`**

Find the block containing the existing "Save a template and sample file…" button and add immediately after it:

```html
        <button id="choose-extract" type="button">I don't have a spreadsheet yet&hellip;</button>
```

Add to `ChooseProps`:

```ts
  onExtract(): void;
```

and register the listener beside the other `querySelector` calls:

```ts
  root.querySelector<HTMLButtonElement>('#choose-extract')?.addEventListener('click', props.onExtract);
```

- [ ] **Step 2: Wire it in `app.ts`**

Add these imports at the top:

```ts
import { createExtractController } from './extract/controller.js';
import { renderExtract } from './extract/mount.js';
```

Add `onExtract` to the props object passed to `renderChoose`:

```ts
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
```

If `app.ts`'s element helper is not called `requireEl`, or the main render function is not called `render`, use the names that file actually uses — search it for `renderChoose(` to find the surrounding idiom.

- [ ] **Step 3: Add the `openPath` channel**

This is the "Open containing folder" button. In `src/desktop/ipc.ts` add to `OeqApi`:

```ts
  /** Reveal a file in the OS file manager. */
  openPath(path: string): Promise<void>;
```

add to `CHANNELS`:

```ts
  openPath: 'oeq:openPath',
```

mirror both in `src/desktop/preload.cts`:

```ts
  openPath: (path) => invoke(CHANNELS.openPath, path),
```

and add the handler in `src/desktop/extractHandlers.ts`, importing `shell` from electron:

```ts
  ipcMain.handle(CHANNELS.openPath, async (_e, path: string): Promise<void> => {
    // showItemInFolder rather than openPath: the operator wants the folder
    // with the file selected, not Excel launching behind the app window.
    shell.showItemInFolder(path);
  });
```

- [ ] **Step 4: Verify the drift guard and build**

```bash
NO_COLOR=1 npx vitest run tests/desktop/preload-channels.test.ts
npm run typecheck
npm run build:desktop
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/desktop/ui/screens/choose.ts src/desktop/ui/app.ts src/desktop/ipc.ts src/desktop/preload.cts src/desktop/extractHandlers.ts
git commit -m "feat(desktop): reach the extract flow from the Choose screen"
```

---

## Task 15: Styles

**Files:**
- Modify: `src/desktop/ui/styles.css`

**Corrected during implementation.** The version originally written here used
hardcoded hex colours. This app has a full light/dark theme built on CSS custom
properties (`--text`, `--panel-bg`, `--border`, `--muted`, `--pending-bg`,
`--pending-text`, …) declared in `:root` with a `prefers-color-scheme: dark`
override, so hardcoded colours would have produced a screen that looked broken
in dark mode — light grey panels on a dark background. Every colour below comes
from those variables instead. The `warn-inline` pair maps onto the existing
`--pending-*` tokens, which already mean "needs a human" elsewhere in this UI.

- [ ] **Step 1: Append the extract styles**

```css
/* ---- Extract flow ---------------------------------------------------- */

.screen.wide { max-width: 62rem; }

.segments { font-family: monospace; }
.segments .segment { display: inline-block; padding: 0.15rem 0.4rem; background: #eef; border-radius: 3px; }
.segments .segment em { display: block; font-size: 0.75em; color: #446; font-style: normal; }
.segments .sep { padding: 0 0.3rem; color: #889; }

table.columns { width: 100%; border-collapse: collapse; }
table.columns td { padding: 0.35rem 0.4rem; border-bottom: 1px solid #e3e3e8; vertical-align: middle; }
table.columns tr.locked { background: #f6f6f8; color: #555; }
table.columns .name code { display: block; font-size: 0.78em; color: #667; }
table.columns .handle button { padding: 0 0.35rem; line-height: 1.4; }
table.columns .remove button { color: #a11; font-size: 1.1em; }

.preview-scroll { overflow-x: auto; }
table.preview { border-collapse: collapse; font-size: 0.85em; }
table.preview th, table.preview td { padding: 0.25rem 0.5rem; border: 1px solid #ddd; white-space: nowrap; }
table.preview th { background: #f2f2f5; text-align: left; }
table.preview .blank { color: #999; font-style: italic; }

/* Warnings carry text as well as colour -- never colour alone. */
.warn-inline { color: #8a5a00; background: #fff6e0; padding: 0.05rem 0.35rem; border-radius: 3px; font-size: 0.85em; }
details.warn summary { color: #8a5a00; cursor: pointer; }

.path-list { list-style: none; padding: 0; max-height: 22rem; overflow-y: auto; }
.path-list button.pick { display: block; width: 100%; text-align: left; padding: 0.35rem 0.5rem; background: none; border: 0; }
.path-list button.pick:hover, .path-list button.pick:focus { background: #eef; }
.path-list code { color: #667; font-size: 0.8em; }

.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/desktop/ui/styles.css
git commit -m "style(desktop): extract flow"
```

---

## Task 16: Documentation

**Files:**
- Modify: `docs/INSTALL.md` — a section for the operator
- Modify: `docs/SESSION-HANDOFF.md`

- [ ] **Step 1: Add to `docs/INSTALL.md`**

Add after the "Try it first: the built-in starter kit" section:

````markdown
## Building a spreadsheet from your files

If you have a folder of PDFs or Word documents and no spreadsheet, the program
can build one for you. On the **Choose what to upload** screen, click
**I don't have a spreadsheet yet…**.

It works in three steps:

1. **Choose the folder.** The program says how many files it can read, and
   lists any it cannot — nothing is skipped silently.
2. **Set up the columns.** It shows one of your filenames broken into parts, and
   a list of the columns your spreadsheet will have. Add, remove and reorder
   them, and say where each one's value comes from. A preview of the first few
   files updates as you go.
3. **Save.** The spreadsheet is written where you choose.

**Then open it in Excel and check it before uploading.** This step guesses, and
everything else the program does doesn't. Two extra columns help you check:

- `_notes` — rows that need a look, and why
- `_source` — where each value came from

The uploader ignores both, so you can leave them in place.

If you will do this again with the same kind of files, click **Save profile…**
so you don't have to set the columns up next time.
````

- [ ] **Step 2: Update `docs/SESSION-HANDOFF.md`**

Replace the extractor's status paragraph with:

```markdown
**Metadata extractor stages 1 and 2 are complete.** `oeq-upload extract` builds
a spreadsheet from a folder of PDFs and `.docx` files, and the desktop app has
the same flow across three screens with a fully editable column list. Stage 3
(MCP tools) is specified but unplanned.

**Not yet driven end to end by a human in the packaged app.** The screens are
covered by unit tests over their logic modules; the native file dialogs are not
CDP-scriptable and have never been exercised in automation. A manual pass on a
real folder is still outstanding.
```

- [ ] **Step 3: Verify and commit**

```bash
NO_COLOR=1 npm test
npm run typecheck
git add docs/INSTALL.md docs/SESSION-HANDOFF.md
git commit -m "docs: the extract flow in the desktop app"
```

---

## Definition of done

- [ ] `npm test` passes with roughly 40 new tests
- [ ] `npm run typecheck` is clean
- [ ] `npm run build:desktop` succeeds
- [ ] `tests/desktop/preload-channels.test.ts` passes — the two `CHANNELS` copies agree
- [ ] `src/desktop/ui/app.ts` has grown by **fewer than 20 lines**, all of them the `onExtract` handler and two imports
- [ ] Nothing under `src/core/` has changed

That last one matters. Stage 1's core is exercised against four kinds of real
file and is not in scope here. If a change to `src/core/extract/` seems
necessary, stop and raise it rather than making it.

## Manual verification, which no test covers

Native file dialogs cannot be driven by the Chrome DevTools Protocol, so these
must be done by hand once, on a real folder:

1. Choose folder → the counts match what is in the folder
2. A folder containing a `.doc` → it is listed as skipped, with the "save as .docx" reason
3. Add a column, reorder it, remove it → the preview follows each change
4. Save profile, restart the app, load the profile → the columns come back
5. Save the spreadsheet → **Open containing folder** reveals it with the file selected
6. Open the spreadsheet in Excel → `_source` and `_notes` are present and readable
7. Feed that spreadsheet to the normal upload flow → it validates without edits

Step 7 is the one that matters most: it proves the two halves of the program
actually fit together.
