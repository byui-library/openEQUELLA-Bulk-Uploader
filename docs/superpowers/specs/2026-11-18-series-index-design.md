# Series index page — design

Date: 2026-11-18. Status: approved by the operator (design 2026-11-17,
approved 2026-11-18). Branch: `feature/series-index`.

## Why

A serial uploaded as one item per volume (Snake River Echoes: 38 volumes,
each holding its issue PDFs) has no single place that lists the run. A
reader who wants "the 1978 issues" must search and open items one at a
time. The index page is that place: one page listing every volume, each
volume linking to its item and its issues linking straight to their PDFs.

## Decisions (operator)

From the interview of 2026-11-17:

- The index lives as **an openEQUELLA item**, built **as a separate step
  after uploading**, never during a batch.
- It shows **each volume, then its issues** beneath.
- The list comes **from openEQUELLA itself** (a search of the collection),
  not from a job file — so it reflects what is actually there, including
  items uploaded by hand or in other batches.
- The index item's **own record comes from the template**.
- Rebuilding **updates the same item**; it never creates a second index.
- The page is **plain and accessible**.
- **Desktop and command line** both offer it.
- Staff see **a preview, then choose Draft or Publish**.

Added 2026-11-17, before approval:

- **Two destinations, either or both, from ONE preview**: save the page as
  files for a different web server, and/or create/update the openEQUELLA
  item. One build feeds both, so the two copies cannot differ.
- **The web-server copy links back to openEQUELLA.** The folder holds only
  `index.html`, `index.css` and `index.js`; no PDF is copied.
- **The JavaScript is a filter box**, as a progressive enhancement: with
  JavaScript off the complete list is still there and works.
- **Draft and published volumes are listed alike** (operator, 2026-11-18,
  superseding "published only, with an Include drafts option"): an item's
  links are the same whatever its state, and most of these will be
  published and made public anyway. Whether a reader can open a linked item
  is openEQUELLA's access control, not this tool's concern.
- **The same three files are the openEQUELLA item's three attachments**
  (approach A). The fallback (approach B: one self-contained file for
  openEQUELLA) is not needed — see live check 3.

## Live checks (content-test, 2026-11-17)

Run in the operator's signed-in Chrome. The throwaway test item was purged
afterwards (`DELETE …?purge=true` → 204; a later GET → 404).

1. **The list.** `GET /api/search?q=…&showall=true&info=basic,attachment`
   returns each item's attachments with `filename` and `uuid` in upload
   order, and `status` per item. On content-test the results DID carry a
   `name` — `client.ts#searchByTitle` records that production did not, so
   `name` is used when present and never relied on. **Eight volumes exist
   twice** (15, 22, 25, 27, 31, 35, 36, 37), left by earlier test runs.
2. **Addresses.** `/items/{uuid}/0/` redirects to the latest version's item
   page; `/items/{uuid}/0/{filename}` redirects to
   `/file/{uuid}/{version}/{filename}`, the file itself. `/file/{uuid}/0/…`
   answers 500 and `/items/{uuid}/latest/` 404, so **only the `/items/…/0/`
   forms are used**. They survive a later edit of the item.
3. **The page.** An item with `index.html`, `index.css` and `index.js` as
   file attachments, created exactly as the uploader creates items (staging
   area, three PUTs, `POST /api/item?draft=true&file=…`), served
   `/items/{uuid}/0/index.html` as `text/html`; the relative stylesheet
   applied and the relative script ran.
4. **Rebuilding.** `PUT /api/item/{uuid}/{version}/?file={new staging}` with
   the item's bean (same attachment uuids and filenames, changed metadata)
   answered 200: the files were replaced, the item kept its uuid, its
   version (1) and its attachment uuids, and its title changed.

Not checked, deliberately (operator, 2026-11-18): what a signed-out reader
sees, and whether a published item's state survives the in-place PUT. The
links do not depend on either, and reader access is openEQUELLA's
permissions, not this tool's.

## What gets built

### 1. Collect — `src/core/index/collect.ts` (pure)

Input: the search hits (uuid, version, status, optional name, attachments
with filenames, in order) and the template's sequence rule
(`checks.sequence.patterns` and `labels`). Output: a `SeriesIndex`:

```ts
interface SeriesIndex {
  volumes: IndexVolume[];          // in group order (numeric where numeric)
  heldBack: HeldBack[];            // a group claimed by more than one item, or an item whose files disagree
  notInSeries: { uuid: string; name: string }[]; // no file fits any pattern
}
interface IndexVolume {
  group: string;                   // "12"
  heading: string;                 // the item's name, else "Volume 12" from labels
  itemUrl: string;                 // {base}/items/{uuid}/0/
  issues: { label: string; url: string }[]; // in attachment order
}
```

Rules:

- An item's **group** is read from its attachment filenames with the
  template's sequence patterns — the same `applyPattern` the extractor's
  checks use, so a name the extractor accepted is a name the index reads.
  Every file that yields a group must yield the **same** group; an item whose
  files disagree is held back, naming the item.
- **Two items claiming one group: that group is held back**, naming both
  items, until someone removes the extra. The page never offers two copies
  of a volume and never picks one, because nothing here can know which is
  right. (Today this is eight volumes on content-test.)
- An item with no file that fits any pattern is **not in the series**: listed
  in the preview, never guessed at. The index item itself lands here (its
  files are `index.*`), which is also how it keeps out of its own list.
- **Issue labels** come from `labels.part` and the part number:
  "Issue 2"; a span "Issues 2–3" (`No2&3`); a year when the name has one:
  "Issue 2 (1972)". A file with no part number (a commemorative issue, an
  index) is labelled by its filename stem and keeps its attachment
  position, which is already last (`folderFiles.ts#orderFiles`).
- Non-file attachments (URLs) are ignored.
- **Status**: `draft` and `live` items are listed alike. An item someone
  has withdrawn (`deleted`, `archived`, `suspended`, `rejected`) is not
  listed, and the preview counts it under "not in the series" with its
  status, so it never silently vanishes.

### 2. Render — `src/core/index/render.ts` (pure)

`renderIndex(index, { title, description, base })` returns
`{ 'index.html': string, 'index.css': string, 'index.js': string }`.

- **No inline `style` or `script`**, and no event-handler attributes, so the
  page works unchanged under a strict Content-Security-Policy on whatever
  server receives it.
- **Every value is escaped** — item names and filenames come from
  openEQUELLA and are operator-typed; URLs are built with
  `encodeURIComponent` per path segment and the base from
  `instanceEndpoint` (`src/core/instanceUrl.ts`), never `new URL('/…', base)`.
- Structure: `<html lang="en">`, a `<main>` with one `<h1>` (the index
  title), the description as a paragraph, then one `<section>` per volume
  with an `<h2>` link to the item and a `<ul>` of issue links. Links open in
  the same tab. A short line under the description says the PDFs are held in
  openEQUELLA.
- **The filter** (`index.js`): on load it inserts a labelled search box and
  a live status line ("Showing 4 of 37 volumes", `aria-live="polite"`)
  before the first volume. Typing hides volumes whose heading and issue
  labels do not contain the text (case-insensitive); an issue matching
  inside a volume keeps the volume shown. Nothing is inserted if the script
  never runs, so there is no dead control.
- `index.css`: readable defaults, visible focus, `prefers-color-scheme`
  dark variant, no external fonts or assets.
- Output is **deterministic** (no build timestamps in the markup), so
  rebuilding with nothing changed produces identical files — a re-upload is
  then visibly a no-op, and a diff of two builds shows only real changes.

### 3. The record — template `index` section

A template gains an optional section:

```json
"index": {
  "columns": [
    { "path": "MWDL/title", "value": "Snake River Echoes: index of volumes" },
    { "path": "MWDL/identifier", "value": "SRE_index" },
    { "path": "MWDL/description", "value": "An index to …" },
    { "path": "MWDL/genres/genre", "value": "Periodical" }
  ]
}
```

- Validated at load (`profile.ts`, zod, strict) like every other section.
  Paths are checked against the schema like the spreadsheet's headers.
- The page's `<h1>` and `<title>` use the value at the schema's declared
  **name path**; the description paragraph uses the declared
  **description path**. Either missing from the section: the build refuses,
  saying which.
- **The identifier is how a rebuild finds the item.** It is the value at
  `plan.ts#resolveIdentifierPath(schema)`. If the schema yields no
  identifier path, or the section gives no value there, **the openEQUELLA
  destination is refused** with that reason; saving files still works.
- Only templates with sequence patterns (and so a notion of group and part)
  are offered for an index. `templates/snake-river-echoes.profile.json` gets
  the section.

### 4. Destinations — `src/core/index/publish.ts` and `files.ts`

**Files.** Write the three files to a chosen folder. If any of the three
names already exists there, nothing is written until the operator agrees
(desktop: a confirm naming the files; CLI: `--force`, otherwise exit with
the list). Other files in the folder are never touched.

**openEQUELLA.**

1. Search the chosen collection for the identifier, `showall=true`, exact
   `where` clause on the identifier path (the `searchByTitle` mechanism,
   generalised to a path and a value).
2. **None** → stage the three files and create the item with the three
   attachments, as Draft or Publish (the existing `createItem`, whose
   explicit-boolean draft guard applies).
3. **One** → stage the three files and `PUT /api/item/{uuid}/{version}/
   ?file={staging}` with the item's own bean: its existing attachment uuids
   kept for the three filenames (new uuids for any missing), its metadata
   replaced by the record above. **The item keeps its state**: an update
   never publishes a draft or unpublishes a live item, and the preview says
   which state it will keep instead of offering Draft/Publish.
4. **More than one** → refuse, naming every match. Nothing is written.

The staging area is deleted on every failure path, as `upload.ts` does.

Client additions (`src/core/client.ts`):

- `searchCollection(collectionUuid)` — pages through
  `/api/search` (`length=50`, `start=`), `info=basic,attachment`,
  `showall=true` (status is then filtered in `collect`), until `available`
  is reached. Applies the guest rule this codebase already learned:
  `available > 0` with no results is reported as "not signed in", never as
  an empty collection.
- `findByField(collectionUuid, path, value)` — the exact `where` search.
- `getItem(uuid, version)` and `editItem(uuid, version, bean, stagingUuid)`.

### 5. Surfaces

**Desktop.** "Build an index…" beside the existing actions on Choose and
Results (it needs a signed-in site and a chosen collection, which Choose
already provides). The screen:

1. Template (only those with sequence patterns and an `index` section).
2. **Preview**: the rendered page in a sandboxed frame, plus counts —
   volumes, issues, held back (each named, with why), not in the series.
3. **Destinations**: "Save as files for a web server" (choose folder) and
   "Create or update the openEQUELLA item" — either or both.
4. For openEQUELLA: either Draft/Publish (new item), or the line "Updates
   the existing index item, which stays {draft|live}" (found one), or the
   refusal (found several / no identifier).
5. Result: where the files went; the item's link.

Main-process handlers do the network and file work; the renderer stays
sandboxed with no `node:` imports (`rendererPurity.test.ts`). The preview
frame gets the HTML as data with scripts disabled; it shows the page, the
counts show the substance.

**CLI.** `oeq-upload index --template <file>
[--out <dir> [--force]] [--upload --draft|--publish]`, collection from
`OEQ_COLLECTION_UUID` as the other commands take it. With neither `--out`
nor `--upload` it prints the preview and exits — the CLI's form of "preview
first". `--upload` without `--draft` or `--publish` is refused, as `run`
refuses.

**MCP**: out of scope for now.

## Errors and edge cases

- Not signed in, or signed in as guest → stop before searching.
- Nothing in the series → nothing to build; the preview says why (no item's
  files fit the template's patterns, with the patterns shown).
- All volumes held back → the same; held-back volumes never silently vanish.
- A held-back volume does **not** block the build of the rest; the preview
  and the CLI output list it, and so does the problems summary on save.
- Network failure mid-upload → staging deleted, item untouched; the files
  destination is independent and its result is reported on its own.

## Testing

- `collect`: fixtures shaped like the recorded live response, with
  **invented** item names and uuids (the repository is public). Groups in
  numeric order; disagreeing files held back; two items one group held back
  naming both; non-fitting items listed; unnumbered files labelled by stem
  and kept last; spans; draft and live listed alike, withdrawn statuses
  listed as not in the series; non-file attachments ignored; a
  missing `name` falling back to the label.
- `render`: every value escaped (a name containing `<script>` and `"`);
  no `style=`, `<script>` without `src`, or `on…=` anywhere in the HTML;
  URLs are `/items/{uuid}/0/…` with encoded filenames under a path-prefixed
  base; deterministic output; the JS filter tested against a DOM
  (happy-dom/jsdom as the suite already uses, or a pure matching function
  it calls).
- `publish`: none → create with the three files and the draft flag; one →
  edit keeping attachment uuids and state; several → refuse, nothing
  staged; no identifier path → refused; staging deleted on each failure.
- `files`: existing names → nothing written without consent; others
  untouched.
- `profile`: the `index` section validated (unknown keys refused, paths
  checked).
- Renderer purity, CSP (no inline styles in the new screen) and the IPC
  channel list are covered by the existing guard tests.
- **Live**, on content-test, before calling it done: build the Snake River
  Echoes index; save files and upload as a draft; open the item's
  `index.html` and follow a volume link and an issue link; rebuild and
  confirm the same item updated.
