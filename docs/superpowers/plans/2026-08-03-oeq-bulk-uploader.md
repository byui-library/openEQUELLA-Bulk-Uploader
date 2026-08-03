# openEQUELLA Bulk Uploader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tool that creates one openEQUELLA contribution per file from a directory of media plus a metadata spreadsheet, with a strict 1:1 file-to-attachment-to-contribution relationship.

**Architecture:** A pure-TypeScript core (`src/core/`) holds all logic and is unaware of its callers. Two thin front ends wrap it: a CLI (`src/cli/`) and an MCP server (`src/mcp/`). Work splits into a cheap interactive *plan* phase that validates everything and writes a `job.json` manifest, and a long mechanical *run* phase that uploads and creates items without ever prompting. The MCP layer never streams file bytes.

**Tech Stack:** Node 22, TypeScript, vitest, commander, `@modelcontextprotocol/sdk`, `exceljs` (xlsx), `csv-parse`, `fast-xml-parser` (schema parsing), native `fetch`.

**Spec:** [../specs/2026-08-03-oeq-bulk-uploader-design.md](../specs/2026-08-03-oeq-bulk-uploader-design.md)

---

## Before you start: what is and isn't verified

The openEQUELLA REST endpoint shapes in **Task 7 and Task 9** are written from the
documented openEQUELLA API, **not** confirmed against this instance. `schema/swagger.json`
may not exist yet.

**If `schema/swagger.json` exists, read it first** and correct the endpoint paths,
payload field names, and status codes in those two tasks before implementing them.

This is deliberately contained: every other task depends only on the client's
*interface*, not its wire format. If reality differs, `client.ts` and `upload.ts`
change and nothing else does. Do not let a wire-format surprise cascade.

Assumptions to verify, in priority order:

1. `POST /api/staging` creates a staging area and returns a uuid.
2. `PUT /api/staging/{uuid}/{filename}` uploads file bytes.
3. `POST /api/item?draft=true` creates an item from an `ItemBean` with `metadata`
   as an XML string and an `attachments` array.
4. Whether a client-supplied **attachment** uuid is honoured. If yes, Task 10 uses
   one pass. If no, it needs the two-pass fallback described in the spec.

---

## File structure

```text
package.json, tsconfig.json, vitest.config.ts, .env.example
src/
  core/
    types.ts        Shared types. No logic. Every other module imports from here.
    errors.ts       Typed error classes so callers can branch on failure kind.
    sheet.ts        xlsx | csv -> Row[]
    schema.ts       Parse schema definition -> valid xpath set; validate; suggest
    metadata.ts     Row -> item metadata XML string
    auth.ts         AuthProvider interface + OAuth client-credentials impl
    client.ts       openEQUELLA REST client (VERIFY wire format)
    upload.ts       Staging-area file upload (VERIFY wire format)
    state.ts        Job manifest read/write, atomic
    plan.ts         Rows + files + schema -> validated manifest
    runner.ts       Execute manifest; retry; resume
  cli/index.ts      commander: plan | run | status | retry
  mcp/index.ts      MCP server
tests/
  fixtures/sample-batch.csv   (already committed)
  helpers/mockServer.ts       Real http.Server implementing the assumed API
```

---

## Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `src/core/types.ts`, `tests/scaffold.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "oeq-bulk-uploader",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "oeq-upload": "./dist/cli/index.js" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "commander": "^12.0.0",
    "csv-parse": "^5.5.0",
    "exceljs": "^4.4.0",
    "fast-xml-parser": "^4.4.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
  },
});
```

- [ ] **Step 4: Create `.env.example`**

```bash
# openEQUELLA instance
OEQ_BASE_URL=https://content.byui.edu

# OAuth client credentials. Register an API client in the admin console, bound to
# a user holding CREATE_ITEM on the target collection. That user becomes the owner
# of every item this tool creates.
OEQ_CLIENT_ID=
OEQ_CLIENT_SECRET=

# Defaults; overridable per run via CLI flags.
OEQ_COLLECTION_UUID=bb348ab1-7a81-4e37-8ef7-adc095ade4f9
OEQ_SCHEMA_UUID=c93181f3-a443-41bf-9afe-ac9f7daf90b7
```

- [ ] **Step 5: Create `src/core/types.ts`**

```typescript
/** One spreadsheet row: xpath -> cell value. Blank cells are present as ''. */
export interface Row {
  /** 1-based row number in the source sheet, for error messages. */
  rowNumber: number;
  /** Column header (xpath, or the reserved 'attachment name') -> cell text. */
  cells: Record<string, string>;
}

export interface Sheet {
  headers: string[];
  rows: Row[];
}

export type ItemState = 'draft' | 'published';

export type RowStatus =
  | 'pending'
  | 'uploading'
  | 'created'
  | 'incomplete'
  | 'failed'
  | 'skipped';

export interface ManifestEntry {
  rowNumber: number;
  /** Absolute path to the file on disk. */
  filePath: string;
  /** Filename as it should appear as the attachment. */
  fileName: string;
  /** Metadata xpath -> value(s). Repeated headers collapse into multiple values. */
  metadata: Record<string, string[]>;
  status: RowStatus;
  /** Populated once openEQUELLA returns it. The authoritative identity. */
  itemUuid?: string;
  itemVersion?: number;
  attachmentUuid?: string;
  error?: string;
  attempts: number;
}

export interface Manifest {
  version: 1;
  createdAt: string;
  baseUrl: string;
  collectionUuid: string;
  schemaUuid: string;
  itemState: ItemState;
  /** Reserved header naming the file on disk. */
  attachmentColumn: string;
  entries: ManifestEntry[];
  /** Non-fatal problems surfaced at plan time. */
  warnings: string[];
}

export const ATTACHMENT_COLUMN = 'attachment name';

/** Field that must receive the real attachment uuid, not the filename. */
export const ATTACHMENT_UUID_XPATH = 'BYUI_extended/attachments/attachment';
```

- [ ] **Step 6: Create `tests/scaffold.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { ATTACHMENT_COLUMN, ATTACHMENT_UUID_XPATH } from '../src/core/types.js';

describe('scaffold', () => {
  it('exposes the reserved column and uuid xpath constants', () => {
    expect(ATTACHMENT_COLUMN).toBe('attachment name');
    expect(ATTACHMENT_UUID_XPATH).toBe('BYUI_extended/attachments/attachment');
  });
});
```

- [ ] **Step 7: Install and verify**

Run: `npm install && npm test`
Expected: 1 test passes.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example src/core/types.ts tests/scaffold.test.ts
git commit -m "chore: scaffold TypeScript project with vitest"
```

---

## Task 2: Read spreadsheets (`sheet.ts`)

**Files:**
- Create: `src/core/sheet.ts`, `tests/sheet.test.ts`
- Read: `tests/fixtures/sample-batch.csv`

The fixture deliberately contains the real data's hazards: a misplaced space
(`Birch ,Rowan`), a lowercase `.mp4` extension, a parenthetical surname, and a
description containing both commas and double quotes. Those are the tests.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { readSheet } from '../src/core/sheet.js';

describe('readSheet (csv)', () => {
  it('reads headers and rows', async () => {
    const sheet = await readSheet('tests/fixtures/sample-batch.csv');
    expect(sheet.headers[0]).toBe('MWDL/identifier');
    expect(sheet.headers).toContain('attachment name');
    expect(sheet.rows).toHaveLength(3);
  });

  it('numbers rows from 2, matching the spreadsheet', async () => {
    const sheet = await readSheet('tests/fixtures/sample-batch.csv');
    expect(sheet.rows[0]!.rowNumber).toBe(2);
    expect(sheet.rows[2]!.rowNumber).toBe(4);
  });

  it('preserves quotes and commas inside a quoted field', async () => {
    const sheet = await readSheet('tests/fixtures/sample-batch.csv');
    const desc = sheet.rows[0]!.cells['MWDL/description']!;
    expect(desc).toContain('"Download linked file"');
    expect(desc).toContain('; for Windows');
  });

  it('preserves filenames with odd spacing and mixed-case extensions', async () => {
    const sheet = await readSheet('tests/fixtures/sample-batch.csv');
    expect(sheet.rows[1]!.cells['attachment name']).toBe('Birch ,Rowan 010125.MP4');
    expect(sheet.rows[2]!.cells['attachment name']).toBe('Cedar (Thorn), Wren 010225.mp4');
  });

  it('represents blank cells as empty strings, not undefined', async () => {
    const sheet = await readSheet('tests/fixtures/sample-batch.csv');
    expect(sheet.rows[0]!.cells['MWDL/abstract']).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/sheet.test.ts`
Expected: FAIL — cannot resolve `../src/core/sheet.js`.

- [ ] **Step 3: Implement `src/core/sheet.ts`**

```typescript
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import type { Row, Sheet } from './types.js';
import { SheetError } from './errors.js';

/** Build a Sheet from a header array and an array of raw string rows. */
function toSheet(headers: string[], raw: string[][]): Sheet {
  const rows: Row[] = raw.map((values, i) => {
    const cells: Record<string, string> = {};
    headers.forEach((h, col) => {
      cells[h] = (values[col] ?? '').trim();
    });
    return { rowNumber: i + 2, cells };
  });
  return { headers, rows };
}

/** Drop trailing rows where every cell is blank — spreadsheets accumulate these. */
function dropEmptyRows(raw: string[][]): string[][] {
  return raw.filter((r) => r.some((c) => (c ?? '').trim() !== ''));
}

async function readCsv(path: string): Promise<Sheet> {
  const text = await readFile(path, 'utf8');
  const records = parse(text, { skipEmptyLines: true }) as string[][];
  const headers = (records[0] ?? []).map((h) => h.trim());
  if (headers.length === 0) throw new SheetError(`${path} has no header row`);
  return toSheet(headers, dropEmptyRows(records.slice(1)));
}

async function readXlsx(path: string): Promise<Sheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets[0];
  if (!ws) throw new SheetError(`${path} contains no worksheets`);

  const raw: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    // ExcelJS row.values is 1-indexed with a leading hole.
    const cells = row.values as unknown[];
    for (let i = 1; i < cells.length; i++) {
      const v = cells[i];
      values.push(v == null ? '' : String(typeof v === 'object' && 'text' in (v as any) ? (v as any).text : v));
    }
    raw.push(values);
  });

  const headers = (raw[0] ?? []).map((h) => h.trim());
  if (headers.length === 0) throw new SheetError(`${path} has no header row`);
  return toSheet(headers, dropEmptyRows(raw.slice(1)));
}

export async function readSheet(path: string): Promise<Sheet> {
  const ext = extname(path).toLowerCase();
  if (ext === '.csv') return readCsv(path);
  if (ext === '.xlsx' || ext === '.xls') return readXlsx(path);
  throw new SheetError(`Unsupported spreadsheet type '${ext}'. Use .xlsx or .csv.`);
}
```

- [ ] **Step 4: Create `src/core/errors.ts`**

```typescript
/** Base for all errors this tool raises deliberately. */
export class OeqError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Spreadsheet could not be read or is structurally invalid. */
export class SheetError extends OeqError {}

/** A column header is not a valid xpath, or a row is unusable. */
export class ValidationError extends OeqError {}

/** The openEQUELLA API returned an error. */
export class ApiError extends OeqError {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
  }
  /** 4xx are caller mistakes and must never be retried. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/sheet.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/core/sheet.ts src/core/errors.ts tests/sheet.test.ts
git commit -m "feat: read metadata from xlsx and csv spreadsheets"
```

---

## Task 3: Parse and validate the schema (`schema.ts`)

**Files:**
- Create: `src/core/schema.ts`, `tests/schema.test.ts`
- Read: `schema/_entity.xml`

The schema lives in `<serialisedDefinition>` as escaped XML whose root is `<xml>`.
Valid xpaths are the paths *below* that root, e.g. `MWDL/title`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { extractDefinition, parseSchemaPaths, validateHeaders, suggest } from '../src/core/schema.js';

const entity = await readFile('schema/_entity.xml', 'utf8');
const paths = parseSchemaPaths(extractDefinition(entity));

describe('parseSchemaPaths', () => {
  it('finds simple and nested xpaths, excluding the xml root', () => {
    expect(paths.has('MWDL/title')).toBe(true);
    expect(paths.has('MWDL/creators/creator')).toBe(true);
    expect(paths.has('BYUI_extended/byui_rights/restriction')).toBe(true);
    expect(paths.has('BYUI_extended/attachments/attachment')).toBe(true);
    expect(paths.has('xml')).toBe(false);
  });

  it('finds every header used by the real spring 2026 batch', () => {
    for (const h of [
      'MWDL/identifier',
      'BYUI_extended/attachments/attachment',
      'BYUI_extended/byui_rights/restriction',
      'MWDL/creators/creator',
      'MWDL/title',
      'MWDL/description',
      'BYUI_extended/BYUI_information/metadata_complete',
      'BYUI_extended/BYUI_information/course_names/course_name',
      'MWDL/abstract',
    ]) {
      expect(paths.has(h), `${h} should be a valid xpath`).toBe(true);
    }
  });
});

describe('validateHeaders', () => {
  it('accepts the reserved attachment column without it being an xpath', () => {
    const result = validateHeaders(['attachment name', 'MWDL/title'], paths);
    expect(result.invalid).toEqual([]);
  });

  it('rejects an unknown xpath and suggests the nearest valid one', () => {
    const result = validateHeaders(['MWDL/Title'], paths);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]!.header).toBe('MWDL/Title');
    expect(result.invalid[0]!.suggestions).toContain('MWDL/title');
  });
});

describe('suggest', () => {
  it('ranks the closest match first', () => {
    expect(suggest('MWDL/creator', paths)[0]).toBe('MWDL/creators/creator');
  });

  it('returns nothing for input with no plausible match', () => {
    expect(suggest('zzzzzzzzzzzzzzzz', paths)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/schema.test.ts`
Expected: FAIL — cannot resolve `../src/core/schema.js`.

- [ ] **Step 3: Implement `src/core/schema.ts`**

```typescript
import { XMLParser } from 'fast-xml-parser';

/** Pull the schema definition XML out of an exported _entity.xml. */
export function extractDefinition(entityXml: string): string {
  const parser = new XMLParser({ ignoreAttributes: true });
  const doc = parser.parse(entityXml);
  const def = doc?.['com.tle.common.ImportExportPack']?.entity?.serialisedDefinition;
  if (typeof def !== 'string' || def.length === 0) {
    throw new Error('No <serialisedDefinition> found in entity XML');
  }
  return def;
}

/** Walk the definition tree and collect every path below the <xml> root. */
export function parseSchemaPaths(definitionXml: string): Set<string> {
  const parser = new XMLParser({
    ignoreAttributes: true,
    allowBooleanAttributes: true,
    parseTagValue: false,
  });
  const doc = parser.parse(definitionXml);
  const root = doc?.xml;
  const out = new Set<string>();

  const walk = (node: unknown, prefix: string): void => {
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}/${key}` : key;
      out.add(path);
      if (Array.isArray(value)) {
        for (const v of value) walk(v, path);
      } else {
        walk(value, path);
      }
    }
  };

  walk(root, '');
  return out;
}

/** Levenshtein distance, iterative two-row form. */
function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/**
 * Nearest valid xpaths for an unrecognised header, closest first.
 * Empty when nothing is plausibly close, so callers never show nonsense.
 */
export function suggest(header: string, paths: Set<string>, limit = 3): string[] {
  const lower = header.toLowerCase();
  const scored = [...paths]
    .map((p) => {
      const d = distance(lower, p.toLowerCase());
      // A case-only or near-miss on the final segment is the common typo.
      const tailBonus = p.toLowerCase().endsWith(lower.split('/').pop() ?? '') ? -1 : 0;
      return { path: p, score: d + tailBonus };
    })
    .filter((s) => s.score <= Math.max(3, Math.floor(header.length * 0.4)))
    .sort((a, b) => a.score - b.score || a.path.length - b.path.length);
  return scored.slice(0, limit).map((s) => s.path);
}

export interface InvalidHeader {
  header: string;
  suggestions: string[];
}

export interface HeaderValidation {
  valid: string[];
  invalid: InvalidHeader[];
}

/** The reserved column naming the file on disk; never a metadata xpath. */
const RESERVED = new Set(['attachment name']);

export function validateHeaders(headers: string[], paths: Set<string>): HeaderValidation {
  const valid: string[] = [];
  const invalid: InvalidHeader[] = [];
  for (const h of headers) {
    if (RESERVED.has(h.toLowerCase()) || paths.has(h)) valid.push(h);
    else invalid.push({ header: h, suggestions: suggest(h, paths) });
  }
  return { valid, invalid };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/schema.test.ts`
Expected: PASS, 6 tests.

If `suggest('MWDL/creator')` does not rank `MWDL/creators/creator` first, adjust the
`tailBonus` weighting until it does — do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add src/core/schema.ts tests/schema.test.ts
git commit -m "feat: parse schema xpaths and validate spreadsheet headers"
```

---

## Task 4: Generate item metadata XML (`metadata.ts`)

**Files:**
- Create: `src/core/metadata.ts`, `tests/metadata.test.ts`

Escaping matters: the real description contains double quotes, and any field may
contain `&`. A hand-rolled builder keeps this explicit and testable.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { buildMetadataXml } from '../src/core/metadata.js';

describe('buildMetadataXml', () => {
  it('nests a single xpath', () => {
    expect(buildMetadataXml({ 'MWDL/title': ['Hello'] }))
      .toBe('<xml><MWDL><title>Hello</title></MWDL></xml>');
  });

  it('merges sibling paths under a shared parent', () => {
    const xml = buildMetadataXml({ 'MWDL/title': ['T'], 'MWDL/abstract': ['A'] });
    expect(xml).toBe('<xml><MWDL><title>T</title><abstract>A</abstract></MWDL></xml>');
  });

  it('emits repeated values as sibling elements', () => {
    const xml = buildMetadataXml({ 'MWDL/creators/creator': ['Ann', 'Bob'] });
    expect(xml).toBe(
      '<xml><MWDL><creators><creator>Ann</creator><creator>Bob</creator></creators></MWDL></xml>',
    );
  });

  it('emits an empty tag for a blank value', () => {
    expect(buildMetadataXml({ 'MWDL/abstract': [''] }))
      .toBe('<xml><MWDL><abstract/></MWDL></xml>');
  });

  it('escapes XML metacharacters', () => {
    const xml = buildMetadataXml({ 'MWDL/description': ['A & B <c> "d"'] });
    expect(xml).toBe(
      '<xml><MWDL><description>A &amp; B &lt;c&gt; &quot;d&quot;</description></MWDL></xml>',
    );
  });

  it('handles the real jury description without corruption', () => {
    const desc =
      'Jury Video - To download video file: Apple : Right-click on link and choose ' +
      '"Download linked file"; for Windows: Right click link and choose "Save Target As"';
    const xml = buildMetadataXml({ 'MWDL/description': [desc] });
    expect(xml).toContain('&quot;Download linked file&quot;');
    expect(xml).not.toContain('<"');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/metadata.test.ts`
Expected: FAIL — cannot resolve `../src/core/metadata.js`.

- [ ] **Step 3: Implement `src/core/metadata.ts`**

```typescript
interface Node {
  children: Map<string, Node>;
  /** Terminal values at this path. Multiple values become sibling elements. */
  values: string[];
}

const newNode = (): Node => ({ children: new Map(), values: [] });

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function render(name: string, node: Node): string {
  // A node carrying values is terminal; emit one element per value.
  if (node.values.length > 0) {
    return node.values
      .map((v) => (v === '' ? `<${name}/>` : `<${name}>${escapeXml(v)}</${name}>`))
      .join('');
  }
  const inner = [...node.children].map(([k, child]) => render(k, child)).join('');
  return inner === '' ? `<${name}/>` : `<${name}>${inner}</${name}>`;
}

/**
 * Build openEQUELLA item metadata from xpath-keyed values.
 *
 * Insertion order of the input determines element order, so the output follows
 * the spreadsheet's column order. Blank values emit empty tags, matching what
 * the openEQUELLA wizard produces.
 */
export function buildMetadataXml(fields: Record<string, string[]>): string {
  const root = newNode();
  for (const [xpath, values] of Object.entries(fields)) {
    let cursor = root;
    for (const segment of xpath.split('/').filter(Boolean)) {
      let next = cursor.children.get(segment);
      if (!next) {
        next = newNode();
        cursor.children.set(segment, next);
      }
      cursor = next;
    }
    cursor.values.push(...values);
  }
  const inner = [...root.children].map(([k, child]) => render(k, child)).join('');
  return `<xml>${inner}</xml>`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/metadata.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/metadata.ts tests/metadata.test.ts
git commit -m "feat: build item metadata XML from xpath-keyed columns"
```

---

## Task 5: Job state persistence (`state.ts`)

**Files:**
- Create: `src/core/state.ts`, `tests/state.test.ts`

Writes must be atomic. A half-written manifest after an interrupted 5.5 GB run
would lose the record of which items already exist — the one thing resume needs.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveManifest, loadManifest } from '../src/core/state.js';
import type { Manifest } from '../src/core/types.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oeq-'));
});

const manifest = (): Manifest => ({
  version: 1,
  createdAt: '2026-08-03T00:00:00.000Z',
  baseUrl: 'https://example.test',
  collectionUuid: 'c-uuid',
  schemaUuid: 's-uuid',
  itemState: 'draft',
  attachmentColumn: 'attachment name',
  entries: [
    {
      rowNumber: 2,
      filePath: '/tmp/a.mp4',
      fileName: 'a.mp4',
      metadata: { 'MWDL/title': ['A'] },
      status: 'pending',
      attempts: 0,
    },
  ],
  warnings: [],
});

describe('state', () => {
  it('round-trips a manifest', async () => {
    const p = join(dir, 'job.json');
    await saveManifest(p, manifest());
    const loaded = await loadManifest(p);
    expect(loaded.entries[0]!.metadata['MWDL/title']).toEqual(['A']);
    expect(loaded.itemState).toBe('draft');
  });

  it('leaves no temp file behind', async () => {
    const p = join(dir, 'job.json');
    await saveManifest(p, manifest());
    await expect(readFile(`${p}.tmp`, 'utf8')).rejects.toThrow();
  });

  it('rejects a manifest with an unknown version', async () => {
    const p = join(dir, 'bad.json');
    await writeFile(p, JSON.stringify({ version: 99 }), 'utf8');
    await expect(loadManifest(p)).rejects.toThrow(/version/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/state.test.ts`
Expected: FAIL — cannot resolve `../src/core/state.js`.

- [ ] **Step 3: Implement `src/core/state.ts`**

```typescript
import { readFile, writeFile, rename } from 'node:fs/promises';
import type { Manifest } from './types.js';
import { OeqError } from './errors.js';

/**
 * Write atomically: a crash mid-write must never leave a truncated manifest,
 * because the manifest is the only record of which items already exist.
 */
export async function saveManifest(path: string, manifest: Manifest): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  await rename(tmp, path);
}

export async function loadManifest(path: string): Promise<Manifest> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as Manifest;
  if (parsed.version !== 1) {
    throw new OeqError(`Unsupported manifest version ${String(parsed.version)}; expected 1`);
  }
  return parsed;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/state.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/state.ts tests/state.test.ts
git commit -m "feat: atomic job manifest persistence"
```

---

## Task 6: Authentication (`auth.ts`)

**Files:**
- Create: `src/core/auth.ts`, `tests/auth.test.ts`, `tests/helpers/mockServer.ts`

- [ ] **Step 1: Create `tests/helpers/mockServer.ts`**

A real HTTP server, not an interception library. It exercises the actual `fetch`
path and makes the assumed API contract explicit in one readable place.

```typescript
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockState {
  /** Tokens handed out, newest last. */
  issuedTokens: string[];
  /** Reject the next N authorised calls with 401, to exercise refresh. */
  expireNext: number;
  /** Fail the next N item creations with 503, to exercise retry. */
  failItemNext: number;
  stagingAreas: Set<string>;
  uploads: { staging: string; filename: string; bytes: number }[];
  items: { uuid: string; version: number; metadata: string; draft: boolean }[];
  /** Identifiers that already exist, for the duplicate pre-flight. */
  existingIdentifiers: string[];
}

export interface MockServer {
  url: string;
  state: MockState;
  close: () => Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

export async function startMockServer(): Promise<MockServer> {
  const state: MockState = {
    issuedTokens: [],
    expireNext: 0,
    failItemNext: 0,
    stagingAreas: new Set(),
    uploads: [],
    items: [],
    existingIdentifiers: [],
  };

  let counter = 0;
  const nextId = (p: string) => `${p}-${++counter}`;

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(text);
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      if (path === '/oauth/access_token') {
        if (url.searchParams.get('client_id') !== 'good-id') {
          return send(res, 401, { error: 'invalid_client' });
        }
        const token = nextId('token');
        state.issuedTokens.push(token);
        return send(res, 200, { access_token: token, token_type: 'bearer', expires_in: 3600 });
      }

      // Everything below requires a currently-valid token.
      const auth = req.headers['x-authorization'];
      const token = typeof auth === 'string' ? auth.replace('access_token=', '') : '';
      const current = state.issuedTokens[state.issuedTokens.length - 1];
      if (token !== current) return send(res, 401, { error: 'unauthorized' });
      if (state.expireNext > 0) {
        state.expireNext--;
        return send(res, 401, { error: 'token expired' });
      }

      if (path === '/api/staging' && req.method === 'POST') {
        const uuid = nextId('staging');
        state.stagingAreas.add(uuid);
        return send(res, 201, { uuid });
      }

      const stagingUpload = /^\/api\/staging\/([^/]+)\/(.+)$/.exec(path);
      if (stagingUpload && req.method === 'PUT') {
        const [, staging, filename] = stagingUpload;
        if (!state.stagingAreas.has(staging!)) return send(res, 404, { error: 'no staging area' });
        const body = await readBody(req);
        state.uploads.push({
          staging: staging!,
          filename: decodeURIComponent(filename!),
          bytes: body.length,
        });
        return send(res, 200, {});
      }

      const stagingDelete = /^\/api\/staging\/([^/]+)$/.exec(path);
      if (stagingDelete && req.method === 'DELETE') {
        state.stagingAreas.delete(stagingDelete[1]!);
        return send(res, 204, '');
      }

      if (path === '/api/item' && req.method === 'POST') {
        if (state.failItemNext > 0) {
          state.failItemNext--;
          return send(res, 503, { error: 'temporarily unavailable' });
        }
        const body = JSON.parse((await readBody(req)).toString('utf8')) as {
          metadata: string;
          attachments?: { uuid?: string }[];
        };
        const uuid = nextId('item');
        state.items.push({
          uuid,
          version: 1,
          metadata: body.metadata,
          draft: url.searchParams.get('draft') === 'true',
        });
        return send(res, 201, {
          uuid,
          version: 1,
          attachments: (body.attachments ?? []).map((a) => ({ uuid: a.uuid ?? nextId('att') })),
        });
      }

      if (path === '/api/search' && req.method === 'GET') {
        const q = url.searchParams.get('q') ?? '';
        const hit = state.existingIdentifiers.some((id) => q.includes(id));
        return send(res, 200, { available: hit ? 1 : 0, results: hit ? [{ uuid: 'existing' }] : [] });
      }

      return send(res, 404, { error: 'not found' });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OAuthClientCredentials } from '../src/core/auth.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';

let mock: MockServer;
beforeEach(async () => { mock = await startMockServer(); });
afterEach(async () => { await mock.close(); });

describe('OAuthClientCredentials', () => {
  it('exchanges client credentials for a token', async () => {
    const auth = new OAuthClientCredentials(mock.url, 'good-id', 'secret');
    expect(await auth.getToken()).toBe(mock.state.issuedTokens[0]);
  });

  it('caches the token across calls', async () => {
    const auth = new OAuthClientCredentials(mock.url, 'good-id', 'secret');
    await auth.getToken();
    await auth.getToken();
    expect(mock.state.issuedTokens).toHaveLength(1);
  });

  it('mints a new token after invalidate()', async () => {
    const auth = new OAuthClientCredentials(mock.url, 'good-id', 'secret');
    await auth.getToken();
    auth.invalidate();
    await auth.getToken();
    expect(mock.state.issuedTokens).toHaveLength(2);
  });

  it('raises a clear error on bad credentials', async () => {
    const auth = new OAuthClientCredentials(mock.url, 'bad-id', 'secret');
    await expect(auth.getToken()).rejects.toThrow(/credential/i);
  });

  it('formats the header as openEQUELLA expects', async () => {
    const auth = new OAuthClientCredentials(mock.url, 'good-id', 'secret');
    const header = await auth.authHeader();
    expect(header['X-Authorization']).toMatch(/^access_token=token-/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/auth.test.ts`
Expected: FAIL — cannot resolve `../src/core/auth.js`.

- [ ] **Step 4: Implement `src/core/auth.ts`**

```typescript
import { ApiError } from './errors.js';

export interface AuthProvider {
  getToken(): Promise<string>;
  authHeader(): Promise<Record<string, string>>;
  /** Drop the cached token so the next call re-authenticates. */
  invalidate(): void;
}

/**
 * OAuth 2.0 client-credentials grant.
 *
 * This is the only viable path for unattended runs: the instance sits behind
 * Okta SSO, which cannot be scripted. Items are owned by the user the client
 * is bound to, not by whoever runs the tool.
 */
export class OAuthClientCredentials implements AuthProvider {
  private token: string | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  async getToken(): Promise<string> {
    if (this.token) return this.token;
    // Collapse concurrent refreshes into one request.
    this.inFlight ??= this.fetchToken().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async fetchToken(): Promise<string> {
    const url = new URL('/oauth/access_token', this.baseUrl);
    url.searchParams.set('grant_type', 'client_credentials');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('client_secret', this.clientSecret);

    const res = await fetch(url, { method: 'POST' });
    const body = await res.text();
    if (!res.ok) {
      throw new ApiError(
        `Token request failed (${res.status}). Check OEQ_CLIENT_ID and OEQ_CLIENT_SECRET credentials.`,
        res.status,
        body,
      );
    }
    const parsed = JSON.parse(body) as { access_token?: string };
    if (!parsed.access_token) {
      throw new ApiError('Token response contained no access_token', res.status, body);
    }
    this.token = parsed.access_token;
    return this.token;
  }

  async authHeader(): Promise<Record<string, string>> {
    return { 'X-Authorization': `access_token=${await this.getToken()}` };
  }

  invalidate(): void {
    this.token = null;
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/auth.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/core/auth.ts tests/auth.test.ts tests/helpers/mockServer.ts
git commit -m "feat: OAuth client-credentials authentication with token caching"
```

---

## Task 7: REST client (`client.ts`) — VERIFY AGAINST SWAGGER FIRST

**Files:**
- Create: `src/core/client.ts`, `tests/client.test.ts`

**Before implementing:** if `schema/swagger.json` exists, confirm the paths and
payload shapes below. Correct both this task's code *and* `tests/helpers/mockServer.ts`
together so they continue to describe the same contract.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OeqClient } from '../src/core/client.js';
import { OAuthClientCredentials } from '../src/core/auth.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';

let mock: MockServer;
let client: OeqClient;

beforeEach(async () => {
  mock = await startMockServer();
  client = new OeqClient(mock.url, new OAuthClientCredentials(mock.url, 'good-id', 'secret'));
});
afterEach(async () => { await mock.close(); });

describe('OeqClient', () => {
  it('creates a staging area', async () => {
    const uuid = await client.createStagingArea();
    expect(mock.state.stagingAreas.has(uuid)).toBe(true);
  });

  it('creates a draft item and returns its uuid', async () => {
    const result = await client.createItem({
      collectionUuid: 'c1',
      metadata: '<xml><MWDL><title>T</title></MWDL></xml>',
      stagingUuid: await client.createStagingArea(),
      attachments: [{ filename: 'a.mp4', description: 'a.mp4', uuid: 'att-fixed' }],
      draft: true,
    });
    expect(result.uuid).toMatch(/^item-/);
    expect(mock.state.items[0]!.draft).toBe(true);
  });

  it('transparently refreshes an expired token', async () => {
    await client.createStagingArea();
    mock.state.expireNext = 1;
    await expect(client.createStagingArea()).resolves.toMatch(/^staging-/);
    expect(mock.state.issuedTokens.length).toBeGreaterThan(1);
  });

  it('reports 5xx as retryable and 4xx as not', async () => {
    mock.state.failItemNext = 1;
    const err = await client
      .createItem({
        collectionUuid: 'c1',
        metadata: '<xml/>',
        stagingUuid: 'nope',
        attachments: [],
        draft: true,
      })
      .catch((e: unknown) => e);
    expect((err as { status: number; retryable: boolean }).status).toBe(503);
    expect((err as { retryable: boolean }).retryable).toBe(true);
  });

  it('detects an existing identifier', async () => {
    mock.state.existingIdentifiers = ['Aster, Juniper 010125.MP4'];
    expect(await client.identifierExists('c1', 'Aster, Juniper 010125.MP4')).toBe(true);
    expect(await client.identifierExists('c1', 'Nobody 000000.MP4')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/client.test.ts`
Expected: FAIL — cannot resolve `../src/core/client.js`.

- [ ] **Step 3: Implement `src/core/client.ts`**

```typescript
import type { AuthProvider } from './auth.js';
import { ApiError } from './errors.js';

export interface AttachmentSpec {
  filename: string;
  description: string;
  /** Client-supplied uuid. VERIFY the server honours this; see the plan preamble. */
  uuid?: string;
}

export interface CreateItemRequest {
  collectionUuid: string;
  metadata: string;
  stagingUuid: string;
  attachments: AttachmentSpec[];
  draft: boolean;
}

export interface CreateItemResult {
  uuid: string;
  version: number;
  attachmentUuids: string[];
}

export class OeqClient {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: AuthProvider,
  ) {}

  /**
   * Single request path for every call. Retries exactly once on 401 after
   * invalidating the token — a long batch will outlive its access token.
   */
  private async request(
    path: string,
    init: RequestInit = {},
    retriedAfter401 = false,
  ): Promise<Response> {
    const headers = { ...(init.headers ?? {}), ...(await this.auth.authHeader()) };
    const res = await fetch(new URL(path, this.baseUrl), { ...init, headers });

    if (res.status === 401 && !retriedAfter401) {
      this.auth.invalidate();
      return this.request(path, init, true);
    }
    if (!res.ok) {
      throw new ApiError(`${init.method ?? 'GET'} ${path} failed`, res.status, await res.text());
    }
    return res;
  }

  async createStagingArea(): Promise<string> {
    const res = await this.request('/api/staging', { method: 'POST' });
    const { uuid } = (await res.json()) as { uuid: string };
    return uuid;
  }

  async deleteStagingArea(uuid: string): Promise<void> {
    // Best-effort cleanup; a leaked staging area must never fail the row.
    try {
      await this.request(`/api/staging/${encodeURIComponent(uuid)}`, { method: 'DELETE' });
    } catch {
      /* ignore */
    }
  }

  async uploadToStaging(stagingUuid: string, filename: string, body: BodyInit): Promise<void> {
    await this.request(
      `/api/staging/${encodeURIComponent(stagingUuid)}/${encodeURIComponent(filename)}`,
      {
        method: 'PUT',
        body,
        headers: { 'content-type': 'application/octet-stream' },
        // @ts-expect-error Node-only: required when streaming a request body.
        duplex: 'half',
      },
    );
  }

  async createItem(req: CreateItemRequest): Promise<CreateItemResult> {
    const res = await this.request(`/api/item?draft=${String(req.draft)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        collection: { uuid: req.collectionUuid },
        metadata: req.metadata,
        stagingUuid: req.stagingUuid,
        attachments: req.attachments.map((a) => ({
          type: 'file',
          filename: a.filename,
          description: a.description,
          ...(a.uuid ? { uuid: a.uuid } : {}),
        })),
      }),
    });
    const body = (await res.json()) as {
      uuid: string;
      version: number;
      attachments?: { uuid: string }[];
    };
    return {
      uuid: body.uuid,
      version: body.version,
      attachmentUuids: (body.attachments ?? []).map((a) => a.uuid),
    };
  }

  /** Advisory only — a hit is a question for the operator, never a silent skip. */
  async identifierExists(collectionUuid: string, identifier: string): Promise<boolean> {
    const url =
      `/api/search?collections=${encodeURIComponent(collectionUuid)}` +
      `&q=${encodeURIComponent(`"${identifier}"`)}&length=1`;
    const res = await this.request(url);
    const body = (await res.json()) as { available: number };
    return body.available > 0;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/client.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/client.ts tests/client.test.ts
git commit -m "feat: openEQUELLA REST client with 401 refresh and typed errors"
```

---

## Task 8: Build the plan (`plan.ts`)

**Files:**
- Create: `src/core/plan.ts`, `tests/plan.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from '../src/core/plan.js';
import type { Sheet } from '../src/core/types.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oeq-plan-'));
  await writeFile(join(dir, 'a.mp4'), 'aaa');
  await writeFile(join(dir, 'b.mp4'), 'bbb');
});

const paths = new Set(['MWDL/title', 'MWDL/identifier', 'BYUI_extended/attachments/attachment']);

const sheet = (rows: Record<string, string>[]): Sheet => ({
  headers: ['attachment name', 'MWDL/title', 'MWDL/identifier', 'BYUI_extended/attachments/attachment'],
  rows: rows.map((cells, i) => ({ rowNumber: i + 2, cells })),
});

const opts = {
  baseUrl: 'https://example.test',
  collectionUuid: 'c1',
  schemaUuid: 's1',
  itemState: 'draft' as const,
};

describe('buildManifest', () => {
  it('matches rows to files and carries metadata through', async () => {
    const m = await buildManifest(
      sheet([{ 'attachment name': 'a.mp4', 'MWDL/title': 'A', 'MWDL/identifier': 'a.mp4', 'BYUI_extended/attachments/attachment': 'a.mp4' }]),
      dir, paths, opts,
    );
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0]!.fileName).toBe('a.mp4');
    expect(m.entries[0]!.metadata['MWDL/title']).toEqual(['A']);
  });

  it('strips the attachment-uuid xpath, which is filled in after upload', async () => {
    const m = await buildManifest(
      sheet([{ 'attachment name': 'a.mp4', 'MWDL/title': 'A', 'MWDL/identifier': 'a.mp4', 'BYUI_extended/attachments/attachment': 'a.mp4' }]),
      dir, paths, opts,
    );
    expect(m.entries[0]!.metadata['BYUI_extended/attachments/attachment']).toBeUndefined();
  });

  it('excludes a row whose file is missing and records why', async () => {
    const m = await buildManifest(
      sheet([
        { 'attachment name': 'a.mp4', 'MWDL/title': 'A', 'MWDL/identifier': 'a', 'BYUI_extended/attachments/attachment': '' },
        { 'attachment name': 'ghost.mp4', 'MWDL/title': 'G', 'MWDL/identifier': 'g', 'BYUI_extended/attachments/attachment': '' },
      ]),
      dir, paths, opts,
    );
    expect(m.entries).toHaveLength(1);
    expect(m.warnings.join(' ')).toMatch(/ghost\.mp4/);
  });

  it('warns about a file with no row but does not fail', async () => {
    const m = await buildManifest(
      sheet([{ 'attachment name': 'a.mp4', 'MWDL/title': 'A', 'MWDL/identifier': 'a', 'BYUI_extended/attachments/attachment': '' }]),
      dir, paths, opts,
    );
    expect(m.warnings.join(' ')).toMatch(/b\.mp4/);
  });

  it('rejects an unknown header before any file work', async () => {
    const bad: Sheet = { headers: ['attachment name', 'MWDL/Title'], rows: [] };
    await expect(buildManifest(bad, dir, paths, opts)).rejects.toThrow(/MWDL\/Title/);
  });

  it('matches filenames case-insensitively, since .MP4 and .mp4 both occur', async () => {
    const m = await buildManifest(
      sheet([{ 'attachment name': 'A.MP4', 'MWDL/title': 'A', 'MWDL/identifier': 'a', 'BYUI_extended/attachments/attachment': '' }]),
      dir, paths, opts,
    );
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0]!.fileName).toBe('a.mp4');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/plan.test.ts`
Expected: FAIL — cannot resolve `../src/core/plan.js`.

- [ ] **Step 3: Implement `src/core/plan.ts`**

```typescript
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Manifest, ManifestEntry, Sheet, ItemState } from './types.js';
import { ATTACHMENT_COLUMN, ATTACHMENT_UUID_XPATH } from './types.js';
import { validateHeaders } from './schema.js';
import { ValidationError } from './errors.js';

export interface PlanOptions {
  baseUrl: string;
  collectionUuid: string;
  schemaUuid: string;
  itemState: ItemState;
}

export async function buildManifest(
  sheet: Sheet,
  filesDir: string,
  schemaPaths: Set<string>,
  opts: PlanOptions,
): Promise<Manifest> {
  // Headers first: a typo should surface before we touch the filesystem.
  const { invalid } = validateHeaders(sheet.headers, schemaPaths);
  if (invalid.length > 0) {
    const detail = invalid
      .map((i) =>
        i.suggestions.length > 0
          ? `  '${i.header}' is not a valid xpath. Did you mean: ${i.suggestions.join(', ')}?`
          : `  '${i.header}' is not a valid xpath.`,
      )
      .join('\n');
    throw new ValidationError(`Spreadsheet has invalid column headers:\n${detail}`);
  }

  const onDisk = await readdir(filesDir);
  const byLower = new Map(onDisk.map((f) => [f.toLowerCase(), f]));

  const entries: ManifestEntry[] = [];
  const warnings: string[] = [];
  const matched = new Set<string>();

  for (const row of sheet.rows) {
    const wanted = (row.cells[ATTACHMENT_COLUMN] ?? '').trim();
    if (wanted === '') {
      warnings.push(`Row ${row.rowNumber}: no '${ATTACHMENT_COLUMN}' value; skipped.`);
      continue;
    }
    const actual = byLower.get(wanted.toLowerCase());
    if (!actual) {
      warnings.push(`Row ${row.rowNumber}: file '${wanted}' not found in ${filesDir}; skipped.`);
      continue;
    }
    matched.add(actual);

    const metadata: Record<string, string[]> = {};
    for (const [header, value] of Object.entries(row.cells)) {
      if (header === ATTACHMENT_COLUMN) continue;
      // Filled in with the real uuid once the attachment exists.
      if (header === ATTACHMENT_UUID_XPATH) continue;
      (metadata[header] ??= []).push(value);
    }

    entries.push({
      rowNumber: row.rowNumber,
      filePath: join(filesDir, actual),
      fileName: actual,
      metadata,
      status: 'pending',
      attempts: 0,
    });
  }

  for (const f of onDisk) {
    if (!matched.has(f)) warnings.push(`File '${f}' has no matching row; not uploaded.`);
  }

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    baseUrl: opts.baseUrl,
    collectionUuid: opts.collectionUuid,
    schemaUuid: opts.schemaUuid,
    itemState: opts.itemState,
    attachmentColumn: ATTACHMENT_COLUMN,
    entries,
    warnings,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/plan.test.ts`
Expected: PASS, 6 tests.

Note: the spreadsheet lists `Equella_Spring2026.xlsx` alongside the media, so the
"file with no row" warning will fire for the spreadsheet itself. That is correct
behaviour — a warning, not an error.

- [ ] **Step 5: Commit**

```bash
git add src/core/plan.ts tests/plan.test.ts
git commit -m "feat: build validated job manifest from sheet and files directory"
```

---

## Task 9: Upload files (`upload.ts`) — VERIFY AGAINST SWAGGER FIRST

**Files:**
- Create: `src/core/upload.ts`, `tests/upload.test.ts`

Files average 150 MB, so the body must be a stream. Reading one into memory would
work but wastes 150 MB of heap per row for no benefit.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadFile } from '../src/core/upload.js';
import { OeqClient } from '../src/core/client.js';
import { OAuthClientCredentials } from '../src/core/auth.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';

let mock: MockServer;
let client: OeqClient;
let dir: string;

beforeEach(async () => {
  mock = await startMockServer();
  client = new OeqClient(mock.url, new OAuthClientCredentials(mock.url, 'good-id', 'secret'));
  dir = await mkdtemp(join(tmpdir(), 'oeq-up-'));
});
afterEach(async () => { await mock.close(); });

describe('uploadFile', () => {
  it('streams the file into a staging area', async () => {
    const p = join(dir, 'clip.mp4');
    await writeFile(p, Buffer.alloc(4096, 7));
    const staging = await uploadFile(client, p, 'clip.mp4');
    expect(mock.state.uploads).toEqual([{ staging, filename: 'clip.mp4', bytes: 4096 }]);
  });

  it('preserves commas and spaces in the filename', async () => {
    const name = 'Aster, Juniper 010125.MP4';
    const p = join(dir, name);
    await writeFile(p, Buffer.alloc(16));
    await uploadFile(client, p, name);
    expect(mock.state.uploads[0]!.filename).toBe(name);
  });

  it('removes the staging area when the upload fails', async () => {
    const p = join(dir, 'missing-after.mp4');
    await writeFile(p, Buffer.alloc(8));
    // Force the PUT to 404 by destroying the staging area mid-flight.
    const original = client.createStagingArea.bind(client);
    client.createStagingArea = async () => {
      const uuid = await original();
      mock.state.stagingAreas.delete(uuid);
      return uuid;
    };
    await expect(uploadFile(client, p, 'missing-after.mp4')).rejects.toThrow();
    expect(mock.state.stagingAreas.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/upload.test.ts`
Expected: FAIL — cannot resolve `../src/core/upload.js`.

- [ ] **Step 3: Implement `src/core/upload.ts`**

```typescript
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { OeqClient } from './client.js';

/**
 * Upload one file into a fresh staging area and return that area's uuid.
 *
 * The file is streamed rather than buffered: at ~150 MB per file, buffering
 * would cost heap for no gain. On failure the staging area is removed so a
 * retry does not leak a partial upload server-side.
 */
export async function uploadFile(
  client: OeqClient,
  filePath: string,
  fileName: string,
): Promise<string> {
  const stagingUuid = await client.createStagingArea();
  try {
    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    await client.uploadToStaging(stagingUuid, fileName, stream);
    return stagingUuid;
  } catch (err) {
    await client.deleteStagingArea(stagingUuid);
    throw err;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/upload.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/upload.ts tests/upload.test.ts
git commit -m "feat: stream file uploads to staging areas with cleanup on failure"
```

---

## Task 10: Execute the run (`runner.ts`)

**Files:**
- Create: `src/core/runner.ts`, `tests/runner.test.ts`

Sequential by default. Per-row isolation. Retries only what is retryable.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runManifest } from '../src/core/runner.js';
import { OeqClient } from '../src/core/client.js';
import { OAuthClientCredentials } from '../src/core/auth.js';
import { loadManifest, saveManifest } from '../src/core/state.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';
import type { Manifest } from '../src/core/types.js';

let mock: MockServer;
let client: OeqClient;
let dir: string;

beforeEach(async () => {
  mock = await startMockServer();
  client = new OeqClient(mock.url, new OAuthClientCredentials(mock.url, 'good-id', 'secret'));
  dir = await mkdtemp(join(tmpdir(), 'oeq-run-'));
  await writeFile(join(dir, 'a.mp4'), Buffer.alloc(32));
  await writeFile(join(dir, 'b.mp4'), Buffer.alloc(32));
});
afterEach(async () => { await mock.close(); });

const manifest = (): Manifest => ({
  version: 1,
  createdAt: '2026-08-03T00:00:00.000Z',
  baseUrl: mock.url,
  collectionUuid: 'c1',
  schemaUuid: 's1',
  itemState: 'draft',
  attachmentColumn: 'attachment name',
  warnings: [],
  entries: ['a.mp4', 'b.mp4'].map((f, i) => ({
    rowNumber: i + 2,
    filePath: join(dir, f),
    fileName: f,
    metadata: { 'MWDL/title': [f] },
    status: 'pending' as const,
    attempts: 0,
  })),
});

describe('runManifest', () => {
  it('creates one item per entry and records the uuids', async () => {
    const path = join(dir, 'job.json');
    await saveManifest(path, manifest());
    const summary = await runManifest(client, path, { retryDelayMs: 1 });
    expect(summary.created).toBe(2);
    const done = await loadManifest(path);
    expect(done.entries.every((e) => e.status === 'created')).toBe(true);
    expect(done.entries[0]!.itemUuid).toMatch(/^item-/);
  });

  it('writes the attachment uuid into the metadata it sends', async () => {
    const path = join(dir, 'job.json');
    await saveManifest(path, manifest());
    await runManifest(client, path, { retryDelayMs: 1 });
    expect(mock.state.items[0]!.metadata).toMatch(
      /<BYUI_extended><attachments><attachment>[^<]+<\/attachment>/,
    );
  });

  it('skips entries already created, so re-running is safe', async () => {
    const path = join(dir, 'job.json');
    const m = manifest();
    m.entries[0]!.status = 'created';
    m.entries[0]!.itemUuid = 'item-existing';
    await saveManifest(path, m);
    const summary = await runManifest(client, path, { retryDelayMs: 1 });
    expect(summary.created).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(mock.state.items).toHaveLength(1);
  });

  it('retries a 503 and then succeeds', async () => {
    const path = join(dir, 'job.json');
    await saveManifest(path, manifest());
    mock.state.failItemNext = 1;
    const summary = await runManifest(client, path, { retryDelayMs: 1, maxAttempts: 3 });
    expect(summary.created).toBe(2);
  });

  it('isolates a permanent failure without stopping the batch', async () => {
    const path = join(dir, 'job.json');
    const m = manifest();
    m.entries[0]!.filePath = join(dir, 'does-not-exist.mp4');
    await saveManifest(path, m);
    const summary = await runManifest(client, path, { retryDelayMs: 1 });
    expect(summary.failed).toBe(1);
    expect(summary.created).toBe(1);
    const done = await loadManifest(path);
    expect(done.entries[0]!.status).toBe('failed');
    expect(done.entries[0]!.error).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/runner.test.ts`
Expected: FAIL — cannot resolve `../src/core/runner.js`.

- [ ] **Step 3: Implement `src/core/runner.ts`**

```typescript
import type { OeqClient } from './client.js';
import type { Manifest, ManifestEntry } from './types.js';
import { ATTACHMENT_UUID_XPATH } from './types.js';
import { loadManifest, saveManifest } from './state.js';
import { buildMetadataXml } from './metadata.js';
import { uploadFile } from './upload.js';
import { ApiError } from './errors.js';
import { randomUUID } from 'node:crypto';

export interface RunOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  /** Invoked after each entry so front ends can report progress. */
  onProgress?: (entry: ManifestEntry, done: number, total: number) => void;
}

export interface RunSummary {
  created: number;
  failed: number;
  skipped: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const isRetryable = (err: unknown): boolean =>
  err instanceof ApiError ? err.retryable : false;

async function processEntry(
  client: OeqClient,
  manifest: Manifest,
  entry: ManifestEntry,
): Promise<void> {
  const stagingUuid = await uploadFile(client, entry.filePath, entry.fileName);

  // Generate the attachment uuid locally so the metadata can carry it in the
  // same request. VERIFY the server honours a supplied uuid; if it does not,
  // switch to the two-pass fallback described in the spec.
  const attachmentUuid = randomUUID();

  const metadata = {
    ...entry.metadata,
    [ATTACHMENT_UUID_XPATH]: [attachmentUuid],
  };

  const result = await client.createItem({
    collectionUuid: manifest.collectionUuid,
    metadata: buildMetadataXml(metadata),
    stagingUuid,
    attachments: [
      { filename: entry.fileName, description: entry.fileName, uuid: attachmentUuid },
    ],
    draft: manifest.itemState === 'draft',
  });

  entry.itemUuid = result.uuid;
  entry.itemVersion = result.version;
  entry.attachmentUuid = result.attachmentUuids[0] ?? attachmentUuid;
  entry.status = 'created';
  delete entry.error;
}

export async function runManifest(
  client: OeqClient,
  manifestPath: string,
  opts: RunOptions = {},
): Promise<RunSummary> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 2000;

  const manifest = await loadManifest(manifestPath);
  const summary: RunSummary = { created: 0, failed: 0, skipped: 0 };
  const total = manifest.entries.length;
  let done = 0;

  for (const entry of manifest.entries) {
    done++;

    if (entry.status === 'created' || entry.status === 'skipped') {
      summary.skipped++;
      opts.onProgress?.(entry, done, total);
      continue;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      entry.attempts++;
      entry.status = 'uploading';
      await saveManifest(manifestPath, manifest);
      try {
        await processEntry(client, manifest, entry);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        if (!isRetryable(err) || attempt === maxAttempts) break;
        // Exponential backoff: transient server pressure needs room to clear.
        await sleep(retryDelayMs * 2 ** (attempt - 1));
      }
    }

    if (lastError) {
      entry.status = 'failed';
      entry.error = lastError instanceof Error ? lastError.message : String(lastError);
      summary.failed++;
    } else {
      summary.created++;
    }

    await saveManifest(manifestPath, manifest);
    opts.onProgress?.(entry, done, total);
  }

  return summary;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/runner.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/runner.ts tests/runner.test.ts
git commit -m "feat: resumable runner with per-row isolation and retry"
```

---

## Task 11: CLI (`src/cli/index.ts`)

**Files:**
- Create: `src/cli/index.ts`, `src/core/config.ts`, `tests/config.test.ts`

- [ ] **Step 1: Write the failing test for config**

```typescript
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/core/config.js';

describe('loadConfig', () => {
  it('reads values from the environment', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://example.test',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
      OEQ_COLLECTION_UUID: 'c1',
      OEQ_SCHEMA_UUID: 's1',
    });
    expect(cfg.baseUrl).toBe('https://example.test');
    expect(cfg.collectionUuid).toBe('c1');
  });

  it('names every missing variable at once, not one at a time', () => {
    expect(() => loadConfig({})).toThrow(/OEQ_BASE_URL.*OEQ_CLIENT_ID.*OEQ_CLIENT_SECRET/s);
  });

  it('strips a trailing slash from the base url', () => {
    const cfg = loadConfig({
      OEQ_BASE_URL: 'https://example.test/',
      OEQ_CLIENT_ID: 'id',
      OEQ_CLIENT_SECRET: 'secret',
    });
    expect(cfg.baseUrl).toBe('https://example.test');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/core/config.js`.

- [ ] **Step 3: Implement `src/core/config.ts`**

```typescript
import { OeqError } from './errors.js';

export interface Config {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  collectionUuid: string;
  schemaUuid: string;
}

const DEFAULT_COLLECTION = 'bb348ab1-7a81-4e37-8ef7-adc095ade4f9';
const DEFAULT_SCHEMA = 'c93181f3-a443-41bf-9afe-ac9f7daf90b7';

export function loadConfig(env: Record<string, string | undefined>): Config {
  const required = ['OEQ_BASE_URL', 'OEQ_CLIENT_ID', 'OEQ_CLIENT_SECRET'] as const;
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new OeqError(
      `Missing required environment variables:\n${missing.map((m) => `  ${m}`).join('\n')}\n` +
        `Copy .env.example to .env and fill them in.`,
    );
  }
  return {
    baseUrl: env.OEQ_BASE_URL!.replace(/\/+$/, ''),
    clientId: env.OEQ_CLIENT_ID!,
    clientSecret: env.OEQ_CLIENT_SECRET!,
    collectionUuid: env.OEQ_COLLECTION_UUID ?? DEFAULT_COLLECTION,
    schemaUuid: env.OEQ_SCHEMA_UUID ?? DEFAULT_SCHEMA,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Implement `src/cli/index.ts`**

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../core/config.js';
import { readSheet } from '../core/sheet.js';
import { extractDefinition, parseSchemaPaths } from '../core/schema.js';
import { buildManifest } from '../core/plan.js';
import { saveManifest, loadManifest } from '../core/state.js';
import { OAuthClientCredentials } from '../core/auth.js';
import { OeqClient } from '../core/client.js';
import { runManifest } from '../core/runner.js';
import type { ItemState } from '../core/types.js';

const program = new Command();
program.name('oeq-upload').description('Bulk-create openEQUELLA contributions from files + a spreadsheet');

program
  .command('plan')
  .requiredOption('--sheet <path>', 'metadata spreadsheet (.xlsx or .csv)')
  .requiredOption('--files <dir>', 'directory containing the files')
  .option('--manifest <path>', 'where to write the job manifest', 'job.json')
  .option('--schema-file <path>', 'local schema export', 'schema/_entity.xml')
  .option('--state <state>', 'draft or published', 'draft')
  .action(async (o: { sheet: string; files: string; manifest: string; schemaFile: string; state: string }) => {
    const cfg = loadConfig(process.env);
    const sheet = await readSheet(resolve(o.sheet));
    const paths = parseSchemaPaths(extractDefinition(await readFile(o.schemaFile, 'utf8')));
    const manifest = await buildManifest(sheet, resolve(o.files), paths, {
      baseUrl: cfg.baseUrl,
      collectionUuid: cfg.collectionUuid,
      schemaUuid: cfg.schemaUuid,
      itemState: o.state as ItemState,
    });
    await saveManifest(o.manifest, manifest);
    console.log(`Planned ${manifest.entries.length} item(s) -> ${o.manifest}`);
    for (const w of manifest.warnings) console.log(`  warning: ${w}`);
  });

program
  .command('run')
  .requiredOption('--manifest <path>', 'job manifest from `plan`')
  .action(async (o: { manifest: string }) => {
    const cfg = loadConfig(process.env);
    const client = new OeqClient(
      cfg.baseUrl,
      new OAuthClientCredentials(cfg.baseUrl, cfg.clientId, cfg.clientSecret),
    );
    const summary = await runManifest(client, o.manifest, {
      onProgress: (e, done, total) =>
        console.log(`[${done}/${total}] ${e.fileName} -> ${e.status}${e.error ? `: ${e.error}` : ''}`),
    });
    console.log(`created=${summary.created} failed=${summary.failed} skipped=${summary.skipped}`);
    if (summary.failed > 0) process.exitCode = 1;
  });

program
  .command('status')
  .requiredOption('--manifest <path>', 'job manifest')
  .action(async (o: { manifest: string }) => {
    const m = await loadManifest(o.manifest);
    const counts: Record<string, number> = {};
    for (const e of m.entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
    console.log(JSON.stringify(counts, null, 2));
    for (const e of m.entries.filter((x) => x.status === 'failed')) {
      console.log(`  row ${e.rowNumber} ${e.fileName}: ${e.error ?? 'unknown error'}`);
    }
  });

program
  .command('retry')
  .requiredOption('--manifest <path>', 'job manifest')
  .action(async (o: { manifest: string }) => {
    const m = await loadManifest(o.manifest);
    for (const e of m.entries) {
      if (e.status === 'failed') {
        e.status = 'pending';
        e.attempts = 0;
      }
    }
    await saveManifest(o.manifest, m);
    console.log('Failed entries reset to pending. Run `oeq-upload run` to continue.');
  });

await program.parseAsync(process.argv);
```

- [ ] **Step 6: Verify it builds and the help works**

Run: `npm run build && node dist/cli/index.js --help`
Expected: usage listing `plan`, `run`, `status`, `retry`.

- [ ] **Step 7: Commit**

```bash
git add src/core/config.ts src/cli/index.ts tests/config.test.ts
git commit -m "feat: CLI with plan, run, status, and retry commands"
```

---

## Task 12: MCP server (`src/mcp/index.ts`)

**Files:**
- Create: `src/mcp/index.ts`

No upload tool exists here by design. `oeq_start_job` spawns the CLI runner
detached and returns immediately.

- [ ] **Step 1: Implement `src/mcp/index.ts`**

```typescript
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { loadConfig } from '../core/config.js';
import { readSheet } from '../core/sheet.js';
import { extractDefinition, parseSchemaPaths, validateHeaders, suggest } from '../core/schema.js';
import { buildManifest } from '../core/plan.js';
import { saveManifest, loadManifest } from '../core/state.js';
import type { ItemState } from '../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const server = new McpServer({ name: 'oeq-bulk-uploader', version: '0.1.0' });

const loadPaths = async (schemaFile: string): Promise<Set<string>> =>
  parseSchemaPaths(extractDefinition(await readFile(schemaFile, 'utf8')));

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

server.tool(
  'oeq_list_schema_paths',
  'Search the valid metadata xpaths for this openEQUELLA schema.',
  {
    filter: z.string().optional().describe('Substring or near-match to search for'),
    schemaFile: z.string().default('schema/_entity.xml'),
  },
  async ({ filter, schemaFile }) => {
    const paths = await loadPaths(schemaFile);
    if (!filter) return text([...paths].sort().join('\n'));
    const exact = [...paths].filter((p) => p.toLowerCase().includes(filter.toLowerCase()));
    const near = exact.length > 0 ? [] : suggest(filter, paths, 10);
    return text([...exact, ...near].join('\n') || 'No matching xpaths.');
  },
);

server.tool(
  'oeq_validate_sheet',
  'Check a spreadsheet\'s column headers against the schema. Reports invalid headers with suggestions.',
  {
    sheet: z.string().describe('Path to .xlsx or .csv'),
    schemaFile: z.string().default('schema/_entity.xml'),
  },
  async ({ sheet, schemaFile }) => {
    const parsed = await readSheet(resolve(sheet));
    const { valid, invalid } = validateHeaders(parsed.headers, await loadPaths(schemaFile));
    const lines = [
      `${parsed.rows.length} data row(s), ${parsed.headers.length} column(s).`,
      `Valid headers: ${valid.length}`,
    ];
    if (invalid.length === 0) lines.push('All headers are valid.');
    else
      for (const i of invalid)
        lines.push(
          `INVALID '${i.header}'` +
            (i.suggestions.length > 0 ? ` -- did you mean: ${i.suggestions.join(', ')}?` : ''),
        );
    return text(lines.join('\n'));
  },
);

server.tool(
  'oeq_plan',
  'Validate a spreadsheet against files on disk and write a job manifest. Uploads nothing.',
  {
    sheet: z.string(),
    filesDir: z.string(),
    manifestPath: z.string().default('job.json'),
    itemState: z.enum(['draft', 'published']).default('draft'),
    schemaFile: z.string().default('schema/_entity.xml'),
  },
  async ({ sheet, filesDir, manifestPath, itemState, schemaFile }) => {
    const cfg = loadConfig(process.env);
    const manifest = await buildManifest(
      await readSheet(resolve(sheet)),
      resolve(filesDir),
      await loadPaths(schemaFile),
      {
        baseUrl: cfg.baseUrl,
        collectionUuid: cfg.collectionUuid,
        schemaUuid: cfg.schemaUuid,
        itemState: itemState as ItemState,
      },
    );
    await saveManifest(manifestPath, manifest);
    return text(
      [
        `Planned ${manifest.entries.length} item(s) -> ${manifestPath}`,
        `State: ${manifest.itemState}`,
        ...manifest.warnings.map((w) => `warning: ${w}`),
      ].join('\n'),
    );
  },
);

server.tool(
  'oeq_start_job',
  'Start the upload runner as a detached background process. Returns immediately; poll oeq_job_status.',
  { manifestPath: z.string(), logPath: z.string().default('job.log') },
  async ({ manifestPath, logPath }) => {
    const out = openSync(logPath, 'a');
    const child = spawn(
      process.execPath,
      [join(here, '..', 'cli', 'index.js'), 'run', '--manifest', manifestPath],
      { detached: true, stdio: ['ignore', out, out] },
    );
    child.unref();
    return text(`Started runner pid=${String(child.pid)}. Log: ${logPath}`);
  },
);

server.tool(
  'oeq_job_status',
  'Report progress for a job manifest: counts by status, plus any failures.',
  { manifestPath: z.string() },
  async ({ manifestPath }) => {
    const m = await loadManifest(manifestPath);
    const counts: Record<string, number> = {};
    for (const e of m.entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
    const failures = m.entries
      .filter((e) => e.status === 'failed')
      .map((e) => `  row ${e.rowNumber} ${e.fileName}: ${e.error ?? 'unknown'}`);
    return text([JSON.stringify(counts), ...failures].join('\n'));
  },
);

server.tool(
  'oeq_retry_failed',
  'Reset failed entries to pending so the next run retries them.',
  { manifestPath: z.string() },
  async ({ manifestPath }) => {
    const m = await loadManifest(manifestPath);
    let n = 0;
    for (const e of m.entries) {
      if (e.status === 'failed') {
        e.status = 'pending';
        e.attempts = 0;
        n++;
      }
    }
    await saveManifest(manifestPath, m);
    return text(`Reset ${String(n)} failed entr(ies) to pending.`);
  },
);

await server.connect(new StdioServerTransport());
```

- [ ] **Step 2: Verify it builds and starts**

Run: `npm run build && node -e "import('./dist/mcp/index.js').then(()=>console.log('ok'))" `
Expected: no import errors. (The server blocks on stdio; Ctrl-C to exit.)

- [ ] **Step 3: Register with Claude Code**

```bash
claude mcp add oeq-uploader -- node "c:/Users/milesm/Documents/repos/openEQUELLA Bulk Uploader/dist/mcp/index.js"
```

- [ ] **Step 4: Commit**

```bash
git add src/mcp/index.ts
git commit -m "feat: MCP server exposing plan, launch, and monitor tools"
```

---

## Task 13: Full-suite verification and README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Run the whole suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: all tests pass, no type errors. Do not proceed until both are clean.

- [ ] **Step 2: Write `README.md`**

````markdown
# openEQUELLA Bulk Uploader

Creates one openEQUELLA contribution per file, with that file as its single
attachment.

## Setup

```bash
npm install && npm run build
cp .env.example .env    # then fill in OEQ_CLIENT_ID and OEQ_CLIENT_SECRET
```

## Use

```bash
# 1. Validate and plan. Uploads nothing.
node dist/cli/index.js plan --sheet files/batch.xlsx --files files --manifest job.json

# 2. Review job.json and any warnings, then run.
node dist/cli/index.js run --manifest job.json

# 3. Check progress or failures at any time.
node dist/cli/index.js status --manifest job.json

# 4. Reset failures and run again.
node dist/cli/index.js retry --manifest job.json
```

## Spreadsheet format

Row 1 headers are literal schema xpaths, plus one reserved `attachment name`
column naming the file on disk. Each subsequent row is one contribution.

| attachment name | MWDL/title | MWDL/creators/creator |
| --- | --- | --- |
| `clip.mp4` | My Title | Ann Example |

`BYUI_extended/attachments/attachment` is filled in automatically with the real
attachment uuid; any value in that column is ignored.

## Notes

- Items default to **draft**. The target collection has no moderation workflow,
  so `--state published` puts items live immediately.
- Items are owned by the user the OAuth client is bound to.
````

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup and usage"
git push
```

---

## Task 14: Live smoke test — single file

Do this before any full batch. It is the first contact with the real instance.

- [ ] **Step 1: Prepare a one-row batch**

Copy one real MP4 and its spreadsheet row into a scratch directory. Point
`OEQ_COLLECTION_UUID` at a **test** collection, not the production one.

- [ ] **Step 2: Plan and inspect**

Run: `node dist/cli/index.js plan --sheet scratch/one.csv --files scratch --manifest scratch/job.json`

Open `scratch/job.json`. Confirm the entry's `metadata` contains the expected
xpaths and that `BYUI_extended/attachments/attachment` is absent — the runner adds it.

- [ ] **Step 3: Run**

Run: `node dist/cli/index.js run --manifest scratch/job.json`
Expected: `created=1 failed=0 skipped=0`.

- [ ] **Step 4: Verify in the openEQUELLA UI**

Open the item. Confirm, specifically:

- Title and description match the spreadsheet, quotes intact.
- Exactly **one** attachment, playable, correct byte size.
- `BYUI_extended/attachments/attachment` holds the attachment's uuid — not the
  filename, and not a list.
- Item status is draft.

If the attachment uuid is wrong, the server did not honour the client-supplied
uuid. Switch `runner.ts` to the two-pass fallback from the spec before running a
real batch.

- [ ] **Step 5: Re-run to prove resume is safe**

Run: `node dist/cli/index.js run --manifest scratch/job.json`
Expected: `created=0 failed=0 skipped=1`, and **no** second item in the UI.

---

## Self-review notes

**Spec coverage:** plan/execute split (Tasks 8, 10) · xlsx+csv (2) · xpath validation
with suggestions (3) · live-schema fallback — *see gap below* · metadata XML with
empty tags (4) · attachment uuid substitution (10, 14) · draft/published (8, 11) ·
job-state resume (5, 10) · advisory duplicate scan — *see gap below* · OAuth (6) ·
per-row isolation and retry (10) · staging cleanup (9) · file/row mismatch warnings
(8) · MCP tools (12) · sequential with concurrency option — *see gap below*.

**Known gaps, deliberately deferred:**

1. **Live schema fetch.** Tasks 3 and 11 read the local `schema/_entity.xml` only.
   The spec calls for fetching `/api/schema/{uuid}` with local fallback. Deferred
   because the API response shape is unverified; adding it is a small change to
   `schema.ts` plus one client method once `swagger.json` lands.
2. **Duplicate pre-flight is unwired.** `client.identifierExists()` exists and is
   tested (Task 7) but no task calls it from `plan.ts`. Wire it in once the search
   endpoint is confirmed — it needs a real query syntax to be useful.
3. **`--concurrency` flag.** The runner is sequential, which is the specified
   default. The flag is not implemented; add it only if a real batch proves too slow.

Each is small, isolated, and blocked on the same missing artefact. None prevents a
working first batch.
