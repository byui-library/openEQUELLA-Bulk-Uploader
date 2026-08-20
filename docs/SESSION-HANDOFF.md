# Session handoff — updated 2026-08-20 (end of session)

Read this first.

## Where things stand

**v1.2.1 is released. `main` carries everything and NO branch is open.**

- **Released:** tag `v1.2.1` on `main`, built by CI, both Windows installers
  attached to the GitHub Release. It carries the whole sign-in state plan —
  five tasks, rows 1 to 14 of the credential state table — plus the dependency
  upgrade that was held back from v1.2.0.
- **Private, still.** Anonymous access returns 404. A public-facing version
  remains a later decision, to be discussed with Edalex.
- **2275 tests across 106 files.** Typecheck and `build:desktop` clean.

### What the sign-in plan actually found

All five tasks are done and the operator confirmed each on screen. The value was
not in the tasks — it was in what testing the STATES turned up, none of which
the 2221-test suite could see:

- **A refused token had no way out.** `hasToken` reads the STORE, so a token the
  server rejects is indistinguishable from a good one: no warning, no sign-in
  button, and a collection list that keeps failing. That is the state the
  operator was stranded in for two sessions. The signal is now
  `currentUser(instanceId)` returning null — typed, not the prose of the error,
  because a 403 here carries an empty body.
- **A server fault is deliberately NOT that signal.** A 500 with the session
  intact offers nothing: a browser flow that cannot help is worse than an error.
- **The fix for the first point broke password sites**, and only hand-reasoning
  about row 10 caught it. The offer is the OAuth browser flow and the notice
  beside it says so, so a password site whose credentials were refused would
  have been told something false about how it signs in.
- **Switching a site to a password silently destroyed its client secret.** The
  store says in two places that `forgetOAuth` is the ONLY way to remove one, and
  a mode switch broke that rule at the moment the operator was least likely to
  notice. A password entry now carries the OAuth record DORMANT — kept, never
  read to sign in — and `forgetOAuth` clears it whichever mode the site is in.
- **The wipe understated itself.** `clearSettings` unlinks `settings.enc`
  outright, and the confirm described *"the saved client ID and secret"* — one
  site, one credential, and one a password-mode operator does not even have.
  **A confirm that understates what it confirms is worse than no confirm: it
  collects consent for something other than what happens.** The button is
  renamed **"Clear all credentials…"** at the operator's decision.

### Two changes to behaviour, both the operator's call

- **Choose starts on the collection the site was set up against.** This was
  deliberately not remembered, because the collection decides where real items
  land and the target collection has no moderation workflow. The operator
  weighed that and asked for it. Two conditions keep it honest: only if the
  server listed the collection, and only when nothing is chosen yet. It is
  pre-selected, **never written back** — `Instance.collectionUuid` is what Setup
  read the schema from and what filled the attachment field in.
- **The OAuth refusal names the other way in.** *"Enter the client ID, client
  secret, and redirect URL"* was true and useless to somebody who has none. It
  now points at username and password AND says what OAuth is for, because "use
  the other one instead" is wrong at exactly the institutions that cannot.

### RESUME HERE — nothing is in flight

There is no half-finished task. The plan
([sign-in states](superpowers/plans/2026-08-18-sign-in-states.md)) is complete
and records what each task found.

**Open, and deliberately not started:**

- **A malformed client ID is not warned about.** The operator's own was a
  permutation of a valid uuid with one group moved, and the only symptom was
  openEQUELLA's `client_id (null)`. Setup could check the 8-4-4-4-12 shape and
  warn — overridably, never a refusal, since nothing guarantees an institution's
  client id is a uuid. Raised with the operator, not yet decided.
- **A collection LIST entry with no `schema`** yields `schema: ''` from
  `parseCollections`, and everything downstream — the attachment-field autofill,
  the schema-derived title path — has nothing to read. Measured on
  `content-test.byui.edu` (2026-08-17), where all 29 entries lack it with and
  without `full=true`, while production carries it. **Not handled in code.**

## No branches are open

`chore/dependency-advisories` and `feature/sign-in-states` were both merged on
2026-08-20 and each was checked for stranded commits first (`git log
main..<branch>` empty). This repository has lost work twice by trusting
`git branch --merged`, which reports ancestry rather than whether the work
arrived.

**The uuid advisory is NOT fixable and that is settled**: it arrives through
`exceljs`, `exceljs@4.4.0` is already the latest release, and
`npm audit fix --force` "resolves" it by installing `exceljs@3.4.0` — a
downgrade in the library that writes every spreadsheet this tool produces. The
advisory needs a `buf` argument; exceljs calls `uuidv4()` with none, so the path
is not reachable. `SECURITY.md` records this so nobody force-upgrades on a red
audit line.

## What the fifteen public days cost, unchanged

Traffic for the fifteen days the repository was public:

```text
clones : 240 total, 56 unique
views  :  76 total,  1 unique
```

**56 unique cloners against a single unique human viewer is the signature of
automated clients** — mirroring services, scanners, crawlers. The repository was
copied off-platform while it was public, so **going private stops future access
without retracting what was already taken.** The operator's real name and
institutional email are in that published history.

**Consequence for the public-facing version:** "we scrubbed it before
publishing" will be true of the current tree and NOT of the history. The honest
routes are a fresh repository with clean history, or rewriting history before
republishing. Do not let a future reader assume the scrub covered both.

## Three things the next session must not assume

- **The dev build and the installed app do NOT share a settings store.**
  Electron derives `userData` from the app name, and `electron dist-desktop/...`
  has no package.json at its root, so it falls back to `Electron` and writes to
  `%APPDATA%/Electron`. The isolation is right and stays — a dev run must not
  overwrite the credentials staff use, and one did during this investigation —
  but it was invisible and it cost hours: saves looked lost because the file
  being watched belonged to the other copy. Setup now says which store is in
  use. **A packaged build for a demo must be configured separately.**
- **A 403 with an empty body from openEQUELLA means a REJECTED ACCESS TOKEN.**
  Measured live: no header, a malformed header, a session cookie and a Bearer
  token are all answered 200 as the guest; only
  `X-Authorization: access_token=<invalid|empty>` returns 403 with zero bytes.
  That measurement is what found the auth-mode defect, and it is the fastest
  way to tell "not signed in" from "signed in and refused".
- **`ELECTRON_RUN_AS_NODE=1` may be set in an agent's shell**, which makes
  `electron.exe` run as plain Node: no window, and `import { app } from
  'electron'` fails with an opaque `Cannot read properties of undefined (reading
  'exports')` from the ESM loader. It looks exactly like a broken install or a
  broken build. Unset it before launching. Diagnosed 2026-08-20 after chasing
  the electron install instead.


## OAuth on content-test WORKS — superseded 2026-08-19

This section used to say OAuth had never worked end to end here. It does.
Measured live from the running app on 2026-08-19, against
`https://content-test.byui.edu` with the operator’s own OAuth client:

```text
authMode    : code
hasToken    : true
collections : 29        (no error)
```

The operator completed the browser sign-in on 2026-08-18; `token.enc` was
written at 12:41 and the token is accepted. **Both sign-in modes now work**
against this instance: password was proven on 2026-08-13, OAuth on 2026-08-18.

**The 403 that cost two sessions was never the OAuth design.** It was an
access token openEQUELLA refused, sent because Setup could not show which
mode a site was stored with — see the auth-mode defect. Once a real sign-in
produced a real token, the same path worked first time.

**The redirect-slash trap was never triggered.** The stored redirect URL is
`https://content-test.byui.edu` with no trailing slash and the sign-in
succeeded anyway, so this client is registered without one. Row 15 of the
state table remains unexercised — it is a real hazard recorded from a live
probe elsewhere, and it is not this client’s configuration.

## Historical: 2026-08-19, in detail (kept as the record)

### What was fixed today, all confirmed by the operator in the app

Every one of these was reported by them using it, and none was visible to the
2200-odd tests passing throughout.

- **Setup showed the wrong sign-in method.** `Instance` carries `authMode` and
  the form dropped it, so the radio always read "Username and password". Worse,
  saving from that form wrote the wrong mode back, so changing an attachment
  path could silently change how a site authenticates. Two places had to be
  fixed: the seed, and an async refresh that landed afterwards and put it back.
- **A configured OAuth site looked unconfigured.** The client ID and redirect
  URL were stored correctly and no IPC could read them back. `getOAuth` now
  answers with both plus `hasSecret`; the secret itself never crosses, and gets
  the treatment the password already had — a "stored" card with a Forget
  button. A blank secret on save now means *keep the stored one*.
- **Every configured column read "(nothing — fill in Excel)".** The dropdown
  marks an option selected by matching labels against what the FILES supply,
  and the shipped obituary template's sources — `join`, `dateNear`, `presence`,
  `compose` — are none of them. `optionsForColumn` appends the column's own
  source. **Both the renderer and the change handler must call it**: the value
  is an index into that list.
- **The columns table was unreadable.** `.screen.wide` had never worked — a
  child cannot exceed its parent's max-width, and `#app` capped everything at
  760px. Plus no column sizing, so one 74-character schema path took the width
  the source column needed.
- **The model pass ran silently.** Measured on the operator's own machine: the
  first call takes **48 seconds** while Ollama loads `llama3.1:8b`, warm calls
  about **4**. One call per eligible cell, in sequence. It now reports per cell
  as it goes, and `asking` is emitted BEFORE the call.
- **The model name was typed blind.** `listModels` asks the endpoint what it
  offers — `/v1/models`, part of the OpenAI-compatible contract, so it is not an
  Ollama feature. Advisory only: an endpoint without it leaves the box usable.
- **A windowed operator was told to run a CLI command.** `DEFAULT_LOGIN_HINT`
  moved to its own module so the sandboxed renderer can import it, and
  `errorMessage` substitutes a desktop instruction — at the one place every
  `window.oeq.*` rejection already funnels.
- **An OAuth site failed to list collections instead of saying it needed
  signing in.** Task 1: `hasToken` is asked BEFORE the attempt.

### Two facts worth keeping

- **A 403 with an empty body from openEQUELLA means a REJECTED ACCESS TOKEN.**
  Measured against the live instance: no header, a malformed header, a session
  cookie and a Bearer token are all answered 200 as the guest; only
  `X-Authorization: access_token=<invalid|empty>` gives 403 with zero bytes.
  That is how the whole auth-mode defect was found.
- **The dev build and the installed app do NOT share a settings store.**
  Electron derives `userData` from the app name, and `electron dist-desktop/...`
  has no package.json at its root, so it falls back to `Electron` and writes to
  `%APPDATA%/Electron`. The isolation is right — a dev run must not overwrite
  the credentials staff use, and one did during this investigation — but it was
  invisible, and it cost hours: saves looked lost because the file being watched
  was the other one. **Setup now says which store is in use.** Anyone preparing
  a packaged build for a demo must configure it separately.


**Start here, not with the language-model work.** The operator ran the desktop
app against `content-test.byui.edu` and could not get past the Choose screen.
The diagnosis is finished; the fix is not written.

### The symptom, and the whole chain

The collection box read:

```text
GET /api/collection?privilege=CREATE_ITEM&length=100&full=true failed: 403
```

**403 with an empty body and no reason phrase.** Measured against the live
instance, unauthenticated, while diagnosing — that signature has exactly one
cause:

```text
no auth header        -> 200 (guest, available:29, results:[])
malformed header      -> 200
session cookie        -> 200
Bearer token          -> 200
invalid access_token= -> 403, zero-length body   <-- the signature
empty   access_token= -> 403, zero-length body   <-- also matches
```

Only `OAuthClientCredentials` and `AuthorizationCodeAuth` emit
`X-Authorization: access_token=`. `UsernamePasswordAuth` sends cookies and never
touches it. So **the app was signing in with OAuth while the operator believed
they were using a username and password**, and openEQUELLA refused the token.

**Why it was in OAuth mode — the actual defect, and it shipped in v1.1.1.**
`Instance` carries `authMode` (`secrets.ts`, documented there as "how this site
signs in; carries no secret") and it reaches the renderer. But
`ui/app.ts`'s site-change handler rebuilds the form as
`blankSetupFields()` plus `baseUrl, label, attachmentUuidPath, live,
redirectUri` — **and drops `authMode`**, which `blankSetupFields` hardcodes to
`'password'`. So:

- the sign-in radio always comes back on "Username and password", whatever the
  site is really set to;
- `clientId` and `redirectUri` are worse — they live in the encrypted settings
  and **no IPC exposes them at all** (`getPassword` returns `{ username }` and
  nothing else), so the OAuth boxes cannot be repopulated even in principle.
  The operator reported exactly this: entered a client ID and secret, saved,
  reopened, and both were blank with the radio unchecked;
- an operator therefore cannot see how a site signs in, and re-saving from a
  form showing defaults can silently change it.

**This is the same defect class as the `setDefault` bug fixed this morning: a
form that rebuilds a record from defaults and silently discards the fields it
does not display.** Here the discarded field is *how you sign in*.

### What to do next, in order

1. **Seed `authMode` from the selected instance** in `ui/app.ts`'s site-change
   handler. Small, no IPC change, and it stops a save silently flipping a
   site's sign-in method. Do this first.
2. **Expose a non-secret view of stored credentials over IPC** — `clientId` and
   `redirectUri` returned, the client secret NEVER, mirroring how the password
   is handled today ("Signed in as …" plus a Forget button rather than the
   value). The OAuth section then shows "client secret stored" instead of a
   blank box that reads as unconfigured. **The operator had not agreed the
   shape of this when the session ended — ask before building it.**
3. **Unverified and important:** the operator was asked to select "Username and
   password", save, and report whether the collection list then works. **That
   answer never arrived.** If it still fails, the save itself is not taking
   effect and there is a third bug in play. Get that answer before trusting
   either fix above.

### Two facts established live, both worth keeping

- **A 403 with an empty body from openEQUELLA means a REJECTED ACCESS TOKEN.**
  Nothing else in the request produces it — not a bad cookie, not a malformed
  header, not the absence of credentials, all of which are answered 200 as the
  guest. Diagnostic gold, and it is how this was found.
- **A collection LIST entry does NOT always carry `schema: { uuid }`.**
  `CLAUDE.md` records that it does, "confirmed live 2026-08-12" — but that was
  **production**. On `content-test`, with and without `full=true`, all 29
  entries carry only `uuid, name, nameStrings, readonly, links`. The recorded
  production fixture carries `owner, schema, filestoreId` and the rest.
  **Consequence, waiting behind the auth bug:** once sign-in works here,
  `parseCollections` yields `schema: ''`, so the attachment-field autofill on
  Setup and the schema-derived title path in the duplicate check have nothing
  to read. Corrected in `CLAUDE.md`; not yet handled in code.

### A wrong turn worth not repeating

`schema/swagger.json` documents `full` as "Return full entity (needs VIEW or
EDIT privilege)", which made `full=true` look like the cause. **It is not** —
the operator pasted both URLs into a signed-in browser and both returned 200
with 29 collections. Confirm against the live instance before building on the
spec; this file has now disagreed with the server five times.

### Incidental confirmation

The operator's sign-in completed, which means **the OAuth `state` check added
this session works against the live server** — openEQUELLA echoes `state` back
and the new code accepted it. That path had never been exercised outside tests.

## Historical: branches open on 2026-08-18 — ALL SINCE MERGED OR DELETED

Kept as the record of that session. As of 2026-08-20 no branch is open; see
"No branches are open" above. At the time there were three, none merged:

| Branch | Head | What it holds |
| --- | --- | --- |
| `feature/llm-provider` | profile-editor stage 1, security hardening, the error-message fix | the main line of work |
| `fix/scrub-operator-identity` | off `main` | the privacy scrub |
| `chore/dependency-advisories` | off `main` | fast-xml-parser 5 |

**Merge the scrub first.** The other two branch off pre-scrub `main` and still
carry the operator's surname (56 and 47 hits); nothing regresses, but merging
the scrub last means re-doing it.

### Two process failures this session, both caught, both worth reading

- **`git add -A` staged the ten real obituary PDFs.** `tests/obits/` was
  gitignored on `feature/llm-provider` but NOT on `main`, and the scrub branch
  was cut from `main`. Caught in the commit output, reset, the ignore rule
  ported over, recommitted, and the abandoned commit purged with
  `git reflog expire --expire-unreachable=now` + `git gc --prune=now`. Never
  pushed. **Do not use `git add -A` in this repository** — name the paths.
- **Backticks in a `git commit -m "…"` message were expanded by bash and
  actually ran `npm audit fix --force`** — the exact command the message was
  documenting as harmful. It downgraded `exceljs` to 3.4.0 and moved `electron`
  and `vitest` across majors in the working tree. The commit itself was
  unaffected (staging precedes expansion); restored with `npm ci`. **Write
  commit messages to a file and use `git commit -F`.**

## Historical: the language-model work, as it stood on 2026-08-18

**Branch `feature/llm-provider`, NOT merged.** `npm test` → **2156 across 104
files**, typecheck, `build` and `build:desktop` all clean, working tree clean.
`main` carries the privacy scrub (PR #14) and has been merged in, so this branch
is 0 behind.

### Security hardening — done, and what it deliberately left

A review of the whole tool on 2026-08-17, prompted by the operator asking what
to tell other institutions. Design and findings:
[SECURITY.md](../SECURITY.md), which is written for adopters rather than for us.
Plan: [superpowers/plans/2026-08-17-security-hardening.md](superpowers/plans/2026-08-17-security-hardening.md).

**Two exploitable findings, both closed:**

- **A document could write a live formula into the spreadsheet.** Excel executes
  a cell beginning `=`, `+`, `-` or `@`, and the extractor writes OCR'd text
  from donated documents into a CSV the operator opens in Excel — the one input
  to this tool an outsider supplies. `src/core/formulaGuard.ts` holds **both
  halves in one module on purpose**: `plan` reads that same spreadsheet back and
  uploads what it finds, so guarding on write without unguarding on read would
  have traded an injection risk for an apostrophe written into a permanent
  catalogue record. `unguardFormula(guardFormula(v)) === v` for every string,
  and a round-trip test asserts what openEQUELLA would actually receive.
- **The OAuth flow accepted any redirect that arrived.** `state` is now sent and
  checked. This matters most for the CLI's loopback capture — an ordinary HTTP
  server on a local port that any process or open web page on the machine can
  reach. The existing end-to-end test fired `state=xyz` at that port and was
  accepted; it now carries the real value, which is what proves the guard works.
  **The CLI's manual-paste flow is deliberately NOT checked and says so**: people
  paste a bare code, and a check that passed whenever the state was absent would
  be the "reports success without running" defect this repo has shipped twice.

Guarded by four mutations, each applied with the Edit tool and watched go red.

**Deliberately not done, each for a stated reason:**

- **The the operator’s surname scrub** — 48 occurrences across 5 test files and 2 docs,
  including this one. `CLAUDE.md` records that it is reviewed as a change of its
  own and kept off this branch; doing it here would break that twice over. **Do
  it on its own branch off `main`.** It is a disclosure in a public repository,
  so it should not wait long.
- **The three `npm audit` advisories.** Checked against the call sites and none
  applies: the `fast-xml-parser` advisory is against `XMLBuilder` and only
  `XMLParser` is used; the `uuid` one needs a `buf` argument nothing passes.
  Both fixes are breaking majors, one to `exceljs`, which writes every
  spreadsheet. The analysis is in `SECURITY.md` so nobody force-upgrades on a
  red audit line before a release.
- **The password in openEQUELLA's login query string.** Not fixable from here —
  the API declares no body form. TLS covers it in transit; server and
  load-balancer access logs may hold it at rest. Documented for adopters.

**None of it has been driven through the desktop app.** The desktop sign-in
window's state check in particular has no test — a `BrowserWindow` is not
constructible in this suite — so it is verified by reading only.

### The two profile-editor defects are FIXED — stage 1 is built

Read this as the record, not as a queue. Both were reachable from the Extract
flow's columns screen, both damaged the one template that ships, and neither
was caught by the 2069 tests passing at the time.

- **`setDefault` (`src/core/extract/columns.ts`) dropped half the column.** It
  rebuilt one from a list of fields — `path`, `sources`, `transform`, `locked`,
  `default` — and so discarded **`as`, `flagIfEmpty` and `composeOnly`**.
  Typing a default into the Alumni Obituary template's `MWDL/coverage` column
  destroyed its `as: birth_date` alias, after which the description's `compose`
  template named a column that no longer existed and `parseProfile` would
  refuse the saved profile. It now **copies the column whole**, so a ninth
  field added to `Column` is preserved on the day it is added rather than the
  day someone remembers the list. (The rebuild carried a comment blaming
  `noUnusedLocals` for it. That option is not enabled in this project and never
  has been — `CLAUDE.md` already says so.)
- **The columns screen collapsed the source chain.** It read
  `column.sources[0]` and wrote back a one-element list, so choosing anything
  from the dropdown replaced the whole ordered chain. Touching the description
  column's dropdown on that same template **silently switched the language
  model off**. It is now `setFirstSource` — element 0 is replaced, or removed
  by the blank option, and the rest is left alone. Put in
  `core/extract/columns.ts` beside `setSources` rather than in the controller,
  because the rule is about editing a profile and not about a screen.

Two things came with the fix:

- **The dropdown now offers "A language model."** That was the operator's
  actual complaint — turning the model on for a column otherwise means
  hand-editing JSON. Its label is `describeSource`'s, because the screen marks
  the current option by comparing label strings and a hand-written one renders
  a dropdown that never shows what a column is already set to. **When** a model
  may write is untouched and stays unconfigurable: an empty cell or a flagged
  one, never a stated value.
- **A column whose chain is longer than one says so beside the dropdown**, and
  names the later sources rather than counting them. The design proposed *"and
  1 more, shown when this column is expanded"*; stage 1 ships no expansion, and
  a hint pointing at a control that does not exist is exactly the kind of claim
  this project keeps retracting.

**Guarded by four mutations, each applied with the Edit tool and watched go
red** (never a `sed` pattern with `\n` in it — the working copy is CRLF and
this project has twice had a mutation silently not apply). The strongest test
is in `tests/extract/templates.test.ts`: both editing operations applied to
every column of every *shipped* template, comparing the whole profile. It
passed the moment it was written, which proves nothing, so both defects were
reintroduced and it was watched to fail on each.

**Stages 2–4 of
[the profile-editor design](superpowers/specs/2026-08-17-profile-editor-design.md)
are not built** — the ordered source-chain editor, the profile-wide
`aiInstruction` field, and showing the settings the GUI does not edit. Stage 1
stands on its own; nothing below depends on it.

**Nobody has driven this through the app.** It is a GUI change on a branch of
which that is already true, and this project's record on GUI changes verified
only by tests is unambiguous — see *What is genuinely outstanding* below.

**The nine review findings this block used to list as a queue are CLOSED**
(`29061f9`). Every one has a test, and eight mutations — including all four the
review found surviving — were run and confirmed red. Do not go looking for them;
the record of what was wrong is under *What the hardening established* below,
kept as history rather than as work.

### The one-paragraph version

A language model was wired in as a last-resort source for cells extraction could
not fill. Run against a real batch it **fabricated**: 2 of 10 generated
descriptions asserted facts the documents do not contain, including a full death
date for a document stating no date at all — three runs at temperature 0, three
different dates. `src/core/ai/verify.ts` now refuses a generated value carrying
a claim the document does not support, and the layer has since been hardened
against the defect that made it depend on a model's formatting habits. It has
been re-run against the same batch with a capable model: **8 of 8 written
outputs follow the house style, the same 2 were refused, and nothing ungrounded
reached the spreadsheet.** The sample is still ten documents, one collection,
one language.

### What the hardening established — closed, `29061f9`

Read this as the record, not as a queue.

- **A date with no year was never checked at all**, so `He died on January 6.`
  over a document stating no date was written into the catalogue. That was the
  founding failure surviving inside the layer built to stop it. `FORMS` was
  rebuilt around the rule that **a month name, or a day-and-month pair, is a
  claim whether or not a year sits beside it.** Now refused where it was written
  before: `He died on January 6.`, `Jan. 6`, `the 6th of January`, `1/6`,
  `January 6, aged 87` over a year-only document, `in January`,
  `2024-01-06T00:00:00Z`, `2024-01-06 12:30`, `in January of 2024`,
  `January the 6th, 2024`, `6.1.2024`.
- **Precision ranking was replaced by a `Reading`** — a date decomposed into the
  parts the text actually stated — with one rule, `entails`: every part the
  claim states must be stated, and equal, in the document's. `new Date` is gone
  from the path; month names resolve through a stem table, so every reading is
  calendar-validated and `2024-02-30` is not a date.
- **Twelve classes of false rejection fixed**: `.`-separated dates, two-digit
  years, `the 6th of January`, thousands separators, spelled numbers above
  ninety-nine, ordinal words, `a dozen`, `three and a half`.
- **A UTF-16/code-point desync in `blank()`** let an emoji in the reply shift
  the mask — enough of them and a fabricated number went unmasked and was
  written. Note `quoted()` in `fill.ts` is *correctly* code-point-based; they
  are not the same problem.
- **The year↔number equivalence is symmetric and is NOT guarded** — pinned by
  test and stated in the docblock, because guarding it means reading prose.
- **Four surviving mutations killed**, of which one was dangerous: **a single
  blank string in a profile's trigger list silently disabled the assertion
  check** for that source, because `includes('')` is true of every string. A
  check reporting success without running, inside the module that exists to
  prevent exactly that.
- **The tool no longer says "the document states no such date."** It says no
  date *it can read* supports the value. **It reads English month names and
  numeric forms only**, and that is stated rather than silent — in `verify.ts`,
  in `MONTH_NAMES` in `src/core/extract/dates.ts`, in the README and in
  `docs/INSTALL.md`.

### The second run — a capable model, 2026-08-16

Same ten scanned obituaries, `llama3.1:8b` on a GPU, where the first run was
`llama3.2:3b` on CPU. 140 seconds for ten documents.

- **8 of 8 written outputs follow the house style**
  (`Died 2024-01-09; Born 1935-04-03; Attended Ricks College.`). With the 3B
  model about three of eight did — the rest prepended names, gave an age where a
  death date belongs, or wrote prose sentences naming a hospital. **The house-style
  failures were model capability, not prompt wording. Do not elaborate the
  instruction.** That was the open question this block used to carry as a guess;
  it now has an answer.
- **The same two documents defeated both models.** One states no date of any
  kind; the other never mentions the institution it claimed. Both were refused
  by both runs. Capability did not help there, which is the argument for
  verification rather than better prompting.
- **Nothing ungrounded reached the spreadsheet**, confirmed by an independent
  audit against the source documents.
- **The hardened verifier was re-checked against both models' stored output:**
  2 of 2 fabrications still caught, 8 of 8 good descriptions still kept, zero
  false rejections.
- **Caveat, and it must be stated wherever the result is:** that run passed the
  date checks partly because `llama3.1:8b` answers in ISO format. Evidence
  within a sample of ten, one collection, one language — not coverage.

### What is genuinely outstanding

- **Nobody has driven this through the desktop app.** Nothing on this branch has
  been exercised in the GUI. This project's record is that one screenshot of an
  empty dropdown produced six defects with 1236 tests green throughout, and every
  serious fault here has lived at a boundary the tests do not cross.
- **Whether the eight kept descriptions are *good* is still a human judgement.**
  The 8B result is strong evidence they now follow house style, which is not the
  same as being worth cataloguing. Groundedness is not quality and no test can
  answer it.
- **This branch predates the privacy scrub.** `feature/llm-provider` branched
  off `main` before PR #14, so it still carries real dates in `dates.test.ts`
  and elsewhere. **Merge `main` in once #14 lands**, or the LLM PR will read as
  re-introducing them.
- **the operator’s surname in 40 fixtures, and the phrase in published history** — both
  unchanged, both below under *Two privacy items*.

### The local model runtime, and why the diagnosis is kept

Recorded because an adopting institution pointing this tool at a local runtime
will hit runtime problems that look like tool problems.

Every model returned HTTP 500 with `ROCm error: invalid device function`, and
llama-server died with `0xc0000409`. **It was not the tool and not the model.** A
user environment variable `HSA_OVERRIDE_GFX_VERSION=11.0.0` forced ROCm to load
kernels built for a discrete gfx1100 card onto an *integrated* Radeon 860M
(gfx1150). Removing it, plus setting `OLLAMA_IGPU_ENABLE=1` — Ollama
deliberately drops integrated GPUs from the Vulkan path, and says so in its own
log — gave a working Vulkan backend with all layers offloaded.

**The diagnostic route generalises: read the Ollama server log and see which
library and which GPU it chose.** The earlier CPU-only workaround
(`HIP_VISIBLE_DEVICES=-1`, `ROCR_VISIBLE_DEVICES=-1`, `OLLAMA_LLM_LIBRARY=cpu`
on port 11435) is superseded and no longer needed. Operator-facing versions of
this are in the README and `docs/INSTALL.md`.

**Then** open the PR.

### Two privacy items, both outstanding

- **the operator’s surname appears in 40 test fixtures across four files**, and the same surname once
  in `tests/passwordAuth.test.ts`. The operator's real surname, not a botanical
  pseudonym, in a **public** repository. Deliberately kept off this branch so it
  can be reviewed on its own.
- **Real document text is in published history.** The phrase *"in the early
  hours of Saturday morning"*, quoted from a real scanned obituary, reached
  `verify.ts` and two fixtures during this session and was removed in `a238858`
  — **but it was already on `origin/main`** in three commits from the
  collection-templates work (`7897136`, `4156bfe`, `7f8ad6d`). Removing it from
  published history is a separate decision, not a code change.
- `tests/obits/` and a bare `obits/` are now gitignored (`481cf1a`). They
  arrived **untracked and not ignored**, one `git add -A` from publishing ten
  scanned obituaries naming real people with their dates.

### Reproducing the run

```bash
npm run build
OEQ_MODEL_BASE_URL=http://127.0.0.1:11434/v1 OEQ_MODEL=llama3.1:8b \
OEQ_MODEL_TIMEOUT_SECONDS=600 \
  node dist/cli/index.js extract --dir "tests/obits" \
    --profile templates/alumni-obituary.profile.json --out out.csv --ai
```

The first run used `llama3.2:3b` on port 11435, which was the CPU-only
workaround for the GPU fault described above. Neither is needed now.

Fires on **1 of 10** rows with the shipped template — that is the eligibility
rule working, not a fault. To get ten outputs to read, copy the template and
give the description an `{ "ai": true }` source alone. **That scratch profile is
for evaluation and must never ship**, and the eligibility rule must not be
loosened to make an evaluation easier.

## Historical: "START HERE" as it read on 2026-08-14

1. `npm install && npm test` — expect **2149 passing across 104 files**.
   `npm run typecheck`, `npm run build` and `npm run build:desktop` are all
   clean.
2. **You are probably on `feature/llm-provider`.** It **is not merged**, and it
   branched off `main` before the privacy scrub. `main` carries **v1.1.1**. The repository is **public**
   (`byui-library/openEQUELLA-Bulk-Uploader`, Apache-2.0) — spec 2 happened;
   anything committed here is world-readable.
3. **The language-model feature has been run against two real models, and both
   fabricated on the same two documents.** A verification layer refuses a value
   the document does not support, and has since been hardened so that it no
   longer depends on a model answering in ISO. See "The language model: run
   against a real model, and guarded" below before touching any of it.
4. **Three things you must not assume.** All are below in full; each would be
   an expensive mistake:
   - **A session behind a load balancer needs EVERY cookie, not just
     JSESSIONID** — and openEQUELLA serves an unroutable session as *guest*,
     200, rather than rejecting it.
   - **A 200 from openEQUELLA is not proof anybody is signed in.** `guest: true`
     on `/api/content/currentuser`, and `available > 0` with an empty
     `results`, are the two reliable signals.
   - **The attachment-uuid field is institution-specific and not required by
     openEQUELLA.** The file attaches through the attachment API regardless.
     BYU-Idaho needs it because BYU-Idaho's *own web wizard* writes it — that
     is the test, and it generalises: contribute one item through openEQUELLA's
     interface and match what it produces. `item/attachments/attachment/uuid`,
     which the sync documentation names, is **generated** by openEQUELLA and is
     not in the schema; nothing writes it.

## The language model: run against a real model, and guarded — 2026-08-14

**All 14 tasks of
[the plan](superpowers/plans/2026-08-14-llm-provider.md) are implemented on
`feature/llm-provider`.** One OpenAI-compatible provider serves a local runtime
or a hosted endpoint; `src/core/ai/` holds the rule, the slicer, the prompt,
the provider, the fill pass, the verification and the confirmation. `CLAUDE.md`
carries the domain facts this established — read those before changing any of it.

**It has now been run against a real model**, which is the thing this section
used to say had never happened: ten scanned obituaries, `llama3.2:3b` served
locally by Ollama, on 2026-08-14. Ten generated descriptions and the 1-of-10
eligibility figure below are not in conflict — the shipped template sends almost
nothing, so getting ten outputs to read means the scratch evaluation profile
Task 13 prescribes, never a loosened rule.

**What it found: the model fabricates, and the prompt does not stop it.** 2 of 10
generated descriptions asserted facts the source documents do not contain — an
affiliated institution neither document mentions, and in one case a full death
date for a document that states **no date of any kind**. The shipped prompt says
*"Use only what the document states. Do not invent names, dates, places or
events"* and the profile instruction says to include the affiliation clause only
where the document supports it. Neither held.

**It is not a misreading.** The dateless document was processed three times at
temperature 0 and produced three different death dates. It is generating a
plausibly shaped value to fill a slot.

**Everything downstream behaved correctly, which is the point.** The cell was
flagged, `_source` read `ai`, the note told the operator to check. **A flag is
not a guard**: in a collection with no moderation workflow, a fabricated date a
reviewer skims past is permanent and indistinguishable from a real one.

**What was built in response: `src/core/ai/verify.ts`**, commit `8224934`. Every
generated value is checked against the whole document before it is written, and
`fill.ts` refuses the **whole** value if any checkable claim is unsupported —
never a repaired one, because this tool does not edit generated prose. Built from
invented fixtures only, then run against those ten real documents it had never
seen: **2 of 2 fabrications refused, 8 of 8 supported descriptions kept, zero
false rejections.** The refused row ends with an empty cell, no `ai` in
`_source`, and a note naming each unsupported claim. The design records the three
decisions and their reasoning under "Verification: what may be written into a
cell".

**What the second run settled, and what it did not.** Re-run on 2026-08-16 with
`llama3.1:8b` on a GPU, the same ten documents produced **8 of 8 written outputs
in house style** where the 3B model managed about three of eight — so the
house-style failures were **model capability, not prompt wording**, and the
instruction should not be changed. The same two documents were refused by both
models, and an independent audit against the sources confirmed nothing
ungrounded reached the spreadsheet. What that does **not** settle is whether the
kept descriptions are worth cataloguing: groundedness is not quality, following
a house style is not quality either, and no test can answer it. Note also what
verification cannot do — it catches a claim the document does not support, and
it cannot tell whether a supported date is attached to the right person. A model
can still say something false using only true tokens.

**A normal batch fires on almost nothing, and that is now measured rather than
predicted: 1 of 10 rows** on the shipped template. The plan's original premise
was wrong — it claimed tier 3 flags every obituary row so every row is eligible.
The shipped template's description uses `compose`, which attaches no note, and
has no `{ opening: true }` source at all, so the model fires only where `compose`
produced nothing: the death date, the birth date **and** the Ricks mention all
missing at once. That happened on one document of ten. **Do not read that as the
feature being broken, and do not loosen the eligibility rule to make an
evaluation easier** — build a batch that genuinely defeats extraction, or use a
scratch profile that is never shipped.

**Why the rule is not loosening**, decided 2026-08-14 on archival grounds: a
description assembled from extracted facts is evidence with a traceable origin,
and `_source` records one origin per cell, so replacing it would merge verified
fact and machine assertion with no way to tell them apart. An incomplete but
traceable description outranks a complete but unverifiable one. The model may
fill a gap; it may never overwrite one.

**Worth doing eventually:** `flagged` currently means both "a human should check
this" and "the model may replace this". An incomplete composed value deserves
the first and not the second. Separating them is the honest version of what
"let the model improve a partial description" was reaching for.

**Known, not fixed:** the operator’s surname appears in 40 test fixtures across four files,
and the same surname once in `tests/passwordAuth.test.ts`. Both are the operator's real
surname rather than a botanical pseudonym, both violate this repo's own rule,
and the repository is now public. The scrub was deliberately kept out of the
LLM branch so it can be reviewed on its own.

### What v1.1.1 adds, and why

Every item came from the operator installing v1.1.0 and using it — none from a
test. Recorded because the pattern is the point: the wording that confused
them is also what emptied their stored setting.

- The attachment field says what it *is* (a metadata copy of an ID openEQUELLA
  already holds), **fills itself** from the chosen collection's schema when
  that schema declares exactly one candidate, and carries a note about the
  sync path so a reader of openEQUELLA's own documentation is not misled.
- **Blank is no longer called correct before anything has been checked.** On
  the first pass through Setup there is no collection, so no schema — and the
  field used to answer "correct for most schemas" anyway. That is how the
  operator's real stored path ended up empty.
- **Setup is reachable from Choose and from Results**, has a Back that clears
  nothing, and both screens can sign out. The app had a red banner naming the
  site with no way to act on it.

### What this branch built

The tool was hardcoded to BYU-Idaho. It now works at any openEQUELLA
institution:

- **Username and password sign-in** (`OEQ_AUTH_MODE=password`,
  `src/core/passwordAuth.ts`). OAuth stays for SSO sites like BYU-Idaho, behind
  an *Advanced* disclosure on the desktop Setup screen. Note the env default is
  still `code` — the *desktop UI* defaults to password, which is a different
  thing, and `runPreflight` reports which mode was actually used because
  confusing the two produces openEQUELLA's `client_id (null)`.
- **Collections and schemas come from the API** (`src/core/discovery.ts`).
  Setup lists what the account can contribute to; the collection carries its
  schema uuid. Nobody types a uuid or exports XML any more.
- **The instance list ships empty.** Operators add their own address on Setup.
  **Stored v1.0.0 credentials are discarded** — the store version went to 3 and
  Setup explains the blank form in one sentence. Deliberate clean break, not an
  accident; the reasoning is in the plan under Task 11.
- **Nothing institution-specific is read at runtime.** Title path from the
  schema's `namePath`, description from `descriptionPath`, identifier matched
  by leaf name, attachment-uuid field per-instance configuration defaulting to
  **writing nothing at all**.
- **A per-instance "this is a live site" flag**, defaulting ON, drives the loud
  red banner. Without it, deleting the shipped instance list made the warning
  fire on every site, and a warning that fires on everything is not one.
- **`oeq-upload check` is now the compatibility probe** — nine checks, each
  saying what a failure means for a real run.
- **`logout` ends the server session** (`PUT /api/auth/logout`) when it holds a
  live password provider. A plain one-shot `oeq-upload logout` holds none and
  makes no request; it says so rather than claiming a logout it did not do.

### The whole flow was driven by hand, end to end — 2026-08-13

**The operator ran the desktop app against `content-test.byui.edu`, signed in
with an ordinary openEQUELLA account, listed collections, chose one, and
uploaded a real batch.** Not a unit test, not a probe: the application, doing
its actual job, at an institution's real instance, with password sign-in.

That is the first end-to-end confirmation this branch has, and it is the only
kind that has ever caught anything here — **six defects came out of one
screenshot of an empty dropdown**, with all 1236 tests passing throughout:

1. `UsernamePasswordAuth` kept only `JSESSIONID` (below).
2. `currentUser()` discarded `guest`, so `check` reported *"Identity ok —
   logged in as guest"*.
3. `parseCollections` could not tell a withheld list from an empty one.
4. `listCollections` omitted `full=true`, so no collection carried its schema.
5. The live-site checkbox and the attachment field were never rendered on the
   add-a-site pass — the one pass every operator makes.
6. The identifier pre-flight resolved nothing and said nothing.

### Password auth: VERIFIED live, 2026-08-12 — and it found a defect

**Superseded.** This section used to read *"password auth is unverified
live"*: `POST /api/auth/login` was in the captured swagger and
`UsernamePasswordAuth` had 20-odd unit tests against a stubbed server, but no
instance had ever answered a real login request from this code. BYU-Idaho's
accounts are Okta-backed, so the one site then available could not test it, and
Task 1 Step 3 of the plan — the probe that would have — was not run.

**It has now run.** On **2026-08-12**, against **`https://content-test.byui.edu`**
with an ordinary openEQUELLA account, `POST /api/auth/login` returned **200 and
authenticated as the real user**. The endpoint, the query-string credentials
and the flow are all confirmed.

**The probe refuted a fourth assumption the entire test suite agreed with.**
Recorded here the same way `?file=` and `showall=false` were:

- **A session is the WHOLE cookie jar, not JSESSIONID.** One sign-in response
  set four cookies — `AWSALB` (124 chars), `AWSALBCORS` (124), `JSESSIONID`
  (32), `ROUTEID` (2). Which of them were sent back decided who the instance
  thought you were:

  | cookies sent back | identity reported |
  | --- | --- |
  | first `JSESSIONID` only | `username=guest`, `guest=true` |
  | last `JSESSIONID` only | `username=guest`, `guest=true` |
  | all four | `username=<operator>`, `guest=false` |

- **The instance is behind an AWS load balancer**, and `AWSALB`/`ROUTEID` carry
  the routing state that lands a request on the backend actually holding the
  session. Without them it reaches one that has never seen it.
- **openEQUELLA does not answer that with a 401.** It serves it as **guest,
  200, with empty-but-plausible data.** That is what made this invisible and is
  the reason the desktop app was unusable with password sign-in: the collection
  list simply looked empty, with no error anywhere.
- **Fixed** in `src/core/passwordAuth.ts` — the provider stores every cookie
  from the sign-in response and `authHeader()` emits all of them. `getToken()`
  still returns the JSESSIONID value, which is the credential identifying the
  session; the routing cookies identify a backend and mean nothing to a caller.
  Guarded by the `cookie jar` block in `tests/passwordAuth.test.ts`, which
  carries the measured numbers above.

The lesson generalises past this codebase: **a 200 is not proof of identity.**
If a probe cannot say *which user* the server thinks it is talking to, it has
not verified sign-in.

### Spec 2 has happened — the repository is PUBLIC

**Superseded.** This section used to say publishing had not started. As of
2026-08-14: `LICENSE` exists, `package.json` declares `Apache-2.0`, the README
carries a section written for outside readers, and `gh repo view` returns
`"isPrivate": false`. History is 298 commits, not the ~196 estimated here.

**Anything committed to this repository is world-readable.** That changes what
may safely go in a fixture, a comment or a doc — see the pseudonym rule in
`CLAUDE.md`, and the the operator’s surname note above, which is now a public exposure
rather than an untidiness.

### What the probe found — 2026-08-12, content.byui.edu

Recorded here in the same way the `showall=false` and `?file=` findings were,
because this codebase has now had **three** live probes refute assumptions the
entire test suite agreed with. Fixtures are committed under
`tests/fixtures/api/`, trimmed of `security` blocks and scrubbed of owner
uuids. `scripts/probe-instance.mjs` is committed so any institution can re-run
it against their own site.

- **`GET /api/collection?privilege=CREATE_ITEM&full=true` works**, returning
  `{ start, length, available, results }` with `available: 29`.
- **A collection LIST entry already carries `schema: { uuid }`**, so Setup
  needs no per-collection follow-up call — better than the design assumed.
- **Those 29 collections use two distinct schemas.** An institution really can
  have more than one, so the discovery design is not over-engineering.
- **The declared title path is `namePath`, not `itemNamePath`** as the XML
  export spells it. Value `/MWDL/title`, alongside
  `"descriptionPath": "/MWDL/description"` — so BYU-Idaho's behaviour is
  unchanged once the value is *read* rather than assumed.
- **`definition` is nested JSON, not XML.** `parseSchemaPaths` cannot be reused
  on the API path; a tree-walker is required. (`serializedDefinition` does
  carry the XML string, but parsing JSON we already have would be perverse.)
- **Cross-checking that walker against `parseSchemaPaths` on the same schema
  found three bugs in the version the plan specified** — 158 paths from the XML
  export against 227 from the naive walk. It must strip the `xml` root, emit
  **leaves only** (the 70 extras were containers, which cannot hold a value),
  and treat `@attr` as an addressable segment rather than skipping it
  (`item/oai/id` was the single path the walk missed; `_`-prefixed keys are
  metadata and *are* skipped). **That cross-check is now the test**: both
  sources describe one schema, so any disagreement is a bug in one of them.
- **Password login was NOT probed here** — this instance is Okta-backed. It was
  probed separately on `content-test.byui.edu` the same day; see the password
  auth section above for what that found.

### Known seams left open, on purpose

- **`plan` reads the schema from `--schema-file`; `runPreflight` reads it from
  the API.** They can disagree — a schema edited on the server since the export
  was taken. Not made worse by this branch. If it is closed, the API is the
  authority and the local file is the offline fallback.
- **`schema/_entity.xml` is still `--schema-file`'s default**, so the CLI's
  last institution-specific default is BYU-Idaho's schema export. Another
  institution must export and pass its own.
- **The desktop runs no probe at the end of Setup.** The design said it would
  show the same lines as `oeq-upload check`; it does not. Saving credentials
  validates locally, then the app advances to Sign-in. The collection list
  refresh after saving is the only live call, and its result is visible on the
  next visit to Setup.
- **Apostrophe escaping in a `where` clause is still assumed.** `Bach's
  Prelude` sends `Bach''s Prelude`; no live title has exercised it.

## Historical: where things stood at v1.0.0 (2026-08-10)

Everything below this line predates the institution-agnostic branch and is kept
because it records how each fact was established.

Released as **v1.0.0** on 2026-08-07 -- the first release since v0.1.0, carrying
the extractor, duplicate prevention, collection templates and the Windows
sign-in fix. To cut another: bump package.json, tag `vX.Y.Z`, push the tag.

Sign-in is confirmed working on **both** instances; there is no open loop there.

### The AI description tier — deferred, then built

**Superseded.** The operator deferred it on 2026-08-10 (*"Let's hold off on the
ai piece for now"*) and un-deferred it on 2026-08-14, widening it to "any of
the major AI LLMs including local models". It is built on
`feature/llm-provider` — see "The language model: run against a real model, and
guarded" at the top.

Tiers 1–3 still fill the description without a network call, and **that remains
the behaviour wherever no endpoint is configured**, which is the point: with
nothing set up, nothing is contacted and nothing is sent.

### What is waiting on the operator

- Copy the Setup installer to the network share.
- Clean-machine test v1.0.0, especially the template chooser from an
  installed build rather than a dev run.

Both done as of 2026-08-10: the OAuth secret is dealt with, and the duplicate
items created on 2026-08-06 have been deleted from production.

### The next thing worth building, when something asks for it

**md5 matching for renamed re-uploads.** Every attachment in a search result
already carries an `md5`, so the cheap half costs no extra request. Recorded
in full at the end of
[2026-08-06-duplicate-prevention-design.md](superpowers/specs/2026-08-06-duplicate-prevention-design.md).
Not started, and not worth starting until a renamed re-upload actually bites.

### What happened in the session of 2026-08-06

A long one. In order:

- **Description extraction tiers 2 and 3 built** — a named section
  (`Abstract`, `Summary`, …) then the opening paragraph. Every description
  cell that was blank on three previous runs is now filled.
- **The operator ran it on 30 real documents twice**, and reading their output
  found four faults: a journal citation block riding along with an abstract,
  trailing page furniture on two more, a heading that was really a word inside
  a sentence, and twelve warnings about a filename pattern nothing was reading.
  All fixed, all verified against the same files.
- **A filename fallback for the title**, because two of twelve journal PDFs
  state no title at all and that field becomes the item's NAME in openEQUELLA.
  Those two would have been contributed nameless.
- **The CLI was getting none of the description evidence.** Found by re-running
  the extract → plan round trip: 14 items planned, 14 titles, **0
  descriptions**. `--init-profile` read only the filenames. Evidence-gathering
  now lives in `core/extract/evidence.ts`, shared by both front ends.
- **PR #3 merged.**
- **The Done screen was a dead end** — no way to start another batch without
  restarting the app. Now has "Upload another spreadsheet".
- **Duplicate prevention designed, planned, and its core built.** The operator
  uploaded the same 30 files twice and the tool said nothing.

### Running the desktop app

```bash
npm run build:desktop
npx electron dist-desktop/desktop/main.js
```

**Unset `ELECTRON_RUN_AS_NODE` first if it is set** — this sandbox sets it, and
it turns `electron.exe` into plain Node, so the app exits silently with no
window and no error. `npm run desktop` does the same two steps.

The Extract flow is reached from **Choose what to upload → "I don't have a
spreadsheet yet…"**, which means you must sign in to get to it, even though
extraction never touches the network. Test instance is fine.

## Where the project is

**The CLI is finished and has run in production.** On 2026-08-04 it contributed
37 jury videos to BYU-Idaho Faculty Content on `content.byui.edu` — every one
verified by reading it back from the API and comparing md5, size, filename,
attachment count, draft state and the attachment uuid in metadata against the
source file on disk. 5.68 GB in 6.1 minutes, zero failures. A full rehearsal on
`content-test` beforehand was identical and was purged afterwards.

**The desktop GUI is finished, released and merged.** All seven original
screens (Setup, Sign-in, Choose, Review, Confirm, Progress, Results), a fully
sandboxed renderer, per-instance encrypted credentials, and a typed IPC
contract. Released as **v0.1.0** with both installers, and clean-machine tested
by the operator. Merged to `main` as PR #1.

**What is on `main`:** everything. The CLI, the MCP server, the desktop GUI,
the whole metadata extractor (PR #2 and PR #3), duplicate prevention (PR #4),
and collection templates (PR #5 and PR #6).

**What is not merged:** nothing. All six feature branches were deleted locally
and on the remote on 2026-08-10, after confirming each one's content was on
`main`.

## Collection templates: built, reviewed, verified, merged and released

**Merged as PR #5, with the richer obituary description following as PR #6.**
The operator drove it in the app on 2026-08-07 and confirmed the chooser, the
template load and the preview all work. A batch of ten alumni obituaries the
generic extractor could say almost nothing about.

**925 tests across 69 files** at that point, typecheck clean, desktop builds.
(1197 across 78 on `feature/institution-agnostic`.)

### What the operator found by using it

Two things no test caught, both about the moment of decision rather than the
logic:

1. **The preview reported a count and nothing else** — "1 need review" — so the
   note text reached them only in the saved CSV's `_notes` column. This whole
   feature rests on being flagged rather than silent, and the flag was
   invisible on the screen where the batch is judged. There is now a "Needs
   review" panel naming each flagged row and its reasons.
2. **Both notes stated an observation and gave no guidance.** They now say what
   to do and why. The empty-field note in particular says *"or leave it blank
   if the document genuinely does not say"* — because one obituary really does
   not state a date, so a blank there is CORRECT, and a note that only reported
   the absence invited someone to invent a value. That is the failure this tool
   exists to avoid, and it would have been a bad one to introduce in the very
   mechanism meant to prevent it.

Both messages have tests pinning the GUIDANCE, not the wording, so they cannot
regress to merely stating what was noticed.

**A template is a profile JSON**, in `templates/`, offered on the Extract flow
as "Start from: Generic / Alumni Obituary". Supporting a new collection is
configuration, never code. Four generic capabilities make that possible —
`dateNear`, `datePair`, `compose`, and a `filenameWordsInText` check — and
nothing in the code knows what an obituary is.

**Measured against the ten real files:**

```text
death date found   9 of 10      (the tenth states no date anywhere)
cross-checks       3 of 3       agrees with the numeric header where OCR spared it
Hollis Bracken     2211-04-13   not the 21st, which is his funeral
rows flagged       1            'Larkspar' in the filename, 'Larkspur' in the document
```

**The finding that made this worth building:** the OCR was fine, the wrong part
of the page was being read. These documents state the death date twice — a
numeric header and a sentence. OCR destroyed the header on seven of ten
(`06107/2211`, `0:4`, `0`) while every spelled-out date came through clean,
because letters carry more redundancy than digits. Reading the prose took
recovery from 3 of 10 to 9 of 10 with no change to the scanning at all. Buying
better OCR software would have solved the wrong problem.

**Two traps found and closed during the build**, both of the shape that ships
silently:

- **`PAIR_GAP` was unconstrained.** The test meant to pin it was actually
  protected by letters between the dates, so the constant could have been
  changed to anything without a failure. A subagent noticed and reported it
  rather than moving on.
- **`extraResources` did not ship `templates/`.** The chooser would have been
  empty in a packaged build and full in development. Fixed before an installer
  exists.

**Deliberately not extracted**, and recorded in the spec with the evidence:
cause of death, birthplace, residence, and the Ricks College connection. The
first two cannot be read honestly; the last two are readable at 8 of 10 and
were dropped as not worth the build, because the PDF is attached and a reader
can see them.

**Still not built:** the house-style description synthesis of the existing
records — *"Died May 3, 2208: Fernvale, Idaho, influenza; Born June 5,
2131"* — which needs facts this design does not extract. Tier 4 territory.

**OCR happens outside this tool**, decided the same day. See the
description-extraction design for why.

### What a final review caught, and why it is worth reading

The review executed the shipped modules rather than reading them, and found
five ways a **wrong death date** could reach a permanent record. Read these
before extending the date logic:

- **`died` is a substring of `studied`** — in an ALUMNI collection, where
  "studied at Ricks College" is near-certain. A raw substring search read a
  man's MARRIAGE date as his date of death. Matches now need word boundaries.
- **A relative's death won.** *"preceded in death by his wife Ivy, who passed
  away on January 17, 2186"* appears in nearly every obituary. Nothing can
  reliably tell whose death a sentence describes, so `datesNear` returns every
  candidate and the row is flagged. **Caveat: none of the ten real files
  triggers this**, so it is verified by unit test only — do not read "no
  multi-date flags" on a future batch as proof the guard works.
- **A birth date paired with a funeral date** across a full stop and two
  newlines — the same failure the module already memorialises for Hollis Bracken,
  by another route. The pair gap now excludes sentence and line terminators.
- **`April 13 12345` yielded the year 1234**, which normalises cleanly and
  would never have been flagged.
- **The attachment column could be composed**, producing a row naming something
  that is not a file — the one-file-one-item relationship the tool rests on.
  Rejected at load, and both fill passes now apply the same override.

It also found that the design's promise to flag an empty death date **was never
implemented**: Alden Larkspar was flagged only because his filename happened to
be misspelled too, so correcting that filename would have made the batch's one
genuine failure look clean. Columns now declare `flagIfEmpty`.

### A process note for whoever runs subagents next

Do not instruct `git commit --amend` while another agent is committing to the
same branch. That was done once here, tripped a security warning, and could
have lost work — the history survived, but only by luck of timing. Run agents
on one branch sequentially, or give each its own worktree.

**Committing to a branch after its PR has merged loses the commit silently.**
Two documentation commits were written that way and sat on dead branches for
three days while being cited in conversation as "recorded in the spec" — the
md5 next-step note and the OCR-stays-outside decision. Both were recovered by
cherry-pick on 2026-08-10, which is why they carry later dates than the
sections around them. Nothing warns you: the commit succeeds, the branch is
already merged, and `main` never sees it. **Before deleting any branch, diff
its content against `main` rather than trusting `git branch --merged`** —
merged-ness is about ancestry, not about whether the work arrived.

## Duplicate prevention: built, connected, and verified against real data

**Status: done and working.** On 2026-08-07 the operator fed back the same
spreadsheet and folder that had been uploaded twice, and every row came back
flagged. That was the first time any of it had run against a real finding —
until an hour before, the desktop plan handler returned a hard-coded empty
array, so the whole feature was parts that had never been connected.

**What it does.** One search per pending row, matching `/xml/MWDL/title`
exactly via the search API's `where` clause, with each hit's attachments in the
same response. **Superseded on `feature/institution-agnostic`:** that path is
no longer a literal — it is read from the schema's declared `namePath`, which
at BYU-Idaho *is* `/MWDL/title`, so everything measured below still holds. With
no declared path, every row is reported `could-not-check` and no search is
issued. A filename match is `near-certain` and defaults to **skip**; a
title-only match is `possible` and defaults to **upload**, because two items
can legitimately share a title and silently dropping a real item is worse than
a visible duplicate. Rows the operator skips are written into the manifest as
`skipped`, which the runner already treated as terminal — no runner change.

**CONFIRMED against production**, by pasting URLs into a browser already signed
in to openEQUELLA (the REST API accepts a session cookie — this took seconds,
after an hour lost trying to get the CLI a cached OAuth token):

- `/xml/MWDL/title = 'VALUE'` is accepted, and **genuinely filters** — a title
  known to be absent returns `available: 0`. That was the answer that decided
  the approach was viable at all.
- An attachment's filename is at `attachments[].filename`; `description`
  carried the same value.
- **A result has no `name` field**, even with `info=basic`. This nearly made
  the feature silently do nothing: a guard added in code review compared each
  hit's name to the searched title, and with no name it rejected every hit.
- Each attachment carries an **`md5`** — unused, but it would catch a renamed
  re-upload, which is the one limitation this design cannot see.

**Still UNVERIFIED:** apostrophe escaping. `Bach's Prelude` sends `Bach''s
Prelude` and no live title has exercised it. Marked as such in `client.ts`.

### Two review passes, and what they caught

Both found defects that would have shipped. Worth reading before extending
this, because two are the same shape as bugs this project has already had:

- **A concurrency loop that ran its body exactly once across the whole suite.**
  Replacing it with `slice(0, 5)` — checking 5 rows of a 37-row batch and
  reporting the other 32 clean — passed all 19 tests.
- **`duplicateChoices` surviving a change of spreadsheet.** Review → Back →
  Choose a different sheet → Continue, and the previous sheet's decisions were
  applied by row number to the new one. `clearedForNextBatch()` does NOT cover
  this; it only runs after a completed run, which is why `loadReviewColumns`
  hand-clears the other review fields.
- **The operator's seen decision being discarded**, because `handleUpload`
  re-plans and was overwriting the findings with a set nobody had looked at.
- **The skip filter being untestable.** Inverting it — skipping every row the
  operator wanted kept — passed the entire suite. It is now `rowsToSkip` in
  `ui/duplicates.ts`, and inverting it fails 7 of 8 tests.

### Also fixed on this branch, unrelated

`oeq-upload login` was broken on Windows for every user. `cmd /c start "" <url>`
truncated the authorize URL at the first `&`, so openEQUELLA received no
`client_id` and no `redirect_uri` and said so. The command's own instructions
blamed a cold SSO session for that message and told the operator to sign in
again, which could never have worked. Now `rundll32 url.dll,FileProtocolHandler`,
with `browserCommand(platform, url)` extracted and tested — the defect was
invisible except by reading the argv.

## Historical: how this was blocked

**Why this exists.** On 2026-08-06 the operator uploaded the same 30 files
twice and the tool said nothing. The cause was not a missing feature:
`preflightDuplicates` runs on every plan in all three front ends, but its first
line is `if (!identifier) continue;` against `MWDL/identifier` — a column the
extractor has never produced. It had been reporting "no duplicates" by never
looking.

**It happened a second time, in the same function, and was fixed on
`feature/institution-agnostic`.** `MWDL/identifier` was BYU-Idaho's spelling,
so at any other institution every entry fell into that same skip branch and the
check examined nothing. The path is now resolved off the schema by leaf name,
and where nothing matches the batch gets one warning saying the check did not
run and why — never an empty result, which is how the caller says "checked, all
clean". **Read this paragraph before adding any check that can be skipped.**

- Design: [superpowers/specs/2026-08-06-duplicate-prevention-design.md](superpowers/specs/2026-08-06-duplicate-prevention-design.md)
- Plan: [superpowers/plans/2026-08-06-duplicate-prevention.md](superpowers/plans/2026-08-06-duplicate-prevention.md) — 15 tasks

**Built and reviewed** (Tasks 2, 5, 6, 7 — everything that does not touch the
wire format):

```text
src/core/duplicates.ts   verdictFor, defaultChoice, findDuplicates, TitleSearcher
src/core/plan.ts         markSkipped
src/core/client.ts       escapeWhereValue
src/core/types.ts        TITLE_XPATH, sameFileName
```

**BLOCKED: the probe.** Two assumptions are unverified against the live
instance, and `schema/swagger.json` settles neither — it documents `where` only
as a link to external docs, and its `AttachmentBean` has no filename property
at all:

1. what `where` clause syntax this instance accepts, and whether `''` or `\'`
   is the escape;
2. **whether `where` filters at all** — if it does not, the approach is invalid
   and needs rethinking, not building on;
3. which key in a search result holds an attachment's filename.

`scripts/probe-where.mts` answers all three. It reads only. It needs the
operator's credentials, which is why it is not done:

```bash
OEQ_BASE_URL=https://content-test.byui.edu \
OEQ_CLIENT_ID=<operator> OEQ_CLIENT_SECRET=<operator> \
OEQ_PROBE_TITLE="<exact title of an item known to exist>" \
npx tsx scripts/probe-where.mts
```

It authenticates through `loadConfig` + `createAuthProvider`, the same path the
CLI takes — **not** `OAuthClientCredentials`, which cannot be used against this
instance. Fill the ANSWERS block at the top of the script once it has run.

**Then:** plan Tasks 3 and 4 (mock server `where` support, then
`client.searchByTitle`), then 8–13 (CLI, IPC, handlers, Review screen, Results
label, MCP), then 14–15 (docs, and an end-to-end double upload).

### What the code review of the core caught

Worth reading before writing the rest, because two of these are the same shape
as bugs this project has already shipped:

- **The concurrency loop was never exercised.** Every `findDuplicates` test used
  one or two rows against a limit of five, so the loop body ran exactly once in
  the whole suite. Replacing it with `pending.slice(0, CONCURRENCY)` — checking
  5 rows of a 37-row batch and reporting the other 32 clean — passed all 19
  tests. Two tests now pin it; the mutation was confirmed to fail them.
- **`verdictFor` returned `rowNumber: 0`** for the caller to overwrite. Row 0
  does not exist, and a caller that forgot would produce a finding that
  `markSkipped` silently matches nothing — a skip that does not skip. The
  return type now omits the field so the compiler demands it.
- **Hits were trusted without checking the title.** If `where` turns out not to
  filter, that flags every row rather than none. There is now a local
  case-insensitive title check as well.
- **The title xpath was a bare string literal** — the exact pattern that caused
  the bug being fixed. Now `TITLE_XPATH` in `types.ts`.
- **A comment claimed a verification that had not happened.** `escapeWhereValue`
  said "the escape this instance accepts"; it now says UNVERIFIED, in the
  vocabulary `client.ts` already uses for the attachment payload.

## Commands and the extractor's own documents

- Extractor design: [superpowers/specs/2026-08-05-metadata-extractor-design.md](superpowers/specs/2026-08-05-metadata-extractor-design.md)
- Description tiers: [superpowers/specs/2026-08-06-description-extraction-design.md](superpowers/specs/2026-08-06-description-extraction-design.md)
- Stage 1 plan: [superpowers/plans/2026-08-05-metadata-extractor-stage1.md](superpowers/plans/2026-08-05-metadata-extractor-stage1.md)
- Stage 2 plan: [superpowers/plans/2026-08-05-metadata-extractor-stage2.md](superpowers/plans/2026-08-05-metadata-extractor-stage2.md)

```text
npm test            2149 tests, 104 files
npm run typecheck   clean
npm run build       CLI + MCP -> dist/
npm run build:desktop  Electron -> dist-desktop/
npm run desktop     build then launch
npm run dist        electron-builder -> release/   (CI does this on a tag)
```

**Metadata extractor stages 1 and 2 are complete.** Stage 1 (core + CLI) is
merged to `main`. `oeq-upload extract` builds a spreadsheet from a folder of
PDFs and `.docx` files, driven by a profile. Stage 2 gives the desktop app the
same flow across three screens — choose a folder, edit the columns, save — with
a fully editable column list, a live preview, and an inline undo. It lives on
`feature/extractor-desktop`. Stage 3 (MCP tools) is specified in
[the design doc](superpowers/specs/2026-08-05-metadata-extractor-design.md) but
not planned.

**The desktop flow HAS now been driven by a human**, on 2026-08-05, and it
works: folder chosen, columns edited, a column added, the picker and search
usable. That session found six faults no test caught — see "What live testing
found" below, which is the most useful section in this document.

### The round trip: done, and it found a real bug (2026-08-06)

A spreadsheet produced by the Extract flow was fed back through
`oeq-upload plan`. It failed:

```text
Spreadsheet has invalid column headers:
  '_source' is not a valid xpath.
  '_notes' is not a valid xpath.
```

**The uploader rejected its own extractor's output** — while the README,
INSTALL.md and the Save screen all said it ignored those columns. Every
generated spreadsheet would have needed hand-editing first, and nothing said
so.

Fixed: `validateHeaders` treats any `_`-prefixed column as an annotation —
carried through, reported separately from real metadata, never uploaded — and
`plan.ts` skips them when assembling an item's fields. The three documents that
made the false claim are corrected.

Both halves passed their own tests throughout. Only crossing the boundary
showed it. **Re-run this after any change to either side:**

```bash
npm run build
OEQ_BASE_URL=https://content-test.byui.edu OEQ_CLIENT_ID=x OEQ_CLIENT_SECRET=x \
  node dist/cli/index.js plan --sheet <extracted.csv> --files <folder> \
  --manifest job.json --skip-duplicate-check
```

Dummy credentials are fine — `--skip-duplicate-check` keeps it off the network,
and header validation is what matters here.

Verified after the fix: 12 items planned, four separate `<creator>` elements in
the XML, accents intact, and no underscore-prefixed key anywhere in the
manifest.

**Still outstanding: the same round trip through the GUI** (Choose → Review).
The CLI shares `readSheet` and `validateHeaders` with it, so the format itself
is proven; the Review screen is its own code path and has not been driven.

### Extracting a description: tiers 1-3 done, tier 4 not started

The description column came out empty on nearly every row of three real runs.
It no longer does. Four tiers are tried in order and the first that yields
anything wins; three of them are built:

| Tier | Source | State |
| --- | --- | --- |
| 1 | table cell / label / document property | built earlier |
| 2 | `{ "section": "Abstract" }` — text under a heading | **built** (`src/core/extract/sections.ts`) |
| 3 | `{ "opening": true }` — first substantial paragraph | **built** (`src/core/extract/opening.ts`) |
| 4 | a language model | **built** on `feature/llm-provider`; run against a real model 2026-08-14, and its output is now verified against the document before it is written |

Measured on the operator's own folders after building tiers 2 and 3:

```text
14 of 14 PDFs      12 read from a real Abstract or Purpose section
 2 of  2 Word       1 from a section, 1 from the opening paragraph
 2 flagged          the two that deserved it, and no others
```

The starter profile proposes all three automatically, so a folder of journal
PDFs now arrives with real abstracts without anything being mapped by hand.

Two things are always flagged in `_notes`, and both fired on real files:

- **a section that ran to the 4,000-character cap** — it never reached another
  heading, which usually means the heading was not one. A benefits PDF matched
  "Summary" mid-page and produced 3,996 characters of plan tables.
- **anything from tier 3**, every time. It is the one source that infers rather
  than reads.

Design, with what the building taught that the design did not anticipate:
[specs/2026-08-06-description-extraction-design.md](superpowers/specs/2026-08-06-description-extraction-design.md).

**If you touch tier 3, mutation-test it.** The first drafts of its negative
tests all passed unchanged when the rule each one named was deleted — every one
was failing on the sentence rule by accident. Each test is now written to fail
exactly one rule, and all five rules die under mutation. The check is:

```bash
# flip one rule in src/core/extract/opening.ts, then
npx vitest run tests/extract/opening.test.ts   # must go 17 -> 16
```

**On the LLM tier:** the operator hoped a user could point at their own Claude
Pro / ChatGPT Plus / Gemini subscription. That is not possible - those licence
the chat interface and issue no API key. The agreed approach is one
institutional key distributed like the OAuth client secret already is. The
program must run fully without a key, with the AI tier simply absent.

Subjects and keywords were raised and deferred.

### Two improvements a review found, deliberately not rushed

Both came out of a `/simplify` pass at the end of the session and were left for
next time rather than done hastily. Neither is urgent; both are small.

**1. The renderer/Node split belongs in a tsconfig, not a regex test.**
`tests/desktop/rendererPurity.test.ts` catches `node:` imports reaching the
renderer, and it did catch the real bug. But it is a test, so it only runs when
someone runs tests, and its regexes have known holes: single-quoted specifiers
only, no dynamic `import()`, no re-export chains (`export * from`), and it would
false-positive on an erasable `import type`.

The compiler-level fix: a `tsconfig.renderer.json` scoped to `src/desktop/ui/**`
with `"types": []`, which turns `import 'node:path'` into a compile error on
every `tsc` run. The project already has three tsconfigs, so this is a
well-precedented addition. Keep the test as a backstop; make the compiler the
primary mechanism.

**2. `ExtractScan.starter` is a workaround for a mixed-concern module.**
The renderer cannot call `starterProfile` because `core/extract/suggest.ts`
imports `extname` from `node:path` and pulls in `readers/index.ts`, which drags
in pdf.js and `node:fs`. So the main process computes it and ships it inside the
scan result.

But `isSupported` is a Set lookup on a file extension — genuinely pure. The
impurity is accidental: `readers/index.ts` mixes it with `readDocument`, which
touches disk. Splitting `SUPPORTED_EXTENSIONS`/`isSupported` into their own
node-free module (with a hand-rolled extension parser instead of `extname`)
would let the renderer call `starterProfile` directly, as the original plan had
it, and remove the IPC field plus three comments explaining the workaround.
`core/extract/columns.ts` is already structured this way and the renderer
imports it directly, so the pattern is proven here.

### What live testing found — read this before writing any more UI

Eight faults now, found by a person using the app rather than by any test.
**Every one was invisible to a passing suite**, and the reasons are worth internalising
because they will recur.

1. **Blank white window.** `ui/extract/controller.ts` imported a core module
   that reached `node:fs` three hops down. The renderer is sandboxed, the import
   failed, the whole module graph died. Nothing on the terminal.
   *Why tests missed it: vitest runs in Node, where those imports resolve.*
   Now guarded by `tests/desktop/rendererPurity.test.ts`.

2. **MWDL fields unreachable in the Add-column picker.** Sorted alphabetically
   and capped at 50 rows, and `BYUI_extended` supplies 98 of the schema's 158
   paths — so `MWDL/title` sat at position ~99 and no amount of scrolling
   reached it. *Why tests missed it: the unit tests use four-path fixtures where
   nothing can hide.* Now ordered MWDL first, grouped under headings, no cap.

3. **The search box typed backwards** — "title" arrived as "eltit". Every
   keystroke re-renders, destroying the input; re-focusing without restoring the
   caret leaves it at position 0. *Why tests missed it: pure DOM behaviour, and
   this project has no jsdom.*

4. **Two SHIPPED inputs lost focus after every character** — the Confirm
   screen's item-count box (the publish gate) and the Choose screen's collection
   filter. Same root cause as (3). Unnoticed for months because Draft is the
   default so the publish gate is rarely used. Both now call
   `ui/dom.ts#keepCaret`.

5. **A one-column starter profile** left the operator with nothing obvious to
   do. Now proposes Title, Creator and Description.

6. **A warning that fired on the default setup** — "nothing fills this" beside
   every empty column, including the Description the starter profile now ships
   empty on purpose. A warning that is always present is one people stop
   reading. Removed; the dropdown already says "(nothing — fill in Excel)".

7. **The CSV had no byte-order mark**, so Excel read it as ANSI and every
   accented name appeared as mojibake -- `Ibáñez` as `IbAAza`-style noise.
   The bytes were correct UTF-8 the whole time. Confirmed fixed in Excel.
   *Why tests missed it: they compare strings, and the strings were right. The
   fault was in how another program would read the file.*

8. **The uploader rejected the extractor's own output** over its `_source` and
   `_notes` columns, while three documents said it ignored them. See the round
   trip section above.
   *Why tests missed it: each half was tested against its own idea of the
   format, and the two ideas differed.*

The pattern across all of them: **the tests verify logic, and every one of these
was about behaviour at a boundary the tests do not cross** — the browser
context, the real schema, the DOM, the default configuration, how another
program reads a file, and where two halves of this program meet. More unit
tests would not have helped. Ten minutes of a person using it would have, and
did — eight times.

**Open question worth deciding:** whether to add jsdom. It would have caught (3)
and (4) outright. Against: another dependency, and jsdom is not Chromium, so it
gives real confidence about some things and false confidence about others.

**Known rough edge, not fixed:** on the Choose screen, "I don't have a
spreadsheet yet…" sits below the starter-kit paragraph, so someone with no
spreadsheet clicks the big obvious "Choose spreadsheet…" first, lands in a file
picker filtered to `.xlsx/.xls/.csv`, and is stuck. The operator hit this. It
should sit directly beneath "Choose spreadsheet…", where that question arises.

**Tried against real material, three times.** Nine PDFs; the same PDFs renamed
to a convention; then 59 real Word documents. Every trial found something the
generated fixtures could not — PDF-syntax dates, a UTC day-shift, and compact
filename dates — all fixed. The final run produced 59 rows with nothing
flagged. The lesson worth keeping: the fixtures were *correct* but incomplete,
and each gap was a thing every real file has and no fixture had.

**Word tables are supported** (2026-08-06). Word documents here hold their
metadata as a table -- a header row naming the fields, one row of values, and
cells that often span several paragraphs. The reader now preserves that
structure and a column can be pointed at a header with . Verified against all 18 real documents: 18 rows, nothing flagged,
descriptions of 1,875 to 3,593 characters extracted intact. This was the last
known gap in what the extractor can read.

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

On `feature/institution-agnostic`, three more matter, and `OEQ_COLLECTION_UUID`
became **required in every mode** — the default above used to be built in, and
an institution that never set it silently got BYU-Idaho's uuid:

```text
OEQ_AUTH_MODE=password                # code (DEFAULT) | client_credentials | password
OEQ_USERNAME= / OEQ_PASSWORD=         # password mode only; no OAuth client needed
OEQ_ATTACHMENT_UUID_PATH=BYUI_extended/attachments/attachment   # BLANK = write no such field
```

`.env.example` documents all of them with the reasoning. Note the trap:
`OEQ_AUTH_MODE` unset means `code`, so setting only the username and password
gets OAuth and `client_id (null)`.

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
- The custom-xpath field on Review commits on blur, not on Enter.
- Native file-open dialogs have never been driven in automation — they are not
  CDP-scriptable, so every dialog in the app is covered only by the logic behind
  it. This is why the round-trip check at the top of this document has to be
  done by a person.
- The Choose screen's **"I don't have a spreadsheet yet…"** sits below the
  starter-kit paragraph, so someone with no spreadsheet reaches for the obvious
  "Choose spreadsheet…" first and lands in an empty file picker. The operator
  hit this. Move it directly beneath "Choose spreadsheet…".
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

- **The round-trip check** described under "The one test that has never been
  run". This is the only thing genuinely blocking confidence in stage 2.
- **Decide on packaging.** The operator asked that no installer be built yet, so
  PR #3 is code only. When it is time: `npm run dist`, and note that
  `pdfjs-dist` adds ~35 MB to an installer distributed over a network share.
  Only `legacy/build` is used at runtime, so electron-builder `files`
  exclusions may trim it — untested, and it needs a real packaged build to
  verify, which is why nobody has tried.
- **Decide whether Word tables are worth supporting.** The 59 test documents
  kept their metadata in tables, which label matching cannot read. Whether that
  matters depends on whether real upload batches look like those files.
- **Decide on jsdom.** Three of the six faults live testing found were DOM
  behaviour that no test here can express. See "What live testing found".
- The 37 production items are **meant to stay as drafts** — draft is the
  finished state for this collection, not a pending step. Do not suggest
  submitting them.
- Apply shared owners via Manage Resources.
- A clean-machine test needs a Windows machine with **no Node installed** — the
  only way to prove the "zero prerequisites" claim.

## Things that bit us, worth not re-learning

- **A green suite says nothing about the browser context.** The renderer is a
  different runtime from the tests. 590 tests passed while the app showed a
  blank window, because vitest runs in Node and the failing import resolves
  there. Anything that only breaks in Chromium is invisible here.
- **Fixtures are correct but incomplete, and that is the dangerous shape.**
  Three real bugs in the extractor lived in things every real file has and no
  fixture had: PDFs always store dates as `D:2026...`, Word always stores UTC,
  real filename conventions use compact dates. The fixtures were not wrong.
  They were polite in exactly the ways the code assumed.
- **A warning that fires on the default configuration is noise.** "Nothing fills
  this" appeared beside a column the starter profile ships empty on purpose.
  People stop reading warnings that are always there, and then the warning is
  not there when it matters.
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
