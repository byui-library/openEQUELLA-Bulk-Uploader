# Wiring in a language model — Design

**Date:** 2026-08-14
**Status:** Approved. Not yet planned or built.
**Occasion:** The operator un-deferred tier 4 and widened it: *"build the
functionality to wire in an llm via an api. It should allow for connecting to
any of the major ai LLMs including local models."*

Supersedes the tier 4 sketch in
[2026-08-06-description-extraction-design.md](2026-08-06-description-extraction-design.md),
which was written for descriptions alone and assumed a single hosted vendor.
Its open questions are answered below; its safety argument survives with one
deliberate amendment (see "The rule").

## What changed since it was deferred

Three things, all of which make this a different design from the one sketched
in August:

1. **Local models are in scope.** The earlier design assumed an institutional
   API key and recorded that a consumer subscription cannot be used. A local
   runtime needs neither, and removes the policy question entirely for any
   institution that cannot send material off-site.
2. **The operator chooses the fields**, rather than the tool deciding that only
   descriptions qualify.
3. **The tool is institution-agnostic now.** Anything it assumes about a schema
   or a document is an assumption at every adopting library, not just this one.
   That constraint shaped nearly every decision here.

## Decisions taken

Settled in conversation on 2026-08-14. Recorded so they are not reopened.

- **Fields are operator-specified**, but the first release ships enabled for
  the description only. Architecture general, rollout staged — see "What ships
  first".
- **One wire format: OpenAI-compatible.** Proven against two configurations, a
  local runtime and a hosted endpoint.
- **Sending document text to a hosted provider is cleared** at BYU-Idaho, or
  clearable quickly. It is not assumed to be cleared anywhere else.
- **The model may fill an empty cell or replace a flagged one. It may never
  replace a value the document stated.**
- **Cost is confirmed before a run and capped during it.** The local provider
  is exempt from both.
- **Disclosure in the item is configuration**, off unless a profile names a
  field.

## Architecture: one more source, and one provider

### The source

`Source` in `src/core/extract/types.ts` is an ordered union; a column names
several and the first non-empty wins. A language model becomes one more member:

```json
{
  "path": "MWDL/description",
  "sources": [
    { "section": "Abstract" },
    { "opening": true },
    { "ai": true }
  ]
}
```

Nothing about resolution changes. `_source` still records which member fired,
so a reviewer can sort a spreadsheet by it and read only the model's work.

**This is what makes "fields the operator specifies" configuration rather than
code.** Enabling a second field is adding `{ "ai": true }` to another column.
Nothing in the extractor learns what a description is, exactly as nothing in it
knows what an obituary is.

### The provider

One `OpenAiCompatibleProvider`, configured twice:

```text
baseUrl  http://localhost:11434/v1              Ollama
baseUrl  https://api.openai.com/v1              OpenAI
baseUrl  https://<resource>.openai.azure.com/…  Azure OpenAI
```

The chat-completions request and response shape is shared by Ollama, LM Studio,
llama.cpp, OpenAI, Azure OpenAI, Groq, Together and OpenRouter. **So "any of the
major LLMs" is largely a base URL, not new code.** What genuinely differs
between the two configurations — auth header, model naming, rate limiting,
failure shape — is enough to keep the interface honest without paying for a
second protocol.

Anthropic and Google use different formats and would each be a separate
adapter. Neither is in this release; the interface exists so adding one is not
a rewrite.

**Configuration lives per instance in the existing encrypted store**, entered
on Setup beside the credentials. `src/desktop/secrets.ts` already does exactly
this for the client secret and the password, including the refusal to write
when OS encryption is unavailable.

### Running with nothing configured

**With no endpoint configured the feature does not exist.** No prompt, no
error, no degraded mode, no mention on any screen. Tiers 1–3 run as they do
today.

This is not politeness. A library that never configures an endpoint never
sends anything anywhere, which is what lets the tool be adopted without a data
review — and the installer keeps its zero-prerequisite promise.

## The rule: when the model may write

For a column a profile has enabled, the model may:

| Existing value | May the model write? |
| --- | --- |
| empty | **yes** |
| flagged as uncertain — an opening paragraph, a capped section | **yes, replacing it** |
| stated by the document — a label, a table cell, a named section | **no, never** |

**"Flagged" is not a judgement call — it is already structural.** `resolve` in
`src/core/extract/rows.ts` returns:

```typescript
interface Resolved {
  value: string;
  note?: string;
}
```

A tier that is unsure sets `note` — *"taken from the start of the document,
which may not be a description -- please check"*. So the rule is exactly:

> the model may write when the resolved value is empty, **or** when its `note`
> is set.

No new confidence model, no per-source table to keep in step with the sources.
A tier that starts flagging itself becomes model-replaceable automatically,
which is the correct behaviour and requires no one to remember.

The August design said tier 4 runs "only when tiers 1–3 all came back empty",
on the argument that a model competing against a blank cell has no fact to
contradict. That argument is right and is kept for stated values.

**The amendment is deliberate.** The batch that prompted this work is scanned
obituaries, where the target description is a synthesis — *"Died 2024-01-06;
Born 1957-06-19; Attended Ricks College"* — and the August design itself notes
that "no section-finding produces that from a clipping". On those documents
tier 3 yields a flagged opening paragraph: worse than a blank, because "blanks
only" would let the junk block the model precisely where the model is most
useful.

The tiers already carry different confidence, and the tool already tells the
operator which values it is unsure about. Replacing a value the tool has
flagged is not overwriting a fact; it is replacing a guess with a better guess,
and saying so.

Every model-written cell is flagged in `_notes` and marked in `_source`,
whether it filled a blank or replaced a flag.

### Prose fields and fact fields are not the same risk

Built in now rather than retrofitted when the second field is enabled.

A description that reads oddly is a quality problem a cataloguer can fix. **A
fabricated death date is indistinguishable from a real one to everyone
downstream, permanently**, in a collection with no moderation queue. Fact
fields — dates, names, identifiers, anything from a controlled vocabulary —
stay flagged for review even when an operator enables them, and the flag says
which kind of field it was.

## Verification: what may be written into a cell

Added 2026-08-14, after the first run against a real model. **"The rule" above
governs which CELLS the model may write. This governs what may be written INTO
them, and the two are different guarantees** — the first protects values the
document stated, and says nothing at all about whether what arrives in an
eligible cell is true.

### What the run found

Ten scanned obituaries, `llama3.2:3b` served locally by Ollama. **2 of 10
generated descriptions asserted facts the source documents do not contain** — an
affiliated institution neither document mentions, and a full death date for a
document that states no date of any kind. (Ten outputs to read means an
evaluation profile asking for the model alone, as Task 13 of the plan prescribes.
On the shipped template the model fires on **1 of those 10 rows**, because
`compose` produced a value for the other nine — the eligibility rule working, not
the feature failing.)

The prompt already forbids exactly that (*"Use only what the document states. Do
not invent names, dates, places or events"*), and the profile instruction already
says to include the affiliation clause only where the document supports it.
Neither held, and **the prompt cannot be made the defence**: this design's whole
premise is "any of the major LLMs including local models", so the tool cannot
know how capable the model behind an endpoint is.

**The invention is not a misreading.** The document stating no date was processed
three times at temperature 0 and produced three different death dates. A
plausibly shaped value is being generated to fill a slot.

**Everything downstream behaved correctly, and that is what made the point.** The
cell was flagged, `_source` read `ai`, the note asked the operator to check.
**A flag is not a guard.** In a collection with no moderation workflow, a
fabricated date a reviewer skims past is permanent and indistinguishable from a
real one.

So: **the model proposes; the tool verifies.** `src/core/ai/verify.ts` reads the
generated value against the whole document — not the slice that was sent, or a
supported value would depend on the character budget — and returns the claims the
document does not support.

**Measured.** Built from invented fixtures only, then run against those ten real
documents it had never seen: **2 of 2 fabrications refused, 8 of 8 supported
descriptions kept, zero false rejections.** End to end, the refused row yields an
empty cell, no `ai` in `_source`, and a note naming each unsupported claim.

### What the hardening established — 2026-08-17

The design above is unchanged. What follows is what a review of the
implementation found, and it matters to the design because one finding was the
design's own founding failure surviving inside the layer built to stop it.

**A date with no year was never checked at all.** `He died on January 6.` over a
document stating no date was written into the catalogue. `FORMS` recognised a
date only where a four-digit year sat beside it, and "no form matched" was read
as "no claim was made" — so the layer's effectiveness turned on a model's
formatting habit rather than on anything the design asserts. **The rule is now
that a month name, or a day-and-month pair, is a claim whether or not a year
sits beside it.** `Jan. 6`, `the 6th of January`, `1/6`, `in January`,
`2024-01-06T00:00:00Z`, `in January of 2024` and `6.1.2024` are all claims.

**Precision ranking was replaced by a `Reading`** — a date decomposed into the
parts the text actually stated — under one rule, `entails`: every part the claim
states must be stated, and equal, in the document's. A part the claim omits is
not checked, so `2024` is supported by `2024-01-06`; the reverse is not, which
is fabricated precision refused at a finer grain than the design anticipated.
`new Date` is gone from the path, month names resolve through a stem table, and
every reading is calendar-validated.

**Twelve classes of false rejection were fixed**, which is the cost side of the
design's "a false rejection is expensive" and turned out to be mostly format
provincialism: `.`-separated dates, two-digit years, thousands separators,
spelled numbers above ninety-nine, ordinal words, `a dozen`, `three and a half`.
The old ninety-nine ceiling came from obituary prose — a domain judgement inside
a module whose premise is that it knows nothing about any collection.

**And the assertion check could be silently disabled by a blank string.** One
empty entry in a profile's trigger list makes `includes('')` true of every
document, so the check reports success without having run — the failure this
project has now shipped twice elsewhere, sitting inside the module that exists
to prevent it. The filter is load-bearing and is pinned by mutation.

### It reads English dates only, and says so

`MONTH_NAMES` is English. A document writing `Falleció el 6 de enero de 2024`
states a day, and this layer sees only the year in it, so a **correct**
day-precision description of that document is refused and discarded.

Refusing stays: the fabrication this layer was built for came from a genuinely
dateless document, and a check that gave up quietly on text it could not read
would be the shape this codebase has shipped before. **What the design now
requires is the wording.** *"The document states no such date"* is a claim about
the document, and this layer is entitled only to a claim about itself: no date
**it can read** supports the value. Every refusal reason is written to that
standard, and the limitation is documented for operators rather than left to be
discovered. Adding a language means adding its month names to `MONTH_NAMES` and
its numeral words to `SMALL`.

### Three decisions, taken by the operator

**1. Reject the whole value, never repair it.** The tool does not edit generated
prose. Stripping the offending clause leaves a half-removed sentence that reads
as complete while meaning something different — a worse outcome than no
description, because nothing about it looks wrong. A refusal leaves the cell
exactly as it was found, which for an eligible cell is empty or holding the
flagged guess it would have replaced.

**2. Checkable claims only — dates, numbers, and assertions the profile already
has a check for.** Paraphrase is legitimate description, and a check that read
prose for support would have rejected the eight good ones. **A false rejection is
expensive**: it discards a good description and teaches the operator to distrust
the check. The claim kinds are the ones that can be compared against the
document's own text without judging language. Proper nouns are deliberately not
checked — OCR damage in a scan makes a real name look unsupported, and the batch
this feature exists for is scanned pages.

**3. Always on, with no setting.** This project has twice shipped a check that
reported success without running — `MWDL/identifier` against a column the
extractor never produced, and `MWDL/title` at any institution but this one. Both
reported "no duplicates" by never having looked. A switch is how that happens a
third time.

### What it deliberately does not know

**Nothing about any collection.** Not what an obituary is, not what a death date
is, not that any institution exists. Every rule derives from the profile's own
configuration — a `presence` source declares its trigger list, which is an
operator saying "this collection cares whether the document evidences this" — and
from the document's own text. A profile declaring no `presence` source gets no
assertion check and **nothing is substituted**. A list of colleges would be the
institution-specific assumption an entire release was spent removing.

### What verification does not buy

**It catches a claim the document does not support. That is all it catches.** It
cannot tell whether a supported date is attached to the right person: a model can
state something false using only tokens the document contains, and nothing here
reads the sentence around a date to see what it says about it. An empty result
means every checkable claim is supported, **not** that the value is true.

Every model-written cell therefore stays flagged, exactly as before. Verification
raises the floor; it does not replace the review.

## What gets sent

**Whole document if it fits the model's context. Beyond that, the opening plus
any named sections the extractor already found.**

The cap is not a constant. A local 7B and a hosted frontier model differ by
more than an order of magnitude, and a rule that fits one fails the other.

**The cap is entered with the endpoint, as a character budget.** Not derived
from a model-name lookup table: such a table is wrong the week a vendor ships a
new model, and this tool sits untouched for months at a time. A number the
operator sets beside the model name cannot rot, and the field says what it is
for — the most text to send from one document, and that a smaller model needs a
smaller number.

Characters rather than tokens, because the operator can count characters and
the tool already measures documents that way. It is an approximation and is
described as one; the ceiling that matters for cost is the document count, not
this.

Both halves are type-agnostic. "Whole document if short" serves an obituary, a
syllabus, a finding aid, a policy memo. "Opening plus named sections" is a
property of prose generally — a thesis, a report, a grant application all state
what they are near the front or under a heading — and the extractor already
finds those headings without knowing what any of them mean.

A profile may name which sections to prefer, alongside the section list it
already carries. **The slicing strategy itself is not pluggable**: that is a
knob nobody can set correctly without reading the source.

The row records which shape was sent, so a surprising output can be explained.

## Cost, confirmation, failure

### Before the run

```text
About to send 412 documents to
  OpenAI (gpt-4o-mini)
  roughly 1.2M characters

Stop after 500 documents.

[ Cancel ]  [ Send 412 documents ]
```

Count, provider, model, rough volume, one confirmation. The same shape as the
existing publish confirmation, which already makes an operator type an item
count before anything goes live.

### During the run

A configurable ceiling. Reaching it leaves the remaining rows blank and
flagged — **not silently charged, and not silently skipped**.

### The local provider is exempt from both

Nothing leaves the machine and nothing is billed, so a confirmation dialog
would be friction teaching the operator to click past dialogs. That habit is
what makes the hosted confirmation worthless.

### Failure

A call that fails, times out, or returns something unparseable leaves the cell
**blank with a note saying what happened**. Never a partial value. Never a
silent retry loop.

This follows the rule the rest of the tool now obeys without exception: a check
that could not run says so, and is never dressed as a pass. That rule exists
here because it was broken here — `oeq-upload check` once reported *"Identity
ok — logged in as guest"*.

## Disclosure in the item

A profile may name a field to receive a provenance note:

```json
"aiProvenance": {
  "path": "MWDL/conversionSpecifications",
  "append": "Description generated by {model}"
}
```

For BYU-Idaho that field already carries "Scanned to PDF" — a processing-
provenance note for a different transformation, which is exactly the job.

**Where no field is named, nothing is written to the item.** The tool never
picks the field and never invents one. Choosing a path on an institution's
behalf is the assumption an entire release was spent removing, and writing to
an undeclared node would repeat it on every item.

The path is validated against the collection's schema like any other, and
reports "not declared" rather than writing outside it.

## What ships first

The whole mechanism, enabled for the description column only.

Staged for three reasons:

1. **Quality can only be judged one field at a time.** Reviewing model-written
   descriptions across a real batch is tractable; reviewing eight generated
   fields at once is not, and the operator would end up trusting them by
   default.
2. **A mistake in a description is the cheapest mistake available.**
3. **The prompt is the actual work.** Producing the house style reliably is
   what teaches us what the second field will need.

Widening is editing a profile. If it requires code, the architecture is wrong.

## Testing, and what cannot be tested

- **Unit, against a stubbed provider:** the rule table above, in full — empty
  filled, flagged replaced, stated untouched; the cap reached mid-run; a failed
  call leaving a blank and a note; an unparseable response treated as a
  failure rather than as content.
- **The input strategy:** a document under the cap sent whole; one over it sent
  as opening plus sections; the recorded shape matching what was sent.
- **No endpoint configured:** the feature is absent from every screen, and the
  extractor behaves exactly as it does today. This is the test that protects
  the zero-prerequisite promise.
- **Against a real local model:** the one end-to-end path that costs nothing to
  run repeatedly, and the only way to see what the prompt actually produces.
  **Done twice, with different models, and the difference between them is
  itself the finding** — see below. The first run found the fabrication the
  verification section above records; it is the only thing that could have.
- **Groundedness, which CAN be tested and now is.** `tests/ai/verify.test.ts`
  asserts, against invented fixtures, that a date the document does not state is
  refused, that a claim finer than anything the document states is refused as
  not that precise, and that supported dates, numbers and assertions are kept —
  along with free prose, which is not treated as a claim at all. It is a
  property of one value against one document, so it needs no model to run and no
  opinion about what a good description is. Distinct from quality below: a
  grounded description can still be a poor one.
- **What cannot be tested:** output quality, at all. No assertion can say a
  description is good. That judgement is the operator's, on a real batch, and
  the plan must say so rather than implying coverage it does not have.
  **Narrowed, not removed, by the second run**: the 8B model's output follows
  the house style, which is evidence and not proof. Verification answers "does
  the document support this?" and house style answers "is it shaped right?";
  neither answers "is this worth cataloguing?", and answering either must not be
  read as having answered that.

### Two runs, two models — and why the difference is recorded

**Whoever enables a model on a second field should read this before choosing
one.** The same ten documents, the same prompt, the same profile instruction:

| | `llama3.2:3b`, CPU, 2026-08-14 | `llama3.1:8b`, GPU, 2026-08-16 |
| --- | --- | --- |
| written outputs in house style | about 3 of 8 | **8 of 8** |
| fabrications, refused | 2 of 2 | 2 of 2 |
| false rejections | 0 | 0 |
| wall clock, ten documents | — | 140 seconds |

**The house-style failures were model capability, not prompt wording.** The 3B
model prepended names, gave an age where a death date belongs, and wrote prose
sentences naming a hospital; the instruction that produced those is the same one
that produced eight correct lines from the 8B model. So the design's refusal to
make the prompt the defence extends to quality: **elaborating the instruction
against a weak model is work aimed at a problem the wording does not have.**

**Capability is not the guard, though.** The same two documents defeated both
models — one states no date of any kind, the other never mentions the
institution it claimed — and both were refused both times. That is the argument
for verification rather than for better prompting, made by a model good enough
that "get a better model" was the obvious alternative. An independent audit
against the sources confirmed nothing ungrounded reached the spreadsheet, and
the hardened verifier re-checked against both models' stored output still caught
2 of 2 and kept 8 of 8.

**One caveat travels with the result wherever it is quoted:** the 8B run passed
the date checks partly because that model answers in ISO format. That is exactly
the habit the hardening removed the layer's dependence on, and it is why the
gap was found by reading `FORMS` rather than by the run passing. Ten documents,
one collection, one language is evidence within a sample — not coverage.

## Rejected alternatives

**Letting the model fill any empty field, including dates and names.** The tool
writes to a permanent catalogue with no moderation queue. A fabricated date
looks exactly like a real one. Prose and facts are separated deliberately.

**Always generating enabled fields, ignoring what extraction found.** Gives the
most consistent house style and removes the guard that makes everything else
safe. A stated value is evidence from the document; a model output is not.

**A general "point the LLM at anything" tool.** A different product from a bulk
uploader, needing its own screens and its own review step.

**Implementing several vendors at once.** Effort per vendor in auth, error
shapes and rate limits, none of it testable against anything but the key
actually held. One wire format covers most of the market.

**A consumer subscription instead of an API key.** Recorded in the August
design and unchanged: Claude Pro, ChatGPT Plus, Gemini Advanced and Copilot
licence the chat interface, none issues an API key, and driving one from a
script breaches its terms.

**Making the slicing strategy pluggable.** Configuration nobody can set
correctly without reading the source.

## Out of scope

- **Anthropic and Google adapters.** The interface admits them; this release
  does not build them.
- **Streaming responses.** A batch tool has no one watching a token stream.
- **Fine-tuning, embeddings, retrieval.** None serves the job of describing a
  document that yielded nothing.
- **Using a model for OCR.** OCR stays outside this tool, decided 2026-08-07
  and unchanged.
- **Subjects and keywords.** Deferred by the operator and still deferred.
