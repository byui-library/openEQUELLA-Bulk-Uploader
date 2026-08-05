# Metadata Extractor — Design

**Date:** 2026-08-05
**Status:** Approved (design), not yet planned or implemented
**Supersedes nothing.** Additive to the shipped v0.1.0 uploader.

## Goal

Generate the upload spreadsheet automatically from a folder of PDFs and Word
documents, so that metadata for a batch does not have to be typed by hand.

## Why it belongs in this program

The extractor's output is a spreadsheet, and a spreadsheet is already this
program's input. It is a new step in front of the existing flow, not a
different tool:

```text
[NEW]      folder of PDFs/.docx  →  Extract  →  extracted.csv
                                                     ↓  reviewed in Excel
[EXISTING]                       Choose → Review → Confirm → Upload
```

Nothing in the shipped upload path changes. The extractor never touches the
network and knows nothing about openEQUELLA. That isolation is the point: no
defect in extraction can reach a live collection, because a human opens the
spreadsheet in between.

## Scope

**In:**

- PDFs with a text layer; `.docx`
- Scanned PDFs handled gracefully — filename and embedded properties only,
  flagged as having no readable text
- Three extraction sources: filename template, `Label:` lines in document text,
  embedded document properties
- One constant value filled down every row
- A reusable, shareable profile file
- Desktop screen, `oeq-upload extract`, and MCP tools

**Out, deliberately:**

- **OCR.** ~30 MB added to an installer distributed over a network share, seconds
  per page, and quality on historical or handwritten material is poor enough
  that correcting it costs more than typing. Scanned pages get a flagged row
  instead.
- **`.doc` (pre-2007 binary).** No reliable pure-JavaScript reader. Batch-convert
  to `.docx` in Word first.
- **Multiple values for one field on one row.** Dropped during design. It would
  require replacing the duplicate-header guard in `src/core/sheet.ts`; deferred
  until there is a real batch that needs it.
- **Loading extracted rows directly into the uploader.** The file is the review
  step. See "The honesty guarantees" below.

## Architecture

```text
src/core/extract/
  profile.ts     load / save / validate the .profile.json   (zod, as src/mcp)
  pattern.ts     "{last}_{first}_{title}" → parse a filename
  labels.ts      find "Performer: Jane Smith" in document text
  readers/
    pdf.ts       text layer + /Info properties; detects "no text layer"
    docx.ts      docProps/core.xml properties + word/document.xml text
  extract.ts     orchestrates: file → row
  csv.ts         serialise the sheet
```

Front ends stay thin, per the existing convention: `src/desktop/`, `src/cli/`,
`src/mcp/` wrap `src/core/extract/` and contain no extraction logic.

### Per-file pipeline

Each file is independent. One unreadable PDF must not abort a 300-file run —
the same per-row isolation `src/core/runner.ts` already uses for uploads.

```text
file → read (text + properties, or a no-text flag)
     → filename template      ─┐
     → label matcher           ├→ first non-empty wins, in this order
     → document properties    ─┘
     → "when blank" defaults
     → row
```

Precedence never overwrites: the first source to yield a value keeps it. The
default order is filename, then labels, then properties — filenames rank highest
because naming conventions here are deliberate and institution-controlled, while
embedded properties are frequently junk inherited from whoever created the file
(`Author` is often a license holder, not a creator).

That order is a **default, not a rule**: it is stored per column in the profile,
so a collection whose embedded metadata is actually trustworthy can invert it
without a code change. See "Profile format".

### The honesty guarantees

Two invariants, both learned from this project's own history of defects that
passed their own tests:

1. **Every generated value is traceable.** A `_source` column records where each
   value came from. One column cannot hold a single answer for a whole row —
   different cells come from different sources — so it holds compact
   `field=source` pairs:

   ```text
   _source:  title=filename; date=properties; creator=label
   ```

   Only fields that received a value appear. When a batch comes out wrong, the
   cause is visible rather than inferred.
2. **Nothing is silently dropped.** A file that yields nothing usable still gets
   a row, flagged in `_notes`. A file missing from the output must be
   indistinguishable from a file that was never in the folder — so it never is.

Both columns are `_`-prefixed and ignored by the uploader. `validateHeaders` in
`src/core/schema.ts` will warn if one survives into an upload.

**The extractor prefers a blank to a guess.** Where a source is ambiguous it
leaves the cell empty and says so in `_notes`. A blank cell is obvious in Excel;
a confidently wrong one is not.

## Profile format

**The profile is an ordered list of output columns.** That list is the
authoritative description of the spreadsheet: what columns exist, in what order,
and where each one's values come from. Columns are added, removed, reordered and
retargeted freely.

```json
{
  "version": 1,
  "pattern": "{last}_{first}_{title}_{date}.pdf",
  "columns": [
    { "path": "attachment name",       "sources": [{ "filename": true }], "locked": true },
    { "path": "MWDL/title",            "sources": [{ "placeholder": "title" }, { "label": "Title" }] },
    { "path": "MWDL/creators/creator", "sources": [{ "join": "{last}, {first}" }, { "label": "Performer" }] },
    { "path": "MWDL/date",             "sources": [{ "placeholder": "date" }, { "property": "created" }],
                                       "transform": "date" },
    { "path": "MWDL/publisher",        "sources": [], "default": "BYU-Idaho" },
    { "path": "MWDL/description",      "sources": [] }
  ]
}
```

Reading that: title comes from the filename, falling back to a `Title:` line.
Creator joins two filename parts, falling back to a `Performer:` label.
Publisher is a constant on every row. **Description has no source at all — it is
an empty column, deliberately, so there is somewhere to type in Excel.**

This one structure replaces the three separate maps the design previously had,
and it is what makes add/remove/change possible: each of those operations is an
edit to one list.

Details that are otherwise easy to misread:

- **`sources` is tried in order; the first non-empty value wins.** Nothing later
  overwrites anything earlier. The default order when the program builds a
  profile for you is filename, then label, then property — but because the order
  is per column and stored, you can override it where a particular collection
  needs it. This replaces the previously global, unchangeable precedence rule.
- **`sources: []` means an empty column.** Combined with `default`, it is a
  constant; without one, it is a blank column for manual entry. Both are
  legitimate and neither is an error.
- **`placeholder` names come from `pattern`;** `join` is a template over those
  same placeholders, for the common case of a name split across parts.
- **`transform: "date"`** normalises a recognised date to `YYYY-MM-DD`. A value
  it cannot recognise is left exactly as found and noted in `_notes` — a
  transform never discards the original.
- **`attachment name` is `locked`.** It is the one column the uploader requires,
  and it always holds the real filename on disk. It cannot be removed, renamed,
  reordered out of first position, or given a different source. Every other
  column is fully editable. The UI shows it greyed with a short explanation
  rather than hiding it, so its absence from the editable set is never a
  mystery.

Validated with zod at load time and checked against the real schema — a profile
naming an xpath that does not exist in `schema/_entity.xml` is rejected
immediately, not after 300 files, using the existing `validateHeaders` and
`suggest` in `src/core/schema.ts` so a typo gets the same "did you mean" help the
uploader already gives. Duplicate `path` entries are rejected for the same
reason `sheet.ts` rejects duplicate headers. `version` exists so a future format
change can be detected rather than misread.

A plain file is the only form of reuse that works identically in the GUI, the
CLI and MCP, which is why profiles are files rather than app settings.

## User interface

The people who run this are the ones `docs/INSTALL.md` assumes have never opened
a command line. The interface has to be usable by someone who does this twice a
year and remembers nothing in between.

### Principles applied

Each is tied to a concrete decision rather than cited decoratively.

| Principle | What it changed here |
| --- | --- |
| **Recognition over recall** (Nielsen #6) | The program detects the filename structure and shows it; the user confirms and names the parts. Nobody authors a `{template}` from a blank field. |
| **Visibility of system status** (#1) | A live preview of the first five files updates on every change. Extraction of a large folder shows per-file progress, as the upload screen already does. |
| **Error prevention over error messages** (#5) | Field targets are a dropdown of real schema xpaths, not free text. An invalid mapping cannot be expressed. |
| **Match the user's language** (#2) | Dropdowns read `Title — MWDL/title`, plain-language label first. The xpath stays visible because it is what the spreadsheet header must say. |
| **User control and freedom** (#3) | The output is a file. Nothing is committed, and Back never loses entered mapping. Removing a column offers inline **Undo** rather than a confirmation dialog — a modal in front of a reversible action is friction pretending to be safety. |
| **Flexibility and efficiency of use** (#7) | Columns can be added, removed, reordered and retargeted; source precedence is per column; profiles make a worked-out setup reusable. The novice never has to touch any of it, because the program proposes a working set of columns from the files themselves. |
| **Consistency** (#4) | Reuses the shipped screen chrome, banner, and button placement. Extract is a sub-wizard of the existing wizard, not a new idiom. |
| **Minimalism** (#8) | Label matching and defaults start collapsed. The common case — filenames only — fits on one screen with nothing expanded. |
| **Recover from errors** (#9) | A summary before saving: "12 of 300 files produced no title." Problems are counted and listed, never left for the user to notice in Excel. |

From current bulk-import practice (sources below), three patterns are adopted
directly:

- **File → map → validate → save**, as distinct steps.
- **Auto-match with unmapped columns visibly highlighted**, rather than an empty
  mapping the user must fill from scratch.
- **A per-field "when blank" control, on the same row as the mapping.** This is
  the notable one: it makes the "same value on every row" feature a property of
  each field, visible exactly where that field is configured, instead of a
  separate constants panel elsewhere in the UI. One concept, one place.

### Flow

**Step 1 — Choose the folder.** On selection, report immediately: how many files,
broken down by type, and any that cannot be read (`.doc`, unsupported) listed
explicitly rather than silently skipped.

**Step 2 — Columns.** The core screen, and the one the add/remove/change
requirement lands on. The detected filename structure is shown for reference at
the top; below it, **the columns of the spreadsheet, in order, as an editable
list**:

```text
Your files look like this:

   Smith  _  Jane  _  Recital  _  2026-04-12 .pdf
   └─last─┘  └first┘  └─title─┘   └───date────┘        ▸ edit the pattern

Columns in your spreadsheet                              [ + Add column ]

  ⋮⋮  attachment name          the file itself           🔒 required
  ⋮⋮  Title                    from  [ title      ▾ ]    ✕
  ⋮⋮  Creator                  from  [ last, first ▾ ]   ✕
  ⋮⋮  Date                     from  [ date       ▾ ]    ✕
  ⋮⋮  Publisher                always [ BYU-Idaho    ]   ✕
  ⋮⋮  Description              (empty — fill in Excel)   ✕
                                                          ⚠ nothing fills this

   Preview — first 5 files                    ⚠ 1 of 5 has no title
   ┌──────────────────┬─────────────┬────────────┬─────────────┐
   │ attachment name  │ MWDL/title  │ MWDL/date  │ MWDL/descr… │
   │ Smith_Jane_…pdf  │ Recital     │ 2026-04-12 │             │
   │ Lee_Anna_…pdf    │ Jury        │ 2026-04-13 │             │
   │ scan_0142.pdf    │ (blank)     │ 2026-04-13 │             │
   └──────────────────┴─────────────┴────────────┴─────────────┘
```

- **Add** opens the schema field list — searchable, showing plain-language names
  with their xpaths, and greying out fields already used. This reuses
  `parseSchemaPaths`, so the choices are the real ~158 leaf paths and nothing
  invalid can be picked.
- **Remove** (`✕`) takes the column out of the output entirely. It is
  immediately undoable from an inline "Removed *Date*. **Undo**" message rather
  than guarded by a confirmation dialog — the action is cheap to reverse and
  nothing is destroyed, so a modal would be friction without safety.
- **Reorder** by dragging the handle, with keyboard equivalents (a focused row
  moves with `Alt`+`↑`/`↓`), because drag-only reordering is unusable for
  keyboard and screen-reader users.
- **Change** the source from the per-row dropdown: a filename part, a document
  label, a document property, a constant, or nothing. The dropdown offers only
  sources that actually exist for these files — a `Performer:` label appears
  only if it was found in the scanned documents, so the list is evidence-based
  rather than aspirational.
- **A column that nothing fills is warned about, not forbidden.** Empty columns
  are a legitimate, common choice: somewhere to type in Excel.

Every edit re-renders the preview immediately, so the consequence of a change is
visible in the same glance as the change itself.

The template remains the stored form and the source of truth — the segment
display is a view over it, and editing it as text stays available for filenames
too irregular for the detector. This preserves the template mechanism chosen
during design while removing the requirement to type one.

**Step 3 — Save.** A summary of what will be written and what is thin, then Save.
Afterwards: the path, an **Open containing folder** button, and a plain
instruction to review it in Excel before uploading. Deliberately *no* "use this
now" button — the convenient path must not be the one that skips review, because
the guesses are exactly what needs reviewing.

### Accessibility

Every control has a real `<label>`; the segment table is a `<table>` with proper
headers, navigable by keyboard in reading order. Status and warnings are text as
well as colour — never colour alone. Focus moves to the first control of each
step and is visible. This matches the constraints already in place: a sandboxed
renderer with no Node access and a strict CSP.

## Command line

```bash
oeq-upload extract --dir ./files --profile music.profile.json --out rows.csv
oeq-upload extract --dir ./files --profile music.profile.json --dry-run
```

`--dry-run` prints the first five rows and the problem summary without writing.

Adding, removing or reordering columns from the command line means editing the
profile's `columns` array in a text editor — which is the point of keeping the
profile a plain, ordered, human-readable file rather than app state. `--dry-run`
after an edit is the fast way to confirm it did what you meant.

## MCP

Three tools, consistent with the existing rule that the MCP layer never streams
file bytes:

- `extract_preview` — first N rows for a folder and profile
- `extract_run` — write the CSV
- `suggest_profile` — given a folder listing, propose a pattern and mapping

Conversational mapping is a genuinely good fit for "work out my naming
convention", which is why MCP is included rather than deferred.

## Delivery order

Three surfaces is a lot to build at once, and the risk is uneven — the readers
are the part most likely to be wrong, and the GUI is the part most expensive to
change. So they are built in the order that puts real files through real code
earliest:

1. **`src/core/extract/` + the CLI.** Fully usable and fully testable against
   real PDFs and `.docx` files with no Electron involved. This is where the
   readers, the precedence chain and the profile format get proven — and where
   an error costs an edit, not a redesign.
2. **The desktop screens.** Built against a core whose behaviour is already
   settled, so the UI work is UI work.
3. **The MCP tools.** Thin wrappers, added once the profile shape has stopped
   moving.

Each stage is independently shippable. If the work stops after stage 1, the
result is a working extractor with a command line — not a half-built feature.

## Dependencies

Two new production dependencies:

- **`pdfjs-dist`** — PDF text and document properties. Used via its `legacy`
  build, which is the one that runs under Node without a DOM.
- **`fflate`** — a small zero-dependency unzipper. `.docx` is a zip of XML, and
  while `exceljs` bundles a zip implementation it does not expose one. The XML
  inside is parsed with `fast-xml-parser`, already a dependency.

CSV writing goes through `exceljs`, already a production dependency, rather than
hand-rolled quoting — the sheet reader's history with malformed CSV is reason
enough not to hand-roll the writer.

Both new packages ship inside the installer. The credential-scan step in
`.github/workflows/release.yml` covers them like any other bundled code.

## Testing

Readers are tested against **real files**, not stubs: a generated PDF with a text
layer, a PDF with none, a `.docx`, and a file yielding nothing. This project's
recurring failure mode is a mock and its code agreeing on the same wrong
assumption — `src/core/client.ts` and `tests/helpers/mockServer.ts` did exactly
that twice, and a 240-test suite stayed green. Fixtures must be bytes.

Unit coverage for `pattern.ts` (including filenames that do not match), the
per-column source chain, `labels.ts`, and profile validation including a bad
xpath.

Column editing gets its own tests, because it is the part a user touches most
and the part where a silent mistake is most expensive: that removing a column
removes exactly one, that reordering changes only order and never values, that
adding a duplicate path is rejected, that an empty column produces an empty
cell rather than a missing one, and that `attachment name` cannot be removed,
reordered, retargeted or renamed by any operation. That last one is a data-loss
guard, not a niceness — a spreadsheet without it cannot be uploaded at all.

Fixtures carry no real student names, per the standing rule.

## Risks

**This feature guesses; nothing else in the program does.** Mitigations: the live
preview, the `_source` column, blanks in preference to guesses, and an output
that is a file a human opens before anything is uploaded.

**`src/desktop/ui/app.ts` is 802 lines and has no test importing it.** The extract
screens must not be added to it. They go in `src/desktop/ui/screens/` with the
testable logic — segment detection, mapping state, preview construction — in
plain modules that tests can import without Electron, as `confirm.ts` and
`errors.ts` already do.

## Decisions taken during design

| Question | Decision |
| --- | --- |
| Same program or separate? | Same — output is this program's input format |
| Extraction sources | Filename, document text labels, embedded properties |
| Output | A spreadsheet file, reviewed in Excel; not loaded into the app |
| Repeating value | One constant per field, filled down; multi-value dropped |
| Column control | Add, remove, reorder and retarget any column; `attachment name` locked. Empty columns allowed on purpose |
| Filename mechanism | Fill-in-the-blank template, with a segment picker over it |
| Formats | PDF (text layer), `.docx`; scanned PDFs flagged; `.doc` excluded |
| Scanned PDFs | Filename + properties, flagged — no OCR |
| Document text | Match `Label:` lines only |
| Conflicts | Fixed precedence, first non-empty wins |
| Surfaces | Core + desktop + CLI + MCP |
| Config reuse | A shareable profile file |
| Output format | CSV |

## Sources

- [How To Design Bulk Import UX — Smart Interface Design Patterns](https://smart-interface-design-patterns.com/articles/bulk-ux/)
- [Best UX flow for spreadsheet imports — CSVBox](https://blog.csvbox.io/spreadsheet-import-ux/)
- [CSV import column mapping UI: safer matching, defaults, previews — AppMaster](https://appmaster.io/blog/csv-import-column-mapping-ui)
- [Building a Universal Data Import Wizard — C# Corner](https://www.c-sharpcorner.com/article/building-a-universal-data-import-wizard-mapping-columns-preview-validation/)
