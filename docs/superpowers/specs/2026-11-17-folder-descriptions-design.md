# Model-written descriptions for folder rows — design

2026-11-17. Branch `feature/multi-file-items`. Follows the description-length
work of the same day (`core/extract/length.ts`).

## Why

A folder row is one item holding several files: for *Snake River Echoes*, one
volume of a quarterly journal and its three to five issue PDFs. Its
description today is either a fixed sentence from the template ("Upper Snake
River Valley Historical Society Quarterly, Volume 2") or, with no template,
text copied from the first issue. The first says nothing about what is in the
volume. The second describes one issue, and it is text copied from the
document, not a summary.

The language model pass does not run on folder rows at all
(`core/ai/fill.ts`, reason `'folder-row'`). Two things stopped it:

- **It is sent one document.** A volume is several, and a description of the
  volume has to come from all of them.
- **`verify.ts` checks against one document.** Which document a claim about a
  volume must be supported by was left as "a separate design". This is that
  design.

## Decisions (operator, 2026-11-17)

1. **The fixed sentence always comes first, and the model's summary follows
   it**, in the same description field.
2. **The summary covers the subjects of the volume**: the topics, places,
   people, events and periods its issues cover, in one or two sentences of
   prose. It does not list article titles.
3. **One or two paragraphs at most: the whole cell stays within the column's
   limit**, 1,000 characters by default (`DESCRIPTION_LIMIT`).
4. **The model reads the start of every issue**: about 2,000 characters each
   for a four-issue volume.
5. **Claims are checked against all of the volume's issues together.**
6. **The item says that a model wrote part of its description.** For Snake
   River Echoes this goes in `MWDL/conversionSpecifications`, beside "Scanned
   to PDF".

## Approaches considered

- **A. The model writes after what the column already holds.** Chosen. The
  description column keeps its fixed-sentence source, and the `ai` source
  says the model's text follows it. If the model fails or is refused, the
  fixed sentence stands alone, so no row ever loses its description to a
  model failure. Nothing in it knows about journals: any collection can put a
  fixed lead before a summary.
- **B. The summary goes in a separate field.** Simpler, but the operator wants
  both in the description, and a second field would be one more place for a
  reader to miss.
- **C. A composed column joins a fixed part to a model-written part.** It
  would need the model pass to run before composing. Composing happens during
  extraction, which never touches the network, and keeping it that way is why
  the model pass is separate (CLAUDE.md). Rejected.

## The design

### 1. The profile: `{ "ai": true, "after": true }`

An `ai` source may carry `"after": true`. It means: "write the model's text
after whatever this column's other sources produced, separated by one space."
The Snake River Echoes description column becomes:

```json
{ "path": "MWDL/description",
  "sources": [
    { "join": "Upper Snake River Valley Historical Society Quarterly, Volume {group}." },
    { "ai": true, "after": true }
  ] }
```

Note the full stop added to the fixed sentence, so the summary starts a new
sentence.

**Which cells it fills.** `eligible.ts` has one rule today: an empty cell, or
one a source flagged. An `after` column has its own rule: **it is filled on
every row the model has not already written** (`aiWritten[path]` absent),
whatever the cell holds. It never replaces anything: the earlier value is kept
in front, flagged or not. An empty cell gets the summary alone.

**How much room the model gets.** The column's limit (`limitFor(column)`),
minus the lead and the one space joining them. For Snake River Echoes the lead
is about 70 characters, so the model is told about 930. If the lead leaves
fewer than 100 characters, nothing is sent and the row is noted: the room is
too small for a useful summary, and a call that cannot succeed should not be
paid for.

**What is written.** `lead + ' ' + summary`, or the summary alone. `_source`
records `ai` as now, and `aiWritten[path]` carries the note, so a second pass
over the same rows does not send the row again.

`parseProfile` accepts `after` only as `true`, and only on an `ai` source.

### 2. What the model is sent for a folder row

The row's documents, in attachment order. Each one contributes **the start of
its text**, not `readOpening`'s first prose line: a journal issue opens with
its masthead and contents, which are the best summary of what is in it.

- **The budget (`OEQ_MODEL_BUDGET` / Setup, default 8,000) is divided evenly
  across the issues.** A four-issue volume sends about 2,000 characters of
  each. One budget, one setting, the same consent arithmetic.
- **Each part is labelled with its file name**, so the model can tell where
  one issue ends and the next begins.
- **A file the readers could not open, or with no text layer, is left out of
  the slice and named in the row's notes.** If nothing is left, the row is not
  sent, and is noted as a single-file row with no text is today.
- **Each share is cut at a word boundary.** A cut sentence costs the model
  little; a cut word can be misread as a name.

A single-file row is sliced exactly as today (`sliceForModel`).

The new code is one pure function, `sliceFolder(docs, budget)` in `slice.ts`,
returning the same `Slice` shape. `fillWithModel` picks it when a target
holds more than one document.

### 3. The prompt

`buildPrompt` gains one fact: how many documents the slice holds. For a folder
row the first line reads *"Write a description of the volume below, made up of
N issues, for a library catalogue."* Everything else in it stays: use only
what the documents state, the length limit, the document fence, the house
style.

The house style comes from the template (`aiInstruction`), as for the
obituaries. For Snake River Echoes:

> Summarise the subjects the issues cover — the topics, places, people,
> events and periods — in one or two sentences of plain prose. Do not repeat
> the journal's title or the volume number, which are already given. Do not
> list article titles.

### 4. Checking the model's work

`unsupportedClaims(generated, evidence, profile)` is unchanged. For a folder
row, the evidence is read from **the full text of every issue, joined**, not
from the slice: a claim another page of the volume supports is a coincidence,
not a fabrication. This is the same rule that a single-file row is checked
against its whole document.

Anything the volume does not support is refused whole, as now. **The cell then
keeps the fixed sentence alone**, and the note says what was refused and
quotes the reply. A reply over the room it was given is refused whole, never
shortened.

### 5. Disclosure in the item

The Snake River Echoes template gains:

```json
"aiProvenance": {
  "path": "MWDL/conversionSpecifications",
  "append": "Description partly generated by a language model ({model})"
}
```

`discloseInItem` already joins this to the column's value with `'; '`, once
per row, and only on a row the model wrote. A volume whose summary was refused
says only "Scanned to PDF". No template uses `aiProvenance` yet: this is its
first use, and the mechanism already exists and is tested.

### 6. Getting the documents to the pass

`extractFolders` gains the `onRow` hook `extractFolder` has: `(row, docs)`,
called once per folder row with the documents it read. The callers collect
targets from it and run the pass after extraction, as they do for single
files.

`FillTarget` becomes `{ row, docs: FolderDoc[] }`, one entry for a single-file
row. This is the one interface change the pass needs.

The `'folder-row'` reason and its notes are deleted, and the command line
stops refusing `--ai --per-folder`.

### 7. Consent and cost

There is one request per folder row, so the confirmation counts rows as it
does today. The characters line stays a true maximum: `requests × budget`.
The desktop dialog and `confirm.ts` change no wording. "Each request" is now
sometimes a volume, and the text never said "each file".

### 8. The preview

The preview never runs the model (existing rule). A folder row's preview
shows the fixed sentence, as it does today.

## Error handling

Every failure leaves the fixed sentence in the cell and a note on the row:

- **Model unreachable, timed out, or the reply was cut at `max_tokens`:** the
  existing failure notes, with outcome "not replaced".
- **The reply was refused** (unsupported claim, over the limit, preamble only,
  a refusal): the existing notes, quoting what was said.
- **Not enough room after the lead:** "not sent to the model -- the fixed text
  leaves fewer than 100 of this column's N characters".
- **No issue had text:** "not sent to the model -- no file in this folder has
  text to read".
- **The run cap was reached:** the existing note.

## Testing

From invented fixtures only, test-first, with mutation checks applied through
the Edit tool (source files are CRLF).

- `sliceFolder`:
  - the even division;
  - attachment order;
  - labels;
  - an unreadable or empty file left out and named;
  - word-boundary cuts;
  - the result within the budget.
- `eligible.ts`: an `after` column is eligible when the cell holds a value,
  when it is flagged, and when it is empty; it is not eligible once
  `aiWritten` has an entry.
- `fill.ts`:
  - the lead is kept and joined with a space;
  - the room is the limit minus the lead;
  - too little room sends nothing;
  - a refused reply leaves the lead alone;
  - a claim supported only by issue 3 passes;
  - a claim supported by no issue is refused;
  - the provenance is appended once.
- `profile.ts`: `after` accepted on `ai`, refused elsewhere and refused as
  `false`.
- `extractFolders`: `onRow` receives the documents in attachment order.
- CLI and desktop: `--ai --per-folder` runs. A folder batch's model cells are
  filled, not noted as unsupported.

**Then a live run, operator present**:
- **Inputs:** four or five real volumes; the operator's model in LM Studio
  (`http://127.0.0.1:1234/v1`, the `/v1` is required); the Snake River
  Echoes template.
- **Offline:** extract only, nothing uploaded.
- **What the operator reads:** every summary against its volume. **Whether a
  summary is good is a human judgement**; the tests check the machinery, not
  the prose.
- **What gets recorded:** how many were written, refused and why, and whether
  any refusal was wrong. Nothing from the documents goes into the repository.

## Out of scope

- Article-title lists (decision 2).
- A limit box on the columns screen. A profile sets `maxLength`.
- Re-running the model on a row it has already written. Clear the cell and
  re-extract.
- Reading prose to check a summary's wording. `verify.ts` checks checkable
  claims, never paraphrase.
