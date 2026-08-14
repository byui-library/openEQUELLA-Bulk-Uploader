# Language Model Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a language model write a value into a column where the extractor found nothing, or found something it had already flagged as a guess — using any OpenAI-compatible endpoint, local or hosted.

**Architecture:** Extraction stays synchronous, pure and offline exactly as it is. A **second, asynchronous pass** runs after it, sees the finished rows, and fills only the cells the rule permits. The profile declares intent with an `{ ai: true }` source; the pass acts on it.

**Tech Stack:** TypeScript on Node 22, `moduleResolution: nodenext` (relative imports need `.js`), vitest, Electron with a sandboxed renderer.

**Spec:** [../specs/2026-08-14-llm-provider-design.md](../specs/2026-08-14-llm-provider-design.md)

---

## Before you start

Read `CLAUDE.md` first — Conventions and Process were written from this project's own failures, and three of them bear directly on this work:

- **Mutation testing has a CRLF trap here.** A `sed`/`perl` pattern containing `\n` silently matches nothing, the suite comes back green, and you conclude a test is load-bearing when it is not. **Use the Edit tool.** This has caught four people, including the author of this plan.
- **`noUnusedLocals` is NOT enabled.** The typecheck will not find a dead import.
- **Nothing under `src/desktop/ui/` may import `node:*` or `electron`.** It fails silently by blanking the window.

**Branch:** `feature/llm-provider`, already created, with the spec committed. Do not work on `main`.

### Two things the spec did not anticipate

Both were found by reading the code while writing this plan. They change the shape, not the intent.

**1. `resolve()` is synchronous and pure.** The spec frames the model as "one more source in the union", which is right for *configuration* and wrong for *execution*: `resolve` returns a value with no I/O, and making it async would ripple through `buildRow`, `extract.ts` and `extractHandlers.ts`, dragging network concerns into the offline extractor the project deliberately keeps offline.

So `{ ai: true }` is a **marker**. `resolve` returns empty for it; a separate async pass reads the finished rows and fills what it may. This is better than the spec's framing for three reasons beyond avoiding the ripple: the rule ("empty, or flagged") is evaluated on the *completed* row, which is the only place that information exists; the confirmation dialog needs a *count* of qualifying rows, which is only knowable after tiers 1–3 have run; and `src/core/extract/` keeps its "never touches the network" property, which Task 9 of the institution-agnostic plan went to some trouble to preserve.

**2. `ExtractedRow.notes` is a flat `string[]`.** So a finished row cannot answer "was the description flagged?" — the per-column note that `resolve` produced has been flattened away. The rule depends on that answer, so Task 1 preserves it. This is a prerequisite, not an optional tidy-up.

---

## File structure

**Create:**

| File | Responsibility |
| --- | --- |
| `src/core/ai/provider.ts` | `OpenAiCompatibleProvider`. One HTTP call, injectable `fetch`. Knows nothing about documents |
| `src/core/ai/eligible.ts` | Pure. Given a row and a profile, which cells may the model write? |
| `src/core/ai/slice.ts` | Pure. How much of a document to send |
| `src/core/ai/prompt.ts` | Pure. Builds the request text; parses the reply |
| `src/core/ai/fill.ts` | The async pass. Ties the four together and applies results to rows |
| `tests/ai/*.test.ts` | One per module |

**Modify:**

| File | Change |
| --- | --- |
| `src/core/extract/types.ts` | `Source` gains `{ ai: true }`; `ExtractedRow` gains per-column notes |
| `src/core/extract/rows.ts` | `resolve` returns empty for `ai`; `buildRow` records per-column notes |
| `src/core/extract/profile.ts` | zod: accept `ai`, and the profile-level `aiProvenance` |
| `src/desktop/secrets.ts` | Store endpoint, model, key, character budget, run cap |
| `src/desktop/ui/screens/setup.ts` | Enter them |
| `src/desktop/ui/screens/extractColumns.ts` | The confirmation before a run |
| `src/cli/extract.ts` | `--ai` flag and the same confirmation |

---

## Task 1: A finished row remembers which cells were flagged

**This is a prerequisite for the rule.** Without it the model cannot tell a stated value from a guess.

**Files:**
- Modify: `src/core/extract/types.ts`, `src/core/extract/rows.ts`
- Test: `tests/extract/rows.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/extract/rows.test.ts
describe('a finished row remembers which cells were only a guess', () => {
  /**
   * `notes` is a flat list, so a finished row could not say WHICH column was
   * uncertain -- and "may the model replace this?" is exactly that question.
   * The information already existed inside buildRow and was being thrown away.
   */
  it('records the note against the column it belongs to', () => {
    const profile = {
      version: 1 as const,
      columns: [
        { path: 'MWDL/title', sources: [{ filenameStem: true }] },
        { path: 'MWDL/description', sources: [{ opening: true }] },
      ],
    };
    const row = buildRow(profile, 'a.pdf', {
      text: 'A sentence long enough to be taken as an opening paragraph by the reader, with plenty of lowercase words in it.',
      hasTextLayer: true,
      properties: {},
      tables: [],
    });
    expect(row.flagged['MWDL/description']).toMatch(/start of the document/);
    expect(row.flagged['MWDL/title']).toBeUndefined();
  });

  it('leaves flagged empty when every value was stated', () => {
    const profile = {
      version: 1 as const,
      columns: [{ path: 'MWDL/title', sources: [{ filenameStem: true }] }],
    };
    const row = buildRow(profile, 'a.pdf', { text: '', hasTextLayer: true, properties: {}, tables: [] });
    expect(row.flagged).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/extract/rows.test.ts`
Expected: FAIL — `row.flagged` is undefined.

- [ ] **Step 3: Implement**

In `src/core/extract/types.ts`, add to `ExtractedRow`:

```typescript
  /**
   * Column path -> the note explaining why that cell is only a guess.
   *
   * `notes` above is a flat list for the operator to read. This is the same
   * information keyed so code can ask about ONE column, which is what the
   * model-fill rule needs: it may replace a guess and must never replace a
   * value the document stated. Only flagged columns appear.
   */
  flagged: Record<string, string>;
```

In `src/core/extract/rows.ts#buildRow`, wherever a `Resolved` with a `note` is
folded into `notes`, also record it: `flagged[column.path] = resolved.note`.
Initialise `const flagged: Record<string, string> = {};` beside the existing
accumulators and return it. **Do not change what goes into `notes`** — the
operator-facing list stays exactly as it is.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. Every existing row test still green — this only adds a field.

- [ ] **Step 5: Commit**

```bash
git add src/core/extract/types.ts src/core/extract/rows.ts tests/extract/rows.test.ts
git commit -m "feat(extract): keep the per-column note a finished row was throwing away"
```

---

## Task 2: The rule — which cells may the model write

**Files:**
- Create: `src/core/ai/eligible.ts`, `tests/ai/eligible.test.ts`

This is the safety property of the whole feature. Read the spec's "The rule"
section before writing.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/ai/eligible.test.ts
import { describe, it, expect } from 'vitest';
import { eligibleColumns } from '../../src/core/ai/eligible.js';
import type { ExtractedRow } from '../../src/core/extract/types.js';

const profile = {
  version: 1 as const,
  columns: [
    { path: 'MWDL/description', sources: [{ opening: true }, { ai: true }] },
    { path: 'MWDL/title', sources: [{ filenameStem: true }] },
  ],
};

const row = (over: Partial<ExtractedRow> = {}): ExtractedRow => ({
  cells: { 'MWDL/description': '', 'MWDL/title': 'A Title' },
  sources: {},
  notes: [],
  flagged: {},
  ...over,
});

describe('eligibleColumns', () => {
  it('offers an empty cell in a column that asked for a model', () => {
    expect(eligibleColumns(profile, row())).toEqual(['MWDL/description']);
  });

  /** The amendment to the August design: a guess may be replaced. */
  it('offers a cell the extractor already flagged as a guess', () => {
    const r = row({
      cells: { 'MWDL/description': 'Possibly a description', 'MWDL/title': 'A Title' },
      flagged: { 'MWDL/description': 'taken from the start of the document' },
    });
    expect(eligibleColumns(profile, r)).toEqual(['MWDL/description']);
  });

  /** The safety property. A stated value is evidence; a model output is not. */
  it('never offers a value the document stated', () => {
    const r = row({ cells: { 'MWDL/description': 'A real abstract', 'MWDL/title': 'A Title' } });
    expect(eligibleColumns(profile, r)).toEqual([]);
  });

  it('never offers a column that did not ask for a model', () => {
    const r = row({ cells: { 'MWDL/description': 'x', 'MWDL/title': '' } });
    expect(eligibleColumns(profile, r)).toEqual([]);
  });

  it('treats whitespace as empty', () => {
    const r = row({ cells: { 'MWDL/description': '   ', 'MWDL/title': 'A Title' } });
    expect(eligibleColumns(profile, r)).toEqual(['MWDL/description']);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Cannot resolve `eligible.js`.

- [ ] **Step 3: Implement**

```typescript
// src/core/ai/eligible.ts
import type { ExtractedRow, Profile } from '../extract/types.js';

/**
 * The columns a model may write in this row.
 *
 * THE SAFETY PROPERTY OF THE FEATURE. A column qualifies when its profile
 * asked for a model AND the cell is either empty or was flagged as a guess.
 *
 * A STATED VALUE IS NEVER REPLACED. It is evidence the document supplied; a
 * model output is not, and this tool writes to a permanent catalogue with no
 * moderation queue.
 *
 * "Flagged" is not judged here -- `buildRow` already recorded which cells its
 * tiers were unsure about. So a tier that starts flagging itself becomes
 * model-replaceable with nobody having to remember, and this function cannot
 * drift out of step with the sources.
 */
export function eligibleColumns(profile: Profile, row: ExtractedRow): string[] {
  return profile.columns
    .filter((column) => column.sources.some((s) => 'ai' in s))
    .filter((column) => {
      const value = (row.cells[column.path] ?? '').trim();
      return value === '' || row.flagged[column.path] !== undefined;
    })
    .map((column) => column.path);
}
```

- [ ] **Step 4: Run.** Expected: PASS, 5 tests.

- [ ] **Step 5: Mutation test — mandatory**

Use the **Edit tool**, never a shell substitution (see "Before you start").

1. Drop the `flagged` half of the condition → "offers a cell the extractor already flagged" must go red.
2. Drop the empty check, keeping only `flagged` → "offers an empty cell" must go red.
3. Make it return every column that asked for a model → "never offers a value the document stated" must go red. **This is the important one.**

Confirm the file actually changed before believing any result.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(ai): the rule -- empty or flagged, never a stated value"
```

---

## Task 3: The `ai` marker source

**Files:**
- Modify: `src/core/extract/types.ts`, `src/core/extract/rows.ts`, `src/core/extract/profile.ts`
- Test: `tests/extract/profile.test.ts`, `tests/extract/rows.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// append to tests/extract/profile.test.ts
it('accepts a column that asks for a model', () => {
  expect(() =>
    parseProfile({
      version: 1,
      columns: [{ path: 'MWDL/description', sources: [{ opening: true }, { ai: true }] }],
    }),
  ).not.toThrow();
});
```

```typescript
// append to tests/extract/rows.test.ts
/**
 * `{ ai: true }` declares intent; it does not fetch. resolve() is synchronous
 * and `src/core/extract/` never touches the network -- the property that lets
 * an operator build a spreadsheet without signing in to anything. The async
 * pass in core/ai/fill.ts acts on the marker afterwards.
 */
it('resolves an ai source to nothing, leaving the cell for the later pass', () => {
  const profile = {
    version: 1 as const,
    columns: [{ path: 'MWDL/description', sources: [{ ai: true }] }],
  };
  const row = buildRow(profile, 'a.pdf', { text: 'Some text.', hasTextLayer: true, properties: {}, tables: [] });
  expect(row.cells['MWDL/description']).toBe('');
  expect(row.sources['MWDL/description']).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify both fail.**

- [ ] **Step 3: Implement**

In `src/core/extract/types.ts`, add to the `Source` union:

```typescript
  /**
   * Ask a language model, in the async pass that runs after extraction.
   *
   * A MARKER, NOT A FETCH. `resolve` returns empty for it -- extraction is
   * synchronous, pure and offline, and stays that way. `core/ai/fill.ts` reads
   * the finished rows and fills only what `eligibleColumns` permits. Placed
   * last in a source list by convention; the rule does not depend on position.
   */
  | { ai: true }
```

In `src/core/extract/rows.ts#resolve`, before the final fallthrough:

```typescript
  if ('ai' in source) return { value: '' };
```

In `src/core/extract/profile.ts`, add `z.object({ ai: z.literal(true) })` to the
source union.

- [ ] **Step 4: Run `npm test` and `npm run typecheck`.** Both clean.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(extract): an ai source that declares intent without fetching"
```

---

## Task 4: How much of a document to send

**Files:**
- Create: `src/core/ai/slice.ts`, `tests/ai/slice.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/ai/slice.test.ts
import { describe, it, expect } from 'vitest';
import { sliceForModel } from '../../src/core/ai/slice.js';

describe('sliceForModel', () => {
  it('sends a short document whole', () => {
    const result = sliceForModel('A short obituary.', { budget: 1000, sections: [] });
    expect(result.text).toBe('A short obituary.');
    expect(result.shape).toBe('whole');
  });

  /** The death date can be in the last line. Truncation would lose it. */
  it('keeps the end of a document that fits', () => {
    const text = 'x'.repeat(500) + ' He died on 6 January 2019.';
    expect(sliceForModel(text, { budget: 1000, sections: [] }).text).toContain('6 January 2019');
  });

  it('falls back to the opening plus named sections when it does not fit', () => {
    const text = 'Opening words. ' + 'x'.repeat(5000) + '\nAbstract\nThe abstract body.\n' + 'y'.repeat(5000);
    const result = sliceForModel(text, { budget: 200, sections: ['Abstract'] });
    expect(result.shape).toBe('opening+sections');
    expect(result.text).toContain('Opening words');
    expect(result.text).toContain('The abstract body');
    expect(result.text.length).toBeLessThanOrEqual(200);
  });

  it('never exceeds the budget', () => {
    const result = sliceForModel('z'.repeat(10_000), { budget: 300, sections: [] });
    expect(result.text.length).toBeLessThanOrEqual(300);
  });

  it('reports an empty document rather than pretending it sent something', () => {
    expect(sliceForModel('', { budget: 100, sections: [] })).toEqual({ text: '', shape: 'empty' });
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```typescript
// src/core/ai/slice.ts
import { readSection } from '../extract/sections.js';
import { readOpening } from '../extract/opening.js';

export type SliceShape = 'whole' | 'opening+sections' | 'empty';

export interface Slice {
  text: string;
  /** Recorded on the row, so a surprising output can be explained. */
  shape: SliceShape;
}

export interface SliceOptions {
  /** Characters. See the spec: a budget the operator sets, not a model lookup. */
  budget: number;
  /** Section headings to prefer when the whole document will not fit. */
  sections: string[];
}

/**
 * How much of a document to send.
 *
 * WHOLE IF IT FITS, because a one-page obituary states its death date wherever
 * the sentence happens to fall, and leading-N-characters would throw the end
 * away. Beyond the budget, the opening plus any named sections: a property of
 * prose generally -- a thesis, a report, a grant application all say what they
 * are near the front or under a heading -- not of any one document type.
 */
export function sliceForModel(text: string, options: SliceOptions): Slice {
  const trimmed = text.trim();
  if (trimmed === '') return { text: '', shape: 'empty' };
  if (trimmed.length <= options.budget) return { text: trimmed, shape: 'whole' };

  const parts = [readOpening(trimmed)];
  for (const heading of options.sections) {
    const { text: body } = readSection(trimmed, heading);
    if (body.trim() !== '') parts.push(`${heading}\n${body}`);
  }
  return {
    text: parts.join('\n\n').slice(0, options.budget),
    shape: 'opening+sections',
  };
}
```

- [ ] **Step 4: Run.** Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): send a document whole when it fits, its opening and sections when it does not"
```

---

## Task 5: The provider

**Files:**
- Create: `src/core/ai/provider.ts`, `tests/ai/provider.test.ts`

Read `src/core/passwordAuth.ts` first — it is the model for an injectable
`fetch`, for never letting a secret reach an error, and for the redaction
helper you must reuse.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/ai/provider.test.ts
import { describe, it, expect, vi } from 'vitest';
import { OpenAiCompatibleProvider } from '../../src/core/ai/provider.js';

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe('OpenAiCompatibleProvider', () => {
  it('posts to the chat-completions path under the configured base url', async () => {
    const seen: string[] = [];
    const impl = vi.fn(async (input: string | URL) => {
      seen.push(String(input));
      return reply('A description.');
    }) as unknown as typeof fetch;
    const p = new OpenAiCompatibleProvider({ baseUrl: 'http://localhost:11434/v1', model: 'llama3' }, impl);
    await p.complete('prompt');
    expect(seen[0]).toBe('http://localhost:11434/v1/chat/completions');
  });

  /** A prefixed host is real: openEQUELLA is commonly deployed under one, and
   *  so are self-hosted model gateways. */
  it('keeps a path prefix on the base url', async () => {
    const seen: string[] = [];
    const impl = vi.fn(async (input: string | URL) => {
      seen.push(String(input));
      return reply('x');
    }) as unknown as typeof fetch;
    await new OpenAiCompatibleProvider({ baseUrl: 'https://host/gateway/v1', model: 'm' }, impl).complete('p');
    expect(seen[0]).toBe('https://host/gateway/v1/chat/completions');
  });

  it('sends no Authorization header when there is no key -- the local case', async () => {
    let headers: Record<string, string> = {};
    const impl = vi.fn(async (_i: string | URL, init?: RequestInit) => {
      headers = Object.fromEntries(new Headers(init?.headers).entries());
      return reply('x');
    }) as unknown as typeof fetch;
    await new OpenAiCompatibleProvider({ baseUrl: 'http://localhost:11434/v1', model: 'm' }, impl).complete('p');
    expect(headers['authorization']).toBeUndefined();
  });

  it('sends a bearer token when there is a key', async () => {
    let headers: Record<string, string> = {};
    const impl = vi.fn(async (_i: string | URL, init?: RequestInit) => {
      headers = Object.fromEntries(new Headers(init?.headers).entries());
      return reply('x');
    }) as unknown as typeof fetch;
    await new OpenAiCompatibleProvider(
      { baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'sk-secret' },
      impl,
    ).complete('p');
    expect(headers['authorization']).toBe('Bearer sk-secret');
  });

  it('returns the message content', async () => {
    const impl = vi.fn(async () => reply('  A description.  ')) as unknown as typeof fetch;
    const p = new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, impl);
    await expect(p.complete('p')).resolves.toBe('A description.');
  });

  /** Every failure is the same to the caller: no value, and a reason to show. */
  it('reports a non-2xx as a failure rather than as content', async () => {
    const impl = vi.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const p = new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, impl);
    await expect(p.complete('p')).rejects.toThrow(/429/);
  });

  it('reports an unparseable body as a failure rather than as content', async () => {
    const impl = vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    await expect(
      new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, impl).complete('p'),
    ).rejects.toThrow();
  });

  it('reports a 200 with no choices as a failure rather than as an empty description', async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as unknown as typeof fetch;
    await expect(
      new OpenAiCompatibleProvider({ baseUrl: 'http://x/v1', model: 'm' }, impl).complete('p'),
    ).rejects.toThrow();
  });

  it('never lets the key reach an error message', async () => {
    const impl = vi.fn(async () => new Response('failed for key sk-secret', { status: 500 })) as unknown as typeof fetch;
    const p = new OpenAiCompatibleProvider(
      { baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'sk-secret' },
      impl,
    );
    const error = await p.complete('p').catch((e: unknown) => e);
    expect(JSON.stringify(error)).not.toContain('sk-secret');
    expect((error as Error).message).not.toContain('sk-secret');
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```typescript
// src/core/ai/provider.ts
import { instanceEndpoint } from '../instanceUrl.js';
import { redactSecret } from '../redact.js';

export interface ProviderConfig {
  /** Base URL up to and including /v1. Ollama, LM Studio, OpenAI, Azure. */
  baseUrl: string;
  model: string;
  /** Absent for a local runtime, which needs no key. */
  apiKey?: string;
}

/**
 * One HTTP call to an OpenAI-compatible chat-completions endpoint.
 *
 * ONE WIRE FORMAT, MANY PROVIDERS. Ollama, LM Studio, llama.cpp, OpenAI, Azure
 * OpenAI, Groq, Together and OpenRouter all speak this shape, so "any of the
 * major LLMs" is a base URL rather than new code. Anthropic and Google do not
 * and would each be a separate class behind the same method.
 *
 * KNOWS NOTHING ABOUT DOCUMENTS. It takes a prompt and returns text. What to
 * send and what the answer means belong to prompt.ts and fill.ts.
 *
 * EVERY FAILURE THROWS, including a 200 whose body carries no content. A
 * caller that cannot tell "the model said nothing" from "the call failed"
 * would write an empty description and call it success -- the exact shape of
 * failure this codebase has been bitten by repeatedly.
 */
export class OpenAiCompatibleProvider {
  constructor(
    private readonly config: ProviderConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(prompt: string): Promise<string> {
    const url = instanceEndpoint(this.config.baseUrl, '/chat/completions');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) headers['authorization'] = `Bearer ${this.config.apiKey}`;

    let res: Response;
    let body: string;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      body = await res.text();
    } catch {
      throw new Error(`Could not reach ${url.origin}${url.pathname}. Check the address and that the model is running.`);
    }

    if (!res.ok) throw new Error(this.redact(`The model returned ${res.status}. ${body.slice(0, 200)}`));

    let parsed: { choices?: { message?: { content?: unknown } }[] };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      throw new Error('The model returned something that was not JSON.');
    }
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('The model returned no text.');
    }
    return content.trim();
  }

  private redact(text: string): string {
    return this.config.apiKey ? redactSecret(text, this.config.apiKey) : text;
  }
}
```

- [ ] **Step 4: Run.** Expected: PASS, 9 tests.

- [ ] **Step 5: Mutation test — Edit tool only**

1. Accept a non-2xx as content → the 429 test must go red.
2. Return `''` for a 200 with no choices instead of throwing → its test must go red.
3. Drop the redaction → the key test must go red.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(ai): one OpenAI-compatible provider, local or hosted"
```

---

## Task 6: The prompt

**Files:**
- Create: `src/core/ai/prompt.ts`, `tests/ai/prompt.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/ai/prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildPrompt, cleanReply } from '../../src/core/ai/prompt.js';

describe('buildPrompt', () => {
  it('names the field being written and includes the document', () => {
    const p = buildPrompt({ field: 'a description', document: 'The document text.', instruction: null });
    expect(p).toContain('a description');
    expect(p).toContain('The document text.');
  });

  /** A model that invents a date is the failure this whole design guards
   *  against. The instruction has to say so, not imply it. */
  it('tells the model not to invent facts', () => {
    expect(buildPrompt({ field: 'a description', document: 'x', instruction: null })).toMatch(/not.*invent|only.*document/i);
  });

  it('carries a profile instruction when one is given', () => {
    const p = buildPrompt({ field: 'a description', document: 'x', instruction: 'Use the form: Died {date}; Born {date}' });
    expect(p).toContain('Died {date}; Born {date}');
  });
});

describe('cleanReply', () => {
  it('strips a preamble a chat model adds', () => {
    expect(cleanReply('Here is a description:\n\nA study of birds.')).toBe('A study of birds.');
  });

  it('strips surrounding quotes', () => {
    expect(cleanReply('"A study of birds."')).toBe('A study of birds.');
  });

  it('leaves a clean reply alone', () => {
    expect(cleanReply('A study of birds.')).toBe('A study of birds.');
  });

  /** A refusal is not a description. Writing it into a catalogue would be
   *  worse than leaving the cell blank. */
  it('treats a refusal as no answer', () => {
    expect(cleanReply("I'm sorry, I cannot help with that.")).toBe('');
    expect(cleanReply('As an AI language model, I cannot determine this.')).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```typescript
// src/core/ai/prompt.ts

export interface PromptInput {
  /** What is being written, in words: "a description". */
  field: string;
  document: string;
  /** House style from the profile, or null. */
  instruction: string | null;
}

/**
 * Builds the request text.
 *
 * THE ANTI-FABRICATION LINE IS NOT DECORATION. This tool writes to a permanent
 * catalogue with no moderation queue, and a model that fills a gap with a
 * plausible invention produces something no reviewer can distinguish from a
 * real fact. It is stated explicitly rather than left to the model's defaults.
 */
export function buildPrompt(input: PromptInput): string {
  return [
    `Write ${input.field} for the document below, for a library catalogue.`,
    '',
    'Use only what the document states. Do not invent names, dates, places or',
    'events. If the document does not support a claim, leave it out. If you',
    'cannot write anything from the document, reply with nothing at all.',
    input.instruction ? `\n${input.instruction}` : '',
    '',
    'Reply with the text only -- no preamble, no quotation marks, no explanation.',
    '',
    '--- document ---',
    input.document,
  ].join('\n');
}

const REFUSAL = /^(i'?m sorry|i cannot|i can'?t|as an ai|unfortunately,? i)/i;

/**
 * Tidies a chat model's reply into a catalogue value.
 *
 * A REFUSAL BECOMES NOTHING. "I'm sorry, I cannot help with that" written into
 * MWDL/description would be worse than a blank cell: it looks like content,
 * survives review by skimming, and is visible to every future reader of the
 * record.
 */
export function cleanReply(reply: string): string {
  let text = reply.trim();
  if (REFUSAL.test(text)) return '';
  // "Here is a description:" and similar, only when a blank line follows it.
  text = text.replace(/^[^\n]{0,80}:\s*\n\s*\n/, '');
  text = text.replace(/^"(.*)"$/s, '$1');
  return text.trim();
}
```

- [ ] **Step 4: Run.** Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): a prompt that forbids invention, and a reply cleaner that refuses refusals"
```

---

## Task 7: The fill pass

**Files:**
- Create: `src/core/ai/fill.ts`, `tests/ai/fill.test.ts`

This ties the four pure modules to the provider. It is the only module in
`src/core/ai/` that does I/O.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/ai/fill.test.ts
import { describe, it, expect, vi } from 'vitest';
import { fillWithModel } from '../../src/core/ai/fill.js';
import type { ExtractedRow } from '../../src/core/extract/types.js';

const profile = {
  version: 1 as const,
  columns: [{ path: 'MWDL/description', sources: [{ opening: true }, { ai: true }] }],
};
const doc = (text: string) => ({ text, hasTextLayer: true, properties: {}, tables: [] });
const row = (over: Partial<ExtractedRow> = {}): ExtractedRow => ({
  cells: { 'MWDL/description': '' },
  sources: {},
  notes: [],
  flagged: {},
  ...over,
});

const provider = (reply: string) => ({ complete: vi.fn(async () => reply) });

describe('fillWithModel', () => {
  it('writes the model value into an eligible cell', async () => {
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, provider('A description.'), { budget: 1000, sections: [], cap: 10, model: 'llama3' });
    expect(rows[0]!.row.cells['MWDL/description']).toBe('A description.');
  });

  /** Always flagged, without exception -- a model output is a guess. */
  it('flags every cell it writes', async () => {
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, provider('A description.'), { budget: 1000, sections: [], cap: 10, model: 'llama3' });
    expect(rows[0]!.row.sources['MWDL/description']).toBe('ai');
    expect(rows[0]!.row.notes.join(' ')).toMatch(/written by a language model/i);
  });

  it('leaves a stated value alone and asks the model nothing about it', async () => {
    const p = provider('A description.');
    const rows = [{ row: row({ cells: { 'MWDL/description': 'Stated.' } }), doc: doc('A document.') }];
    await fillWithModel(rows, profile, p, { budget: 1000, sections: [], cap: 10, model: 'llama3' });
    expect(rows[0]!.row.cells['MWDL/description']).toBe('Stated.');
    expect(p.complete).not.toHaveBeenCalled();
  });

  /** A failure leaves a blank and a reason. Never a partial, never a retry loop. */
  it('leaves the cell blank and says why when the call fails', async () => {
    const p = { complete: vi.fn(async () => { throw new Error('the model returned 429'); }) };
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, p, { budget: 1000, sections: [], cap: 10, model: 'llama3' });
    expect(rows[0]!.row.cells['MWDL/description']).toBe('');
    expect(rows[0]!.row.notes.join(' ')).toMatch(/429/);
    expect(p.complete).toHaveBeenCalledTimes(1);
  });

  it('leaves the cell blank when the model refuses', async () => {
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, provider("I'm sorry, I cannot help."), { budget: 1000, sections: [], cap: 10, model: 'llama3' });
    expect(rows[0]!.row.cells['MWDL/description']).toBe('');
    expect(rows[0]!.row.notes.join(' ')).toMatch(/no answer|nothing/i);
  });

  /** The cap is a ceiling on spend, so what it stops must be visible. */
  it('stops at the cap and says the rest were not attempted', async () => {
    const p = provider('A description.');
    const rows = [1, 2, 3].map(() => ({ row: row(), doc: doc('A document.') }));
    await fillWithModel(rows, profile, p, { budget: 1000, sections: [], cap: 2, model: 'llama3' });
    expect(p.complete).toHaveBeenCalledTimes(2);
    expect(rows[2]!.row.cells['MWDL/description']).toBe('');
    expect(rows[2]!.row.notes.join(' ')).toMatch(/limit of 2/i);
  });

  it('sends nothing at all when no row is eligible', async () => {
    const p = provider('x');
    const rows = [{ row: row({ cells: { 'MWDL/description': 'Stated.' } }), doc: doc('A doc.') }];
    await fillWithModel(rows, profile, p, { budget: 1000, sections: [], cap: 10, model: 'llama3' });
    expect(p.complete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```typescript
// src/core/ai/fill.ts
import type { DocumentData, ExtractedRow, Profile } from '../extract/types.js';
import { eligibleColumns } from './eligible.js';
import { sliceForModel } from './slice.js';
import { buildPrompt, cleanReply } from './prompt.js';

/** Just enough of a provider to be substitutable in a test. */
export interface Completer {
  complete(prompt: string): Promise<string>;
}

export interface FillOptions {
  budget: number;
  sections: string[];
  /** Most documents to send in one run. Reaching it is reported, never silent. */
  cap: number;
  /** House style, from the profile. */
  instruction?: string | null;
}

export interface FillTarget {
  row: ExtractedRow;
  doc: DocumentData;
}

/**
 * Fill eligible cells from a language model. Mutates the rows in place, the
 * way the rest of the extract pipeline already works.
 *
 * ONE CALL PER ELIGIBLE CELL, IN ORDER, AND NEVER A RETRY. A retry loop over a
 * paid endpoint is a bill nobody agreed to, and the operator has already been
 * shown a count and confirmed it. A failure leaves the cell blank with the
 * reason on the row.
 *
 * EVERY WRITE IS FLAGGED. A model output is a guess, and this tool's rule is
 * that a guess says so -- the same rule that flags an opening paragraph.
 */
export async function fillWithModel(
  targets: FillTarget[],
  profile: Profile,
  provider: Completer,
  options: FillOptions,
): Promise<void> {
  let used = 0;
  for (const { row, doc } of targets) {
    for (const path of eligibleColumns(profile, row)) {
      if (used >= options.cap) {
        row.notes.push(
          `${path} was not sent to the model: this run reached its limit of ${options.cap} documents.`,
        );
        continue;
      }
      const slice = sliceForModel(doc.text, { budget: options.budget, sections: options.sections });
      if (slice.shape === 'empty') {
        row.notes.push(`${path} was not sent to the model: this file has no text to read.`);
        continue;
      }
      used += 1;
      try {
        const reply = cleanReply(
          await provider.complete(
            buildPrompt({ field: describe(path), document: slice.text, instruction: options.instruction ?? null }),
          ),
        );
        if (reply === '') {
          row.notes.push(`${path} was left blank: the model gave no answer for this document.`);
          continue;
        }
        row.cells[path] = reply;
        row.sources[path] = 'ai';
        row.notes.push(
          `${path} was written by a language model from the document text -- please check it before uploading.`,
        );
      } catch (error) {
        row.notes.push(
          `${path} was left blank: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

/** The field, in words, for the prompt. `MWDL/description` -> "a description". */
function describe(path: string): string {
  const leaf = path.split('/').pop() ?? path;
  return `a ${leaf.replace(/[_-]+/g, ' ').toLowerCase()}`;
}
```

- [ ] **Step 4: Run.** Expected: PASS, 7 tests.

- [ ] **Step 5: Mutation test — Edit tool only**

1. Remove the cap check → "stops at the cap" must go red.
2. Write the reply without flagging → "flags every cell it writes" must go red.
3. Retry once on failure → "leaves the cell blank and says why" must go red on the call count.
4. Treat a refusal as content (skip `cleanReply`) → its test must go red.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(ai): the fill pass -- one call per eligible cell, every write flagged"
```

---

## Task 8: Configuration and storage

**Files:**
- Modify: `src/desktop/secrets.ts`, `src/desktop/ui/screens/setup.ts`, `src/desktop/ipc.ts`, `src/desktop/preload.cts`
- Test: `tests/desktop/secrets.test.ts`, `tests/desktop/ui/setup.test.ts`

Read `src/desktop/secrets.ts` first and follow it exactly — it already stores a
client secret and a password per instance, refuses to write when OS encryption
is unavailable, and returns null rather than throwing on a corrupt store.

**`CHANNELS` is duplicated between `ipc.ts` and `preload.cts` on purpose** and a
drift test fails the build if they diverge. Change both together.

- [ ] **Step 1: Write the failing tests**

```typescript
// append to tests/desktop/secrets.test.ts
describe('model settings', () => {
  it('round-trip per instance, key included', async () => {
    const store = makeTestSecrets();
    await store.setModel('https://a.example.edu', {
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3',
      apiKey: '',
      budget: 8000,
      cap: 200,
    });
    expect(await store.getModel('https://a.example.edu')).toMatchObject({ model: 'llama3', budget: 8000 });
  });

  it('keeps two instances separate', async () => {
    const store = makeTestSecrets();
    await store.setModel('https://a.example.edu', { baseUrl: 'x', model: 'm', apiKey: '', budget: 1, cap: 1 });
    expect(await store.getModel('https://b.example.edu')).toBeNull();
  });

  /** The zero-prerequisite promise: nothing configured, feature absent. */
  it('returns null when nothing was ever configured', async () => {
    expect(await makeTestSecrets().getModel('https://a.example.edu')).toBeNull();
  });

  it('refuses to write when OS encryption is unavailable', async () => {
    const store = makeTestSecrets({ available: false });
    await expect(
      store.setModel('https://a.example.edu', { baseUrl: 'x', model: 'm', apiKey: 'k', budget: 1, cap: 1 }),
    ).rejects.toThrow();
  });
});
```

```typescript
// append to tests/desktop/ui/setup.test.ts
describe('the model section', () => {
  it('is not offered until an endpoint is entered', () => {
    expect(setupMarkup(props())).toContain('id="setup-model-base-url"');
  });

  /** A local endpoint needs no key, and asking for one implies it does. */
  it('says the key is only needed for a hosted endpoint', () => {
    expect(setupMarkup(props())).toMatch(/hosted|local/i);
  });
});
```

- [ ] **Step 2: Run to verify both fail.**

- [ ] **Step 3: Implement**

Add to `src/desktop/secrets.ts`:

```typescript
export interface ModelSettings {
  /** Base URL up to and including /v1. */
  baseUrl: string;
  model: string;
  /** Empty for a local runtime. Encrypted with everything else. */
  apiKey: string;
  /** Characters to send from one document. See the design doc. */
  budget: number;
  /** Most documents to send in one run. */
  cap: number;
}

setModel(instanceId: string, settings: ModelSettings): Promise<void>;
/** Null when nothing is configured -- which is what makes the feature absent. */
getModel(instanceId: string): Promise<ModelSettings | null>;
```

Store it in a `models` map keyed by instance, alongside `passwords`, for the
same reason: it must be removable without removing the site.

Setup gains a section with `#setup-model-base-url`, `#setup-model-name`,
`#setup-model-key`, `#setup-model-budget` and `#setup-model-cap`. **Add every
typed input to `TEXT_INPUTS`** or the caret test fails — which is the point of
that test.

Add three channels (`setModel`, `getModel`, `forgetModel`) to **both** `CHANNELS`
copies.

- [ ] **Step 4: Run `npm test`, `npm run typecheck`, `npm run build:desktop`.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(desktop): store a model endpoint per instance"
```

---

## Task 9: The confirmation and the cap

**Files:**
- Create: `src/desktop/ui/aiConfirm.ts`, `tests/desktop/ui/aiConfirm.test.ts`
- Modify: `src/desktop/ui/screens/extractColumns.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/desktop/ui/aiConfirm.test.ts
import { describe, it, expect } from 'vitest';
import { aiConfirmation } from '../../../src/desktop/ui/aiConfirm.js';

describe('aiConfirmation', () => {
  it('names the count, the provider and the model before anything is sent', () => {
    const text = aiConfirmation({ documents: 412, model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', characters: 1_200_000, cap: 500, local: false });
    expect(text).toContain('412');
    expect(text).toContain('gpt-4o-mini');
    expect(text).toMatch(/api\.openai\.com/);
  });

  it('says where the cap will stop it', () => {
    expect(aiConfirmation({ documents: 900, model: 'm', baseUrl: 'https://x/v1', characters: 10, cap: 500, local: false })).toMatch(/500/);
  });

  /**
   * A local run costs nothing and sends nothing off the machine. A dialog
   * there is friction that teaches the operator to click past dialogs -- which
   * is what makes the hosted one worthless.
   */
  it('is not shown for a local endpoint', () => {
    expect(aiConfirmation({ documents: 412, model: 'llama3', baseUrl: 'http://localhost:11434/v1', characters: 1, cap: 500, local: true })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```typescript
// src/desktop/ui/aiConfirm.ts
export interface AiConfirmInput {
  documents: number;
  model: string;
  baseUrl: string;
  characters: number;
  cap: number;
  /** True when the endpoint is on this machine. */
  local: boolean;
}

/**
 * What the operator is asked before any document is sent, or null when no
 * confirmation is warranted.
 *
 * NULL FOR A LOCAL ENDPOINT. Nothing leaves the machine and nothing is
 * charged, so a dialog would be pure friction -- and friction on a dialog that
 * does not matter is what trains people to click past the one that does.
 */
export function aiConfirmation(input: AiConfirmInput): string | null {
  if (input.local) return null;
  const host = new URL(input.baseUrl).host;
  return [
    `About to send ${input.documents} document${input.documents === 1 ? '' : 's'} to ${host}`,
    `  model: ${input.model}`,
    `  roughly ${Math.round(input.characters / 1000)}k characters of document text`,
    '',
    `This run stops after ${input.cap} documents; any beyond that are left blank and flagged.`,
    'Nothing is uploaded to openEQUELLA by this step -- it writes into your spreadsheet only.',
  ].join('\n');
}
```

Wire it into `extractColumns.ts`: when a model is configured and any column
carries `{ ai: true }`, show it before the extract runs, with the same
confirm/cancel treatment the publish step already uses. **`local` is
`baseUrl`'s host resolving to loopback** — `localhost`, `127.0.0.0/8`, `[::1]`.

- [ ] **Step 4: Run all gates.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(desktop): say what is about to be sent, and where it stops"
```

---

## Task 10: Disclosure in the item

**Files:**
- Modify: `src/core/extract/profile.ts`, `src/core/ai/fill.ts`
- Test: `tests/ai/fill.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// append to tests/ai/fill.test.ts
describe('disclosure in the item', () => {
  const withProvenance = {
    version: 1 as const,
    columns: [{ path: 'MWDL/description', sources: [{ ai: true }] }],
    aiProvenance: { path: 'MWDL/conversionSpecifications', append: 'Description generated by {model}' },
  };

  it('appends a provenance note to the named field', async () => {
    const rows = [{ row: row({ cells: { 'MWDL/description': '', 'MWDL/conversionSpecifications': 'Scanned to PDF' } }), doc: doc('A doc.') }];
    await fillWithModel(rows, withProvenance, provider('A description.'), { budget: 1000, sections: [], cap: 10, model: 'llama3' });
    expect(rows[0]!.row.cells['MWDL/conversionSpecifications']).toBe('Scanned to PDF; Description generated by llama3');
  });

  /** The tool never picks the field. No profile setting, no write. */
  it('writes nothing to the item when no profile names a field', async () => {
    const rows = [{ row: row({ cells: { 'MWDL/description': '', 'MWDL/conversionSpecifications': 'Scanned to PDF' } }), doc: doc('A doc.') }];
    await fillWithModel(rows, profile, provider('A description.'), { budget: 1000, sections: [], cap: 10, model: 'llama3' });
    expect(rows[0]!.row.cells['MWDL/conversionSpecifications']).toBe('Scanned to PDF');
  });

  it('writes the note once even when several columns were filled', async () => {
    const two = { ...withProvenance, columns: [
      { path: 'MWDL/description', sources: [{ ai: true }] },
      { path: 'MWDL/abstract', sources: [{ ai: true }] },
    ] };
    const rows = [{ row: row({ cells: { 'MWDL/description': '', 'MWDL/abstract': '', 'MWDL/conversionSpecifications': '' } }), doc: doc('A doc.') }];
    await fillWithModel(rows, two, provider('Text.'), { budget: 1000, sections: [], cap: 10, model: 'llama3' });
    expect(rows[0]!.row.cells['MWDL/conversionSpecifications']).toBe('Description generated by llama3');
  });

  it('writes nothing when the model wrote nothing', async () => {
    const rows = [{ row: row({ cells: { 'MWDL/description': '', 'MWDL/conversionSpecifications': '' } }), doc: doc('A doc.') }];
    await fillWithModel(rows, withProvenance, provider("I'm sorry, I cannot help."), { budget: 1000, sections: [], cap: 10, model: 'llama3' });
    expect(rows[0]!.row.cells['MWDL/conversionSpecifications']).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

Add `model: string` to `FillOptions`. Add to `Profile`:

```typescript
  /**
   * Where to record, in the item itself, that a model wrote something.
   *
   * ABSENT BY DEFAULT AND THE TOOL NEVER PICKS IT. Choosing a path on an
   * institution's behalf is the assumption an entire release was spent
   * removing; a wrong one writes outside the schema on every item.
   */
  aiProvenance?: { path: string; append: string };
```

In `fillWithModel`, after processing a row: if the profile names a path **and**
at least one cell was written, append `aiProvenance.append` with `{model}`
substituted, joined to any existing value with `'; '`.

Validate the path against the schema the same way every other path is —
reporting "not declared" rather than writing outside it.

- [ ] **Step 4: Run all gates.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): record in the item that a model wrote a value, when a profile asks"
```

---

## Task 11: Wire it into both front ends

**Files:**
- Modify: `src/cli/extract.ts`, `src/desktop/extractHandlers.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// append to tests/cli/extract.test.ts
import { runExtract } from '../../src/cli/extract.js';

/**
 * THE ZERO-PREREQUISITE PROMISE. A library that never configures an endpoint
 * must get exactly today's behaviour -- no prompt, no error, no degraded mode.
 * If this test ever fails, the installer has stopped being safe to hand to an
 * institution that has not had a data review.
 */
describe('with no model configured', () => {
  it('extracts exactly as it does today', async () => {
    const dir = await makeFolder({ 'a.txt': 'A document with an opening sentence in it.' });
    const profile = {
      version: 1,
      columns: [{ path: 'MWDL/description', sources: [{ opening: true }] }],
    };
    const out = join(dir, 'out.csv');
    await runExtract({ dir, profile: await writeProfile(dir, profile), out }, () => {}, {});
    expect(await readFile(out, 'utf8')).toContain('opening sentence');
  });

  /**
   * A column that asked for a model, with none set up, must SAY so. Producing
   * a silently empty cell is the shape of failure this codebase has been bitten
   * by four times: a thing that could not run, reported as if it had.
   */
  it('says an ai column needed a model that is not configured', async () => {
    const dir = await makeFolder({ 'a.txt': 'A document.' });
    const profile = {
      version: 1,
      columns: [{ path: 'MWDL/description', sources: [{ ai: true }] }],
    };
    const out = join(dir, 'out.csv');
    await runExtract({ dir, profile: await writeProfile(dir, profile), out }, () => {}, {});
    const csv = await readFile(out, 'utf8');
    expect(csv).toMatch(/no model is configured/i);
  });

  it('sends nothing anywhere', async () => {
    const fetchSpy = vi.fn();
    const dir = await makeFolder({ 'a.txt': 'A document.' });
    const profile = { version: 1, columns: [{ path: 'MWDL/description', sources: [{ ai: true }] }] };
    await runExtract(
      { dir, profile: await writeProfile(dir, profile), out: join(dir, 'out.csv') },
      () => {},
      {},
      fetchSpy as unknown as typeof fetch,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

`makeFolder` and `writeProfile` are the file's existing helpers — read
`tests/cli/extract.test.ts` first and use them rather than building new ones.
The fourth argument to `runExtract` is the injectable `fetch`; add it in Step 3
if it does not exist, defaulting to the global.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

CLI: `--ai` on `oeq-upload extract`, reading `OEQ_MODEL_BASE_URL`,
`OEQ_MODEL`, `OEQ_MODEL_KEY`, `OEQ_MODEL_BUDGET`, `OEQ_MODEL_CAP`. Print the
same confirmation text and require `--yes` to proceed unattended.

Desktop: after `buildRow` in `extractHandlers.ts`, if a model is configured and
any column asks for one, call `fillWithModel` with the stored settings.

**Both must be no-ops when nothing is configured.**

- [ ] **Step 4: Run all gates.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: run the model pass from the CLI and the desktop"
```

---

## Task 11b: Enable it on the shipped template — and only there

The spec says v1 ships "enabled for the description only". Nothing so far
does that: `{ ai: true }` is profile configuration, and no shipped profile
carries it.

**Files:**
- Modify: `templates/alumni-obituary.profile.json`
- Test: `tests/extract/templates.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// append to tests/extract/templates.test.ts
describe('the model is offered where it helps and nowhere else', () => {
  it('asks for a model on the description, after the deterministic sources', async () => {
    const profile = await loadTemplate('alumni-obituary');
    const description = profile.columns.find((c) => c.path === 'MWDL/description');
    const sources = description?.sources ?? [];
    expect(sources.some((s) => 'ai' in s)).toBe(true);
    // Last, so every deterministic source has its turn first. The rule does
    // not depend on order, but a reader of the profile should see the
    // intended precedence.
    expect('ai' in (sources[sources.length - 1] ?? {})).toBe(true);
  });

  /**
   * A death date is a FACT. A model that fills one produces something no
   * reviewer can distinguish from a real one, in a collection with no
   * moderation queue. Prose only, in this release.
   */
  it('asks for a model on no other column', async () => {
    const profile = await loadTemplate('alumni-obituary');
    const asked = profile.columns.filter((c) => c.sources.some((s) => 'ai' in s)).map((c) => c.path);
    expect(asked).toEqual(['MWDL/description']);
  });
});
```

- [ ] **Step 2: Run to verify both fail.**

- [ ] **Step 3: Implement**

In `templates/alumni-obituary.profile.json`, the description column becomes:

```json
{ "path": "MWDL/description",
  "sources": [
    { "compose": "Died {death_date}; Born {birth_date}; {ricks}" },
    { "ai": true }
  ] }
```

Add the house style so the model produces the same shape the compose source
does, rather than inventing its own:

```json
"aiInstruction": "Write one line in this form, omitting any part the document does not state: Died <date>; Born <date>; Attended Ricks College. Use ISO dates."
```

**Change no other column.** The death-date column stays deterministic.

- [ ] **Step 4: Run all gates.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(templates): let a model write the obituary description, and nothing else"
```

---

## Task 12: Documentation

**Files:**
- Modify: `README.md`, `docs/INSTALL.md`, `CLAUDE.md`, `.env.example`

- [ ] **Step 1: README** — a section on configuring an endpoint, with a worked
  Ollama example (`ollama pull llama3`, base URL `http://localhost:11434/v1`)
  and a hosted one. State plainly that output quality is unverified and is the
  operator's judgement.

- [ ] **Step 2: INSTALL.md** — what the operator sees: the confirmation, the
  cap, the flag on every model-written cell, and that leaving it unconfigured
  costs them nothing.

- [ ] **Step 3: CLAUDE.md** — a domain fact: `resolve()` is synchronous and
  `src/core/extract/` never touches the network; the model pass is separate for
  that reason and must stay so.

- [ ] **Step 4: `.env.example`** — the five variables, with the note that
  omitting `OEQ_MODEL_BASE_URL` disables the feature entirely.

- [ ] **Step 5: Commit**

```bash
git commit -m "docs: how to point the tool at a model, and what it does not promise"
```

---

## Task 13: Run it against a real model

**Not automatable. This is the task that finds what the tests cannot.**

- [ ] **Step 1: `ollama pull llama3` and point the app at `http://localhost:11434/v1`.**

- [ ] **Step 2: Run a real batch** — the obituary folder is the case that
  prompted this work, and tier 3 flags every row there, so every row is
  eligible.

- [ ] **Step 3: Read every generated description.** Specifically:

  - Did it invent a date, a place or a relative? That is the failure the whole
    design guards against, and only a human reading the source document can
    see it.
  - Does it match the house style, or does the prompt need the profile
    instruction?
  - Is the flag visible enough in the saved CSV that a reviewer would notice?

- [ ] **Step 4: Record what the prompt needed** in the spec's "What ships
  first" section. That is what the second field will need to know.

- [ ] **Step 5: Full verification**

```bash
npm test && npm run typecheck && npm run build && npm run build:desktop
```

- [ ] **Step 6: Open the PR.**

**No assertion in this plan can say a description is good.** The plan does not
claim otherwise, and Step 3 is the only thing standing between a plausible
invention and a permanent catalogue record.
