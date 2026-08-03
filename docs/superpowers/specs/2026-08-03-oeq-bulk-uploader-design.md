# openEQUELLA Bulk Uploader — Design

**Date:** 2026-08-03
**Status:** Approved, pending API verification
**Instance:** `https://content.byui.edu`

## Problem

Contributing many files to openEQUELLA one at a time through the web wizard does
not scale. A typical batch is ~37 video files averaging 150 MB — roughly 5.5 GB —
each needing identical-shaped metadata that differs only in a few fields.

An earlier tool by Jim Kurian solved this but no longer works.

Two distinct users need serving:

- Someone comfortable authoring a metadata spreadsheet who wants a repeatable,
  unattended batch run.
- Someone who is not, and needs help discovering which of ~200 schema xpaths a
  given piece of information belongs in.

## Scope

### In scope (v1)

- Create one contribution per file, with that file as its single attachment (1:1).
- Metadata driven by a spreadsheet whose column headers are schema xpaths.
- Items created as draft or published, configurable per run.
- Resumable batches with per-row failure isolation.

### Target and item state

One collection per job, configured per run, defaulting to "BYU-Idaho Faculty
Content" (itemdef `bb348ab1-7a81-4e37-8ef7-adc095ade4f9`).

**That collection has no moderation workflow.** Publishing puts an item live
immediately, with no queue in which to catch a mistake. Draft is therefore the
default: the first run of any batch is where a subtly wrong metadata mapping
surfaces, and draft items are trivial to delete where live ones are not.

### Out of scope (v1)

- Shared owners / collaborators — continues to be applied manually inside
  openEQUELLA via Manage Resources. (Cheap to add later; see Future Work.)
- Access control lists.
- Per-row target collections — one collection per job.
- Standalone Windows `.exe` packaging.

## Architecture

One TypeScript package on Node, three layers. The core is unaware of both front ends.

```text
src/core/
  auth.ts       AuthProvider interface; OAuth client-credentials implementation
  client.ts     Typed openEQUELLA REST client
  schema.ts     Fetch/parse schema; validate xpaths; suggest near-matches
  sheet.ts      xlsx | csv -> rows
  metadata.ts   xpath-keyed row -> nested item XML
  plan.ts       rows + files + schema -> validated manifest
  upload.ts     Staging-area file upload
  runner.ts     Execute manifest; retry; resume
  state.ts      Job state persistence
src/cli/        commander: plan | run | status | retry
src/mcp/        MCP server; thin wrapper over core
```

**Invariant: the MCP layer never streams file bytes.** It plans, validates,
launches, and monitors. Byte movement belongs to the runner process. This is what
keeps a 5.5 GB batch from costing hundreds of tool calls and megabytes of
conversation context.

Each core module is independently testable: `metadata.ts` and `sheet.ts` are pure
functions over fixtures, `schema.ts` and `client.ts` need only a mock HTTP server.

## Two-phase flow

The phases exist because the work has two incompatible shapes: one is fuzzy,
interactive, and cheap; the other is mechanical, long, and must not ask questions.

### Phase 1 — Plan

1. Read the spreadsheet (`.xlsx` or `.csv`, detected by extension).
2. Validate every column header against the live schema. Unknown headers block
   the plan and produce nearest-match suggestions.
3. Match each row to a file on disk via the reserved `attachment name` column.
4. Advisory duplicate scan on `MWDL/identifier` against the target collection.
5. Write `job.json`.

No bytes move. Every human decision happens here.

### Phase 2 — Run

For each pending row:

1. Create a staging area.
2. Upload the file.
3. Create the item with metadata and attachment.
4. Record the returned item UUID; mark the row done.

The runner never prompts. Anything ambiguous was resolved during planning.

**Concurrency:** rows process sequentially by default, with an optional
`--concurrency N` flag. Sequential is the right default here because the
bottleneck is a 150 MB upload over a campus network — parallelism risks
saturating the connection and makes partial-failure states harder to reason
about, for a gain that only materialises if the server is the bottleneck rather
than the link.

`job.json` is the sole contract between phases and the only input `status` and
`retry` require.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `oeq_list_schema_paths(filter)` | Search the ~200 valid xpaths |
| `oeq_validate_sheet(path)` | Header validation with suggestions |
| `oeq_plan(sheet, filesDir, collection, opts)` | Write manifest; return summary and problems |
| `oeq_start_job(manifest)` | Spawn detached runner; return `jobId` |
| `oeq_job_status(jobId)` | Counts and recent failures |
| `oeq_retry_failed(jobId)` | Re-queue failed rows |

There is deliberately no upload tool.

## Metadata generation

Column headers are xpaths, merged into a single tree:

```text
MWDL/creators/creator = "David Olsen"
  -> <MWDL><creators><creator>David Olsen</creator></creators></MWDL>
```

- Repeated values under one xpath become sibling elements. **In v1 this is not
  reachable from a spreadsheet:** `sheet.ts` rejects duplicate column headers
  outright, because `Row.cells` is `Record<string, string>` and two identical
  headers would otherwise silently discard the first column's data. The XML
  builder accepts multiple values per path, so supporting genuinely repeated
  fields (two `MWDL/creators/creator` columns for co-creators, say) means
  changing only the sheet reader. Deferred until a real batch needs it.
- Blank values inside a multi-value list are dropped; a lone blank still emits a
  self-closing tag. An empty slot among real values is a spreadsheet artifact,
  not a value.
- **Blank cells emit empty tags** (`<abstract/>`), matching what the openEQUELLA
  wizard produces and what existing items look like. Consistency matters here
  because the OAI Dublin Core transform (`schema/oai_dc_limb.xsl`) runs over this
  output.
- `attachment name` is reserved: it names the file on disk and is never written
  as metadata.
- **`BYUI_extended/attachments/attachment` receives the real attachment UUID**,
  replacing the filename incoming spreadsheets place there. Exactly one UUID per
  item, per the 1:1 rule.

`schema/sample.xml` shows ~170 UUIDs in this field on a single-attachment item.
That is accretion from repeated bulk edits, not the intended pattern, and is not
reproduced.

### Attachment UUID ordering

Preferred, **one pass**: if the API accepts a client-supplied attachment UUID,
generate it locally, embed it in the metadata, and create the item in a single
call. Atomic — it either succeeds or it does not.

Fallback, **two pass**: if the server assigns the UUID, create the item, read the
assigned UUID, then update the metadata. This leaves a window where an item exists
with an empty field, so such rows are marked `incomplete` rather than `done` until
the second call lands.

Which applies is an open question (see Unverified Assumptions).

## Schema source

Fetched live from `/api/schema/{uuid}` at plan time, falling back to the local
`schema/_entity.xml` when offline. Live matters: the local copy is a point-in-time
export dated 2026-05-11, and validating against a stale copy would reject fields
added since and accept fields removed.

## Identity and resume

`MWDL/identifier` is **not** a reliable unique key — it happens to be unique in
the current batch, but future batches may repeat values. Roles therefore split:

- **Job state file — authoritative.** Keyed by source file plus row index,
  recording the item UUID openEQUELLA returns at creation. That UUID is the only
  guaranteed-unique identifier, and resume keys on it.
- **Identifier pre-flight — advisory only.** Reports "N rows have an identifier
  already present in this collection" and defers to the operator. It never
  silently skips, so a batch with intentionally repeated identifiers is not
  quietly dropped.

The pre-flight runs before any upload. Its purpose is preventing the genuinely bad
outcome: duplicate items in a collection with no moderation queue to catch them,
each carrying a 150 MB attachment that must then be deleted by hand.

## Authentication

The instance sits behind Okta SSO (`id.churchofjesuschrist.org`). Interactive
login cannot be automated, so unattended operation requires **OAuth client
credentials**:

```http
POST /oauth/access_token?grant_type=client_credentials&client_id=…&client_secret=…
-> { "access_token": … }
then: X-Authorization: access_token=<token>
```

`AuthProvider` is an interface so alternatives can be swapped without touching
the client. Credentials live in a gitignored `.env`.

**Provisioning note:** items are owned by the user the OAuth client is bound to,
not by the person running the tool. That user needs `CREATE_ITEM` on the target
collection. Ownership is awkward to change after the fact, so it should be settled
when the client is registered.

## Error handling

- **Per-row isolation** — one failure never terminates the job.
- **Retry** with exponential backoff on 5xx and network errors; never on 4xx.
- **Token refresh** on a mid-run 401, transparently.
- **Cleanup** — a failed upload deletes its staging area so retries do not leak
  partial 150 MB files.
- **Mismatches**, reported at plan time: a row naming a missing file is excluded
  and listed; a file with no matching row is a warning. Neither blocks the rows
  that are valid.

## Testing

- **Unit** — `metadata.ts` against golden XML derived from `schema/sample.xml`;
  `sheet.ts` against `tests/fixtures/sample-batch.csv`, which reproduces the real
  data's hazards (misplaced spaces, mixed-case extensions, parenthetical names,
  descriptions containing both commas and double quotes); xpath validation against
  `schema/_entity.xml`.
- **Integration** — mock HTTP server covering resume after interruption, retry
  backoff, and 401 refresh.
- **Smoke** — single-file dry run into a test collection before any real batch.

## Unverified assumptions

All three resolve by capturing `schema/swagger.json` from
`https://content.byui.edu/api/swagger.json` (gated by the `VIEW_APIDOCS` privilege).

1. The staging-area upload endpoint shape, and whether it supports chunked or
   resumable transfer. If it does not, a failed 150 MB upload restarts from zero.
2. Whether item UUIDs may be supplied at creation. If so, deterministic
   client-side UUIDs would make retries naturally idempotent — the cleanest
   possible answer to the duplicate problem.
3. Whether attachment UUIDs may be supplied at creation, deciding the one-pass
   versus two-pass question above.

None block writing the implementation plan; all should be confirmed before the
code that depends on them is written.

## Future work

- **Collaborators.** The legacy `currentItem.addSharedOwner(...)` script maps to
  `item/collaborativeowners/collaborator`, and the item-creation payload accepts a
  collaborators list — likely a few lines rather than a feature. If adopted, the
  legacy list needs cleaning first: it contains ~48 entries that dedupe to ~34,
  mixing UUIDs, bare numeric IDs, and raw usernames, which the API treats more
  strictly than the script console does.
- Standalone `.exe` packaging, if the tool is ever handed to a department directly.
- Per-row target collections.
