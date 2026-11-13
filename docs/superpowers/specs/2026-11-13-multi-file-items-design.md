# Several files on one contribution — design

Approved by the operator 2026-11-13. Branch `feature/multi-file-items`.

## Why

The tool makes one contribution per file. *Snake River Echoes*, a historical
journal, is 103 issue PDFs (1.8 GB) in 38 volume folders, and the operator wants
**one contribution per volume, holding its issues in order** — 38 items, not 103.

Proven live before design (2026-11-11, content-test, confirmed by the operator in
openEQUELLA's own interface): one staging area, several `PUT`s, one
`POST /api/item` with N attachments is accepted; **attachments are kept in the
order sent**; client-supplied attachment uuids are honoured; each opens.

## Decisions (the operator's)

| Question | Decision |
| --- | --- |
| How a row names a folder | The existing `attachment name` column may name a **subfolder** of the batch folder. No new column. |
| Order within a folder | Natural sort ignoring punctuation, shown in the plan; wrong order is fixed by renaming files. |
| What counts as contents | Every file, any type. Known clutter skipped and named. A nested folder or an empty folder **refuses the row**. |
| Duplicates | Existing item holds ALL files: near-certain, default skip. SOME: possible, default upload, reason names held and missing files. NONE: possible, as today. |
| Extractor | Full extraction, one row per subfolder. Each column takes the first value found across the folder's files in attachment order; a column may instead collect one value from every file. |

## The data the batch actually holds

Measured 2026-11-13. Every case below is a test case.

- Vol 2: `SRE_1972-73_Vol2_No3.pdf` sorts **before** `SRE_1972_Vol2_No1.pdf` in
  plain name order (`-` < `_`). Ignoring punctuation puts it last, correctly.
- Vol 3: six files, including a 1973 `Vol2_No4` filed there and a second, different
  third issue named `Num3`. Sorting cannot judge these; the plan must show them.
- Vol 4: `No2&3` — `&` in a filename that goes into a staging URL path.
- Vol 27: `Commemorative` sorts before `No1`. A human call.
- Vols 16–20, 38: a single file. No nested folders, no non-PDFs anywhere.
- Every PDF tried has an OCR text layer; the `title` property is good on some
  issues and `Untitled` on others.

## 1. Plan (`plan.ts`)

- `attachment name` resolves against the batch folder: a file is one attachment,
  as today; a directory is a folder row.
- **One ordering function**, `orderFiles(names)` in a new `src/core/folderFiles.ts`:
  `Intl.Collator('en', { numeric: true, sensitivity: 'base', ignorePunctuation: true })`,
  ties broken by plain code-unit comparison so the order is total and stable.
  Used by plan and extractor alike.
- **One listing function**, `listFolderFiles(dir)` in the same module, returning
  `{ files: {name, size}[], skipped: {name, reason}[], refusal?: string }`:
  - clutter skipped and named: `Thumbs.db`, `desktop.ini`, `.DS_Store`, any name
    beginning `.` or `~$` (case-insensitive for the fixed names);
  - any subdirectory: refusal naming it;
  - no files left: refusal "the folder is empty" (or "holds only skipped files").
- A refused folder row is skipped with its reason as a plan warning, like a
  missing file today; it is never planned with fewer files than the folder holds.
- The plan output lists, per folder row, its files **in upload order** and any
  skipped names.

## 2. Manifest (`types.ts`, `state.ts`)

- `ManifestEntry` replaces `filePath`/`fileName` with
  `files: { path: string; name: string; size: number }[]` and adds
  `source: string` (what `attachment name` said: a filename or folder name — the
  row's display label). `attachmentUuid` becomes `attachmentUuids: string[]`.
- `Manifest.version` becomes `2`. **A v1 manifest loads**: each entry maps to a
  one-element `files` list (size read at load, as v1 did not record it — a v1
  row's size check is skipped, and the code says so), `source` = `fileName`,
  `attachmentUuids` = `[attachmentUuid]` when present. Saved back as v2.
- Single-file rows plan as one-element lists; there is one code path.

## 3. Run (`upload.ts`, `runner.ts`)

- **Before anything is created**, the row's files are re-checked against the
  plan: same names, each present, same size. Any difference fails the row:
  *"the folder changed since planning (…); plan again"*. A 0-byte file fails the
  row here too, per file, naming it.
- One staging area per row; files uploaded **in manifest order**.
- **A 401 mid-row deletes the staging area and restarts the whole row once**
  (today's single-file recovery, widened); a second 401 propagates.
- `createItem` sends N attachments `{ type: 'file', filename, description: filename, uuid }`
  in order, each with a client uuid. With `attachmentUuidPath` set it receives all
  N uuids. The returned-uuid check compares **position by position** where the
  server returns them (it currently returns none — Location-only — as today).
- Staging `PUT` paths are percent-encoded per segment; a test pins `&`, `#`, `%`,
  space and `?` in a filename.
- `rowContext` and every error name the row by `source`, with a file count.
- Interrupted rows (`'uploading'` at load) are skipped unless forced, unchanged.

## 4. Duplicates (`duplicates.ts`)

`verdictFor(fileNames: string[], title, hits)`. Title matching is unchanged.
Against the matching hits:

- some hit holds **every** file → `near-certain`, default skip;
- some hit holds **some** → `possible`, default upload, detail names the files held
  and the files missing;
- otherwise → `possible`, as today.

A single-file row behaves exactly as today. `DuplicateFinding.fileName` becomes
`source` plus `fileNames`.

## 5. Extractor (`src/core/extract/`)

- **Switch:** `extract --per-folder` (CLI) and a "One row per subfolder" toggle on
  the desktop scan screen. Never inferred from what the folder contains.
- Per-folder listing uses `listFolderFiles` on each subfolder; a refused or empty
  subfolder is reported in `skipped` with its reason. Only files a reader supports
  are read; the rest are still attachments and are not refused.
- Each row: `attachment name` = folder name. **Pattern placeholders and
  `filenameStem` read the folder name.**
- Document sources are tried against each file in attachment order; **the first
  value found wins**. A value from any file but the first gets a `_notes` entry
  naming the file it came from.
- New column option **`"each": true`**: the column's sources run against every
  file and the values are collected in order, de-duplicated, and joined with the
  repeated-value separator `plan` already splits on. The cell is noted
  ("collected from N files").
- `resolve()` stays synchronous and the extractor stays offline.
- **The model pass does not run on folder rows in this release.** `verify.ts`
  checks a value against one document, and which document that is for a volume is
  a separate design. A folder row's `{ ai: true }` cell is noted
  *"not sent to the model — rows built from a folder are not supported by the
  model pass yet"*, never left silently blank.
- A template, `templates/snake-river-echoes.profile.json`: configuration only.

## 6. Surfaces

CLI `plan`/`run`/`status`/`retry`, the MCP tools, and the desktop Plan, Progress
and Results screens show `source (N files)` where they show a filename now, with
the file list available. No `style` attributes (CSP); `keepCaret` on any new input.

## 7. Documentation

- README: new section **"Several files on one contribution"**, with this batch as
  the worked example (folder names and file order only); the "strict 1:1" claim is
  rewritten.
- `docs/INSTALL.md`: staff steps — naming files for order, reading the plan's file
  list, per-folder extraction.
- CLAUDE.md: the 1:1 statement and the layout entry for `folderFiles.ts`.
- Release v1.3.0 (also the first release carrying Electron 44).

## 8. Verification

- TDD throughout; mutation-check the guards (folder-changed, nested refusal,
  all/some duplicate split, order function) with the Edit tool (CRLF).
- Typecheck, full suite, `build:desktop`, renderer purity.
- **Live:** Vol 2 to content-test as a draft through the desktop app; the operator
  checks order and that each issue opens. Then a dry-run `plan` of all 38 volumes
  for the operator to review file order before any real upload.

## Out of scope

The model pass on folder rows; reordering files without renaming; nested folders;
the HTML index item for the journal.
