# Institution-Agnostic Uploader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any openEQUELLA institution use this tool — sign in with an
openEQUELLA username and password, pick a collection the server lists, and
validate against the schema that collection declares.

**Architecture:** Three seams open. Auth gains a third `AuthProvider`
implementation, so `client.ts` needs no changes and session expiry is handled
by the existing 401-retry path. Collections and schemas are fetched from the
API instead of hardcoded, cached to disk so offline extraction keeps working.
The title xpath is read from the schema's declared `itemNamePath` instead of
the `MWDL/title` literal, which is what makes duplicate detection correct
anywhere.

**Tech Stack:** TypeScript on Node 22, `moduleResolution: nodenext` (relative
imports need the `.js` extension), vitest, Electron with a sandboxed renderer.

**Compiler strictness, checked rather than assumed:** `tsconfig.json` sets
`strict` and `noUncheckedIndexedAccess`. It does **not** set `noUnusedLocals` —
an earlier version of this plan claimed it did. Do not rely on the typecheck to
find a dead import; it will not.

**Mutation testing on this repo has a trap.** Source files are CRLF in the
working copy, so a `perl` or `sed` pattern containing `\n` silently matches
nothing — the mutation never applies, the suite comes back green, and the
result is indistinguishable from a well-covered test. This has already produced
a false "all passing" twice during this plan's execution. **Apply mutations with
the Edit tool, and confirm the file actually changed before believing a green
run.**

**Spec:** [../specs/2026-08-12-institution-agnostic-design.md](../specs/2026-08-12-institution-agnostic-design.md)

---

## Before you start

**Task 1 is a live probe run by the operator, and Tasks 6, 7 and 9 cannot be
written correctly until it has run.** Three response shapes are unknown:

1. Whether `GET /api/collection/{uuid}?full=true` names the collection's schema.
2. Whether `GET /api/schema/{uuid}` returns its definition as nested JSON or as
   XML. This decides whether `parseSchemaPaths` (which parses XML) can be
   reused or whether a JSON tree-walker is needed.
3. Whether the declared name path comes back as `namePath` or `itemNamePath`.

This plan writes those tasks against **fixtures the probe records**. Where a
field name appears below, it is the expected one — Step 1 of each parsing task
is always "read the fixture and confirm the shape before writing the test."
Do not skip that step and do not invent a field name.

**Why this matters here specifically:** this codebase has had two live probes
refute assumptions the entire test suite agreed with — the staging area being a
`?file=` query parameter, and `/search` defaulting to `showall=false`. Both
were believed by every test until an instance said otherwise.

**Branch:** `feature/institution-agnostic`, already created. Do not work on
`main`.

---

## What the probe actually found — 2026-08-12, content.byui.edu

Run by the operator via the browser (see Task 1). **All three unknowns are
settled, and two of the answers are better than the design assumed.** Fixtures
are committed under `tests/fixtures/api/`.

**Q1 — the collection list works.** `GET /api/collection?privilege=CREATE_ITEM&full=true`
returned `{ start, length, available, results }` with `available: 29`. Entries
carry `uuid`, `name` and — the useful part — **`schema: { uuid }`**.

**Q2 — YES, and the second request is unnecessary.** The schema uuid is on each
**list entry**, so `parseCollections` should carry it through and Setup needs no
per-collection follow-up call. Across the 29 collections there are two distinct
schemas, so an institution really can have more than one and the discovery
design is not over-engineering.

**Q3 — the field is `namePath`, not `itemNamePath`.**

```json
"namePath": "/MWDL/title",
"descriptionPath": "/MWDL/description",
"definition": { "xml": { "item": …, "MWDL": …, "BYUI_extended": … } }
```

`definition` is a **nested object**, not XML, so `parseSchemaPaths` cannot be
reused for the API path and the tree-walker is required. (`serializedDefinition`
does carry the XML string, but parsing JSON we already have would be perverse.)

### Two bugs this found in the walker as originally specified

Cross-checked the walker's output against `parseSchemaPaths(schema/_entity.xml)`
on the same schema — 158 paths from the XML export, 227 from the naive walk:

1. **The `xml` root must be stripped.** Paths live under `definition.xml`, so
   walking `definition` yields `xml/MWDL/title` where a spreadsheet header is
   `MWDL/title`. Note `namePath` omits the root, giving `/MWDL/title`.
2. **Containers must not be emitted.** The 70 extra paths are parent nodes —
   `MWDL/creators`, `MWDL/subjects`, `MWDL/genres`. `parseSchemaPaths` emits
   **leaves only**, and rightly: openEQUELLA cannot store a value at a container,
   so offering one as a valid header would let an operator build a spreadsheet
   that fails at upload.
3. **Attributes are addressable and must not be skipped.** The single path in
   the XML export missing from the walk was `item/oai/id`, because the JSON
   represents it as `@id` and the draft walker skipped every `@`-prefixed key.
   Underscore keys (`_type`, `_indexed`, `_field`) are metadata and *are*
   skipped; `@name` becomes the path segment `name`.

**The test that catches all three is the cross-check itself:** parse
`schema/_entity.xml` with the existing `parseSchemaPaths`, walk
`tests/fixtures/api/schema.json`, and assert the two agree. They describe the
same schema, so any disagreement is a bug in one of them. Write that test in
Task 7 — it is worth more than any hand-written fixture.

---

## File structure

**Create:**

| File | Responsibility |
| --- | --- |
| `scripts/probe-instance.mjs` | The live probe. Read-only. Records fixtures. Committed so any institution can run it |
| `src/core/instanceUrl.ts` | Validating and normalising an openEQUELLA address. HTTPS enforcement lives here |
| `src/core/passwordAuth.ts` | The `UsernamePasswordAuth` provider |
| `src/core/discovery.ts` | Parsing collection and schema responses. Pure functions over JSON — no fetching |
| `tests/instanceUrl.test.ts`, `tests/passwordAuth.test.ts`, `tests/discovery.test.ts` | Their tests |
| `tests/fixtures/api/collections.json`, `tests/fixtures/api/schema.json` | Recorded by the probe |

**Modify:**

| File | Change |
| --- | --- |
| `src/core/config.ts` | `AuthMode` gains `'password'`; required env vars become mode-dependent |
| `src/core/types.ts:64` | `TITLE_XPATH` stops being the single source of truth |
| `src/core/client.ts:484` | The `where` clause takes the title path as an argument |
| `src/core/duplicates.ts` | Threads the title path through; reports `could not check` when absent |
| `src/cli/index.ts:615` | `check` becomes the compatibility probe |
| `src/desktop/secrets.ts` | Stores the password |
| `src/desktop/ipc.ts`, `src/desktop/ui/instances.ts` | Instance list becomes user-managed |

---

## Task 1: The live probe

**This task is run by the operator, not by an implementing agent.** It needs an
interactive SSO sign-in that cannot be automated.

**Files:**
- Create: `scripts/probe-instance.mjs`
- Create: `tests/fixtures/api/collections.json`, `tests/fixtures/api/schema.json`

- [ ] **Step 1: Write the probe script**

```javascript
// scripts/probe-instance.mjs
//
// Read-only probe of an openEQUELLA instance. Creates nothing, changes
// nothing. Answers the response-shape questions in
// docs/superpowers/specs/2026-08-12-institution-agnostic-design.md and
// records fixtures the parsing tests are written against.
//
// Usage:
//   node scripts/probe-instance.mjs --token <access_token> [--collection <uuid>]
//   node scripts/probe-instance.mjs --user <name> --pass <password>
//
// Get an access token by running `oeq-upload login` first, then reading it
// from .oeq-token.json.
import { writeFileSync, mkdirSync } from 'node:fs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const base = (arg('base') ?? process.env.OEQ_BASE_URL ?? '').replace(/\/+$/, '');
if (!base) {
  console.error('Need --base <url> or OEQ_BASE_URL.');
  process.exit(2);
}

let headers;

if (arg('token')) {
  headers = { 'X-Authorization': `access_token=${arg('token')}` };
} else if (arg('user')) {
  // QUESTION 0: does password login work at all, and does it return a cookie?
  const url = new URL('/api/auth/login', base);
  url.searchParams.set('username', arg('user'));
  url.searchParams.set('password', arg('pass'));
  const res = await fetch(url, { method: 'POST' });
  console.log('=== Q0  POST /api/auth/login ->', res.status);
  const cookies = res.headers.getSetCookie?.() ?? [];
  console.log('    set-cookie names:', cookies.map((c) => c.split('=')[0]).join(', ') || '(none)');
  const jsession = cookies.find((c) => c.startsWith('JSESSIONID='));
  console.log('    JSESSIONID present:', Boolean(jsession));
  if (!res.ok || !jsession) {
    console.log('    body:', (await res.text()).slice(0, 300));
    process.exit(1);
  }
  headers = { Cookie: jsession.split(';')[0] };
} else {
  console.error('Need --token or --user/--pass.');
  process.exit(2);
}

const get = async (path) => {
  const res = await fetch(new URL(path, base), { headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
};

mkdirSync('tests/fixtures/api', { recursive: true });

// QUESTION 1: does privilege filtering work, and what does a collection look like?
console.log('\n=== Q1  GET /api/collection?privilege=CREATE_ITEM&full=true');
const cols = await get('/api/collection?privilege=CREATE_ITEM&full=true&length=50');
console.log('    status', cols.status, '| available:', cols.json?.available);
console.log('    result keys:', Object.keys(cols.json?.results?.[0] ?? {}).join(', ') || '(no results)');
if (cols.json) {
  writeFileSync('tests/fixtures/api/collections.json', JSON.stringify(cols.json, null, 2));
  console.log('    -> recorded tests/fixtures/api/collections.json');
}

// QUESTION 2: does a collection name its schema?
const collectionUuid = arg('collection') ?? cols.json?.results?.[0]?.uuid;
console.log(`\n=== Q2  GET /api/collection/${collectionUuid}?full=true`);
const one = await get(`/api/collection/${collectionUuid}?full=true`);
console.log('    status', one.status);
console.log('    keys:', Object.keys(one.json ?? {}).join(', '));
console.log('    schema field:', JSON.stringify(one.json?.schema ?? '(ABSENT - this changes the Setup flow)'));

// QUESTION 3: definition as JSON or XML? which name-path field?
const schemaUuid = one.json?.schema?.uuid ?? process.env.OEQ_SCHEMA_UUID;
console.log(`\n=== Q3  GET /api/schema/${schemaUuid}`);
const sch = await get(`/api/schema/${schemaUuid}`);
console.log('    status', sch.status);
console.log('    keys:', Object.keys(sch.json ?? {}).join(', '));
console.log('    namePath:', sch.json?.namePath ?? '(absent)');
console.log('    itemNamePath:', sch.json?.itemNamePath ?? '(absent)');
console.log('    definition type:', typeof sch.json?.definition);
if (sch.json) {
  writeFileSync('tests/fixtures/api/schema.json', JSON.stringify(sch.json, null, 2));
  console.log('    -> recorded tests/fixtures/api/schema.json');
}
```

- [ ] **Step 2: Operator signs in and runs it**

```bash
npx tsx src/cli/index.ts login        # interactive SSO, writes .oeq-token.json
node -e "console.log(JSON.parse(require('fs').readFileSync('.oeq-token.json','utf8')).accessToken)"
node scripts/probe-instance.mjs --base https://content-test.byui.edu --token <paste>
```

Use **content-test**, not production. The probe only issues GETs, but the
test instance is the right habit.

- [ ] **Step 3: Separately, confirm whether password login works at all**

```bash
node scripts/probe-instance.mjs --base https://content-test.byui.edu --user <name> --pass <password>
```

Expected: `Q0 ... -> 200` and `JSESSIONID present: true`.

**If every BYUI account is SSO-only and this returns 401**, password auth
cannot be verified here. That is a finding, not a blocker — continue the plan,
and record in the handoff and README that password auth ships **unverified**.
Do not let it be quietly forgotten.

- [ ] **Step 4: Record the answers in the handoff**

Add a section to `docs/SESSION-HANDOFF.md` stating, for each question, what the
instance actually returned. This is the same discipline the `showall=false`
and `?file=` findings got.

- [ ] **Step 5: Commit**

```bash
git add scripts/probe-instance.mjs tests/fixtures/api/ docs/SESSION-HANDOFF.md
git commit -m "probe: record what the instance returns for collections and schemas"
```

---

## Task 2: Instance URL validation

**Files:**
- Create: `src/core/instanceUrl.ts`
- Test: `tests/instanceUrl.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/instanceUrl.test.ts
import { describe, it, expect } from 'vitest';
import { normaliseInstanceUrl } from '../src/core/instanceUrl.js';

describe('normaliseInstanceUrl', () => {
  it('strips trailing slashes so callers can concatenate paths', () => {
    expect(normaliseInstanceUrl('https://oeq.example.edu/')).toBe('https://oeq.example.edu');
    expect(normaliseInstanceUrl('https://oeq.example.edu///')).toBe('https://oeq.example.edu');
  });

  /**
   * openEQUELLA takes the password as a QUERY PARAMETER on /api/auth/login.
   * Over plaintext that puts it in the clear on the wire, so this is refused
   * rather than warned about -- there is no safe way to proceed.
   */
  it('refuses plaintext http, naming the reason', () => {
    expect(() => normaliseInstanceUrl('http://oeq.example.edu')).toThrow(/https/i);
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => normaliseInstanceUrl('oeq.example.edu')).toThrow();
    expect(() => normaliseInstanceUrl('')).toThrow();
  });

  it('keeps a path prefix, because openEQUELLA can be hosted under one', () => {
    expect(normaliseInstanceUrl('https://library.example.edu/oeq/')).toBe(
      'https://library.example.edu/oeq',
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/instanceUrl.test.ts`
Expected: FAIL — cannot resolve `../src/core/instanceUrl.js`.

- [ ] **Step 3: Implement**

```typescript
// src/core/instanceUrl.ts
import { OeqError } from './errors.js';

/**
 * Validate and normalise an openEQUELLA address typed by an operator.
 *
 * HTTPS is required, not preferred. openEQUELLA's `/api/auth/login` takes the
 * password as a query parameter (confirmed in schema/swagger.json), so over
 * http it would travel in clear text in the request line. There is no
 * degraded mode worth offering, so this throws rather than warning.
 */
export function normaliseInstanceUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new OeqError(
      `"${trimmed}" is not a web address. It should look like https://oeq.yourschool.edu`,
    );
  }
  if (url.protocol !== 'https:') {
    throw new OeqError(
      `The address must start with https, not ${url.protocol.replace(':', '')}. ` +
        `Your password is sent as part of the web address when signing in to openEQUELLA, ` +
        `so an unencrypted connection would expose it.`,
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/instanceUrl.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/instanceUrl.ts tests/instanceUrl.test.ts
git commit -m "feat(core): validate an instance URL and require https"
```

---

## Task 3: The UsernamePassword auth provider

**Files:**
- Create: `src/core/passwordAuth.ts`
- Test: `tests/passwordAuth.test.ts`

Read `src/core/auth.ts` first. This provider copies its generation-based
invalidation deliberately — the reasoning in that file's comments (why expiry
is handled reactively on 401 rather than by a timer, why a fetch started before
an `invalidate()` must not populate the cache) applies here unchanged.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/passwordAuth.test.ts
import { describe, it, expect, vi } from 'vitest';
import { UsernamePasswordAuth } from '../src/core/passwordAuth.js';

const BASE = 'https://oeq.example.edu';

/** A fetch stub that returns a JSESSIONID cookie and counts its calls. */
function loginStub(cookie = 'abc123') {
  const calls: string[] = [];
  const impl = vi.fn(async (input: string | URL) => {
    calls.push(String(input));
    return new Response('', {
      status: 200,
      headers: { 'set-cookie': `JSESSIONID=${cookie}; Path=/; HttpOnly` },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('UsernamePasswordAuth', () => {
  it('signs in and presents the session as a Cookie header', async () => {
    const { impl } = loginStub();
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    expect(await auth.authHeader()).toEqual({ Cookie: 'JSESSIONID=abc123' });
  });

  it('signs in once and reuses the session', async () => {
    const { impl, calls } = loginStub();
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    await auth.authHeader();
    await auth.authHeader();
    expect(calls).toHaveLength(1);
  });

  /**
   * The client retries once on 401 after calling invalidate(). That is the
   * ONLY mechanism handling an expired session, so it has to actually
   * re-login rather than hand back the dead cookie.
   */
  it('signs in again after invalidate', async () => {
    const { impl, calls } = loginStub();
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    await auth.authHeader();
    auth.invalidate();
    await auth.authHeader();
    expect(calls).toHaveLength(2);
  });

  it('collapses concurrent sign-ins into one request', async () => {
    const { impl, calls } = loginStub();
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    await Promise.all([auth.authHeader(), auth.authHeader(), auth.authHeader()]);
    expect(calls).toHaveLength(1);
  });

  it('reports bad credentials without echoing the password', async () => {
    const impl = vi.fn(async () =>
      new Response('Bad credentials for hunter2', { status: 401 }),
    ) as unknown as typeof fetch;
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    await expect(auth.authHeader()).rejects.toThrow(/sign-in failed/i);
    await auth.authHeader().catch((e: Error) => {
      expect(JSON.stringify(e)).not.toContain('hunter2');
      expect(e.message).not.toContain('hunter2');
    });
  });

  /**
   * A 200 with no cookie means we are not authenticated but would look it.
   * Every later request would 401 with no explanation.
   */
  it('rejects a 200 that carried no session cookie', async () => {
    const impl = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    await expect(auth.authHeader()).rejects.toThrow(/no session/i);
  });

  it('refuses to be constructed against a plaintext instance', () => {
    const { impl } = loginStub();
    expect(() => new UsernamePasswordAuth('http://oeq.example.edu', 'j', 'p', impl)).toThrow(/https/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/passwordAuth.test.ts`
Expected: FAIL — cannot resolve `../src/core/passwordAuth.js`.

- [ ] **Step 3: Implement**

```typescript
// src/core/passwordAuth.ts
import { ApiError } from './errors.js';
import type { AuthProvider } from './auth.js';
import { normaliseInstanceUrl } from './instanceUrl.js';

/**
 * openEQUELLA's own username/password sign-in.
 *
 * This is the default for institutions that are not behind SSO. It posts to
 * `/api/auth/login` and keeps the returned JSESSIONID, presenting it as a
 * Cookie header so `client.ts` needs no changes: the client merges whatever
 * `authHeader()` returns into every request.
 *
 * SESSION EXPIRY IS NOT HANDLED HERE. A lapsed session produces a 401, and
 * client.ts already responds to a 401 by calling `invalidate()` and retrying
 * once. See the long comment in auth.ts for why expiry is handled reactively
 * rather than on a timer -- the reasoning is identical, and duplicating it
 * with a timer here would put expiry logic in two places.
 *
 * THE PASSWORD TRAVELS IN THE QUERY STRING. That is openEQUELLA's API, not a
 * choice made here. It means the password reaches server access logs, so:
 * https is required (enforced in the constructor), and nothing in this class
 * ever puts a full URL into an error, a message or a log line.
 */
export class UsernamePasswordAuth implements AuthProvider {
  private session: string | null = null;
  private inFlight: Promise<string> | null = null;
  private inFlightGeneration: number | null = null;
  private generation = 0;
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly username: string,
    private readonly password: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = normaliseInstanceUrl(baseUrl);
  }

  async getToken(): Promise<string> {
    if (this.session) return this.session;
    if (!this.inFlight || this.inFlightGeneration !== this.generation) {
      const startedInGeneration = this.generation;
      const promise = this.login(startedInGeneration);
      this.inFlight = promise;
      this.inFlightGeneration = startedInGeneration;
      void promise
        .finally(() => {
          if (this.inFlight === promise) {
            this.inFlight = null;
            this.inFlightGeneration = null;
          }
        })
        .catch(() => {});
    }
    return this.inFlight;
  }

  private async login(startedInGeneration: number): Promise<string> {
    const url = new URL('/api/auth/login', this.baseUrl);
    url.searchParams.set('username', this.username);
    url.searchParams.set('password', this.password);

    let res: Response;
    let body: string;
    try {
      res = await this.fetchImpl(url, { method: 'POST' });
      body = await res.text();
    } catch {
      // Never include the request URL: it carries the password, and some
      // runtimes fold the failing URL into the error's message or cause.
      throw new ApiError(
        `Sign-in request to ${this.safeEndpoint()} failed before a response was received.`,
        0,
        '',
      );
    }

    if (!res.ok) {
      throw new ApiError(
        this.redact(`Sign-in failed (${res.status}). Check the username and password.`),
        res.status,
        this.redact(body),
      );
    }

    const session = readJsessionId(res.headers);
    if (!session) {
      throw new ApiError(
        'Sign-in returned success but no session cookie, so nothing is authenticated. ' +
          'The address may point at something that is not openEQUELLA.',
        res.status,
        '',
      );
    }

    if (startedInGeneration === this.generation) {
      this.session = session;
    }
    return session;
  }

  /** Origin + path only — never the query string, which carries the password. */
  private safeEndpoint(): string {
    const url = new URL('/api/auth/login', this.baseUrl);
    return `${url.origin}${url.pathname}`;
  }

  private redact(text: string): string {
    if (!this.password) return text;
    let result = text.split(this.password).join('[REDACTED]');
    const encoded = encodeURIComponent(this.password);
    if (encoded !== this.password) {
      result = result.split(encoded).join('[REDACTED]');
    }
    return result;
  }

  async authHeader(): Promise<Record<string, string>> {
    return { Cookie: `JSESSIONID=${await this.getToken()}` };
  }

  invalidate(): void {
    this.session = null;
    this.generation++;
  }
}

/** Pull JSESSIONID out of the response's Set-Cookie headers. */
function readJsessionId(headers: Headers): string | null {
  const all =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie') ?? ''];
  for (const cookie of all) {
    const match = /(?:^|;\s*)JSESSIONID=([^;]+)/.exec(cookie);
    if (match?.[1]) return match[1];
  }
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/passwordAuth.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/passwordAuth.ts tests/passwordAuth.test.ts
git commit -m "feat(core): username and password auth provider"
```

---

## Task 4: Prove the password cannot leak

The password reaches an error path, a manifest and a log line in normal
operation. A debug line added six months from now could put it in a file the
operator emails to a vendor. This test is the guard against that.

**Files:**
- Test: `tests/passwordAuth.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/passwordAuth.test.ts
describe('the password never escapes', () => {
  const SECRET = 'correct-horse-battery-staple';

  /**
   * Walks every string reachable from a thrown error -- message, stack,
   * ApiError's body field, and anything nested -- looking for the password
   * in either literal or percent-encoded form. It travels in a query string,
   * so a URL echoed back by the server carries the encoded form.
   */
  const findsSecret = (value: unknown): boolean => {
    const seen = new Set<unknown>();
    const walk = (v: unknown): boolean => {
      if (v == null || seen.has(v)) return false;
      seen.add(v);
      if (typeof v === 'string') {
        return v.includes(SECRET) || v.includes(encodeURIComponent(SECRET));
      }
      if (v instanceof Error) return walk(v.message) || walk(v.stack) || walk(v.cause);
      if (typeof v === 'object') return Object.values(v as object).some(walk);
      return false;
    };
    return walk(value);
  };

  it('is absent from a rejected sign-in, including the echoed body', async () => {
    const impl = vi.fn(async (input: string | URL) =>
      // A server echoing the request line back is exactly how the encoded
      // form leaks.
      new Response(`Rejected request: ${String(input)}`, { status: 401 }),
    ) as unknown as typeof fetch;
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', SECRET, impl);
    const error = await auth.authHeader().catch((e: unknown) => e);
    expect(findsSecret(error)).toBe(false);
  });

  it('is absent when the network fails before a response', async () => {
    const impl = vi.fn(async (input: string | URL) => {
      throw new Error(`connect ECONNREFUSED for ${String(input)}`);
    }) as unknown as typeof fetch;
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', SECRET, impl);
    const error = await auth.authHeader().catch((e: unknown) => e);
    expect(findsSecret(error)).toBe(false);
  });

  it('is absent from the Cookie header handed to the client', async () => {
    const { impl } = loginStub();
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', SECRET, impl);
    expect(findsSecret(await auth.authHeader())).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm which ones fail**

Run: `npx vitest run tests/passwordAuth.test.ts`

The network-failure test is the one most likely to fail: `new Error(...)` in
the stub has the URL in its message, and if the catch block re-threw the
original error rather than constructing a fresh `ApiError`, it leaks. **If all
three pass immediately, delete the catch block's `ApiError` in
`passwordAuth.ts`, re-run, and confirm a test goes red.** A guard that passes
against broken code guards nothing — this codebase has already shipped a set
of tests that all passed unchanged when the rule they named was deleted.

- [ ] **Step 3: Fix anything the tests caught**

If a test fails, the fix is in `passwordAuth.ts`: never pass a URL, a response
body, or a caught error's message into `ApiError` without `this.redact()`.

- [ ] **Step 4: Run to verify all pass**

Run: `npx vitest run tests/passwordAuth.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add tests/passwordAuth.test.ts src/core/passwordAuth.ts
git commit -m "test(core): prove the password reaches no error, log or header"
```

---

## Task 5: Wire the password mode into config

**Files:**
- Modify: `src/core/config.ts:8`, `:32-47`, `:84-95`
- Test: `tests/config.test.ts`

Note the existing required-variable check demands `OEQ_CLIENT_ID` and
`OEQ_CLIENT_SECRET` unconditionally. In password mode neither exists, so the
check has to become mode-dependent or password mode can never load.

- [ ] **Step 1: Write the failing tests**

```typescript
// append to tests/config.test.ts
import { loadConfig, createAuthProvider } from '../src/core/config.js';
import { UsernamePasswordAuth } from '../src/core/passwordAuth.js';

describe('password auth mode', () => {
  const base = {
    OEQ_BASE_URL: 'https://oeq.example.edu',
    OEQ_AUTH_MODE: 'password',
    OEQ_USERNAME: 'jsmith',
    OEQ_PASSWORD: 'hunter2',
  };

  it('loads without any OAuth client credentials', () => {
    const cfg = loadConfig(base);
    expect(cfg.authMode).toBe('password');
    expect(cfg.username).toBe('jsmith');
  });

  it('builds a UsernamePasswordAuth provider', () => {
    expect(createAuthProvider(loadConfig(base))).toBeInstanceOf(UsernamePasswordAuth);
  });

  it('names the missing variable when the password is absent', () => {
    expect(() => loadConfig({ ...base, OEQ_PASSWORD: undefined })).toThrow(/OEQ_PASSWORD/);
  });

  it('still demands client credentials in the OAuth modes', () => {
    expect(() =>
      loadConfig({ OEQ_BASE_URL: 'https://oeq.example.edu', OEQ_AUTH_MODE: 'code' }),
    ).toThrow(/OEQ_CLIENT_ID/);
  });

  it('rejects an unknown mode by listing the three that exist', () => {
    expect(() => loadConfig({ ...base, OEQ_AUTH_MODE: 'saml' })).toThrow(/password/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `loadConfig` throws about missing `OEQ_CLIENT_ID`.

- [ ] **Step 3: Implement**

In `src/core/config.ts`, replace the `AuthMode` type (line 8):

```typescript
/** Which sign-in method to use. See the institution-agnostic design doc. */
export type AuthMode = 'code' | 'client_credentials' | 'password';
```

Add to the `Config` interface:

```typescript
  /** Set only in `password` mode. */
  username: string;
  /** Set only in `password` mode. Never logged, never written to the manifest. */
  password: string;
```

Replace the required-variable block (lines 33-47) with:

```typescript
  const authModeRaw = env.OEQ_AUTH_MODE ?? 'code';
  if (authModeRaw !== 'code' && authModeRaw !== 'client_credentials' && authModeRaw !== 'password') {
    throw new OeqError(
      `OEQ_AUTH_MODE must be "code", "client_credentials" or "password", got "${authModeRaw}".`,
    );
  }

  // Which variables are required depends on the mode: an institution using
  // password auth has no OAuth client at all, so demanding a client id would
  // make the mode unusable.
  const required =
    authModeRaw === 'password'
      ? (['OEQ_BASE_URL', 'OEQ_USERNAME', 'OEQ_PASSWORD'] as const)
      : (['OEQ_BASE_URL', 'OEQ_CLIENT_ID', 'OEQ_CLIENT_SECRET'] as const);
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new OeqError(
      `Missing required environment variables:\n${missing.map((m) => `  ${m}`).join('\n')}\n` +
        `Copy .env.example to .env and fill them in.`,
    );
  }
```

In the returned object, add:

```typescript
    username: env.OEQ_USERNAME ?? '',
    password: env.OEQ_PASSWORD ?? '',
```

Replace `clientId`/`clientSecret` with non-null-asserted reads, since they are
no longer always required:

```typescript
    clientId: env.OEQ_CLIENT_ID ?? '',
    clientSecret: env.OEQ_CLIENT_SECRET ?? '',
```

And in `createAuthProvider`, before the `client_credentials` branch:

```typescript
  if (cfg.authMode === 'password') {
    return new UsernamePasswordAuth(cfg.baseUrl, cfg.username, cfg.password);
  }
```

with the import at the top:

```typescript
import { UsernamePasswordAuth } from './passwordAuth.js';
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/config.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts tests/config.test.ts
git commit -m "feat(core): OEQ_AUTH_MODE=password, with mode-dependent required vars"
```

---

## Task 5b: Extract the single-flight/generation machinery

**Added after review, not in the original plan.** Recommended by the code
quality reviewer and deferred deliberately, because it touches OAuth code
running in production today. It is written down as a task rather than left as a
comment: two documentation commits were lost on this repo in the week before
this plan was written by being remembered rather than tracked.

**Files:**
- Create: `src/core/singleFlight.ts`, `tests/singleFlight.test.ts`
- Modify: `src/core/auth.ts`, `src/core/passwordAuth.ts`

### The case for doing it

`auth.ts` and `passwordAuth.ts` duplicate the concurrency protocol **verbatim**:
four fields, the `!this.inFlight || this.inFlightGeneration !== this.generation`
guard, the `void promise.finally(...).catch(() => {})` double-rejection dance,
and a `startedInGeneration` parameter threaded through the network method purely
so it can re-check `=== this.generation` before caching.

That is the only subtle code in either file. It took four dedicated tests each
to pin down, and `tests/auth.test.ts:92-97` records that its semantics were
**already revised once under review**. The next such revision has to be found
and applied twice, linked by nothing but the prose comment at
`passwordAuth.ts:34`. A comment is not a mechanism.

What must NOT be extracted: the endpoint, the response shape (cookie vs JSON),
`authHeader()`'s format, the error wording, the constructor's URL policy. A
shared abstract base would drag all of that into one file and every future
divergence would be paid for with a hook. Only the concurrency protocol moves.

### The shape

```typescript
// src/core/singleFlight.ts
class SingleFlight<T> {
  constructor(produce: () => Promise<T>);
  get(): Promise<T>;
  invalidate(): void;
}
```

Each provider then owns one, and `getToken()` becomes `return this.flight.get()`,
`invalidate()` becomes `this.flight.invalidate()`. **This is a net simplification,
not just deduplication**: the generation check moves inside the helper, so
`login()` and `fetchToken()` lose their `startedInGeneration` parameter and their
trailing cache-guard entirely, and become plain "produce a value" functions.

- [ ] **Step 1: Move the existing tests first, before touching the providers**

`tests/auth.test.ts` and `tests/passwordAuth.test.ts` each hold the concurrency
tests — `discards (does not cache) a token whose fetch was invalidated
mid-flight`, `does not hand an invalidated in-flight token to a caller who calls
getToken() after invalidate()`, and their session equivalents. Write the
`SingleFlight` versions in `tests/singleFlight.test.ts` **first**, against a
plain counter rather than a fetch stub, and confirm they fail.

- [ ] **Step 2: Implement `SingleFlight`, confirm its tests pass.**

- [ ] **Step 3: Convert `passwordAuth.ts` first** — it is the newer, less
  battle-tested of the two, so a mistake there is cheaper. Full suite green.

- [ ] **Step 4: Convert `auth.ts`.** The eight existing hardening tests across
  both providers are the safety net. **If any of them needs editing to pass, stop
  and report** — that means the refactor changed behaviour, which is exactly what
  it must not do.

- [ ] **Step 5: Mutation test.** Remove the generation check from `SingleFlight`
  and confirm the moved tests go red. Apply mutations with the Edit tool and
  verify the file changed — see the CRLF warning at the top of this plan.

- [ ] **Step 6: Commit**

```bash
git add src/core/singleFlight.ts src/core/auth.ts src/core/passwordAuth.ts tests/
git commit -m "refactor(core): one single-flight helper for both auth providers"
```

---

## Task 5c: End the server session on logout

**Added after review.** The spec's endpoint block lists `PUT /api/auth/logout`
but no task implemented it — it fell through when the plan was written.

**Files:**
- Modify: `src/core/passwordAuth.ts`, `src/cli/index.ts`
- Test: `tests/passwordAuth.test.ts`

`logoutAction` ([src/cli/index.ts:517](../../../src/cli/index.ts#L517)) clears
the local token store and nothing else. That is complete for OAuth, where the
token is local. Under password auth the JSESSIONID stays valid on the server
until openEQUELLA times it out, so "Logged out" would be a claim the tool has
not earned.

- [ ] **Step 1: Write the failing tests**

```typescript
// append to tests/passwordAuth.test.ts
describe('logout', () => {
  it('tells the server to end the session', async () => {
    const calls: string[] = [];
    const impl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
      return new Response('', {
        status: 200,
        headers: { 'set-cookie': 'JSESSIONID=abc123; Path=/' },
      });
    }) as unknown as typeof fetch;
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    await auth.authHeader();
    await auth.logout();
    expect(calls).toEqual(['POST /api/auth/login', 'PUT /api/auth/logout']);
  });

  it('drops the local session even when the server call fails', async () => {
    let first = true;
    const impl = vi.fn(async () => {
      if (first) {
        first = false;
        return new Response('', { status: 200, headers: { 'set-cookie': 'JSESSIONID=a; Path=/' } });
      }
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const auth = new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl);
    await auth.authHeader();
    await expect(auth.logout()).resolves.toBeUndefined();
  });

  it('does nothing when there was never a session', async () => {
    const calls: string[] = [];
    const impl = vi.fn(async (input: string | URL) => {
      calls.push(String(input));
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await new UsernamePasswordAuth(BASE, 'jsmith', 'hunter2', impl).logout();
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, confirm failure (`logout` is not a function).**

- [ ] **Step 3: Implement**

```typescript
  /**
   * End the session server-side as well as locally.
   *
   * Never throws. A logout that fails is not worth interrupting anyone over --
   * the local session is dropped either way, and openEQUELLA times the server
   * one out regardless. Throwing here would make `oeq-upload logout` fail on a
   * flaky network while having done the part that matters.
   */
  async logout(): Promise<void> {
    const session = this.session;
    this.invalidate();
    if (!session) return;
    try {
      await this.fetchImpl(new URL(LOGOUT_PATH, this.baseUrl), {
        method: 'PUT',
        headers: { Cookie: `JSESSIONID=${session}` },
      });
    } catch {
      // Deliberately swallowed -- see the doc comment above.
    }
  }
```

with `const LOGOUT_PATH = '/api/auth/logout';` beside `LOGIN_PATH`.

- [ ] **Step 4: Wire it into `logoutAction`** so that in password mode it calls
  `logout()` on the provider before reporting. Keep the existing token-store
  clear — an operator who moved over from an OAuth mode can still have a stale
  token file, and refusing to clear it would strand them.

- [ ] **Step 5: Run the full suite. Step 6: commit.**

```bash
git commit -m "feat(core): end the openEQUELLA session on logout, not just the local token"
```

---

## Task 6: Parse the collection list

**Do not start this task until Task 1's fixture exists.**

**Files:**
- Create: `src/core/discovery.ts`
- Test: `tests/discovery.test.ts`
- Read: `tests/fixtures/api/collections.json`

- [ ] **Step 1: Read the fixture and confirm the shape**

```bash
node -e "const j=require('./tests/fixtures/api/collections.json'); console.log(Object.keys(j)); console.log(JSON.stringify(j.results?.[0],null,2).slice(0,600))"
```

Write the test against **what you see**, not against what Step 2 assumes. If
the wrapper key is not `results` or the entries do not carry `uuid`/`name`,
adjust both the test and the implementation.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/discovery.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCollections } from '../src/core/discovery.js';

const recorded = JSON.parse(readFileSync('tests/fixtures/api/collections.json', 'utf8'));

describe('parseCollections', () => {
  it('reads the real recorded response', () => {
    const collections = parseCollections(recorded);
    expect(collections.length).toBeGreaterThan(0);
    for (const c of collections) {
      expect(c.uuid).toMatch(/^[0-9a-f-]{36}$/i);
      expect(c.name.length).toBeGreaterThan(0);
    }
  });

  it('sorts by name so the dropdown is not in server order', () => {
    const names = parseCollections({
      results: [
        { uuid: '00000000-0000-0000-0000-00000000000b', name: 'Zoology' },
        { uuid: '00000000-0000-0000-0000-00000000000a', name: 'Archives' },
      ],
    }).map((c) => c.name);
    expect(names).toEqual(['Archives', 'Zoology']);
  });

  /**
   * An account that authenticates but can create nothing is a real state --
   * it is what a viewer-only account looks like. Returning [] lets Setup say
   * so; throwing would present it as a connection failure.
   */
  it('returns an empty list rather than throwing when there are none', () => {
    expect(parseCollections({ results: [] })).toEqual([]);
    expect(parseCollections({})).toEqual([]);
  });

  it('skips an entry with no uuid rather than producing an unusable option', () => {
    expect(parseCollections({ results: [{ name: 'Broken' }] })).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/discovery.test.ts`
Expected: FAIL — cannot resolve `../src/core/discovery.js`.

- [ ] **Step 4: Implement**

```typescript
// src/core/discovery.ts
//
// Pure parsing of openEQUELLA's collection and schema responses. Nothing here
// fetches: the caller owns the request so this stays testable against
// recorded fixtures, which is how every response shape in this codebase has
// been pinned down.

export interface CollectionSummary {
  uuid: string;
  name: string;
}

/**
 * Read `GET /api/collection?privilege=CREATE_ITEM`.
 *
 * An empty list is a legitimate answer meaning "this account can create
 * nothing", so it is returned rather than thrown. Entries missing a uuid are
 * dropped: an option that cannot be selected is worse than an absent one.
 */
export function parseCollections(body: unknown): CollectionSummary[] {
  const results = (body as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const collections: CollectionSummary[] = [];
  for (const entry of results) {
    const uuid = (entry as { uuid?: unknown })?.uuid;
    const name = (entry as { name?: unknown })?.name;
    if (typeof uuid !== 'string' || !uuid) continue;
    collections.push({ uuid, name: typeof name === 'string' && name ? name : uuid });
  }
  return collections.sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/discovery.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/core/discovery.ts tests/discovery.test.ts
git commit -m "feat(core): parse the collection list from the API"
```

---

## Task 7: Parse the schema, including its declared title path

**Do not start this task until Task 1's fixture exists.** This task's field
names are the most likely in the plan to be wrong.

**Files:**
- Modify: `src/core/discovery.ts`
- Test: `tests/discovery.test.ts`
- Read: `tests/fixtures/api/schema.json`

- [ ] **Step 1: Read the fixture and answer two questions**

```bash
node -e "const j=require('./tests/fixtures/api/schema.json'); console.log('keys:',Object.keys(j)); console.log('namePath:',j.namePath,'| itemNamePath:',j.itemNamePath); console.log('definition is a',typeof j.definition); console.log(JSON.stringify(j.definition,null,2).slice(0,800))"
```

- **Which field carries the name path** — `namePath` or `itemNamePath`?
  `schema/_entity.xml` uses `itemNamePath`, but the REST representation may
  rename it.
- **Is `definition` nested JSON or an XML string?** If XML, reuse the existing
  `extractDefinition` + `parseSchemaPaths` from `src/core/schema.ts` instead of
  the walker below and adjust the test accordingly.

- [ ] **Step 2: Write the failing test**

```typescript
// append to tests/discovery.test.ts
import { parseSchema } from '../src/core/discovery.js';

const recordedSchema = JSON.parse(readFileSync('tests/fixtures/api/schema.json', 'utf8'));

describe('parseSchema', () => {
  it('reads the real recorded schema', () => {
    const schema = parseSchema(recordedSchema);
    expect(schema.namePath).toBeTruthy();
    expect(schema.paths.size).toBeGreaterThan(10);
  });

  /**
   * BYUI's schema declares /MWDL/title. The tool has been hardcoding that
   * value; this asserts it is now READ. If this fails after the probe, the
   * field name in parseSchema is wrong -- fix it there, not here.
   */
  it('reads BYUI declared title path rather than assuming it', () => {
    expect(parseSchema(recordedSchema).namePath).toBe('/MWDL/title');
  });

  it('strips the leading slash so it matches spreadsheet header form', () => {
    // Headers in a spreadsheet are `MWDL/title`, not `/MWDL/title`.
    expect(parseSchema(recordedSchema).titleHeader).toBe('MWDL/title');
  });

  /**
   * A schema with no declared name path is the case that must NOT silently
   * become "clean" in duplicate detection. parseSchema reports it as null and
   * Task 9 turns that into "could not check".
   */
  it('returns null rather than a guess when no name path is declared', () => {
    const schema = parseSchema({ uuid: 'x', definition: { local: { title: {} } } });
    expect(schema.namePath).toBeNull();
    expect(schema.titleHeader).toBeNull();
  });

  it('flattens the definition into xpaths a spreadsheet header can match', () => {
    const schema = parseSchema({
      uuid: 'x',
      namePath: '/local/title',
      definition: { local: { title: {}, creator: { name: {} } } },
    });
    expect(schema.paths.has('local/title')).toBe(true);
    expect(schema.paths.has('local/creator/name')).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/discovery.test.ts`
Expected: FAIL — `parseSchema` is not exported.

- [ ] **Step 4: Implement**

Append to `src/core/discovery.ts`:

```typescript
export interface SchemaInfo {
  uuid: string;
  /** As declared, with a leading slash: `/MWDL/title`. Null if undeclared. */
  namePath: string | null;
  /** The same path in spreadsheet-header form: `MWDL/title`. Null if undeclared. */
  titleHeader: string | null;
  /** Every valid xpath, in spreadsheet-header form. */
  paths: Set<string>;
}

/**
 * Read `GET /api/schema/{uuid}`.
 *
 * THE NAME PATH IS THE POINT. An openEQUELLA schema declares which node
 * becomes an item's name (`itemNamePath` in the XML export). This tool used
 * to hardcode `MWDL/title` -- correct for BYU-Idaho by coincidence of it
 * being what BYUI's schema declares, and wrong everywhere else. Duplicate
 * detection matches on this path, so a wrong value makes every row report
 * clean from a check that never looked.
 *
 * When no path is declared this returns null and does NOT fall back to a
 * guess. See findDuplicates: undeclared means "could not check", never
 * "clean".
 */
export function parseSchema(body: unknown): SchemaInfo {
  const raw = body as { uuid?: unknown; namePath?: unknown; itemNamePath?: unknown; definition?: unknown };
  const declared =
    typeof raw?.namePath === 'string' && raw.namePath
      ? raw.namePath
      : typeof raw?.itemNamePath === 'string' && raw.itemNamePath
        ? raw.itemNamePath
        : null;

  return {
    uuid: typeof raw?.uuid === 'string' ? raw.uuid : '',
    namePath: declared,
    titleHeader: declared ? declared.replace(/^\/+/, '') : null,
    paths: flattenDefinition(raw?.definition),
  };
}

/**
 * Walk the nested definition into `a/b/c` xpaths, matching the form
 * spreadsheet headers use and the form `parseSchemaPaths` produces from the
 * XML export, so both sources are interchangeable downstream.
 */
function flattenDefinition(definition: unknown, prefix = ''): Set<string> {
  const paths = new Set<string>();
  if (!definition || typeof definition !== 'object') return paths;
  for (const [key, value] of Object.entries(definition as Record<string, unknown>)) {
    // Attributes of the node itself, not children.
    if (key.startsWith('_') || key.startsWith('@')) continue;
    const path = prefix ? `${prefix}/${key}` : key;
    paths.add(path);
    for (const child of flattenDefinition(value, path)) paths.add(child);
  }
  return paths;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/discovery.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add src/core/discovery.ts tests/discovery.test.ts
git commit -m "feat(core): read the schema declared item name path"
```

---

## Task 8: Thread the title path into duplicate detection

**This is the task that prevents a silent failure.** Read
`docs/superpowers/specs/2026-08-06-duplicate-prevention-design.md` first: this
codebase already shipped a duplicate check that read a field nobody filled in
and therefore reported no duplicates by never having looked.

**Files:**
- Modify: `src/core/client.ts:484`
- Modify: `src/core/duplicates.ts:147`
- Modify: `src/core/types.ts:64`
- Test: `tests/duplicates.test.ts`, `tests/client.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// append to tests/duplicates.test.ts
import { findDuplicates } from '../src/core/duplicates.js';

describe('the title path is read, not assumed', () => {
  const manifest = {
    entries: [
      {
        rowNumber: 2,
        file: 'thesis.pdf',
        metadata: { 'local/dc/title': ['A Thesis'], 'MWDL/title': ['WRONG'] },
        status: 'pending',
      },
    ],
  } as unknown as Parameters<typeof findDuplicates>[0];

  it('queries the path the schema declared, not MWDL/title', async () => {
    const asked: string[] = [];
    const searcher = async (title: string) => {
      asked.push(title);
      return [];
    };
    await findDuplicates(manifest, searcher, { titleHeader: 'local/dc/title' });
    expect(asked).toEqual(['A Thesis']);
  });

  /**
   * The whole point. With no declared path there is no way to search, and
   * saying "clean" would tell the operator their batch was checked when it
   * was not.
   */
  it('reports could-not-check when no title path is known, never clean', async () => {
    const searcher = async () => [];
    const findings = await findDuplicates(manifest, searcher, { titleHeader: null });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.tier).toBe('could-not-check');
    expect(findings[0]?.reason).toMatch(/title/i);
  });

  it('issues no search at all when it cannot know what to search for', async () => {
    let calls = 0;
    const searcher = async () => {
      calls += 1;
      return [];
    };
    await findDuplicates(manifest, searcher, { titleHeader: null });
    expect(calls).toBe(0);
  });
});
```

```typescript
// append to tests/client.test.ts
describe('the duplicate search where-clause', () => {
  it('uses the supplied path rather than a hardcoded MWDL/title', async () => {
    const seen: string[] = [];
    const client = makeTestClient(async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    await client.searchByTitle('A Thesis', 'local/dc/title');
    expect(decodeURIComponent(seen[0] ?? '')).toContain("/xml/local/dc/title = 'A Thesis'");
    expect(seen[0]).not.toContain('MWDL');
  });

  it('still sends showall=true, which drafts depend on', async () => {
    const seen: string[] = [];
    const client = makeTestClient(async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    await client.searchByTitle('A Thesis', 'local/dc/title');
    expect(seen[0]).toContain('showall=true');
  });
});
```

`makeTestClient` already exists in `tests/client.test.ts` — reuse it rather
than writing a second stub.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/duplicates.test.ts tests/client.test.ts`
Expected: FAIL — `findDuplicates` takes two arguments, and `searchByTitle`
takes one.

- [ ] **Step 3: Implement**

In `src/core/client.ts`, change the search method to take the path:

```typescript
  async searchByTitle(title: string, titleHeader: string): Promise<ExistingItemHit[]> {
    const clause = `/xml/${titleHeader} = '${escapeWhereValue(title)}'`;
    // ... rest unchanged
```

In `src/core/types.ts`, keep `TITLE_XPATH` but demote it to what it actually
is — a default for hand-made BYUI spreadsheets, not a universal truth:

```typescript
/**
 * The title path BYU-Idaho's schema declares. Used ONLY as a fallback for a
 * hand-made spreadsheet with no schema behind it. Anything that talks to an
 * instance must read the path from the schema instead -- see
 * discovery.ts#parseSchema. Hardcoding this is what made duplicate detection
 * silently blind at any other institution.
 */
export const DEFAULT_TITLE_XPATH = 'MWDL/title';
```

In `src/core/duplicates.ts`, take the path as an option and short-circuit when
it is absent:

```typescript
export interface DuplicateOptions {
  /** From the schema's declared name path. Null when the schema declared none. */
  titleHeader: string | null;
}

export async function findDuplicates(
  manifest: Manifest,
  search: TitleSearcher,
  options: DuplicateOptions,
): Promise<DuplicateFinding[]> {
  // No declared title path means there is nothing to match on. Reporting
  // every row as could-not-check is the only honest answer: "clean" would
  // claim a check happened.
  if (!options.titleHeader) {
    return manifest.entries
      .filter((entry) => entry.status === 'pending')
      .map((entry) => ({
        rowNumber: entry.rowNumber,
        tier: 'could-not-check' as const,
        reason:
          'This collection schema does not say which field holds the item title, ' +
          'so existing items cannot be searched. Check by hand before uploading.',
        hits: [],
      }));
  }
  // ... existing body, replacing `entry.metadata[TITLE_XPATH]` with
  //     `entry.metadata[options.titleHeader]` and passing options.titleHeader
  //     through to `search`.
}
```

Update `TitleSearcher` so implementations receive the path:

```typescript
export type TitleSearcher = (title: string, titleHeader: string) => Promise<ExistingItemHit[]>;
```

Then fix the call sites the compiler points at: `src/cli/index.ts`,
`src/desktop/handlers.ts`, and the MCP plan handler.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run && npm run typecheck`
Expected: PASS. **All 925 existing tests must still pass** — BYUI's behaviour
does not change, it just arrives at `MWDL/title` by reading it.

- [ ] **Step 5: Commit**

```bash
git add src/core/client.ts src/core/duplicates.ts src/core/types.ts tests/
git commit -m "fix(core): read the title path from the schema instead of hardcoding MWDL/title"
```

---

## Task 8b: The other BYU-Idaho values baked into core

**Added 2026-08-12, missed by the original plan.** Task 8 found the hardcoded
title path. Auditing `src/` for the Task 11 acceptance test found three more of
the same kind, and one of them is worse than the title path because it is a
**write, on every item created**.

**Files:**
- Modify: `src/core/types.ts:61`, `src/core/runner.ts:117`, `src/core/plan.ts:81`, `src/core/config.ts:34-35`, `src/desktop/ui/extract/picker.ts:21`
- Test: `tests/runner.test.ts`, `tests/config.test.ts`

### 1. `ATTACHMENT_UUID_XPATH` — the write

```typescript
// src/core/types.ts:61
export const ATTACHMENT_UUID_XPATH = 'BYUI_extended/attachments/attachment';

// src/core/runner.ts:117 -- on EVERY created item
[ATTACHMENT_UUID_XPATH]: [attachmentUuid],
```

`BYUI_extended` is BYU-Idaho's schema extension. At any other institution that
node does not exist, so the tool would write metadata to a path outside the
collection's schema on every item it creates — either silently storing junk or
failing the create, and neither is discoverable from the message.

**The attachment itself is not affected.** Attachments are linked through the
attachment API; this field is a convenience index that BYU-Idaho's schema
declares. So the correct behaviour elsewhere is **to not write it at all**.

Make it configuration: `attachmentUuidPath`, defaulting to **unset**. When
unset, `runner.ts` omits the field entirely rather than substituting a guess.
Tests: an item built with the path set carries the field; one with it unset
carries no trace of it; `plan.ts`'s skip at line 81 still skips it when set and
is a no-op when not.

### 2. `DEFAULT_COLLECTION` and `DEFAULT_SCHEMA` — silent wrong defaults

```typescript
// src/core/config.ts:34-35
const DEFAULT_COLLECTION = 'bb348ab1-7a81-4e37-8ef7-adc095ade4f9';
const DEFAULT_SCHEMA = 'c93181f3-a443-41bf-9afe-ac9f7daf90b7';
```

An institution that does not set `OEQ_COLLECTION_UUID` gets **BYU-Idaho's
collection uuid** rather than an error. The failure arrives from the server, as
a not-found on an identifier the operator never chose and cannot recognise.

Delete both. `OEQ_COLLECTION_UUID` joins the required list; the error naming a
missing variable is a better outcome than any default. `OEQ_SCHEMA_UUID` is
recorded in the manifest but never sent anywhere (see `CLAUDE.md`), so it
becomes optional-and-empty rather than required.

Test: `loadConfig` with no `OEQ_COLLECTION_UUID` throws naming it, and no BYUI
uuid appears in `src/`.

### 3. `SCHEMA_ORDER` — a cosmetic one, worth doing while here

```typescript
// src/desktop/ui/extract/picker.ts:21
const SCHEMA_ORDER = ['MWDL', 'BYUI_extended'];
```

Sorts the column picker so BYU-Idaho's two top-level schema sections appear in a
useful order — plain sorting put all 98 `BYUI_extended` entries ahead of the
MWDL fields most items need. Elsewhere the array simply does not match and the
ordering falls back, which is not a bug but is dead weight.

Derive the order from the schema instead: the section containing the declared
`namePath` first, then the rest alphabetically. That reproduces today's
behaviour at BYU-Idaho — `namePath` is `/MWDL/title`, so MWDL leads — while
being right anywhere.

- [ ] **Step 1: Write the failing tests for all three.**
- [ ] **Step 2: Run, confirm each fails for the stated reason.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full suite green, typecheck clean.**
- [ ] **Step 5: Mutation-test the `attachmentUuidPath`-unset path** — make the
  unset case fall back to the old constant and confirm a test goes red. This is
  the one whose silent failure would corrupt every item at a new institution.
  Use the Edit tool for the mutation; see the CRLF warning at the top.
- [ ] **Step 6: Commit**

```bash
git commit -m "fix(core): stop writing BYU-Idaho schema paths and uuids everywhere"
```

---

## Task 9: Cache the schema so extraction stays offline

`src/core/extract/` never touches the network — that is what lets an operator
build a spreadsheet without signing in. Task 7 moved the schema onto the API,
so it has to be cached or that property breaks.

**Files:**
- Create: `src/core/schemaCache.ts`
- Test: `tests/schemaCache.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/schemaCache.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchemaCache } from '../src/core/schemaCache.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oeq-schema-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

const info = {
  uuid: 'c93181f3-a443-41bf-9afe-ac9f7daf90b7',
  namePath: '/MWDL/title',
  titleHeader: 'MWDL/title',
  paths: new Set(['MWDL/title', 'MWDL/description']),
};

describe('SchemaCache', () => {
  it('round-trips a schema, including the path set', async () => {
    const cache = new SchemaCache(dir);
    await cache.save('https://oeq.example.edu', info);
    const loaded = await cache.load('https://oeq.example.edu', info.uuid);
    expect(loaded?.titleHeader).toBe('MWDL/title');
    expect(loaded?.paths.has('MWDL/description')).toBe(true);
  });

  it('keeps instances separate so two sites do not overwrite each other', async () => {
    const cache = new SchemaCache(dir);
    await cache.save('https://a.example.edu', info);
    expect(await cache.load('https://b.example.edu', info.uuid)).toBeNull();
  });

  /**
   * Extraction must still run with no cache -- blocking the offline half of
   * the tool on a network call the operator did not ask for would trade a
   * real capability for a check.
   */
  it('returns null rather than throwing when nothing is cached', async () => {
    expect(await new SchemaCache(dir).load('https://oeq.example.edu', 'nope')).toBeNull();
  });

  it('returns null rather than throwing on a corrupt cache file', async () => {
    const cache = new SchemaCache(dir);
    await cache.save('https://oeq.example.edu', info);
    const { writeFileSync, readdirSync } = await import('node:fs');
    const file = readdirSync(dir)[0]!;
    writeFileSync(join(dir, file), 'not json');
    expect(await cache.load('https://oeq.example.edu', info.uuid)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/schemaCache.test.ts`
Expected: FAIL — cannot resolve `../src/core/schemaCache.js`.

- [ ] **Step 3: Implement**

```typescript
// src/core/schemaCache.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { SchemaInfo } from './discovery.js';

/**
 * Holds fetched schemas on disk so `src/core/extract/` can validate columns
 * without a network call. Extraction being offline is deliberate: an operator
 * builds a spreadsheet from a folder of files without signing in to anything.
 *
 * Every read failure returns null rather than throwing. A missing or corrupt
 * cache must degrade to "columns unvalidated", never to "extraction refused".
 */
export class SchemaCache {
  constructor(private readonly dir: string) {}

  private file(instanceUrl: string, schemaUuid: string): string {
    const key = createHash('sha256').update(`${instanceUrl}|${schemaUuid}`).digest('hex').slice(0, 16);
    return join(this.dir, `schema-${key}.json`);
  }

  async save(instanceUrl: string, schema: SchemaInfo): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(
      this.file(instanceUrl, schema.uuid),
      JSON.stringify({ ...schema, paths: [...schema.paths] }, null, 2),
      'utf8',
    );
  }

  async load(instanceUrl: string, schemaUuid: string): Promise<SchemaInfo | null> {
    try {
      const raw = JSON.parse(await readFile(this.file(instanceUrl, schemaUuid), 'utf8')) as {
        uuid: string;
        namePath: string | null;
        titleHeader: string | null;
        paths: string[];
      };
      return { ...raw, paths: new Set(raw.paths) };
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/schemaCache.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/schemaCache.ts tests/schemaCache.test.ts
git commit -m "feat(core): cache fetched schemas so extraction stays offline"
```

---

## Task 10: `oeq-upload check` becomes the compatibility probe

> ### CORRECTION — do NOT create `src/core/compatibility.ts`
>
> The task below, as first written, specified a new module exporting
> `CheckResult` and `formatReport`. **That would re-implement what already
> exists.** `src/core/preflight.ts` has done this job all along:
>
> ```typescript
> export interface PreflightCheck { label: string; pass: boolean; message: string }
> export interface PreflightResult { ok: boolean; checks: PreflightCheck[] }
> ```
>
> `runPreflight` is already shared by the CLI's `check` and the MCP's
> `oeq_check`, and already reports **Token, Identity, Collection, Permission**
> and — added by Task 8b — **Attachment field**.
>
> So this task **extends `runPreflight`**, and adds no parallel module. The
> `CheckResult`/`formatReport` code below is superseded; keep only the
> presentation improvements, applied to `PreflightCheck`.
>
> **What is genuinely missing for a new institution:**
>
> 1. **HTTPS** — that the instance URL passed `normaliseInstanceUrl`. Cheap, and
>    it is the precondition for password auth being safe at all.
> 2. **Sign-in method** — which `OEQ_AUTH_MODE` was used and that it worked.
>    A site that thinks it is using a password but fell through to OAuth should
>    be told here, not at a confusing `client_id (null)` error.
> 3. **Collections available** — `GET /api/collection?privilege=CREATE_ITEM`
>    returning zero is a real, diagnosable state: the account authenticated but
>    can create nothing. Distinct from the existing Collection check, which
>    tests one named collection.
> 4. **Duplicate detection** — whether the collection's schema declares a
>    `namePath`. This is the highest-value line in the report. Without it every
>    row reports `could not check`, and a site should learn that before a batch,
>    not during one.
>
> Each new check must follow the existing file's discipline: never throw, always
> push a result, and say what a failure means for a real run rather than only
> what was observed.


The first outside institution is the real test of this work. This is what lets
them tell us what broke without us having access to their instance.

**Files:**
- Modify: `src/cli/index.ts:615`
- Create: `src/core/compatibility.ts`
- Test: `tests/compatibility.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/compatibility.test.ts
import { describe, it, expect } from 'vitest';
import { formatReport, type CheckResult } from '../src/core/compatibility.js';

const results: CheckResult[] = [
  { name: 'HTTPS', ok: true, detail: '' },
  { name: 'Sign-in', ok: true, detail: 'signed in as jsmith' },
  { name: 'Collections', ok: true, detail: '3 with CREATE_ITEM' },
  { name: 'Schema title path', ok: false, detail: 'the schema declares no item name path' },
];

describe('formatReport', () => {
  it('marks each line pass or fail', () => {
    const lines = formatReport(results).split('\n');
    expect(lines[0]).toMatch(/HTTPS\s+ok/);
    expect(lines[3]).toMatch(/Schema title path\s+FAILED/);
  });

  /**
   * A failing line that only says "failed" sends the operator to us. It has
   * to name the consequence.
   */
  it('explains what a failure means for the run', () => {
    expect(formatReport(results)).toContain('the schema declares no item name path');
  });

  it('ends with a verdict a script can act on', () => {
    expect(formatReport(results)).toMatch(/1 of 4 checks failed/);
    expect(formatReport(results.slice(0, 3))).toMatch(/all 3 checks passed/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/compatibility.test.ts`
Expected: FAIL — cannot resolve `../src/core/compatibility.js`.

- [ ] **Step 3: Implement**

```typescript
// src/core/compatibility.ts

export interface CheckResult {
  name: string;
  ok: boolean;
  /** What was found, or what the failure means for a real run. */
  detail: string;
}

/**
 * Render the compatibility report.
 *
 * This exists because only BYU-Idaho instances were available when this tool
 * was made institution-agnostic. The first site to run it somewhere else is
 * the real test, and this is how they tell us what broke.
 */
export function formatReport(results: CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length));
  const lines = results.map(
    (r) => `${r.name.padEnd(width + 2)}${r.ok ? 'ok' : 'FAILED'}${r.detail ? `   ${r.detail}` : ''}`,
  );
  const failed = results.filter((r) => !r.ok).length;
  lines.push('');
  lines.push(
    failed === 0
      ? `All ${results.length} checks passed.`
      : `${failed} of ${results.length} checks failed.`,
  );
  return lines.join('\n');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/compatibility.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire it into the `check` command**

In `src/cli/index.ts`, replace the body of `checkAction` with the collector
below. Each check appends its result and never throws — a check that aborts
the run hides every check after it, which is the opposite of the point.

```typescript
async function checkAction(env: Record<string, string | undefined>): Promise<number> {
  const results: CheckResult[] = [];
  const record = async (name: string, run: () => Promise<string>): Promise<void> => {
    try {
      results.push({ name, ok: true, detail: await run() });
    } catch (error) {
      results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  const cfg = loadConfig(env);
  const client = createClient(cfg, createAuthProvider(cfg, env));

  await record('HTTPS', async () => {
    normaliseInstanceUrl(cfg.baseUrl);
    return cfg.baseUrl;
  });

  await record('Sign-in', async () => {
    const me = await client.get<{ id?: string; username?: string }>('/api/content/currentuser');
    return `signed in as ${me.username ?? me.id ?? 'an unnamed account'}`;
  });

  let schema: SchemaInfo | null = null;

  await record('Collections', async () => {
    const body = await client.get<unknown>('/api/collection?privilege=CREATE_ITEM&full=true&length=50');
    const collections = parseCollections(body);
    if (collections.length === 0) {
      throw new Error('this account can create items in no collection, so nothing can be uploaded');
    }
    return `${collections.length} with CREATE_ITEM`;
  });

  await record('Schema', async () => {
    schema = parseSchema(await client.get<unknown>(`/api/schema/${cfg.schemaUuid}`));
    return `${schema.paths.size} valid fields`;
  });

  await record('Duplicate detection', async () => {
    if (!schema?.titleHeader) {
      throw new Error(
        'the schema declares no item name path, so existing items cannot be searched by ' +
          'title -- duplicates will be reported as "could not check", never as clean',
      );
    }
    return `will match on ${schema.titleHeader}`;
  });

  console.log(formatReport(results));
  return results.every((r) => r.ok) ? 0 : 1;
}
```

Add the imports this needs at the top of `src/cli/index.ts`:

```typescript
import { formatReport, type CheckResult } from '../core/compatibility.js';
import { parseCollections, parseSchema, type SchemaInfo } from '../core/discovery.js';
import { normaliseInstanceUrl } from '../core/instanceUrl.js';
```

If `client.get` is not the accessor name in `src/core/client.ts`, use whatever
the existing `checkAction` already calls — do not add a method.

- [ ] **Step 6: Commit**

```bash
git add src/core/compatibility.ts src/cli/index.ts tests/compatibility.test.ts
git commit -m "feat(cli): check reports per-capability compatibility"
```

---

## Task 11: Desktop — user-managed instance list

**Files:**
- Modify: `src/desktop/ipc.ts`, `src/desktop/ui/instances.ts`, `src/desktop/secrets.ts`, `src/desktop/session.ts`, `src/desktop/ui/app.ts`
- Test: `tests/desktop/ui/instances.test.ts`, `tests/desktop/secrets.test.ts`

**This task was understated in the first draft of this plan.** It said "empty
both literals". `InstanceId` is not data — it is a union type woven through the
type system and the on-disk format:

```typescript
// src/desktop/secrets.ts
export type InstanceId = 'production' | 'test';

interface StoredShapeV2 {
  version: 2;
  instances: Partial<Record<InstanceId, StoredSettings>>;   // <-- the disk key
}
```

So an operator running v1.0.0 has their OAuth client id, client secret and
redirect URI encrypted on disk under the literal keys `production` and `test`.

### Decision: clean break, not a migration — settled 2026-08-12

Stored credentials are **discarded** and Setup re-prompts. A v2→v3 rekeying
migration and a seed-don't-rekey hybrid were both considered and rejected.

Why, in order of weight:

1. **The operator is resetting the OAuth client secret.** Every stored
   `clientSecret` becomes invalid regardless of what this task does. A
   migration would faithfully preserve dead credentials, and the failure would
   then surface at sign-in rather than at Setup — further from the fix, and
   much harder to diagnose.
2. **Migration is the only option that can lose what it exists to protect.**
   Discarding is deliberate; not touching them is safe; moving them is the one
   path with a failure mode.
3. **Both preserving options keep BYU-Idaho's URLs in the shipped code**, as a
   seed or migration map. Removing them is the entire point of this task, and
   in a codebase heading for public release such a map reads as a default to
   whoever finds it next.
4. **The codebase already made this exact call.** `loadAll` returns `empty` for
   any unrecognised shape, and `SecretStore`'s doc comment reasons it out:
   *"the operator sees Setup again and re-enters what they have; that one-time
   re-prompt is a far smaller cost than a wrong-instance credential being sent
   to openEQUELLA unnoticed."*

### What this task must therefore do

1. **`InstanceId` becomes `string`** — a stable key derived from the normalised
   instance URL, not a hand-picked name. `normaliseInstanceUrl` from Task 2 is
   what makes two spellings of one address agree on a single key.
2. **Bump the stored version to 3.** `loadAll`'s existing "unrecognised shape →
   `empty`" path then discards v2 entries with no new code. Do not write a
   rekeying step.
3. **Setup must explain the blank form**, once, when a v2 store was found and
   dropped. A silent empty form reads as a broken app:
   *"This version stores credentials differently, and the client secret has
   been reset. Ask your administrator for the current client ID and secret."*
   **This string is the whole cost of the decision above — do not skip it.**
   Test that the notice appears for a v2 blob and does NOT appear for a fresh
   install, which has nothing to explain.
4. **`defaultRedirectUri` must go or change.** It looks the id up in `INSTANCES`
   and its doc comment relies on that list always declaring both known ids —
   an invariant this task deletes. Do not leave it silently returning `''`.

The two hand-mirrored `INSTANCES` literals and their drift test stay as a
mechanism; only their hardcoded contents go.

### The acceptance test, stated precisely

**No BYU-Idaho VALUE may remain in `src/` — but the comments stay.**

`grep -ri byui src/` currently returns 21 hits in 11 files, and they are three
different things. Only the first must go:

| Category | Examples | Action |
| --- | --- | --- |
| **Values and defaults** | the two `INSTANCES` literals in `ipc.ts` and `ui/instances.ts` | **Remove.** This task. |
| **Schema paths and uuids** | `ATTACHMENT_UUID_XPATH`, `DEFAULT_COLLECTION`, `DEFAULT_SCHEMA`, `SCHEMA_ORDER` | **Task 8b**, not here. |
| **Comments recording live findings** | `authCode.ts` on the redirect-URI trailing slash, `client.ts` on the staging `201`, `tokenStore.ts` on measured expiry | **Keep.** |

That last row matters. Those comments name `content-test.byui.edu` as the
*provenance of evidence* — "confirmed live against X" — and each one records
something that cost real time to establish and that a future reader would
otherwise re-derive or get wrong. Deleting them to satisfy a grep would destroy
the most valuable prose in the codebase. Naming where a fact was verified is
good practice, not institutional residue.

`secrets.ts:87-88` is the one comment that does need rewording, because it cites
the two instances as the *reason* credentials are per-instance. Keep the reason,
change the example.

- [ ] **Step 1: Write the failing test**

```typescript
// replace the BYUI-literal assertions in tests/desktop/ui/instances.test.ts
import { describe, it, expect } from 'vitest';
import { UI_INSTANCES } from '../../../src/desktop/ui/instances.js';

describe('the instance list', () => {
  /**
   * A tool shipped to other institutions must not arrive knowing BYU-Idaho's
   * addresses. The list is what the operator has added.
   */
  it('ships empty', () => {
    expect(UI_INSTANCES).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/desktop/ui/instances.test.ts`
Expected: FAIL — the list has BYUI's two entries.

- [ ] **Step 3: Implement**

Empty both literals, keeping the doc comments that explain the mirroring, and
add to `src/desktop/ui/instances.ts`:

```typescript
/**
 * Ships EMPTY. Instances are added by the operator on Setup and remembered
 * per Windows account. BYU-Idaho's two addresses used to be hardcoded here;
 * a tool handed to other institutions must not arrive knowing them.
 */
export const UI_INSTANCES: Pick<InstanceChoice, 'id' | 'label' | 'baseUrl'>[] = [];
```

Setup gains an address field that runs `normaliseInstanceUrl` and appends to
the stored list.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/desktop/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/desktop/ tests/desktop/
git commit -m "feat(desktop): instances are added by the operator, not shipped"
```

---

## Task 12: Desktop — password on Setup

> ### REGRESSION INTRODUCED BY TASK 8b — FIX IT IN THIS TASK
>
> Task 8b made the attachment-uuid field configuration
> (`OEQ_ATTACHMENT_UUID_PATH`), defaulting to unset. `src/desktop/session.ts`
> now reads it from `process.env`, which is fine for a developer running
> `npm run desktop` and **useless for the operator**, who launches the packaged
> app from a Start Menu shortcut with no environment set.
>
> **As things stand, a BYU-Idaho operator using the GUI will silently create
> items without `BYUI_extended/attachments/attachment`.** No error, no warning
> — the field is simply absent from every contribution, and nobody would notice
> until someone went looking for it in openEQUELLA weeks later.
>
> This task rewrites Setup and the per-instance settings store, so it is where
> the field belongs: a **per-instance setting collected on Setup and stored with
> the other credentials**, not an environment variable. The `process.env` read
> in `session.ts` is a stopgap and must not survive this task.
>
> Pre-fill it from the chosen collection's schema where possible — Task 8b's
> pre-flight already reports whether a configured path exists in the schema, so
> the same lookup can offer the right value rather than making the operator
> know it.

> ### THIS TASK IS THE CONSUMER OF THREE THINGS BUILT AHEAD OF IT
>
> Tasks 6, 7 and 9 built modules that **currently have no production caller.**
> `grep -rn SchemaCache src/` and `grep -rn parseCollections src/` each return
> only their own definition. That is acceptable only because this task adopts
> them. If it does not, they are dead code and must be deleted rather than left
> as plausible-looking infrastructure nobody calls.
>
> 1. **`parseCollections`** — Setup's collection dropdown. Note a real
>    duplication to resolve while here: `client.listCollections` parses the same
>    `/api/collection` response with its own inline `body.results.map(...)` and
>    **drops the `schema.uuid`** that `parseCollections` keeps. Two parsers for
>    one endpoint. `parseCollections` should win, because the schema uuid is
>    exactly what Setup needs to go from a chosen collection to its schema in
>    one hop. Make `listCollections` use it and delete the inline parse.
> 2. **`parseSchema`** — already widely used; no action.
> 3. **`SchemaCache`** — write to it when Setup fetches a schema, so
>    `src/core/extract/` keeps validating columns without a network call. That
>    offline property is the whole reason the cache exists.

> ### A SEAM THIS TASK DOES NOT CLOSE — record it, do not silently widen it
>
> `planAction` in `src/cli/index.ts` still reads the schema from a **local XML
> file** (`--schema-file`, via `extractItemNamePath`), while the pre-flight now
> reads it **from the API**. So the title path `check` reports and the one
> `plan` actually searches on come from different sources and can disagree —
> for instance when a schema has been edited on the server since the export was
> taken.
>
> Not this task's job, but do not make it worse. If a later task unifies them,
> the API is the authority and the local file is the offline fallback.


**Files:**
- Modify: `src/desktop/secrets.ts`, the Setup screen, `src/desktop/ipc.ts`
- Test: `tests/desktop/secrets.test.ts`

**Renderer rule:** nothing reachable from `src/desktop/ui/` may import `node:*`
or `electron`. Such an import does not fail loudly — it blanks the window with
nothing on the terminal. `tests/desktop/rendererPurity.test.ts` walks the
import graph and will catch it.

**Caret rule:** the username and password inputs re-render on `input`, so both
must call `ui/dom.ts#keepCaret` or they lose focus after one character.

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/desktop/secrets.test.ts
describe('the stored password', () => {
  it('round-trips per instance', async () => {
    const store = makeTestSecrets();
    await store.setPassword('https://a.example.edu', 'jsmith', 'hunter2');
    expect(await store.getPassword('https://a.example.edu')).toEqual({
      username: 'jsmith',
      password: 'hunter2',
    });
  });

  it('keeps two instances separate', async () => {
    const store = makeTestSecrets();
    await store.setPassword('https://a.example.edu', 'jsmith', 'hunter2');
    expect(await store.getPassword('https://b.example.edu')).toBeNull();
  });

  it('forgets on request, leaving nothing behind', async () => {
    const store = makeTestSecrets();
    await store.setPassword('https://a.example.edu', 'jsmith', 'hunter2');
    await store.forgetPassword('https://a.example.edu');
    expect(await store.getPassword('https://a.example.edu')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/desktop/secrets.test.ts`
Expected: FAIL — `setPassword` is not a function.

- [ ] **Step 3: Implement**

Add these to `src/desktop/secrets.ts`, reusing the same `safeStorage`
encryption and per-instance keying the client secret already uses — read that
code first and follow it rather than inventing a second storage shape:

```typescript
export interface StoredLogin {
  username: string;
  password: string;
}

/** Encrypted per Windows account, keyed by instance, like the client secret. */
setPassword(instanceUrl: string, username: string, password: string): Promise<void>;

/** Null when nothing is stored, or when decryption fails — never throws. */
getPassword(instanceUrl: string): Promise<StoredLogin | null>;

/** Behind the Forget button. Removing a key that is absent is not an error. */
forgetPassword(instanceUrl: string): Promise<void>;
```

Add three channels for these to **both** `src/desktop/ipc.ts` and
`preload.cts`. The two `CHANNELS` lists are hand-mirrored on purpose and a
drift test fails the build if they diverge — add to both in the same commit.

Setup gains an address field, username and password fields, a **Forget this
password** button, and a line naming who is signed in. Read the existing Setup
screen and follow its structure; do not restructure it. Both new inputs
re-render on `input`, so both must call `keepCaret` from `ui/dom.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/desktop/ && npm run typecheck && npm run build:desktop`
Expected: PASS, and the desktop build succeeds.

- [ ] **Step 5: Drive it in the real app**

```bash
npm run desktop
```

Unset `ELECTRON_RUN_AS_NODE` first if set — it turns `electron.exe` into plain
Node and the app exits silently with no window.

Confirm: typing an address, signing in with a password, that the collection
dropdown fills from the server, and that **the caret does not jump** while
typing in either field.

- [ ] **Step 6: Commit**

```bash
git add src/desktop/ tests/desktop/
git commit -m "feat(desktop): sign in with a username and password"
```

---

## Task 13: Documentation

**Files:**
- Modify: `README.md`, `docs/INSTALL.md`, `CLAUDE.md`, `docs/SESSION-HANDOFF.md`, `.env.example`

- [ ] **Step 1: Write what is and is not verified**

README gains a section stating the openEQUELLA version tested, that testing
covered **only** BYU-Idaho instances, and that `oeq-upload check` is how a new
site finds out whether it works. If Task 1 Step 3 showed password login could
not be tested, say **that** — plainly, not in a footnote.

- [ ] **Step 2: Update the domain facts in CLAUDE.md**

Two entries are now wrong:

- The duplicate-check fact says it matches `/xml/MWDL/title`. It now matches
  the path the schema declares.
- The authentication fact says unattended runs require OAuth client
  credentials. Task 1 found BYUI's client is registered for the
  authorization-code flow only and **cannot** use that grant.

- [ ] **Step 3: Add the password variables to `.env.example`**

```bash
# Sign-in method: code | client_credentials | password
# `password` is the default for institutions not behind SSO.
OEQ_AUTH_MODE=password
OEQ_USERNAME=
OEQ_PASSWORD=
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/ CLAUDE.md .env.example
git commit -m "docs: how another institution sets this up, and what is untested"
```

---

## Task 14: Full verification

- [ ] **Step 1: Run everything**

```bash
npm test && npm run typecheck && npm run build && npm run build:desktop
```

Expected: all tests pass (925 existing plus roughly 35 new), typecheck clean,
both builds succeed.

- [ ] **Step 2: Prove BYUI still works, end to end**

Run a real extract → plan → check cycle against **content-test** with a small
folder. Confirm the title path resolves to `MWDL/title` **by being read from
the schema**, and that duplicate detection still flags the duplicates it
flags today.

This is the regression that matters. Everything else is new code; this is the
one that could quietly break a tool already in production use.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feature/institution-agnostic
gh pr create --title "Make the uploader institution-agnostic" --body "Implements docs/superpowers/specs/2026-08-12-institution-agnostic-design.md"
```
