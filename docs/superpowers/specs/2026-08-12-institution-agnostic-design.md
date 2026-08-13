# Making the uploader institution-agnostic — Design

**Date:** 2026-08-12
**Status:** Approved. Not yet planned or built.
**Occasion:** The tool works, and the operator wants other openEQUELLA sites to
be able to use it.

This is **spec 1 of two**. It makes the code work at any openEQUELLA
installation. Publishing the repository — licence, outsider-facing README, and
the audit of 196 commits of history — is spec 2, deliberately separate because
it is the only step that cannot be undone.

## What is actually BYU-Idaho-specific

Not as much as it looks, and not the parts people assume. Measured by reading
the code rather than guessing:

| Thing | Where | How hard |
| --- | --- | --- |
| Auth is OAuth, because the instance is Okta-backed | `src/core/auth.ts` | **Already a seam.** `AuthProvider` is an interface and `OEQ_AUTH_MODE` already selects between two implementations |
| Instance URLs | `src/desktop/ui/instances.ts`, `src/desktop/ipc.ts` | Hardcoded dropdown, duplicated in two files by design |
| The schema | `schema/_entity.xml`, shipped as a resource | `--schema-file` is **already a CLI flag**; it merely defaults to BYUI's |
| Collection uuid | configuration | Already an env var / stored setting |
| **The title xpath** | `src/core/client.ts:484`, `src/core/types.ts:64` | **The dangerous one.** See below |

The auth change is the one the operator named and the smallest of the three.
The title xpath is the one nobody named and the one that fails silently.

## Decisions taken

Settled in conversation on 2026-08-12, recorded so they are not reopened:

- **One codebase, config-driven.** BYU-Idaho becomes one configuration of the
  same tool, not a special build. A fork was considered and rejected: the
  generic copy would get far less real-world exercise than BYUI's, so its bugs
  would surface at other institutions rather than at home.
- **Discovery over the API**, not typed uuids and hand-exported XML.
- **Username and password is the default sign-in; OAuth stays behind an
  Advanced toggle** for SSO sites and unattended runs.
- **The password is remembered**, encrypted per Windows account, with a visible
  Forget button.
- **Only BYUI's two instances are available for testing.** This is a constraint
  on the design, not a footnote — see "What cannot be tested".

## 1. Auth: a third provider, and no client changes

`client.ts` merges `await this.auth.authHeader()` into every request
([client.ts:229](../../../src/core/client.ts#L229)) and, on a 401, calls
`invalidate()` and retries exactly once
([client.ts:247](../../../src/core/client.ts#L247)).

A `UsernamePassword` provider returning `{ Cookie: 'JSESSIONID=…' }` satisfies
that interface unchanged. **Session expiry therefore needs no new code**: a
session that has lapsed produces a 401, which invalidates and re-logs-in
through machinery that already exists and is already tested. The reasoning
written in `auth.ts` for handling OAuth expiry reactively rather than on a
timer applies identically here, and for the same reason — batch runs have
bursty, unpredictable request timing.

`OEQ_AUTH_MODE` gains a third value, `password`, alongside `code` and
`client_credentials`.

### The endpoint, and the hazard in it

```http
POST /api/auth/login?username=<user>&password=<pass>
PUT  /api/auth/logout
```

**The credentials are query parameters, not a body.** This is openEQUELLA's
API and cannot be changed from here. It means credentials are written to
server access logs, and to any proxy in between.

Two things follow, and both are requirements:

1. **Refuse `http://`.** A password in a query string over plaintext is
   indefensible. The tool rejects a non-HTTPS instance URL at Setup with an
   explanation, not a warning that can be clicked past.
2. **No URL containing credentials is ever logged**, printed, or written to
   the manifest. This gets its own test, because a debug line added later
   would leak passwords into a file the operator emails around when asking for
   help.

Confirmed present in the captured `schema/swagger.json`. **Not yet verified
live.** The staging endpoint's `?file=` parameter had exactly this shape and
the entire test suite believed the wrong thing about it until a live probe
said otherwise. A probe comes before any code depends on this.

### The password at rest

Stored by the existing per-instance encrypted store (`src/desktop/secrets.ts`),
the same one that already holds the OAuth client secret — Electron
`safeStorage`, which is DPAPI on Windows, so it is readable only by the same
Windows account.

Setup shows which account is signed in and offers **Forget this password**.

The password is held for the life of the run in the CLI and never written to
disk there; only the desktop app persists it.

## 2. Discovery: ask the server

### Collections

```http
GET /api/collection?privilege=CREATE_ITEM&full=true
```

The `privilege` parameter is the useful part: it returns only the collections
the signed-in user can actually contribute to, which answers "which one do I
pick?" without anyone reading a uuid out of the admin console. A user with
rights to one collection sees one entry.

If the list comes back empty, that is a *finding*, not an error — the account
authenticated but can create nothing, and Setup says exactly that.

### The schema, and the field we were ignoring

```http
GET /api/schema/{uuid}
```

A schema entity declares its own item name and description paths. BYUI's, from
the committed `schema/_entity.xml`:

```xml
<itemNamePath>/MWDL/title</itemNamePath>
<itemDescriptionPath>/MWDL/description</itemDescriptionPath>
```

**`MWDL/title` was never an arbitrary choice — it is what this schema
declares.** The tool has been hardcoding a value the schema was publishing all
along. Reading `itemNamePath` makes the title path correct at every
institution and, incidentally, documents why it is what it is at this one.

The valid-xpath set that `schema/_entity.xml` supplies today comes from the
same response, so `parseSchemaPaths` keeps working against a schema fetched
over the network instead of read from disk.

**Unverified and needing a probe:** whether `GET /collection/{uuid}?full=true`
carries the uuid of the schema the collection uses. If it does not, the link
from chosen collection to its schema needs another call or another field, and
that changes the Setup flow. This is the single biggest unknown in the design.

### The fetched schema is cached, because extraction is offline

`src/core/extract/` never touches the network, and that is a deliberate
property worth keeping: the operator builds a spreadsheet from a folder of
files without signing in to anything. But extraction validates the columns it
produces against the schema, which this design has just moved onto the API.

So a fetched schema is **written to a per-instance cache on disk** at Setup and
refreshed when the collection changes. Extraction reads the cache, never the
network, and `--schema-file` survives as an explicit override — it is already a
CLI flag today and stays one.

If no cached schema exists, extraction still runs and reports every column as
unvalidated rather than refusing. Blocking the offline half of the tool on a
network call the operator did not ask for would trade a real capability for a
check.

## 3. The failure that would be silent

Duplicate detection builds its query as a literal:

```ts
// src/core/client.ts:484
const clause = `/xml/MWDL/title = '${escapeWhereValue(title)}'`;
```

and reads the row's title through a constant:

```ts
// src/core/types.ts:64
export const TITLE_XPATH = 'MWDL/title';
```

At an institution whose schema names its title anything else, that clause
matches nothing. Every row comes back **clean**, and the operator is told
their batch has no duplicates by a check that never looked.

**This exact failure has already happened in this codebase.** The original
pre-flight checked `MWDL/identifier`, a column the extractor never produced,
so it "reported no duplicates by never having looked" — recorded in
[2026-08-06-duplicate-prevention-design.md](2026-08-06-duplicate-prevention-design.md).
Repeating it in a tool handed to strangers, on a check whose entire purpose is
to prevent silent damage, would be worse the second time.

So:

- The title xpath comes from the schema's `itemNamePath`, threaded to both
  call sites rather than read from a module-level constant.
- **Where it cannot be determined, the verdict is `could not check`, never
  `clean`.** That verdict already exists in the duplicate design and is
  already rendered by both front ends; this design adds a new way to reach it,
  not a new thing to build.

## 4. The instance list

`UI_INSTANCES` and `INSTANCES` (hand-mirrored across
`src/desktop/ui/instances.ts` and `src/desktop/ipc.ts`, guarded by
`tests/desktop/ui/instances.test.ts`) hold BYUI's two URLs.

They become a **user-managed list, seeded empty**: Setup takes an openEQUELLA
address, validates it is HTTPS and reachable, and remembers it. BYUI operators
add their two once. The drift-guard test survives because the mirroring
concern does not go away — only the literal contents do.

This is a small regression in convenience for BYUI, who currently pick from a
dropdown, and it is the honest price of the tool not knowing who its user is.

## 5. `oeq-upload check` becomes the compatibility probe

`check` already exists and already confirms auth, identity and `CREATE_ITEM`
([cli/index.ts:615](../../../src/cli/index.ts#L615)). It grows into the thing a
new institution runs first, reporting a line per capability:

```text
HTTPS                              ok
POST /api/auth/login               ok      signed in as jsmith
GET  /api/collection               ok      3 collections with CREATE_ITEM
GET  /api/schema/{uuid}            ok
schema declares itemNamePath       ok      /local/dc/title
duplicate detection                ok      will match on /local/dc/title
upload endpoints                   ok
```

Every line that fails names what it means and what to do. The point is that
"it didn't work" becomes a specific, diagnosable statement made by the tool
rather than a support conversation conducted blind across institutions.

The desktop app runs the same probe at the end of Setup and shows the same
lines.

## What cannot be tested

**Only `content.byui.edu` and `content-test.byui.edu` are available.** This
design will be verified against one vendor configuration of one openEQUELLA
version at one institution.

What BYUI can genuinely prove: that `/api/auth/login` works (**if** local
accounts exist on the instance — if every account is SSO-only, password auth
ships unverified and that must be stated plainly, not glossed); that
`/api/collection` and `/api/schema/{uuid}` return what this design expects;
that reading `itemNamePath` yields `/MWDL/title` and duplicate detection still
finds the duplicates it already finds today.

What it cannot prove: other openEQUELLA versions, other authentication
configurations, or schemas that are not MWDL.

The README states the tested version and instance count explicitly. The
compatibility probe exists precisely because the first outside institution is
the real test, and it should be able to tell us what broke without needing us.

## Testing

- **Unit:** the `UsernamePassword` provider against a stubbed login — success,
  bad credentials, a 401 mid-run triggering exactly one re-login, and an
  instance URL that is not HTTPS being refused.
- **Leak test:** assert that no log line, error message or manifest field ever
  contains the password, including on the failure paths.
- **Discovery:** collection and schema responses parsed from recorded
  fixtures, including an empty collection list and a schema with no
  `itemNamePath`.
- **The silent-failure test:** a schema whose `itemNamePath` is *not*
  `/MWDL/title`, asserting the `where` clause uses the declared path — and a
  schema with no declared path at all, asserting the verdict is `could not
  check` and never `clean`.
- **Live probe, before implementation:** login, logout, collection list with
  `privilege=CREATE_ITEM`, schema fetch, and whether a collection response
  names its schema. Recorded in the handoff when it passes, as the earlier
  probes were.
- **Regression:** the existing 925 tests keep passing. BYUI's behaviour must
  not change; it should arrive at `/MWDL/title` by reading it rather than by
  assuming it.

## Rejected alternatives

**A fork, or a long-lived generic branch.** Two codebases forever, and the
generic one exercised least. A branch additionally rots the moment merging
stops — this repository lost two documentation commits to exactly that in the
week before this was written.

**A public copy of the repository made now, as insurance.** The stated fear
was that this work might damage the working tool. It cannot: `v1.0.0` is
tagged on `origin`, and the installer on the network share is a built artifact
no repository change can reach. The copy would buy nothing against that risk
while performing the one irreversible step — exposing 196 commits of history —
before the audit that is supposed to precede it.

**Typing the collection uuid and supplying an exported schema file.** Almost
no new code. Rejected because it asks a librarian to open the openEQUELLA
admin console and export XML, which is the barrier the desktop app exists to
remove.

**Detecting the auth method automatically.** openEQUELLA gives no reliable
signal that an account is SSO-only, so the tool would guess, and a wrong guess
fails at sign-in — where a new user is least equipped to diagnose it.

**Dropping OAuth.** BYU-Idaho is Okta-backed; an SSO-only account may have no
openEQUELLA-local password at all. Removing OAuth risks breaking the one
installation known to work.

## Out of scope

- **Publishing the repository** — licence, README for outside readers, and the
  history audit. Spec 2. Whether BYUI's `alumni-obituary` template and
  `schema/_entity.xml` ship as worked examples is decided there.
- **Supporting non-Windows platforms.** Unchanged by this work.
- **The AI description tier**, deferred by the operator on 2026-08-10.
- **Multi-user or server deployment.** This stays a local tool run by one
  person on their own machine.
