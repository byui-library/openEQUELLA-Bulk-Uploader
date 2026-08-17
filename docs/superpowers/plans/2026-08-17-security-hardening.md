# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two exploitable findings from the 2026-08-17 security review — spreadsheet formula injection and the missing OAuth `state` — and write the adopter-facing security documentation a public repository needs.

**Architecture:** Formula neutralisation is a **symmetric pair of pure functions in one module**, so the writer and the reader cannot drift apart; a guarded value must survive the extract → Excel → `plan` round trip byte-for-byte, because this tool's spreadsheets are re-read by the uploader and a one-sided escape would corrupt uploaded metadata. OAuth `state` is generated where the authorize URL is built and verified at each of the two places a code is captured; the manual-paste flow cannot verify it and says so rather than pretending to.

**Tech Stack:** TypeScript on Node, vitest, ExcelJS (CSV writing), csv-parse (CSV reading), Electron (desktop sign-in), `node:crypto`.

---

## Scope

**In:** formula injection, OAuth `state`, `SECURITY.md`.

**Deliberately out, and why:**

- **The `m.miles` scrub** (48 occurrences across 5 test files and 2 docs). `CLAUDE.md` records a decision that it is done and reviewed as a change of its own and kept off the language-model branch. Folding it in here would break that on both counts. Do it on its own branch off `main`.
- **The dependency advisories.** Analysed in the review and found not to apply — `fast-xml-parser`'s advisory is against `XMLBuilder` and only `XMLParser` is used; the `uuid` advisory needs a `buf` argument nothing passes. Both fixes are breaking major bumps, one of them to `exceljs`, which writes the spreadsheet. The analysis is recorded in Task 6 so nobody force-upgrades on a red audit line.
- **The password in openEQUELLA's login query string.** Not fixable from here; documented in Task 6.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/core/formulaGuard.ts` | **New.** The symmetric pair: `guardFormula` / `unguardFormula`. Pure, no imports. Owns the trigger set both halves read. |
| `src/core/extract/csv.ts` | Modified. Guards every cell value on the way out. |
| `src/core/sheet.ts` | Modified. Unguards every cell value on the way in, for `.csv` and `.xlsx` alike. |
| `src/core/authCode.ts` | Modified. Generates `state`, sends it, and answers `checkState`. |
| `src/desktop/signin.ts` | Modified. Refuses a code whose `state` does not match. |
| `src/cli/index.ts` | Modified. Loopback capture returns the `state` too, and login verifies it. |
| `SECURITY.md` | **New.** What an adopting institution needs to know, and how to report a vulnerability. |

---

## Task 1: The formula guard, as a symmetric pair

**Files:**
- Create: `src/core/formulaGuard.ts`
- Test: `tests/formulaGuard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/formulaGuard.test.ts`:

```typescript
// tests/formulaGuard.test.ts
import { describe, it, expect } from 'vitest';
import { guardFormula, unguardFormula } from '../src/core/formulaGuard.js';

/**
 * ## Why a pair, and why the round trip is the real test
 *
 * The extractor writes a spreadsheet the operator opens in Excel, and `plan`
 * reads that same spreadsheet back and uploads what it finds. So an escape
 * applied on the way out MUST be removed on the way in: a one-sided guard
 * would put a stray apostrophe into a permanent catalogue record, which is a
 * worse outcome than the injection it prevents.
 */
describe('guardFormula', () => {
  it.each(['=SUM(A1)', '+1+1', '-2+3', '@SUM(A1)', '\tx', '\rx'])(
    'prefixes a value Excel would execute: %j',
    (value) => {
      expect(guardFormula(value)).toBe(`'${value}`);
    },
  );

  it('leaves ordinary text alone', () => {
    expect(guardFormula('Died 2024-01-09; Born 1935-04-03')).toBe('Died 2024-01-09; Born 1935-04-03');
    expect(guardFormula('')).toBe('');
    expect(guardFormula('Fennel, Marcus')).toBe('Fennel, Marcus');
  });

  /**
   * A value that already starts with an apostrophe has to be escaped too, or
   * the reader cannot tell the guard it added from an apostrophe the document
   * really began with, and would strip a character that was always data.
   */
  it('escapes a leading apostrophe so the reader can tell them apart', () => {
    expect(guardFormula("'=SUM(A1)")).toBe("''=SUM(A1)");
    expect(guardFormula("'quoted'")).toBe("''quoted'");
  });
});

describe('unguardFormula', () => {
  it('removes exactly one guarding apostrophe', () => {
    expect(unguardFormula("'=SUM(A1)")).toBe('=SUM(A1)');
    expect(unguardFormula("''=SUM(A1)")).toBe("'=SUM(A1)");
  });

  it('leaves an apostrophe that is not a guard alone', () => {
    expect(unguardFormula("'tis the season")).toBe("'tis the season");
    expect(unguardFormula('ordinary')).toBe('ordinary');
    expect(unguardFormula('')).toBe('');
  });
});

describe('the round trip', () => {
  // Every shape the two functions distinguish, including the ones that only
  // matter because Excel or a document produced them.
  const values = [
    '',
    'ordinary text',
    '=SUM(A1)',
    '+1+1',
    '-2+3',
    '@SUM(A1)',
    '\tx',
    '\rx',
    "'=SUM(A1)",
    "'tis the season",
    "''already doubled",
    '-- see attached',
    'Died 2024-01-09',
  ];

  it.each(values)('survives guard then unguard unchanged: %j', (value) => {
    expect(unguardFormula(guardFormula(value))).toBe(value);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/formulaGuard.test.ts`

Expected: FAIL — `Failed to resolve import "../src/core/formulaGuard.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/core/formulaGuard.ts`:

```typescript
// src/core/formulaGuard.ts

/**
 * Stopping a document's text from becoming a live formula in Excel, without
 * changing what the value IS.
 *
 * The extractor writes text it read out of PDFs and Word files into a
 * spreadsheet the operator opens in Excel. Excel does not treat a cell
 * beginning `=`, `+`, `-` or `@` as text -- it treats it as a formula and runs
 * it, and the DDE forms of that are a remote-code-execution vector. The
 * documents come from donors, families and other departments, are frequently
 * scanned, and nobody reads all of them first: they are the one input to this
 * tool that an outsider supplies.
 *
 * THE TWO HALVES MUST STAY SYMMETRIC, WHICH IS WHY THEY LIVE IN ONE MODULE.
 * `plan` reads the extractor's own spreadsheet back and uploads what it finds,
 * so an escape added on the way out and not removed on the way in would write
 * a stray apostrophe into a permanent catalogue record -- a data-integrity bug
 * introduced by a security fix, which is a bad trade. `unguardFormula(guardFormula(v))`
 * is `v` for every string, and `tests/formulaGuard.test.ts` pins that.
 *
 * The cost is visible and accepted: a description that genuinely starts with
 * `-` shows a leading apostrophe in Excel. It is removed again on upload.
 */

/**
 * The characters Excel reads as the start of a formula, plus the two control
 * characters it strips before deciding -- so `\t=cmd` is a formula too.
 */
const TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

/** The escape character. Excel's own convention for "this cell is text". */
const GUARD = "'";

/**
 * Make a value safe to write into a spreadsheet cell.
 *
 * A value already starting with the guard character is escaped as well. Without
 * that, `'=SUM(A1)` read back is indistinguishable from a guarded `=SUM(A1)`,
 * and the reader would strip an apostrophe that was always part of the data.
 */
export function guardFormula(value: string): string {
  const first = value[0];
  if (first === undefined) return value;
  if (first === GUARD || TRIGGERS.includes(first)) return GUARD + value;
  return value;
}

/** Undo exactly one `guardFormula`. Anything else is left as it is. */
export function unguardFormula(value: string): string {
  if (value[0] !== GUARD) return value;
  const second = value[1];
  if (second === undefined) return value;
  if (second === GUARD || TRIGGERS.includes(second)) return value.slice(1);
  return value;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/formulaGuard.test.ts`

Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/formulaGuard.ts tests/formulaGuard.test.ts
git commit -m "feat(security): a symmetric guard against spreadsheet formula injection"
```

---

## Task 2: Guard values as the spreadsheet is written

**Files:**
- Modify: `src/core/extract/csv.ts`
- Test: `tests/extract/csv.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/extract/csv.test.ts` (inside the existing top-level `describe`, or as a new one at the end of the file):

```typescript
describe('formula injection', () => {
  /**
   * The operator opens this file in Excel. A description OCR'd out of a
   * donated document is the one value in this tool that an outsider controls,
   * and `=`, `+`, `-` and `@` make Excel execute it rather than show it.
   */
  it('guards a cell a document made look like a formula', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-csv-'));
    const path = join(dir, 'out.csv');
    const profile: Profile = {
      version: 1,
      pattern: '{a}.pdf',
      columns: [
        { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
        { path: 'MWDL/description', sources: [] },
      ],
    };
    await writeCsv(path, profile, [
      {
        cells: { [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/description': '=HYPERLINK("http://x","click")' },
        sources: {},
        notes: [],
        flagged: {},
        aiWritten: {},
      },
    ]);

    const text = await readFile(path, 'utf8');
    expect(text).toContain("'=HYPERLINK");
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves an ordinary description untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-csv-'));
    const path = join(dir, 'out.csv');
    const profile: Profile = {
      version: 1,
      pattern: '{a}.pdf',
      columns: [
        { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
        { path: 'MWDL/description', sources: [] },
      ],
    };
    await writeCsv(path, profile, [
      {
        cells: { [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/description': 'Died 2024-01-09' },
        sources: {},
        notes: [],
        flagged: {},
        aiWritten: {},
      },
    ]);

    const text = await readFile(path, 'utf8');
    expect(text).toContain('Died 2024-01-09');
    expect(text).not.toContain("'Died");
    await rm(dir, { recursive: true, force: true });
  });
});
```

If `tests/extract/csv.test.ts` does not already import them, add at the top of the file:

```typescript
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTACHMENT_COLUMN, type Profile } from '../../src/core/extract/types.js';
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/extract/csv.test.ts`

Expected: FAIL on the first case — `expected '…' to contain "'=HYPERLINK"`. The second case passes already, which is correct: it exists to catch an over-broad guard.

- [ ] **Step 3: Write the implementation**

In `src/core/extract/csv.ts`, add the import below the existing ones:

```typescript
import { guardFormula } from '../formulaGuard.js';
```

Then replace the row-writing line:

```typescript
    sheet.addRow([...columns.map((c) => row.cells[c.path] ?? ''), sources, row.notes.join('; ')]);
```

with:

```typescript
    // Every value that came from a document, plus the two annotation columns,
    // which quote discarded model output and are just as attacker-influenced.
    // Headers are NOT guarded: they are schema xpaths, none of which can start
    // with a trigger, and guarding one would stop `plan` matching the column.
    sheet.addRow([
      ...columns.map((c) => guardFormula(row.cells[c.path] ?? '')),
      guardFormula(sources),
      guardFormula(row.notes.join('; ')),
    ]);
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/extract/csv.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/extract/csv.ts tests/extract/csv.test.ts
git commit -m "fix(security): stop a document writing a live formula into the spreadsheet"
```

---

## Task 3: Unguard values as the spreadsheet is read

**Files:**
- Modify: `src/core/sheet.ts:32-42`
- Test: `tests/sheet.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/sheet.test.ts` a new top-level block. Match the file's existing helper for writing a temporary CSV if it has one; if it does not, use this self-contained form:

```typescript
describe('a guarded value comes back as it went in', () => {
  /**
   * The extractor guards `=…` on the way out so Excel shows it instead of
   * running it. If this side did not undo that, the uploader would write an
   * apostrophe that was never in the document into a permanent record -- a
   * data-integrity bug caused by a security fix.
   */
  it('removes the guard the extractor added', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-sheet-'));
    const path = join(dir, 'in.csv');
    await writeFile(path, "MWDL/title,MWDL/description\nA title,'=SUM(A1)\n", 'utf8');

    const sheet = await readSheet(path);
    expect(sheet.rows[0]?.cells['MWDL/description']).toBe('=SUM(A1)');
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves an apostrophe that a person actually typed alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-sheet-'));
    const path = join(dir, 'in.csv');
    await writeFile(path, "MWDL/title,MWDL/description\nA title,'tis the season\n", 'utf8');

    const sheet = await readSheet(path);
    expect(sheet.rows[0]?.cells['MWDL/description']).toBe("'tis the season");
    await rm(dir, { recursive: true, force: true });
  });
});
```

Ensure the file imports what this needs:

```typescript
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/sheet.test.ts`

Expected: FAIL on the first case — `expected "'=SUM(A1)" to be "=SUM(A1)"`. The second passes already and guards against over-stripping.

- [ ] **Step 3: Write the implementation**

In `src/core/sheet.ts`, add to the imports:

```typescript
import { unguardFormula } from './formulaGuard.js';
```

Then change `toSheet` (currently at line 32) so the cell assignment reads:

```typescript
    headers.forEach((h, col) => {
      // Undoes `guardFormula` from the writing side. Applied here rather than
      // in `readCsv` so an .xlsx re-saved by Excel from a guarded .csv is
      // treated identically -- the guard is a property of the value, not of
      // the file format it arrived in.
      cells[h] = unguardFormula((values[col] ?? '').trim());
    });
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/sheet.test.ts tests/formulaGuard.test.ts tests/extract/csv.test.ts`

Expected: PASS in all three files.

- [ ] **Step 5: Prove the whole round trip, not just the two halves**

Add to `tests/extract/csv.test.ts`:

```typescript
it('survives extract -> read back, so the uploader gets the original text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-roundtrip-'));
  const path = join(dir, 'out.csv');
  const profile: Profile = {
    version: 1,
    pattern: '{a}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/description', sources: [] },
    ],
  };
  const original = '=HYPERLINK("http://x","click")';
  await writeCsv(path, profile, [
    {
      cells: { [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/description': original },
      sources: {},
      notes: [],
      flagged: {},
      aiWritten: {},
    },
  ]);

  const sheet = await readSheet(path);
  expect(sheet.rows[0]?.cells['MWDL/description']).toBe(original);
  await rm(dir, { recursive: true, force: true });
});
```

Add the import `import { readSheet } from '../../src/core/sheet.js';` to that file.

Run: `npx vitest run tests/extract/csv.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/sheet.ts tests/sheet.test.ts tests/extract/csv.test.ts
git commit -m "fix(security): undo the formula guard when the spreadsheet is read back"
```

---

## Task 4: Generate and send an OAuth `state`

**Files:**
- Modify: `src/core/authCode.ts:60-92`
- Test: `tests/authCode.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/authCode.test.ts`:

```typescript
describe('the state parameter', () => {
  const make = () =>
    new AuthorizationCodeAuth(
      'https://oeq.example.edu',
      'client',
      'secret',
      'https://oeq.example.edu',
      { load: async () => null, save: async () => {}, clear: async () => {} },
    );

  it('puts a state on the authorize URL', () => {
    const url = new URL(make().getAuthorizeUrl());
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('uses a different state each time, so one cannot be replayed', () => {
    expect(new URL(make().getAuthorizeUrl()).searchParams.get('state')).not.toBe(
      new URL(make().getAuthorizeUrl()).searchParams.get('state'),
    );
  });

  it('accepts the state it sent', () => {
    const auth = make();
    const sent = new URL(auth.getAuthorizeUrl()).searchParams.get('state');
    expect(auth.checkState(sent)).toBe(true);
  });

  it('rejects a different state, an absent one, and an empty one', () => {
    const auth = make();
    auth.getAuthorizeUrl();
    expect(auth.checkState('not-the-one')).toBe(false);
    expect(auth.checkState(null)).toBe(false);
    expect(auth.checkState('')).toBe(false);
  });

  /**
   * Nothing was ever sent, so nothing can match. Returning true here would
   * turn the check into one that reports success without having run --
   * the failure this codebase has now had twice.
   */
  it('rejects everything when no authorize URL was ever built', () => {
    expect(make().checkState('anything')).toBe(false);
    expect(make().checkState(null)).toBe(false);
  });
});
```

If the existing tests in this file construct `AuthorizationCodeAuth` with a different token-store stub, reuse that one instead of the inline object above.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/authCode.test.ts`

Expected: FAIL — `expected null to match /^[0-9a-f]{32}$/`, and `auth.checkState is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/core/authCode.ts`, add to the imports at the top of the file:

```typescript
import { randomBytes } from 'node:crypto';
```

Add a field beside the existing private fields in the class:

```typescript
  /** The `state` most recently sent. Null until an authorize URL is built. */
  private sentState: string | null = null;
```

Replace `getAuthorizeUrl()` with:

```typescript
  /** The URL the operator opens in a browser to authenticate via SSO.
   *  The ENDPOINT is resolved against the instance (prefix and all); the
   *  `redirect_uri` below is not -- it is sent verbatim, per the class doc. */
  getAuthorizeUrl(): string {
    const url = instanceEndpoint(this.baseUrl, '/oauth/authorise');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    // An unguessable value echoed back with the code, so a response this app
    // did not ask for can be told from one it did. Fresh per authorize URL:
    // a fixed value would be replayable once observed.
    this.sentState = randomBytes(16).toString('hex');
    url.searchParams.set('state', this.sentState);
    return url.toString();
  }

  /**
   * Does this response carry back the `state` we sent?
   *
   * FALSE UNTIL AN AUTHORIZE URL HAS BEEN BUILT, and false for an absent or
   * empty value. Nothing was sent, so nothing can match -- answering true for
   * the un-started case would make this a check that reports success without
   * having run, which is the exact defect this codebase has shipped twice.
   */
  checkState(received: string | null | undefined): boolean {
    return this.sentState !== null && received === this.sentState;
  }
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/authCode.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/authCode.ts tests/authCode.test.ts
git commit -m "feat(security): send an OAuth state parameter and remember it"
```

---

## Task 5: Verify the `state` where the code is captured

**Files:**
- Modify: `src/desktop/signin.ts:165-300`
- Modify: `src/cli/index.ts:410-520`
- Test: `tests/desktop/signin.test.ts` (create the block if the file exists; if it does not, create the file)

- [ ] **Step 1: Write the failing test**

The CLI's loopback flow is drivable end-to-end, so test it there for real. `openBrowser`
receives the authorize URL, which is how the stub learns the state a real browser would
have carried back — the test simulates the round trip rather than reaching inside the object.

Add to `tests/cli.test.ts`, inside the same `describe` that holds the existing
`loginAction` tests (it already has `mock`, `dir`, `env` and `captureLogs` in scope):

```typescript
describe('the loopback redirect must carry back our state', () => {
  /** A loopback redirect URI, so `loginAction` takes the capture branch
   *  rather than the manual-paste one. */
  const loopbackEnv = async () => ({
    ...env(),
    OEQ_REDIRECT_URI: `http://127.0.0.1:${await getFreePort()}/`,
  });

  /**
   * The loopback server answers an ordinary HTTP request on a local port. Any
   * other process on the machine -- or a web page the operator has open -- can
   * send one carrying an attacker's code. The state is what tells openEQUELLA's
   * redirect apart from theirs.
   */
  it('refuses a code that came back with the wrong state', async () => {
    mock.state.validAuthCodes.add('the-code');
    const store = new FileTokenStore(join(dir, 'token.json'));

    const err = await captureLogs(async () => {
      await loginAction(await loopbackEnv(), {
        tokenStore: store,
        openBrowser: () => {},
        captureLoopbackCode: async () => ({ code: 'the-code', state: 'attacker-chose-this' }),
      });
    }).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/did not come from the sign-in that was started here/i);
    // Nothing was exchanged, so nothing was cached.
    expect(await store.loadRaw()).toBeNull();
  });

  it('refuses a redirect that carried no state at all', async () => {
    mock.state.validAuthCodes.add('the-code');
    const store = new FileTokenStore(join(dir, 'token.json'));

    const err = await captureLogs(async () => {
      await loginAction(await loopbackEnv(), {
        tokenStore: store,
        openBrowser: () => {},
        captureLoopbackCode: async () => ({ code: 'the-code', state: null }),
      });
    }).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(await store.loadRaw()).toBeNull();
  });

  it('accepts the code when the state is the one it sent', async () => {
    mock.state.validAuthCodes.add('the-code');
    mock.state.currentUser = { username: 'jdoe', firstName: 'Jane', lastName: 'Doe' };
    const store = new FileTokenStore(join(dir, 'token.json'));

    // What a real browser does: carry back the state it was given.
    let sentState: string | null = null;
    await captureLogs(async () => {
      await loginAction(await loopbackEnv(), {
        tokenStore: store,
        openBrowser: (url) => {
          sentState = new URL(url).searchParams.get('state');
        },
        captureLoopbackCode: async () => ({ code: 'the-code', state: sentState }),
      });
    });

    expect(sentState).toMatch(/^[0-9a-f]{32}$/);
    expect(await store.loadRaw()).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/cli.test.ts`

Expected: FAIL. The first two cases fail because nothing refuses a bad state yet — the
login completes and caches a token. The third fails to type-check/run because
`captureLoopbackCode` still returns a bare string.

- [ ] **Step 3: Enforce it in the desktop sign-in window**

In `src/desktop/signin.ts`, inside `signInInteractive`, add a rejection channel beside the existing `closedPromise` and `timeoutPromise` declarations:

```typescript
  let rejectStateMismatch!: (err: Error) => void;
  const stateMismatchPromise = new Promise<never>((_resolve, reject) => {
    rejectStateMismatch = reject;
  });
```

Replace the body of `inspect` with:

```typescript
  const inspect = (url: string): void => {
    if (!armed || codeCaptured) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.origin !== origin) return;
    if (parsed.pathname.startsWith('/oauth/authorise')) return;
    const found = parsed.searchParams.get('code');
    if (!found) return;
    // The code is only ours if the state came back with it. Failing loudly
    // rather than ignoring it: a silently skipped code leaves the operator
    // staring at a window that never closes, for ten minutes.
    if (!auth.checkState(parsed.searchParams.get('state'))) {
      rejectStateMismatch(
        new OeqError(
          'Sign-in was refused: the response did not carry back the value this app sent, ' +
            'so it did not come from the sign-in that was started here. Try signing in again.',
        ),
      );
      return;
    }
    resolveCode(found);
  };
```

Add `stateMismatchPromise` to the race:

```typescript
    code = await Promise.race([
      resolveSignIn({
        code: codePromise,
        loadError: loadErrorPromise,
        graceMs: LOAD_ERROR_GRACE_MS,
        delay: (ms) => new Promise((r) => setTimeout(r, ms)),
      }).catch(async (err: unknown) => {
        throw await betterSignInError(win, origin, toError(err));
      }),
      closedPromise,
      timeoutPromise,
      stateMismatchPromise,
    ]);
```

`OeqError` is already imported in this file; if it is not, add `import { OeqError } from '../core/errors.js';`.

- [ ] **Step 4: Enforce it in the CLI's loopback capture**

In `src/cli/index.ts`, change the `LoginDeps` member (line 415):

```typescript
  /** Overridable for tests; see `defaultCaptureLoopbackCode` for the real implementation. */
  captureLoopbackCode?: (redirectUri: string) => Promise<{ code: string; state: string | null }>;
```

Change `defaultCaptureLoopbackCode`'s signature and its resolve call:

```typescript
function defaultCaptureLoopbackCode(redirectUri: string): Promise<{ code: string; state: string | null }> {
```

and wherever it currently calls `resolvePromise(code)`, change it to:

```typescript
      resolvePromise({ code, state: reqUrl.searchParams.get('state') });
```

Then in `loginAction`, replace the loopback branch:

```typescript
  let code: string;
  if (loopback) {
    console.log('Waiting for openEQUELLA to redirect back to this machine...');
    let captured: { code: string; state: string | null };
    try {
      captured = await (deps.captureLoopbackCode ?? defaultCaptureLoopbackCode)(cfg.redirectUri);
    } catch (err) {
      throw new OeqError(
        `Could not capture the code automatically at ${cfg.redirectUri}: ${errorMessage(err)}. Check ` +
          `that nothing else is using that port, or point OEQ_REDIRECT_URI at a non-loopback address ` +
          `to fall back to the manual-paste flow.`,
      );
    }
    // The loopback server answers an ordinary HTTP request on a local port,
    // which any other process or page on this machine can also send. The state
    // is what distinguishes openEQUELLA's redirect from one of those.
    if (!auth.checkState(captured.state)) {
      throw new OeqError(
        'The redirect did not carry back the value this command sent, so it did not come from the ' +
          'sign-in that was started here. Run `oeq-upload login` again.',
      );
    }
    code = captured.code;
    console.log('Code captured automatically from the local redirect.');
  } else {
    const raw = (await (deps.promptForCode ?? defaultPromptForCode)()).trim();
    if (!raw) {
      throw new OeqError('No code entered. Run `oeq-upload login` again when you have it.');
    }
    // NOT STATE-CHECKED, AND SAID RATHER THAN HIDDEN. This flow exists for a
    // redirect this machine cannot receive, so the operator pastes a code they
    // read off a page -- often without the state beside it. A check that
    // silently passed whenever the pasted text lacked a state would report
    // success without running. The loopback flow above is the checked one.
    code = extractCode(raw);
  }
```

- [ ] **Step 5: Verify nothing else broke**

Run: `npm run typecheck && npx vitest run tests/cli.test.ts tests/authCode.test.ts tests/desktop`

Expected: typecheck clean, all tests pass. If a test stubs `captureLoopbackCode`, update it to resolve `{ code: 'x', state: null }` **and** give that test an `auth` whose state check passes, or assert the new refusal — whichever the test is actually about.

- [ ] **Step 6: Commit**

```bash
git add src/desktop/signin.ts src/cli/index.ts tests/authCode.test.ts
git commit -m "fix(security): refuse an OAuth code that does not carry back our state"
```

---

## Task 6: Write `SECURITY.md`

**Files:**
- Create: `SECURITY.md`

- [ ] **Step 1: Write the file**

Create `SECURITY.md`:

```markdown
# Security

This tool uploads files and metadata to an openEQUELLA instance using
credentials an operator supplies. This page states what it does with those
credentials, what leaves the machine, and what an adopting institution should
check on their own site.

Last reviewed 2026-08-17.

## Reporting a vulnerability

Open a GitHub issue for anything already public. For anything not public,
use GitHub's **Report a vulnerability** button on the Security tab, which
opens a private advisory rather than a public issue.

## Your password is in the URL, and URLs get logged

openEQUELLA's sign-in API is `POST /api/auth/login?username=…&password=…`.
Both are query-string parameters; the API offers no request-body form. That is
openEQUELLA's design and this tool cannot change it.

- **In transit it is protected.** HTTPS is required before any request is
  built, and plain `http` is refused outright — including to `localhost` —
  precisely because the password rides in the URL.
- **At rest on the server it may not be.** Web servers, reverse proxies and
  load balancers routinely log the full request line. An AWS load balancer's
  access logs record the query string.

**What to check on your own instance:** whether access logging captures query
strings, how long those logs are kept, and who can read them. Where your site
supports OAuth, prefer it — the password never leaves the browser in that flow.

## What leaves your machine

- **To your openEQUELLA instance:** the files you selected, the metadata in
  your spreadsheet, and your credentials. Nothing else.
- **To a language model, only if you configure one.** With no model endpoint
  configured, nothing is contacted and nothing is sent. Point it at a local
  runtime and nothing leaves the machine. Point it at a hosted provider and the
  text of your documents is sent there, governed by that provider's terms
  rather than by this tool. An API key is never sent over plain `http` to
  anything but this machine.
- **Nowhere else.** There is no telemetry, no crash reporting and no update
  check.

## Stored credentials

Credentials are encrypted with Electron's `safeStorage` — on Windows that is
DPAPI, tied to your Windows account, so another user of the same computer
cannot read them. If the operating system reports encryption unavailable, the
tool refuses to store rather than falling back to plaintext.

**If you build this for Linux**, check what `safeStorage` backend you get:
without a system keyring it can report itself available while using a weak
one. Only Windows installers are published today.

## Spreadsheet formula injection

Text extracted from documents is written into a spreadsheet you open in Excel,
and Excel executes a cell beginning `=`, `+`, `-` or `@`. Such values are
prefixed with an apostrophe when written and the apostrophe is removed when the
spreadsheet is read back, so what gets uploaded is the original text. A value
that genuinely starts with one of those characters therefore shows a leading
apostrophe in Excel; that is expected.

## Dependency advisories

`npm audit` currently reports three moderate advisories. Both underlying issues
were checked against how this code actually calls the libraries:

| Package | Advisory | Applies here? |
| --- | --- | --- |
| `fast-xml-parser` | Comment/CDATA injection in `XMLBuilder` | **No.** Only `XMLParser` is used. Item XML is built by hand with its own escaper in `src/core/metadata.ts`. |
| `uuid` (via `exceljs`) | Missing bounds check when a `buf` argument is passed | **No.** Nothing in this codebase passes one. |

Both fixes are breaking major upgrades, one of them to `exceljs`, which writes
every spreadsheet this tool produces. **Do not run `npm audit fix --force`
before a release.** Re-check when non-breaking fixes ship, and treat any future
advisory that touches `XMLParser` as urgent, since it parses `.docx` files and
schema XML.

## What has not been reviewed

- No penetration testing against a running instance.
- The openEQUELLA server itself.
- The installer, its signing, and how it reaches staff.
- Provenance or integrity of the dependency tree beyond the advisory database.
```

- [ ] **Step 2: Check the links and claims still hold**

Run: `grep -n "XMLBuilder\|XMLParser" src/core/schema.ts src/core/extract/readers/docx.ts`

Expected: only `XMLParser` appears. If `XMLBuilder` ever shows up here, the table above is wrong and must be corrected before committing.

- [ ] **Step 3: Commit**

```bash
git add SECURITY.md
git commit -m "docs(security): state what leaves the machine, and what adopters must check"
```

---

## Task 7: Whole-suite verification

- [ ] **Step 1: Run everything**

```bash
npm test
npm run typecheck
npm run build
npm run build:desktop
```

Expected: all tests pass (2092 before this plan, plus the ~25 added here), typecheck clean, both builds clean.

- [ ] **Step 2: Mutation-test the two guards**

Both fixes are the kind that pass a suite while doing nothing. Apply each mutation **with the Edit tool** — never a `sed`/`perl` pattern containing `\n`, because the working copy is CRLF and the mutation silently fails to apply, which reads as a well-covered test.

1. In `formulaGuard.ts`, make `guardFormula` return `value` unchanged.
   Expect `tests/formulaGuard.test.ts` and `tests/extract/csv.test.ts` to fail. Revert.
2. In `formulaGuard.ts`, make `unguardFormula` return `value` unchanged.
   Expect `tests/formulaGuard.test.ts`, `tests/sheet.test.ts` and the round-trip test to fail. Revert.
3. In `authCode.ts`, make `checkState` return `true` unconditionally.
   Expect `tests/authCode.test.ts` to fail. Revert.
4. In `authCode.ts`, make `checkState` return `this.sentState === null || received === this.sentState`
   (the "nothing sent means anything goes" mistake). Expect the un-started case to fail. Revert.

- [ ] **Step 3: Update the handoff**

Add a section to `docs/SESSION-HANDOFF.md` recording what was hardened, what was
deliberately left (the scrub, the advisories, the query-string password), and
that none of it has been driven through the desktop app.

- [ ] **Step 4: Commit**

```bash
git add docs/SESSION-HANDOFF.md
git commit -m "docs: record the security hardening and what it deliberately left"
```
