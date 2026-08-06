# openEQUELLA Bulk Uploader

A local tool for bulk-creating openEQUELLA contributions from a directory of files
plus a metadata spreadsheet. One file becomes one attachment on one contribution —
a strict 1:1 relationship.

Targets the BYU-Idaho instance at `https://content.byui.edu`.

Replaces an older, no-longer-working tool by Jim Kurian.

## Status

**Read [docs/SESSION-HANDOFF.md](docs/SESSION-HANDOFF.md) first.** It states
where the work stands and exactly what to do next.

**The CLI is finished and has run in production** — 37 jury videos contributed
to BYU-Idaho Faculty Content on 2026-08-04, every one verified byte-for-byte
against its source file.

**The desktop GUI is finished, released and merged.** Seven screens, a
sandboxed renderer, per-instance encrypted credentials, a typed IPC contract.
Released as v0.1.0 and clean-machine tested by the operator.

**Sign-in works on both instances.** Authorization-code flow, `src/core/authCode.ts`.
Not a blocker any more; the handoff records what the fix actually was.

**Active work: the metadata extractor**, on `feature/extractor-desktop` as
**PR #3**. It builds the spreadsheet from a folder of PDFs and Word files so
nobody types it by hand. Core and CLI are merged; the desktop screens are on
that branch. **692 tests across 59 files**, typecheck clean.

Description extraction is tiered — a stated field, then a named section
(`Abstract`, `Summary`, …), then the opening paragraph, then eventually a
language model. **Tiers 1–3 are built**; tier 4 is not started and needs its
own conversation. Anything from tier 3, and any section that ran to the length
cap, is always flagged in `_notes`.

**Do NOT build an installer yet.** The operator asked that packaging wait.

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
src/core/extract/ Build the spreadsheet from a folder of files. Never touches the network.
src/cli/          plan | run | status | retry | login | logout | check
src/mcp/          Nine MCP tools
src/desktop/      Electron app. Renderer is sandboxed: NO Node access, no `node:` imports.
src/desktop/ui/extract/  The extract flow's own state, controller and screens.
schema/           openEQUELLA schema reference material (committed).
  _entity.xml       BYUI_MWDL schema export, uuid c93181f3-a443-41bf-9afe-ac9f7daf90b7
  sample.xml        A real contributed item, used as the golden target for output
  oai_dc_limb.xsl   OAI Dublin Core export transform
docs/             Specs and design docs.
tests/fixtures/   Anonymized test data. Never put real student names here.
```

## Key domain facts

These were established by inspecting the instance and existing data. They are
easy to get wrong from first principles.

- **Schema**: `BYUI_MWDL`, uuid `c93181f3-a443-41bf-9afe-ac9f7daf90b7`. Item name
  comes from `/MWDL/title`, description from `/MWDL/description`. Roughly 200
  valid xpaths.
- **Target collection**: "BYU-Idaho Faculty Content", itemdef
  `bb348ab1-7a81-4e37-8ef7-adc095ade4f9`. **No moderation workflow** — publishing
  puts an item live immediately, with no queue to catch mistakes. Draft is the
  default for this reason.
- **Spreadsheet convention**: row 1 headers are literal schema xpaths
  (`MWDL/title`, `MWDL/creators/creator`, …). `attachment name` is a reserved
  header naming the file on disk; it is never written as metadata.
- **`BYUI_extended/attachments/attachment` holds the attachment UUID**, not the
  filename — even though incoming spreadsheets put the filename there. The tool
  substitutes the real UUID. Note that `schema/sample.xml` shows ~170 UUIDs on a
  single-attachment item; that is accreted junk from repeated bulk edits, not the
  intended pattern.
- **Authentication is SSO-backed** (Okta via `id.churchofjesuschrist.org`).
  Interactive login cannot be automated, so unattended runs require OAuth
  client credentials. The API client needs `CREATE_ITEM` on the target
  collection; `VIEW_APIDOCS` gates `/api/swagger.json`.
- **Shared owners are not ACLs.** The legacy `currentItem.addSharedOwner(...)`
  script sets collaborators (`item/collaborativeowners/collaborator`), which is
  a different mechanism from access control. Out of scope for v1.

## Conventions

- TypeScript on Node. Core logic in `src/core/` must stay free of CLI and MCP
  concerns so both front ends are thin wrappers.
- **The MCP layer never streams file bytes.** It plans, validates, launches, and
  monitors. Uploading belongs to the runner process.
- Never commit real spreadsheets, `.env` files, or media.
- **Nothing reachable from `src/desktop/ui/` may import `node:*` or `electron`.**
  The renderer is sandboxed. Such an import does not fail loudly — it kills the
  whole module graph and the window renders blank, with nothing on the terminal.
  This happened: `ui/extract/controller.ts` imported a core module that reached
  `node:fs` three hops down, and all 590 tests still passed, because vitest runs
  in Node. `tests/desktop/rendererPurity.test.ts` now walks the import graph and
  fails the build instead. If the renderer needs something a Node-dependent
  module computes, compute it in the main process and send it over IPC.
- **Any input whose `input` event triggers a re-render must call
  `ui/dom.ts#keepCaret`.** Screens render by replacing `innerHTML`, so the input
  is destroyed and recreated on every keystroke; without it the field loses
  focus after one character, or types backwards if it re-focuses without
  restoring the caret. Both shipped for months unnoticed.

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
  Schema validation reads the local `schema/_entity.xml`. Don't chase it.
