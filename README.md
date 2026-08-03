# openEQUELLA Bulk Uploader

A local tool for bulk-creating openEQUELLA contributions from a directory of
files plus a metadata spreadsheet. One file becomes one attachment on one
contribution — a strict 1:1 relationship. Built for the BYU-Idaho instance at
`https://content.byui.edu`, replacing an older, no-longer-working tool by Jim
Kurian.

Two front ends share one core: a CLI for a spreadsheet-comfortable operator
running a batch (one browser sign-in to start it, then unattended for the
rest — see Authentication), and an MCP server for a conversational assistant
that plans, launches, and monitors a run without ever handling file bytes
itself.

## Setup

```bash
npm install
npm run build
cp .env.example .env
```

Fill in `.env`:

```dotenv
OEQ_BASE_URL=https://content.byui.edu
OEQ_CLIENT_ID=...
OEQ_CLIENT_SECRET=...
OEQ_COLLECTION_UUID=bb348ab1-7a81-4e37-8ef7-adc095ade4f9
OEQ_SCHEMA_UUID=c93181f3-a443-41bf-9afe-ac9f7daf90b7
```

`OEQ_COLLECTION_UUID` and `OEQ_SCHEMA_UUID` already default to "BYU-Idaho
Faculty Content" / `BYUI_MWDL` if left unset; only `OEQ_BASE_URL`,
`OEQ_CLIENT_ID`, and `OEQ_CLIENT_SECRET` are required.

Save `.env` as **UTF-8 without a BOM**. A BOM (common from PowerShell 5.1's
`Set-Content -Encoding utf8`, and plenty of Windows editors) lands on the
*first* variable in the file, not something obviously wrong-looking, so it
reads like a typo (`OEQ_BASE_URL` reported "missing" when it's plainly
there) rather than an encoding issue. The tool tolerates one anyway — it
strips a BOM off the first key it finds — but avoiding it in the first
place is one less thing to debug.

**An admin must register an API client** in the openEQUELLA admin console,
with two requirements:

- **`redirectUrl` must be the site root** (`https://content.byui.edu`, or
  `https://content-test.byui.edu` for the test instance) — not a `localhost`
  callback. This tool cannot capture the login code on a local listener, so
  the operator pastes it by hand; see Authentication below.
- **It must NOT be bound to a fixed user.** That's deliberate, not a gap:
  see Authentication below for why.

The instance sits behind Okta SSO, which cannot be scripted — there is no
way to authenticate without a human at a browser at least once per session.

## Authentication

`oeq-upload login`:

1. Prints the authorize URL and tries to open it in your default browser
   (best-effort — if that fails, headless or over SSH, the URL is printed
   regardless).
2. You sign in through the normal Okta SSO screen, **as yourself** — not a
   shared service account.
3. The browser lands on the openEQUELLA home page with `?code=…` in the
   address bar. Copy that code and paste it at the prompt.
4. The tool exchanges it for a token, confirms who you're logged in as
   (`GET /api/content/currentuser`), and caches the token in
   `.oeq-token.json` (gitignored) in the current directory.

**Items are owned by whoever logged in.** That's the entire reason this
flow exists instead of a fixed service account: the OAuth client on this
instance is deliberately *not* bound to a fixed user, so each contributor
owns what they contribute rather than everything being attributed to one
account.

The cached token is scoped to the `OEQ_BASE_URL` it was issued for — a
token minted against `content-test.byui.edu` is refused against
`content.byui.edu`, and vice versa. This matters: **the collection UUID is
identical in both instances**, so `OEQ_BASE_URL` is the *only* thing
distinguishing test from production, and the token guard is what stops a
test-instance login from being silently reused against production.

`oeq-upload logout` removes the cached token — useful for switching users,
or before handing the machine to someone else.

**Runs cannot be fully unattended.** Every session needs one browser
sign-in first; there is no way around that on an SSO-backed instance with
no fixed-user client. If a long-running batch outlives the token, the
runner marks the remaining rows failed with a clear message rather than
guessing — `run` afterward skips everything already created, so recovery
is cheap (log in again, `run` the same manifest), just not automatic.

`OEQ_AUTH_MODE` defaults to `code` (this flow). `client_credentials`
(`OAuthClientCredentials` in `src/core/auth.ts`) remains available for an
instance whose OAuth client *is* registered with a fixed user, but **does
not work against `content-test.byui.edu` or `content.byui.edu`** — their
client is deliberately unbound, and client-credentials against it fails
with `invalid_client`.

## Spreadsheet format

Row 1 headers are literal openEQUELLA schema xpaths (`MWDL/title`,
`MWDL/creators/creator`, …), plus one reserved header, `attachment
name`, naming the file on disk for that row. Both `.xlsx` and `.csv` are
accepted (chosen by file extension); in `.xlsx` sheets, formula cells are
resolved to their computed value, not their formula text.

| attachment name | MWDL/title | MWDL/description | MWDL/creators/creator |
| --- | --- | --- | --- |
| interview_072126.mp4 | Oral History: Jane Doe | Recorded 2026-07-21 | David Olsen |

Notes:

- `BYUI_extended/attachments/attachment` is filled in automatically with the
  real attachment uuid once the file is uploaded. If your spreadsheet has a
  column with this header (some legacy sheets put the filename there),
  whatever value it holds is ignored and overwritten — do not rely on it.
- **Duplicate column headers are rejected in v1.** Two columns with the same
  xpath (e.g. two `MWDL/creators/creator` columns for co-creators) fail
  `plan` outright rather than silently discarding one. See Known
  limitations.
- Unknown headers block `plan` and print nearest-match suggestions; run
  `oeq_list_schema_paths` / `oeq_validate_sheet` (MCP) to find the right
  xpath first if you're not sure.

## CLI usage

Seven commands. `login` once per session (see Authentication above); then,
in order:

```bash
# 1. Authenticate once per session -- see Authentication above.
oeq-upload login

# 2. Read-only pre-flight. Creates nothing. Do not proceed until this passes.
oeq-upload check

# 3. Validate the sheet against files on disk and the live schema. Uploads nothing.
oeq-upload plan --sheet batch.xlsx --files ./files --manifest job.json --state draft

# 4. Upload every pending row, resumably.
oeq-upload run --manifest job.json

# 5. Check progress at any time, including mid-run.
oeq-upload status --manifest job.json

# 6. After fixing a problem, reset failed rows so the next `run` retries them.
oeq-upload retry --manifest job.json

# When done, or to switch users:
oeq-upload logout
```

- `login` — see Authentication above. No flags.
- `check` — read-only pre-flight; verifies, in order, that the cached token
  is valid, which user it belongs to (created items are owned by this
  user), that the target collection exists **on this host**, and that this
  user holds `CREATE_ITEM` on it. Exits non-zero if any check fails. No
  flags. Real output on full success:

  ```text
  OEQ_BASE_URL: https://content-test.byui.edu
  OEQ_COLLECTION_UUID: bb348ab1-7a81-4e37-8ef7-adc095ade4f9

  [PASS] Token: present and usable.
  [PASS] Identity: logged in as <username> (<First> <Last>). Created items will be owned by this user.
  [PASS] Collection: '<name>' (<uuid>) exists on https://content-test.byui.edu.
  [PASS] Permission: CREATE_ITEM confirmed on '<name>'.

  All checks passed.
  ```

  Do not proceed to `plan`/`run` — and definitely not to the live smoke test
  below — until all four checks pass.
- `plan` prints `Planned N item(s) -> job.json` plus any warnings (missing
  files, unmatched files, possible duplicate identifiers already in the
  collection). Flags: `--sheet`, `--files` (both required), `--manifest`
  (default `job.json`), `--schema-file` (default `schema/_entity.xml`),
  `--state draft|published` (default `draft`), `--skip-duplicate-check`.
- `run` prints one line per row (`[done/total] filename -> status`) and a
  final summary line: `created=… failed=… skipped=… incomplete=… interrupted=…`.
  Flags: `--manifest` (required), `--force-interrupted`, `--max-attempts <n>`.
  Exit code is `1` only if `failed > 0` — see below for why `interrupted`
  does not also set it.
- `status` prints a JSON count-by-status object, any failed rows with their
  error, any interrupted rows, and whether a lock is currently held.
- `retry` resets `failed` rows to `pending` (and their attempt counter to 0)
  so the next `run` gives them a fresh try. It deliberately does not touch
  interrupted rows — see below.
- `logout` — see Authentication above. No flags.

## MCP usage

Register the server with Claude Code (after `npm run build`, since it spawns
`dist/cli/index.js`):

```bash
claude mcp add oeq-uploader -- node "c:/Users/milesm/Documents/repos/openEQUELLA Bulk Uploader/dist/mcp/index.js"
```

Nine tools:

- `oeq_login_url()` — returns the authorize URL to open in a browser, plus
  where to find the code afterward. An MCP tool can't drive a browser or
  read stdin itself, so login is split across this call and the next one.
- `oeq_login_complete(code)` — exchanges the code from `oeq_login_url` for a
  token, caches it (so a detached `oeq_start_job` runner can use it too),
  and confirms `Logged in as <username> (<First> <Last>).` — that user owns
  every item created from here on.
- `oeq_check()` — the same read-only, four-step pre-flight as the CLI's
  `check` (token, identity, does the collection exist on this host, is it
  contributable). Creates nothing. Run this — and confirm it passes — before
  `oeq_plan`/`oeq_start_job`.
- `oeq_list_schema_paths(filter?, schemaFile?)` — search the ~158 valid
  metadata xpaths; useful for finding which column header a piece of
  information belongs in.
- `oeq_validate_sheet(sheet, schemaFile?)` — check a spreadsheet's headers
  against the schema, with suggestions for anything invalid.
- `oeq_plan(sheet, filesDir, manifestPath?, itemState?, schemaFile?, skipDuplicateCheck?)`
  — write a job manifest; returns the same summary and warnings the CLI's
  `plan` prints. Refuses to run while the manifest is locked by an active job.
- `oeq_start_job(manifestPath, logPath?)` — spawn the runner as a detached
  background process and return immediately (`Started runner pid=… for …`).
  Refuses to start a second runner against an already-locked manifest.
- `oeq_job_status(manifestPath)` — counts by status, failures, interrupted
  rows, and lock state. Read-only; safe to poll at any time.
- `oeq_retry_failed(manifestPath)` — reset failed rows to pending. Refuses
  to run while locked.

**Division of labor:** the MCP layer plans, launches, and monitors — it
never streams file bytes. Uploading a ~150 MB file over dozens of tool calls
would be slow and would burn conversation context, so `oeq_start_job`
detaches the actual upload process and the assistant polls `oeq_job_status`
for progress instead of driving the upload itself.

## Item state and the draft default

The target collection ("BYU-Idaho Faculty Content") **has no moderation
workflow.** `--state published` (or `itemState: "published"` over MCP) puts
every item live immediately, with nothing in between to catch a wrong
metadata mapping before it's visible. **Draft is the default for exactly
this reason** — both the CLI flag and the MCP tool default to `draft`, and
both explicitly refuse (rather than silently correct) any value other than
`draft`/`published`. Do not pass `--state published` until a draft dry run
into the same collection has been checked in the openEQUELLA UI.

## Interrupted rows

A row's status can persist as `uploading` if a prior `run` died mid-row —
crash, kill, disk full, laptop sleep, anything. On the next `run`, that row
is reported as `interrupted`, not retried automatically: the item **may or
may not** already exist in openEQUELLA, and the runner refuses to guess.

The asymmetry is deliberate: guessing "already done" when it isn't costs
nothing (the operator manually checks and re-runs); guessing "not done" when
it actually is creates a duplicate ~150 MB contribution in a collection with
no moderation queue to catch it. So the default is always the cheap
mistake — skip and ask.

To resolve: check the collection by hand for the item in question, then

```bash
oeq-upload run --manifest job.json --force-interrupted
```

`interrupted` rows do **not** set the CLI's exit code to 1 on their own
(only `failed > 0` does) — a prior run's leftover ambiguity is not this
run's mistake — but `run` prints a prominent message whenever
`interrupted > 0`, and `status` lists interrupted rows explicitly.

## The job lock

Only one runner may act on a given manifest at a time. `run` acquires
`<manifest>.lock` for its duration; `plan`, `retry`, and their MCP
equivalents (`oeq_plan`, `oeq_retry_failed`, `oeq_start_job`) all check that
lock first and refuse to write while it's held, rather than risk clobbering
the runner's in-progress state with a stale snapshot (which would revert a
`created` row back to `pending` and cause a duplicate upload on the next
run). A stale lock (owning process no longer alive) is reclaimed
automatically on the next `acquireLock`.

## Known limitations

- **One wire-format assumption remains unverified.** `AttachmentBean` in
  `schema/swagger.json` documents only `uuid, description, viewer, preview,
  erroredIndexing, restricted, externalId` — no `filename` or `type` —
  because the spec doesn't model openEQUELLA's polymorphic attachment
  subtypes (file/url/etc.). This client's `{ type: 'file', filename,
  description, uuid }` attachment payload is therefore still a guess; it
  must be confirmed by the live smoke test below. If it's wrong,
  `src/core/client.ts` and `tests/helpers/mockServer.ts` are the two files
  that need to change.
- **Shared owners / collaborators are applied manually** in openEQUELLA
  (Manage Resources) — out of v1 scope. `ItemBean` does have a
  `collaborators` field in swagger.json, so automating this later is a
  small, contained change.
- **Repeated columns for multi-value fields are rejected in v1.** Two
  columns sharing an xpath (e.g. two creators) fail `plan`'s
  duplicate-header check rather than being merged. `sheet.ts` would need to
  change to support this; the metadata XML builder already accepts multiple
  values per xpath.
- **The OAuth client secret travels in the token request's query string** —
  openEQUELLA's documented form, not RFC 6749's recommended body/Basic-auth
  form. It may therefore appear in the instance's own server access or
  proxy logs on every token request. This tool redacts the secret (raw and
  percent-encoded) from every error it raises, but cannot do anything about
  the server's own logs — treat the secret as rotatable, not long-lived.
- **Sequential uploads only.** Rows are processed one at a time; there is no
  concurrency flag. This is intentional (the bottleneck is a ~150 MB upload
  over a campus network, and parallelism would only complicate
  partial-failure reasoning for a doubtful gain), not an oversight.

## The live smoke test

Run this before any real batch, and before ever passing `--state published`.
**Do not start until `oeq-upload login` then `oeq-upload check` (or
`oeq_login_url`/`oeq_login_complete` then `oeq_check` over MCP) report all
four checks passing** — this test creates a real item, and a failing
pre-flight (wrong host, no `CREATE_ITEM`, wrong user) is a much cheaper
place to catch a misconfiguration than here.

1. Prepare a one-row spreadsheet and a single small test file.
2. Point `plan` at a **test** collection (override `OEQ_COLLECTION_UUID`, or
   use one with no production consequences), with `--state draft`:

   ```bash
   oeq-upload plan --sheet smoke.xlsx --files ./smoke --manifest smoke.json --state draft
   oeq-upload run --manifest smoke.json
   ```

3. In the openEQUELLA UI, verify:
   - Title and description match the spreadsheet exactly, including any
     quote characters.
   - Exactly one attachment, and it plays / opens correctly, with the
     correct byte size.
   - `BYUI_extended/attachments/attachment` holds the attachment's **uuid**
     — not the original filename, and not a list of values.
   - The item's status is **draft**.
4. Re-run the same command:

   ```bash
   oeq-upload run --manifest smoke.json
   ```

   Confirm the output reads `created=0 ... skipped=1 ...` and that no
   second item was created in openEQUELLA.

If the attachment is missing, wrong, or malformed, the `{ type: 'file',
filename, ... }` payload assumption noted above is wrong. Fix it in
`src/core/client.ts` (the request-building side) and
`tests/helpers/mockServer.ts` (so the test suite reflects the corrected
contract) together.

## Development

```bash
npm test        # vitest, 239 tests across 16 files
npm run typecheck
npm run build    # emits dist/cli/index.js and dist/mcp/index.js
```

Layout:

```text
src/core/   Framework-free core: auth, authCode, tokenStore, client, schema,
            sheet, metadata, plan, upload, runner, state, lock, preflight,
            config, errors, types. Must stay free of CLI and MCP concerns --
            both front ends are thin wrappers over this layer.
src/cli/    commander: login | logout | check | plan | run | status | retry
src/mcp/    MCP server exposing the nine tools above
schema/     openEQUELLA schema and API reference material (committed)
tests/      vitest specs + tests/fixtures, tests/helpers/mockServer.ts
```
