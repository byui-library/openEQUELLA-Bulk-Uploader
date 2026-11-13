# Several Files on One Contribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one spreadsheet row name a subfolder, and contribute every file in it as the ordered attachments of one openEQUELLA item. Let the extractor build one row per subfolder.

**Architecture:** A new `src/core/folderFiles.ts` owns the two shared answers: what a folder holds and in what order. The manifest moves to v2, where every row carries a `files` list. A single-file row is a one-element list, so there is one code path, and a v1 manifest still loads. Upload, runner and duplicate check each widen from one file to N. The extractor gains `buildFolderRow` and `extractFolders` beside the existing per-file functions.

**Tech Stack:** TypeScript on Node, vitest, Electron (sandboxed renderer), commander CLI, MCP SDK.

**Spec:** [docs/superpowers/specs/2026-11-13-multi-file-items-design.md](../specs/2026-11-13-multi-file-items-design.md)

---

## Ground rules for every task

- **TDD.** Write the test, watch it fail for the stated reason, implement, then watch it pass.
- **Source files are CRLF.** Make edits and mutation checks with the Edit tool. Before trusting a green run after a mutation, confirm the file actually changed.
- **Shells:** run `unset ELECTRON_RUN_AS_NODE` (bash) or `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue` (PowerShell) first. Commands:
  - `npx vitest run <file>` runs one file.
  - `npm test` runs the whole suite.
  - `npm run typecheck` runs the typecheck.
  - `npm run build:desktop` builds the desktop app.
- **The repository is public.** Every name, date and town in a fixture is invented. Fixtures use invented journal names, not *Snake River Echoes* filenames. The template and README may use the SRE folder and file *naming pattern*, which is not personal data.
- **No `style` attributes** in rendered markup. Any `input` that re-renders on its `input` event calls `keepCaret`. Nothing under `src/desktop/ui/` imports `node:*`.
- **Every commit message** ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Correction to the spec, found while planning

The spec says ignoring punctuation puts Vol 2's `SRE_1972-73_Vol2_No3.pdf` last. **It does not.** Once punctuation is ignored, the comparison reaches `73` against `Vol`, and digits sort before letters, so that file still sorts first. Measured with the exact collator:

```text
[ 'SRE_1972-73_Vol2_No3.pdf', 'SRE_1972_Vol2_No1.pdf', 'SRE_1972_Vol2_No2.pdf' ]
```

The rule stays as decided: one order, shown in the plan, and wrong order fixed by renaming. Vol 2 now joins Vol 3 and Vol 27 on the operator's renaming list. Task 1 pins this case as a test so the order cannot change silently, and Task 15 corrects the spec text.

## File map

| File | Change |
| --- | --- |
| `src/core/folderFiles.ts` | **new**: `orderFiles`, `clutterReason`, `listFolderFiles` |
| `src/core/folderReport.ts` | **new**, pure: `folderLines(entries)` for CLI and MCP plan output |
| `src/core/types.ts` | `ManifestFile`, v2 `ManifestEntry`, `Manifest.version: 2`, `rowLabel` |
| `src/core/state.ts` | accept v1 and v2; `upgradeV1` |
| `src/core/plan.ts` | folder rows, `size`, unclaimed-folder warning |
| `src/core/upload.ts` | `uploadFiles`, `checkUnchanged`; `uploadFile` removed |
| `src/core/runner.ts` | N attachments, `attachmentUuids`, `rowLabel` in errors |
| `src/core/duplicates.ts` | `verdictFor(fileNames[], …)`; `DuplicateFinding.source` + `fileNames` |
| `src/core/extract/types.ts` | `Column.each` |
| `src/core/extract/profile.ts` | `each` in the zod schema; refuse `each` on the attachment column |
| `src/core/extract/rows.ts` | `trySources` split out of `fill`; `buildFolderRow` |
| `src/core/extract/extract.ts` | `listSubfolders`, `extractFolders` |
| `src/core/ai/fill.ts` | `MissingModelReason` gains `'folder-row'` |
| `src/cli/index.ts`, `src/cli/extract.ts` | `rowLabel`, folder listing, `--per-folder` |
| `src/mcp/index.ts` | `rowLabel`, folder listing |
| `src/desktop/ipc.ts`, `handlers.ts`, `extractHandlers.ts` | `label` fields, `PlanReport.folders`, `perFolder` |
| `src/desktop/ui/…` | review folder section, warnings bucket, duplicates, progress, results, extract toggle |
| `templates/snake-river-echoes.profile.json` | **new** |
| `tests/helpers/entry.ts` | **new**: `fileEntry` fixture helper |
| `tests/helpers/mockServer.ts` | record each item's attachments |
| README.md, docs/INSTALL.md, CLAUDE.md, spec, handoff | documentation |

---

### Task 1: `folderFiles.ts` — order and contents of a folder

**Files:**
- Create: `src/core/folderFiles.ts`
- Test: `tests/folderFiles.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/folderFiles.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orderFiles, clutterReason, listFolderFiles } from '../src/core/folderFiles.js';

describe('orderFiles', () => {
  it('sorts numbers by value, not by character', () => {
    expect(orderFiles(['Issue10.pdf', 'Issue9.pdf', 'Issue1.pdf'])).toEqual([
      'Issue1.pdf', 'Issue9.pdf', 'Issue10.pdf',
    ]);
  });

  it('ignores case and punctuation between words', () => {
    expect(orderFiles(['Ledger_No2.pdf', 'ledger-no1.pdf', 'LEDGER No3.pdf'])).toEqual([
      'ledger-no1.pdf', 'Ledger_No2.pdf', 'LEDGER No3.pdf',
    ]);
  });

  // PINNED, NOT ENDORSED. A hyphenated year range compares its second half
  // against the next word, and digits sort before letters, so this issue
  // sorts first. The decision is "rename to fix", and the plan shows the
  // order so the operator can see it. This test exists so the order cannot
  // change without someone noticing.
  it('puts a hyphenated year range before the plain year (rename to fix)', () => {
    expect(orderFiles(['Gazette_1972_V2_No1.pdf', 'Gazette_1972-73_V2_No3.pdf', 'Gazette_1972_V2_No2.pdf']))
      .toEqual(['Gazette_1972-73_V2_No3.pdf', 'Gazette_1972_V2_No1.pdf', 'Gazette_1972_V2_No2.pdf']);
  });

  it('keeps an ampersand name in its numeric place', () => {
    expect(orderFiles(['G_No4.pdf', 'G_No2&3.pdf', 'G_No1.pdf'])).toEqual([
      'G_No1.pdf', 'G_No2&3.pdf', 'G_No4.pdf',
    ]);
  });

  it('is total: names equal to the collator still get a fixed order', () => {
    const a = orderFiles(['b.pdf', 'B.pdf', 'b_.pdf']);
    const b = orderFiles(['b_.pdf', 'B.pdf', 'b.pdf']);
    expect(a).toEqual(b);
  });

  it('does not mutate its input', () => {
    const input = ['b', 'a'];
    orderFiles(input);
    expect(input).toEqual(['b', 'a']);
  });
});

describe('clutterReason', () => {
  it.each(['Thumbs.db', 'thumbs.DB', 'desktop.ini', '.DS_Store', '.hidden', '~$draft.docx'])(
    'names %s as clutter',
    (name) => expect(clutterReason(name)).not.toBeNull(),
  );
  it('passes an ordinary file', () => expect(clutterReason('Issue1.pdf')).toBeNull());
});

describe('listFolderFiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oeq-ff-'));
  });

  it('lists files in upload order with sizes, skipping clutter by name', async () => {
    await writeFile(join(dir, 'No10.pdf'), 'xx');
    await writeFile(join(dir, 'No9.pdf'), 'x');
    await writeFile(join(dir, 'Thumbs.db'), 'x');
    const r = await listFolderFiles(dir);
    expect(r.refusal).toBeUndefined();
    expect(r.files).toEqual([{ name: 'No9.pdf', size: 1 }, { name: 'No10.pdf', size: 2 }]);
    expect(r.skipped.map((s) => s.name)).toEqual(['Thumbs.db']);
  });

  it('refuses a folder holding a folder, naming it', async () => {
    await writeFile(join(dir, 'a.pdf'), 'x');
    await mkdir(join(dir, 'extras'));
    const r = await listFolderFiles(dir);
    expect(r.refusal).toMatch(/'extras'/);
  });

  it('skips a hidden folder rather than refusing', async () => {
    await writeFile(join(dir, 'a.pdf'), 'x');
    await mkdir(join(dir, '.sync'));
    const r = await listFolderFiles(dir);
    expect(r.refusal).toBeUndefined();
    expect(r.skipped.map((s) => s.name)).toEqual(['.sync']);
  });

  it('refuses an empty folder', async () => {
    expect((await listFolderFiles(dir)).refusal).toBe('the folder is empty');
  });

  it('refuses a folder holding only skipped files, and says so', async () => {
    await writeFile(join(dir, 'desktop.ini'), 'x');
    expect((await listFolderFiles(dir)).refusal).toBe('the folder holds only skipped files');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/folderFiles.test.ts`
Expected: FAIL, because the module `../src/core/folderFiles.js` cannot be found.

- [ ] **Step 3: Implement**

```ts
// src/core/folderFiles.ts
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The ONE order a folder's files are uploaded in. Used by plan and extractor
 * alike, so the spreadsheet and the contribution cannot disagree.
 *
 * Natural (Issue9 before Issue10), case-blind, punctuation-blind. Ties --
 * names the collator calls equal -- are broken by plain code-unit order, so
 * the result never depends on the order readdir happened to return.
 *
 * It is a rule, not a judgement. It cannot know that a commemorative issue
 * belongs last or that a misfiled issue belongs elsewhere, and it puts a
 * hyphenated year range (`1972-73`) before the plain year, because the
 * comparison reaches `73` against `Vol` and digits sort before letters. The
 * remedy for all of these is renaming the file, and the plan prints the order
 * so the operator can see it before anything is uploaded.
 */
const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base', ignorePunctuation: true });

export function orderFiles(names: readonly string[]): string[] {
  return [...names].sort((a, b) => COLLATOR.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
}

const SYSTEM_FILES: Record<string, string> = {
  'thumbs.db': 'a Windows thumbnail cache',
  'desktop.ini': 'a Windows folder settings file',
  '.ds_store': 'a macOS folder settings file',
};

/** Why this name is never uploaded, or null when it is an ordinary file. */
export function clutterReason(name: string): string | null {
  const fixed = SYSTEM_FILES[name.toLowerCase()];
  if (fixed !== undefined) return fixed;
  if (name.startsWith('~$')) return 'an Office lock file';
  if (name.startsWith('.')) return 'a hidden file';
  return null;
}

export interface FolderFiles {
  /** In upload order. */
  files: { name: string; size: number }[];
  /** Never uploaded, each with the reason. Shown, never silent. */
  skipped: { name: string; reason: string }[];
  /** Set when the folder must not become a contribution at all. */
  refusal?: string;
}

/**
 * What one folder contributes. A refusal is never a partial answer: a folder
 * holding a folder is not uploaded with fewer files than it holds.
 */
export async function listFolderFiles(dir: string): Promise<FolderFiles> {
  const entries = await readdir(dir, { withFileTypes: true });
  const skipped: FolderFiles['skipped'] = [];
  const nested: string[] = [];
  const names: string[] = [];

  for (const entry of entries) {
    const clutter = clutterReason(entry.name);
    if (clutter !== null) {
      skipped.push({ name: entry.name, reason: clutter });
    } else if (entry.isDirectory()) {
      nested.push(entry.name);
    } else if (entry.isFile()) {
      names.push(entry.name);
    } else {
      skipped.push({ name: entry.name, reason: 'not an ordinary file' });
    }
  }

  const files: FolderFiles['files'] = [];
  for (const name of orderFiles(names)) {
    files.push({ name, size: (await stat(join(dir, name))).size });
  }

  let refusal: string | undefined;
  if (nested.length > 0) {
    refusal =
      `it holds ${nested.length === 1 ? 'a folder' : 'folders'} ` +
      `(${orderFiles(nested).map((n) => `'${n}'`).join(', ')}); a folder inside a folder is not ` +
      `uploaded -- move its files up into this folder or out of it`;
  } else if (files.length === 0) {
    refusal = skipped.length > 0 ? 'the folder holds only skipped files' : 'the folder is empty';
  }

  return refusal === undefined ? { files, skipped } : { files, skipped, refusal };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run tests/folderFiles.test.ts`
Expected: PASS. If the hyphenated-range test fails because the order differs on this Node/ICU version, **stop and report it**. The pinned order is the behaviour the operator was told about.

- [ ] **Step 5: Mutation check**

Use Edit to remove the `|| (a < b …)` tie-break. Confirm the file changed, then confirm the "is total" test fails. Restore it.

- [ ] **Step 6: Commit**

```bash
git add src/core/folderFiles.ts tests/folderFiles.test.ts
git commit -m "feat(core): folderFiles -- one upload order and one listing for a folder"
```

---

### Task 2: Manifest v2, with v1 still loading

This task changes the manifest shape. To keep the build green it also makes every reader compile, using single-file shims that later tasks replace.

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/state.ts`
- Modify: `src/core/plan.ts`, `src/core/runner.ts`, `src/core/duplicates.ts` (shims only), `src/cli/index.ts`, `src/mcp/index.ts`, `src/desktop/handlers.ts`
- Create: `tests/helpers/entry.ts`
- Test: `tests/state.test.ts` and every test fixture that builds a `ManifestEntry`

- [ ] **Step 1: Write the failing tests** (append to `tests/state.test.ts`)

```ts
import { rowLabel } from '../src/core/types.js';

describe('manifest v1 compatibility', () => {
  it('loads a v1 manifest as v2: one-element files list, no size, uuid as a list', async () => {
    const path = join(dir, 'v1.json');
    await writeFile(path, JSON.stringify({
      version: 1, createdAt: 'x', baseUrl: 'https://h', collectionUuid: 'c', schemaUuid: 's',
      itemState: 'draft', attachmentColumn: 'attachment name', warnings: [],
      entries: [{
        rowNumber: 2, filePath: '/b/clip.mp4', fileName: 'clip.mp4', metadata: {},
        status: 'created', itemUuid: 'i', itemVersion: 1, attachmentUuid: 'a1', attempts: 1,
      }],
    }));
    const m = await loadManifest(path);
    expect(m.version).toBe(2);
    expect(m.entries[0]).toEqual({
      rowNumber: 2, source: 'clip.mp4', files: [{ path: '/b/clip.mp4', name: 'clip.mp4' }],
      metadata: {}, status: 'created', itemUuid: 'i', itemVersion: 1, attachmentUuids: ['a1'], attempts: 1,
    });
  });

  it('a v1 row with no attachment uuid gets no attachmentUuids key', async () => {
    const path = join(dir, 'v1b.json');
    await writeFile(path, JSON.stringify({
      version: 1, createdAt: 'x', baseUrl: 'https://h', collectionUuid: 'c', schemaUuid: 's',
      itemState: 'draft', attachmentColumn: 'attachment name', warnings: [],
      entries: [{ rowNumber: 2, filePath: '/b/a.pdf', fileName: 'a.pdf', metadata: {}, status: 'pending', attempts: 0 }],
    }));
    expect('attachmentUuids' in (await loadManifest(path)).entries[0]!).toBe(false);
  });

  it('still refuses an unknown version', async () => {
    const path = join(dir, 'v9.json');
    await writeFile(path, JSON.stringify({ version: 9, entries: [], collectionUuid: 'c', itemState: 'draft' }));
    await expect(loadManifest(path)).rejects.toThrow(/expected 1 or 2/);
  });
});

describe('rowLabel', () => {
  it('is the filename for a file row', () => {
    expect(rowLabel({ source: 'a.pdf', files: [{ path: '/a.pdf', name: 'a.pdf' }] })).toBe('a.pdf');
  });
  it('counts files for a folder row, singular included', () => {
    const f = { path: '/v/x', name: 'x' };
    expect(rowLabel({ source: 'Vol2', folderPath: '/v', files: [f, f, f] })).toBe('Vol2 (3 files)');
    expect(rowLabel({ source: 'Vol9', folderPath: '/v', files: [f] })).toBe('Vol9 (1 file)');
  });
});
```

Make sure `writeFile` is imported and a temp `dir` is created by the file's `beforeEach`. Follow whatever the file already does.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/state.test.ts`
Expected: FAIL. `rowLabel` is not exported and version 1 does not upgrade.

- [ ] **Step 3: Change the types** in `src/core/types.ts`

Replace `ManifestEntry` and `Manifest.version`:

```ts
/** One file a row contributes, in upload order. */
export interface ManifestFile {
  /** Absolute path on disk. */
  path: string;
  /** Filename as it appears as the attachment. */
  name: string;
  /**
   * Bytes at plan time, so the run can tell a file was replaced. ABSENT on a
   * row planned by a version that did not record sizes (manifest v1): for those
   * the run checks presence only, and cannot tell a same-named replacement.
   */
  size?: number;
}

export interface ManifestEntry {
  rowNumber: number;
  /** What `attachment name` said: a filename, or a folder name. The row's label. */
  source: string;
  /** Set only when `source` named a folder: its absolute path. Re-listed at run time. */
  folderPath?: string;
  /** One for a file row, every file in upload order for a folder row. Never empty. */
  files: ManifestFile[];
  /** Files in the folder that are never uploaded, shown in the plan. Folder rows only. */
  skippedFiles?: { name: string; reason: string }[];
  /** Metadata xpath -> value(s). Repeated headers collapse into multiple values. */
  metadata: Record<string, string[]>;
  status: RowStatus;
  /** Populated once openEQUELLA returns it. The authoritative identity. */
  itemUuid?: string;
  /** openEQUELLA items are versioned; this is the version this row created. */
  itemVersion?: number;
  /** One uuid per entry in `files`, in the same order, as they exist on the server. */
  attachmentUuids?: string[];
  error?: string;
  /** Cumulative attempts across all resumed runs; retry resets status, not this. */
  attempts: number;
}
```

In `Manifest`, set `version: 2;`. After `sameFileName`, add:

```ts
/**
 * How a row is named to the operator everywhere: CLI, MCP, desktop and every
 * runner error. A file row is its filename, exactly as before; a folder row
 * says how many files it carries, so "SRE_Vol3 (6 files)" cannot be mistaken
 * for one file. Lives here because the renderer needs it and types.ts has no
 * node imports.
 */
export function rowLabel(entry: Pick<ManifestEntry, 'source' | 'folderPath' | 'files'>): string {
  if (entry.folderPath === undefined) return entry.source;
  const n = entry.files.length;
  return `${entry.source} (${n} file${n === 1 ? '' : 's'})`;
}
```

- [ ] **Step 4: Upgrade v1 at load** in `src/core/state.ts`

In `validateStructure`, replace the version check:

```ts
  if (m['version'] !== 1 && m['version'] !== 2) {
    throw new OeqError(
      `Unsupported manifest version ${JSON.stringify(m['version'])} in ${path}; expected 1 or 2. ` +
        `This manifest may be from an incompatible version of the tool; do not resume with it.`,
    );
  }
```

Change its signature to `asserts value is Record<string, unknown>`. The cast to `Manifest` now happens after the upgrade. Then replace the end of `loadManifest`:

```ts
  validateStructure(parsed, path);
  return parsed['version'] === 1 ? upgradeV1(parsed) : (parsed as unknown as Manifest);
}

interface V1Entry {
  filePath: string;
  fileName: string;
  attachmentUuid?: string;
  [field: string]: unknown;
}

/**
 * A v1 manifest -- one file per row -- read as v2. Nothing on disk changes
 * until the runner next saves, which writes v2.
 *
 * NO SIZE IS INVENTED. v1 never recorded one, and reading today's size here
 * would make the run's "changed since planning" check compare a file against
 * itself. Absent, the check verifies presence only; see ManifestFile.size.
 */
function upgradeV1(m: Record<string, unknown>): Manifest {
  const entries = (m['entries'] as V1Entry[]).map(({ filePath, fileName, attachmentUuid, ...rest }) => ({
    ...rest,
    source: fileName,
    files: [{ path: filePath, name: fileName }],
    ...(attachmentUuid !== undefined ? { attachmentUuids: [attachmentUuid] } : {}),
  }));
  return { ...m, version: 2, entries } as unknown as Manifest;
}
```

- [ ] **Step 5: Make every reader compile with single-file shims**

Run `npm run typecheck` and fix each error as follows. **Each shim is replaced in a later task.**

- `plan.ts` `entries.push`: replace `filePath`/`fileName` with `source: actual, files: [{ path: resolve(filesDir, actual), name: actual }]`. Set `version: 2`. In `preflightDuplicates`, replace `'${entry.fileName}'` with `'${rowLabel(entry)}'`, importing `rowLabel` from `./types.js`.
- `runner.ts`:
  - `rowContext` returns `` `Row ${entry.rowNumber} (${rowLabel(entry)})` ``.
  - `processEntry` calls `uploadFile(client, entry.files[0]!.path, entry.files[0]!.name)` and uses `entry.files[0]!.name` for the attachment (Task 5 replaces this).
  - Where it sets `entry.attachmentUuid = x`, write `entry.attachmentUuids = [x]` instead.
- `duplicates.ts`: replace `entry.fileName` with `entry.files[0]!.name` (Task 6 replaces this).
- `cli/index.ts` lines 138, 172 and 179, `mcp/index.ts` lines 467 and 474: replace `e.fileName` with `rowLabel(e)`.
- `desktop/handlers.ts`: replace `entry.fileName` / `e.fileName` with `rowLabel(entry)` / `rowLabel(e)`. The IPC field names change in Task 9.

- [ ] **Step 6: Add the fixture helper and migrate the test fixtures**

```ts
// tests/helpers/entry.ts
import type { ManifestEntry } from '../../src/core/types.js';

/** A pending single-file row, v2 shape. No size: the size check is skipped, as for v1. */
export function fileEntry(
  rowNumber: number,
  path: string,
  name: string,
  extra: Partial<ManifestEntry> = {},
): ManifestEntry {
  return { rowNumber, source: name, files: [{ path, name }], metadata: {}, status: 'pending', attempts: 0, ...extra };
}
```

Run `npm run typecheck` and replace each `filePath: X, fileName: Y` fixture with `source: Y, files: [{ path: X, name: Y }]` (or `fileEntry`). Also:

- Replace `version: 1` in fixtures with `version: 2`.
- Replace assertions on `.fileName` with `.source`.
- Replace assertions on `.attachmentUuid` with `.attachmentUuids?.[0]` or `.attachmentUuids`.

The files involved are listed in the File map. The counts from grep are: `cli`, `config`, `desktop/handlers`, `desktop/reviewRoundTrip`, `desktop/secrets`, `desktop/session`, `duplicates`, `mcp`, `plan`, `preflight`, `runner`, `state`, `client`. Some hits in `secrets` and `session` are dialog `filePaths`; leave those alone.

- [ ] **Step 7: Run the checks**

Run: `npm run typecheck`, then `npm test`
Expected: both clean. Every existing test still passes, because every file row behaves as before.

- [ ] **Step 8: Mutation check**

Use Edit to drop the `...(attachmentUuid !== undefined ? …)` spread from `upgradeV1`. Confirm the first v1 test fails. Restore it.

- [ ] **Step 9: Commit**

```bash
git add -A src tests
git commit -m "feat(core): manifest v2 -- every row carries a files list; v1 still loads"
```

---

### Task 3: Plan folder rows

**Files:**
- Modify: `src/core/plan.ts`
- Create: `src/core/folderReport.ts`
- Test: `tests/plan.test.ts`, `tests/folderReport.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `tests/plan.test.ts`, reusing its existing sheet/schema helpers and temp `dir`)

```ts
describe('folder rows', () => {
  async function folder(name: string, files: Record<string, string>) {
    await mkdir(join(dir, name));
    for (const [f, body] of Object.entries(files)) await writeFile(join(dir, name, f), body);
  }

  it('plans a folder as one row holding its files in upload order, with sizes', async () => {
    await folder('Gazette_V2', { 'G_No10.pdf': 'aa', 'G_No9.pdf': 'a', 'Thumbs.db': 'x' });
    const m = await buildManifest(sheetOf([{ 'attachment name': 'Gazette_V2' }]), dir, paths, opts);
    const e = m.entries[0]!;
    expect(e.source).toBe('Gazette_V2');
    expect(e.folderPath).toBe(resolve(dir, 'Gazette_V2'));
    expect(e.files).toEqual([
      { path: resolve(dir, 'Gazette_V2', 'G_No9.pdf'), name: 'G_No9.pdf', size: 1 },
      { path: resolve(dir, 'Gazette_V2', 'G_No10.pdf'), name: 'G_No10.pdf', size: 2 },
    ]);
    expect(e.skippedFiles).toEqual([{ name: 'Thumbs.db', reason: 'a Windows thumbnail cache' }]);
  });

  it('records a size on a single-file row too', async () => {
    await writeFile(join(dir, 'one.pdf'), 'abc');
    const m = await buildManifest(sheetOf([{ 'attachment name': 'one.pdf' }]), dir, paths, opts);
    expect(m.entries[0]!.files[0]!.size).toBe(3);
    expect(m.entries[0]!.folderPath).toBeUndefined();
  });

  it('skips a refused folder with its reason, never planning it short', async () => {
    await folder('Gazette_V3', { 'a.pdf': 'x' });
    await mkdir(join(dir, 'Gazette_V3', 'extra'));
    await writeFile(join(dir, 'other.pdf'), 'x');
    const m = await buildManifest(
      sheetOf([{ 'attachment name': 'Gazette_V3' }, { 'attachment name': 'other.pdf' }]), dir, paths, opts,
    );
    expect(m.entries.map((e) => e.source)).toEqual(['other.pdf']);
    expect(m.warnings).toContainEqual(expect.stringMatching(/^Row 2: folder 'Gazette_V3' cannot be uploaded: .*'extra'.*; skipped\.$/));
  });

  it('warns about an unclaimed folder only when the batch uses folders', async () => {
    await folder('Gazette_V1', { 'a.pdf': 'x' });
    await folder('Gazette_V2', { 'a.pdf': 'x' });
    const m = await buildManifest(sheetOf([{ 'attachment name': 'Gazette_V1' }]), dir, paths, opts);
    expect(m.warnings).toContain("Folder 'Gazette_V2' has no matching row; not uploaded.");
  });

  it('stays silent about incidental folders in a file-only batch', async () => {
    await mkdir(join(dir, 'scratch'));
    await writeFile(join(dir, 'one.pdf'), 'x');
    const m = await buildManifest(sheetOf([{ 'attachment name': 'one.pdf' }]), dir, paths, opts);
    expect(m.warnings.some((w) => w.includes('scratch'))).toBe(false);
  });

  it('refuses two rows claiming one folder, as for a file', async () => {
    await folder('Gazette_V1', { 'a.pdf': 'x' });
    await expect(buildManifest(
      sheetOf([{ 'attachment name': 'Gazette_V1' }, { 'attachment name': 'gazette_v1' }]), dir, paths, opts,
    )).rejects.toThrow(/claimed by rows 2, 3/);
  });
});
```

If `sheetOf`, `paths` or `opts` are named differently in `tests/plan.test.ts`, use the existing names. Import `mkdir` and `resolve`.

```ts
// tests/folderReport.test.ts
import { describe, it, expect } from 'vitest';
import { folderLines } from '../src/core/folderReport.js';
import { fileEntry } from './helpers/entry.js';

describe('folderLines', () => {
  it('lists each folder row, numbered in upload order, with its skipped files', () => {
    const folderRow = {
      ...fileEntry(3, '', ''),
      source: 'Gazette_V2',
      folderPath: '/b/Gazette_V2',
      files: [{ path: '/b/Gazette_V2/G_No1.pdf', name: 'G_No1.pdf' }, { path: '/b/Gazette_V2/G_No2.pdf', name: 'G_No2.pdf' }],
      skippedFiles: [{ name: 'Thumbs.db', reason: 'a Windows thumbnail cache' }],
    };
    expect(folderLines([fileEntry(2, '/b/x.pdf', 'x.pdf'), folderRow])).toEqual([
      'Row 3: Gazette_V2 (2 files), in upload order:',
      '    1. G_No1.pdf',
      '    2. G_No2.pdf',
      '    not uploaded: Thumbs.db (a Windows thumbnail cache)',
    ]);
  });
  it('says nothing for a file-only batch', () => {
    expect(folderLines([fileEntry(2, '/b/x.pdf', 'x.pdf')])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/plan.test.ts tests/folderReport.test.ts`
Expected: FAIL. Folders are not matched, and `folderReport` does not exist.

- [ ] **Step 3: Implement `folderReport.ts`**

```ts
// src/core/folderReport.ts
import { rowLabel, type ManifestEntry } from './types.js';

/**
 * The plan's account of every folder row: its files in the order they will
 * be attached, and what in the folder will not be. PURE, so the CLI and the
 * MCP server print the same lines. The order is a rule, not a judgement (see
 * folderFiles.ts#orderFiles), and this listing is how the operator checks it
 * before anything is uploaded.
 */
export function folderLines(entries: readonly ManifestEntry[]): string[] {
  const lines: string[] = [];
  for (const e of entries) {
    if (e.folderPath === undefined) continue;
    lines.push(`Row ${e.rowNumber}: ${rowLabel(e)}, in upload order:`);
    e.files.forEach((f, i) => lines.push(`    ${i + 1}. ${f.name}`));
    for (const s of e.skippedFiles ?? []) lines.push(`    not uploaded: ${s.name} (${s.reason})`);
  }
  return lines;
}
```

- [ ] **Step 4: Implement folder rows in `plan.ts`**

Imports: `readdir, stat` from `node:fs/promises`, `join` from `node:path`, `listFolderFiles` from `./folderFiles.js`.

Replace the directory scan and the start of the row loop:

```ts
  // Files AND folders are candidates now: a row may name a subfolder, whose
  // files become one contribution's attachments (folderFiles.ts).
  const dirEntries = await readdir(filesDir, { withFileTypes: true });
  const onDisk = dirEntries.filter((d) => d.isFile()).map((d) => d.name);
  const folders = dirEntries.filter((d) => d.isDirectory()).map((d) => d.name);
  const byLower = new Map<string, { name: string; isFolder: boolean }>([
    ...folders.map((f) => [f.toLowerCase(), { name: f, isFolder: true }] as const),
    // Files second, so on a case-sensitive disk a file wins a tie: the
    // behaviour every existing batch already had.
    ...onDisk.map((f) => [f.toLowerCase(), { name: f, isFolder: false }] as const),
  ]);
```

Inside the loop, replace the lookup and the "not found" handling:

```ts
    const match = byLower.get(wanted.toLowerCase());
    if (!match) {
      warnings.push(`Row ${row.rowNumber}: file '${wanted}' not found in ${filesDir}; skipped.`);
      continue;
    }
    const actual = match.name;

    let files: ManifestFile[];
    let folderPath: string | undefined;
    let skippedFiles: ManifestEntry['skippedFiles'];
    if (match.isFolder) {
      folderPath = resolve(filesDir, actual);
      const listing = await listFolderFiles(folderPath);
      if (listing.refusal !== undefined) {
        // Skipped whole, never planned with fewer files than the folder
        // holds: an item missing an issue reads as complete.
        warnings.push(`Row ${row.rowNumber}: folder '${actual}' cannot be uploaded: ${listing.refusal}; skipped.`);
        continue;
      }
      files = listing.files.map((f) => ({ path: join(folderPath!, f.name), name: f.name, size: f.size }));
      if (listing.skipped.length > 0) skippedFiles = listing.skipped;
    } else {
      const path = resolve(filesDir, actual);
      files = [{ path, name: actual, size: (await stat(path)).size }];
    }
```

Keep the claims bookkeeping as it is, keyed on `actual`. Build the entry as:

```ts
    entries.push({
      rowNumber: row.rowNumber,
      source: actual,
      ...(folderPath !== undefined ? { folderPath } : {}),
      files,
      ...(skippedFiles !== undefined ? { skippedFiles } : {}),
      metadata,
      status: 'pending',
      attempts: 0,
    });
```

**Note:** `folderPath` is `resolve(filesDir, actual)`, and the test expects `join(folderPath, name)` for each file path. On Windows `resolve` already normalises, so `join` of an absolute path stays absolute.

In the conflict message, say "the same file or folder" and "each may back only one contribution". After the unclaimed-files loop, add:

```ts
  // Unclaimed folders are reported only when this batch uses folders at all.
  // A file-only batch's folder routinely holds incidental subfolders and
  // always has; naming them would be noise. A folder batch missing one is
  // a volume that will silently not be contributed.
  if (entries.some((e) => e.folderPath !== undefined)) {
    for (const f of folders) {
      if (!claims.has(f)) warnings.push(`Folder '${f}' has no matching row; not uploaded.`);
    }
  }
```

In the empty-manifest message, change "No rows matched any file" to "No rows matched any file or folder".

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run tests/plan.test.ts tests/folderReport.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation check**

Use Edit to replace the `continue;` after the refusal warning with nothing. Confirm the refused-folder test fails. Restore it.

- [ ] **Step 7: Commit**

```bash
git add src/core/plan.ts src/core/folderReport.ts tests/plan.test.ts tests/folderReport.test.ts
git commit -m "feat(plan): a row may name a folder; its files plan in upload order"
```

---

### Task 4: Upload N files into one staging area

**Files:**
- Modify: `src/core/upload.ts`
- Test: `tests/upload.test.ts`

- [ ] **Step 1: Write the failing tests** (append; migrate existing `uploadFile(client, p, name)` calls to `uploadFiles(client, single(p, name))`)

```ts
import { uploadFiles } from '../src/core/upload.js';
import { mkdir } from 'node:fs/promises';

const single = (path: string, name: string) => ({ source: name, files: [{ path, name }] });

describe('uploadFiles -- folder rows', () => {
  async function folderOf(files: Record<string, string>) {
    const f = join(dir, 'V2');
    await mkdir(f);
    for (const [n, b] of Object.entries(files)) await writeFile(join(f, n), b);
    return {
      source: 'V2',
      folderPath: f,
      files: Object.entries(files).map(([name, b]) => ({ path: join(f, name), name, size: b.length })),
    };
  }

  it('puts every file into ONE staging area, in manifest order', async () => {
    const unit = await folderOf({ 'No1.pdf': 'a', 'No2.pdf': 'bb', 'No3.pdf': 'ccc' });
    const staging = await uploadFiles(client, unit);
    expect(mock.state.uploads).toEqual([
      { staging, filename: 'No1.pdf', bytes: 1 },
      { staging, filename: 'No2.pdf', bytes: 2 },
      { staging, filename: 'No3.pdf', bytes: 3 },
    ]);
  });

  it('a 401 on the second file restarts the WHOLE row in a fresh staging area', async () => {
    const unit = await folderOf({ 'No1.pdf': 'a', 'No2.pdf': 'bb' });
    // first PUT succeeds, second is refused once
    const original = mock.state.uploads.length;
    mock.state.expireNextUploadAfter = 1; // see Step 3b
    const staging = await uploadFiles(client, unit);
    const ok = mock.state.uploads.slice(original).filter((u) => u.staging === staging);
    expect(ok.map((u) => u.filename)).toEqual(['No1.pdf', 'No2.pdf']);
    expect(mock.state.stagingAreas.size).toBe(1);
  });

  it('fails the row when the folder gained a file since planning', async () => {
    const unit = await folderOf({ 'No1.pdf': 'a' });
    await writeFile(join(unit.folderPath, 'No2.pdf'), 'x');
    await expect(uploadFiles(client, unit)).rejects.toThrow(
      /the folder changed since planning \('No2\.pdf' was added\); plan again/,
    );
    expect(mock.state.stagingAreas.size).toBe(0);
  });

  it('fails the row when a file changed size, naming both sizes', async () => {
    const unit = await folderOf({ 'No1.pdf': 'a' });
    await writeFile(join(unit.folderPath, 'No1.pdf'), 'abcd');
    await expect(uploadFiles(client, unit)).rejects.toThrow(/'No1\.pdf' changed size \(1 bytes when planned, 4 now\)/);
  });

  it('fails the row when a file is missing', async () => {
    const unit = await folderOf({ 'No1.pdf': 'a', 'No2.pdf': 'b' });
    await rm(join(unit.folderPath, 'No2.pdf'));
    await expect(uploadFiles(client, unit)).rejects.toThrow(/'No2\.pdf' is missing/);
  });

  it('refuses a 0-byte file in a folder, naming it', async () => {
    const unit = await folderOf({ 'No1.pdf': 'a', 'No2.pdf': '' });
    await expect(uploadFiles(client, unit)).rejects.toThrow(/No2\.pdf.*0 bytes/);
    expect(mock.state.stagingAreas.size).toBe(0);
  });

  it('checks presence only when no size was recorded (a v1 manifest)', async () => {
    const unit = await folderOf({ 'No1.pdf': 'a' });
    delete (unit.files[0] as { size?: number }).size;
    await writeFile(join(unit.folderPath, 'No1.pdf'), 'abcd');
    await expect(uploadFiles(client, unit)).resolves.toBeTypeOf('string');
  });

  it.each(['A & B.pdf', 'No #3.pdf', '100% done.pdf', 'what?.pdf'])(
    'percent-encodes %s in the staging path so the server receives it whole',
    async (name) => {
      const p = join(dir, name);
      await writeFile(p, 'x');
      await uploadFiles(client, single(p, name));
      expect(mock.state.uploads.at(-1)!.filename).toBe(name);
    },
  );
});
```

**Note:** `'what?.pdf'` is not a legal Windows filename. Skip that case on win32 with `it.skipIf(process.platform === 'win32')` in a separate `it`, and keep the other three in the `each`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/upload.test.ts`
Expected: FAIL, because `uploadFiles` is not exported.

- [ ] **Step 3: Implement**

**3a.** In `src/core/upload.ts`, replace `uploadFile` and `uploadOnce` with the code below. Keep the header doc's "401-mid-upload gap" section, reworded from "file" to "row", and keep the existing comments about `Readable.toWeb` and `destroy()` inside the loop.

```ts
import { listFolderFiles } from './folderFiles.js';
import type { ManifestFile } from './types.js';

/** What a row uploads. Structurally a subset of ManifestEntry. */
export interface UploadUnit {
  source: string;
  folderPath?: string;
  files: ManifestFile[];
}

/**
 * Upload a row's files into ONE fresh staging area, in order, and return its uuid.
 * Nothing is created until checkUnchanged has passed.
 */
export async function uploadFiles(client: OeqClient, unit: UploadUnit): Promise<string> {
  await checkUnchanged(unit);
  return uploadOnce(client, unit.files, false);
}

/**
 * The row's files are still the ones that were planned, or a ValidationError
 * (not retryable) saying what changed. The plan the operator read is the
 * thing they approved: a file added, removed or replaced since then makes a
 * contribution nobody looked at.
 */
export async function checkUnchanged(unit: UploadUnit): Promise<void> {
  if (unit.folderPath !== undefined) {
    const listing = await listFolderFiles(unit.folderPath);
    const now = new Map(listing.files.map((f) => [f.name, f.size]));
    const planned = new Set(unit.files.map((f) => f.name));
    const problems: string[] = [];
    if (listing.refusal !== undefined && listing.files.length > 0) problems.push(listing.refusal);
    for (const f of unit.files) {
      const size = now.get(f.name);
      if (size === undefined) problems.push(`'${f.name}' is missing`);
      // f.size absent: planned by a version that did not record sizes
      // (manifest v1). Only presence can be checked; see ManifestFile.size.
      else if (f.size !== undefined && size !== f.size) {
        problems.push(`'${f.name}' changed size (${f.size} bytes when planned, ${size} now)`);
      }
    }
    for (const name of now.keys()) if (!planned.has(name)) problems.push(`'${name}' was added`);
    if (problems.length > 0) {
      throw new ValidationError(`the folder changed since planning (${problems.join('; ')}); plan again`);
    }
  }

  for (const f of unit.files) {
    const { size } = await stat(f.path);
    if (unit.folderPath === undefined && f.size !== undefined && size !== f.size) {
      throw new ValidationError(
        `'${f.name}' changed since planning (${f.size} bytes when planned, ${size} now); plan again`,
      );
    }
    // A 0-byte source is evidence of a broken export or copy upstream, never an
    // intended empty attachment. (Comment carried from the old uploadFile.)
    if (size === 0) throw new ValidationError(`Refusing to upload '${f.path}': the file is 0 bytes.`);
  }
}

async function uploadOnce(client: OeqClient, files: ManifestFile[], isRetry: boolean): Promise<string> {
  const stagingUuid = await client.createStagingArea();
  for (const f of files) {
    const nodeStream = createReadStream(f.path);
    try {
      const body = Readable.toWeb(nodeStream) as ReadableStream;
      await client.uploadToStaging(stagingUuid, f.name, body);
    } catch (err) {
      nodeStream.destroy();
      await client.deleteStagingArea(stagingUuid);
      // The WHOLE row restarts, not the one file: the staging area holding
      // the earlier files is gone, and a contribution must never be created
      // from a partial set. Once only; a second 401 is a real auth failure.
      if (!isRetry && err instanceof ApiError && err.status === 401) {
        return uploadOnce(client, files, true);
      }
      throw err;
    }
  }
  return stagingUuid;
}
```

**3b.** The second-file 401 test needs mock scaffolding. In `tests/helpers/mockServer.ts`, add `expireNextUploadAfter: number` to `MockState`. Document it as: "Let this many more PUTs succeed, then refuse the next one with 401. Test scaffolding." Initialise it to `-1`. In the PUT handler, before the `expireNextUpload` check:

```ts
        if (state.expireNextUploadAfter === 0) {
          state.expireNextUploadAfter = -1;
          return send(res, 401, { error: 'token expired' });
        }
        if (state.expireNextUploadAfter > 0) state.expireNextUploadAfter--;
```

Check how the mock's 401 interacts with token invalidation. The existing `expireNextUpload` test shows the client re-authenticates on the next request, and the new test relies on that same path.

**3c.** For the `# % ?` names, `uploadToStaging` already uses `encodeURIComponent` (`client.ts:371`). These tests pin that. If one fails, fix the mock's path parsing first: it must take `url.pathname`, not the raw URL.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run tests/upload.test.ts`
Expected: PASS, including the migrated single-file tests.

- [ ] **Step 5: Mutation checks**

Make each change with Edit, confirm the named test fails, then restore it:

1. Remove the `for (const name of now.keys())` line. The "gained a file" test fails.
2. Change `return uploadOnce(client, files, true)` to `throw err`. The 401 test fails.
3. In client.ts:371, replace `encodeURIComponent(filename)` with `filename`. The `#` case fails.

- [ ] **Step 6: Commit**

```bash
git add src/core/upload.ts tests/upload.test.ts tests/helpers/mockServer.ts
git commit -m "feat(upload): a row's files go into one staging area, checked against the plan first"
```

---

### Task 5: Runner creates one item with N attachments

**Files:**
- Modify: `src/core/runner.ts`, `tests/helpers/mockServer.ts`
- Test: `tests/runner.test.ts`

- [ ] **Step 1: Make the mock record attachments**

In `MockState.items`, add `attachments: { filename?: string; description?: string; uuid?: string; type?: string }[]`. Widen the parsed body type to match, and push `attachments: body.attachments ?? []`.

- [ ] **Step 2: Write the failing tests** (append to `tests/runner.test.ts`)

```ts
describe('folder rows', () => {
  async function folderManifest(uuidPath = ''): Promise<string> {
    const f = join(dir, 'V2');
    await mkdir(f);
    for (const [n, b] of [['No1.pdf', 'a'], ['No2.pdf', 'bb']] as const) await writeFile(join(f, n), b);
    const m = manifest();
    m.attachmentUuidPath = uuidPath;
    m.entries = [{
      rowNumber: 2, source: 'V2', folderPath: f,
      files: [{ path: join(f, 'No1.pdf'), name: 'No1.pdf', size: 1 }, { path: join(f, 'No2.pdf'), name: 'No2.pdf', size: 2 }],
      metadata: { 'MWDL/title': ['Gazette, Volume 2'] }, status: 'pending', attempts: 0,
    }];
    const path = join(dir, 'job.json');
    await saveManifest(path, m);
    return path;
  }

  it('creates ONE item with every file as an attachment, in order', async () => {
    const path = await folderManifest();
    const summary = await runManifest(client, path, { retryDelayMs: 1 });
    expect(summary.created).toBe(1);
    expect(mock.state.items).toHaveLength(1);
    const atts = mock.state.items[0]!.attachments;
    expect(atts.map((a) => [a.type, a.filename, a.description])).toEqual([
      ['file', 'No1.pdf', 'No1.pdf'], ['file', 'No2.pdf', 'No2.pdf'],
    ]);
    const saved = await loadManifest(path);
    expect(saved.entries[0]!.attachmentUuids).toEqual(atts.map((a) => a.uuid));
  });

  it('writes every attachment uuid, in order, to the configured path', async () => {
    const path = await folderManifest('X/attachments/attachment');
    await runManifest(client, path, { retryDelayMs: 1 });
    const item = mock.state.items[0]!;
    for (const a of item.attachments) expect(item.metadata).toContain(a.uuid!);
    expect(item.metadata.indexOf(item.attachments[0]!.uuid!)).toBeLessThan(item.metadata.indexOf(item.attachments[1]!.uuid!));
  });

  it('marks the row incomplete when the server assigns different uuids and the path is set', async () => {
    const path = await folderManifest('X/attachments/attachment');
    mock.state.mismatchAttachmentNext = 1;
    const summary = await runManifest(client, path, { retryDelayMs: 1 });
    expect(summary.incomplete).toBe(1);
    expect((await loadManifest(path)).entries[0]!.error).toMatch(/Row 2 \(V2 \(2 files\)\)/);
  });

  it('names a folder that changed since planning, and creates nothing', async () => {
    const path = await folderManifest();
    await writeFile(join(dir, 'V2', 'No3.pdf'), 'x');
    const summary = await runManifest(client, path, { retryDelayMs: 1 });
    expect(summary.failed).toBe(1);
    expect(mock.state.items).toHaveLength(0);
    expect((await loadManifest(path)).entries[0]!.error).toMatch(/Row 2 \(V2 \(2 files\)\): the folder changed since planning/);
  });
});
```

Confirm that `buildMetadataXml` with a repeated path emits one element per value, in order (see `metadata.ts`). The second test relies on it.

- [ ] **Step 3: Run them and confirm they fail**

Run: `npx vitest run tests/runner.test.ts`
Expected: FAIL. Only one attachment is sent (the Task 2 shim).

- [ ] **Step 4: Implement** in `processEntry`

Replace the upload and create section, and everything after it through the success return:

```ts
  const stagingUuid = await uploadFiles(client, entry);

  // One client uuid per file, in upload order -- openEQUELLA keeps both the
  // order and the uuids it is sent (proven live 2026-11-11).
  const attachments = entry.files.map((f) => ({ filename: f.name, description: f.name, uuid: randomUUID() }));
  const requested = attachments.map((a) => a.uuid);
  const uuidPath = manifest.attachmentUuidPath ?? '';
  const metadata = uuidPath === '' ? entry.metadata : { ...entry.metadata, [uuidPath]: requested };

  const result = await client.createItem({
    collectionUuid: manifest.collectionUuid,
    metadata: buildMetadataXml(metadata),
    stagingUuid,
    attachments,
    draft: manifest.itemState === 'draft',
  });

  entry.itemUuid = result.uuid;
  entry.itemVersion = result.version;

  // Compared POSITION BY POSITION where the server returns any: the metadata
  // lists the uuids in order, so the same set in a different order is still
  // stale. The live server returns none (Location only), which is trusted.
  const returned = result.attachmentUuids;
  const differs =
    returned.length > 0 &&
    (returned.length !== requested.length || requested.some((u, i) => returned[i] !== u));
  if (uuidPath !== '' && differs) {
    entry.attachmentUuids = returned;
    entry.status = 'incomplete';
    entry.error =
      `${rowContext(entry)}: item ${result.uuid} and its attachments were created, but ` +
      `openEQUELLA assigned attachment uuids [${returned.join(', ')}] instead of the requested ` +
      `[${requested.join(', ')}]. The metadata already sent still references the requested ` +
      `uuids, so '${uuidPath}' is now stale on this item. This needs manual correction in ` +
      `openEQUELLA -- do not re-run this row, it would create a duplicate item.`;
    return 'incomplete';
  }

  entry.attachmentUuids = returned.length > 0 ? returned : requested;
  entry.status = 'created';
  delete entry.error;
  return 'created';
```

Update the docblock's "single attachment" wording to "attachments", and its `result.attachmentUuids[0]` reference to "position by position". Import `uploadFiles` instead of `uploadFile`.

- [ ] **Step 5: Run the checks**

Run: `npx vitest run tests/runner.test.ts`, then `npm test`
Expected: PASS. The existing single-file mismatch test still passes; update its expected error text only if it quoted the singular wording.

- [ ] **Step 6: Mutation check**

Use Edit to change `requested.some((u, i) => returned[i] !== u)` to `false`. Confirm the incomplete test still fails, because it relies on that comparison for the folder case. If it does **not** fail, the length check is masking it: add a same-length mismatch assertion and recheck. Restore the line.

- [ ] **Step 7: Commit**

```bash
git add src/core/runner.ts tests/runner.test.ts tests/helpers/mockServer.ts
git commit -m "feat(runner): one item per row with every file attached, in order"
```

---

### Task 6: The duplicate check knows about all of a row's files

**Files:**
- Modify: `src/core/duplicates.ts`, `src/cli/index.ts`, `src/mcp/index.ts`, `src/desktop/ui/duplicates.ts`
- Test: `tests/duplicates.test.ts`

- [ ] **Step 1: Write the failing tests**

Migrate the existing `verdictFor('a.pdf', …)` calls to `verdictFor(['a.pdf'], …)`, and `.fileName` assertions to `.fileNames`. Then append:

```ts
describe('verdictFor -- several files', () => {
  const hit = (attachmentNames: string[]) => ({ uuid: 'u', version: 1, name: '', attachmentNames });
  const files = ['No1.pdf', 'No2.pdf', 'No3.pdf'];

  it('near-certain when an existing item holds every file', () => {
    const v = verdictFor(files, 'Gazette, Volume 2', [hit(['no1.pdf', 'No2.pdf', 'No3.pdf', 'cover.jpg'])]);
    expect(v?.tier).toBe('near-certain');
    expect(v?.detail).toBe('an item with this title already holds all 3 of these files');
  });

  it('possible, naming held and missing, when an item holds some', () => {
    const v = verdictFor(files, 'Gazette, Volume 2', [hit(['No1.pdf'])]);
    expect(v?.tier).toBe('possible');
    expect(v?.detail).toBe(
      "an item with this title already holds 1 of these 3 files ('No1.pdf'); it does not hold 'No2.pdf', 'No3.pdf'",
    );
  });

  it('judges by the hit holding the most, not the first', () => {
    const v = verdictFor(files, 'T', [hit(['No1.pdf']), hit(files)]);
    expect(v?.tier).toBe('near-certain');
  });

  it('possible, as today, when an item holds none', () => {
    expect(verdictFor(files, 'T', [hit(['other.pdf'])])?.detail).toBe(
      'an item with this title already exists, but holds a different file',
    );
  });

  it('a single-file row reads exactly as before', () => {
    expect(verdictFor(['a.pdf'], 'T', [hit(['a.pdf'])])?.detail).toBe(
      "an item with this title already holds a file called 'a.pdf'",
    );
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/duplicates.test.ts`

- [ ] **Step 3: Implement**

In `DuplicateFinding`, replace `fileName: string` with:

```ts
  /** The row's label source: a filename or a folder name. */
  source: string;
  /** Every file the row would attach, in upload order. */
  fileNames: string[];
```

Change `verdictFor` to `(fileNames: readonly string[], title, hits): Omit<DuplicateFinding, 'rowNumber' | 'source'> | null`. Its objects carry `fileNames: [...fileNames]` in place of `fileName`. Replace the `holdsThisFile` block with:

```ts
  // The hit holding the MOST of this row's files decides. An item holding all
  // of them is this row already uploaded; one holding some is worth a look
  // but not a default skip -- skipping would leave the missing files nowhere.
  const heldBy = (h: ExistingItemHit) =>
    fileNames.filter((f) => h.attachmentNames.some((n) => sameFileName(n, f)));
  const held = matching.map(heldBy).reduce((a, b) => (b.length > a.length ? b : a), [] as string[]);
  const quote = (names: readonly string[]) => names.map((n) => `'${n}'`).join(', ');

  if (held.length === fileNames.length) {
    return {
      fileNames: [...fileNames], existing, tier: 'near-certain',
      detail: fileNames.length === 1
        ? `an item with this title already holds a file called '${fileNames[0]}'`
        : `an item with this title already holds all ${fileNames.length} of these files`,
    };
  }
  if (held.length > 0) {
    const missing = fileNames.filter((f) => !held.includes(f));
    return {
      fileNames: [...fileNames], existing, tier: 'possible',
      detail:
        `an item with this title already holds ${held.length} of these ${fileNames.length} files ` +
        `(${quote(held)}); it does not hold ${quote(missing)}`,
    };
  }
  return {
    fileNames: [...fileNames], existing, tier: 'possible',
    detail: 'an item with this title already exists, but holds a different file',
  };
```

The early `not-checkable` return also carries `fileNames`. In `findDuplicates`, every finding gets `source: entry.source, fileNames: entry.files.map((f) => f.name)`, and the call becomes `verdictFor(entry.files.map((f) => f.name), title, hits)`. This removes the Task 2 shim.

Update the readers:

- `cli/index.ts:86` and `mcp/index.ts:362`: use `${f.source}${f.fileNames.length > 1 ? ` (${f.fileNames.length} files)` : ''}`.
- `src/desktop/ui/duplicates.ts:52`: use `escapeHtml(d.source)`, and for more than one file add `<br><small>${d.fileNames.length} files</small>`.

- [ ] **Step 4: Run the checks**

Run: `npx vitest run tests/duplicates.test.ts`, then `npm run typecheck`, then `npm test`
Expected: PASS. Fix any desktop test asserting `fileName` on findings.

- [ ] **Step 5: Mutation check**

Use Edit to change `held.length === fileNames.length` to `held.length > 0`. Confirm the "holds some" test fails. Restore it.

- [ ] **Step 6: Commit**

```bash
git add -A src tests
git commit -m "feat(duplicates): all files held is near-certain, some is possible and named"
```

---

### Task 7: CLI and MCP show folder rows

**Files:**
- Modify: `src/cli/index.ts`, `src/mcp/index.ts`
- Test: `tests/cli.test.ts`, `tests/mcp.test.ts`

- [ ] **Step 1: Write the failing tests**

**`tests/cli.test.ts`:** add a plan test that follows the file's existing `planAction` test pattern with a captured console. The batch folder holds a subfolder `Gazette_V2` containing `G_No2.pdf` and `G_No1.pdf`, and a one-row sheet naming `Gazette_V2`. Assert the output contains, in order:

```text
Row 2: Gazette_V2 (2 files), in upload order:
    1. G_No1.pdf
    2. G_No2.pdf
```

**`tests/mcp.test.ts`:** do the same through the plan tool's text result, following the file's existing `oeq_plan` test.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/cli.test.ts tests/mcp.test.ts`

- [ ] **Step 3: Implement**

- In `planAction`, after `console.log(\`Planned …\`)`, add `for (const line of folderLines(manifest.entries)) console.log(\`  ${line}\`);`.
- In the MCP plan tool, push `folderLines(manifest.entries)` onto its `lines`, after the planned count, using the same indentation the tool uses for warnings.
- `status` and `retry` already use `rowLabel` (Task 2). Check the run progress line at `cli/index.ts:138` shows `rowLabel(e)`.

- [ ] **Step 4: Run the tests and confirm they pass, then commit**

Run: `npx vitest run tests/cli.test.ts tests/mcp.test.ts`

```bash
git add -A src tests
git commit -m "feat(cli,mcp): plan output lists each folder's files in upload order"
```

---

### Task 8: Desktop plan, progress and results show folder rows

**Files:**
- Modify: `src/desktop/ipc.ts`, `src/desktop/handlers.ts`, `src/desktop/ui/app.ts`, `src/desktop/ui/screens/review.ts`, `src/desktop/ui/screens/progress.ts`, `src/desktop/ui/screens/results.ts`, `src/desktop/ui/warnings.ts`
- Test: `tests/desktop/handlers.test.ts`, `tests/desktop/ui/*` (follow the existing screen-test pattern), `tests/desktop/ui/warnings.test.ts` (or wherever `categorizeWarnings` is tested)

- [ ] **Step 1: Write the failing tests**

1. **`categorizeWarnings`:**

   ```ts
   expect(categorizeWarnings(["Row 4: folder 'V3' cannot be uploaded: the folder is empty; skipped."]).refusedFolder)
     .toHaveLength(1);
   expect(categorizeWarnings(["Folder 'V9' has no matching row; not uploaded."]).unmatchedFile).toHaveLength(1);
   ```

2. **Review screen:** render with a `report` whose `folders` is
   `[{ rowNumber: 2, label: 'V2 (2 files)', files: ['No1.pdf', 'No2.pdf'], skipped: [{ name: 'Thumbs.db', reason: 'a Windows thumbnail cache' }] }]`.
   Assert the HTML contains a heading "Folders: files in upload order", an `<ol>` with `No1.pdf` before `No2.pdf`, and `Thumbs.db`. Also assert no element carries a `style` attribute.
3. **Plan handler:** after planning a sheet naming a folder, `report.folders[0].files` equals the ordered names.
4. **Progress and results:** they render `label` (e.g. `V2 (2 files)`) where they rendered `fileName`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/desktop`

- [ ] **Step 3: Implement**

**`ipc.ts`:**
- Rename `RunProgress.fileName` to `label`.
- Rename `RunReport.failures[].fileName` to `label`.
- Add to `PlanReport`:

  ```ts
  /** Each folder row's files in upload order, and what will not be uploaded. Empty for a file-only batch. */
  folders: { rowNumber: number; label: string; files: string[]; skipped: { name: string; reason: string }[] }[];
  ```

**`handlers.ts`:**
- Set the progress `label` and failures `label` from `rowLabel(entry)`.
- Build `folders` in the plan handler:

  ```ts
  folders: manifest.entries
    .filter((e) => e.folderPath !== undefined)
    .map((e) => ({ rowNumber: e.rowNumber, label: rowLabel(e), files: e.files.map((f) => f.name), skipped: e.skippedFiles ?? [] })),
  ```

**`warnings.ts`:**
- Add the `refusedFolder: string[]` bucket and `const REFUSED_FOLDER_RE = /^Row \d+: folder '.*' cannot be uploaded: .*; skipped\.$/;`.
- Test it before `MISSING_FILE_RE`.
- Update the header doc, which lists the shapes from plan.ts.

**`review.ts`:**
- Add `section('Folders that cannot be uploaded', groups.refusedFolder)` after the missing-file section.
- Add the folders block inside the Plan summary fieldset, after the item count:

  ```ts
  const foldersHtml = props.report.folders.length === 0 ? '' : `
    <div class="warning-group">
      <h3>Folders: files in upload order (${props.report.folders.length})</h3>
      <p class="note">Each folder becomes one item, its files attached in this order. To change the order, rename the files and check again.</p>
      ${props.report.folders.map((f) => `
        <details open>
          <summary>Row ${f.rowNumber}: ${escapeHtml(f.label)}</summary>
          <ol>${f.files.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ol>
          ${f.skipped.length === 0 ? '' : `<p class="note">Not uploaded: ${f.skipped.map((s) => `${escapeHtml(s.name)} (${escapeHtml(s.reason)})`).join(', ')}</p>`}
        </details>`).join('')}
    </div>`;
  ```

- Change "every row matched a file" to "every row matched a file or folder".

**`progress.ts`, `results.ts`, `app.ts`:**
- Rename the `fileName` fields to `label`: `ProgressLogEntry`, `ProgressProps`, `InterruptedEntry`, the `results.ts` failure table, and `app.ts` lines 470, 1880 and 1901.
- In `app.ts:1901`, build the interrupted list's label with `rowLabel(e)` (renderer-safe: it comes from `types.ts`).

- [ ] **Step 4: Run the checks**

Run: `npx vitest run tests/desktop`, `npm run typecheck`, `npm run build:desktop`
Expected: PASS, including `rendererPurity`.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "feat(desktop): Review lists each folder's files in upload order; labels name folder rows"
```

---

### Task 9: `each` — a column that collects one value per file

**Files:**
- Modify: `src/core/extract/types.ts`, `src/core/extract/profile.ts`
- Test: `tests/extract/profile.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('accepts "each": true on a column', () => {
  const p = parseProfile({ version: 1, pattern: '{v}', columns: [
    { path: 'attachment name', sources: [{ filename: true }], locked: true },
    { path: 'MWDL/title', sources: [{ property: 'title' }], each: true },
  ] });
  expect(p.columns[1]!.each).toBe(true);
});

it('refuses "each" on the attachment column', () => {
  expect(() => parseProfile({ version: 1, pattern: '{v}', columns: [
    { path: 'attachment name', sources: [{ filename: true }], locked: true, each: true },
  ] })).toThrow(/'attachment name'.*each/);
});
```

- [ ] **Step 2: Run them and confirm they fail.** Then implement.

**`types.ts`**, in `Column`:

```ts
  /**
   * In a row built from a folder, run this column's sources against EVERY file
   * and keep each value, in attachment order, de-duplicated, joined with
   * plan's repeated-value separator. Without it the first file to answer wins.
   * Has no effect on a row built from one file.
   */
  each?: boolean;
```

**`profile.ts`:**
- Add `each: z.boolean().optional(),` to `columnSchema`.
- Where the other per-column refusals live (near the `composeOnly` check at line 137), add:

  ```ts
    if (column.each === true && column.path === ATTACHMENT_COLUMN) {
      throw new ValidationError(
        `Column '${ATTACHMENT_COLUMN}' cannot use "each": it names the file or folder the row ` +
          `uploads, and a row names exactly one.`,
      );
    }
  ```

- [ ] **Step 3: Run the tests and confirm they pass, then commit**

Run: `npx vitest run tests/extract/profile.test.ts`

```bash
git add src/core/extract/types.ts src/core/extract/profile.ts tests/extract/profile.test.ts
git commit -m "feat(extract): column option each -- collect one value per file"
```

---

### Task 10: `buildFolderRow`

**Files:**
- Modify: `src/core/extract/rows.ts`
- Test: `tests/extract/rows.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { buildFolderRow } from '../../src/core/extract/rows.js';

const doc = (text: string, title = ''): DocumentData => ({
  text, hasTextLayer: true, properties: title ? { title } : {}, tables: [],
});
const profile = (columns: Column[], pattern = 'Gazette_V{volume}'): Profile => ({
  version: 1, pattern,
  columns: [{ path: 'attachment name', sources: [{ filename: true }], locked: true }, ...columns],
});

describe('buildFolderRow', () => {
  it('names the folder in attachment name; placeholders and filenameStem read the folder name', () => {
    const row = buildFolderRow(
      profile([
        { path: 'MWDL/title', sources: [{ join: 'Gazette, Volume {volume}' }] },
        { path: 'MWDL/identifier', sources: [{ filenameStem: true }] },
      ]),
      'Gazette_V2',
      [{ name: 'G_No1.pdf', doc: doc('x') }],
    );
    expect(row.cells['attachment name']).toBe('Gazette_V2');
    expect(row.cells['MWDL/title']).toBe('Gazette, Volume 2');
    expect(row.cells['MWDL/identifier']).toBe('Gazette_V2');
  });

  it('takes the first value found in attachment order, noting a later file', () => {
    const row = buildFolderRow(
      profile([{ path: 'MWDL/description', sources: [{ property: 'title' }] }]),
      'Gazette_V2',
      [{ name: 'G_No1.pdf', doc: doc('a') }, { name: 'G_No2.pdf', doc: doc('b', 'Spring issue') }],
    );
    expect(row.cells['MWDL/description']).toBe('Spring issue');
    expect(row.notes).toContain(
      "MWDL/description: taken from 'G_No2.pdf' -- the earlier files in this folder gave nothing",
    );
  });

  it('adds no note when the first file answers', () => {
    const row = buildFolderRow(
      profile([{ path: 'MWDL/description', sources: [{ property: 'title' }] }]),
      'Gazette_V2',
      [{ name: 'G_No1.pdf', doc: doc('a', 'Winter issue') }, { name: 'G_No2.pdf', doc: doc('b', 'Spring issue') }],
    );
    expect(row.cells['MWDL/description']).toBe('Winter issue');
    expect(row.notes).toEqual([]);
  });

  it('each: collects every file\'s value in order, de-duplicated, joined with "; ", and notes it', () => {
    const row = buildFolderRow(
      profile([{ path: 'MWDL/subjects/subject', sources: [{ property: 'title' }], each: true }]),
      'Gazette_V2',
      [
        { name: 'G_No1.pdf', doc: doc('', 'Winter') },
        { name: 'G_No2.pdf', doc: doc('', '') },
        { name: 'G_No3.pdf', doc: doc('', 'winter') },
        { name: 'G_No4.pdf', doc: doc('', 'Spring') },
      ],
    );
    expect(row.cells['MWDL/subjects/subject']).toBe('Winter; Spring');
    expect(row.notes).toContain('MWDL/subjects/subject: collected from 3 of 4 files');
  });

  it('falls back to the default only when no file answers', () => {
    const row = buildFolderRow(
      profile([{ path: 'MWDL/genre', sources: [{ property: 'subject' }], default: 'Periodical' }]),
      'Gazette_V2',
      [{ name: 'G_No1.pdf', doc: doc('') }, { name: 'G_No2.pdf', doc: doc('') }],
    );
    expect(row.cells['MWDL/genre']).toBe('Periodical');
  });

  it('names each file with no text layer', () => {
    const row = buildFolderRow(profile([]), 'Gazette_V2', [
      { name: 'G_No1.pdf', doc: { ...doc(''), hasTextLayer: false } },
    ]);
    expect(row.notes).toContain("no text layer in 'G_No1.pdf' -- nothing could be read from inside it");
  });

  it('says so when no file in the folder could be read, and still builds the row', () => {
    const row = buildFolderRow(profile([]), 'Gazette_V2', []);
    expect(row.cells['attachment name']).toBe('Gazette_V2');
    expect(row.notes).toContain(
      'no file in this folder could be read -- the row was built from the folder name alone',
    );
  });

  it('says folder name, not filename, when the pattern does not match', () => {
    const row = buildFolderRow(
      profile([{ path: 'MWDL/title', sources: [{ placeholder: 'volume' }] }]),
      'Other', [{ name: 'a.pdf', doc: doc('') }],
    );
    expect(row.notes).toContain("folder name does not match the pattern 'Gazette_V{volume}'");
  });

  it('buildRow on one file is unchanged', () => {
    // Re-run one existing buildRow assertion here, or rely on the existing
    // suite staying green. buildRow must keep every existing note's wording.
  });
});
```

Delete the placeholder-comment test in the last `it` before committing. The existing `buildRow` suite already guards that behaviour; it is listed here only as a reminder to run it.

- [ ] **Step 2: Run them and confirm they fail.** Then implement.

**Refactor `fill`** into a loop that can fail plus the default:

```ts
/** The first source that yields a value, finished; null when none did. Notes as fill always has. */
function trySources(
  column: Column,
  context: Context,
  notes: string[],
  flagged: Record<string, string>,
): { value: string; source: string } | null {
  for (const source of column.sources) {
    // ... the body of fill's existing loop, unchanged, returning { value, source: sourceKind(source) } ...
  }
  return null;
}

function fill(column: Column, context: Context, notes: string[], flagged: Record<string, string>) {
  const found = trySources(column, context, notes, flagged);
  if (found !== null) return found;
  if (column.default !== undefined) return { value: column.default, source: 'default' };
  return { value: '' };
}
```

**Folder filling:**

```ts
/** One file in a folder row, in attachment order. */
export interface FolderDoc {
  name: string;
  doc: DocumentData;
}

const EMPTY_DOC: DocumentData = { text: '', hasTextLayer: true, properties: {}, tables: [] };

function fillAcross(
  column: Column,
  contexts: { file: string; context: Context }[],
  notes: string[],
  flagged: Record<string, string>,
): { value: string; source?: string } {
  if (column.each === true) {
    const seen = new Set<string>();
    const values: string[] = [];
    let source: string | undefined;
    let answered = 0;
    for (const { context } of contexts) {
      const found = trySources(column, context, notes, flagged);
      if (found === null) continue;
      answered++;
      source ??= found.source;
      const key = found.value.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        values.push(found.value);
      }
    }
    if (values.length > 0) {
      notes.push(`${column.path}: collected from ${answered} of ${contexts.length} files`);
      return { value: values.join(`${VALUE_SEPARATOR} `), source };
    }
  } else {
    for (const [i, { file, context }] of contexts.entries()) {
      const found = trySources(column, context, notes, flagged);
      if (found === null) continue;
      if (i > 0) {
        notes.push(`${column.path}: taken from '${file}' -- the earlier files in this folder gave nothing`);
      }
      return found;
    }
  }
  if (column.default !== undefined) return { value: column.default, source: 'default' };
  return { value: '' };
}
```

Import `VALUE_SEPARATOR` from `../metadata.js`. If `rendererPurity` then fails because `metadata.ts` reaches something node-only through this import, define `const VALUE_SEPARATOR = ';'` locally instead, with a comment that it must equal `metadata.ts#VALUE_SEPARATOR`, plus a test asserting the two are equal.

**`buildFolderRow`.** Extract the shared tail of `buildRow` into one internal builder, used by both. Factor it as below; the existing `buildRow` behaviour must not change.

```ts
function build(
  profile: Profile,
  name: string,
  files: FolderDoc[],
  folder: boolean,
): ExtractedRow {
  const notes: string[] = [];
  const parts = applyPattern(profile.pattern, name);
  const usesParts = /* unchanged */;
  if (parts === null && usesParts) {
    notes.push(`${folder ? 'folder name' : 'filename'} does not match the pattern '${profile.pattern}'`);
  }

  if (folder && files.length === 0) {
    notes.push('no file in this folder could be read -- the row was built from the folder name alone');
  }
  const effective = files.length > 0 ? files : [{ name, doc: EMPTY_DOC }];
  for (const f of effective) {
    if (!f.doc.hasTextLayer) {
      notes.push(folder
        ? `no text layer in '${f.name}' -- nothing could be read from inside it`
        : 'no text layer -- nothing could be read from inside this file');
    }
  }

  const composed: Record<string, string> = {};
  const contexts = effective.map((f) => ({
    file: f.name,
    // `filename` is the ROW's name -- the folder's, for a folder row -- so every
    // filename-reading source reads it, whichever file's context is in use.
    context: { filename: name, parts, labels: findLabels(f.doc.text), doc: f.doc, composed } as Context,
  }));
  // ... the two passes, as before, but calling fillAcross(column, contexts, notes, flagged)
  //     in place of fill(column, context, notes, flagged). With one context and no
  //     `each`, fillAcross is exactly fill. Every context shares ONE `composed` object,
  //     so the second pass reads the first pass's values from any of them.
  // ... flagIfEmpty unchanged ...
  // ... filenameWordsInText: missingFilenameWords(name, effective.map((f) => f.doc.text).join('\n'), ignore),
  //     with the note saying "this folder name" in place of "this filename" when folder ...
  return { cells, sources, notes, flagged, aiWritten: {} };
}

export function buildRow(profile: Profile, filename: string, doc: DocumentData): ExtractedRow {
  return build(profile, filename, [{ name: filename, doc }], false);
}

/**
 * One row for a folder whose files become one item's attachments. `docs` are
 * the files that could be read, in attachment order (folderFiles.ts#orderFiles).
 * Filename-reading sources read the FOLDER name; document sources try each
 * file in turn and the first answer wins, unless the column says `each`.
 */
export function buildFolderRow(profile: Profile, folderName: string, docs: readonly FolderDoc[]): ExtractedRow {
  return build(profile, folderName, [...docs], true);
}
```

When implementing, write the two passes out in full. Do **not** leave the comments above as the code. Keep every existing comment in `buildRow` attached to the code it explains.

- [ ] **Step 3: Run the checks**

Run: `npx vitest run tests/extract`, then `npm test`
Expected: every new test passes and every existing extract test passes unchanged.

- [ ] **Step 4: Mutation checks**

Make each change with Edit, confirm the named test fails, then restore it:

1. Remove `if (!seen.has(key))`. The each test fails ("Winter; winter").
2. Remove the `if (i > 0)` note. The later-file test fails.

- [ ] **Step 5: Commit**

```bash
git add src/core/extract/rows.ts tests/extract/rows.test.ts
git commit -m "feat(extract): buildFolderRow -- one row per folder, first answer wins or each collects"
```

---

### Task 11: `listSubfolders` / `extractFolders`, and the model pass's folder-row note

**Files:**
- Modify: `src/core/extract/extract.ts`, `src/core/ai/fill.ts`
- Test: `tests/extract/extract.test.ts`, `tests/ai/fill.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('extractFolders', () => {
  it('builds one row per subfolder, in natural order, reading files in attachment order', async () => {
    // dir/Gazette_V10/{a.pdf}, dir/Gazette_V2/{b.pdf, a.pdf}, dir/loose.pdf, dir/Gazette_V3/ (empty)
    // with a fake reader that returns doc(name) and records call order
    const calls: string[] = [];
    const reader = async (p: string) => { calls.push(basename(p)); return doc(basename(p)); };
    const result = await extractFolders(dir, profile, { reader });
    expect(result.rows.map((r) => r.cells['attachment name'])).toEqual(['Gazette_V2', 'Gazette_V10']);
    expect(calls).toEqual(['a.pdf', 'b.pdf', 'a.pdf']);
    expect(result.skipped).toEqual([
      { file: 'loose.pdf', reason: 'a file directly in the chosen folder -- with one row per subfolder, only subfolders become rows' },
      { file: 'Gazette_V3', reason: 'the folder is empty' },
    ]);
  });

  it('keeps an unreadable file as an attachment and notes it on the row', async () => {
    // reader throws for 'bad.pdf'
    // row exists; notes contain "'bad.pdf' could not be read (boom); it is still uploaded with the others"
  });

  it('reads only supported files; an unsupported file is still an attachment and not refused', async () => {
    // Gazette_V2/{a.pdf, cover.jpg}: reader called for a.pdf only; row built; skipped is empty
  });
});
```

Write the two sketched tests out fully, following the file's existing temp-folder pattern. In `tests/ai/fill.test.ts`:

```ts
it("notes a folder row's model column instead of leaving it silently blank", () => {
  const rows = [row({ 'MWDL/description': '' })];
  noteMissingModel(rows, profileWithAiOn('MWDL/description'), 'folder-row');
  expect(rows[0]!.notes).toContain(
    'MWDL/description: not sent to the model -- rows built from a folder are not supported by the model pass yet',
  );
});
```

Use the file's existing row/profile builders.

- [ ] **Step 2: Run them and confirm they fail.** Then implement.

**`fill.ts`:** add `'folder-row'` to `MissingModelReason`, and to `MISSING_MODEL`:

```ts
  'folder-row':
    'not sent to the model -- rows built from a folder are not supported by the model pass yet',
```

Extend the docblock with a line on why: `verify.ts` checks a value against ONE document, and which document that is for a volume is a separate design.

**`extract.ts`:**

```ts
export interface SubfolderListing {
  /** Each subfolder that can become a row, in natural order. */
  folders: { name: string; files: string[]; readable: string[] }[];
  /** Loose files and refused subfolders, with reasons. */
  skipped: { file: string; reason: string }[];
}

export async function listSubfolders(dir: string): Promise<SubfolderListing> {
  const entries = await readdir(dir, { withFileTypes: true });
  const skipped: SubfolderListing['skipped'] = [];
  for (const e of entries) {
    if (e.isFile() && clutterReason(e.name) === null) {
      skipped.push({
        file: e.name,
        reason: 'a file directly in the chosen folder -- with one row per subfolder, only subfolders become rows',
      });
    }
  }
  const folders: SubfolderListing['folders'] = [];
  for (const name of orderFiles(entries.filter((e) => e.isDirectory() && clutterReason(e.name) === null).map((e) => e.name))) {
    const listing = await listFolderFiles(join(dir, name));
    if (listing.refusal !== undefined) {
      skipped.push({ file: name, reason: listing.refusal });
      continue;
    }
    const files = listing.files.map((f) => f.name);
    folders.push({ name, files, readable: files.filter(isSupported) });
  }
  return { folders, skipped };
}

/**
 * One row per subfolder of `dir`. The files of a subfolder become ONE item's
 * attachments at upload, so a file the readers cannot open is still part of
 * that item: it is noted on the row, never dropped, and never refuses it.
 */
export async function extractFolders(
  dir: string,
  profile: Profile,
  options: Omit<ExtractOptions, 'onRow' | 'listing'> & { listing?: SubfolderListing } = {},
): Promise<ExtractResult> {
  const { reader = readDocument, onProgress, signal } = options;
  const found = options.listing ?? (await listSubfolders(dir));
  const skipped = [...found.skipped];
  const rows: ExtractedRow[] = [];
  let done = 0;
  for (const folder of found.folders) {
    if (signal?.aborted) break;
    const docs: FolderDoc[] = [];
    const unreadable: string[] = [];
    for (const name of folder.readable) {
      try {
        docs.push({ name, doc: await reader(join(dir, folder.name, name)) });
      } catch (error) {
        unreadable.push(`'${name}' could not be read (${(error as Error).message}); it is still uploaded with the others`);
      }
    }
    const row = buildFolderRow(profile, folder.name, docs);
    row.notes.push(...unreadable);
    rows.push(row);
    done += 1;
    onProgress?.(done, found.folders.length);
  }
  return { rows, skipped };
}
```

**No `onRow` hook:** the model pass does not run on folder rows. Callers use `noteMissingModel(…, 'folder-row')` instead (Tasks 12–13).

- [ ] **Step 3: Run the checks, then commit**

Run: `npx vitest run tests/extract tests/ai`

```bash
git add -A src tests
git commit -m "feat(extract): extractFolders -- one row per subfolder; model pass notes folder rows"
```

---

### Task 12: `oeq-upload extract --per-folder`

**Files:**
- Modify: `src/cli/index.ts` (option), `src/cli/extract.ts`
- Test: `tests/extract/cli-extract.test.ts`

- [ ] **Step 1: Write the failing tests**

1. `--per-folder` on a folder holding `Gazette_V1/a.pdf` and `Gazette_V2/b.pdf` writes a CSV whose `attachment name` column is `Gazette_V1`, `Gazette_V2`.
2. `--per-folder --ai` throws `ValidationError` matching `/--ai cannot be used with --per-folder/`, before any file is read (reader spy not called).
3. `--per-folder` with a profile that has an `{ ai: true }` column, no `--ai`, writes the folder-row note into `_notes` for that column, and **not** the "--ai was not given" note.
4. `--init-profile --per-folder` builds the starter from documents sampled across the subfolders, and its `attachment name` column still reads `{ filename: true }`.

- [ ] **Step 2: Run them and confirm they fail.** Then implement.

**`index.ts`:**

```ts
    .option('--per-folder', 'one row per subfolder: each subfolder becomes one item, its files the attachments')
```

**`ExtractCliOptions`:** add `perFolder?: boolean`.

**`runExtract`:**
- **Right after loading the profile and before any listing**, refuse `--ai`:

  ```ts
  if (options.perFolder === true && options.ai === true) {
    throw new ValidationError(
      `--ai cannot be used with --per-folder: the model pass checks what it writes against ONE ` +
        `document, and a row built from a folder has several. Drop --ai; the model columns will ` +
        `say why they are empty.`,
    );
  }
  ```

- When `perFolder` is set, skip the model branch entirely. Run `extractFolders(options.dir, profile)`, then `if (wantsModel) noteMissingModel(result.rows, profile, 'folder-row')`, then the existing skipped/dry-run/write tail.
- The skipped log prints `file` and `reason` exactly as now.
- For `--init-profile --per-folder`, feed `scanEvidence` the first readable files across the subfolders. Read the current `--init-profile` code at `cli/extract.ts:270-292` and pass it the list `listing.folders.flatMap((f) => f.readable.map((n) => join(f.name, n)))`, which keeps relative paths under `dir`. Then make sure `starterProfile` is given folder names as the "filenames" it infers a pattern from: `listing.folders.map((f) => f.name)`.
- Help text: describe `--per-folder` in the command description too.

- [ ] **Step 3: Run the checks, then commit**

Run: `npx vitest run tests/extract/cli-extract.test.ts`, then `npm test`

```bash
git add -A src tests
git commit -m "feat(cli): extract --per-folder builds one row per subfolder"
```

---

### Task 13: Desktop extract — "One row per subfolder"

**Files:**
- Modify: `src/desktop/ipc.ts`, `src/desktop/extractHandlers.ts`, `src/desktop/ui/extract/state.ts`, `src/desktop/ui/extract/controller.ts`, `src/desktop/ui/screens/extractFolder.ts`
- Test: `tests/desktop/extractHandlers.test.ts`, `tests/desktop/ui/` extract screen and controller tests

- [ ] **Step 1: Write the failing tests**

1. **`extractScan(dir, instanceId, true)`:** `supported` lists subfolder names in natural order. `skipped` carries loose files and refused folders. `perFolder` is `true` on the result.
2. **`extractPreview({ dir, profile, perFolder: true })`:** returns rows whose `attachment name` cells are folder names.
3. **`extractRun({ …, perFolder: true, modelApproved: true })`:**
   - makes **no** fetch (inject `fetchImpl` as a spy; assert not called) even with a model configured;
   - writes the folder-row note for an `ai` column;
   - writes one CSV row per subfolder.
4. **The folder screen** renders a checkbox `#extract-per-folder` labelled "One row per subfolder", checked when `perFolder`. Its `change` event calls `onPerFolderChange(true)`. With `perFolder`, the summary reads "N folder(s) will become items".
5. **The controller:** toggling rescans with `perFolder`, and `approveModelRun` is not consulted (no confirmation shown) when `perFolder` is on.

- [ ] **Step 2: Run them and confirm they fail.** Then implement.

**`ipc.ts`:**
- Change `extractScan(dir, instanceId?, perFolder?: boolean)`.
- Add `perFolder?: boolean` to the `extractPreview` and `extractRun` args.
- Add `ExtractScan.perFolder?: boolean`, and document that with it set, `supported` holds folder names.
- Update the preload bridge wherever the channel arguments are forwarded. Find it with `grep -rn "extractScan" src/desktop`.

**`extractHandlers.ts`:**
- Make the cache key `${dir}\u0000${perFolder}`.
- `sample(dir, perFolder)`: for `perFolder`, call `listSubfolders(dir)`. For each of the first `PREVIEW_ROWS` folders, read its readable files into `FolderDoc[]`, skipping unreadable ones as the file sample already does. Store `{ folders: { name, docs }[] }` plus a flat `docs` list for `evidenceFrom`.
- Scan:
  - `supported = listing.folders.map((f) => f.name)`.
  - `skipped = listing.skipped`.
  - The starter comes from `starterProfile(folderNames, schema, evidence)`, which is the folder-name pattern inference.
  - Return `perFolder: true`.
- Preview: `buildFolderRow(profile, f.name, f.docs)` for each sampled folder.
- Run, when `perFolder`:

  ```ts
      if (args.perFolder === true) {
        const result = await extractFolders(args.dir, args.profile);
        // NO MODEL, whatever was approved. See core/ai/fill.ts 'folder-row'.
        if (modelColumns(args.profile).length > 0) noteMissingModel(result.rows, args.profile, 'folder-row');
        await writeCsv(args.outPath, args.profile, result.rows);
        return { outPath: args.outPath, written: result.rows.length, flagged: countNeedingReview(result.rows), aiWritten: 0 };
      }
  ```

  Place this before `settings` is resolved, so no endpoint is read.

**`state.ts`:** add `perFolder: boolean` (default `false`).

**`controller.ts`:**
- Choosing a folder or toggling calls `extractScan(dir, instanceId, state.perFolder)`.
- Preview and run pass `perFolder`.
- The model-approval step returns "no model" without asking when `state.perFolder`.

**`extractFolder.ts`:**
- Add the props `perFolder: boolean` and `onPerFolderChange(on: boolean): void`.
- After the template field (only when a folder is chosen), add:

  ```html
  <div class="field">
    <label><input type="checkbox" id="extract-per-folder" ${props.perFolder ? 'checked' : ''} ${props.busy ? 'disabled' : ''}>
      One row per subfolder</label>
    <p class="hint">Each subfolder becomes one item, with every file in it attached in name order.
      Use this for a journal kept as one folder per volume.</p>
  </div>
  ```

- Wire `change`. It needs no `keepCaret` (a checkbox fires `change`, not `input`, and the `checked` attribute restores it). Say so in a comment, as the select's comment does.
- Make the summary wording conditional:
  - "folder(s) will become items" versus "file(s) can be read";
  - the empty-state error: "No subfolder here can become an item." versus the existing line.

- [ ] **Step 3: Run the checks**

Run: `npx vitest run tests/desktop`, `npm run typecheck`, `npm run build:desktop`
Expected: PASS, including `rendererPurity`. `extractFolder.ts` must import nothing new from core beyond types.

- [ ] **Step 4: Commit**

```bash
git add -A src tests
git commit -m "feat(desktop): extract toggle -- one row per subfolder"
```

---

### Task 14: The Snake River Echoes template

**Files:**
- Create: `templates/snake-river-echoes.profile.json`
- Test: `tests/extract/templates.test.ts` (existing tests load every template; add an assertion for this one)

- [ ] **Step 1: Write the failing test**

```ts
it('ships the Snake River Echoes template, which builds a title from the volume folder name', async () => {
  const p = await loadTemplate('snake-river-echoes', TEMPLATES_DIR);
  const row = buildFolderRow(p, 'SRE_Vol10', [{ name: 'SRE_1981_Vol10_No1.pdf', doc: { text: '', hasTextLayer: true, properties: {}, tables: [] } }]);
  expect(row.cells['MWDL/title']).toBe('Snake River Echoes, Volume 10');
  expect(row.cells['attachment name']).toBe('SRE_Vol10');
});
```

- [ ] **Step 2: Run it and confirm it fails.** Then create the template.

```json
{
  "version": 1,
  "pattern": "SRE_Vol{volume}",
  "columns": [
    { "path": "attachment name", "sources": [{ "filename": true }], "locked": true },
    { "path": "MWDL/identifier", "sources": [{ "filename": true }] },
    { "path": "MWDL/title", "sources": [{ "join": "Snake River Echoes, Volume {volume}" }, { "filenameStem": true }] },
    { "path": "MWDL/genres/genre", "sources": [], "default": "Periodical" },
    { "path": "MWDL/conversionSpecifications", "sources": [], "default": "Scanned to PDF" },
    { "path": "MWDL/source", "sources": [], "default": "None" },
    { "path": "BYUI_extended/byui_rights/restrict_to_byui", "sources": [], "default": "Public" }
  ]
}
```

**The constants are a cataloguing decision.** The genre, rights and source values above copy the shape of the obituary template and are **proposals**. Task 16 has the operator confirm or change them before the live run. Every path must exist in `schema/_entity.xml`; `parseProfile` plus the schema check will say if one does not.

- [ ] **Step 3: Run the checks, then commit**

Run: `npx vitest run tests/extract/templates.test.ts`

```bash
git add templates/snake-river-echoes.profile.json tests/extract/templates.test.ts
git commit -m "feat(templates): Snake River Echoes -- one item per volume folder"
```

---

### Task 15: Documentation

**Files:**
- Modify: `README.md`, `docs/INSTALL.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-11-13-multi-file-items-design.md`, `docs/SESSION-HANDOFF.md`

- [ ] **Step 1: README.** Add a section **"Several files on one contribution"** after the section that describes the spreadsheet. It must say:
  - Put each contribution's files in their own subfolder of the batch folder, and name that subfolder in `attachment name`. Every file in it is attached, in name order.
  - **The order rule** in one sentence, then three examples in a table from the SRE naming pattern:
    - `No9` before `No10`;
    - a `1972-73` issue sorting **first**;
    - `Commemorative` sorting before `Vol27_No1`.

    The remedy is to rename the file. The plan prints each folder's order so you can check it before anything is uploaded.
  - Clutter (`Thumbs.db`, `desktop.ini`, `.DS_Store`, hidden and `~$` files) is skipped and named. A folder inside a folder, or an empty folder, refuses that row.
  - **Do not change a folder between plan and run.** The run re-checks names and sizes, and refuses the row with "the folder changed since planning … plan again".
  - Duplicates: all files held means skipped by default; some held means flagged, naming which are held.
  - `extract --per-folder` and the desktop toggle; `each`; the model pass does not fill folder rows yet.
  - A worked example with the SRE layout: folder names and file order only, no contents.

  Also rewrite the "strict 1:1" claim near the top: one row makes one contribution, holding one file, or every file in one folder.

- [ ] **Step 2: `docs/INSTALL.md`.** Add a staff-facing "Uploading a folder as one item" procedure:
  1. One folder per item.
  2. Name files so they sort in the order you want, including leading words like "Commemorative".
  3. Build the spreadsheet with "One row per subfolder".
  4. On Review, read "Folders: files in upload order" for every folder before continuing.
  5. Do not touch the folders until the run finishes.

- [ ] **Step 3: CLAUDE.md.**
  - Replace "One file becomes one attachment on one contribution — a strict 1:1 relationship" with the row-to-contribution statement.
  - Add `folderFiles.ts` and `folderReport.ts` to the layout block.
  - Add a key domain fact: one staging area with N attachments is accepted, order is preserved, and client uuids are honoured (proven 2026-11-11). Include the orderFiles caveat (hyphenated year range).
  - Add a status line naming the branch and the state.

- [ ] **Step 4: Spec.** Correct the Vol 2 bullet: it sorts **first**, and is a renaming case like Vol 27. Note the v1-size decision: absent, never read at load.

- [ ] **Step 5: Handoff.** Add a "State on <date>" section covering:
  - what is built;
  - the live check still to do;
  - the operator's renaming list: Vol 2, Vol 3 (`Vol2_No4`, `Num3`), Vol 27;
  - the template constants awaiting confirmation.

- [ ] **Step 6: Commit**

```bash
git add README.md docs CLAUDE.md
git commit -m "docs: several files on one contribution"
```

---

### Task 16: Verification, live check, release prep

- [ ] **Step 1: Run the whole suite and build**

Run: `npm run typecheck`, `npm test`, `npm run build:desktop`
Expected: all clean. Record the test count for CLAUDE.md.

- [ ] **Step 2: Review the branch.** Run `/code-review` at high effort on the branch diff. Fix what it confirms, and grep for the class of each finding, not just the named line.

- [ ] **Step 3: Live check (operator present).** On `content-test`, through the desktop app:
  1. Extract `SRE_Vol2` alone with "One row per subfolder" and the template.
  2. Plan it, and read the folder order on Review. It shows `SRE_1972-73_Vol2_No3.pdf` first unless the operator has renamed it.
  3. Run as **draft**.
  4. The operator confirms in openEQUELLA that the attachments are in order and that each issue opens.

  Ask before running; this creates a real item.

- [ ] **Step 4: Dry-run plan of all 38 volumes.** Run the CLI `plan` against the full SRE folder with the extracted spreadsheet, and write the manifest to the scratchpad. Hand the operator the folder listing to review the order. **Do not run it.**

- [ ] **Step 5: Push and PR.** Push `feature/multi-file-items` and open a PR. Its body:
  - the design link;
  - what changed per layer;
  - the manifest v2 compatibility note;
  - the verification evidence.

  It must not quote any document content. Read the automated review comments before merging.

- [ ] **Step 6: Release v1.3.0, after the merge, with operator approval.** Bump `package.json` to `1.3.0`, then tag `v1.3.0` and push the tag. The release notes say:
  - this is the first release carrying Electron 44;
  - it adds folder contributions;
  - manifests from earlier versions still resume.

---

## Self-review

- **Spec coverage:**

  | Spec section | Tasks |
  | --- | --- |
  | §1 Plan | 1, 3 |
  | §2 Manifest | 2 |
  | §3 Run | 4, 5 |
  | §4 Duplicates | 6 |
  | §5 Extractor | 9–14 |
  | §6 Surfaces | 2, 6, 7, 8, 13 |
  | §7 Docs | 15, 16 |
  | §8 Verification | every task's mutation step, and 16 |

  The out-of-scope items are untouched.
- **Deliberate deviations from the spec:**
  - v1 sizes are absent rather than "read at load". Reading them would make the check vacuous, and the spec's own words say the check is skipped.
  - Vol 2's order is corrected.
  - Task 2 adds `folderPath` and `skippedFiles` to the entry, which the spec implied ("re-checked against the plan", "the plan lists skipped names") without naming them.
- **Type consistency:**
  - `ManifestFile {path, name, size?}`, `rowLabel`, `UploadUnit`, `uploadFiles` and `checkUnchanged` are used the same way in Tasks 2, 4 and 5.
  - `verdictFor(fileNames, title, hits)` and `DuplicateFinding.source` / `fileNames` are used the same way in Tasks 6, 7 and 8.
  - `FolderDoc`, `buildFolderRow`, `listSubfolders`, `extractFolders` and `'folder-row'` are used the same way in Tasks 10–13.
  - IPC `label` is used the same way in Task 8.
