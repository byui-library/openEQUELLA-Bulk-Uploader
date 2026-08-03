# openEQUELLA Bulk Uploader

A local tool for bulk-creating openEQUELLA contributions from a directory of files
plus a metadata spreadsheet. One file becomes one attachment on one contribution —
a strict 1:1 relationship.

Targets the BYU-Idaho instance at `https://content.byui.edu`.

Replaces an older, no-longer-working tool by Jim Kurian.

## Status

Design phase. The spec lives at
[docs/superpowers/specs/2026-08-03-oeq-bulk-uploader-design.md](docs/superpowers/specs/2026-08-03-oeq-bulk-uploader-design.md).
No implementation code yet.

## Repository layout

```
files/            Batch inputs — MP4s + spreadsheet. GITIGNORED (size + student names).
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

## Working notes

- A Playwright profile with a live SSO session may exist under the session
  scratchpad. openEQUELLA's `JSESSIONID` is session-scoped, so it does not
  survive a browser restart — re-login is interactive each time.
- `schema/swagger.json` is not yet captured. Three design decisions depend on it:
  the staging upload endpoint, whether item UUIDs may be supplied at creation,
  and whether attachment UUIDs may be supplied at creation.
