# openEQUELLA Bulk Uploader

A local tool for bulk-creating openEQUELLA contributions from a directory of files
plus a metadata spreadsheet. One file becomes one attachment on one contribution —
a strict 1:1 relationship.

Works at any openEQUELLA institution. BYU-Idaho (`https://content.byui.edu`) is
one configuration of it, not the only one it fits — but it is the **only** one
it has ever been run against.

Replaces an older, no-longer-working tool by Jim Kurian.

## Status

**Read [docs/SESSION-HANDOFF.md](docs/SESSION-HANDOFF.md) first.** It states
where the work stands and exactly what to do next.

**The CLI is finished and has run in production** — 37 jury videos contributed
to BYU-Idaho Faculty Content on 2026-08-04, every one verified byte-for-byte
against its source file.

**The desktop GUI is finished, released and merged.** Seven screens, a
sandboxed renderer, per-instance encrypted credentials, a typed IPC contract.
First released as v0.1.0 and clean-machine tested by the operator.

**Sign-in works on both instances.** Authorization-code flow, `src/core/authCode.ts`.
Not a blocker any more; the handoff records what the fix actually was.

**The metadata extractor is finished and merged** (PR #2 and PR #3). It builds
the spreadsheet from a folder of PDFs and Word files so nobody types it by
hand -- core, `oeq-upload extract`, and three desktop screens.

**Collection templates are finished and merged** (PR #5, PR #6). A template is
a profile JSON in `templates/`; supporting a new collection is configuration,
never code. One ships: `templates/alumni-obituary.profile.json`.

**The institution-agnostic work is MERGED** (PRs #7, #8, #9). Username/password
sign-in, collections and schemas discovered from the API, an operator-managed
instance list, nothing BYU-Idaho-specific read at runtime, and `check` grown
into a compatibility probe. Typecheck clean, `build:desktop` clean. `main`
carries everything and no PR is open.

**Every screen but Progress now has a way off it.** Choose and Results both
carry "Site settings for {site}…" and "Sign out of {site}…", and Setup has a
Back that saves nothing, offered only when it was opened from somewhere.
Progress deliberately has none: signing out under a running batch would end the
session the runner uploads through.

**Setup fills the attachment-ID field in from the schema.** Choosing a
collection reads its schema; where that schema declares exactly one leaf whose
last segment is `attachment(s)` -- BYUI_MWDL declares exactly one,
`BYUI_extended/attachments/attachment` -- the field is filled and the verdict
line says it was. Never over what the operator typed, never on a re-render (a
cleared field has to stay cleared), and never when the schema declares two:
picking between them would be the institution-specific assumption this branch
exists to remove. **1444 tests across 88 files.**

That is spec 1 of two. Publishing the repository — a licence, a README written
for outside readers, and the audit of ~196 commits of history — is spec 2 and
**has not started**. It is the only step that cannot be undone, which is why it
was kept separate.

**Not yet released.** `package.json` is still at 1.0.0; nothing has been tagged
since. Two things staff must be told before v1.1.0 reaches them: **they will
re-enter their credentials once** (deliberate — the store version changed and
Setup explains it), and **they must choose their collection on Setup**, which is
what fills the attachment field in from the schema. Skipping it leaves the field
blank and their contributions silently lose
`BYUI_extended/attachments/attachment`.

**Password auth is VERIFIED against a live instance** — 2026-08-13,
`content-test.byui.edu`, an ordinary openEQUELLA account, driven through the
desktop app's own stored credentials and code path: `POST /api/auth/login`
returned 200, `currentuser` identified the real user, and all 29 contributable
collections came back. This file previously said it was unverified and must not
be described as working; that is superseded.

**It took a defect to get there, and hand-testing is what found it.** The
provider kept only `JSESSIONID` from the sign-in response and discarded the
load balancer's `AWSALB`/`ROUTEID` cookies, so every request landed on a
backend that had never seen the session — served as **guest, 200, empty list**.
The whole test suite passed throughout. See the cookie-jar fact below.

Description extraction is tiered — a stated field, then a named section
(`Abstract`, `Summary`, …), then the opening paragraph, then eventually a
language model. **Tiers 1–3 are built.** Anything from tier 3, and any section
that ran to the length cap, is always flagged in `_notes`.

**Tier 4 is deferred by the operator** — "hold off on the ai piece for now",
2026-08-10. Do not start it without being asked. It needs a provider decision
and its own conversation; the open questions are listed at the end of
[docs/superpowers/specs/2026-08-06-description-extraction-design.md](docs/superpowers/specs/2026-08-06-description-extraction-design.md).

**Released as v1.0.0** on 2026-08-07. Packaging is tag-driven: bump the version
in package.json, tag `vX.Y.Z`, push the tag, and .github/workflows/release.yml
builds both Windows installers and creates the GitHub Release. The repo is
private, so the Release is the version archive, not the delivery channel --
staff get the executable from the network share.

The wire format is settled — the `{ type: 'file', filename, description, uuid }`
attachment payload was confirmed by the production run, not just by
`schema/swagger.json`, which does not model openEQUELLA's polymorphic
attachment subtypes.

The spec lives at
[docs/superpowers/specs/2026-08-03-oeq-bulk-uploader-design.md](docs/superpowers/specs/2026-08-03-oeq-bulk-uploader-design.md).

## Repository layout

```text
files/            Batch inputs — MP4s + spreadsheet. GITIGNORED (size + student names).
src/core/         All logic. Free of CLI, MCP and Electron concerns. Reused by every front end.
  discovery.ts      Parses /api/collection and /api/schema. PURE — never fetches, so every
                    response shape is pinned against a recorded fixture.
  schemaCache.ts    A fetched schema on disk, keyed (instance url, schema uuid). Exists so
                    extract/ stays offline. Every read failure returns null, never throws.
  passwordAuth.ts   UsernamePasswordAuth. Cookie-based; no expiry logic — a 401 goes through
                    client.ts's existing invalidate-and-retry-once path.
  instanceUrl.ts    Validate/normalise an operator-typed address. HTTPS enforcement lives here.
  redact.ts         One redactor for secrets on the wire. Used by every error path.
src/core/extract/ Build the spreadsheet from a folder of files. Never touches the network.
src/cli/          plan | run | status | retry | login | logout | check | extract
src/mcp/          Nine MCP tools
src/desktop/      Electron app. Renderer is sandboxed: NO Node access, no `node:` imports.
src/desktop/ui/extract/  The extract flow's own state, controller and screens.
scripts/
  probe-instance.mjs  Read-only live probe. Committed so any institution can run it against
                      their own site and answer the response-shape questions themselves.
schema/           openEQUELLA schema reference material (committed).
  _entity.xml       BYU-Idaho's BYUI_MWDL export, uuid c93181f3-a443-41bf-9afe-ac9f7daf90b7.
                    Still `--schema-file`'s default, so it is the one institution-specific
                    default left in the CLI; elsewhere, export and pass your own.
  sample.xml        A real contributed item, used as the golden target for output
  oai_dc_limb.xsl   OAI Dublin Core export transform
docs/             Specs and design docs.
tests/fixtures/   Anonymized test data. Never put real student names here.
tests/fixtures/api/  Real /api/collection and /api/schema responses, recorded by the probe on
                     2026-08-12 and trimmed (security blocks and owner uuids stripped).
```

## Key domain facts

These were established by inspecting the instance and existing data. They are
easy to get wrong from first principles.

**Some of them are BYU-Idaho's configuration, not properties of openEQUELLA.**
They are marked. Reading one as universal is how `MWDL/title` came to be
hardcoded into duplicate detection; treat every marked fact as an example of a
shape, never as a value the code may assume.

- **A schema declares its own name and description paths, and the tool reads
  them.** `namePath` / `descriptionPath` over REST, `<itemNamePath>` /
  `<itemDescriptionPath>` in an `_entity.xml` export — note the REST spelling
  differs from the export's, and the probe of 2026-08-12 is the only reason we
  know. Where a schema declares no name path the answer is **null**, and every
  consumer must report "could not check" rather than substitute a guess.
- **A collection LIST entry already carries `schema: { uuid }`.** So a chosen
  collection resolves to its schema in one hop, with no per-collection
  follow-up request. Confirmed live 2026-08-12.
- **A schema's `definition` comes back over REST as nested JSON, not XML**, so
  `parseSchemaPaths` (which parses the export) cannot be reused on that path —
  `discovery.ts` walks the tree instead. The two must agree: parse
  `schema/_entity.xml` one way, walk `tests/fixtures/api/schema.json` the
  other, and assert the results match. They describe one schema, so any
  disagreement is a bug in one of them. That cross-check found three: the `xml`
  root must be stripped, containers must not be emitted (openEQUELLA cannot
  store a value at one), and `@attr` keys are addressable segments while `_`
  keys are metadata.
- *(BYU-Idaho's configuration)* **Schema**: `BYUI_MWDL`, uuid
  `c93181f3-a443-41bf-9afe-ac9f7daf90b7`. Declares `/MWDL/title` and
  `/MWDL/description`. 158 valid xpaths from the export, 98 of them under
  `BYUI_extended`. **Target collection**: "BYU-Idaho Faculty Content", itemdef
  `bb348ab1-7a81-4e37-8ef7-adc095ade4f9`, one of 29 the account can contribute
  to, across two distinct schemas — an institution really can have more than
  one. **That collection has no moderation workflow**, so publishing puts an
  item live immediately with no queue to catch mistakes. Draft is the default
  for this reason, and nothing in the code knows whether any other collection
  is the same.
- **Spreadsheet convention**: row 1 headers are literal schema xpaths
  (`MWDL/title`, `MWDL/creators/creator`, …). `attachment name` is a reserved
  header naming the file on disk; it is never written as metadata.
- **The attachment-uuid field is configuration, and defaults to written-nowhere.**
  `OEQ_ATTACHMENT_UUID_PATH` names it; BYU-Idaho sets it to
  `BYUI_extended/attachments/attachment`, which holds the attachment UUID, not
  the filename — even though incoming spreadsheets put the filename there. The
  tool substitutes the real UUID. Left blank, no such field is written at all:
  it is a convenience index a schema may declare, the attachment is linked
  through the attachment API regardless, and writing a guessed path would put
  metadata outside the collection's schema on every item. Note that
  `schema/sample.xml` shows ~170 UUIDs on a single-attachment item; that is
  accreted junk from repeated bulk edits, not the intended pattern.
- **openEQUELLA answers an unauthenticated request with 200, not 401.** Probed
  against `content-test.byui.edu` on 2026-08-13 with no credentials at all:

  ```text
  GET /api/content/currentuser  -> 200  { "username": "guest", "guest": true }
  GET /api/collection?privilege=CREATE_ITEM
                                -> 200  { "available": 29, "results": [] }
  ```

  Note `available: 29` beside **zero** rows -- the server says "there are 29,
  you get none". **This cost four defects at once**, all the same shape: a
  successful HTTP call taken as proof of sign-in. `currentUser()` dropped the
  `guest` field, so `check` reported *"Identity ok -- logged in as guest"*, and
  the collection dropdown rendered "No collections match", indistinguishable
  from an account that genuinely has none. **Two reliable signals exist and
  must be used: `guest: true` on `/api/content/currentuser`, and `available > 0`
  with an empty `results`.** A failed `POST /api/auth/login` *does* return 401 --
  but it still issues a JSESSIONID, and that cookie yields a guest session, so
  holding a cookie is not proof either.
- **A session is the WHOLE cookie jar, not just `JSESSIONID`.** Measured on
  `content-test.byui.edu`, 2026-08-12, with a real account. One sign-in
  response set four cookies, and which of them went back decided who the
  instance thought you were:

  ```text
  Set-Cookie: AWSALB (124 chars), AWSALBCORS (124), JSESSIONID (32), ROUTEID (2)

  JSESSIONID alone -> username=guest,  guest=true
  all four         -> username=milesm, guest=false
  ```

  The instance is behind an AWS load balancer; `AWSALB` and `ROUTEID` carry the
  routing state that reaches the backend actually holding the session, and
  without them the request lands on one that has never seen it. **openEQUELLA
  serves that as guest -- 200, empty-but-plausible data -- rather than
  rejecting it**, which is the previous bullet's failure mode arriving through
  a different door and is why this went unnoticed: the desktop collection list
  simply looked empty. `passwordAuth.ts` therefore keeps every cookie the
  sign-in set and sends them all back. Any future cookie-carrying auth path
  must do the same.
- *(BYU-Idaho's configuration)* **Authentication is SSO-backed** (Okta via
  `id.churchofjesuschrist.org`). Interactive login cannot be automated. The API
  client needs `CREATE_ITEM` on the target collection; `VIEW_APIDOCS` gates
  `/api/swagger.json`. Everywhere else, `OEQ_AUTH_MODE=password` is the
  expected route.
- **`OEQ_AUTH_MODE` defaults to `code`, NOT to `password`.** The desktop's
  Setup screen offers username and password first, with OAuth behind an
  Advanced disclosure -- that is the UI default, and it is a different thing
  from the env default. A site that sets `OEQ_USERNAME`/`OEQ_PASSWORD` and
  nothing else silently gets OAuth, and openEQUELLA answers with `No OAuth
  client can be found with the supplied client_id (null)`, naming neither the
  variables they set nor the one they didn't. `runPreflight` detects exactly
  that combination and says so; do not describe password mode as "the default"
  without saying which surface.
- **The password travels in the query string.** `POST /api/auth/login?username=&password=`
  is openEQUELLA's API and cannot be changed from here. So https is *refused*
  rather than warned about (loopback exempted), and nothing may put a login URL
  into a log, a message or the manifest. `tests/passwordAuth.test.ts` walks
  every string reachable from a thrown error for the password in literal and
  percent-encoded form; that guard exists because a debug line added later
  would leak passwords into a file the operator emails around asking for help.
- **BYU-Idaho's OAuth client cannot do the client-credentials grant.** Probed
  2026-08-12: it answers `invalid_client` — *"To use the Client Credentials
  flow your client must be registered with a fixed user"*. This file previously
  said unattended runs require that grant; they cannot use it as registered.
  `OEQ_AUTH_MODE=code` (authorization code, interactive) is the working path
  here, and `password` is the path for institutions that are not behind SSO.
- **The duplicate check matches the schema's declared item name path exactly**
  -- `/xml/<namePath>` in the search API's `where` clause, not free-text `q`,
  whose matching semantics are unconfirmed and would raise false alarms. At
  BYU-Idaho that resolves to `/xml/MWDL/title`, which is what this file used to
  state as the literal; hardcoding it made the clause match nothing anywhere
  else, so every row came back clean from a check that never looked. **With no
  declared name path, no search is issued at all and every pending row is
  `could-not-check`** -- returning an empty list there would borrow the
  vocabulary of "checked, all clean". CONFIRMED against production: the clause
  filters, and an attachment's filename is at `attachments[].filename`. A
  result carries NO `name` field, even with `info=basic`. `showall=true` is
  mandatory or it cannot see this tool's own drafts.
- **The identifier path is resolved by matching leaf name, and reports "not
  checked" when it cannot be.** Unlike the title, openEQUELLA declares no
  identifier path -- a schema declares a name path and a description path and
  nothing else -- so `resolveIdentifierPath` matches the schema's REAL paths on
  the leaf `identifier`, ties going to the top-level section the declared name
  path lives in. At BYU-Idaho that yields `MWDL/identifier`, the literal it used
  to hardcode. Where nothing matches, the batch gets **one warning saying the
  check did not run and why**, never an empty warning list. That distinction is
  the whole point: **a check that reports success without running is the bug
  this codebase has now had twice** -- first `MWDL/identifier` against a column
  the extractor never produced, then `MWDL/title` at any institution but this
  one. Both reported "no duplicates" by never having looked.
- **Stored desktop credentials were a clean break at v3, not a migration.** v2
  keyed entries by the literal ids `production` and `test` -- the names of two
  addresses this tool no longer ships. `loadAll`'s existing "unrecognised shape
  -> empty" path discards them with no rekeying step, and Setup shows a
  one-sentence notice explaining the blank form, because a silently empty Setup
  reads as a broken app. Migration was the only option that could lose what it
  existed to protect, and it would have faithfully preserved credentials the
  operator was resetting anyway.
- **The instance list ships EMPTY, and each site carries a "live" flag
  defaulting to ON.** Deleting BYU-Idaho's two hardcoded addresses left the
  banner shouting red on every configured site, and a warning that fires on
  everything stops being a warning. The flag is per-instance configuration; the
  banner reads it rather than inferring from an id that no longer exists. Note
  the banner shows the operator's own label for the site, uppercased, not the
  word PRODUCTION.
- **A collection template is just a profile JSON** in `templates/`. Supporting a
  new collection is configuration, never code -- a code pack per collection
  would need a developer each time. `dateNear`, `datePair` and `compose` are
  generic sources; nothing in the code knows what an obituary is.
- **Read prose, not numbers, from OCR.** Scanned obituaries state the death date
  in both a numeric header and a sentence. OCR destroyed the header on 7 of 10
  files while every spelled-out date survived -- letters carry more redundancy
  than digits. Reading the prose took recovery from 3 of 10 to 9 of 10.
- **A session can only be ended by the provider that holds it, and the desktop
  builds a new one per IPC call.** `UsernamePasswordAuth.logout()` PUTs
  `/api/auth/logout` with its own cookie jar; a provider that never signed in
  makes no request at all. So in password mode every desktop handler call
  signs in again -- one live server session per call -- and before
  `src/desktop/session.ts`'s registry there was nothing left to log out.
  Building a provider from the stored credential to log out would have signed
  in FIRST and then ended that brand-new session, leaving the real one alive;
  the CLI reached the same conclusion and declined (`LogoutDeps.auth`). The
  registry keeps every provider reachable by instance id so Forget and quit can
  end the sessions that actually exist. **Reusing one provider per instance
  would also stop the leak, and is deliberately NOT done**: one long-lived
  session would serve every later request, and a session openEQUELLA has since
  expired is answered as the guest with 200 and empty data, never a 401.
- **Shared owners are not ACLs.** The legacy `currentItem.addSharedOwner(...)`
  script sets collaborators (`item/collaborativeowners/collaborator`), which is
  a different mechanism from access control. Out of scope for v1.

## Conventions

- TypeScript on Node. Core logic in `src/core/` must stay free of CLI and MCP
  concerns so both front ends are thin wrappers.
- **The MCP layer never streams file bytes.** It plans, validates, launches, and
  monitors. Uploading belongs to the runner process.
- Never commit real spreadsheets, `.env` files, or media.
- **Every person in a test, a fixture, a comment or a doc is invented.** The
  jury data uses botanical surnames (Aster, Birch, Cedar, Juniper, Rowan, Thorn,
  Wren); the alumni-obituary examples use Larkspar/Larkspur, Fennel, Linden,
  Bracken, Teasel, Sorrel, Alder, Clover, Willow and Hawthorn. **They are
  pseudonyms and must stay that way, and so must the dates, towns and causes of
  death beside them** — a real death date under an invented name still
  identifies someone. This rule is written here because it was broken once: the
  real names of ten deceased people, with birth and death dates, towns and
  causes of death, reached the tests, the README, the specs and the source
  comments during the obituary work and had to be scrubbed before the repository
  could be opened. Working from a real batch is fine; typing what you saw into
  the repository is not.
- **Nothing reachable from `src/desktop/ui/` may import `node:*` or `electron`.**
  The renderer is sandboxed. Such an import does not fail loudly — it kills the
  whole module graph and the window renders blank, with nothing on the terminal.
  This happened: `ui/extract/controller.ts` imported a core module that reached
  `node:fs` three hops down, and all 590 tests still passed, because vitest runs
  in Node. `tests/desktop/rendererPurity.test.ts` now walks the import graph and
  fails the build instead. If the renderer needs something a Node-dependent
  module computes, compute it in the main process and send it over IPC.
- **Mutation testing has a trap here: source files are CRLF in the working
  copy.** A `perl` or `sed` pattern containing `\n` silently matches nothing,
  so the mutation never applies, the suite comes back green, and the result is
  indistinguishable from a well-covered test. This has produced a false "all
  passing" twice. Apply mutations with the Edit tool and confirm the file
  actually changed before believing a green run. The same CRLF issue already
  broke multi-line `node -e` string replaces once.
- **`noUnusedLocals` is NOT enabled.** `tsconfig.json` sets `strict` and
  `noUncheckedIndexedAccess` only. Do not rely on the typecheck to find a dead
  import — it will not. Stated here because a plan and several task briefs
  asserted otherwise.
- **Any input whose `input` event triggers a re-render must call
  `ui/dom.ts#keepCaret`.** Screens render by replacing `innerHTML`, so the input
  is destroyed and recreated on every keystroke; without it the field loses
  focus after one character, or types backwards if it re-focuses without
  restoring the caret. Both shipped for months unnoticed.
- **Never put a `style` attribute in rendered markup. The CSP blocks it
  silently.** `index.html` sets `default-src 'self'` with no `style-src`, so
  Chromium refuses inline styles — *"Refused to apply inline style because it
  violates …"* — while leaving the attribute visibly present in the DOM. Set
  the property through the DOM API instead (`el.style.width = …`), which CSP
  does not block. **Do not add `'unsafe-inline'`**: this app renders
  operator-supplied spreadsheet and document text into the DOM, so the policy
  is load-bearing. The progress bar broke on exactly this and shipped broken
  from v0.1.0 through two releases and a production run — and not as a dead
  bar. `.progress-bar__fill` had no width in CSS, so `width: auto` filled the
  track: operators were shown a **completed** bar for the whole of every run.
- **Never build an instance URL with `new URL('/path', base)`.** An absolute
  path replaces the base's path outright, so `https://host/oeq` silently
  becomes `https://host/oauth/...`. openEQUELLA is commonly deployed under a
  path prefix. Use `instanceEndpoint(baseUrl, path)` from
  `src/core/instanceUrl.ts`. This was wrong at ten sites at once, including
  `client.ts`, through which every API request passes.
- **A build script must fail loudly when a required asset is missing.**
  `copy-ui-assets.mjs` swallowed every error with `.catch(() => {})`, so a
  build missing `index.html` completed successfully and opened a **blank
  window** — this project's known catastrophic failure, which cost a full
  session to diagnose once already, with the build configured to hide it.
- **Do not assert semantically meaningless ordering in tests.** Cookie order in
  a `Cookie` header is the live example: RFC 6265 says a server must not depend
  on it, so asserting it couples the test to an iteration order that may change
  harmlessly. Compare a sorted set of whole pairs — not `toContain`, which
  passes for `AWSALB=lb; Path=/` and would drop the guard against echoing
  cookie attributes back.

## Process

- **Read the PR review comments before merging.** Automated review has
  commented on every PR in this repository since #1 and nobody read any of it
  until 2026-08-13. There were **17 comments; seven were real defects**, one of
  them user-visible and shipping since v0.1.0. They cost nothing to find.
- **A review finding is usually narrower than the problem it points at.** Both
  confirmed instances: the path-prefix comment named 2 sites, there were 10;
  the cookie-order comment named 1 assertion, there were 4. Treat a finding as
  a sample of a class, not an inventory — grep for the pattern before fixing
  the line.
- **Check that a refutation is valid before abandoning a hypothesis.** The
  load-balancer cookie theory was raised, then dropped because a probe showed
  both variants empty — but that run's sign-in status was never visible, and if
  the sign-in itself failed both would read guest and the test proves nothing.
  It was the right answer, discarded on evidence that could not support the
  conclusion, and rediscovered an hour later.
- **A commit pushed after its PR is merged is stranded.** It is invisible to
  `git branch --merged`, which reports ancestry rather than whether the work
  arrived. This repo has lost commits that way twice. **Before deleting any
  branch, diff its content against `main`**, and after merging a PR, check
  whether anything landed on the branch since.
- **Hand-testing finds what the suite cannot.** One screenshot of an empty
  dropdown produced six defects with all 1236 tests passing throughout. Every
  serious fault in this project has lived at a boundary the tests do not
  cross — the browser, the real schema, the DOM, the packaged build, the
  seam between two halves of the program, and now the live server's idea of
  what a successful response means.

## Working notes

- A Playwright profile with a live SSO session may exist under the session
  scratchpad. openEQUELLA's `JSESSIONID` is session-scoped, so it does not
  survive a browser restart — re-login is interactive each time.
- `schema/swagger.json` has been captured from the live instance and is
  committed. It confirmed the staging upload endpoints and that a
  client-supplied attachment uuid is accepted (`AttachmentBean.uuid`), but it
  does not settle everything: `AttachmentBean` has no `filename`/`type`
  property at all, because the spec doesn't model openEQUELLA's polymorphic
  attachment subtypes. Whether this tool's `{ type: 'file', filename, ... }`
  payload shape is correct is still unverified and is exactly what the live
  smoke test in the README exists to confirm. See the header comment in
  `src/core/client.ts` for the full CONFIRMED/UNVERIFIED breakdown.
- It also **refuted two assumptions the entire test suite agreed with**: the
  staging area is a `?file=` query parameter (not a body field), and
  `GET /search` defaults `showall=false`, which made the duplicate pre-flight
  blind to the drafts this tool creates. Both are fixed.
- OAuth endpoints are **not** under `basePath: /api`, so swagger.json does not
  describe them. Verified by probe: `/oauth/authorise` is canonical (British
  spelling); `/oauth/authorize` 302-redirects to it. The registered
  `redirectUrl` is the site root, and the server strips its trailing slash.
- `OEQ_SCHEMA_UUID` is recorded in the manifest but **never sent anywhere**.
  Don't chase it. (It used to be true that schema validation always read the
  local `schema/_entity.xml`. It no longer is: the desktop fetches the chosen
  collection's schema and caches it per instance, and `runPreflight` reads it
  from the API. `plan` and `extract` still read `--schema-file`.)
- **`plan` and `check` read the schema from different sources**, and can
  disagree — `plan` from the local `--schema-file` export, `runPreflight` from
  the API. A schema edited on the server since the export was taken is the case
  where they diverge. Known seam, deliberately left open on
  `feature/institution-agnostic`. If it is closed, **the API is the authority
  and the local file is the offline fallback**, not the other way round.
- **Extraction must stay offline.** `src/core/extract/` never touches the
  network, which is what lets an operator build a spreadsheet without signing
  in to anything. Moving the schema onto the API threatened that, which is the
  entire reason `schemaCache.ts` exists. With no cache, extraction still runs
  against the bundled export and reports columns as unvalidated — blocking the
  offline half of the tool on a network call nobody asked for would trade a
  real capability for a check.
