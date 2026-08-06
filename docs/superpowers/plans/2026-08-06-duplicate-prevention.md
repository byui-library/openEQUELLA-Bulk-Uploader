# Duplicate Prevention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the tool silently re-uploading files it has already uploaded, by checking each planned row against the target collection on a field the spreadsheets actually contain.

**Architecture:** A new `src/core/duplicates.ts` holds the verdict logic and is free of network and UI concerns; `OeqClient` gains one exact-match search; the three front ends present the verdicts and let a row be skipped. A skipped row is written into the manifest with the existing terminal status `skipped`, so the runner needs no change at all.

**Tech Stack:** TypeScript on Node 22, vitest, `moduleResolution: nodenext` (relative imports need `.js`), `strict` + `noUncheckedIndexedAccess`.

**Spec:** [../specs/2026-08-06-duplicate-prevention-design.md](../specs/2026-08-06-duplicate-prevention-design.md)

---

## Before you start

```bash
git checkout main && git pull
git checkout -b feature/duplicate-prevention
npm install && npm test        # expect 730 passing across 61 files
```

Two conventions this codebase enforces and a reviewer will reject you for breaking:

- **Relative imports end in `.js`**, even from `.ts` files.
- **Nothing reachable from `src/desktop/ui/` may import `node:*` or `electron`.** The renderer is sandboxed; such an import does not fail loudly, it blanks the window. `tests/desktop/rendererPurity.test.ts` fails the build if you do it. Types are fine — they are erased.

## File structure

| File | Responsibility |
| --- | --- |
| `src/core/duplicates.ts` | **New.** Verdict types, the pure `verdictFor`, `defaultChoice`, and the `findDuplicates` orchestration. Kept out of `plan.ts`, which is already large and has a different job. |
| `src/core/client.ts` | **Modify.** Add `escapeWhereValue` and `searchByTitle`. |
| `src/core/plan.ts` | **Modify.** Add `markSkipped`. `preflightDuplicates` is left exactly as it is. |
| `src/cli/index.ts` | **Modify.** Report findings, skip near-certain rows, add `--upload-duplicates`. |
| `src/desktop/ipc.ts` | **Modify.** `PlanReport.duplicates`, plus an `applyDuplicateChoices` channel. |
| `src/desktop/preload.cts` | **Modify.** The new channel. `CHANNELS` is duplicated here on purpose and a drift test guards it. |
| `src/desktop/handlers.ts` | **Modify.** Call `findDuplicates`; handle `applyDuplicateChoices`. |
| `src/desktop/ui/batch.ts` | **Modify.** The findings and the operator's choices are batch-scoped state. |
| `src/desktop/ui/screens/review.ts` | **Modify.** Render the duplicates section. |
| `src/desktop/ui/screens/results.ts` | **Modify.** Widen one label. |
| `src/desktop/ui/app.ts` | **Modify.** Hold choices, apply them before the run. |
| `src/mcp/index.ts` | **Modify.** Return findings from the plan tool. |
| `tests/helpers/mockServer.ts` | **Modify.** Teach the fake server `where` and `info=attachment`. |
| `scripts/probe-where.mts` | **New.** The one-off live probe. |

---

## Task 1: The live probe

**This task comes first and gates Tasks 2 and 3.** Two assumptions are unverified against the real instance: the syntax of the `where` clause, and where an attachment's filename appears in a search result. `schema/swagger.json` documents `where` only as a link to external docs, and its `AttachmentBean` has no `filename` property at all. This project has twice been wrong about exactly this kind of thing — the staging `?file=` parameter and the `showall` default — and both times the entire test suite agreed with the wrong answer.

**Files:**
- Create: `scripts/probe-where.mts`

- [ ] **Step 1: Write the probe**

```typescript
// scripts/probe-where.mts
// One-off probe. Answers two questions the captured swagger.json cannot:
//   1. What `where` clause syntax does this instance accept?
//   2. Where does an attachment's filename appear in a search result?
// Run against TEST, never production. Delete nothing; this only reads.
import { OeqClient } from '../src/core/client.js';
import { OAuthClientCredentials } from '../src/core/auth.js';

const baseUrl = process.env.OEQ_BASE_URL;
const collection = process.env.OEQ_COLLECTION_UUID;
const title = process.env.OEQ_PROBE_TITLE;
if (!baseUrl || !collection || !title) {
  console.error('Set OEQ_BASE_URL, OEQ_COLLECTION_UUID and OEQ_PROBE_TITLE.');
  process.exit(1);
}

const auth = new OAuthClientCredentials(
  baseUrl,
  process.env.OEQ_CLIENT_ID ?? '',
  process.env.OEQ_CLIENT_SECRET ?? '',
);
const token = await auth.authHeader();

async function get(qs: string): Promise<{ status: number; body: string }> {
  const res = await fetch(new URL(`/api/search?${qs}`, baseUrl), { headers: token });
  return { status: res.status, body: (await res.text()).slice(0, 1500) };
}

const enc = encodeURIComponent;

console.log('--- A: doubled-quote escaping, exact title');
console.log(
  await get(
    `collections=${enc(collection)}&where=${enc(`/xml/MWDL/title = '${title.replace(/'/g, "''")}'`)}` +
      `&info=attachment&showall=true&length=5`,
  ),
);

console.log('--- B: a title that certainly does not exist');
console.log(
  await get(
    `collections=${enc(collection)}&where=${enc(`/xml/MWDL/title = 'zzz-no-such-item-zzz'`)}` +
      `&info=attachment&showall=true&length=5`,
  ),
);

console.log('--- C: backslash escaping, for comparison with A');
console.log(
  await get(
    `collections=${enc(collection)}&where=${enc(`/xml/MWDL/title = '${title.replace(/'/g, "\\'")}'`)}` +
      `&info=attachment&showall=true&length=5`,
  ),
);
```

- [ ] **Step 2: Run it against the TEST instance**

Ask the operator for the credentials and a title known to exist. Then:

```bash
OEQ_BASE_URL=https://content-test.byui.edu \
OEQ_CLIENT_ID=<from the operator> OEQ_CLIENT_SECRET=<from the operator> \
OEQ_COLLECTION_UUID=bb348ab1-7a81-4e37-8ef7-adc095ade4f9 \
OEQ_PROBE_TITLE="<a title known to exist>" \
npx tsx scripts/probe-where.mts
```

- [ ] **Step 3: Record the three answers**

Write down, and carry into Tasks 2 and 3:

1. **Does A return status 200 with `available >= 1`?** If it returns 400, the clause syntax is wrong — try `/xml/MWDL/title='...'` without spaces, and consult the Edalex REST docs linked from swagger.json's `where` description. **Do not proceed to Task 3 until a clause returns 200 with a plausible hit count.**
2. **Does B return `available: 0`?** If B also returns hits, `where` is not filtering and the whole approach is invalid — stop and report to the operator rather than building on it.
3. **In A's `results[0]`, what key holds the attachment filename?** Look for `attachments[0].filename`, `attachments[0].description`, or a nested `links`. Record the exact path.

Also note whether A or C is the working escape.

- [ ] **Step 4: Commit the probe and the findings**

Add what you learned as a comment block at the top of `scripts/probe-where.mts`, replacing nothing — the questions stay, the answers go under them.

```bash
git add scripts/probe-where.mts
git commit -m "chore: probe the search where clause against the test instance"
```

---

## Task 2: Escaping a value for a where clause

**Files:**
- Modify: `src/core/client.ts`
- Test: `tests/client.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/client.test.ts`:

```typescript
describe('escapeWhereValue', () => {
  // A music library. "Bach's Prelude" is not a hypothetical title.
  it('doubles a single quote so it cannot end the literal early', () => {
    expect(escapeWhereValue("Bach's Prelude")).toBe("Bach''s Prelude");
  });

  it('doubles every quote, not just the first', () => {
    expect(escapeWhereValue("A's B's")).toBe("A''s B''s");
  });

  it('leaves an ordinary title untouched', () => {
    expect(escapeWhereValue('Senior Recital')).toBe('Senior Recital');
  });

  it('leaves a backslash alone', () => {
    expect(escapeWhereValue('a\\b')).toBe('a\\b');
  });

  it('leaves a newline alone, for the URL encoder to deal with', () => {
    expect(escapeWhereValue('a\nb')).toBe('a\nb');
  });

  it('handles an empty string', () => {
    expect(escapeWhereValue('')).toBe('');
  });
});
```

Add `escapeWhereValue` to the existing import from `../src/core/client.js` at the top of that file.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/client.test.ts -t escapeWhereValue`
Expected: FAIL — `escapeWhereValue is not a function`.

- [ ] **Step 3: Implement**

Add to `src/core/client.ts`, above the `OeqClient` class:

```typescript
/**
 * Escape a value for interpolation into a search `where` clause.
 *
 * Doubling the single quote is the escape this instance accepts; confirmed by
 * `scripts/probe-where.mts` (Task 1), not assumed. A title containing an
 * apostrophe would otherwise end the literal early and either error or, far
 * worse, silently change what is being matched.
 *
 * Nothing else is escaped: everything is passed through `encodeURIComponent`
 * on the way into the URL, which handles newlines, backslashes and the rest.
 */
export function escapeWhereValue(value: string): string {
  return value.replace(/'/g, "''");
}
```

**If Task 1 found that backslash escaping is what works**, implement `value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")` instead and change the tests to match — the tests encode the answer, so they change with it.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/client.test.ts -t escapeWhereValue`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/client.ts tests/client.test.ts
git commit -m "feat(client): escape a value for a search where clause"
```

---

## Task 3: Teach the mock server `where` and `info=attachment`

The mock server's `/api/search` currently understands only `q`. It has to model the real thing before the client can be tested against it.

**Files:**
- Modify: `tests/helpers/mockServer.ts`

- [ ] **Step 1: Extend the mock's state**

In `MockState` (around line 168), beside `existingIdentifiers`, add:

```typescript
  /** Items that already exist, for the title/attachment duplicate check. */
  existingItems: { uuid: string; version: number; title: string; attachmentNames: string[] }[];
```

And in the `state` literal inside `startMockServer`, beside `existingIdentifiers: []`, add:

```typescript
    existingItems: [],
```

- [ ] **Step 2: Extend the search handler**

Replace the `/api/search` block (around line 344) with:

```typescript
      if (path === '/api/search' && req.method === 'GET') {
        // CONFIRMED against swagger.json: `showall` (default false) gates
        // whether non-live items are matched at all. Items here default to
        // draft, i.e. not live, so a hit requires showall=true regardless
        // of whether the identifier is otherwise known -- modelling the
        // live server's default of excluding drafts entirely.
        const showAll = url.searchParams.get('showall') === 'true';
        const where = url.searchParams.get('where');

        if (where) {
          // Models EXACT matching on the node, which is the whole point of
          // using `where` rather than free-text `q`. The clause this tool
          // sends is `/xml/MWDL/title = 'value'`, with '' as an escaped
          // quote; anything else is rejected the way a real server would.
          const parsed = /^\/xml\/MWDL\/title\s*=\s*'(.*)'$/s.exec(where);
          if (!parsed) return send(res, 400, { error: `unparseable where clause: ${where}` });
          const wanted = parsed[1]!.replace(/''/g, "'");

          const hits = showAll
            ? state.existingItems.filter((i) => i.title === wanted)
            : [];
          const withAttachments = url.searchParams.get('info')?.includes('attachment') ?? false;
          return send(res, 200, {
            available: hits.length,
            results: hits.map((i) => ({
              uuid: i.uuid,
              version: i.version,
              name: i.title,
              ...(withAttachments
                ? { attachments: i.attachmentNames.map((filename) => ({ filename })) }
                : {}),
            })),
          });
        }

        const q = url.searchParams.get('q') ?? '';
        const hit = showAll && state.existingIdentifiers.some((id) => q.includes(id));
        return send(res, 200, { available: hit ? 1 : 0, results: hit ? [{ uuid: 'existing' }] : [] });
      }
```

**If Task 1 found the filename lives somewhere other than `attachments[].filename`**, change the shape emitted here to match what the real server returned, and keep Task 4's parser aligned with it.

- [ ] **Step 3: Verify nothing regressed**

Run: `npx vitest run tests/client.test.ts tests/plan.test.ts`
Expected: PASS — the `q` path is untouched, so the existing identifier tests still pass.

- [ ] **Step 4: Commit**

```bash
git add tests/helpers/mockServer.ts
git commit -m "test: model exact where-clause search in the mock server"
```

---

## Task 4: `searchByTitle` on the client

**Files:**
- Modify: `src/core/client.ts`
- Test: `tests/client.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/client.test.ts`, inside the same `describe` that builds a `client` against the mock:

```typescript
describe('searchByTitle', () => {
  it('finds an item by exact title and returns its attachment filenames', async () => {
    mock.state.existingItems = [
      { uuid: 'i1', version: 1, title: 'Senior Recital', attachmentNames: ['Smith_Jane.pdf'] },
    ];
    const hits = await client.searchByTitle('c1', 'Senior Recital');
    expect(hits).toEqual([
      { uuid: 'i1', version: 1, name: 'Senior Recital', attachmentNames: ['Smith_Jane.pdf'] },
    ]);
  });

  it('does not match a title that merely shares a word', async () => {
    mock.state.existingItems = [
      { uuid: 'i1', version: 1, title: 'Senior Recital', attachmentNames: [] },
    ];
    expect(await client.searchByTitle('c1', 'Recital')).toEqual([]);
    expect(await client.searchByTitle('c1', 'Senior')).toEqual([]);
  });

  it('matches a title containing an apostrophe', async () => {
    mock.state.existingItems = [
      { uuid: 'i1', version: 1, title: "Bach's Prelude", attachmentNames: ['b.pdf'] },
    ];
    const hits = await client.searchByTitle('c1', "Bach's Prelude");
    expect(hits).toHaveLength(1);
  });

  it('returns nothing when the collection holds no such title', async () => {
    mock.state.existingItems = [];
    expect(await client.searchByTitle('c1', 'Senior Recital')).toEqual([]);
  });

  /**
   * Items this tool creates are drafts. Without showall=true the search
   * excludes them, and the check would be blind to precisely the duplicates
   * it exists to catch -- this tool's own recent runs. That mistake has
   * already been made once in this codebase.
   */
  it('asks for non-live items, or it would never see this tool own drafts', async () => {
    mock.state.existingItems = [
      { uuid: 'i1', version: 1, title: 'A Draft', attachmentNames: [] },
    ];
    // The mock returns hits for a where-clause search ONLY when showall=true.
    expect(await client.searchByTitle('c1', 'A Draft')).toHaveLength(1);
  });

  it('asks for attachments, or the filename tier has nothing to compare', async () => {
    mock.state.existingItems = [
      { uuid: 'i1', version: 1, title: 'T', attachmentNames: ['only-if-info-requested.pdf'] },
    ];
    expect((await client.searchByTitle('c1', 'T'))[0]?.attachmentNames).toEqual([
      'only-if-info-requested.pdf',
    ]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/client.test.ts -t searchByTitle`
Expected: FAIL — `client.searchByTitle is not a function`.

- [ ] **Step 3: Implement**

Add the type next to the client's other exported types in `src/core/client.ts`:

```typescript
/** One item already in the collection, as the duplicate check needs to see it. */
export interface SearchHit {
  uuid: string;
  version: number;
  name: string;
  /** Filenames of this item's attachments. Empty if it has none. */
  attachmentNames: string[];
}
```

And this method inside `OeqClient`, beside `identifierExists`:

```typescript
  /**
   * Items in the collection whose title is EXACTLY `title`.
   *
   * Uses the search API's `where` clause rather than free-text `q`.
   * `identifierExists` uses `q` and its own comment concedes the
   * phrase-quoting behaviour is unconfirmed -- a `q` search for
   * "Senior Recital" may match anything containing "senior" or "recital".
   * False alarms are not harmless: they teach the operator to click past the
   * warning, which is worse than no check. `where` matches the node exactly,
   * server-side, which also makes this viable against a collection of
   * 100,000+ items where reading everything is not an option.
   *
   * `showall=true` is mandatory -- see identifierExists' note; every item this
   * tool creates is a draft, and the default excludes them.
   *
   * `info=attachment` brings each hit's attachments back in the same
   * response, so comparing filenames costs no extra requests.
   *
   * The clause syntax and the attachment shape were confirmed against the
   * test instance by `scripts/probe-where.mts`, not assumed from swagger.json,
   * which documents `where` only as a link and models no attachment filename
   * at all.
   */
  async searchByTitle(collectionUuid: string, title: string, limit = 50): Promise<SearchHit[]> {
    const clause = `/xml/MWDL/title = '${escapeWhereValue(title)}'`;
    const url =
      `/api/search?collections=${encodeURIComponent(collectionUuid)}` +
      `&where=${encodeURIComponent(clause)}` +
      `&info=attachment&showall=true&length=${limit}`;
    const res = await this.request(url);
    const body = (await res.json()) as {
      results?: {
        uuid?: string;
        version?: number;
        name?: string;
        attachments?: { filename?: string; description?: string }[];
      }[];
    };
    return (body.results ?? []).map((r) => ({
      uuid: r.uuid ?? '',
      version: r.version ?? 1,
      name: r.name ?? '',
      // `filename` first, `description` as a fallback: swagger.json's
      // AttachmentBean models NEITHER as a filename, so which one carries it
      // was settled by the probe. Reading both means a server that uses the
      // other one still works rather than silently comparing empty strings.
      attachmentNames: (r.attachments ?? [])
        .map((a) => a.filename ?? a.description ?? '')
        .filter((n) => n !== ''),
    }));
  }
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/client.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/core/client.ts tests/client.test.ts
git commit -m "feat(client): exact title search with attachments"
```

---

## Task 5: The verdict logic

Pure. No network, no UI. This is the file that decides what counts as a duplicate.

**Files:**
- Create: `src/core/duplicates.ts`
- Test: `tests/duplicates.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/duplicates.test.ts
import { describe, it, expect } from 'vitest';
import { verdictFor, defaultChoice } from '../src/core/duplicates.js';
import type { SearchHit } from '../src/core/client.js';

const hit = (title: string, attachmentNames: string[] = []): SearchHit => ({
  uuid: 'i1',
  version: 1,
  name: title,
  attachmentNames,
});

describe('verdictFor', () => {
  it('reports nothing when the collection has no item with this title', () => {
    expect(verdictFor('Smith_Jane.pdf', 'Senior Recital', [])).toBeNull();
  });

  it('calls it near-certain when an existing item holds the same file', () => {
    const v = verdictFor('Smith_Jane.pdf', 'Senior Recital', [hit('Senior Recital', ['Smith_Jane.pdf'])]);
    expect(v?.tier).toBe('near-certain');
  });

  /**
   * Two students genuinely can have "Senior Recital". A title match alone is
   * not proof, and treating it as proof would silently drop real items.
   */
  it('calls it only possible when the title matches but the file differs', () => {
    const v = verdictFor('Smith_Jane.pdf', 'Senior Recital', [hit('Senior Recital', ['Lee_Anna.pdf'])]);
    expect(v?.tier).toBe('possible');
  });

  it('matches a filename ignoring case and surrounding space', () => {
    const v = verdictFor('Smith_Jane.pdf', 'T', [hit('T', ['  SMITH_JANE.PDF  '])]);
    expect(v?.tier).toBe('near-certain');
  });

  it('is near-certain if ANY hit holds the file, not just the first', () => {
    const v = verdictFor('Smith_Jane.pdf', 'T', [hit('T', ['other.pdf']), hit('T', ['Smith_Jane.pdf'])]);
    expect(v?.tier).toBe('near-certain');
  });

  it('handles a hit with no attachments at all', () => {
    expect(verdictFor('Smith_Jane.pdf', 'T', [hit('T', [])])?.tier).toBe('possible');
  });

  /**
   * A row with no title cannot be checked this way. Saying so is the point:
   * a check that quietly reports nothing teaches the operator that silence
   * means safety.
   */
  it('reports a row with no title as not checkable, never as clean', () => {
    const v = verdictFor('Smith_Jane.pdf', '', []);
    expect(v?.tier).toBe('not-checkable');
    expect(v?.detail).toMatch(/no title/i);
  });

  it('treats a whitespace-only title as no title', () => {
    expect(verdictFor('a.pdf', '   ', [])?.tier).toBe('not-checkable');
  });

  it('carries the existing items through so the operator can look at them', () => {
    const v = verdictFor('Smith_Jane.pdf', 'T', [hit('T', ['Smith_Jane.pdf'])]);
    expect(v?.existing).toEqual([{ uuid: 'i1', version: 1, title: 'T', attachmentNames: ['Smith_Jane.pdf'] }]);
  });
});

describe('defaultChoice', () => {
  // A filename match is near-proof; re-uploading is almost never wanted.
  it('skips a near-certain duplicate by default', () => {
    expect(defaultChoice('near-certain')).toBe('skip');
  });

  /**
   * Uploads by default, deliberately. A silent omission is worse than a
   * visible duplicate: the operator can delete a duplicate they can see, but
   * cannot notice an item that never arrived.
   */
  it('uploads a merely possible duplicate by default', () => {
    expect(defaultChoice('possible')).toBe('upload');
  });

  it('uploads when the row could not be checked, rather than dropping it', () => {
    expect(defaultChoice('not-checkable')).toBe('upload');
    expect(defaultChoice('could-not-check')).toBe('upload');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/duplicates.test.ts`
Expected: FAIL — cannot resolve `../src/core/duplicates.js`.

- [ ] **Step 3: Implement**

```typescript
// src/core/duplicates.ts
import type { SearchHit } from './client.js';

/**
 * How sure the tool is that a row has already been uploaded.
 *
 * Two tiers rather than a yes/no, because they deserve different defaults:
 * a filename match is near-proof, a title match alone is ordinary and often
 * innocent.
 */
export type DuplicateTier = 'near-certain' | 'possible' | 'not-checkable' | 'could-not-check';

export type DuplicateChoice = 'skip' | 'upload';

export interface DuplicateFinding {
  rowNumber: number;
  fileName: string;
  tier: DuplicateTier;
  /** Plain-language reason, shown to the operator as-is. */
  detail: string;
  /** The items already in the collection that caused this. */
  existing: { uuid: string; version: number; title: string; attachmentNames: string[] }[];
}

/** Compare filenames the way sheet.ts already compares attachment names. */
function sameFile(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The verdict for one row, or null if there is nothing to say.
 *
 * Deliberately pure and network-free: what counts as a duplicate is a rule,
 * and rules are worth testing without a server.
 */
export function verdictFor(
  fileName: string,
  title: string,
  hits: readonly SearchHit[],
): DuplicateFinding | null {
  const base = { rowNumber: 0, fileName, existing: [] as DuplicateFinding['existing'] };

  if (title.trim() === '') {
    return {
      ...base,
      tier: 'not-checkable',
      detail: 'this row has no title, so it could not be checked for duplicates',
    };
  }

  if (hits.length === 0) return null;

  const existing = hits.map((h) => ({
    uuid: h.uuid,
    version: h.version,
    title: h.name,
    attachmentNames: h.attachmentNames,
  }));

  const fileMatch = hits.some((h) => h.attachmentNames.some((n) => sameFile(n, fileName)));

  return fileMatch
    ? {
        ...base,
        existing,
        tier: 'near-certain',
        detail: `an item with this title already holds a file called '${fileName}'`,
      }
    : {
        ...base,
        existing,
        tier: 'possible',
        detail: `an item with this title already exists, but holds a different file`,
      };
}

/**
 * What happens to a flagged row if the operator changes nothing.
 *
 * Only a near-certain match defaults to skipping. Everything else uploads,
 * because a silent omission is worse than a visible duplicate -- a duplicate
 * can be seen and deleted; an item that never arrived cannot be noticed.
 */
export function defaultChoice(tier: DuplicateTier): DuplicateChoice {
  return tier === 'near-certain' ? 'skip' : 'upload';
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/duplicates.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/duplicates.ts tests/duplicates.test.ts
git commit -m "feat(core): duplicate verdict rules"
```

---

## Task 6: `findDuplicates` — running the check over a manifest

**Files:**
- Modify: `src/core/duplicates.ts`
- Test: `tests/duplicates.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/duplicates.test.ts`:

```typescript
import { findDuplicates } from '../src/core/duplicates.js';
import type { Manifest } from '../src/core/types.js';

function manifestOf(rows: { rowNumber: number; fileName: string; title: string }[]): Manifest {
  return {
    version: 1,
    createdAt: '2026-08-06T00:00:00.000Z',
    baseUrl: 'https://example.test',
    collectionUuid: 'c1',
    schemaUuid: 's1',
    itemState: 'draft',
    attachmentColumn: 'attachment name',
    warnings: [],
    entries: rows.map((r) => ({
      rowNumber: r.rowNumber,
      filePath: `/files/${r.fileName}`,
      fileName: r.fileName,
      metadata: { 'MWDL/title': [r.title] },
      status: 'pending' as const,
      attempts: 0,
    })),
  };
}

describe('findDuplicates', () => {
  it('reports one finding per flagged row, with its row number', async () => {
    const manifest = manifestOf([
      { rowNumber: 2, fileName: 'a.pdf', title: 'Taken' },
      { rowNumber: 3, fileName: 'b.pdf', title: 'Free' },
    ]);
    const client = {
      searchByTitle: async (_c: string, title: string) =>
        title === 'Taken' ? [{ uuid: 'i1', version: 1, name: 'Taken', attachmentNames: ['a.pdf'] }] : [],
    };
    const found = await findDuplicates(client, manifest);
    expect(found).toHaveLength(1);
    expect(found[0]?.rowNumber).toBe(2);
    expect(found[0]?.tier).toBe('near-certain');
  });

  /**
   * A failed check must never look like a clean one. This is the whole
   * difference between a check that helps and a check that misleads.
   */
  it('reports a failed request as could-not-check, not as clean', async () => {
    const manifest = manifestOf([{ rowNumber: 2, fileName: 'a.pdf', title: 'Taken' }]);
    const client = {
      searchByTitle: async () => {
        throw new Error('the server said 400');
      },
    };
    const found = await findDuplicates(client, manifest);
    expect(found[0]?.tier).toBe('could-not-check');
    expect(found[0]?.detail).toContain('the server said 400');
  });

  it('keeps checking the other rows after one fails', async () => {
    const manifest = manifestOf([
      { rowNumber: 2, fileName: 'a.pdf', title: 'Boom' },
      { rowNumber: 3, fileName: 'b.pdf', title: 'Taken' },
    ]);
    const client = {
      searchByTitle: async (_c: string, title: string) => {
        if (title === 'Boom') throw new Error('nope');
        return [{ uuid: 'i1', version: 1, name: 'Taken', attachmentNames: ['b.pdf'] }];
      },
    };
    const found = await findDuplicates(client, manifest);
    expect(found.map((f) => f.tier).sort()).toEqual(['could-not-check', 'near-certain']);
  });

  it('says nothing at all when no row is flagged', async () => {
    const manifest = manifestOf([{ rowNumber: 2, fileName: 'a.pdf', title: 'Free' }]);
    const client = { searchByTitle: async () => [] };
    expect(await findDuplicates(client, manifest)).toEqual([]);
  });

  // An entry already marked skipped or created by an earlier run is not
  // going to be uploaded, so checking it would waste a request and report a
  // duplicate the operator can do nothing about.
  it('skips entries that are not pending', async () => {
    const manifest = manifestOf([{ rowNumber: 2, fileName: 'a.pdf', title: 'Taken' }]);
    manifest.entries[0]!.status = 'created';
    let calls = 0;
    const client = {
      searchByTitle: async () => {
        calls++;
        return [];
      },
    };
    await findDuplicates(client, manifest);
    expect(calls).toBe(0);
  });

  it('asks the collection named in the manifest, not some other one', async () => {
    const manifest = manifestOf([{ rowNumber: 2, fileName: 'a.pdf', title: 'T' }]);
    const seen: string[] = [];
    const client = {
      searchByTitle: async (collection: string) => {
        seen.push(collection);
        return [];
      },
    };
    await findDuplicates(client, manifest);
    expect(seen).toEqual(['c1']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/duplicates.test.ts -t findDuplicates`
Expected: FAIL — `findDuplicates is not exported`.

- [ ] **Step 3: Implement**

Append to `src/core/duplicates.ts`:

```typescript
import type { Manifest } from './types.js';

/**
 * Just the part of OeqClient this needs. Narrower than the class on purpose:
 * the rules above are testable without a server, and so is this.
 */
export interface TitleSearcher {
  searchByTitle(collectionUuid: string, title: string): Promise<SearchHit[]>;
}

/** How many checks are in flight at once. Enough to be quick, few enough to be polite. */
const CONCURRENCY = 5;

/**
 * Check every pending row against the collection.
 *
 * A failure for one row becomes its own `could-not-check` finding rather than
 * aborting the batch -- an unreachable server says nothing about whether a
 * title exists, and it must not block a plan that is otherwise ready. It must
 * equally never be reported as clean, which is why it produces a finding at
 * all rather than being swallowed.
 */
export async function findDuplicates(
  client: TitleSearcher,
  manifest: Manifest,
): Promise<DuplicateFinding[]> {
  const pending = manifest.entries.filter((e) => e.status === 'pending');
  const findings: DuplicateFinding[] = [];

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (entry) => {
        const title = entry.metadata['MWDL/title']?.[0] ?? '';
        try {
          const hits = title.trim() === '' ? [] : await client.searchByTitle(manifest.collectionUuid, title);
          const verdict = verdictFor(entry.fileName, title, hits);
          return verdict ? { ...verdict, rowNumber: entry.rowNumber } : null;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          return {
            rowNumber: entry.rowNumber,
            fileName: entry.fileName,
            tier: 'could-not-check' as const,
            detail: `could not check whether this already exists (${detail})`,
            existing: [],
          };
        }
      }),
    );
    for (const r of results) if (r) findings.push(r);
  }

  return findings;
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/duplicates.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/duplicates.ts tests/duplicates.test.ts
git commit -m "feat(core): check every pending row for duplicates"
```

---

## Task 7: Marking a row skipped

**Files:**
- Modify: `src/core/plan.ts`
- Test: `tests/plan.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/plan.test.ts` (reuse the file's existing manifest-building helper if it has one; otherwise build one inline as in Task 6):

```typescript
describe('markSkipped', () => {
  function twoRowManifest(): Manifest {
    return {
      version: 1,
      createdAt: '2026-08-06T00:00:00.000Z',
      baseUrl: 'https://example.test',
      collectionUuid: 'c1',
      schemaUuid: 's1',
      itemState: 'draft',
      attachmentColumn: 'attachment name',
      warnings: [],
      entries: [2, 3].map((rowNumber) => ({
        rowNumber,
        filePath: `/f/${rowNumber}.pdf`,
        fileName: `${rowNumber}.pdf`,
        metadata: {},
        status: 'pending' as const,
        attempts: 0,
      })),
    };
  }

  it('marks only the named rows', () => {
    const m = twoRowManifest();
    markSkipped(m, [2], 'a duplicate');
    expect(m.entries[0]?.status).toBe('skipped');
    expect(m.entries[1]?.status).toBe('pending');
  });

  it('records why, so Results is not a mystery', () => {
    const m = twoRowManifest();
    markSkipped(m, [2], 'skipped as a duplicate of an existing item');
    expect(m.entries[0]?.error).toBe('skipped as a duplicate of an existing item');
  });

  it('returns how many it marked', () => {
    expect(markSkipped(twoRowManifest(), [2, 3], 'x')).toBe(2);
  });

  it('ignores a row number that is not in the manifest', () => {
    expect(markSkipped(twoRowManifest(), [99], 'x')).toBe(0);
  });

  // A row already created must not be rewritten to skipped: that would lose
  // the record that an item exists for it.
  it('never touches a row that is not pending', () => {
    const m = twoRowManifest();
    m.entries[0]!.status = 'created';
    expect(markSkipped(m, [2], 'x')).toBe(0);
    expect(m.entries[0]?.status).toBe('created');
  });
});
```

Add `markSkipped` to the existing import from `../src/core/plan.js`, and `Manifest` to the type imports.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/plan.test.ts -t markSkipped`
Expected: FAIL — `markSkipped is not a function`.

- [ ] **Step 3: Implement**

Append to `src/core/plan.ts`:

```typescript
/**
 * Mark rows as skipped, with a reason, before the run starts.
 *
 * Needs no runner change: `skipped` is already in the runner's
 * TERMINAL_STATUSES, so it steps over these rows and counts them into its
 * `skipped` total exactly as it does for rows a previous run completed.
 *
 * Only `pending` rows are touched. Rewriting an already-`created` row to
 * skipped would erase the record that an item exists for it.
 */
export function markSkipped(
  manifest: Manifest,
  rowNumbers: readonly number[],
  reason: string,
): number {
  const wanted = new Set(rowNumbers);
  let marked = 0;
  for (const entry of manifest.entries) {
    if (!wanted.has(entry.rowNumber) || entry.status !== 'pending') continue;
    entry.status = 'skipped';
    entry.error = reason;
    marked++;
  }
  return marked;
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/plan.ts tests/plan.test.ts
git commit -m "feat(core): mark rows skipped before a run"
```

---

## Task 8: The CLI

**Files:**
- Modify: `src/cli/index.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/cli.test.ts`, following that file's existing pattern for invoking `plan` against the mock server:

The entry point is **`planAction(options, env)`**, exported from `src/cli/index.ts` and already imported at the top of `tests/cli.test.ts`. It takes an options object (`sheet`, `files`, `manifest`, `schemaFile`, `state`, …) and an `env` object — the mock server's URL and credentials go in `env`, following the `mockEnv()` pattern in `tests/mcp.test.ts`.

Write a spreadsheet whose title column holds a known value and whose `attachment name` column holds a file you create on disk, then:

```typescript
describe('plan and duplicates', () => {
  // Build the sheet/dir/env the same way the existing planAction tests in
  // this file do; only the assertions below are new.

  it('skips a near-certain duplicate by default and says so', async () => {
    mock.state.existingItems = [
      { uuid: 'i1', version: 1, title: 'Recital', attachmentNames: ['a.mp4'] },
    ];
    await planAction({ ...opts, manifest: manifestPath }, mockEnv());
    const manifest = await loadManifest(manifestPath);
    expect(manifest.entries.find((e) => e.fileName === 'a.mp4')?.status).toBe('skipped');
  });

  it('uploads them anyway with --upload-duplicates', async () => {
    mock.state.existingItems = [
      { uuid: 'i1', version: 1, title: 'Recital', attachmentNames: ['a.mp4'] },
    ];
    await planAction({ ...opts, manifest: manifestPath, uploadDuplicates: true }, mockEnv());
    const manifest = await loadManifest(manifestPath);
    expect(manifest.entries.find((e) => e.fileName === 'a.mp4')?.status).toBe('pending');
  });

  it('does not skip a merely possible duplicate', async () => {
    mock.state.existingItems = [
      { uuid: 'i1', version: 1, title: 'Recital', attachmentNames: ['something-else.mp4'] },
    ];
    await planAction({ ...opts, manifest: manifestPath }, mockEnv());
    const manifest = await loadManifest(manifestPath);
    expect(manifest.entries.find((e) => e.fileName === 'a.mp4')?.status).toBe('pending');
  });

  it('checks nothing at all with --skip-duplicate-check', async () => {
    mock.state.existingItems = [
      { uuid: 'i1', version: 1, title: 'Recital', attachmentNames: ['a.mp4'] },
    ];
    await planAction({ ...opts, manifest: manifestPath, skipDuplicateCheck: true }, mockEnv());
    const manifest = await loadManifest(manifestPath);
    expect(manifest.entries.find((e) => e.fileName === 'a.mp4')?.status).toBe('pending');
  });
});
```

`loadManifest` is already imported at the top of `tests/cli.test.ts`. `opts` stands for the options object the surrounding tests build — reuse theirs rather than inventing one, and make the title in the fixture sheet match `'Recital'` above.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/cli.test.ts -t "plan and duplicates"`
Expected: FAIL — the entry is `pending`, not `skipped`.

- [ ] **Step 3: Implement**

In `src/cli/index.ts`, add to the options interface beside `skipDuplicateCheck`:

```typescript
  uploadDuplicates?: boolean;
```

Add the flag to the `plan` command, beside `--skip-duplicate-check`:

```typescript
    .option('--upload-duplicates', 'upload rows that look like duplicates instead of skipping them')
```

Replace the existing duplicate block (around line 67) with:

```typescript
  if (!o.skipDuplicateCheck) {
    // Unchanged: still checks MWDL/identifier for spreadsheets that carry one.
    const dupWarnings = await preflightDuplicates(client, manifest);
    manifest.warnings.push(...dupWarnings);

    const findings = await findDuplicates(client, manifest);
    for (const f of findings) {
      log(`  Row ${f.rowNumber}: ${f.fileName} -- ${f.tier}: ${f.detail}`);
    }

    // Only near-certain rows are skipped without being asked. A title match
    // alone is ordinary -- two students can share a recital name -- and
    // dropping those silently would lose real items.
    const toSkip = o.uploadDuplicates
      ? []
      : findings.filter((f) => defaultChoice(f.tier) === 'skip').map((f) => f.rowNumber);
    const marked = markSkipped(manifest, toSkip, 'skipped as a duplicate of an existing item');
    if (marked > 0) {
      log(`  ${marked} row(s) skipped as duplicates; use --upload-duplicates to upload them anyway.`);
    }
  }
```

Add to the imports at the top of the file:

```typescript
import { buildManifest, preflightDuplicates, markSkipped } from '../core/plan.js';
import { findDuplicates, defaultChoice } from '../core/duplicates.js';
```

(The first line replaces the existing `plan.js` import.)

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts tests/cli.test.ts
git commit -m "feat(cli): skip near-certain duplicates, with an override"
```

---

## Task 9: The IPC contract

**Files:**
- Modify: `src/desktop/ipc.ts`, `src/desktop/preload.cts`
- Test: `tests/desktop/preload-channels.test.ts` (already exists; it must keep passing)

- [ ] **Step 1: Extend the contract**

In `src/desktop/ipc.ts`, add to the imports:

```typescript
import type { DuplicateFinding } from '../core/duplicates.js';
```

Add to `PlanReport`:

```typescript
  /** Rows that look like they have been uploaded before. Empty if none. */
  duplicates: DuplicateFinding[];
```

Add to `OeqApi`, beside `plan`:

```typescript
  /**
   * Mark rows as skipped in an already-planned manifest, just before running.
   * Returns how many were marked. Separate from `plan` because the operator
   * makes these choices AFTER seeing the plan.
   */
  applyDuplicateChoices(args: { manifestPath: string; skipRows: number[] }): Promise<number>;
```

Add to `CHANNELS`:

```typescript
  applyDuplicateChoices: 'oeq:applyDuplicateChoices',
```

- [ ] **Step 2: Mirror it in the preload**

In `src/desktop/preload.cts`, add the same entry to its copy of `CHANNELS`, and expose the method alongside `plan`:

```typescript
  applyDuplicateChoices: (args: { manifestPath: string; skipRows: number[] }) =>
    ipcRenderer.invoke(CHANNELS.applyDuplicateChoices, args),
```

- [ ] **Step 3: Run the drift test**

Run: `npx vitest run tests/desktop/preload-channels.test.ts`
Expected: PASS. If it fails, the two `CHANNELS` copies disagree — that is exactly what this test is for.

- [ ] **Step 4: Commit**

```bash
git add src/desktop/ipc.ts src/desktop/preload.cts
git commit -m "feat(desktop): IPC contract for duplicate findings and choices"
```

---

## Task 10: The desktop handlers

**Files:**
- Modify: `src/desktop/handlers.ts`
- Test: `tests/desktop/handlers.test.ts`

- [ ] **Step 1: Understand what is testable here first**

**`tests/desktop/handlers.test.ts` does not register IPC handlers.** It only tests the pure exports of that module — `applyOverrides`, `reportColumns`, `resolveSchemaPath`, `missingCredentialsMessage`. There is no mock server and no `planArgs` in it.

There *is* a working pattern for registering handlers, in `tests/desktop/extractHandlers.test.ts`: a `fakeIpcMain()` that records handlers into a `Map` and a `call(channel, ...args)` that invokes them. Read it before writing anything here.

`registerHandlers` in `handlers.ts` needs more setup than `registerExtractHandlers` does — it reaches for stored settings and a session. Spend no more than a short while wiring it. **If it needs more scaffolding than the test is worth, stop and do this instead:** test `applyDuplicateChoices`'s logic through `markSkipped` (already covered by Task 7) and leave the desktop plan path to the end-to-end check in Task 15. Say clearly in your commit message which of the two you did.

- [ ] **Step 2: Write the failing test (the fakeIpcMain route)**

```typescript
describe('applyDuplicateChoices', () => {
  it('marks the chosen rows skipped in the saved manifest', async () => {
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, handlerOptions);
    const manifestPath = join(await mkdtemp(join(tmpdir(), 'oeq-dup-')), 'job.json');
    await saveManifest(manifestPath, manifestWithRows([2, 3]));

    const marked = await ipc.call<number>('oeq:applyDuplicateChoices', {
      manifestPath,
      skipRows: [2],
    });

    expect(marked).toBe(1);
    const manifest = await loadManifest(manifestPath);
    expect(manifest.entries.find((e) => e.rowNumber === 2)?.status).toBe('skipped');
    expect(manifest.entries.find((e) => e.rowNumber === 3)?.status).toBe('pending');
  });

  it('marks nothing when the operator chose to skip nothing', async () => {
    const ipc = fakeIpcMain();
    registerHandlers(ipc as never, handlerOptions);
    const manifestPath = join(await mkdtemp(join(tmpdir(), 'oeq-dup-')), 'job.json');
    await saveManifest(manifestPath, manifestWithRows([2]));

    expect(await ipc.call<number>('oeq:applyDuplicateChoices', { manifestPath, skipRows: [] })).toBe(0);
  });
});
```

`manifestWithRows` is the same tiny builder as in Task 7's test — copy it rather than importing across test files. `handlerOptions` is whatever `registerHandlers` requires; read its signature.

This route needs no mock server at all, because `applyDuplicateChoices` never touches the network. That is the point of putting it in its own channel.

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/desktop/handlers.test.ts -t applyDuplicateChoices`
Expected: FAIL — no handler registered for `oeq:applyDuplicateChoices`.

- [ ] **Step 3: Implement**

In `src/desktop/handlers.ts`, extend the imports:

```typescript
import { buildManifest, preflightDuplicates, markSkipped } from '../core/plan.js';
import { findDuplicates } from '../core/duplicates.js';
```

In the `plan` handler, after the existing `preflightDuplicates` line:

```typescript
      const duplicates = await findDuplicates(client, manifest);
```

Add `duplicates` to the object the handler returns, beside `warnings`.

Then register the new handler beside the others:

```typescript
  ipcMain.handle(
    CHANNELS.applyDuplicateChoices,
    async (_e, args: { manifestPath: string; skipRows: number[] }): Promise<number> => {
      // Applied to the SAVED manifest just before the run, because the
      // operator makes these choices after seeing the plan. Re-planning
      // instead would re-query every row for no benefit.
      const manifest = await loadManifest(args.manifestPath);
      const marked = markSkipped(
        manifest,
        args.skipRows,
        'skipped as a duplicate of an existing item',
      );
      await saveManifest(args.manifestPath, manifest);
      return marked;
    },
  );
```

`loadManifest` and `saveManifest` are already imported in this file; check the import line and add whichever is missing.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/desktop/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/desktop/handlers.ts tests/desktop/handlers.test.ts
git commit -m "feat(desktop): find duplicates at plan time, apply skips before running"
```

---

## Task 11: The Review screen

**Files:**
- Modify: `src/desktop/ui/batch.ts`, `src/desktop/ui/screens/review.ts`, `src/desktop/ui/app.ts`
- Test: `tests/desktop/ui/batch.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/desktop/ui/batch.test.ts`:

```typescript
describe('clearedForNextBatch and duplicates', () => {
  it('forgets the findings from the last batch', () => {
    expect(clearedForNextBatch().duplicates).toEqual([]);
  });

  it('forgets the operator choices from the last batch', () => {
    expect(clearedForNextBatch().duplicateChoices).toEqual({});
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/desktop/ui/batch.test.ts`
Expected: FAIL — `duplicates` is undefined on the returned object.

- [ ] **Step 3: Add the batch state**

In `src/desktop/ui/batch.ts`, add to the imports:

```typescript
import type { DuplicateChoice, DuplicateFinding } from '../../core/duplicates.js';
```

Add to `BatchState`, in the review group:

```typescript
  duplicates: DuplicateFinding[];
  /** Row number -> what the operator decided. Absent means the tier default. */
  duplicateChoices: Record<number, DuplicateChoice>;
```

And to the object `clearedForNextBatch` returns:

```typescript
    duplicates: [],
    duplicateChoices: {},
```

`AppState extends BatchState`, so `initialState()` in `app.ts` will now fail to compile until it supplies both. Add the same two lines to it. That failure is the guard working.

- [ ] **Step 4: Render them**

In `src/desktop/ui/screens/review.ts`, add to the props interface:

```typescript
  duplicates: DuplicateFinding[];
  duplicateChoices: Record<number, DuplicateChoice>;
  onDuplicateChoice(rowNumber: number, choice: DuplicateChoice): void;
```

Add this section to the rendered HTML, above the Continue button:

```typescript
  const TIER_LABEL: Record<DuplicateTier, string> = {
    'near-certain': 'Almost certainly already uploaded',
    possible: 'Possibly already uploaded',
    'not-checkable': 'Could not be checked',
    'could-not-check': 'Could not be checked',
  };

  const duplicateRows = props.duplicates
    .map((d) => {
      const choice = props.duplicateChoices[d.rowNumber] ?? defaultChoice(d.tier);
      return `
      <tr>
        <td>${d.rowNumber}</td>
        <td>${escapeHtml(d.fileName)}</td>
        <td>${escapeHtml(TIER_LABEL[d.tier])}<br><small>${escapeHtml(d.detail)}</small></td>
        <td>
          <label><input type="radio" name="dup-${d.rowNumber}" value="skip"
            ${choice === 'skip' ? 'checked' : ''}> Skip</label>
          <label><input type="radio" name="dup-${d.rowNumber}" value="upload"
            ${choice === 'upload' ? 'checked' : ''}> Upload anyway</label>
        </td>
      </tr>`;
    })
    .join('');

  const duplicatesSection =
    props.duplicates.length > 0
      ? `
      <fieldset>
        <legend>Possible duplicates (${props.duplicates.length})</legend>
        <p class="hint">
          Rows that look like they have been uploaded to this collection before.
          Only the almost-certain ones are set to skip; check the rest yourself.
        </p>
        <table class="review-table">
          <thead><tr><th>Row</th><th>File</th><th>Why</th><th>What to do</th></tr></thead>
          <tbody>${duplicateRows}</tbody>
        </table>
      </fieldset>`
      : '';
```

Insert `${duplicatesSection}` into the template, and wire the radios after `innerHTML` is set:

```typescript
  root.querySelectorAll<HTMLInputElement>('input[name^="dup-"]').forEach((input) => {
    input.addEventListener('change', () => {
      const rowNumber = Number(input.name.slice('dup-'.length));
      props.onDuplicateChoice(rowNumber, input.value as DuplicateChoice);
    });
  });
```

Import `defaultChoice` and the types from `../../../core/duplicates.js`. That module imports only types from `client.js` and `types.js`, so it is renderer-safe — `tests/desktop/rendererPurity.test.ts` will confirm it.

- [ ] **Step 5: Wire it in app.ts**

Pass the three new props in the `review` case of `render()`:

```typescript
        duplicates: state.duplicates,
        duplicateChoices: state.duplicateChoices,
        onDuplicateChoice: (rowNumber, choice) => {
          state.duplicateChoices[rowNumber] = choice;
          render();
        },
```

Store the findings where the plan report is handled:

```typescript
    state.duplicates = report.duplicates;
```

And apply the choices immediately before the run starts, in the handler that calls `window.oeq.run`:

```typescript
    // Applied here, not at plan time: these are the operator's choices, made
    // after seeing the plan. A row left at its tier default is included too.
    const skipRows = state.duplicates
      .filter((d) => (state.duplicateChoices[d.rowNumber] ?? defaultChoice(d.tier)) === 'skip')
      .map((d) => d.rowNumber);
    if (skipRows.length > 0) {
      await window.oeq.applyDuplicateChoices({ manifestPath, skipRows });
    }
```

- [ ] **Step 6: Run the suite and the purity test**

Run: `npm run typecheck && npx vitest run`
Expected: PASS, including `tests/desktop/rendererPurity.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/desktop/ui tests/desktop/ui
git commit -m "feat(desktop): review duplicates and choose what to skip"
```

---

## Task 12: The Results label

**Files:**
- Modify: `src/desktop/ui/screens/results.ts`

- [ ] **Step 1: Widen it**

The Results screen says `Skipped (already done)`. That count now also means "skipped as a duplicate", so the parenthetical is wrong. Change the line in the summary list to:

```typescript
        <dt>Skipped</dt><dd>${r.skipped}</dd>
```

- [ ] **Step 2: Run the suite**

Run: `npx vitest run tests/desktop`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/desktop/ui/screens/results.ts
git commit -m "fix(desktop): Skipped no longer claims every skip was already done"
```

---

## Task 13: MCP

**Files:**
- Modify: `src/mcp/index.ts`
- Test: `tests/mcp.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/mcp.test.ts`. The entry point is `planTool(args, env)`, already imported at the top of that file; `mockEnv()` and `writeIdentifierSheet(dir)` are the helpers its existing duplicate-pre-flight tests use. Give the sheet a title matching the one below.

```typescript
it('reports duplicate findings from the plan tool', async () => {
  mock.state.existingItems = [
    { uuid: 'i1', version: 1, title: 'Row Two', attachmentNames: ['a.mp4'] },
  ];
  const result = await planTool({ sheet: sheetPath, filesDir: dir, manifestPath }, mockEnv());
  expect(JSON.stringify(result)).toContain('near-certain');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/mcp.test.ts -t "duplicate findings"`
Expected: FAIL — the response contains no such string.

- [ ] **Step 3: Implement**

In `src/mcp/index.ts`, extend the import and, beside the existing `preflightDuplicates` call (around line 264), add:

```typescript
          const duplicates = await findDuplicates(client, manifest);
```

Include `duplicates` in the tool's response object. **Do not act on them here.** The MCP layer plans, validates and monitors; deciding what to skip belongs to whoever is uploading — the same rule that keeps file bytes out of this layer.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/index.ts tests/mcp.test.ts
git commit -m "feat(mcp): report duplicate findings from the plan tool"
```

---

## Task 14: Documentation

**Files:**
- Modify: `README.md`, `docs/SESSION-HANDOFF.md`, `CLAUDE.md`

- [ ] **Step 1: README**

Add a section after "Where a description comes from":

````markdown
### The duplicate check

Before a plan is confirmed, every row is checked against the target collection:

```http
GET /api/search?collections=<uuid>&where=/xml/MWDL/title = '<title>'
   &info=attachment&showall=true
```

| What was found | Verdict | Default |
| --- | --- | --- |
| an existing item with the same title **and** the same filename | almost certainly a duplicate | **skip** |
| an existing item with the same title, different file | possibly a duplicate | upload |
| the row has no title | could not be checked | upload |
| the request failed | could not be checked | upload |

Only the first defaults to skipping. Two items can legitimately share a title,
and silently dropping a real item is worse than a visible duplicate.

A skipped row is written into the manifest as `skipped` and counted on the
Results screen. On the CLI, `--upload-duplicates` uploads them anyway and
`--skip-duplicate-check` does not check at all.

**Limitation:** a re-upload whose title was changed will not be caught.
````

- [ ] **Step 2: Handoff**

Add to `docs/SESSION-HANDOFF.md`, in the same style as the existing sections: what the check does, that `where` was confirmed by `scripts/probe-where.mts` against the test instance on the date it was run, and what the probe found for the attachment filename key. Update the test count at the top of the file to whatever `npx vitest run` now reports.

- [ ] **Step 3: CLAUDE.md**

Add one line to the "Key domain facts" list:

```markdown
- **The duplicate check matches `/xml/MWDL/title` exactly** via the search API's
  `where` clause, not free-text `q`. `q`'s matching semantics are unconfirmed and
  would produce false alarms. `showall=true` is mandatory or it cannot see this
  tool's own drafts.
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/SESSION-HANDOFF.md CLAUDE.md
git commit -m "docs: the duplicate check"
```

---

## Task 15: End to end, against the operator's own files

**Files:** none

- [ ] **Step 1: Plan the same batch twice**

With the operator's credentials against the **test** instance, run a small batch of real files through `plan` and `run`. Then, without changing anything, run `plan` again over the same spreadsheet and folder.

- [ ] **Step 2: Check what the second plan says**

Every row should come back `near-certain`, and every row should be marked `skipped` in the manifest. Run it and confirm the Results screen reports them all as skipped and creates nothing.

- [ ] **Step 3: Check the GUI path too**

Do the same through the desktop app: the Review screen should list every row under "Possible duplicates", all set to Skip, and Confirm should proceed to a run that creates nothing.

- [ ] **Step 4: Record the result in the handoff**

This is the test that matters. Every serious fault in this project has been found at a boundary the unit tests do not cross, and this exercises the whole of it.

---

## Self-review notes

Checked against the spec:

| Spec section | Task |
| --- | --- |
| The fault (identifier check is a no-op) | 8 — `preflightDuplicates` kept, new check added beside it |
| Two tiers | 5 |
| The query, `where` / `info=attachment` / `showall` | 4, with the mock modelling it in 3 |
| Verdicts, including not-checkable and could-not-check | 5, 6 |
| When it runs | 8, 10 |
| Identifier check stays | 8 |
| Operator choice, tier defaults | 5 (`defaultChoice`), 11 (UI) |
| Skip via manifest status | 7, 10 |
| Results label | 12 |
| CLI, desktop, MCP | 8, 10–11, 13 |
| The unverified `where` clause, probe first | 1 |
| Escaping | 2 |
| Performance / concurrency | 6 |
| Testing, including the live probe | throughout, 15 |
| Out of scope | nothing built for overwrite, delete, or cleanup |
