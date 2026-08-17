# Editing a profile without a text editor — Design

**Date:** 2026-08-17
**Status:** Approved. **Stage 1 is built** (2026-08-17); stages 2–4 are not.
**Occasion:** The operator, part-way through hand-testing the language-model
feature: *"can we put together a GUI for creating and configuring the json
file? Some people will struggle with creating and editing a json file."*

## What is already there, and what it does wrong

The Extract flow's columns screen is already a profile editor. It edits the
filename pattern, one source per column, a default value, and the order and
membership of the column list, and it can open and save a profile file.

**It is also lossy, today, on the one template that ships.** Two defects found
while exploring for this design, both reachable from the shipped UI, neither
caught by 2069 tests:

- **`setDefault` drops half the column.** `Column` carries eight fields;
  `setDefault` rebuilds one preserving `path`, `sources`, `transform`,
  `locked` and `default`, and silently discards **`as`, `flagIfEmpty` and
  `composeOnly`**. Typing a default into the Alumni Obituary template's
  `MWDL/coverage` column destroys its `as: birth_date` alias and its
  `composeOnly` flag, after which the description's `compose` template refers
  to a name that no longer exists.
- **`setSource` collapses the source chain.** The screen reads
  `column.sources[0]` and sets a single source, so choosing anything from the
  dropdown replaces the whole ordered list with one entry. Touching the
  description column's dropdown on that same template silently switches the
  language model off.

So this is not only a matter of adding fields. **An editor that silently
damages what it does not understand is the failure this codebase has spent the
whole of August chasing** — a step that could not run, reported as though it
had — and it is currently in the shipped GUI.

## Decisions taken

Settled in conversation on 2026-08-17.

- **The GUI covers the common cases and is safe on the rest.** Anything it
  cannot edit is carried through untouched and shown, never dropped.
- **The preview stays visible while editing.** It is the feedback loop that
  makes profile-building tractable, and it decides the layout.
- **Inline, single-open expansion per column.** Not a separate screen, not a
  side panel.
- **A text editor remains the escape hatch** for compose templates, presence
  triggers and disclosure. That is a deliberate boundary, not a gap to close
  later.

## The layout, and why

**A separate editor screen is rejected because it hides the preview.** This
screen shows live extracted rows; an operator learns whether a profile works by
watching them change. Editing in one place and seeing the effect in another
breaks the only feedback this task has.

**A side panel is rejected on measurement.** The window gives roughly 530px of
content width. Master-detail wants about double that before both halves stop
being cramped.

That leaves inline expansion, which works only if three things hold:

1. **The collapsed row carries the information.** `MWDL/description — Compose,
   then a model` says what the chain is without opening anything. Expansion is
   for *editing*, not for *seeing*. An accordion you must open to understand
   your own profile has failed.
2. **Single-open.** Opening one row closes the others. Several open at once
   makes the list unnavigable and shifts content under the cursor mid-click.
3. **The expansion is not a wall.** The source chain is primary. Transform and
   flag-if-empty are secondary and rare; the read-only settings sit below them.

## Staged, because stage 1 is worth shipping alone

### Stage 1 — stop the loss, and put the model in the dropdown — BUILT 2026-08-17

`setDefault` preserves every field of a `Column`. It copies the column whole
rather than listing what to keep, so a ninth field added to `Column` is
preserved on the day it is added.

`setSource` stops replacing the list. Until stage 2 the dropdown still shows
one source, so the rule is explicit: **choosing from the dropdown replaces
element 0 and leaves the rest of the chain alone**; choosing the blank entry
removes element 0 and leaves the rest. It is
`setFirstSource` in `core/extract/columns.ts`, beside `setSources` rather than
in the controller, because the rule is about editing a profile and not about a
screen.

A column whose chain is longer than one says so beside the dropdown.

**The wording changed while building it.** This section proposed *"and 1 more,
shown when this column is expanded"*, and stage 1 ships no expansion — a hint
pointing at a control that does not exist is the kind of claim this project
keeps having to retract. The row NAMES the later sources instead
(`restOfChain`): *"This sets the first source; then: A language model… The rest
is kept as it is — edit the profile file to change it."* Naming beats counting
anyway: the collapsed row is supposed to carry the information, and "1 more"
carries none of it. Stage 2 replaces the closing sentence when the expansion
exists.

`sourceOptions` gains **"A language model"**. This is the change that answers
the operator's actual complaint: turning the model on for a column currently
requires hand-editing JSON, and this removes that with no new UI at all.

It was deliberately left out when the language-model feature was built, on the
grounds that a profile declares the model rather than a dropdown offering it.
**That reasoning holds for shipping a template and does not hold for an
operator configuring their own collection**, which is what the request is.

The rule that governs *when* the model may write is untouched and stays
unconfigurable: empty cell or flagged cell, never a stated value.

### Stage 2 — the source chain

Each column expands to show its sources **in order**, with add, remove and
reorder. This is the one thing a single dropdown cannot express, and it is
where the tiered design lives.

The order is the meaning: first non-empty wins. The UI must show it as an
ordered list rather than a set, and should say what it means in one line
rather than assuming it is obvious.

### Stage 3 — the profile-wide section

A section below the column list, visually separate because it describes the
profile rather than a column:

- **`aiInstruction`** — the house style the model is asked for. Free text.
  Where a column asks for a model and no instruction exists, say so: the model
  will otherwise invent its own format, which is what the 3B run produced.

### Stage 4 — everything else, preserved and visible

Inside a column's expansion, the settings the GUI does not edit are shown
read-only with their values: compose templates, presence triggers, aliases,
`composeOnly`. Profile-wide, the same for `aiProvenance` and `checks`.

**Shown, not hidden.** An operator who cannot see that a column carries a
compose template cannot understand why their source chain does nothing. The
wording states that these were kept as they are and are edited in the file.

## What the GUI will not do

- **Edit compose templates.** `Died {death_date}; Born {birth_date}` with
  optional `[...]` groups is a small language; a form that expressed it would
  be harder to use than the string.
- **Edit presence triggers**, for the same reason — a trigger list plus its
  `then` text is a rule, not a setting.
- **Configure the eligibility rule.** Not a UI decision. See the
  language-model design.
- **Validate against a schema it does not have.** Column paths are already
  checked against the chosen collection's schema where one is chosen; that is
  unchanged.

## Error handling

The editor's job is to never produce a profile that will not load. Two rules:

- **An edit that would break an alias is refused at the moment it is made**,
  naming the compose template that depends on it — not at save, and not at
  load. `parseProfile` already rejects an unknown placeholder; the GUI must
  not be able to construct one.
- **A profile that arrives with settings the GUI cannot edit round-trips
  byte-identically** through open → edit an unrelated column → save. This is
  the property both current defects violate, and it is the one worth a test of
  its own.

## Testing

Everything under stage 1 is done and is marked; the rest waits on its stage.

- **Round-trip:** every shipped template, and a profile carrying every field
  the format allows, survives open → edit → save unchanged except for the edit.
  **Done** — `tests/extract/templates.test.ts` applies both editing operations
  to every column of every *shipped* template and compares the whole profile,
  so a template added later is covered on the day it is added. It passed the
  moment it was written, which proves nothing, so both defects were
  reintroduced and it was watched to fail on each.
- **The two defects, pinned:** setting a default preserves `as`,
  `flagIfEmpty`, `composeOnly`; choosing a source preserves the rest of the
  chain. **Done**, and asserted as whole-object comparisons rather than field
  by field — a list of fields to check is wrong again the day a field is added,
  which is the same mistake that caused the defect.
- **The dropdown offers the model**, and choosing it produces `{ ai: true }`
  in the right position. **Done.** The option's label must be
  `describeSource`'s: the screen marks the current option by comparing label
  strings, so a hand-written one renders a dropdown that never shows what a
  column is already set to.
- **Ordering is meaning:** reordering sources changes which one wins, asserted
  through the preview rather than through the profile object alone.
- **The read-only settings are rendered**, so a maintainer removing them from
  the markup fails a test rather than silently hiding an operator's compose
  template.
- Driven through `fakeDom` where the existing extract screen tests are, so the
  assertions are about what the screen does rather than what a string contains.
  **Note its limit, found doing this:** `fakeDom` hands out unparented stubs,
  so `closest('tr')` — how the screen recovers which column a control belongs
  to — has no answer and now returns null. A test driven this way can assert
  WHAT a control reported and never WHICH row reported it. Asserting the empty
  string that falls out would be asserting the fake.

## Rejected alternatives

**A full editor covering every field.** Compose templates and presence
triggers are the two that make it unattractive: expressing them in a form is
harder to use than the text, and the screen grows to accommodate the rarest
cases at the expense of the common ones.

**Fixing the data loss and adding nothing.** Closes a live defect and leaves
the operator's actual problem — hand-editing JSON to turn the model on —
exactly where it was.

**A JSON text box in the app.** Solves nothing: an operator who struggles with
JSON in Notepad struggles with it in a textarea, and it invites a broken
profile with no validation between typing and saving.

## Out of scope

- Creating a profile from nothing. The starter profile proposed from a folder
  scan already covers that, and the template chooser covers the rest.
- Editing the shipped templates in place. Save-as is the route; a shipped
  template is a tracked file and changing it is a code change.
- Any change to the eligibility rule, the verification layer, or the prompt.
