# Session handoff — 2026-08-03

Read this first in a new session. It says where the project actually is, what is
verified, and precisely what to do next.

## State

The tool is **built and green**, but has **never successfully talked to a live
openEQUELLA instance**. Everything below the authentication layer is tested
against a mock server that encodes our own assumptions.

```
173 tests passing, 14 files      npm test
typecheck clean                  npm run typecheck
builds                           npm run build  -> dist/cli/index.js, dist/mcp/index.js
branch                           feature/bulk-uploader
```

Implemented: spreadsheet reading (xlsx + csv, formula-aware), schema xpath
validation with nearest-match suggestions, metadata XML generation, atomic job
state, OAuth (client-credentials — see blocker), REST client, plan builder with
duplicate pre-flight, streaming upload, resumable runner with a job lock, CLI
(`plan | run | status | retry`), and an MCP server (six tools).

Design: `docs/superpowers/specs/2026-08-03-oeq-bulk-uploader-design.md`
Plan: `docs/superpowers/plans/2026-08-03-oeq-bulk-uploader.md`
Usage: `README.md`

## THE BLOCKER — authentication must be rewritten before anything runs

`OAuthClientCredentials` is implemented and works, but **cannot be used against
this instance**. The token request returns:

```json
{ "error": "invalid_client",
  "error_description": "To use the Client Credentials flow your client must be registered with a fixed user" }
```

The owner has **declined to register a fixed user**, deliberately: each
contributor should own what they contribute rather than everything being
attributed to one service account. Their existing "openEQUELLA Sync" tool
already uses the authorization-code flow, so it is proven on this instance.

### What to build

A new `src/core/authCode.ts` implementing the existing `AuthProvider` interface
(`getToken`, `authHeader`, `invalidate`). **Nothing else should need to change** —
`client.ts`, `upload.ts`, `runner.ts`, and `plan.ts` depend only on the
interface. That seam was built for this.

Flow, with the parts already verified against `content-test.byui.edu`:

1. Build `{base}/oauth/authorise?response_type=code&client_id=…&redirect_uri=…`
   - **`/oauth/authorise`** is canonical (British spelling). `/oauth/authorize`
     302-redirects to it. Verified.
   - `redirect_uri` is the **site root**: `https://content-test.byui.edu` (test)
     or `https://content.byui.edu` (production). It is *not* a local callback.
   - The server **strips the trailing slash**. Send exactly what it echoes or the
     exchange fails on a `redirect_uri` mismatch. Verified.
2. The operator opens that URL, authenticates via Okta SSO as themselves.
3. The browser lands on the openEQUELLA home page carrying `?code=…`.
4. The operator pastes the code into the tool.
5. `POST {base}/oauth/access_token?grant_type=authorization_code&code=…&redirect_uri=…&client_id=…&client_secret=…`

For MCP (which cannot prompt), add two tools: `oeq_login_url` returning the URL,
and `oeq_login_complete(code)` performing the exchange and caching the token.

### Open decision, not yet made

Keep `OAuthClientCredentials` alongside the new provider (~20 lines, leaves room
for a fixed-user client and scheduled runs later), or remove it. **Ask the owner.**

### Risks to handle

- **The code may not survive the redirect.** openEQUELLA's home page may strip
  `?code=` before the operator can copy it. If so, fall back to driving a browser
  with Playwright — that already works in this project's scratchpad tooling.
- **Token lifetime is unmeasured.** Measure it once a token exists. A detached
  runner cannot re-authenticate, so if a 5.5 GB batch outlives the token the
  runner marks remaining rows failed; resume then skips completed rows, so
  recovery is cheap but manual.
- Reuse the existing secret-redaction helper. The secret must never reach an
  error message, a log, or an MCP tool result.

## Environment

`.env` exists locally, is gitignored, and is **already populated** with a working
`client_id` / `client_secret` for the test instance, pointing at:

```
OEQ_BASE_URL=https://content-test.byui.edu
OEQ_COLLECTION_UUID=bb348ab1-7a81-4e37-8ef7-adc095ade4f9   # "BYU-Idaho Faculty Content"
```

The test instance is not an exact duplicate of production, but **the collection
and schemas are the same**, so that UUID is valid in both. Because of that,
`OEQ_BASE_URL` is the *only* thing distinguishing test from production — check it
before every run.

`OEQ_SCHEMA_UUID` is **never sent anywhere**. It is recorded in the manifest for
provenance and nothing else; xpath validation reads the local
`schema/_entity.xml`. Do not spend time on it.

## After authentication works

Two read-only scripts exist in the session scratchpad and are worth recreating —
they create nothing:

1. **Pre-flight**: get a token, `GET /api/content/currentuser` (identifies who
   will own created items), `GET /api/collection/{uuid}` (confirms the collection
   exists on this host), and `GET /api/collection?privilege=CREATE_ITEM` (confirms
   the authenticated user may actually contribute to it).
2. Only once all four pass, run the **live smoke test** in `README.md`: one file,
   `--state draft`, into the test collection.

### What the smoke test must prove

This is the last unverified wire-format assumption and no test in the repo can
settle it — `client.ts` and `tests/helpers/mockServer.ts` encode the same
assumption by construction and will always agree with each other.

`AttachmentBean` in `schema/swagger.json` lists only `uuid, description, viewer,
preview, erroredIndexing, restricted, externalId` — **no `filename`, no `type`** —
because the spec does not model openEQUELLA's polymorphic attachment subtypes.
Our payload sends `{ type: 'file', filename, description, uuid }`.

In the openEQUELLA UI, verify on the created item:

- Title and description match the spreadsheet, quotes intact.
- **Exactly one** attachment, playable, correct byte size.
- `BYUI_extended/attachments/attachment` holds the attachment **uuid** — not the
  filename, and not a list.
- Item status is **draft**.

Then re-run the same manifest and confirm `created=0 skipped=1` and that no
second item appears.

If the attachment is missing or malformed, the `{type:'file', filename}`
assumption is wrong. **`src/core/client.ts` and `tests/helpers/mockServer.ts` are
the two files to change, together** — nothing else depends on the wire format.

## Things worth knowing that are not obvious from the code

- **The real spreadsheet uses formulas.** `Equella_Spring2026.xlsx` computes
  `attachment name` and `MWDL/title` with `CONCATENATE`/`MID`. `sheet.ts` resolves
  formula cells to their cached values. A CSV-only test suite missed this
  entirely and would have failed all 37 rows.
- **Draft is the default deliberately.** The target collection has **no
  moderation workflow**, so `--state published` puts items live immediately with
  nothing to catch a mistake.
- **`interrupted` rows are not failures.** If a prior run died mid-entry, the
  runner refuses to guess whether the item was created and reports the row as
  interrupted. The operator checks the collection, then re-runs with
  `--force-interrupted`. Guessing "already done" costs a re-run; guessing "not
  done" costs a duplicate 150 MB item.
- **A job lock prevents concurrent writes** to one manifest. `plan` and `retry`
  refuse while a runner holds it. Stale locks (dead pid) are reclaimed.
- **Duplicate column headers are rejected in v1.** The XML builder supports
  multiple values per xpath; only the sheet reader refuses. Lifting it is a
  sheet-reader change.
- The client secret travels in a query string (openEQUELLA's documented form), so
  it may appear in server access logs. Treat it as rotatable.

## Suggested first moves in a new session

1. Read this file and `README.md`.
2. `npm install && npm test` — confirm 173 green before changing anything.
3. Ask the owner the open decision above (keep or drop client-credentials).
4. Build `src/core/authCode.ts` + tests, then the two MCP login tools.
5. Run the pre-flight script. Do not create anything until all four checks pass.
6. Run the smoke test. Verify in the UI by eye.
7. Only then consider a real batch — and check `OEQ_BASE_URL` first.
