# Collection templates — Design

**Date:** 2026-08-07
**Status:** Approved. Not yet planned or built.
**Occasion:** A batch of ten alumni obituaries that the generic extractor could
say almost nothing about.
**Builds on:** [2026-08-05-metadata-extractor-design.md](2026-08-05-metadata-extractor-design.md),
[2026-08-06-description-extraction-design.md](2026-08-06-description-extraction-design.md)

## The problem

Different collections need different knowledge. An alumni obituary keeps its
death date in a sentence — *"passed away on September 8, 2019"* — or in a dash
pair after the name, and its genre, subjects and rights are the same on every
record in the collection. None of that is expressible with the generic sources,
and none of it should be hard-coded, because the next collection will be
different again.

The operator's framing: **as little human intervention as possible**, and for
this collection **the name and the death date are what matter**. Anything else
that cannot be read reliably is better left out — the PDF is attached, and a
person can read it.

## What a template is

**A profile JSON.** The format the app already saves and loads, shipped as a
file:

```text
templates/alumni-obituary.profile.json
```

It appears on the Extract flow as *"Start from: Generic / Alumni Obituary"*.
Authoring a new one means building a profile in the app and saving it — no
code, no developer, and a colleague can use it by opening the file.

This is the whole point of the design. A code pack per collection was
considered and rejected: every new collection would need a developer, and each
pack would be its own thing to test. One mechanism, tested once, configured
many times.

## What the format gains

Three sources and one check. **All generic — nothing in the code knows what an
obituary is.**

### `{ "dateNear": ["passed away", "died", …] }`

The first date following any of the given phrases, **within 80 characters of
the end of the phrase**. The window matters: without one, "died" near the top
of a document would reach a funeral date hundreds of characters away. Eighty
covers every real case in the batch — the longest gap is
*"returned home to his Heavenly Father on"*, at 39 — with room for OCR noise.

Phrases are matched case-insensitively, and the first phrase in the list that
produces a date wins, so the order in the profile is the order of preference.

Real examples from the batch:

```text
"graduated this world on   [March 5, 2019]"                Marcus
"passed away on            [September 8, 2019]"            Orrin
"returned home to his Heavenly Father on [June 27, 2019]"  Ivor
```

### `{ "datePair": "first" | "second" }`

Four of the ten state the dates with **no phrase at all** — just the name, then
birth and death separated by a dash or a space:

```text
Gideon olwyn Alder         April 5, 1954  -  October 2, 2019
Thaddeus E>or1an Hawthorn  December 8, 1947 - July 3, 2019
Corwin Ames Teasel         August 14, 1951   May 1, 2019
```

`"second"` takes the death date, `"first"` the birth date.

**A pair is two dates separated by at most 12 characters**, none of them a
letter or a digit — so a dash, a space, or the whitespace and punctuation OCR
leaves behind all qualify, while two dates in separate sentences do not. The
first such pair in the document wins; these documents state the name-and-dates
line before any other prose.

**The two are combined by the ordered-source list that already exists:**

```json
{ "path": "BYUI_extended/BYUI_information/special_collections/alumni_obituary/death_date",
  "sources": [
    { "dateNear": ["passed away", "died", "returned home", "graduated this world"] },
    { "datePair": "second" }
  ],
  "transform": "date" }
```

First non-empty wins, so neither form needs to know about the other. No new
combining mechanism is invented. `transform: "date"` normalises
`March 5, 2019` to `2019-03-05`, which `normaliseDate` already does.

### `{ "compose": "Died {death_date}" }`

Builds one field from others, so the death date can appear in the description
as well as its own field — as the existing catalogue records do.

**A placeholder names a column, not an xpath.** A column may declare a short
name for itself, and `compose` refers to that:

```json
{ "path": "BYUI_extended/BYUI_information/special_collections/alumni_obituary/death_date",
  "as": "death_date",
  "sources": [ … ] }
```

Without `as`, a column cannot be referenced. Xpaths are far too long to write
inside a template, and naming the reference explicitly means renaming a column
never silently breaks one.

**Composed columns are resolved after the columns they name.** A profile whose
`compose` references a column that does not exist, or that forms a cycle, is
rejected when the profile loads — the same place a malformed date format is
rejected today, and for the same reason: a batch should fail before it starts,
not part-way through.

Two rules for the template itself:

- **`[...]` marks an optional group**, dropped entirely including its
  punctuation if any placeholder inside it is empty.
- **A `;`-separated clause whose placeholders are all empty is dropped**, so
  the output is never `Died March 5, 2019; ;`.

`Died {death_date}[: {residence}]; Born {birth_date}` with no residence yields
`Died March 5, 2019; Born November 13, 1907`.

### `"checks": { "filenameWordsInText": { "ignore": ["Obituary"] } }`

Flags a row when a word from the filename does not appear in the document.
Measured on the batch:

```text
Alden Larkspar    MISSING ["Larkspar"] ← the document says "Larkspur" throughout
…the other nine   all present
```

One flag, and it is the right one. **Whole-word matching is what makes this
work**: `Marcus Fennel` never appears contiguously — the text reads
`Marcus T Fennel` — but both words do. Matching the full name would flag
nine rows out of ten.

It survives OCR damage for the same reason. Middle names came out as
`!;ennick`, `E>or1an`, `olwyn` and `c eVarn`, and none is a filename word, so
none is ever tested.

A profile option rather than a hard-wired rule, so any collection where the
filename is supposed to reflect the contents can switch it on. The note reads:
*"the file is named 'Alden Larkspar' but the document does not contain
'Larkspar'"*.

## What the Alumni Obituary template contains

| Field | How |
| --- | --- |
| `attachment name` | the file |
| `MWDL/title` | `Alumni Obituary: ` + filename parts — **existing** pattern and join |
| `MWDL/identifier` | the filename, as the existing records do |
| `…/alumni_obituary/death_date` | `dateNear` then `datePair`, `transform: date` |
| `MWDL/description` | `compose: "Died {death_date}"` |
| genre, subjects, contributor, rights, `conversionSpecifications`, `source`, `date_digitized` | column defaults — **existing** |

Only one row of that table needs anything new. The rest is configuration.

## Deliberately not extracted

- **Cause of death.** The sample record says *"pneumonia"*; these documents
  say *"natural causes"* and *"after a four-year…"*. Too varied to read
  honestly.
- **Birthplace.** Attempted, and the captures were `"Elmsgate, a son to
  Wendell Vance R"` and `"Marchmont Hospital, in Pasadena Ca"`. Wrong, and
  plausibly wrong, which is worse.
- **Residence and the Ricks College connection.** Both extract at 8/10 and
  would need two further source kinds (`textNear`, `presence`). Dropped on the
  operator's instruction: not worth the build, and a reader has the PDF.
- **Publication date.** Not present in any of these ten.

A wrong fact in a permanent catalogue record is worse than an absent one. That
principle decided every row of this list.

## Honesty

`_source` gains `dateNear`, `datePair` and `compose`. A row whose death date
came back empty is flagged, because for this collection that is the field that
had to work. `filenameWordsInText` writes its own note.

## Build order

1. `compose` — testable with no documents at all
2. `dateNear` and `datePair` — the death date
3. `filenameWordsInText`
4. The shipped template, and the "Start from" choice on the Extract flow

## Verification

Against the operator's ten obituaries:

- **An independent cross-check exists.** Three files (Marcus, Gideon, Thaddeus)
  have a numeric `Approx Date of Death` that survived OCR. The extracted date
  must equal it: `03/05/2019`, `10/02/2019`, `07/03/2019`.
- Five more whose numeric header was mangled beyond reading — into a longer
  digit run, a truncated fragment, or one or two stray characters — must still
  yield a date from the prose.
- **Alden Larkspar must come out blank and flagged.** His obituary says only
  where the death fell by season and time of day, and states no date anywhere. A value
  here would mean the rules are guessing.
- The name check must flag exactly one row.

## Why the numbers in this document are trustworthy

Every count above was measured against the operator's own ten files, not
estimated. The dates were originally read from the numeric header and recovered
in only 3 of 10; reading the prose instead took it to 9 of 10. That finding is
what made this feature worth building rather than buying better OCR software —
the OCR was fine, the wrong part of the page was being read.

One measurement error was made and corrected along the way: a first pass
reported Hollis Bracken's death date as `February 19, 2019`, his funeral. His
actual death date is written `February 11 , 2019`, with a space before the
comma, and the pattern missed it. **The date pattern must tolerate whitespace
around punctuation**, and that is a requirement, not a detail.

## Out of scope

- A code-level plugin per collection. Rejected above.
- The description synthesis of the existing records — *"Died March 2, 1991:
  Willow Bend, Idaho, pneumonia; Born June 5, 1928; Attended Ricks College"* —
  which needs facts this design deliberately does not extract. That remains a
  tier 4 case; see the description-extraction design.
- OCR. Done outside this tool, decided 2026-08-07.
