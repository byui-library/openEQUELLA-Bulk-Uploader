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
- **What cannot be tested:** output quality, at all. No assertion can say a
  description is good. That judgement is the operator's, on a real batch, and
  the plan must say so rather than implying coverage it does not have.

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
