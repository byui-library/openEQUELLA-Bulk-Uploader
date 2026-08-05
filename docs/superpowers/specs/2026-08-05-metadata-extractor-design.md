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
  profile.ts     load / save / validate the .profile.json   (zod, as config.ts)
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

Precedence is fixed and never overwrites: filename, then labels, then
properties. Filenames rank highest because naming conventions here are
deliberate and institution-controlled, while embedded properties are frequently
junk inherited from whoever created the file (`Author` is often a license
holder, not a creator).

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

```json
{
  "version": 1,
  "pattern": "{last}_{first}_{title}_{date}.pdf",
  "fields": {
    "last+first": { "path": "MWDL/creators/creator", "join": "{last}, {first}" },
    "title":      { "path": "MWDL/title" },
    "date":       { "path": "MWDL/date", "transform": "date" }
  },
  "labels": { "Performer": "MWDL/creators/creator" },
  "defaults": { "MWDL/publisher": "BYU-Idaho" }
}
```

Three details that are otherwise easy to misread:

- **`fields` keys are placeholder names from `pattern`.** A key naming several
  placeholders (`"last+first"`) combines them into one field using `join`, which
  is a template over those same placeholders.
- **`transform: "date"`** normalises a recognised date to `YYYY-MM-DD`. If the
  value is not recognisable as a date it is left exactly as found and noted in
  `_notes` — a transform never discards the original.
- **`defaults` is one map, keyed by xpath, serving both UI controls.** The
  per-field "when blank" control and the collapsed "add a value to every row"
  panel both write here. A default applies when the field is blank after all
  three sources have run, which makes a constant simply the case where the field
  is always blank. One concept, one place in the file.

Validated with zod at load time and checked against the real schema — a profile
mapping to an xpath that does not exist in `schema/_entity.xml` is rejected
immediately, not after 300 files. `version` exists so a future format change can
be detected rather than misread.

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
| **User control and freedom** (#3) | The output is a file. Nothing is committed, everything is reversible, and Back never loses entered mapping. |
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

**Step 2 — Map.** The core screen. The detected segmentation is shown against a
real filename from the folder:

```text
Your files look like this:

   Smith  _  Jane  _  Recital  _  2026-04-12 .pdf
   └──1──┘   └─2─┘   └───3───┘   └────4─────┘

   1  Smith        → [ Creator — MWDL/creators/creator  ▾ ]  when blank [ leave empty ▾ ]
   2  Jane         → [ ⤷ joined with 1 as "Last, First"  ▾ ]
   3  Recital      → [ Title — MWDL/title               ▾ ]  when blank [ leave empty ▾ ]
   4  2026-04-12   → [ Date — MWDL/date                 ▾ ]  when blank [ leave empty ▾ ]

   ▸ Also read labels inside the documents            (collapsed)
   ▸ Add a value to every row                          (collapsed)

   Preview — first 5 files                    ⚠ 1 of 5 has no title
   ┌────────────────────┬───────────────┬────────────┐
   │ attachment name    │ MWDL/title    │ MWDL/date  │
   │ Smith_Jane_…pdf    │ Recital       │ 2026-04-12 │
   │ Lee_Anna_…pdf      │ Jury          │ 2026-04-13 │
   │ scan_0142.pdf      │ (blank)       │ 2026-04-13 │
   └────────────────────┴───────────────┴────────────┘

   Advanced: edit the pattern directly  {last}_{first}_{title}_{date}.pdf
```

The template remains the stored form and the source of truth — the segment table
is a view over it, and the text field stays available for filenames too
irregular for the detector. This preserves the template mechanism chosen during
design while removing the requirement to type one.

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

One new production dependency for PDF text extraction (`pdfjs-dist` or
equivalent). `.docx` requires only zip + XML. CSV writing goes through `exceljs`,
already a production dependency, rather than hand-rolled quoting — the sheet
reader's history with malformed CSV is reason enough not to hand-roll the
writer.

## Testing

Readers are tested against **real files**, not stubs: a generated PDF with a text
layer, a PDF with none, a `.docx`, and a file yielding nothing. This project's
recurring failure mode is a mock and its code agreeing on the same wrong
assumption — `src/core/client.ts` and `tests/helpers/mockServer.ts` did exactly
that twice, and a 240-test suite stayed green. Fixtures must be bytes.

Unit coverage for `pattern.ts` (including filenames that do not match), the
precedence chain, `labels.ts`, and profile validation including a bad xpath.

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
