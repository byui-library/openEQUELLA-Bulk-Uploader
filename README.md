# openEQUELLA Bulk Uploader

A local tool for bulk-creating openEQUELLA contributions from a directory of
files plus a metadata spreadsheet. One file becomes one attachment on one
contribution — a strict 1:1 relationship. It works at any openEQUELLA
installation: the collection, the schema, the field that holds an item's title
and the field that holds an attachment uuid are all read from the instance or
supplied as configuration, never assumed. It was built for the BYU-Idaho
instance at `https://content.byui.edu`, replacing an older, no-longer-working
tool by Jim Kurian, and BYU-Idaho is now one configuration of it rather than
the only one it fits.

**Read [What is and is not verified](#what-is-and-is-not-verified) before
trusting any of that at a site other than BYU-Idaho.** Everything here has
been tested against BYU-Idaho's two instances only.

Two front ends share one core: a CLI for a spreadsheet-comfortable operator
running a batch, and an MCP server for a conversational assistant that plans,
launches, and monitors a run without ever handling file bytes itself. A third,
the desktop app, is documented in [docs/INSTALL.md](docs/INSTALL.md) and is
what a non-technical operator uses.

## Setting up a new institution

Two commands and one screenful of configuration:

```bash
npm install
npm run build
cp .env.example .env
```

Fill in `.env`. The shortest working version, for an institution with ordinary
openEQUELLA accounts:

```dotenv
OEQ_BASE_URL=https://oeq.yourschool.edu
OEQ_AUTH_MODE=password
OEQ_USERNAME=jsmith
OEQ_PASSWORD=...
OEQ_COLLECTION_UUID=...
```

Then run `oeq-upload check`. It reports, line by line, whether this tool can
work here — including which collections the account can contribute to, so the
collection uuid above is the only value you have to go and find, and `check`
itself will list the candidates once the rest is right.

`.env.example` documents every variable with the reasoning behind it. In short:

| Variable | Required | Notes |
| --- | --- | --- |
| `OEQ_BASE_URL` | always | Must be https. See below. |
| `OEQ_COLLECTION_UUID` | always | No default, in any mode. |
| `OEQ_AUTH_MODE` | no | `code` (the default), `client_credentials`, or `password` |
| `OEQ_USERNAME` / `OEQ_PASSWORD` | in `password` mode | Nothing else reads them |
| `OEQ_CLIENT_ID` / `OEQ_CLIENT_SECRET` | in the two OAuth modes | Not needed at all in `password` mode |
| `OEQ_REDIRECT_URI` | no | `code` mode only; sent verbatim |
| `OEQ_SCHEMA_UUID` | no | Recorded in the manifest, sent nowhere |
| `OEQ_ATTACHMENT_UUID_PATH` | no | **Blank means no such field is written** |
| `OEQ_TOKEN_STORE_PATH` | no | `code` mode only; where the token is cached |

**`OEQ_AUTH_MODE` defaults to `code`, not to `password`.** That trips people:
setting `OEQ_USERNAME` and `OEQ_PASSWORD` and nothing else gets you the OAuth
flow with an empty client id, and openEQUELLA answers with `No OAuth client can
be found with the supplied client_id (null)`, naming neither the variables you
set nor the one you didn't. `check` detects exactly that case and says so.

**`OEQ_BASE_URL` must be https**, and this is refused rather than warned about.
openEQUELLA's `/api/auth/login` takes the password as a *query parameter*, so
over plain http it travels in clear text in the request line. A loopback
address (`localhost`, `127.0.0.1`) is the one exemption, because its traffic
never leaves the machine — and `check` says so out loud rather than printing a
bare `ok`, so nobody reads it as license to use http against a real host.

There is no default collection: one used to be built in, and an institution
that never set it silently got BYU-Idaho's collection uuid and a not-found from
the server naming an identifier they had never chosen.

`OEQ_SCHEMA_UUID` is optional -- it is recorded in the job manifest and sent
nowhere. The schema this tool actually validates against comes from the chosen
collection (the collection list carries its `schema.uuid`) or, for `plan` and
`extract`, from `--schema-file`.

`OEQ_ATTACHMENT_UUID_PATH` is optional, and **blank means no such field is
written**. It names a metadata xpath that should also receive each item's
attachment uuid, a convenience index that BYU-Idaho's schema declares and most
do not; writing to a path the collection's schema does not have would store
junk or fail the create, on every item. The attachment itself is linked through
the attachment API and is unaffected either way. `oeq-upload check` reports
whether it is set and whether the path really exists in the collection's
schema.

Save `.env` as **UTF-8 without a BOM**. A BOM (common from PowerShell 5.1's
`Set-Content -Encoding utf8`, and plenty of Windows editors) lands on the
*first* variable in the file, not something obviously wrong-looking, so it
reads like a typo (`OEQ_BASE_URL` reported "missing" when it's plainly
there) rather than an encoding issue. The tool tolerates one anyway — it
strips a BOM off the first key it finds — but avoiding it in the first
place is one less thing to debug.

## What is and is not verified

**Everything on this branch was tested against BYU-Idaho's two instances
only** — `content.byui.edu` and `content-test.byui.edu`. That is one vendor
configuration of one openEQUELLA version at one institution. It is the whole
sample.

**Password sign-in HAS now been confirmed against a live instance** — 2026-08-12,
`content-test.byui.edu`, an ordinary openEQUELLA account: `POST /api/auth/login`
returned 200 and authenticated as the real user. It had shipped unverified until
then, and verifying it immediately found a defect: **the whole cookie jar has to
go back, not just `JSESSIONID`.** That instance sits behind an AWS load
balancer, and its `AWSALB`/`ROUTEID` cookies decide which backend a request
reaches. `JSESSIONID` alone landed on a backend that had never seen the session
— and openEQUELLA served that as **guest, 200, with empty-but-plausible data**
rather than a 401, so the desktop app's collection list simply looked empty with
no error anywhere. Fixed; `tests/passwordAuth.test.ts` carries the measurements.

What the probe of 2026-08-12 **did** confirm live, against `content.byui.edu`:

| Confirmed | Detail |
| --- | --- |
| `GET /api/collection?privilege=CREATE_ITEM&full=true` | returns `{ start, length, available, results }`; `available: 29` |
| a collection **list entry** carries its schema | `schema: { uuid }`, so a chosen collection resolves to its schema with no second request |
| more than one schema per institution is real | those 29 collections use two distinct schemas |
| `GET /api/schema/{uuid}` | declares `namePath` and `descriptionPath`; `/MWDL/title` and `/MWDL/description` here |
| `definition` is nested **JSON**, not XML | so the XML parser cannot be reused on the API path |

**The language model pass has been run against real models twice** — the same
ten scanned documents through a small local model (2026-08-14) and then a larger
one (2026-08-16). Both fabricated on the same 2 of them, so the tool checks every
generated value against the document before writing it and discards one that
states something the document does not support; both times it caught both, and
refused nothing good. What changed between the runs was the **quality** of the
eight it kept: about three followed the requested form with the small model,
eight of eight with the larger one. **No test can assert that a generated
description is good**, and none tries to: whether the ones that survive the check
are worth keeping is still your judgement. Note also that the check reads
**English month names and numeric date forms only**. See *Letting a language
model write a description*; it is off unless you configure an endpoint.

What has **not** been confirmed anywhere: other openEQUELLA versions, other
authentication configurations, and any schema that is not BYU-Idaho's MWDL. Apostrophe escaping in a `where` clause is still assumed
(`Bach's Prelude` sends `Bach''s Prelude`; no live title has exercised it).

**`oeq-upload check` is how a new site finds out.** It exists for exactly this
reason: it reports a line per capability, each saying what a failure would mean
for a real run, so "it didn't work" becomes a specific, diagnosable statement
made by the tool rather than a support conversation conducted blind across
institutions. Run it first. If it passes and something still breaks, the output
is what to send.

## Authentication

Three modes, selected by `OEQ_AUTH_MODE`:

| Mode | For | Needs |
| --- | --- | --- |
| `password` | an institution with ordinary openEQUELLA accounts | `OEQ_USERNAME`, `OEQ_PASSWORD` |
| `code` | an SSO-backed site, such as BYU-Idaho | an OAuth client, and a human at a browser once per session |
| `client_credentials` | an OAuth client registered with a fixed user | that client's id and secret |

**The tool does not detect which one applies, and will not guess.**
openEQUELLA gives no reliable signal that an account is SSO-only, so a guess
would fail at sign-in — where a new user is least equipped to diagnose it.
`oeq-upload check` reports which mode was actually used, on the success path
as well as the failure one.

### `password` — an openEQUELLA username and password

The simplest mode, and the one the desktop app offers first. Set:

```dotenv
OEQ_AUTH_MODE=password
OEQ_USERNAME=jsmith
OEQ_PASSWORD=...
```

There is no `login` step: it signs in on first use, keeps the returned
`JSESSIONID`, and presents it as a `Cookie` header. Session expiry needs no
special handling — a lapsed session produces a 401, which the client already
answers by invalidating and retrying exactly once, the same machinery OAuth
expiry has always used.

**The credentials go in the query string** (`POST /api/auth/login?username=…&password=…`).
That is openEQUELLA's API and cannot be changed from here, and it has two
consequences the tool acts on rather than warns about:

- **https is required**, enforced in the provider's constructor and reported
  by `check`. Over http the password would be in clear text in the request
  line.
- **No URL carrying credentials is ever logged, printed, or written to the
  manifest.** `tests/passwordAuth.test.ts` walks every string reachable from a
  thrown error — message, stack, the `ApiError` body, anything nested — for the
  password in both literal and percent-encoded form, including on the path
  where a server echoes the request line back at us. That test exists because a
  debug line added later would otherwise put a password in a file the operator
  emails around when asking for help.

The password is held for the life of the process and never written to disk by
the CLI. Only the desktop app persists it, encrypted per Windows account.

**`oeq-upload logout` does not end a password session**, and says so:
password mode caches no token, so a fresh `logout` process has no live session
to end and makes no network request at all. `UsernamePasswordAuth.logout()`
*does* `PUT /api/auth/logout`, and the desktop app and any long-lived process
holding a provider get that; a one-shot CLI `logout` would have to mint a
session purely to destroy it, which it declines to do. The cached token file is
cleared either way, so an operator who moved over from an OAuth mode is not
stranded with a stale one.

### `code` — the authorization-code flow

This is the working path at BYU-Idaho, whose instance sits behind Okta SSO.
SSO cannot be scripted: there is no way to authenticate without a human at a
browser at least once per session.

**An admin must register an API client** in the openEQUELLA admin console,
with two requirements:

- **`redirectUrl` must match `OEQ_REDIRECT_URI` character-for-character,
  including any trailing slash.** The default (unset `OEQ_REDIRECT_URI`) is
  the site root **with** a trailing slash (`https://content.byui.edu/`, or
  `https://content-test.byui.edu/` for the test instance) — confirmed live:
  the same URL *without* the slash fails with "No OAuth client can be
  found ...". `redirect_uri` is sent verbatim, never normalised, so a
  mismatch of even one trailing character breaks login. See "A dedicated
  OAuth client for this tool" below for a better option than the site root.
- **It must NOT be bound to a fixed user.** That's deliberate, not a gap:
  see below for why.

`oeq-upload login`:

1. Warns up front about a known SSO quirk (see "A cold SSO session" below),
   then prints the authorize URL and tries to open it in your default
   browser (best-effort — if that fails, headless or over SSH, the URL is
   printed regardless).
2. You sign in through the normal Okta SSO screen, **as yourself** — not a
   shared service account.
3. Gets the resulting `code` back one of two ways, chosen automatically from
   `OEQ_REDIRECT_URI` (never guessed from browser cookies — this tool has no
   access to them):
   - **Loopback capture**, if `OEQ_REDIRECT_URI` points at `localhost` or
     `127.0.0.1`: a temporary local server catches the redirect and reads
     `code` off it directly. Nothing to copy or paste. This is only possible
     with a dedicated client registered for a loopback `redirectUrl` — see
     below — since the current client's `redirectUrl` is the site root.
   - **Manual paste**, otherwise (the situation against this instance
     today): openEQUELLA's home page discards the `?code=…` query string
     within about a second of loading, so grabbing it straight out of the
     address bar is a race you will usually lose. The reliable way: after
     you sign in and click **Authorize**, open your browser's **history**
     and look for the entry containing `?code=` — it's recorded there even
     though the address bar has already moved on to `/page/home`. Paste
     that whole URL at the prompt (or just the code, if you've already
     isolated it) — either is accepted.
4. The tool exchanges the code for a token, confirms who you're logged in
   as (`GET /api/content/currentuser`), and caches the token in
   `.oeq-token.json` (gitignored) in the current directory.

**A cold SSO session drops the query string on the first attempt.**
Visiting the authorize URL while not already signed in to openEQUELLA in
that browser bounces through Okta SSO and lands back on a *bare*
`/oauth/authorise` — no query string — which openEQUELLA reports as `No
OAuth client can be found with the supplied client_id (null) and
redirect_uri (null)`. Confirmed live. This tool cannot detect your
browser's session, so it can't route around this automatically: if you see
that error, sign in to openEQUELLA at the base URL first, then run
`oeq-upload login` again (or just re-open the URL it printed).

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

`OEQ_AUTH_MODE` defaults to `code` (this flow), which is why an institution
that fills in only `OEQ_USERNAME` and `OEQ_PASSWORD` gets a confusing
`client_id (null)` from openEQUELLA rather than the password sign-in they
asked for.

### `client_credentials` — a fixed-user OAuth client

`OAuthClientCredentials` in `src/core/auth.ts`. Available for an instance
whose OAuth client *is* registered with a fixed user, and **it does not work
against `content-test.byui.edu` or `content.byui.edu`** — their client is
deliberately unbound. Probed 2026-08-12: it answers `invalid_client`, *"To use
the Client Credentials flow your client must be registered with a fixed
user"*. An earlier version of this file said unattended runs require this
grant; at BYU-Idaho they cannot use it, and `password` is the mode that gets an
unattended run anywhere else.

### A dedicated OAuth client for this tool (recommended)

The site-root `redirectUrl` this tool currently uses forces the manual-paste
fallback above on every login. That's avoidable: **ask an admin to register
a second, dedicated OAuth client for this tool** (leaving the existing
"openEQUELLA Sync" client untouched) with:

```text
redirectUrl = http://localhost:8787/callback
```

then set `OEQ_REDIRECT_URI=http://localhost:8787/callback` (and the new
client's `OEQ_CLIENT_ID`/`OEQ_CLIENT_SECRET`) in `.env`. `login` detects the
loopback host automatically and captures the code itself — no address bar,
no history, no pasting.

This has to be a **separate** client, not a `redirectUrl` change on the
existing Sync client: `OAuthClientBean.redirectUrl` (per
`schema/swagger.json`) is a single value, not a list, so pointing the
existing client at a loopback address would break Sync's own login in the
process. Registering a second client with its own `client_id`/`client_secret`
costs nothing and leaves Sync alone.

**Alternative, not built into this tool:** a Playwright script that drives a
real browser and captures the code at the network layer (intercepting the
redirect response before the SPA's own navigation discards it) also works
against the *current* site-root client, without needing a new one
registered. This tool does not vendor Playwright as a dependency — it's a
heavier tool than a bulk-upload CLI should carry just for this — but if
you'd rather automate the current setup than ask for a new client, that
approach is worth building as a separate, optional script outside this
package.

## Spreadsheet format

Row 1 headers are literal openEQUELLA schema xpaths — your schema's, not this
document's. The examples below are BYU-Idaho's (`MWDL/title`,
`MWDL/creators/creator`, …); yours will be whatever your collection's schema
declares, and `oeq-upload check` reports how many valid paths it found. There
is one reserved header, `attachment name`, naming the file on disk for that
row. Both `.xlsx` and `.csv` are accepted (chosen by file extension); in
`.xlsx` sheets, formula cells are resolved to their computed value, not their
formula text.

| attachment name | MWDL/title | MWDL/description | MWDL/creators/creator |
| --- | --- | --- | --- |
| interview_072126.mp4 | Oral History: Jane Doe | Recorded 2026-07-21 | David Olsen |

Notes:

- **The item's title comes from the path the schema declares** as its item
  name path, not from a header this tool picks. At BYU-Idaho that is
  `MWDL/title` — which is what the schema has always declared; the tool used
  to hardcode it and now reads it. Duplicate detection matches on the same
  path, so where a schema declares none, every row is reported as *could not
  check* rather than as clean.
- **The attachment-uuid column is configuration and defaults to off.** When
  `OEQ_ATTACHMENT_UUID_PATH` names a path, that path is filled in
  automatically with the real attachment uuid once the file is uploaded, and
  whatever the spreadsheet holds there is ignored and overwritten — some legacy
  sheets put the filename there; do not rely on it. BYU-Idaho sets it to
  `BYUI_extended/attachments/attachment`. Left blank, no such field is written
  at all, which is right for a schema without one.
- **Duplicate column headers are rejected in v1.** Two columns with the same
  xpath (e.g. two `MWDL/creators/creator` columns for co-creators) fail
  `plan` outright rather than silently discarding one. See Known
  limitations.
- Unknown headers block `plan` and print nearest-match suggestions; run
  `oeq_list_schema_paths` / `oeq_validate_sheet` (MCP) to find the right
  xpath first if you're not sure.

## CLI usage

Seven commands (plus `extract`, which has its own section below). `login` is
needed only in `code` mode — password and client-credentials modes sign in on
first use. Then, in order:

```bash
# 1. Authenticate once per session -- `code` mode only. See Authentication above.
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
- `check` — **the compatibility probe, and the first thing a new institution
  should run.** Read-only; creates nothing; no flags; exits `1` if any check
  fails. It reports nine checks in order: HTTPS, Token, Sign-in method,
  Identity, Collection, Collections available, Permission, Attachment field,
  Duplicate detection. Every message says what a failure *means for a real
  run*, not just what was observed — that is the whole point, because the
  first site to run this somewhere other than BYU-Idaho has to be able to tell
  us what broke without us having access to their instance. Output on full
  success, in `password` mode:

  ```text
  OEQ_BASE_URL: https://oeq.yourschool.edu
  OEQ_COLLECTION_UUID: 0f3a1c2e-5d84-4b0e-9a71-6c2e8f4d1b33

  [PASS] HTTPS: OEQ_BASE_URL is 'https://oeq.yourschool.edu', which uses https. openEQUELLA takes your password as part of the web address when signing in, so this is what keeps it from travelling in clear text.
  [PASS] Token: present and usable.
  [PASS] Sign-in method: signed in with OEQ_AUTH_MODE=password, i.e. a username and password, from OEQ_USERNAME and OEQ_PASSWORD.
  [PASS] Identity: logged in as jsmith (Jane Smith). Created items will be owned by this user.
  [PASS] Collection: 'Digital Archives' (0f3a1c2e-5d84-4b0e-9a71-6c2e8f4d1b33) exists on https://oeq.yourschool.edu.
  [PASS] Collections available: 3 collection(s) accept contributions from this account: Digital Archives (0f3a1c2e-…), Faculty Content (9c40b7a2-…), Theses (7b213fd0-…)
  [PASS] Permission: CREATE_ITEM confirmed on 'Digital Archives'.
  [PASS] Attachment field: OEQ_ATTACHMENT_UUID_PATH is not set, so no attachment-uuid field is written into item metadata. The attachment itself is unaffected -- attachments are linked through the attachment API, not through that field.
  [PASS] Duplicate detection: existing items will be matched on 'local/dc/title', which schema 4a91… declares as the item name path. A row whose title already exists in the collection will be reported before anything is uploaded.

  All checks passed.
  ```

  A failure names itself in the summary rather than sending you back up the
  report:

  ```text
  [FAIL] Duplicate detection: schema 4a91… declares no item name path, so there is nothing to match an existing item's title against. Every row in every batch would be reported as "could not check" -- never as a duplicate, and never as clean -- and each would have to be checked by hand before uploading. Ask an openEQUELLA administrator to set the schema's item name path to the field that holds the title.

  1 of 9 checks failed -- see above: Duplicate detection.
  ```

  Two behaviours worth knowing. If the token check fails, the three checks
  above it are reported and the six below are **not produced at all** — nothing
  past that point can succeed, and every failure would be a confusing echo of
  the same root cause, so the summary reads `of 3`, not `of 9`. And a check
  that could not be *run* (an unreadable collection list, an unreadable schema)
  fails as **unknown**, never as a clean or an empty result — "could not check"
  is not reported as success anywhere in this tool.

  Do not proceed to `plan`/`run` — and definitely not to the live smoke test
  below — until every check passes.
- `plan` prints `Planned N item(s) -> job.json` plus any warnings (missing
  files, unmatched files, possible duplicate identifiers already in the
  collection). Flags: `--sheet`, `--files` (both required), `--manifest`
  (default `job.json`), `--schema-file` (default `schema/_entity.xml`),
  `--state draft|published` (default `draft`), `--skip-duplicate-check`,
  `--upload-duplicates`.

  **`plan` reads the schema from the local `--schema-file` export; `check`
  reads it from the API.** So the title path `check` reports and the one `plan`
  actually searches on come from different sources and can disagree — for
  instance when a schema has been edited on the server since the export was
  taken. This seam is known and deliberately not closed on this branch; if it
  is closed later, the API is the authority and the local file is the offline
  fallback. Until then, a new institution should export its own schema and pass
  it with `--schema-file` rather than relying on the bundled BYU-Idaho export.
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

## Extracting metadata from files

Builds the spreadsheet from a folder of PDFs and `.docx` files, so it does not
have to be typed by hand.

```bash
# 1. Look at the folder and write a starter profile
oeq-upload extract --dir ./files --profile music.profile.json --init-profile

# 2. Edit music.profile.json: add a column per metadata field you want
#    (see the columns array; each column says where its value comes from)

# 3. Check what it will produce, without writing anything
oeq-upload extract --dir ./files --profile music.profile.json --dry-run

# 4. Write the spreadsheet
oeq-upload extract --dir ./files --profile music.profile.json --out rows.csv

# 5. Optional: let a language model fill the columns whose profile asks for one.
#    Does nothing at all unless OEQ_MODEL_BASE_URL is set. See "Letting a
#    language model write a description" below.
oeq-upload extract --dir ./files --profile music.profile.json --out rows.csv --ai
```

Then **open `rows.csv` and check it** before uploading. Two columns exist for
that purpose and are ignored by the uploader:

- `_source` — where each value came from, as `field=source` pairs
- `_notes` — problems with that row, such as a filename that did not match the
  pattern or a PDF with no text layer

### What it can and cannot read

| | |
| --- | --- |
| PDF with a text layer | Text and document properties |
| Scanned PDF | Filename and document properties only, flagged in `_notes` |
| `.docx` | Text and core properties |
| `.doc` (Word 2003) | Not supported — save as `.docx` first |

There is no OCR. A scanned page yields no text, and the row says so rather than
guessing.

### Declaring a date format

A compact date such as `12032025` is refused by default, because it reads as
3 December or 12 March depending on who wrote it and nothing in the file says
which. Rather than guess, state the convention in the profile:

```json
{ "path": "MWDL/date",
  "sources": [{ "placeholder": "date" }],
  "transform": { "date": "MMDDYYYY" } }
```

Use `YYYY`, `MM` and `DD` exactly once each, with any literal separators —
`MMDDYYYY`, `YYYYMMDD`, `DD-MM-YYYY`. A malformed format is rejected when the
profile loads, not part-way through a batch.

Declaring a format buys precision, not permissiveness: a value that does not
match is still kept as found and flagged, and `02302025` is rejected as not a
real date.

Leave `"transform": "date"` for values that are already unambiguous, such as
`2026-04-12` or a document's own timestamp.

### Reading metadata from a Word table

Word documents often hold their fields as a table -- a header row naming them,
then one row of values -- rather than as `Label: value` prose. Point a column
at the header:

```json
{ "path": "MWDL/title", "sources": [{ "tableColumn": "Job Title" }] }
```

The whole cell is taken, including a cell spanning several paragraphs -- which
is how a long description is usually written. Header matching ignores case and
surrounding space. Only the first row under the header is read: one document
describes one item.

The desktop app offers these automatically. Any header it finds with a value
beneath it appears in the source dropdown as "Table column: Job Title".

PDFs are not covered. A table in a PDF is only positioned text with lines drawn
round it, so there are no cell boundaries to read -- guessing them from
coordinates is a different feature from reading a format that states them.

### The starter profile is built from your schema, not from BYU-Idaho's

`--init-profile` used to propose `MWDL/title`, `MWDL/creators/creator` and
`MWDL/description` whatever schema it was handed. At any institution without an
MWDL section, the extractor's very first output — before the operator had done
anything — held three columns the column picker immediately flagged invalid.

It now reads instead of guessing. **Title** comes from the schema's declared
item name path and **description** from its declared description path;
openEQUELLA publishes both (`namePath`/`descriptionPath` over REST,
`<itemNamePath>`/`<itemDescriptionPath>` in an export). **Creator** has no
declared equivalent, so it is matched against the schema's real paths by leaf
name (`creator`, then `author`) and **omitted entirely when nothing matches** —
a missing column is the smaller harm, since the operator adds what they need
and the picker already supports that, whereas an invented path is a mistake
they have to recognise first. Nothing changes at BYU-Idaho: the same four
columns, in the same order, with the same sources.

### A title is never left empty

The declared title path becomes the item's **name** in openEQUELLA, so an empty
one contributes a nameless item. The starter profile therefore ends that column
with the filename minus its extension:

```json
{ "path": "MWDL/title",
  "sources": [{ "property": "title" }, { "filenameStem": true }] }
```

It sits last, so any document that states a title keeps it. Two of twelve real
journal PDFs state none at all, and those two would have been contributed
nameless. `_source` reads `filename` on exactly those rows.

The name is taken verbatim, including any leading number — only the last
extension is removed, because titles in a real batch are full of dots
(`22. Salazar_proof.v2.pdf` → `22. Salazar_proof.v2`).

### The duplicate check

Every row is checked against the target collection before you confirm a plan.
The tool asks openEQUELLA for items whose title matches **exactly**, and gets
each one's attachments back in the same response:

```http
GET /api/search?collections=<uuid>&where=/xml/<item name path> = '<title>'
   &info=basic,attachment&showall=true
```

**The path in that clause is the one the schema declares as its item name
path**, read from `namePath` on the REST representation or `<itemNamePath>` in
an `_entity.xml` export. At BYU-Idaho it resolves to `MWDL/title`, which the
schema has declared all along; the tool used to hardcode that literal, and at
any institution whose schema names its title anything else the clause matched
nothing and every row came back **clean from a check that never looked**.
[That exact failure has shipped from this codebase once already](docs/superpowers/specs/2026-08-06-duplicate-prevention-design.md),
in the same function, which is why there is now a fourth verdict.

| What was found | Verdict | Default |
| --- | --- | --- |
| same title **and** an attachment with the same filename | almost certainly a duplicate | **skip** |
| same title, different file | possibly a duplicate | upload |
| the row has no title | could not be checked | upload |
| the request failed | could not be checked | upload |
| **the schema declares no item name path** | could not be checked | upload |

The last row issues no search at all — a query naming no field would be a
wasted request whose answer means nothing — and reports every pending row as
`could-not-check`. Returning an empty list there would tell the operator their
batch is clean on the strength of a check that never happened. `oeq-upload
check` reports this before a batch rather than during one.

The **identifier** pre-flight, which is separate and advisory, has the same
shape: openEQUELLA declares a name path and a description path and nothing
else, so the identifier field is found by matching the schema's real paths on
leaf name — ties going to the top-level section the declared name path lives
in, which at BYU-Idaho yields `MWDL/identifier`, the literal it used to
hardcode. Where nothing ends in `identifier`, the batch gets one warning saying
the check did not run and why, rather than an empty result.

**Only the first defaults to skipping.** Two items can legitimately share a
title — two students, one recital name — and silently dropping a real item is
worse than a visible duplicate: you can see and delete a duplicate, but you
cannot notice an item that never arrived.

In the desktop app, Review lists every flagged row with **Skip** / **Upload
anyway** and shows what the existing item already holds. Your choices are
applied to the manifest immediately before the run. A skipped row is recorded
as `skipped` with a reason and counted on the Results screen.

On the CLI, near-certain rows are skipped automatically:

```bash
oeq-upload plan --sheet s.csv --files ./files --manifest job.json
oeq-upload plan ... --upload-duplicates      # check, report, skip nothing
oeq-upload plan ... --skip-duplicate-check   # do not check at all
```

**Confirmed against the live instance**, not assumed: the `where` clause is
accepted, it genuinely filters (a title known to be absent returns
`available: 0`), and an attachment's filename is at `attachments[].filename`.
`showall=true` is mandatory — items this tool creates are drafts, and the
search excludes non-live items by default, so without it the check would be
blind to exactly the duplicates it exists to catch.

**Two limitations, both real:**

- A re-upload whose **title was changed** will not be caught. Nothing in this
  approach can see it. Each attachment does carry an `md5` in the search
  response, which would catch it — that is the obvious next step, not built.
- Escaping a title that contains an **apostrophe** is assumed, not verified.
  `Bach's Prelude` sends `Bach''s Prelude`; the probe that would confirm it
  used a title with no apostrophe in it.

### Collection templates

Different collections are written differently. An alumni obituary keeps its
death date in a sentence — *"passed away on November 4, 2211"* — and its genre,
subjects and rights are identical on every record. A **template** carries that
knowledge.

**A template is a profile JSON and nothing more.** They live in `templates/`,
and the Extract flow offers them as *"Start from: Generic / Alumni Obituary"*.
To author one, build a profile in the app and save it — no code, and a
colleague can use it by opening the file. That is deliberate: a code plugin per
collection would need a developer every time.

Four capabilities make a profile expressive enough. All generic — nothing in
the code knows what an obituary is:

| In a profile | Reads |
| --- | --- |
| `{ "dateNear": ["passed away", "died"] }` | the first date in words after any phrase, within 80 characters |
| `{ "datePair": "second" }` | one half of `March 9, 2146 - December 4, 2211` |
| `{ "compose": "Died {death_date}" }` | other columns' finished values |
| `"checks": { "filenameWordsInText": { "ignore": ["Obituary"] } }` | flags a row whose filename the document contradicts |

A column referenced by `compose` must name itself with `"as": "death_date"`.
Xpaths are too long to write inside a template, and naming the reference means
renaming a column cannot silently break one. Composed columns are filled after
all others and may not read each other; a profile that breaks either rule is
rejected when it loads, not part-way through a batch.

`compose` drops what it cannot fill: `[...]` marks an optional group that
disappears with its punctuation, and a `;` clause whose placeholders are all
empty is dropped whole — so a missing piece never yields `Died ; Born`.

**Measured on ten real scanned obituaries:** a death date on 9 of 10, agreeing
in all three cases where the document's own numeric header survived OCR. The
tenth states no date anywhere and comes out blank rather than guessed. One row
was flagged, correctly: the file was named `Alden Larkspar` while the obituary
said *Larkspur* throughout — a misspelling that would otherwise have become the
item's permanent title.

**Read the prose, not the numbers.** These documents state the death date twice,
once in a numeric header and once in a sentence. OCR destroyed the header on
seven of ten — `06107/2211`, `0:4`, `0` — while every spelled-out date came
through clean, because letters carry far more redundancy than digits. Reading
the prose took recovery from 3 of 10 to 9 of 10 without changing anything about
the scanning.

**What the Alumni Obituary template deliberately does not extract:** cause of
death, birthplace, residence, and the Ricks College connection. Cause and
birthplace cannot be read honestly — a trial capture produced *"Sagebrush
Memorial Hospital, in Hazelmere Id"* as a birthplace. Residence and the Ricks
mention are both readable at 8 of 10 but were dropped as not worth the build:
the PDF is attached, and a reader can see them. **A wrong fact in a permanent
catalogue record is worse than an absent one.**

### Where a description comes from

The description is the field that is hardest to find and the one most worth
having, so it is tried from four places in order. **The first that yields
anything wins**, and nothing later overwrites it.

| Tried | Source | What it is |
| --- | --- | --- |
| 1 | `{ "tableColumn": "Job Description" }` | A stated field. The document says this cell is the description. |
| 2 | `{ "section": "Abstract" }` | Text under a heading, ending at the next heading. The document drew the boundary. |
| 3 | `{ "opening": true }` | The first substantial paragraph. **A guess — always flagged.** |
| 4 | — | Blank, and visibly so. |

The desktop app proposes 1, 2 and 3 automatically: any table header matching a
schema field, then every heading it found while scanning, then the opening. So
a folder of journal PDFs arrives with real abstracts in the description column
without mapping anything by hand.

Headings recognised for tier 2: **Abstract**, **Executive Summary**,
**Summary**, **Overview**, **Description**, **Purpose**, **Scope**. A section
ends at the next heading — `Keywords`, `Introduction`, `Methods`, `References`
and the rest — or at a 4,000-character cap.

Two things are always flagged in `_notes`:

- **A section that ran to the cap.** It never reached another heading, which
  usually means the heading was not one. A benefits PDF matched "Summary"
  mid-page and produced 3,996 characters of plan tables.
- **Anything from the opening paragraph**, every time, with no exception. On a
  published PDF the opening is as likely to be a masthead as a summary.

`_source` names the tier that filled each cell — `table`, `section`, `opening`.
It is **one cell per row** holding every column's origin at once
(`attachment name=filename; MWDL/title=join; MWDL/description=opening`), so
sorting on it sorts the whole concatenated string and groups nothing useful.
Filter or search the column for `=opening` instead, and you have the rows that
were guessed at.

Tier 3 refuses to guess when there is nothing to guess from: a page of headings
and table fragments yields a blank cell rather than a line of timeline labels
presented as a description.

### Letting a language model write a description

Tiers 1–3 above read what the document states. Where they find nothing, or find
only a guess, a language model can be asked to write the cell instead. It is
**off unless you configure an endpoint**, and it can point at a model running on
your own computer or at a hosted service.

> **The tool checks the model's work, and the model you pick decides how much
> editing you do.** An answer that states something the document does not
> support is discarded — see *When the tool refuses the model's answer* below.
> What no test can assert is that a description which passes that check is any
> *good*. On a real batch of ten, a capable model wrote eight usable
> descriptions and a small one wrote about three; see *The model you choose
> changes what you get* below before you judge the tool by its output. Whether
> what comes out is worth keeping is your judgement, made by reading the
> descriptions against the documents. Every cell a model writes is flagged for
> exactly that reason.

#### With nothing configured, nothing is contacted and nothing is sent

No endpoint means no network call, no prompt, no error and no degraded mode. An
institution can adopt the tool without a data review, because there is no data
leaving the machine to review.

**One thing does change, and only for a profile that asks for a model.** A
column carrying `{ "ai": true }` that could not be filled records that in
`_notes`, per cell, naming the column and what would have to change — that
`--ai` was not given, or that no endpoint is set up for this site. A cell that
could not be filled must never look like a document that had nothing to say.

**The Alumni Obituary template that ships now asks for one**, so a run of it
without `--ai` writes this on every row whose description came out empty:

```text
MWDL/description: this column asks for a language model, and --ai was not
given, so nothing was written here. Re-run with --ai to fill it -- or fill
this cell in by hand.
```

**The "needs review" count does not move.** An empty description on this
template means `compose` found no death date, no birth date and no Ricks
mention, and an empty death date already raises `flagIfEmpty` on its own
column — so every row that gains this note was being counted anyway. What is
new is the `_notes` text, not the triage number. If you do not want the line, remove
`{ "ai": true }` from the description column; it is a profile edit like any
other.

#### The model you choose changes what you get

**Point this at a small local model and the descriptions will need heavy
editing. That is the model, not the tool.** It is worth knowing before you
conclude the feature does not work.

The same ten scanned obituaries, the same prompt, the same profile — twice:

| | a 3B model, on CPU | an 8B model, on a GPU |
| --- | --- | --- |
| descriptions written in the house style the profile asked for | about 3 of 8 | **8 of 8** |
| answers refused as unsupported | 2 of 2 | 2 of 2 |
| good answers wrongly refused | 0 | 0 |
| time for ten documents | slower | about 140 seconds |

The 3B model's failures were not subtle: names prepended to a line that should
start with a date, an age given where a death date belongs, prose sentences
naming a hospital. **Rewriting the instruction does not fix that** — the wording
that produced those results is the same wording that produced eight correct
lines from the larger model. If the output is not in the shape you asked for,
try a bigger model before you edit the prompt.

**Two documents defeated both models**, and both times the tool refused the
answer: one states no date of any kind, and the model invented one; the other
never mentions the institution the model claimed for it. **A better model does
not remove the need for the check.** That is why the check is always on.

Treat the table as a sample of ten documents from one collection in one
language, not as a benchmark. The 8B figures were measured on `llama3.1:8b`
running on an integrated GPU — not on specialist hardware — and the 3B figures
on the same machine before that GPU worked at all. One more thing to know if you
compare your own results: the larger model happened to answer with `2024-01-06`
style dates, which is the easiest shape for the tool's own check to read.

#### A local model, from nothing (Ollama)

```bash
ollama pull llama3          # once
ollama serve                # if it is not already running as a service
```

```bash
export OEQ_MODEL_BASE_URL=http://localhost:11434/v1
export OEQ_MODEL=llama3
oeq-upload extract --dir ./obituaries --profile templates/alumni-obituary.profile.json \
  --out rows.csv --ai
```

No API key, no account, no charge, and **nothing leaves the computer**. Plain
`http` is fine here and only here — see the key rule below.

#### When a local runtime misbehaves — it is the runtime, not this tool

**Symptoms:** every request comes back `500`, on every model, and the runtime's
own worker process dies (on Windows, exit code `0xc0000409`). The giveaway is
that it fails the same way with this tool uninvolved:

```bash
ollama run llama3 "Say OK."
```

If that fails too, nothing here is going to help — and no amount of changing
`OEQ_MODEL_*` settings will, either. **Read the Ollama server log**, which names
the GPU it detected and the library it chose to load. That one line is usually
the whole diagnosis.

Two traps are worth naming because they cost a session here:

- **A `HSA_OVERRIDE_GFX_VERSION` environment variable naming the wrong
  architecture.** These are commonly copied from forum posts to make ROCm accept
  an unsupported card. Set to a discrete card's architecture on a machine with an
  integrated one, it makes the runtime load kernels the hardware cannot execute:
  `ROCm error: invalid device function`, on every model. Check whether it is set
  before assuming it is needed, and unset it if it names hardware you do not
  have.
- **An integrated GPU being skipped on purpose.** Ollama drops integrated GPUs
  from its Vulkan path by default and says so in the log. `OLLAMA_IGPU_ENABLE=1`
  opts back in. On the machine these figures were measured on, that plus removing
  the override above was the difference between "nothing works" and every layer
  offloaded to the GPU.

You can always fall back to CPU — it is slower, not broken, and the tool's
two-minute timeout is set for exactly that case.

#### A hosted model

```bash
export OEQ_MODEL_BASE_URL=https://api.openai.com/v1
export OEQ_MODEL=gpt-4o-mini
export OEQ_MODEL_KEY=sk-...
oeq-upload extract --dir ./obituaries --profile templates/alumni-obituary.profile.json \
  --out rows.csv --ai --yes
```

**A hosted endpoint sends your document text to somebody else's computer.** Up
to `OEQ_MODEL_BUDGET` characters of each file, over the network, to a third
party under their terms. If your material cannot leave site — student records,
anything under a donor agreement, anything an institutional review would have an
opinion about — **use a local runtime**. That choice is the point of supporting
both, and it is not a detail to settle later.

Any OpenAI-compatible endpoint works: Ollama, LM Studio, llama.cpp, OpenAI,
Azure OpenAI, Groq, Together, OpenRouter. Anthropic's and Google's own APIs do
not speak this wire format and are not supported.

#### The six environment variables

| Variable | Meaning |
| --- | --- |
| `OEQ_MODEL_BASE_URL` | The endpoint, up to and including `/v1`. **This is the switch: unset, the feature does not exist.** |
| `OEQ_MODEL` | The model's name at that endpoint — `llama3`, `gpt-4o-mini`. **No default.** |
| `OEQ_MODEL_KEY` | Bearer key. Leave empty for a local runtime, which needs none. |
| `OEQ_MODEL_BUDGET` | Characters to send from **one** document. Default 8000. |
| `OEQ_MODEL_CAP` | Most **requests** one run may make. Default 500. |
| `OEQ_MODEL_TIMEOUT_SECONDS` | How long to wait for one answer. Default 120. |

On the CLI none of them is read at all without `--ai`; in the desktop app the
same settings are entered per site on Setup and stored encrypted, and the
environment is not consulted.

Every one of them is checked **before a single file is read**, and the message
names the variable that was wrong. That matters more than it sounds: setting
`OEQ_MODEL_BASE_URL` and forgetting `OEQ_MODEL` used to put every document on
the wire with an empty model name — all failing, all charged for by whatever a
gateway charges for accepting a request. `OEQ_MODEL_CAP=eight` used to render
the confirmation itself as *"About to send up to NaN model requests"*, which is
the one screen standing between an operator and a paid batch.

- Malformed budget, cap or timeout: refused, naming the variable and the rule.
  A cap of `0` is legal and means "make no requests"; every row then says the
  limit stopped it.
- `OEQ_MODEL_KEY` set against a plain `http` address that is not this machine:
  **refused**, because a bearer key in clear text is a key disclosed. `https`,
  and plain `http` to loopback, are both fine.
- Empty or unset budget/cap/timeout: the default.

**The cap counts requests, not documents.** One request is made per cell a model
may fill, so a profile with two such columns costs two per document. With the
shipped template — one enabled column — the two numbers happen to be equal, but
nothing relies on that: every figure in the confirmation is stated in requests,
and it says what a request is in the same breath, because an operator has no
reason to know.

**The timeout is 2 minutes, not the usual 30 seconds.** A hosted model answers a
prompt this size in single-digit seconds; a quantised 7B on a CPU can take
ninety and be perfectly healthy. Abandoning a working model mid-generation
spends the compute, leaves the cell blank, and tells the operator "this does not
work" about a configuration that does.

#### `--ai`, `--yes` and `--dry-run`

**`--ai` never prompts.** Against a remote endpoint it prints exactly what it is
about to send and **exits non-zero without sending anything** unless `--yes` is
also given. It does not read stdin at all — a scheduled job's stdin is not a
terminal, so a prompt there either reads EOF and treats it as consent nobody
gave, or blocks for ever holding a nightly run open. Refusing behaves the same
on a terminal and off one.

`--yes` is not required when there is nothing to agree to: a **local** endpoint,
or a cap of zero. Neither shows a confirmation, exactly as the desktop shows no
dialog. (An empty folder is not asked about either, but the run then stops with
`No readable files found`, so it is not a case you can use.)

**`--ai` on a profile where no column asks for a model is refused**, not
ignored. So is `--ai` with no endpoint configured. Both are an explicit
instruction that cannot be carried out, and quietly proceeding is how a run
"with the model on" turns out later not to have been.

**`--dry-run` sends nothing, even with `--ai`.** It shows five rows; sending four
hundred documents to a paid endpoint to print five answers is a bill nobody
asked for. The run says so on screen rather than showing a blank column with no
explanation.

#### What you get back

- **The confirmation**, before any file is opened: how many requests, to which
  host, which model, the maximum characters, where the cap stops it, and that
  nothing is uploaded to openEQUELLA by this step. A **local** endpoint gets no
  confirmation at all, deliberately — nothing leaves the machine and nothing is
  charged, and a dialog that does not matter is what trains people to click past
  the one that does.
- **A flag on every model-written cell**, without exception, in `_notes`, and
  `MWDL/description=ai` in that row's `_source`. Filter or search `_source` for
  `=ai` — it is one cell per row, so sorting it will not group them.
- **A louder flag on a fact field.** Where the column declares a date or a
  people transform, or reads a date from the document, the note says so: *an
  invented date cannot be told from a real one by anyone reading the catalogue
  afterwards*. Such a row also stays in the "needs review" count.
- **A separate count**: `N of M row(s) had a value written by a language model`,
  reported beside the "needs review" number and deliberately **not** folded into
  it. Every model write carries a note, so counting notes would report "400 of
  400 need review" and bury the one row that genuinely failed.
- **A blank and a reason on any failure.** A refused, empty, truncated or
  unreachable answer leaves the cell as it found it and says what happened,
  quoting back up to 80 characters of anything the model said that was thrown
  away. There is no retry.
- **A refusal, where the answer states something the document does not.** The
  cell is left exactly as it was and the note names each unsupported claim — see
  below.

#### When the tool refuses the model's answer

Before anything is written, the generated value is checked against the document
it came from. **Dates, numbers, and anything the profile already has a check
for** must appear in the document; where one does not, the answer is discarded
whole and the cell is left as it was, empty or holding whatever it held before.
Nothing is edited or partially kept — a sentence with a clause removed reads as
complete while meaning something else.

The note names the claim in the model's own words and says why it failed:

```text
MWDL/description: left blank -- the model's answer was refused, because it
stated things this document does not support. "2024-01-06": no date this tool
can read in the document supports it -- it recognises English month names and
numeric date forms only. The model did answer and the call succeeded -- this
tool discarded the answer -- so there is nothing to retry; read the document
and fill this cell in by hand. What it said, which was not used: "Died
2024-01-06; Born 1907-11-13"
```

There is nothing to retry, because nothing went wrong at the endpoint: the call
succeeded and the model answered. Read the document and fill the cell in by hand.

**A date is a claim whether or not a year sits beside it.** `He died on January
6.`, `He died 1/6.` and `Died 2024-01-06T00:00:00Z.` are all checked against the
document, and all three used to be written out unchecked because no pattern
matched them and "no form matched" was read as "no claim was made". That gap was
the difference between this layer working and not working: the first model it was
measured against happened to answer in ISO, and one that writes `He died on
January 6` would have walked straight past it.

#### It reads English dates, and says so rather than blaming the document

> **If your collection is catalogued in another language, read this before
> turning the model on.** The date recogniser knows English month names and the
> numeric forms (`2024-01-06`, `6.1.2024`, `4/2/98`, `the 6th of January 2024`).
> `Falleció el 6 de enero de 2024` states a day; this tool sees only the year in
> it. So a **correct** description of that document, giving the day, is refused
> and discarded.

Refusing is deliberate and stays: the fabrication this check was built for came
from a document that genuinely stated no date, and a check that gave up quietly
on text it could not read would be worse than no check. What the note will never
say is *"the document states no such date"* — that is a claim about the document,
and all that is known is that no date **this tool can read** supports the value.
The sentence in `_notes` says which of the two it means, so an operator is not
sent to re-read a document that says exactly what they thought it said.

Adding a language means adding its month names to `MONTH_NAMES` in
`src/core/extract/dates.ts` — both recognisers in the tool are built from that
one array — and its numeral words to `SMALL` in `src/core/ai/verify.ts`. Nothing
else in the check is language-specific.

Numbers are compared by value, so the document and the description need not agree
on convention: `1,200`, `1.200`, `1 200` and `1200` are one number, and a
document writing `two hundred`, `a dozen`, `the twenty-first` or `three and a
half` supports `200`, `12`, `21st` and `3.5`.

**Free prose is not checked**, because paraphrase is a legitimate way to describe
a document and checking it would throw away good descriptions. **And a check that
passes does not make a value true**: it means every checkable claim appears in
the document, not that the sentence around it says the right thing — a date can
be real and attached to the wrong person. Every model-written cell stays flagged
for that reason, and reading them against the documents is still the job.

#### The rule: what a model may and may not overwrite

A model may write a cell only when the cell is **empty**, or when a source
attached a note to it — the `{ "opening": true }` tier, which flags every time.
**A value the document stated, that no source expressed doubt about, is never
replaced.** That is the safety property of the whole feature.

"Flagged" is structural, not a judgement: it is a note some source attached, not
an opinion formed here. A tier that starts flagging itself becomes
model-replaceable with nobody having to remember.

#### On the shipped template, the model will almost never fire

This surprises people, so it is worth stating before you run it rather than
after.

The Alumni Obituary description comes from `compose`, and **`compose` attaches
no note**. Whatever it assembles is a stated value, so the rule above leaves it
alone. `composeValue` returns empty only when *every* clause is empty — no
death date, no birth date and no Ricks College mention, all three missing from
the same document. A document that yielded only a birth date produces
`Born 1907-11-13`, which is a stated value, unflagged, and never sent.

So expect the model to write on a **small fraction** of a real batch. Measured on
a real folder of ten scanned obituaries: **the model fired on 1 of them**,
because `compose` produced a value for the other nine — 9 of 10 of those
documents gave up a death date. That is not the feature failing.

**It is deliberate, and it is the archival position.** A description assembled
from extracted facts is evidence: every part of it can be traced back to
something the document says. A model may fill a gap, and it may replace a guess
the extractor already admitted to — but it may not overwrite evidence. Letting
it do so would merge verified fact and machine assertion into one cell with no
way to tell them apart afterwards, and `_source` records **one origin per
cell**, so the composed half's provenance would simply be lost. An incomplete
but traceable description outranks a complete but unverifiable one.

To *evaluate* the model's output you need a scratch profile whose description
column asks for the model alone, with no `compose` beside it, run against a
copy of the folder. Keep it out of `templates/` and do not ship it — the way to
see more model output is a throwaway profile, never a loosened rule.

#### Widening it, without touching any code

The shipped **Alumni Obituary** template enables a model on `MWDL/description`
and on nothing else. Enabling another column is a profile edit:

```json
{ "path": "MWDL/description",
  "sources": [
    { "compose": "Died {death_date}; Born {birth_date}; {ricks}" },
    { "ai": true }
  ] }
```

**Put `{ "ai": true }` last by convention, not because position does anything.**
`resolve` returns empty for the marker wherever it sits, and the union takes the
first source that yields a value, so the model pass behaves identically if you
put it first. It goes last because a profile is read by people: a reader
scanning the sources should see the deterministic ones tried before the
fallback, in the order they actually happen.

Give the profile an `aiInstruction` and the model is asked for the house style
rather than left to invent a format, so a generated description and a composed
one look alike in the catalogue. This is the shipped one, in full:

```json
"aiInstruction": "Write one line in this form, omitting any part the document does not state: Died <date>; Born <date>; Attended Ricks College. Use ISO dates (YYYY-MM-DD). Include the last clause only if the document says the person attended Ricks College or BYU-Idaho."
```

**The last sentence is doing the most work in that string** — and on its own it
is not enough. It asks the model not to append *Attended Ricks College* to a
record that never mentioned it, which would be an assertion about a real person
in a permanent catalogue with no moderation queue. **Measured against a small
local model, the instruction did not hold**: it made exactly that claim about
documents that do not support it, which is why the check described under *When
the tool refuses the model's answer* exists and runs regardless of what the
instruction says. Write one of your own by all means, and give every claim it
invites the same evidence requirement — but treat it as a request, not a
guarantee.

**Think hard before enabling one on a fact field.** A death date, a name, an
identifier or a term from a controlled vocabulary is not a quality problem when
a model gets it wrong — it is indistinguishable from a real value to everyone
downstream, permanently, in a collection with no moderation queue. The shipped
template keeps its death date deterministic for that reason.

#### Recording it in the item itself

Everything above lives in `_notes`, which the uploader drops before anything is
contributed — so a cataloguer reviewing the spreadsheet sees the flags and a
future reader of the catalogue sees none of them. To disclose it in the record,
name a **metadata column** to receive the note:

```json
"aiProvenance": {
  "path": "MWDL/conversionSpecifications",
  "append": "Description generated by {model}"
}
```

That column already carries `Scanned to PDF` in the Alumni Obituary template —
a processing-provenance note about an earlier machine transformation of the same
document, which is exactly the job. The note is appended after a semicolon,
once per row, only where a model actually wrote something — whatever the field
already holds is kept.

**The tool never picks this field and ships with none set.** Choosing a metadata
path on an institution's behalf is the assumption an entire release was spent
removing. The path must be a real, writable column in the same profile — it is
validated against your schema alongside every other column path, and a profile
naming a column that does not exist is refused when it loads. `{model}` is the
only placeholder; anything else in braces is refused, because a mistyped
`{modle}` would be written verbatim into every item in the batch.

### Known limitation: extra separators

Placeholders match as little as possible, left to right, so an unexpected extra
separator lands in the **last** placeholder. Against
`{last}_{first}_{title}_{date}`, the file `Smith_Jane_Senior_Recital_2026-04-12.pdf`
yields `title=Senior` and `date=Recital_2026-04-12`. Use `--dry-run` to see this
before it reaches a spreadsheet.

### Known limitation: values that look like formulas

A metadata value beginning with `=`, `+`, `-` or `@` is written to the CSV
correctly, but **Excel will interpret it as a formula when you open the file**.
A title like `=Summary` will display as an error rather than as text.

This is not fixable in the file itself: the usual defence is to prefix the
value with an apostrophe, which would then be uploaded to openEQUELLA as part
of the value. If you hit this, fix the cell in Excel before uploading. It is
rare -- filenames and document text seldom start with those characters.

> Note: PDF support adds `pdfjs-dist` (~35 MB installed) to the packaged app.
> Only its `legacy/build` entry point is used at runtime.

## MCP usage

Register the server with Claude Code (after `npm run build`, since it spawns
`dist/cli/index.js`):

```bash
claude mcp add oeq-uploader -- node "C:/path/to/openEQUELLA Bulk Uploader/dist/mcp/index.js"
```

Nine tools:

- `oeq_login_url()` — returns the authorize URL to open in a browser, plus
  where to find the code afterward. An MCP tool can't drive a browser or
  read stdin itself, so login is split across this call and the next one.
- `oeq_login_complete(code)` — exchanges the code from `oeq_login_url` for a
  token, caches it (so a detached `oeq_start_job` runner can use it too),
  and confirms `Logged in as <username> (<First> <Last>).` — that user owns
  every item created from here on.
- `oeq_check()` — the same read-only pre-flight as the CLI's `check`, running
  the same `runPreflight` and reporting the same nine checks. Creates nothing.
  Run this — and confirm it passes — before `oeq_plan`/`oeq_start_job`. (The
  tool's own registered description still describes the older four-step
  version; the behaviour is the CLI's.)
- `oeq_list_schema_paths(filter?, schemaFile?)` — search the valid
  metadata xpaths; useful for finding which column header a piece of
  information belongs in. `schemaFile` defaults to `schema/_entity.xml`, which
  is BYU-Idaho's export (158 paths) — pass your own elsewhere.
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

`--state published` (or `itemState: "published"` over MCP) puts every item live
immediately. **Draft is the default**, and this tool does not know whether your
collection has a moderation workflow — BYU-Idaho Faculty Content, the
collection it was built for, has none, so published means visible straight away
with nothing in between to catch a wrong metadata mapping before it is seen.
Assume the same until you have confirmed otherwise for your own collection.
Both the CLI flag and the MCP tool default to `draft`, and both explicitly
refuse (rather than silently correct) any value other than `draft`/`published`.
Do not pass `--state published` until a draft dry run into the same collection
has been checked in the openEQUELLA UI.

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

- **The attachment payload is confirmed against one openEQUELLA version, not
  against the spec.** `AttachmentBean` in `schema/swagger.json` documents only
  `uuid, description, viewer, preview, erroredIndexing, restricted,
  externalId` — no `filename` or `type` — because the spec doesn't model
  openEQUELLA's polymorphic attachment subtypes (file/url/etc.). This client's
  `{ type: 'file', filename, description, uuid }` payload was an open guess
  until the production run of 2026-08-04 settled it: 37 items, each read back
  and compared byte-for-byte against its source. Since swagger.json still does
  not describe it, another openEQUELLA version could differ — which is what
  the live smoke test below is for. If it is wrong, `src/core/client.ts` and
  `tests/helpers/mockServer.ts` are the two files that need to change.
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
**At a new institution, run it before anything else at all** — it is the only
thing that proves this tool's wire format against your openEQUELLA version.

**Do not start until `oeq-upload check` reports every check passing** (in
`code` mode, `oeq-upload login` first; over MCP, `oeq_login_url` /
`oeq_login_complete` then `oeq_check`). This test creates a real item, and a
failing pre-flight (wrong host, no `CREATE_ITEM`, wrong user) is a much cheaper
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
   - If `OEQ_ATTACHMENT_UUID_PATH` is set, that field holds the attachment's
     **uuid** — not the original filename, and not a list of values. (At
     BYU-Idaho, `BYUI_extended/attachments/attachment`.) If it is blank, check
     that no such field was written at all.
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
npm test               # vitest, 1450 tests across 88 files
npm run typecheck
npm run build          # emits dist/cli/index.js and dist/mcp/index.js
npm run build:desktop  # Electron -> dist-desktop/
```

Layout:

```text
src/core/   Framework-free core: auth, authCode, passwordAuth, tokenStore,
            instanceUrl, redact, client, discovery, schema, schemaCache,
            sheet, metadata, plan, duplicates, upload, runner, state, lock,
            preflight, config, errors, types. Must stay free of CLI, MCP and
            Electron concerns -- every front end is a thin wrapper over this.
src/cli/    commander: login | logout | check | plan | run | status | retry
            | extract
src/mcp/    MCP server exposing the nine tools above
src/desktop/  Electron app. Renderer is sandboxed -- no `node:` imports.
scripts/    probe-instance.mjs, the read-only instance probe. Committed so
            any institution can run it against their own site.
schema/     openEQUELLA schema and API reference material (committed).
            `_entity.xml` is BYU-Idaho's export, and is `--schema-file`'s
            default -- another institution should export and pass its own.
tests/      vitest specs, tests/fixtures (including tests/fixtures/api/,
            recorded from a live instance), tests/helpers/mockServer.ts
```

### Probing an instance

`scripts/probe-instance.mjs` issues GETs and nothing else. It answers the
response-shape questions this tool depends on and records the answers as
fixtures:

```bash
node scripts/probe-instance.mjs --base https://oeq.yourschool.edu --user <name> --pass <password>
# or, on an SSO site, after `oeq-upload login`:
node scripts/probe-instance.mjs --base https://oeq.yourschool.edu --token <access_token>
```

It exists because **this codebase has had three live probes refute assumptions
the entire test suite agreed with** — the staging area being a `?file=` query
parameter, `GET /search` defaulting to `showall=false`, and the schema's name
path being `namePath` rather than the `itemNamePath` its own XML export uses.
Tests agreeing with the code prove nothing about the server.

## License and contributions

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Copyright 2026 Brigham Young University-Idaho.

Apache 2.0 was chosen because **openEQUELLA itself is Apache 2.0**, so adopting
this tool raises a licensing question your institution has almost certainly
answered already. It is permissive: fork it, adapt it to your schema, and you
are under no obligation to publish the result.

**Contributions are welcome, with one caveat worth stating plainly.** This has
only ever run against one institution's instances. If you get it working
somewhere else, the most valuable thing you can send back is not a feature — it
is what `oeq-upload check` told you, and what your instance returned that this
code did not expect. Every hard-won fact in this repository came from a live
probe contradicting an assumption the test suite agreed with, and yours will
too.

`scripts/probe-instance.mjs` is committed for exactly that: run it against your
site, and the output answers the response-shape questions this tool depends on.

**This tool is not affiliated with or endorsed by the openEQUELLA project or
Apereo.** "openEQUELLA" names the system it talks to, nothing more.
