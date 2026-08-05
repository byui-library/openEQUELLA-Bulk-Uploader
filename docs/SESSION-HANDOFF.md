# Session handoff — updated 2026-08-05

Read this first.

## START HERE

1. `npm install && npm test` — expect **522 passing across 47 files** (389 from
   the desktop GUI plus the metadata extractor's own tests, added since).
2. Task 9 (packaging) and Task 10 (verification) from the desktop plan.

Sign-in is confirmed working on **both** instances; there is no open loop.

## Where the project is

**The CLI is finished and has run in production.** On 2026-08-04 it contributed
37 jury videos to BYU-Idaho Faculty Content on `content.byui.edu` — every one
verified by reading it back from the API and comparing md5, size, filename,
attachment count, draft state and the attachment uuid in metadata against the
source file on disk. 5.68 GB in 6.1 minutes, zero failures. A full rehearsal on
`content-test` beforehand was identical and was purged afterwards.

**Active work is a desktop GUI** — an Electron app for non-technical Windows
staff, reusing `src/core/` unchanged.

- Branch: **`feature/desktop-gui`** (pushed)
- The CLI lives on `feature/bulk-uploader`; `main` holds only initial scaffolding
- Design: [superpowers/specs/2026-08-04-desktop-gui-design.md](superpowers/specs/2026-08-04-desktop-gui-design.md)
- Plan: [superpowers/plans/2026-08-04-desktop-gui.md](superpowers/plans/2026-08-04-desktop-gui.md)
- **Tasks 1–8 of 10 done. 389 tests across 32 files as of that work** (the repo
  total is now 522 across 47 files — see the metadata extractor below).

Built so far: Electron scaffolding with a fully sandboxed renderer,
per-instance encrypted credential/token storage, a typed IPC contract, session
assembly, embedded sign-in, IPC handlers over the existing core, and all seven
screens (Setup, Sign-in, Choose, Review, Confirm, Progress, Results).

Remaining: **Task 9** (packaging + `docs/INSTALL.md`), **Task 10**
(verification including a clean-machine test).

```text
npm test            522 tests, 47 files
npm run typecheck   clean
npm run build       CLI + MCP -> dist/
npm run build:desktop  Electron -> dist-desktop/
npm run desktop     build then launch
npm run dist        electron-builder -> release/
```

**Metadata extractor, stage 1 (core + CLI) is complete** on
`feature/metadata-extractor`. `oeq-upload extract` builds a spreadsheet from a
folder of PDFs and `.docx` files, driven by a profile. Stage 2 (desktop screens)
and stage 3 (MCP tools) are specified but not planned; write their plans from
[the design doc](superpowers/specs/2026-08-05-metadata-extractor-design.md)
once this has been run against a real folder.

**Not yet run against real material.** Before trusting it on a batch, point it
at a folder of genuine files with `--dry-run` and read the `_notes` column.

**Tried against real material, three times.** Nine PDFs; the same PDFs renamed
to a convention; then 59 real Word documents. Every trial found something the
generated fixtures could not — PDF-syntax dates, a UTC day-shift, and compact
filename dates — all fixed. The final run produced 59 rows with nothing
flagged. The lesson worth keeping: the fixtures were *correct* but incomplete,
and each gap was a thing every real file has and no fixture had.

**Known gap, deliberately deferred: metadata held in Word tables.** Those 59
documents keep their fields in a table, so the text extracts as `Company` then
`HCA` on separate lines. Label matching only understands `Label: value` with a
colon, so it found nothing in any of them — everything usable came from the
filename and the document properties. Supporting "this line labels the next"
would open up the document body. Decided against building it before the
desktop stage, on the grounds that these files may not represent a real upload
batch. Ask the operator before investing in it.

Two decisions deferred to the operator, neither blocking:

- **`pdfjs-dist` adds ~35 MB to the installer**, which is distributed over a
  network share. Only `legacy/build` is used, so electron-builder `files`
  exclusions may be able to trim it. Untested -- needs a real packaged build
  to verify, which is why it was not attempted mid-implementation.
- **Values beginning with `=` `+` `-` `@` become formulas when the CSV is
  opened in Excel.** Documented rather than sanitised, because escaping them
  would corrupt the value for upload.

## Sign-in — RESOLVED on both instances

Production sign-in was verified live, twice. **Test sign-in was confirmed
working by the operator on 2026-08-05**, after the two fixes below. No open
loop remains here.

Two causes were found and fixed:

1. Selecting Test sent **production's** client ID — credentials were stored
   globally when they are per-instance. Fixed in `f31505b`: `SecretStore` is now
   keyed by instance.
2. With the right client, openEQUELLA still refused: `redirect_uri` was
   hard-coded as `https://content-test.byui.edu/` (**with** slash), correct for
   the old shared client but evidently not the operator's new dedicated one.
   Fixed in `2aa1cc9`: **the redirect URI is now per-instance stored
   configuration**, editable in Setup, defaulting to the base URL with no
   trailing slash.

**Never hard-code a redirect URI again.** It has been guessed wrong twice. An
administrator registers it per OAuth client and it is not derivable — production
has no trailing slash, the old shared test client had one.

Also in `2aa1cc9`: sign-in failures now read openEQUELLA's own error page and
surface its "Problem description" rather than reporting `ERR_FAILED (-2)`. A
transport error was being shown while the server had rendered a clear
explanation.

Both instances now sign in successfully. The redirect URI being editable in
Setup is what makes this survivable — an administrator can register a client
with either form and nobody needs a code change.

## OAuth clients in play

| client | instance | notes |
| --- | --- | --- |
| `765ee6ab-…` | both | openEQUELLA Sync's. Works, but couples this tool to another application's redirect, secret rotation and ACLs. |
| `f7bc0b38-…` | production | dedicated to this tool. Redirect registered **without** trailing slash. |
| `165e12ca-…` | test | dedicated to this tool. Redirect form unconfirmed. |

Credentials live in the gitignored `.env` (production) and `.env.test` (test)
for CLI use. **The desktop app reads neither** — it keeps its own encrypted
per-instance store under the app's userData directory.

## Environment

```text
OEQ_BASE_URL=https://content.byui.edu           # or content-test
OEQ_COLLECTION_UUID=bb348ab1-7a81-4e37-8ef7-adc095ade4f9   # "BYU-Idaho Faculty Content"
OEQ_REDIRECT_URI=https://content.byui.edu       # must match the client EXACTLY
```

The collection UUID is **identical on test and production**, so `OEQ_BASE_URL`
is the only thing distinguishing them. Check it before every run. The token
store refuses a token issued for a different `baseUrl`, which is the backstop.

`.env` must be UTF-8 **without** BOM — PowerShell 5.1's `Set-Content -Encoding
utf8` adds one, which silently breaks the *first* variable only. The tool
tolerates it now, but it is worth knowing.

`OEQ_SCHEMA_UUID` is recorded in the manifest but **never sent anywhere**.
Don't chase it.

## Wire format — settled

`schema/swagger.json` was captured from the live instance and is committed.
Everything below is confirmed, most of it the hard way.

- `POST /staging`, `PUT /staging/{uuid}/{filepath}`, `DELETE /staging/{uuid}`.
- **`POST /staging` returns `201` with an EMPTY body**; the uuid is only in the
  `Location` header. A bare `res.json()` throws on the first row.
- **`POST /item` takes the staging id as `?file=`, a QUERY parameter.** `ItemBean`
  has no staging field. Sending it in the body is silently ignored, producing
  items whose attachments have no backing file.
- `draft` is a query parameter, **default `False`** — omitting it publishes live.
- **`GET /search` defaults `showall=false`**, excluding non-live items. Since
  this tool creates drafts, the duplicate pre-flight is blind without
  `showall=true`.
- Attachment payload `{ type: 'file', filename, description, uuid }` is correct,
  and a **client-supplied attachment uuid is honoured** — verified by round-trip.
- `POST /item` may answer `201` + `Location` with an empty body; `createItem`
  falls back to parsing the header.
- OAuth endpoints are **not** under `basePath: /api`. `/oauth/authorise`
  (British spelling) is canonical; `/oauth/authorize` 302-redirects to it.
- The production token reports `expires_in` of roughly 30 days; test reports
  Long.MAX_VALUE. Treat the cached token as a long-lived credential and run
  `oeq-upload logout` when finished.

## Electron facts learned the hard way

Each of these failed **silently** and was found by inspecting the running app —
not by reading code, and not by watching a build succeed.

- **The preload must be CommonJS.** Under `"type": "module"` + `nodenext`, `tsc`
  emits ESM and Electron's preload loader cannot execute it. The source is
  `preload.cts`, forcing a `.cjs` emit. An ESM preload opens the window normally
  and simply never initialises the bridge.
- **A sandboxed preload can `require()` only Electron's built-ins.** Importing a
  value from a local module aborts the whole preload with `module not found`,
  leaving `window.oeq` undefined. The preload imports **types** only and keeps a
  duplicated `CHANNELS` literal, guarded by a drift test. `ui/instances.ts` does
  the same for `INSTANCES`.
- **`sandbox: false` is unnecessary.** Sandboxed preloads get a polyfilled
  `require()` for `'electron'`, which is all the bridge uses. If something
  appears to need otherwise, work is happening in the wrong process.
- **`app.getAppPath()` is not the repo root** when launched as
  `electron dist-desktop/desktop/main.js` — it resolves to `dist-desktop/desktop`.
  Resolve bundled files from the module's own compiled location in development
  and `process.resourcesPath` when packaged.
- **Electron wraps every error crossing IPC** as
  `Error invoking remote method '<channel>': <ClassName>: <real message>`.
  `ui/errors.ts#stripElectronWrapper` removes it. Anchor such patterns to the
  start of the string — real messages contain colons.
- **A navigation you intend to interrupt rejects with `ERR_FAILED (-2)`.**
  Sign-in deliberately interrupts the authorize navigation to capture `?code=`.
  Treating that rejection as fatal made the *second* sign-in fail while the
  first passed, because openEQUELLA's Authorize button had provided a
  human-length pause the first time. `signin.ts` now requires both a load error
  **and** a grace period with no code before failing.

## Verifying the app — read before automating

Use the Chrome DevTools Protocol (`--remote-debugging-port`, then Playwright's
`connectOverCDP`) with a **disposable `--user-data-dir`**.

- **Never use desktop screen capture.** One attempt captured the operator's
  Outlook window instead of the app.
- **The operator may be using the app on the same machine.** An agent once
  collided with their live session and misread its state as its own. If the UI
  changes without your input, stop and rely on unit tests.
- This sandbox sets `ELECTRON_RUN_AS_NODE=1`, turning `electron.exe` into plain
  Node. Unset it. Not present for end users.
- `%APPDATA%\Electron` became unlaunchable during testing (native error window,
  no console output). Delete it to recover. The packaged app uses its own folder.
- `window.oeq` is `contextBridge`-frozen and **cannot be monkey-patched**. To
  drive a screen with synthetic data, import the compiled screen module directly
  and call its render function.

## Known gaps in the desktop app

None blocking, all flagged during implementation:

- `ui/collectionUrl.ts` builds `/page/search?collections=<uuid>` — a best-effort
  guess at openEQUELLA's New UI route, **unverified against a live instance**.
- The Results screen's "open in browser" link is a plain `<a target="_blank">`.
  Without `shell.openExternal` / `setWindowOpenHandler` in `main.ts`, Electron
  opens its own window instead of handing off to the OS browser. `main.ts` was
  out of scope for the UI task; worth doing in Task 9.
- The custom-xpath field on Review commits on blur, not on Enter.
- Native file-open dialogs have never been driven in automation — they are not
  CDP-scriptable. Task 10's manual test must cover them.
- `npm audit` reports findings; 18 of 21 are in electron-builder's devDependency
  tree, but `fast-xml-parser` and `uuid` (via `exceljs`) are production
  dependencies that ship. Pre-existing, deliberately not upgraded.

## Known gaps in the CLI

- `tokenStore.ts`'s docstring is now corrected, but the two-pass attachment
  fallback in `runner.ts` is unreachable on this instance since client-supplied
  uuids are honoured. Harmless.
- Sequential uploads only; no concurrency flag.
- Duplicate column headers rejected in v1. The XML builder supports multiple
  values per xpath, so lifting it is a sheet-reader change only.
- Shared owners / collaborators still applied manually in openEQUELLA.
  `ItemBean` has a `collaborators` field, so automating it is small.

## Outstanding for the operator

- Nothing. The 37 production items are **meant to stay as drafts** — draft is
  the finished state for this collection, not a pending step. Do not suggest
  submitting them.
- Apply shared owners via Manage Resources.
- Task 10 needs a Windows machine with **no Node installed** — the only way to
  prove the "zero prerequisites" claim.

## Things that bit us, worth not re-learning

- **Tests agreeing with the code prove nothing about the server.** Two wire-format
  bugs survived a 240-test suite because `client.ts` and
  `tests/helpers/mockServer.ts` encoded the same wrong assumption.
- **The real spreadsheet uses formulas.** `Equella_Spring2026.xlsx` computes
  `attachment name` and `MWDL/title` with `CONCATENATE`/`MID`. A CSV-only fixture
  missed this entirely and would have failed all 37 rows.
- **Draft is the default deliberately** — the target collection has no moderation
  workflow, so publishing goes live immediately.
- **`interrupted` rows are not failures.** A prior run died mid-entry; the runner
  refuses to guess whether the item exists. Check, then re-run with
  `--force-interrupted`.
- **Never round-trip a file through PowerShell `Set-Content`** if it contains
  non-ASCII — it re-encoded 19 em-dashes into mojibake in one commit. Use an
  editing tool that preserves encoding.
