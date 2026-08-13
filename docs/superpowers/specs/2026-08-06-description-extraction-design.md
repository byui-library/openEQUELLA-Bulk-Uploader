# Extracting a description — Design

**Date:** 2026-08-06
**Status:** Tiers 1–3 built and verified on real folders. Tier 4 not started;
its details are still open.
**Builds on:** [2026-08-05-metadata-extractor-design.md](2026-08-05-metadata-extractor-design.md)

## The problem, from real batches

The description column came out empty on almost every row of every run. Three
extractions of the operator's own folder produced a spreadsheet whose most
useful field was blank.

The cause is that different document formats state their description in
completely different places, and until now the extractor only knew about one:

| Format | Where the description actually lives | Before |
| --- | --- | --- |
| Word (18 job postings) | a table cell headed *Job Description* | extracted |
| PDF (12 journal articles) | the **abstract**, between the `Abstract` and `Keywords` headings | nothing |
| Anything unstructured | nowhere in particular | nothing |

The operator's framing is the right one: **this has to work across a variety of
documents in a variety of formats**, and some will have no table, no labels and
no headings at all.

## Four tiers, tried in order

A description column may name several sources. The first that yields anything
wins; nothing later overwrites it. That is the existing ordered-source
mechanism, not a new one.

### 1. A stated field — built

A table cell, a `Label:` line, or a document property. The document says what
the value is; reading it is not inference.

### 2. A named section — built

Text under a heading, ending at the next heading.

```json
{ "section": "Abstract" }
```

Start headings offered: `Abstract`, `Summary`, `Executive Summary`, `Overview`,
`Description`, `Purpose`, `Scope`. End at whichever of a set of following
headings comes first — `Keywords`, `Introduction`, `Background`, `Methods`,
`Contents` — or at a length cap.

Measured against all twelve of the operator's PDFs:

```text
8 files   Abstract -> Keywords        1,524-2,753 chars
06        Abstract -> Methods         1,001 chars
08        Abstract -> Introduction    1,828 chars
11        no Abstract heading         nothing
```

Eleven of twelve, deterministically, offline, at no cost. The twelfth genuinely
has no abstract heading; it is also the file whose embedded title is
`Microsoft Word - 22. Salazar_proof_10pix1line_revised`, so it is a poorly made
PDF rather than an unusual one.

**As built, it is twelve of twelve.** The column names every heading the scan
found, not just one — so file 11, which has a `Purpose` and no `Abstract`, is
filled by the second source in the list. One profile has to serve a whole
folder, and that is what an ordered source list is for.

### 3. The opening paragraph — built, and honest about being crude

The first substantial run of prose, after skipping the boilerplate that opens a
published PDF: copyright lines, DOIs, `Received:`/`Accepted:`/`Published:`
dates, licence text, `Citation:`.

This one is a heuristic and is treated as such. **Every value it produces is
flagged in `_notes`**, because on a journal PDF the opening paragraph is as
likely to be a masthead as a summary. It is offered because "sometimes right and
always visible" beats "always empty" — but it is never silent.

### 4. A language model — to build, optional, last

Runs only when tiers 1–3 all came back empty. It therefore cannot overwrite a
stated fact; the only thing it competes against is a blank cell.

This inverts the objection that ruled out an LLM for extraction generally. A
model asked to produce every field will confidently fabricate over real data. A
model asked only to describe a document that yielded nothing has no data to
contradict.

## Running without a key

**With no key configured, tiers 1–3 run exactly as they do now and tier 4 does
not exist.** No error, no prompt, no degraded mode. The tool stays usable
offline and the installer keeps its zero-prerequisite promise.

With a key, the Columns screen offers **"Write a description where nothing else
could"** — off by default, and stating how many documents would be sent before
anything runs.

## Provider

An institutional API key, distributed exactly as the OAuth client secret already
is: handed to the operator out-of-band, entered on Setup, stored encrypted per
Windows account in the existing per-instance store.

**A consumer subscription cannot be used.** Claude Pro, ChatGPT Plus, Gemini
Advanced and Copilot licence the chat interface; none issues an API key, and
driving a personal subscription from a script breaches its terms. This was the
operator's first preference and it is not available — recorded here so it is not
revisited.

The call sits behind an interface with the provider swappable, so changing
vendor is configuration rather than a rewrite.

## Provenance

`_source` already records where each value came from. A model-written cell reads
`description=ai`, so the reviewer can sort by that column in Excel and read only
those rows. The run reports the split — *"18 from the document, 11 from the
abstract, 1 written by AI"* — so nobody has to infer how much of a batch was
generated.

## Build order

Tiers 2 and 3 first. They need no key, no network and no policy decision, and
they would have solved this batch on their own. Tier 4 follows, behind the
provider interface.

## What tiers 2 and 3 actually did

Measured on the operator's own folders after building them:

```text
14 of 14 PDFs      12 read from a real Abstract or Purpose section
 2 of  2 Word       1 from a section, 1 from the opening paragraph
 2 flagged          the two that deserved it, and no others
```

Every description cell that was blank on three previous runs is now filled, and
the two uncertain ones say so in `_notes`.

Two things were learned in the building that the design did not anticipate:

- **A capped section is a signal, not just a truncation.** A section that runs
  to the length cap never reached another heading, which usually means the
  heading was not a heading. That case is now flagged like tier 3 is.
- **The tier 3 rules needed individual tests.** The first drafts of the negative
  tests all passed unchanged when the rule each one named was deleted — every
  one was actually failing on the sentence rule by accident.

## Still open — for the tier 4 conversation

- Which provider and model
- The prompt, and how long a description should be
- What happens when a call fails or times out: blank plus a note, presumably,
  never a partial or retried-forever row
- A cost guard: a cap per run, and what the operator sees before committing to it
- Whether an AI-written description should be marked as such in the item itself,
  not only in `_source`

## Scanned documents: OCR happens outside this tool

**Decided 2026-08-07. Not a gap to be filled later — a boundary.**

A batch of ten alumni obituaries arrived as PDFs with **no text layer at all**:

```text
0 chars  textLayer=false  Alden Larkspar Obituary.pdf
0 chars  textLayer=false  Marcus Fennel Obituary.pdf
…all ten identical
```

They are scans of newspaper clippings — the existing catalogue records say so
in `MWDL/conversionSpecifications`: "Scanned to PDF". Every tier above needs
text, so all four produce nothing, and the extractor correctly flags each row
"no text layer -- nothing could be read from inside this file".

Building OCR in was considered and **rejected**:

- Rendering a PDF page to an image needs a canvas, which in Node is a native
  dependency. This app ships pure JavaScript today, which is why packaging is
  simple and the installer has no prerequisites.
- 1990s newsprint is close to worst-case for OCR — low contrast, halftone
  screening, tight columns, skew. Bundled Tesseract would produce wrong digits
  in exactly the fields that matter, dates and names.
- Acrobat, ABBYY and `ocrmypdf` already do this better, and OCRing the files
  makes them full-text searchable in openEQUELLA, which is worth doing for its
  own sake regardless of this tool.

**So: OCR the folder first, then point the uploader at it.** A PDF with a text
layer is an ordinary input and needs no special handling.

One thing OCR alone will NOT solve. The target description in these records is
a synthesis, not a quotation:

> Died March 2, 1991: Willow Bend, Idaho, pneumonia; Born June 5, 1928;
> Attended Ricks College; Obituary also appeared in the Post Register 03/04/1991

No section-finding produces that from a clipping, however clean the text. It is
specific facts pulled out and rewritten in a house style — a tier 4 case, and a
good one, because the output is well defined and highly repetitive.

## Out of scope

Subjects and keywords. Raised and explicitly deferred by the operator.
