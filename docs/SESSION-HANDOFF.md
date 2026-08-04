# Session handoff — updated 2026-08-04

Read this first in a new session.

## State

**The tool works end to end against a live openEQUELLA instance.** A single
draft item was created on `content-test.byui.edu` and verified by reading it
back through the API. Every wire-format assumption is now confirmed.

```
252 tests passing, 16 files       npm test
typecheck clean                   npm run typecheck
builds                            npm run build  -> dist/cli/index.js, dist/mcp/index.js
branch                            feature/bulk-uploader
```

Docs: `README.md` (setup and usage) ·
`docs/superpowers/specs/2026-08-03-oeq-bulk-uploader-design.md` (design) ·
`docs/superpowers/plans/2026-08-03-oeq-bulk-uploader.md` (build plan)

## Verified live — no longer assumptions

The smoke test created one draft item and read it back:

- **Attachment payload shape `{ type: 'file', filename, description, uuid }` is
  correct.** This was the last thing `schema/swagger.json` could not settle,
  because the spec does not model openEQUELLA's polymorphic attachment
  subtypes. The server echoed back `"type": "file"` and `"filename"` intact.
- **A client-supplied attachment uuid is honoured.** The uuid we generated came
  back unchanged, so the one-pass design holds and the two-pass fallback in
  `runner.ts` is dead code for this instance (it stays, harmlessly, as a guard).
- **Uploaded bytes are md5-identical** to the source file.
- `BYUI_extended/attachments/attachment` receives the attachment uuid.
- Quotes, `&` and `<>` survive into the stored metadata correctly escaped.
- An empty column emits `<abstract/>`, matching the wizard.
- Items land as **draft**, owned by whoever authenticated.
- **Re-running a manifest creates nothing** (`created=0 skipped=1`).
- The `showall=true` search fix genuinely finds draft items — verified by
  re-planning after the smoke test and seeing the duplicate warning fire.

## Authentication — working

`OAuthClientCredentials` **cannot** be used: the OAuth client has no fixed
user, deliberately, so that each contributor owns what they contribute. The
authorization-code flow is implemented and working.

Confirmed behaviours, all learned the hard way:

- **`/oauth/authorise`** (British spelling) is canonical; `/oauth/authorize`
  302-redirects to it.
- **A cold SSO session drops the query string.** Visiting the authorize URL
  while logged out bounces to Okta, which returns the browser to a bare
  `/oauth/authorise`; openEQUELLA then reports `client_id (null)`. Sign in to
  openEQUELLA first, then authorize. `login` warns about this; it cannot detect
  the browser's session.
- **`redirect_uri` must match the registered value character for character,
  trailing slash included.** `OEQ_REDIRECT_URI` defaults to `baseUrl + '/'` and
  is never normalised. Sending the stripped form yields "No OAuth client can be
  found".
- **The code cannot be read from the address bar.** openEQUELLA's SPA navigates
  to `/page/home` and discards `?code=` immediately. `login` handles this two
  ways — see below.
- **The token does not expire.** `expires_in` comes back as `9223372036854775807`
  (Long.MAX_VALUE). Good for long batches; it also means `.oeq-token.json`
  holds a **non-expiring** credential that authenticates fully as the user who
  logged in. Run `oeq-upload logout` when finished. The comment in
  `tokenStore.ts` calling the token "short-lived" is wrong and should be fixed.

### Recommended improvement, needs an admin

Register a **dedicated OAuth client for this tool** with
`redirectUrl = http://localhost:8787/callback`. `login` already supports
loopback capture: when `OEQ_REDIRECT_URI` is a local address it starts a
temporary server and captures the code automatically, with nothing to paste.

`OAuthClientBean.redirectUrl` is single-valued, so the existing Sync client
cannot be reused — it needs its own client. Until then `login` falls back to a
manual paste, which now accepts a full URL and points the operator at browser
history (where the intermediate `?code=` URL survives).

## Environment

`.env` is gitignored and populated, pointing at the **test** instance:

```
OEQ_BASE_URL=https://content-test.byui.edu
OEQ_COLLECTION_UUID=bb348ab1-7a81-4e37-8ef7-adc095ade4f9   # "BYU-Idaho Faculty Content"
```

The collection UUID is **identical on test and production**, so `OEQ_BASE_URL`
is the only thing distinguishing them. Check it before every run. The token
store refuses a token issued for a different `baseUrl`, which is the backstop.

`.env` must be UTF-8 **without** BOM — PowerShell 5.1's `Set-Content -Encoding
utf8` adds one, which silently breaks the *first* variable only. The tool now
tolerates it, but it is worth knowing.

`OEQ_SCHEMA_UUID` is recorded in the manifest but **never sent anywhere**.
Don't chase it.

## Suggested next steps

1. `npm install && npm test` — confirm 252 green.
2. `oeq-upload check` — four read-only probes; creates nothing.
3. A larger test batch (say 3–5 real MP4s) into the **test** collection, to
   exercise concurrency-free sequential upload at realistic file sizes and
   confirm throughput is sane before committing to 5.5 GB.
4. Then the real batch. Check `OEQ_BASE_URL` first.

## Known remaining work

- `tokenStore.ts`'s docstring claims the token is short-lived. It is not.
- The two-pass attachment fallback in `runner.ts` is unreachable on this
  instance now that client-supplied uuids are confirmed honoured. Harmless.
- No concurrency flag; uploads are sequential by design.
- Duplicate column headers rejected in v1; the XML builder supports multiple
  values per xpath, so lifting it is a sheet-reader change only.
- Shared owners / collaborators still applied manually in openEQUELLA.
  `ItemBean` has a `collaborators` field, so automating it is small.

## Things that bit us, worth not re-learning

- **Tests agreeing with the code proves nothing about the server.** Two bugs
  survived a 240-test suite because `client.ts` and `tests/helpers/mockServer.ts`
  encoded the same wrong assumption: `POST /api/staging` returns `201` with an
  **empty body** and the uuid only in a `Location` header, and `plan`/`run`
  hardcoded the wrong auth provider. Both failed on the first live row.
- **The real spreadsheet uses formulas.** `Equella_Spring2026.xlsx` computes
  `attachment name` and `MWDL/title` with `CONCATENATE`/`MID`. A CSV-only
  fixture missed this entirely and would have failed all 37 rows.
- **Draft is the default deliberately** — the target collection has no
  moderation workflow, so `--state published` goes live immediately.
- **`interrupted` rows are not failures.** A prior run died mid-entry; the
  runner refuses to guess whether the item exists. Check, then re-run with
  `--force-interrupted`.
