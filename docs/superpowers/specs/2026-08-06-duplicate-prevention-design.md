# Preventing duplicate items — Design

**Date:** 2026-08-06
**Status:** Approved. Not yet planned or built.
**Occasion:** The operator uploaded the same 30 files twice and the tool said nothing.

## The fault

The tool already has a duplicate pre-flight. `preflightDuplicates`
([src/core/plan.ts](../../../src/core/plan.ts)) runs on every plan, in all three
front ends — CLI, desktop and MCP. Its first act is:

```ts
const identifier = entry.metadata['MWDL/identifier']?.[0]?.trim();
if (!identifier) continue;
```

It checks **`MWDL/identifier`**, and the metadata extractor has never produced
that column. A starter profile builds `attachment name`, `MWDL/title`,
`MWDL/creators/creator`, `MWDL/description` and sometimes `MWDL/date`. So every
row is skipped, the pre-flight returns an empty list, and Review reports no
duplicates by never having looked.

This is not "build a duplicate check". It is "the check we have is reading a
field nobody fills in."

## What counts as a duplicate

Two tiers, because they deserve different treatment:

| Tier | Evidence | Meaning |
| --- | --- | --- |
| **Near-certain** | an existing item has the same title **and** an attachment with the same filename | this file has been uploaded before |
| **Possible** | an existing item has the same title, but no attachment filename matches | might be a duplicate, might be two students with the same recital name |

Filename comparison is case-insensitive and trimmed, matching how `sheet.ts`
already compares attachment names within a spreadsheet.

## The query

One request per planned row:

```http
GET /api/search
  ?collections=<collectionUuid>
  &where=/xml/MWDL/title = '<title>'
  &info=attachment
  &showall=true
  &length=50
```

Three parts of that are load-bearing:

- **`where`** matches a schema node exactly, server-side. This is what makes the
  check viable at all: the target collection holds over 100,000 items, so
  reading it wholesale and comparing locally is not an option, and free-text
  `q` cannot be trusted to match exactly (see "Rejected alternatives").
- **`info=attachment`** returns each hit's attachments in the same response, so
  the filename tier costs no extra requests.
- **`showall=true`** is mandatory. `/search` excludes items that are not live,
  and every item this tool creates is a draft by default. Omitting it would make
  the check blind to precisely the items most likely to be duplicates — this
  tool's own recent runs. That exact mistake has already been made once in this
  codebase and is recorded in CLAUDE.md.

`length=50` bounds the response. A title with more than 50 existing matches is
reported as a possible duplicate without enumerating them; nothing about the
verdict changes.

## When it runs

During `plan`, where `preflightDuplicates` already runs today — not as a
separate action the operator has to remember. Review therefore shows the
verdicts on the screen where the operator is already deciding whether the batch
is right, before Confirm and before anything uploads.

## What happens to the identifier check

It stays. A hand-made spreadsheet that does populate `MWDL/identifier` gets
that check as well, unchanged, in addition to the title-and-filename check. It
costs one extra query only on rows that actually carry an identifier, and
removing a working check because it was mis-scoped would be the wrong lesson to
draw from this.

## Verdicts

| Situation | Verdict |
| --- | --- |
| no hits | clean |
| a hit has an attachment whose filename matches this row's file | near-certain |
| hits, none whose attachment filename matches | possible |
| the row's title is empty | **not checkable** — reported, never treated as clean |
| the request fails or is rejected | **could not check** — reported per row, never treated as clean |

The last two matter more than they look. A check that fails quietly is worse
than no check, because it teaches the operator that silence means safety. There
is no path through this design where an unchecked row is presented as clean.

## What the operator does

Review gains a duplicates section listing each flagged row with **Skip** and
**Upload anyway**, and the reason it was flagged.

Defaults differ by tier, deliberately:

- **near-certain → Skip.** The filename matched; re-uploading is almost never
  what anyone wants.
- **possible → Upload.** Two students genuinely can share "Senior Recital".
  Defaulting these to Skip would silently drop legitimate items, and a silent
  omission is worse than a visible duplicate — the operator can delete a
  duplicate they can see, but cannot notice an item that never arrived.

Both are visible and both are changeable per row before anything uploads.

## How a skip is carried out

A row the operator skips is written into the manifest with
`status: 'skipped'` and an `error` string naming the reason.

No runner change is required. `skipped` is already in `TERMINAL_STATUSES`
([src/core/runner.ts](../../../src/core/runner.ts)), and the runner already
counts terminal-status rows into `summary.skipped` and reports them. The
Results screen already shows that count.

One cosmetic follow-on: the Results screen labels that count
"Skipped (already done)", which will now also mean "skipped as a duplicate".
The label should be widened to just "Skipped".

## The front ends

The verdict logic lives in core and is shared:

- **Desktop** — the per-row Skip/Upload choice described above.
- **CLI** — reports the tiers, skips near-certain rows by default, and gains
  `--upload-duplicates` to override. The existing `--skip-duplicate-check`
  keeps its current meaning: do not check at all.
- **MCP** — returns the verdicts in its plan response. It never decides; the
  layer that plans is not the layer that uploads.

## The risk, and what is done about it

**This instance's `where` syntax is unverified.** The parameter is documented in
the captured `schema/swagger.json`, but only as a pointer to external
documentation, and this tool has never used it.

That is the same class of assumption that has already been wrong twice here —
the staging area being a `?file=` query parameter rather than a body field, and
`/search` defaulting to `showall=false`. Both were believed by the entire test
suite and refuted only by the live instance.

So:

1. **A live probe against the test instance comes first**, before any code
   depends on the clause. It confirms the syntax, the escaping, and that a
   known-present title returns exactly one hit while a known-absent one returns
   none. This mirrors the live smoke test the README already prescribes for the
   attachment payload.
2. **Rejection is loud.** If the server rejects the clause, every row reports
   "could not check" and the operator sees it.

## Escaping

A title containing an apostrophe — `Bach's Prelude`, and this is a music
library — must not break or alter the query. Escaping is part of building the
clause and gets its own tests, including a title containing a quote, a
backslash, and a newline. Whether the correct escape is `''` or `\'` is one of
the things the live probe establishes.

## Performance

One request per row, a small number in flight at once. Thirty rows finishes in
seconds. Collection size does not enter into it: the server filters.

Results are held for the duration of a plan so that re-checking after the
operator changes a mapping does not re-query rows that have not changed.

## Testing

- **Unit, against recorded search responses:** each verdict in the table above;
  filename matching that ignores case and surrounding space; a hit with no
  attachments; more hits than `length`; an empty title; a rejected request.
- **Escaping:** apostrophe, quote, backslash and newline in a title.
- **Query construction:** that `showall=true` and `info=attachment` are present.
  A test asserting this exists specifically because omitting `showall` is a
  silent, plausible-looking failure that has happened before.
- **Live probe:** documented in the README alongside the existing smoke test,
  run against the test instance, recorded in the handoff when it passes.

## Rejected alternatives

**Free-text `q` search.** The smallest change — `identifierExists` already does
it. Rejected because its own doc comment concedes the phrase-quoting behaviour
is unconfirmed: a search for `"Senior Recital"` may match any item containing
"senior" or "recital". False alarms are not a harmless failure mode; they train
the operator to click past the warning, which leaves them worse off than no
check.

**Reading the whole collection and comparing locally.** Exact, and entirely
under our control. Rejected on size: over 100,000 items.

**Stamping a fingerprint into `MWDL/identifier` on upload.** Would make the
existing pre-flight work as written and would catch renamed files. Rejected for
now on two counts: it is blind to the 100,000 items already there, and it writes
a filename or hash into a curatorial field that means something specific to
cataloguers. Worth revisiting if renamed re-uploads turn out to be a real
problem.

**Overwriting or deleting the existing item.** The operator asked about this
first and then declined it. The tool has only ever created; the target
collection has no moderation workflow, so a wrong overwrite is live immediately
with nothing to catch it. Out of scope.

## Out of scope

- Overwriting, replacing or deleting any existing item.
- Cleaning up the duplicates created on 2026-08-06. The operator will remove
  those by hand in openEQUELLA.
- Catching a re-upload whose title was changed. Nothing in this design can see
  that, and it is stated here so nobody assumes otherwise.
- Duplicates *within* one spreadsheet. `buildManifest` already rejects those.
