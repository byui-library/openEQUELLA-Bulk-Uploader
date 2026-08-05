# Metadata Extractor — Stage 1 (core + CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate the upload spreadsheet from a folder of PDFs and `.docx` files, driven by a reusable profile, usable from the command line.

**Architecture:** All logic lives in `src/core/extract/`, free of CLI, MCP and Electron concerns, per the standing convention. A profile is an ordered list of output columns; each column declares its sources in precedence order. Extraction reads each file independently, fills columns, and writes CSV. Nothing here touches the network.

**Tech Stack:** TypeScript on Node 22, `moduleResolution: nodenext` (relative imports need `.js`), vitest, zod, `pdfjs-dist` (legacy build), `fflate`, `fast-xml-parser`, `exceljs`.

**Spec:** [../specs/2026-08-05-metadata-extractor-design.md](../specs/2026-08-05-metadata-extractor-design.md)

**Branch:** `feature/metadata-extractor` (already created; the spec is committed there)

**Stage 2 (desktop screens) and Stage 3 (MCP tools) get their own plans**, written once this core has run against real files.

---

## Things you must know before starting

You know nothing about this codebase. These are not optional background.

1. **Relative imports need a `.js` extension**, even from `.ts` files. `import { x } from './y.js'` — the file on disk is `y.ts`. This is `moduleResolution: nodenext`. Getting it wrong fails at runtime, not compile time.
2. **`noUncheckedIndexedAccess` is on.** `arr[0]` has type `T | undefined`. You must narrow it. This will feel pedantic; it has caught real bugs here.
3. **Tests live in `tests/`, mirroring `src/`**, named `*.test.ts`. Run with `npm test`.
4. **This project's characteristic failure is a test that agrees with the code and both are wrong.** Two wire-format bugs survived a 240-test suite because the client and its mock shared an assumption. Therefore: **the document readers are tested against real bytes**, never stubs. Task 6 builds those bytes.
5. **Never put real student names in `tests/fixtures/`.** Use obviously fake names.
6. **`attachment name` is a reserved column** already known to `src/core/schema.ts`. It holds the filename on disk and is never metadata.
7. Run `npm run typecheck` before every commit. It is stricter than the test run.

## File structure

| File | Responsibility |
| --- | --- |
| `src/core/extract/types.ts` | Shared types and the `ATTACHMENT_COLUMN` constant. No logic. |
| `src/core/extract/profile.ts` | zod schema, load/save, validation against the real schema xpaths |
| `src/core/extract/pattern.ts` | Compile `{a}_{b}` to a regex; apply it to a filename |
| `src/core/extract/labels.ts` | Find `Label: value` lines in document text |
| `src/core/extract/columns.ts` | Pure add/remove/move/retarget operations on a profile |
| `src/core/extract/readers/docx.ts` | `.docx` → text + properties |
| `src/core/extract/readers/pdf.ts` | PDF → text + properties + `hasTextLayer` |
| `src/core/extract/readers/index.ts` | Dispatch on file extension |
| `src/core/extract/rows.ts` | Build one row: precedence, transform, default, `_source`, `_notes` |
| `src/core/extract/csv.ts` | Serialise rows to CSV |
| `src/core/extract/suggest.ts` | Detect a pattern from filenames; propose a starter profile |
| `src/core/extract/extract.ts` | Walk a folder, read each file, build rows, collect problems |
| `src/cli/extract.ts` | The `extract` command |

Each is small and independently testable. `extract.ts` is the only one that touches the filesystem in bulk, and it takes the readers as an injectable parameter so the orchestration can be tested without real files.

---

## Task 1: Types and constants

**Files:**

- Create: `src/core/extract/types.ts`
- Test: none (types only; exercised by every later task)

- [ ] **Step 1: Create the types file**

```ts
// src/core/extract/types.ts

/** The reserved column naming the file on disk. Always first, never removable. */
export const ATTACHMENT_COLUMN = 'attachment name';

/** Document properties we read, normalised across PDF and .docx. */
export type DocumentProperty = 'title' | 'author' | 'subject' | 'keywords' | 'created';

export const DOCUMENT_PROPERTIES: readonly DocumentProperty[] = [
  'title',
  'author',
  'subject',
  'keywords',
  'created',
];

/**
 * Where a column's value can come from. Tried in the order they appear in
 * `Column.sources`; the first non-empty result wins and nothing later
 * overwrites it.
 */
export type Source =
  /** A single `{placeholder}` from the filename pattern. */
  | { placeholder: string }
  /** Several placeholders combined, e.g. "{last}, {first}". */
  | { join: string }
  /** A `Label:` line found in the document text. */
  | { label: string }
  /** An embedded document property. */
  | { property: DocumentProperty }
  /** The filename itself, verbatim. Only used by ATTACHMENT_COLUMN. */
  | { filename: true };

export interface Column {
  /** A schema xpath, or ATTACHMENT_COLUMN. Becomes the spreadsheet header. */
  path: string;
  sources: Source[];
  /** Used when every source came back empty. A column with no sources and a default is a constant. */
  default?: string;
  /** Normalise a recognised date to YYYY-MM-DD. Never discards an unrecognised value. */
  transform?: 'date';
  /** True only for ATTACHMENT_COLUMN. Blocks removal, reordering and retargeting. */
  locked?: boolean;
}

export interface Profile {
  version: 1;
  /** e.g. "{last}_{first}_{title}_{date}.pdf" */
  pattern: string;
  columns: Column[];
}

/** What a reader returns for one file. */
export interface DocumentData {
  /** Extracted text. Empty string when there is none. */
  text: string;
  /** False for a scanned PDF with no text layer. */
  hasTextLayer: boolean;
  properties: Partial<Record<DocumentProperty, string>>;
}

/** One output row, before serialisation. */
export interface ExtractedRow {
  /** Keyed by column path. Every column in the profile is present, possibly empty. */
  cells: Record<string, string>;
  /** Column path -> which source filled it. Only filled columns appear. */
  sources: Record<string, string>;
  /** Human-readable problems with this row. */
  notes: string[];
}

export interface ExtractResult {
  rows: ExtractedRow[];
  /** Files that could not be read at all, with the reason. */
  skipped: { file: string; reason: string }[];
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: clean, no output.

- [ ] **Step 3: Commit**

```bash
git add src/core/extract/types.ts
git commit -m "feat(extract): types for profiles, sources and extracted rows"
```

---

## Task 2: Filename pattern

**Files:**

- Create: `src/core/extract/pattern.ts`
- Test: `tests/extract/pattern.test.ts`

**Behaviour to implement:** compile `{last}_{first}.pdf` into an anchored regex where every placeholder is **lazy** (`(.+?)`). Lazy matching means leftmost placeholders take as little as possible, so any extra separators fall into the **last** placeholder. That is a real limitation — `Smith_Jane_Senior_Recital_2026-04-12.pdf` against `{last}_{first}_{title}_{date}.pdf` yields `title=Senior`, `date=Recital_2026-04-12`. It is chosen because it is *predictable*: one rule, always the same, and the preview shows the result before anything is written. Do not try to be clever here.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extract/pattern.test.ts
import { describe, it, expect } from 'vitest';
import { placeholders, applyPattern } from '../../src/core/extract/pattern.js';

describe('placeholders', () => {
  it('lists the placeholder names in order', () => {
    expect(placeholders('{last}_{first}_{title}.pdf')).toEqual(['last', 'first', 'title']);
  });

  it('returns an empty list when there are none', () => {
    expect(placeholders('report.pdf')).toEqual([]);
  });

  it('rejects a duplicated placeholder', () => {
    expect(() => placeholders('{a}_{a}.pdf')).toThrow(/duplicate/i);
  });
});

describe('applyPattern', () => {
  it('extracts each placeholder', () => {
    expect(applyPattern('{last}_{first}_{title}_{date}.pdf', 'Smith_Jane_Recital_2026-04-12.pdf'))
      .toEqual({ last: 'Smith', first: 'Jane', title: 'Recital', date: '2026-04-12' });
  });

  it('returns null when the filename does not match', () => {
    expect(applyPattern('{last}_{first}.pdf', 'nosuchseparator.pdf')).toBeNull();
  });

  it('is case-insensitive about the extension', () => {
    expect(applyPattern('{name}.pdf', 'Report.PDF')).toEqual({ name: 'Report' });
  });

  it('treats regex metacharacters in the literal parts as literals', () => {
    expect(applyPattern('{a}+{b}.pdf', 'x+y.pdf')).toEqual({ a: 'x', b: 'y' });
  });

  it('puts extra separators in the last placeholder, because matching is lazy', () => {
    expect(applyPattern('{last}_{first}_{title}.pdf', 'Smith_Jane_Senior_Recital.pdf'))
      .toEqual({ last: 'Smith', first: 'Jane', title: 'Senior_Recital' });
  });

  it('does not match a placeholder to an empty string', () => {
    expect(applyPattern('{a}_{b}.pdf', '_x.pdf')).toBeNull();
  });

  // Guards the trailing `$` anchor. Without it a filename that merely STARTS
  // like the pattern matches, silently producing partial, wrong metadata --
  // and every other "no match" test here fails for a different reason
  // (missing separator, empty capture), so none of them would notice.
  it('does not match when the filename has extra trailing characters', () => {
    expect(applyPattern('{name}.pdf', 'Report.pdfExtra')).toBeNull();
    expect(applyPattern('{last}_{first}.pdf', 'Smith_Jane.pdf.bak')).toBeNull();
  });
});
```

This last test was added after a mutation pass found that deleting the `$`
anchor broke nothing. **Expect 10 tests, not 9.**

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extract/pattern.test.ts`
Expected: FAIL — cannot find module `pattern.js`.

- [ ] **Step 3: Implement**

```ts
// src/core/extract/pattern.ts
import { ValidationError } from '../errors.js';

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** The placeholder names in a pattern, in order. Throws if one is repeated. */
export function placeholders(pattern: string): string[] {
  const names = [...pattern.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) {
      // Wording matches sheet.ts's "Duplicate column headers" -- same problem,
      // same word, so the two errors read as one family.
      throw new ValidationError(`Duplicate placeholder {${n}}: each name may appear only once in a pattern.`);
    }
    seen.add(n);
  }
  return names;
}

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a pattern to an anchored, case-insensitive regex.
 *
 * Every placeholder becomes a lazy `(.+?)`. Lazy is deliberate: leftmost
 * placeholders take as little as possible, so any unexpected extra separator
 * lands in the final placeholder rather than silently shifting every field
 * along by one. One predictable rule beats a clever one nobody can predict.
 */
function compile(pattern: string): RegExp {
  let source = '^';
  let lastIndex = 0;
  for (const match of pattern.matchAll(PLACEHOLDER)) {
    source += escapeLiteral(pattern.slice(lastIndex, match.index));
    source += '(.+?)';
    lastIndex = match.index + match[0].length;
  }
  source += escapeLiteral(pattern.slice(lastIndex));
  source += '$';
  return new RegExp(source, 'i');
}

/**
 * Apply `pattern` to `filename`. Returns a map of placeholder name to captured
 * text, or null if the filename does not match the pattern at all.
 */
export function applyPattern(pattern: string, filename: string): Record<string, string> | null {
  const names = placeholders(pattern);
  const match = compile(pattern).exec(filename);
  if (!match) return null;

  const result: Record<string, string> = {};
  names.forEach((name, i) => {
    result[name] = match[i + 1] ?? '';
  });
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/extract/pattern.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/extract/pattern.ts tests/extract/pattern.test.ts
git commit -m "feat(extract): compile and apply filename patterns"
```

---

## Task 3: Label scanner

**Files:**

- Create: `src/core/extract/labels.ts`
- Test: `tests/extract/labels.test.ts`

**Behaviour:** find `Label: value` lines in document text. First occurrence of a label wins. A label is a short run of letters and spaces — this deliberately excludes prose sentences that happen to contain a colon.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extract/labels.test.ts
import { describe, it, expect } from 'vitest';
import { findLabels } from '../../src/core/extract/labels.js';

describe('findLabels', () => {
  it('finds labelled lines', () => {
    const text = 'Senior Recital\nPerformer: Jane Smith\nInstrument: Violin\n';
    expect(findLabels(text)).toEqual(
      new Map([
        ['Performer', 'Jane Smith'],
        ['Instrument', 'Violin'],
      ]),
    );
  });

  it('keeps the first occurrence of a repeated label', () => {
    expect(findLabels('Performer: Jane\nPerformer: Someone Else\n').get('Performer')).toBe('Jane');
  });

  it('trims surrounding whitespace', () => {
    expect(findLabels('  Performer  :   Jane Smith   \n').get('Performer')).toBe('Jane Smith');
  });

  it('ignores a line whose label side is a whole sentence', () => {
    const text = 'Please note that the following applies to all students: bring your own stand.';
    expect(findLabels(text).size).toBe(0);
  });

  it('ignores a label with no value', () => {
    expect(findLabels('Performer:\n').size).toBe(0);
  });

  it('keeps colons inside the value', () => {
    expect(findLabels('Time: 7:30 PM\n').get('Time')).toBe('7:30 PM');
  });

  it('returns an empty map for empty text', () => {
    expect(findLabels('').size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extract/labels.test.ts`
Expected: FAIL — cannot find module `labels.js`.

- [ ] **Step 3: Implement**

```ts
// src/core/extract/labels.ts

/**
 * A label is 1-3 words of letters, up to 40 characters. That upper bound is
 * what stops an ordinary sentence containing a colon from being read as a
 * label -- "Please note that the following applies to all students:" is not a
 * field name, and treating it as one would invent metadata out of prose.
 */
const LABEL_LINE = /^\s*([A-Za-z][A-Za-z ]{0,39}?)\s*:\s*(\S.*?)\s*$/;
const MAX_LABEL_WORDS = 3;

/** Find `Label: value` lines. First occurrence of each label wins. */
export function findLabels(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = LABEL_LINE.exec(line);
    if (!match) continue;
    const label = match[1]!;
    const value = match[2]!;
    if (label.trim().split(/\s+/).length > MAX_LABEL_WORDS) continue;
    if (!found.has(label)) found.set(label, value);
  }
  return found;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/extract/labels.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/extract/labels.ts tests/extract/labels.test.ts
git commit -m "feat(extract): find labelled lines in document text"
```

---

## Task 4: Column operations

**Files:**

- Create: `src/core/extract/columns.ts`
- Test: `tests/extract/columns.test.ts`

**Behaviour:** the add / remove / reorder / retarget capability. Every function is **pure** — it returns a new profile and never mutates its input. `ATTACHMENT_COLUMN` is locked: it cannot be removed, moved, or retargeted, and it is always at index 0. This is a data-loss guard, not a nicety: a spreadsheet without that column cannot be uploaded at all.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extract/columns.test.ts
import { describe, it, expect } from 'vitest';
import { addColumn, removeColumn, moveColumn, setSources, setDefault } from '../../src/core/extract/columns.js';
import { ATTACHMENT_COLUMN, type Profile } from '../../src/core/extract/types.js';

function profile(): Profile {
  return {
    version: 1,
    pattern: '{title}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
      { path: 'MWDL/date', sources: [] },
    ],
  };
}

describe('addColumn', () => {
  it('appends a column with no sources', () => {
    const after = addColumn(profile(), 'MWDL/description');
    expect(after.columns.map((c) => c.path)).toEqual([
      ATTACHMENT_COLUMN, 'MWDL/title', 'MWDL/date', 'MWDL/description',
    ]);
    expect(after.columns.at(-1)).toEqual({ path: 'MWDL/description', sources: [] });
  });

  it('rejects a duplicate path', () => {
    expect(() => addColumn(profile(), 'MWDL/title')).toThrow(/already/i);
  });

  it('does not mutate the input', () => {
    const before = profile();
    addColumn(before, 'MWDL/description');
    expect(before.columns).toHaveLength(3);
  });
});

describe('removeColumn', () => {
  it('removes exactly one column', () => {
    const after = removeColumn(profile(), 'MWDL/title');
    expect(after.columns.map((c) => c.path)).toEqual([ATTACHMENT_COLUMN, 'MWDL/date']);
  });

  it('refuses to remove the locked attachment column', () => {
    expect(() => removeColumn(profile(), ATTACHMENT_COLUMN)).toThrow(/required/i);
  });

  it('throws on an unknown path', () => {
    expect(() => removeColumn(profile(), 'MWDL/nope')).toThrow(/not in this profile/i);
  });
});

describe('moveColumn', () => {
  it('moves a column down', () => {
    const after = moveColumn(profile(), 'MWDL/title', 1);
    expect(after.columns.map((c) => c.path)).toEqual([ATTACHMENT_COLUMN, 'MWDL/date', 'MWDL/title']);
  });

  it('moves a column up', () => {
    const after = moveColumn(profile(), 'MWDL/date', -1);
    expect(after.columns.map((c) => c.path)).toEqual([ATTACHMENT_COLUMN, 'MWDL/date', 'MWDL/title']);
  });

  it('will not move a column above the locked attachment column', () => {
    const after = moveColumn(profile(), 'MWDL/title', -1);
    expect(after.columns.map((c) => c.path)).toEqual([ATTACHMENT_COLUMN, 'MWDL/title', 'MWDL/date']);
  });

  it('will not move past the end', () => {
    const after = moveColumn(profile(), 'MWDL/date', 5);
    expect(after.columns.map((c) => c.path)).toEqual([ATTACHMENT_COLUMN, 'MWDL/title', 'MWDL/date']);
  });

  it('refuses to move the locked attachment column', () => {
    expect(() => moveColumn(profile(), ATTACHMENT_COLUMN, 1)).toThrow(/required/i);
  });

  it('changes order without changing any column', () => {
    const before = profile();
    const after = moveColumn(before, 'MWDL/title', 1);
    expect([...after.columns].sort((a, b) => a.path.localeCompare(b.path)))
      .toEqual([...before.columns].sort((a, b) => a.path.localeCompare(b.path)));
  });
});

describe('setSources', () => {
  it('replaces the sources of one column', () => {
    const after = setSources(profile(), 'MWDL/date', [{ label: 'Date' }]);
    expect(after.columns[2]).toEqual({ path: 'MWDL/date', sources: [{ label: 'Date' }] });
  });

  it('refuses to retarget the locked attachment column', () => {
    expect(() => setSources(profile(), ATTACHMENT_COLUMN, [{ label: 'Name' }])).toThrow(/required/i);
  });
});

describe('setDefault', () => {
  it('sets a constant', () => {
    const after = setDefault(profile(), 'MWDL/date', '2026-01-01');
    expect(after.columns[2]?.default).toBe('2026-01-01');
  });

  it('clears the default when given an empty string', () => {
    const withDefault = setDefault(profile(), 'MWDL/date', 'x');
    expect(setDefault(withDefault, 'MWDL/date', '').columns[2]).not.toHaveProperty('default');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extract/columns.test.ts`
Expected: FAIL — cannot find module `columns.js`.

- [ ] **Step 3: Implement**

```ts
// src/core/extract/columns.ts
import { ValidationError } from '../errors.js';
import { ATTACHMENT_COLUMN, type Column, type Profile, type Source } from './types.js';

function indexOf(profile: Profile, path: string): number {
  const i = profile.columns.findIndex((c) => c.path === path);
  if (i === -1) throw new ValidationError(`Column '${path}' is not in this profile.`);
  return i;
}

/**
 * The attachment column names the file on disk. Without it the spreadsheet
 * cannot be uploaded at all, so it is not merely inconvenient to lose -- every
 * mutating operation refuses it.
 */
function assertEditable(path: string): void {
  if (path === ATTACHMENT_COLUMN) {
    throw new ValidationError(
      `'${ATTACHMENT_COLUMN}' is required and cannot be removed, moved or retargeted. ` +
        `It is how each row is matched to its file.`,
    );
  }
}

function replaceAt(profile: Profile, index: number, column: Column): Profile {
  const columns = [...profile.columns];
  columns[index] = column;
  return { ...profile, columns };
}

/** Append a new, empty column. An empty column is legitimate: somewhere to type in Excel. */
export function addColumn(profile: Profile, path: string): Profile {
  if (profile.columns.some((c) => c.path === path)) {
    throw new ValidationError(`Column '${path}' is already in this profile.`);
  }
  return { ...profile, columns: [...profile.columns, { path, sources: [] }] };
}

export function removeColumn(profile: Profile, path: string): Profile {
  assertEditable(path);
  const i = indexOf(profile, path);
  return { ...profile, columns: profile.columns.filter((_, n) => n !== i) };
}

/**
 * Move a column by `delta` positions. Clamped so nothing can land above the
 * locked attachment column at index 0, or past the end. Clamping rather than
 * throwing keeps a held-down arrow key from erroring at the boundary.
 */
export function moveColumn(profile: Profile, path: string, delta: number): Profile {
  assertEditable(path);
  const from = indexOf(profile, path);
  const to = Math.min(Math.max(from + delta, 1), profile.columns.length - 1);
  if (to === from) return profile;

  const columns = [...profile.columns];
  const [moved] = columns.splice(from, 1);
  columns.splice(to, 0, moved!);
  return { ...profile, columns };
}

export function setSources(profile: Profile, path: string, sources: Source[]): Profile {
  assertEditable(path);
  const i = indexOf(profile, path);
  return replaceAt(profile, i, { ...profile.columns[i]!, sources });
}

/** Set a column's fallback value. An empty string clears it. */
export function setDefault(profile: Profile, path: string, value: string): Profile {
  assertEditable(path);
  const i = indexOf(profile, path);
  // Rebuilt field by field rather than by destructuring off `default`, because
  // an unused binding trips `noUnusedLocals`.
  const current = profile.columns[i]!;
  const next: Column = { path: current.path, sources: current.sources };
  if (current.transform !== undefined) next.transform = current.transform;
  if (current.locked !== undefined) next.locked = current.locked;
  if (value !== '') next.default = value;
  return replaceAt(profile, i, next);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/extract/columns.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/extract/columns.ts tests/extract/columns.test.ts
git commit -m "feat(extract): add, remove, reorder and retarget columns"
```

---

## Task 5: Profile schema, load and save

**Files:**

- Create: `src/core/extract/profile.ts`
- Test: `tests/extract/profile.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/extract/profile.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProfile, loadProfile, saveProfile, validateAgainstSchema } from '../../src/core/extract/profile.js';
import { ATTACHMENT_COLUMN, type Profile } from '../../src/core/extract/types.js';

const GOOD = {
  version: 1,
  pattern: '{title}.pdf',
  columns: [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
  ],
};

describe('parseProfile', () => {
  it('accepts a valid profile', () => {
    expect(parseProfile(GOOD).pattern).toBe('{title}.pdf');
  });

  it('rejects an unknown version', () => {
    expect(() => parseProfile({ ...GOOD, version: 2 })).toThrow(/version/i);
  });

  it('rejects duplicate column paths', () => {
    const columns = [...GOOD.columns, { path: 'MWDL/title', sources: [] }];
    expect(() => parseProfile({ ...GOOD, columns })).toThrow(/duplicate/i);
  });

  it('requires the attachment column', () => {
    const columns = GOOD.columns.filter((c) => c.path !== ATTACHMENT_COLUMN);
    expect(() => parseProfile({ ...GOOD, columns })).toThrow(/attachment name/i);
  });

  it('requires the attachment column to be first', () => {
    const columns = [...GOOD.columns].reverse();
    expect(() => parseProfile({ ...GOOD, columns })).toThrow(/first/i);
  });

  it('rejects a source naming a placeholder the pattern does not have', () => {
    const columns = [GOOD.columns[0]!, { path: 'MWDL/title', sources: [{ placeholder: 'nope' }] }];
    expect(() => parseProfile({ ...GOOD, columns })).toThrow(/\{nope\}/);
  });

  it('rejects a join naming a placeholder the pattern does not have', () => {
    const columns = [GOOD.columns[0]!, { path: 'MWDL/title', sources: [{ join: '{a}, {b}' }] }];
    expect(() => parseProfile({ ...GOOD, columns })).toThrow(/\{a\}/);
  });

  it('rejects a column with an empty sources array missing entirely', () => {
    const columns = [GOOD.columns[0]!, { path: 'MWDL/title' }];
    expect(() => parseProfile({ ...GOOD, columns })).toThrow();
  });

  it('accepts a column with no sources and no default -- an empty column', () => {
    const columns = [GOOD.columns[0]!, { path: 'MWDL/description', sources: [] }];
    expect(parseProfile({ ...GOOD, columns }).columns).toHaveLength(2);
  });
});

describe('validateAgainstSchema', () => {
  const paths = new Set(['MWDL/title', 'MWDL/date']);

  it('passes when every path is real', () => {
    expect(validateAgainstSchema(parseProfile(GOOD), paths)).toEqual([]);
  });

  it('reports an unknown path with a suggestion', () => {
    const columns = [GOOD.columns[0]!, { path: 'MWDL/titel', sources: [] }];
    const problems = validateAgainstSchema(parseProfile({ ...GOOD, columns }), paths);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.path).toBe('MWDL/titel');
    expect(problems[0]!.suggestions).toContain('MWDL/title');
  });

  it('never complains about the attachment column', () => {
    expect(validateAgainstSchema(parseProfile(GOOD), new Set())).toEqual([
      { path: 'MWDL/title', suggestions: [] },
    ]);
  });
});

describe('loadProfile / saveProfile', () => {
  it('round-trips through a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-profile-'));
    const path = join(dir, 'p.profile.json');
    await saveProfile(path, parseProfile(GOOD) as Profile);
    expect((await loadProfile(path)).pattern).toBe('{title}.pdf');
  });

  it('writes readable, indented JSON a human can edit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-profile-'));
    const path = join(dir, 'p.profile.json');
    await saveProfile(path, parseProfile(GOOD) as Profile);
    expect(await readFile(path, 'utf8')).toContain('\n  "pattern"');
  });

  it('explains which file was bad when the JSON is malformed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-profile-'));
    const path = join(dir, 'bad.profile.json');
    await writeFile(path, '{ not json', 'utf8');
    await expect(loadProfile(path)).rejects.toThrow(/bad\.profile\.json/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extract/profile.test.ts`
Expected: FAIL — cannot find module `profile.js`.

- [ ] **Step 3: Implement**

```ts
// src/core/extract/profile.ts
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { ValidationError } from '../errors.js';
import { suggest } from '../schema.js';
import { placeholders } from './pattern.js';
import { ATTACHMENT_COLUMN, type DocumentProperty, type Profile } from './types.js';

const PROPERTY_NAMES = ['title', 'author', 'subject', 'keywords', 'created'] as const;

/**
 * Fails to compile if PROPERTY_NAMES drifts from the DocumentProperty union in
 * types.ts -- add a property there and forget this file, and the build stops.
 */
const _propertiesAreExhaustive: DocumentProperty extends (typeof PROPERTY_NAMES)[number] ? true : never = true;
void _propertiesAreExhaustive;

const sourceSchema = z.union([
  z.object({ placeholder: z.string().min(1) }).strict(),
  z.object({ join: z.string().min(1) }).strict(),
  z.object({ label: z.string().min(1) }).strict(),
  z.object({ property: z.enum(PROPERTY_NAMES) }).strict(),
  z.object({ filename: z.literal(true) }).strict(),
]);

const columnSchema = z
  .object({
    path: z.string().min(1),
    sources: z.array(sourceSchema),
    default: z.string().optional(),
    transform: z.literal('date').optional(),
    locked: z.boolean().optional(),
  })
  .strict();

const profileSchema = z
  .object({
    version: z.literal(1),
    pattern: z.string().min(1),
    columns: z.array(columnSchema).min(1),
  })
  .strict();


/** Every `{name}` used inside a join template. */
function joinPlaceholders(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!);
}

/**
 * Parse and fully validate a profile. Everything that can be checked without
 * touching the schema file or the filesystem is checked here, so a bad profile
 * fails at load time rather than after three hundred files.
 */
export function parseProfile(input: unknown): Profile {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(`Profile is not valid:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const profile = parsed.data as Profile;

  const paths = profile.columns.map((c) => c.path);
  const duplicates = paths.filter((p, i) => paths.indexOf(p) !== i);
  if (duplicates.length > 0) {
    throw new ValidationError(`Duplicate column paths: ${[...new Set(duplicates)].join(', ')}`);
  }

  if (paths[0] !== ATTACHMENT_COLUMN) {
    const message = paths.includes(ATTACHMENT_COLUMN)
      ? `'${ATTACHMENT_COLUMN}' must be the first column.`
      : `Profile must include the '${ATTACHMENT_COLUMN}' column -- it is how each row is matched to its file.`;
    throw new ValidationError(message);
  }

  const known = new Set(placeholders(profile.pattern));
  for (const column of profile.columns) {
    for (const source of column.sources) {
      const used =
        'placeholder' in source ? [source.placeholder]
        : 'join' in source ? joinPlaceholders(source.join)
        : [];
      for (const name of used) {
        if (!known.has(name)) {
          throw new ValidationError(
            `Column '${column.path}' uses {${name}}, which the pattern '${profile.pattern}' does not define.`,
          );
        }
      }
    }
  }

  return profile;
}

export interface SchemaProblem {
  path: string;
  suggestions: string[];
}

/**
 * Check every column path against the real schema. Returns problems rather
 * than throwing, so a caller can show all of them at once instead of one per
 * run.
 */
export function validateAgainstSchema(profile: Profile, schemaPaths: Set<string>): SchemaProblem[] {
  return profile.columns
    .filter((c) => c.path !== ATTACHMENT_COLUMN && !schemaPaths.has(c.path))
    .map((c) => ({ path: c.path, suggestions: suggest(c.path, schemaPaths) }));
}

export async function loadProfile(path: string): Promise<Profile> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    throw new ValidationError(`Could not read profile '${path}'.`, { cause });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new ValidationError(`Profile '${path}' is not valid JSON.`, { cause });
  }

  try {
    return parseProfile(json);
  } catch (error) {
    throw new ValidationError(`Profile '${path}' is not valid: ${(error as Error).message}`, { cause: error });
  }
}

/** Write a profile as indented JSON -- it is meant to be opened and edited by hand. */
export async function saveProfile(path: string, profile: Profile): Promise<void> {
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/extract/profile.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/extract/profile.ts tests/extract/profile.test.ts
git commit -m "feat(extract): profile schema, validation, load and save"
```

---

## Task 6: Test fixtures — real files, generated

**Files:**

- Create: `tests/fixtures/extract/make.ts`
- Test: `tests/extract/fixtures.test.ts`

**Why this is its own task:** the readers must be tested against real bytes. A stub reader tested against a stub file proves nothing — that exact mistake let two wire-format bugs through a 240-test suite in this project. These fixtures are generated by committed code so the bytes are reproducible and reviewable, and so no binary blob needs committing.

- [ ] **Step 1: Write the generator**

```ts
// tests/fixtures/extract/make.ts
import { zipSync, strToU8 } from 'fflate';

/**
 * Build a minimal but genuinely valid PDF. Object offsets are computed as the
 * body is assembled, so the xref table is correct -- pdf.js will parse this
 * the same way it parses a real file, which is the entire point of using it
 * instead of a stub.
 */
export function makePdf(options: { text?: string; title?: string; author?: string }): Uint8Array {
  const { text, title, author } = options;

  const escape = (s: string): string => s.replace(/([\\()])/g, '\\$1');
  const content = text === undefined ? '' : `BT /F1 12 Tf 72 720 Td (${escape(text)}) Tj ET`;

  const info: string[] = [];
  if (title !== undefined) info.push(`/Title (${escape(title)})`);
  if (author !== undefined) info.push(`/Author (${escape(author)})`);

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< ${info.join(' ')} >>`,
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefOffset = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return strToU8(body + xref + trailer);
}

/** Build a minimal but valid .docx: a zip holding the two parts we read. */
export function makeDocx(options: { text?: string; title?: string; creator?: string }): Uint8Array {
  const { text = '', title, creator } = options;

  const paragraphs = text
    .split('\n')
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`)
    .join('');

  const core =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    (title === undefined ? '' : `<dc:title>${title}</dc:title>`) +
    (creator === undefined ? '' : `<dc:creator>${creator}</dc:creator>`) +
    `</cp:coreProperties>`;

  const document =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${paragraphs}</w:body></w:document>`;

  return zipSync({
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    ),
    'docProps/core.xml': strToU8(core),
    'word/document.xml': strToU8(document),
  });
}
```

- [ ] **Step 2: Install the new dependencies**

```bash
npm install fflate pdfjs-dist
```

Expected: both added to `dependencies` in `package.json`.

- [ ] **Step 3: Write a test proving the fixtures are real files**

```ts
// tests/extract/fixtures.test.ts
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { makePdf, makeDocx } from '../fixtures/extract/make.js';

describe('makePdf', () => {
  it('produces something that starts with a PDF header and ends with EOF', () => {
    const bytes = strFromU8(makePdf({ text: 'hello' }));
    expect(bytes.startsWith('%PDF-')).toBe(true);
    expect(bytes.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('records a byte offset for every object in the xref table', () => {
    const bytes = strFromU8(makePdf({ text: 'hello' }));
    const entries = bytes.match(/^\d{10} 00000 n $/gm) ?? [];
    expect(entries).toHaveLength(6);
  });
});

describe('makeDocx', () => {
  it('produces a zip containing the two parts the reader needs', () => {
    const entries = Object.keys(unzipSync(makeDocx({ text: 'hello' })));
    expect(entries).toContain('docProps/core.xml');
    expect(entries).toContain('word/document.xml');
  });
});
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/extract/fixtures.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add tests/fixtures/extract/make.ts tests/extract/fixtures.test.ts package.json package-lock.json
git commit -m "test(extract): generate real PDF and .docx fixtures"
```

---

## Task 7: The .docx reader

**Files:**

- Create: `src/core/extract/readers/docx.ts`
- Test: `tests/extract/docx.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/extract/docx.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDocx } from '../../src/core/extract/readers/docx.js';
import { makeDocx } from '../fixtures/extract/make.js';

async function write(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-docx-'));
  const path = join(dir, 'test.docx');
  await writeFile(path, bytes);
  return path;
}

describe('readDocx', () => {
  it('reads body text, one paragraph per line', async () => {
    const doc = await readDocx(await write(makeDocx({ text: 'Senior Recital\nPerformer: Jane Smith' })));
    expect(doc.text).toBe('Senior Recital\nPerformer: Jane Smith');
  });

  it('reads core properties', async () => {
    const doc = await readDocx(await write(makeDocx({ text: 'x', title: 'Recital', creator: 'Jane Smith' })));
    expect(doc.properties.title).toBe('Recital');
    expect(doc.properties.author).toBe('Jane Smith');
  });

  it('reports a text layer even for an empty document, because .docx always has one', async () => {
    expect((await readDocx(await write(makeDocx({ text: '' })))).hasTextLayer).toBe(true);
  });

  it('omits properties that are absent rather than returning empty strings', async () => {
    const doc = await readDocx(await write(makeDocx({ text: 'x' })));
    expect(doc.properties.title).toBeUndefined();
  });

  it('unescapes XML entities in the text', async () => {
    const doc = await readDocx(await write(makeDocx({ text: 'Bach & Handel' })));
    expect(doc.text).toBe('Bach & Handel');
  });

  it('fails with a clear message when the file is not a zip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-docx-'));
    const path = join(dir, 'broken.docx');
    await writeFile(path, 'this is not a zip');
    await expect(readDocx(path)).rejects.toThrow(/not a readable \.docx/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extract/docx.test.ts`
Expected: FAIL — cannot find module `docx.js`.

- [ ] **Step 3: Implement**

```ts
// src/core/extract/readers/docx.ts
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { ValidationError } from '../../errors.js';
import type { DocumentData, DocumentProperty } from '../types.js';

const CORE_PROPS = 'docProps/core.xml';
const DOCUMENT = 'word/document.xml';

/** Map the Dublin Core names Word uses onto our normalised property names. */
const PROPERTY_KEYS: Record<string, DocumentProperty> = {
  'dc:title': 'title',
  'dc:creator': 'author',
  'dc:subject': 'subject',
  'cp:keywords': 'keywords',
  'dcterms:created': 'created',
};

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });

/** Collect the text of every <w:t> in document order, splitting on paragraphs. */
function paragraphText(documentXml: string): string {
  const paragraphs = documentXml.split(/<w:p[ >]/).slice(1);
  return paragraphs
    .map((p) => [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]!).join(''))
    .map((line) => unescapeXml(line))
    .join('\n')
    .trim();
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export async function readDocx(path: string): Promise<DocumentData> {
  const bytes = await readFile(path);

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(bytes));
  } catch (cause) {
    throw new ValidationError(`'${path}' is not a readable .docx file.`, { cause });
  }

  const documentPart = entries[DOCUMENT];
  if (!documentPart) {
    throw new ValidationError(`'${path}' is not a readable .docx file: no ${DOCUMENT} inside.`);
  }

  const properties: Partial<Record<DocumentProperty, string>> = {};
  const corePart = entries[CORE_PROPS];
  if (corePart) {
    const core = parser.parse(strFromU8(corePart)) as Record<string, unknown>;
    const root = core['cp:coreProperties'];
    if (root && typeof root === 'object') {
      for (const [xmlName, key] of Object.entries(PROPERTY_KEYS)) {
        const value = (root as Record<string, unknown>)[xmlName];
        if (typeof value === 'string' && value.trim() !== '') properties[key] = value.trim();
        else if (typeof value === 'number') properties[key] = String(value);
      }
    }
  }

  // A .docx always has a text layer; it may simply be empty. That is a
  // different thing from a scanned PDF, where text is genuinely unavailable.
  return { text: paragraphText(strFromU8(documentPart)), hasTextLayer: true, properties };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/extract/docx.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/extract/readers/docx.ts tests/extract/docx.test.ts
git commit -m "feat(extract): read text and properties from .docx"
```

---

## Task 8: The PDF reader

**Files:**

- Create: `src/core/extract/readers/pdf.ts`
- Test: `tests/extract/pdf.test.ts`

**Note on the import:** use `pdfjs-dist/legacy/build/pdf.mjs`. The default build assumes a browser DOM and fails under Node.

**Corrected during implementation against the installed `pdfjs-dist@6.2.108`.** The import path was right, but two API details in the code below were not, and both were caught by running against real PDF bytes rather than by reading:

- **`destroy()` is on the loading task, not the document.** `getDocument()` returns a `PDFDocumentLoadingTask`; `await task.promise` gives a `PDFDocumentProxy`, which has `cleanup()` but no `destroy()`. Keep a reference to the task and call `task.destroy()` in the `finally`. Calling it on the document throws at runtime.
- **`isEvalSupported` no longer exists** and must be dropped from the `getDocument()` call, or `tsc` fails. This is not a security regression: the option is absent from the whole package in v6, and `new Function(` appears zero times in the legacy build — pdf.js removed the eval-based font path upstream, so the protection is now unconditional rather than opt-in. `useSystemFonts: false` is still valid and is kept.

**Expect a `standardFontDataUrl` warning** on tests that extract text, and an `Indexing all PDF objects` warning on the malformed-input test. Both are non-fatal and expected: this reader extracts text and never renders, so font metrics are irrelevant.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extract/pdf.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPdf } from '../../src/core/extract/readers/pdf.js';
import { makePdf } from '../fixtures/extract/make.js';

async function write(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-pdf-'));
  const path = join(dir, 'test.pdf');
  await writeFile(path, bytes);
  return path;
}

describe('readPdf', () => {
  it('reads the text layer', async () => {
    const doc = await readPdf(await write(makePdf({ text: 'Performer: Jane Smith' })));
    expect(doc.text).toContain('Performer: Jane Smith');
    expect(doc.hasTextLayer).toBe(true);
  });

  it('reads document properties', async () => {
    const doc = await readPdf(await write(makePdf({ text: 'x', title: 'Recital', author: 'Jane Smith' })));
    expect(doc.properties.title).toBe('Recital');
    expect(doc.properties.author).toBe('Jane Smith');
  });

  it('reports no text layer for a page with no text, and does not throw', async () => {
    const doc = await readPdf(await write(makePdf({})));
    expect(doc.hasTextLayer).toBe(false);
    expect(doc.text).toBe('');
  });

  it('still returns properties when there is no text layer', async () => {
    const doc = await readPdf(await write(makePdf({ title: 'Scanned Programme' })));
    expect(doc.hasTextLayer).toBe(false);
    expect(doc.properties.title).toBe('Scanned Programme');
  });

  it('fails with a clear message when the file is not a PDF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-pdf-'));
    const path = join(dir, 'broken.pdf');
    await writeFile(path, 'not a pdf at all');
    await expect(readPdf(path)).rejects.toThrow(/not a readable PDF/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extract/pdf.test.ts`
Expected: FAIL — cannot find module `pdf.js`.

- [ ] **Step 3: Implement**

```ts
// src/core/extract/readers/pdf.ts
import { readFile } from 'node:fs/promises';
import { ValidationError } from '../../errors.js';
import type { DocumentData, DocumentProperty } from '../types.js';

/**
 * A page of a scanned document sometimes carries a few stray characters from
 * a header stamp or a watermark. Treating that as "has a text layer" would
 * send a row down the label-matching path with nothing to match, so require
 * a minimum before believing it.
 */
const MIN_TEXT_LAYER_CHARS = 12;

const PROPERTY_KEYS: Record<string, DocumentProperty> = {
  Title: 'title',
  Author: 'author',
  Subject: 'subject',
  Keywords: 'keywords',
  CreationDate: 'created',
};

interface TextItem {
  str?: string;
}

type PdfModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
/** `getDocument` returns a loading task; its `promise` property resolves to the document. */
type PdfDocument = Awaited<ReturnType<PdfModule['getDocument']>['promise']>;

/**
 * pdf.js ships a browser build by default; the `legacy` build is the one that
 * runs under Node. Imported lazily so that nothing pays its startup cost
 * unless a PDF is actually read.
 */
async function pdfjs(): Promise<PdfModule> {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

export async function readPdf(path: string): Promise<DocumentData> {
  const bytes = await readFile(path);
  const { getDocument } = await pdfjs();

  let doc: PdfDocument;
  try {
    doc = await getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: false,
    }).promise;
  } catch (cause) {
    throw new ValidationError(`'${path}' is not a readable PDF.`, { cause });
  }

  try {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(
        (content.items as TextItem[])
          .map((item) => item.str ?? '')
          .join(' ')
          .replace(/[ \t]+/g, ' ')
          .trim(),
      );
    }

    const text = pages.join('\n').trim();

    const properties: Partial<Record<DocumentProperty, string>> = {};
    const metadata = await doc.getMetadata();
    const info = (metadata.info ?? {}) as Record<string, unknown>;
    for (const [pdfName, key] of Object.entries(PROPERTY_KEYS)) {
      const value = info[pdfName];
      if (typeof value === 'string' && value.trim() !== '') properties[key] = value.trim();
    }

    return { text, hasTextLayer: text.length >= MIN_TEXT_LAYER_CHARS, properties };
  } finally {
    await doc.destroy();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/extract/pdf.test.ts`
Expected: PASS, 5 tests.

If the "no text layer" test fails because the fixture's empty content stream is rejected, check that `makePdf({})` emits `/Length 0` and an empty stream — pdf.js accepts that. Do not weaken the assertion to make it pass.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/extract/readers/pdf.ts tests/extract/pdf.test.ts
git commit -m "feat(extract): read text and properties from PDF, detecting scans"
```

---

## Task 9: Reader dispatch

**Files:**

- Create: `src/core/extract/readers/index.ts`
- Test: `tests/extract/readers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/extract/readers.test.ts
import { describe, it, expect } from 'vitest';
import { isSupported, readDocument, SUPPORTED_EXTENSIONS } from '../../src/core/extract/readers/index.js';

describe('isSupported', () => {
  it('accepts pdf and docx in any case', () => {
    expect(isSupported('a.pdf')).toBe(true);
    expect(isSupported('a.PDF')).toBe(true);
    expect(isSupported('a.docx')).toBe(true);
  });

  it('rejects legacy .doc, which has no reliable reader', () => {
    expect(isSupported('a.doc')).toBe(false);
  });

  it('rejects anything else', () => {
    expect(isSupported('a.mp4')).toBe(false);
    expect(isSupported('noextension')).toBe(false);
  });

  it('lists exactly the extensions it supports', () => {
    expect([...SUPPORTED_EXTENSIONS].sort()).toEqual(['.docx', '.pdf']);
  });
});

describe('readDocument', () => {
  it('refuses an unsupported file by name, without reading it', async () => {
    await expect(readDocument('C:/nonexistent/thing.doc')).rejects.toThrow(/\.doc files/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extract/readers.test.ts`
Expected: FAIL — cannot find module `readers/index.js`.

- [ ] **Step 3: Implement**

```ts
// src/core/extract/readers/index.ts
import { extname } from 'node:path';
import { ValidationError } from '../../errors.js';
import type { DocumentData } from '../types.js';
import { readPdf } from './pdf.js';
import { readDocx } from './docx.js';

export const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx']);

export function isSupported(path: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase());
}

/** A reader, so orchestration can be tested without touching real files. */
export type DocumentReader = (path: string) => Promise<DocumentData>;

export const readDocument: DocumentReader = async (path) => {
  const extension = extname(path).toLowerCase();
  if (extension === '.pdf') return readPdf(path);
  if (extension === '.docx') return readDocx(path);
  if (extension === '.doc') {
    throw new ValidationError(
      `.doc files (Word 2003 and earlier) cannot be read. Open them in Word and save as .docx first.`,
    );
  }
  throw new ValidationError(`Cannot read '${extension || 'a file with no extension'}'.`);
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/extract/readers.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/extract/readers/index.ts tests/extract/readers.test.ts
git commit -m "feat(extract): dispatch to the right reader by extension"
```

---

## Task 10: Row assembly

**Files:**

- Create: `src/core/extract/rows.ts`
- Test: `tests/extract/rows.test.ts`

**This is the heart of the feature.** Precedence, transforms, defaults, `_source` and `_notes` all land here.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extract/rows.test.ts
import { describe, it, expect } from 'vitest';
import { buildRow, normaliseDate } from '../../src/core/extract/rows.js';
import { ATTACHMENT_COLUMN, type DocumentData, type Profile } from '../../src/core/extract/types.js';

const EMPTY_DOC: DocumentData = { text: '', hasTextLayer: true, properties: {} };

const profile: Profile = {
  version: 1,
  pattern: '{last}_{first}_{title}_{date}.pdf',
  columns: [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    { path: 'MWDL/title', sources: [{ placeholder: 'title' }, { label: 'Title' }] },
    { path: 'MWDL/creators/creator', sources: [{ join: '{last}, {first}' }, { label: 'Performer' }] },
    { path: 'MWDL/date', sources: [{ placeholder: 'date' }, { property: 'created' }], transform: 'date' },
    { path: 'MWDL/publisher', sources: [], default: 'BYU-Idaho' },
    { path: 'MWDL/description', sources: [] },
  ],
};

describe('normaliseDate', () => {
  it('passes an ISO date through', () => {
    expect(normaliseDate('2026-04-12')).toBe('2026-04-12');
  });

  it('normalises a long form date', () => {
    expect(normaliseDate('April 12, 2026')).toBe('2026-04-12');
  });

  it('returns null for something that is not a date', () => {
    expect(normaliseDate('Recital_2026')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(normaliseDate('')).toBeNull();
  });
});

describe('buildRow', () => {
  it('fills the attachment column with the filename verbatim', () => {
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', EMPTY_DOC);
    expect(row.cells[ATTACHMENT_COLUMN]).toBe('Smith_Jane_Recital_2026-04-12.pdf');
  });

  it('takes the first non-empty source and does not overwrite it', () => {
    const doc: DocumentData = { ...EMPTY_DOC, text: 'Title: A Different Title\n' };
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', doc);
    expect(row.cells['MWDL/title']).toBe('Recital');
    expect(row.sources['MWDL/title']).toBe('filename');
  });

  it('falls through to a later source when an earlier one is empty', () => {
    const doc: DocumentData = { ...EMPTY_DOC, text: 'Performer: Anna Lee\n' };
    const row = buildRow({ ...profile, pattern: '{title}.pdf' }, 'Recital.pdf', doc);
    expect(row.cells['MWDL/creators/creator']).toBe('Anna Lee');
    expect(row.sources['MWDL/creators/creator']).toBe('label');
  });

  it('joins placeholders', () => {
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', EMPTY_DOC);
    expect(row.cells['MWDL/creators/creator']).toBe('Smith, Jane');
  });

  it('applies a default when every source was empty', () => {
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', EMPTY_DOC);
    expect(row.cells['MWDL/publisher']).toBe('BYU-Idaho');
    expect(row.sources['MWDL/publisher']).toBe('default');
  });

  it('leaves a column with no source and no default empty, without a note', () => {
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', EMPTY_DOC);
    expect(row.cells['MWDL/description']).toBe('');
    expect(row.notes.join(' ')).not.toContain('description');
  });

  it('normalises a date', () => {
    const doc: DocumentData = { ...EMPTY_DOC, properties: { created: 'April 12, 2026' } };
    const row = buildRow({ ...profile, pattern: '{title}.pdf' }, 'Recital.pdf', doc);
    expect(row.cells['MWDL/date']).toBe('2026-04-12');
  });

  it('keeps an unrecognisable date verbatim and says so', () => {
    const row = buildRow(profile, 'Smith_Jane_Senior_Recital_x.pdf', EMPTY_DOC);
    expect(row.cells['MWDL/date']).toBe('x');
    expect(row.notes.join(' ')).toMatch(/not recognised as a date/i);
  });

  it('notes when the filename does not match the pattern, and still returns a row', () => {
    const row = buildRow(profile, 'unmatched.pdf', EMPTY_DOC);
    expect(row.cells[ATTACHMENT_COLUMN]).toBe('unmatched.pdf');
    expect(row.cells['MWDL/title']).toBe('');
    expect(row.notes.join(' ')).toMatch(/does not match the pattern/i);
  });

  it('notes a missing text layer', () => {
    const doc: DocumentData = { ...EMPTY_DOC, hasTextLayer: false };
    const row = buildRow(profile, 'Smith_Jane_Recital_2026-04-12.pdf', doc);
    expect(row.notes.join(' ')).toMatch(/no text layer/i);
  });

  it('includes every profile column, even the empty ones', () => {
    const row = buildRow(profile, 'unmatched.pdf', EMPTY_DOC);
    expect(Object.keys(row.cells)).toEqual(profile.columns.map((c) => c.path));
  });

  it('records sources only for columns that got a value', () => {
    const row = buildRow(profile, 'unmatched.pdf', EMPTY_DOC);
    expect(row.sources['MWDL/title']).toBeUndefined();
    expect(row.sources[ATTACHMENT_COLUMN]).toBe('filename');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extract/rows.test.ts`
Expected: FAIL — cannot find module `rows.js`.

- [ ] **Step 3: Implement**

```ts
// src/core/extract/rows.ts
import { applyPattern } from './pattern.js';
import { findLabels } from './labels.js';
import type { Column, DocumentData, ExtractedRow, Profile, Source } from './types.js';
import { ATTACHMENT_COLUMN } from './types.js';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Normalise a recognised date to YYYY-MM-DD, or return null. Deliberately
 * conservative: only an ISO date or a form Date.parse handles unambiguously.
 * A wrong date is worse than an un-normalised one, and the caller keeps the
 * original either way.
 */
export function normaliseDate(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (ISO_DATE.test(trimmed)) return trimmed;

  // Require a four-digit year somewhere, so that "Recital_2026" and other
  // half-dates are rejected rather than coerced into January the 1st.
  if (!/\b\d{4}\b/.test(trimmed)) return null;
  if (/^\d{4}$/.test(trimmed)) return null;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;

  const year = String(parsed.getFullYear()).padStart(4, '0');
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** A short name for where a value came from, written into the _source column. */
function sourceKind(source: Source): string {
  if ('filename' in source) return 'filename';
  if ('placeholder' in source || 'join' in source) return 'filename';
  if ('label' in source) return 'label';
  return 'properties';
}

interface Context {
  filename: string;
  parts: Record<string, string> | null;
  labels: Map<string, string>;
  doc: DocumentData;
}

function resolve(source: Source, context: Context): string {
  if ('filename' in source) return context.filename;

  if ('placeholder' in source) return context.parts?.[source.placeholder] ?? '';

  if ('join' in source) {
    if (!context.parts) return '';
    const parts = context.parts;
    let missing = false;
    const joined = source.join.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const value = parts[name] ?? '';
      if (value === '') missing = true;
      return value;
    });
    // A join with a hole in it produces "Smith, " -- worse than nothing,
    // because it looks deliberate. Treat it as no value and let the next
    // source have its turn.
    return missing ? '' : joined;
  }

  if ('label' in source) return context.labels.get(source.label) ?? '';

  return context.doc.properties[source.property] ?? '';
}

function fill(column: Column, context: Context, notes: string[]): { value: string; source?: string } {
  for (const source of column.sources) {
    const raw = resolve(source, context).trim();
    if (raw === '') continue;

    if (column.transform === 'date') {
      const normalised = normaliseDate(raw);
      if (normalised === null) {
        notes.push(`${column.path}: '${raw}' was not recognised as a date and was left as found`);
        return { value: raw, source: sourceKind(source) };
      }
      return { value: normalised, source: sourceKind(source) };
    }

    return { value: raw, source: sourceKind(source) };
  }

  if (column.default !== undefined) return { value: column.default, source: 'default' };
  return { value: '' };
}

/**
 * Build one output row. Never throws and never omits a column: a file that
 * yields nothing usable still produces a row, flagged in `notes`. A file
 * missing from the output must be indistinguishable from a file that was
 * never in the folder -- so it never is.
 */
export function buildRow(profile: Profile, filename: string, doc: DocumentData): ExtractedRow {
  const notes: string[] = [];

  const parts = applyPattern(profile.pattern, filename);
  if (parts === null) {
    notes.push(`filename does not match the pattern '${profile.pattern}'`);
  }
  if (!doc.hasTextLayer) {
    notes.push('no text layer -- nothing could be read from inside this file');
  }

  const context: Context = {
    filename,
    parts,
    labels: findLabels(doc.text),
    doc,
  };

  const cells: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const column of profile.columns) {
    const { value, source } = fill(column, context, notes);
    cells[column.path] = column.path === ATTACHMENT_COLUMN ? filename : value;
    if (source !== undefined && cells[column.path] !== '') sources[column.path] = source;
  }

  return { cells, sources, notes };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/extract/rows.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/extract/rows.ts tests/extract/rows.test.ts
git commit -m "feat(extract): build a row with source precedence, defaults and notes"
```

---

## Task 11: CSV writer

**Files:**

- Create: `src/core/extract/csv.ts`
- Test: `tests/extract/csv.test.ts`

**The `_source` and `_notes` columns go here**, appended after the profile's columns. They are `_`-prefixed so the uploader ignores them.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extract/csv.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { writeCsv, NOTES_COLUMN, SOURCE_COLUMN } from '../../src/core/extract/csv.js';
import { ATTACHMENT_COLUMN, type ExtractedRow, type Profile } from '../../src/core/extract/types.js';

const profile: Profile = {
  version: 1,
  pattern: '{title}.pdf',
  columns: [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
  ],
};

function row(cells: Record<string, string>, sources = {}, notes: string[] = []): ExtractedRow {
  return { cells, sources, notes };
}

async function writeAndRead(rows: ExtractedRow[]): Promise<string[][]> {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-csv-'));
  const path = join(dir, 'out.csv');
  await writeCsv(path, profile, rows);
  return parse(await readFile(path, 'utf8'), { relax_column_count_less: true }) as string[][];
}

describe('writeCsv', () => {
  it('writes the profile columns in order, then the notes columns', async () => {
    const records = await writeAndRead([row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': 'A' })]);
    expect(records[0]).toEqual([ATTACHMENT_COLUMN, 'MWDL/title', SOURCE_COLUMN, NOTES_COLUMN]);
  });

  it('writes one line per row', async () => {
    const records = await writeAndRead([
      row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': 'A' }),
      row({ [ATTACHMENT_COLUMN]: 'b.pdf', 'MWDL/title': 'B' }),
    ]);
    expect(records).toHaveLength(3);
    expect(records[2]?.[0]).toBe('b.pdf');
  });

  it('quotes a value containing a comma so columns do not shift', async () => {
    const records = await writeAndRead([row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': 'Smith, Jane' })]);
    expect(records[1]?.[1]).toBe('Smith, Jane');
  });

  it('survives a value containing a quote and a newline', async () => {
    const value = 'He said "hello"\nthen left';
    const records = await writeAndRead([row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': value })]);
    expect(records[1]?.[1]).toBe(value);
  });

  it('renders sources as field=source pairs', async () => {
    const records = await writeAndRead([
      row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': 'A' }, { 'MWDL/title': 'label' }),
    ]);
    expect(records[1]?.[2]).toBe('MWDL/title=label');
  });

  it('joins several notes with a semicolon', async () => {
    const records = await writeAndRead([
      row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': '' }, {}, ['first problem', 'second problem']),
    ]);
    expect(records[1]?.[3]).toBe('first problem; second problem');
  });

  it('writes an empty cell for a column the row has no value for', async () => {
    const records = await writeAndRead([row({ [ATTACHMENT_COLUMN]: 'a.pdf' })]);
    expect(records[1]?.[1]).toBe('');
  });

  it('produces a file the project\'s own sheet reader can read back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-csv-'));
    const path = join(dir, 'out.csv');
    await writeCsv(path, profile, [row({ [ATTACHMENT_COLUMN]: 'a.pdf', 'MWDL/title': 'Smith, Jane' })]);
    const { readSheet } = await import('../../src/core/sheet.js');
    const sheet = await readSheet(path);
    expect(sheet.rows[0]?.cells['MWDL/title']).toBe('Smith, Jane');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extract/csv.test.ts`
Expected: FAIL — cannot find module `csv.js`.

- [ ] **Step 3: Implement**

```ts
// src/core/extract/csv.ts
import ExcelJS from 'exceljs';
import type { ExtractedRow, Profile } from './types.js';

/** Where each value came from. Underscore-prefixed, so the uploader ignores it. */
export const SOURCE_COLUMN = '_source';
/** Problems with this row. Underscore-prefixed, so the uploader ignores it. */
export const NOTES_COLUMN = '_notes';

/**
 * Serialise rows to CSV.
 *
 * Written through exceljs rather than by hand. Correct quoting is the whole
 * job of a CSV writer, and this project has already been bitten once by a
 * malformed row silently shifting every later column into the wrong xpath --
 * see the relax_column_count_less comment in src/core/sheet.ts. Getting that
 * wrong in the writer would produce the same class of failure.
 */
export async function writeCsv(path: string, profile: Profile, rows: ExtractedRow[]): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('extracted');

  const headers = [...profile.columns.map((c) => c.path), SOURCE_COLUMN, NOTES_COLUMN];
  sheet.addRow(headers);

  for (const row of rows) {
    const sources = Object.entries(row.sources)
      .map(([path, kind]) => `${path}=${kind}`)
      .join('; ');
    sheet.addRow([
      ...profile.columns.map((c) => row.cells[c.path] ?? ''),
      sources,
      row.notes.join('; '),
    ]);
  }

  await workbook.csv.writeFile(path);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/extract/csv.test.ts`
Expected: PASS, 8 tests.

The last test is the important one: it proves the writer's output is readable by this project's own `readSheet`, which is the only consumer that matters.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/extract/csv.ts tests/extract/csv.test.ts
git commit -m "feat(extract): write extracted rows to CSV"
```

---

## Task 12: Pattern suggestion

**Files:**

- Create: `src/core/extract/suggest.ts`
- Test: `tests/extract/suggest.test.ts`

**Why:** nobody should face an empty pattern box. Given a folder's filenames, propose a pattern. Stage 2's UI depends on this; the CLI uses it for `--init-profile`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extract/suggest.test.ts
import { describe, it, expect } from 'vitest';
import { detectPattern, starterProfile } from '../../src/core/extract/suggest.js';
import { ATTACHMENT_COLUMN } from '../../src/core/extract/types.js';

describe('detectPattern', () => {
  it('detects underscore-separated parts', () => {
    expect(detectPattern(['Smith_Jane_Recital.pdf', 'Lee_Anna_Jury.pdf'])).toBe('{part1}_{part2}_{part3}.pdf');
  });

  it('detects hyphen-separated parts', () => {
    expect(detectPattern(['a-b-c.pdf', 'd-e-f.pdf'])).toBe('{part1}-{part2}-{part3}.pdf');
  });

  it('prefers the separator that gives a consistent part count', () => {
    expect(detectPattern(['a-1_b.pdf', 'c-2_d.pdf'])).toBe('{part1}_{part2}.pdf');
  });

  it('falls back to a single placeholder when parts are inconsistent', () => {
    expect(detectPattern(['a_b.pdf', 'c_d_e.pdf', 'f.pdf'])).toBe('{part1}.pdf');
  });

  it('uses the extension the files actually have', () => {
    expect(detectPattern(['a_b.docx'])).toBe('{part1}_{part2}.docx');
  });

  it('falls back to .pdf when given nothing', () => {
    expect(detectPattern([])).toBe('{part1}.pdf');
  });

  it('ignores files whose extension differs from the majority', () => {
    expect(detectPattern(['a_b.pdf', 'c_d.pdf', 'notes.txt'])).toBe('{part1}_{part2}.pdf');
  });
});

describe('starterProfile', () => {
  it('always starts with the locked attachment column', () => {
    const profile = starterProfile(['Smith_Jane_Recital.pdf']);
    expect(profile.columns[0]).toEqual({
      path: ATTACHMENT_COLUMN,
      sources: [{ filename: true }],
      locked: true,
    });
  });

  it('proposes only the attachment column, leaving the mapping to the operator', () => {
    const profile = starterProfile(['Smith_Jane_Recital.pdf']);
    expect(profile.columns).toHaveLength(1);
    expect(profile.pattern).toBe('{part1}_{part2}_{part3}.pdf');
  });

  it('is a valid profile', async () => {
    const { parseProfile } = await import('../../src/core/extract/profile.js');
    expect(() => parseProfile(starterProfile(['a_b.pdf']))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extract/suggest.test.ts`
Expected: FAIL — cannot find module `suggest.js`.

- [ ] **Step 3: Implement**

```ts
// src/core/extract/suggest.ts
import { extname } from 'node:path';
import { ATTACHMENT_COLUMN, type Profile } from './types.js';

const SEPARATORS = ['_', '-', ' '] as const;

function majorityExtension(filenames: string[]): string {
  const counts = new Map<string, number>();
  for (const name of filenames) {
    const extension = extname(name).toLowerCase();
    if (extension === '') continue;
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  let best = '.pdf';
  let bestCount = 0;
  for (const [extension, count] of counts) {
    if (count > bestCount) {
      best = extension;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Propose a pattern from real filenames. Picks the separator that splits every
 * file into the same number of parts -- consistency is the signal that a
 * separator is structural rather than incidental. Falls back to one
 * placeholder covering the whole name, which always matches and is honest
 * about having found no structure.
 */
export function detectPattern(filenames: string[]): string {
  const extension = majorityExtension(filenames);
  const stems = filenames
    .filter((n) => extname(n).toLowerCase() === extension)
    .map((n) => n.slice(0, n.length - extname(n).length));

  if (stems.length === 0) return `{part1}${extension}`;

  let bestSeparator: string | null = null;
  let bestCount = 1;
  for (const separator of SEPARATORS) {
    const counts = new Set(stems.map((s) => s.split(separator).length));
    if (counts.size !== 1) continue;
    const count = [...counts][0]!;
    if (count > bestCount) {
      bestSeparator = separator;
      bestCount = count;
    }
  }

  if (bestSeparator === null) return `{part1}${extension}`;

  const parts = Array.from({ length: bestCount }, (_, i) => `{part${i + 1}}`);
  return parts.join(bestSeparator) + extension;
}

/**
 * A profile that is valid and runnable immediately: the attachment column and
 * nothing else. Columns are added by the operator, who is the only one who
 * knows what each filename part means.
 */
export function starterProfile(filenames: string[]): Profile {
  return {
    version: 1,
    pattern: detectPattern(filenames),
    columns: [{ path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true }],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/extract/suggest.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/extract/suggest.ts tests/extract/suggest.test.ts
git commit -m "feat(extract): propose a filename pattern from real filenames"
```

---

## Task 13: Folder orchestration

**Files:**

- Create: `src/core/extract/extract.ts`
- Test: `tests/extract/extract.test.ts`

**Reader injection:** `extractFolder` takes a `DocumentReader`. That is what lets orchestration be tested without real files, while the readers themselves are tested against real bytes in Tasks 7 and 8. Neither shortcut is taken alone.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extract/extract.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFolder } from '../../src/core/extract/extract.js';
import { ATTACHMENT_COLUMN, type DocumentData, type Profile } from '../../src/core/extract/types.js';

const profile: Profile = {
  version: 1,
  pattern: '{title}.pdf',
  columns: [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
  ],
};

const emptyDoc: DocumentData = { text: '', hasTextLayer: true, properties: {} };

async function folderWith(names: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-extract-'));
  for (const name of names) await writeFile(join(dir, name), 'x');
  return dir;
}

describe('extractFolder', () => {
  it('produces one row per supported file, sorted by name', async () => {
    const dir = await folderWith(['b.pdf', 'a.pdf']);
    const result = await extractFolder(dir, profile, { reader: async () => emptyDoc });
    expect(result.rows.map((r) => r.cells[ATTACHMENT_COLUMN])).toEqual(['a.pdf', 'b.pdf']);
  });

  it('skips unsupported files and says why', async () => {
    const dir = await folderWith(['a.pdf', 'notes.txt', 'old.doc']);
    const result = await extractFolder(dir, profile, { reader: async () => emptyDoc });
    expect(result.rows).toHaveLength(1);
    expect(result.skipped.map((s) => s.file).sort()).toEqual(['notes.txt', 'old.doc']);
    expect(result.skipped.find((s) => s.file === 'old.doc')?.reason).toMatch(/\.docx/i);
  });

  it('keeps going when one file fails to read, and records the failure', async () => {
    const dir = await folderWith(['good.pdf', 'bad.pdf']);
    const reader = vi.fn(async (path: string) => {
      if (path.endsWith('bad.pdf')) throw new Error('corrupt');
      return emptyDoc;
    });
    const result = await extractFolder(dir, profile, { reader });
    expect(result.rows).toHaveLength(1);
    expect(result.skipped).toEqual([{ file: 'bad.pdf', reason: 'corrupt' }]);
  });

  it('reports progress for every file it reads', async () => {
    const dir = await folderWith(['a.pdf', 'b.pdf']);
    const seen: number[] = [];
    await extractFolder(dir, profile, {
      reader: async () => emptyDoc,
      onProgress: (done, total) => {
        seen.push(done);
        expect(total).toBe(2);
      },
    });
    expect(seen).toEqual([1, 2]);
  });

  it('returns empty results for an empty folder rather than throwing', async () => {
    const result = await extractFolder(await folderWith([]), profile, { reader: async () => emptyDoc });
    expect(result).toEqual({ rows: [], skipped: [] });
  });

  it('ignores subdirectories', async () => {
    const dir = await folderWith(['a.pdf']);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'sub.pdf'));
    const result = await extractFolder(dir, profile, { reader: async () => emptyDoc });
    expect(result.rows).toHaveLength(1);
  });

  it('stops early when the signal is aborted', async () => {
    const dir = await folderWith(['a.pdf', 'b.pdf', 'c.pdf']);
    const controller = new AbortController();
    const result = await extractFolder(dir, profile, {
      reader: async () => {
        controller.abort();
        return emptyDoc;
      },
      signal: controller.signal,
    });
    expect(result.rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extract/extract.test.ts`
Expected: FAIL — cannot find module `extract.js`.

- [ ] **Step 3: Implement**

```ts
// src/core/extract/extract.ts
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { buildRow } from './rows.js';
import { isSupported, readDocument, type DocumentReader } from './readers/index.js';
import type { ExtractResult, ExtractedRow, Profile } from './types.js';

export interface ExtractOptions {
  /** Injectable so orchestration can be tested without real files. */
  reader?: DocumentReader;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

function skipReason(filename: string): string {
  const extension = extname(filename).toLowerCase();
  if (extension === '.doc') {
    return 'Word 2003 and earlier (.doc) cannot be read -- save as .docx first';
  }
  return `unsupported file type '${extension || 'none'}'`;
}

/**
 * Read every supported file in `dir` and build one row each.
 *
 * Files are processed one at a time and failures are isolated: a single
 * unreadable PDF must not abort a three-hundred-file run. This mirrors the
 * per-row isolation src/core/runner.ts already uses for uploads.
 */
export async function extractFolder(
  dir: string,
  profile: Profile,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const { reader = readDocument, onProgress, signal } = options;

  const listing = await readdir(dir, { withFileTypes: true });
  const filenames = listing
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const rows: ExtractedRow[] = [];
  const skipped: { file: string; reason: string }[] = [];

  const supported = filenames.filter(isSupported);
  for (const name of filenames.filter((n) => !isSupported(n))) {
    skipped.push({ file: name, reason: skipReason(name) });
  }

  let done = 0;
  for (const name of supported) {
    if (signal?.aborted) break;
    try {
      const doc = await reader(join(dir, name));
      rows.push(buildRow(profile, name, doc));
    } catch (error) {
      skipped.push({ file: name, reason: (error as Error).message });
    }
    done += 1;
    onProgress?.(done, supported.length);
  }

  return { rows, skipped };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/extract/extract.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/extract/extract.ts tests/extract/extract.test.ts
git commit -m "feat(extract): walk a folder, isolating per-file failures"
```

---

## Task 14: The `extract` CLI command

**Files:**

- Create: `src/cli/extract.ts`
- Modify: `src/cli/index.ts` — add the command registration next to the existing `.command('check')` block near line 575
- Test: `tests/extract/cli-extract.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/extract/cli-extract.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExtract } from '../../src/cli/extract.js';
import { saveProfile } from '../../src/core/extract/profile.js';
import { ATTACHMENT_COLUMN, type Profile } from '../../src/core/extract/types.js';
import { makePdf } from '../fixtures/extract/make.js';

const profile: Profile = {
  version: 1,
  pattern: '{title}.pdf',
  columns: [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
  ],
};

async function setup(): Promise<{ dir: string; profilePath: string; out: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-cli-extract-'));
  await writeFile(join(dir, 'Recital.pdf'), makePdf({ text: 'Programme for the evening' }));
  const profilePath = join(dir, 'p.profile.json');
  await saveProfile(profilePath, profile);
  return { dir, profilePath, out: join(dir, 'out.csv') };
}

describe('runExtract', () => {
  it('writes a CSV containing a row per file', async () => {
    const { dir, profilePath, out } = await setup();
    const lines: string[] = [];
    await runExtract({ dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml' }, (m) => lines.push(m));
    expect(await readFile(out, 'utf8')).toContain('Recital.pdf');
  });

  it('reports how many rows it wrote and where', async () => {
    const { dir, profilePath, out } = await setup();
    const lines: string[] = [];
    await runExtract({ dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml' }, (m) => lines.push(m));
    expect(lines.join('\n')).toMatch(/1 row/);
    expect(lines.join('\n')).toContain(out);
  });

  it('writes nothing on --dry-run', async () => {
    const { dir, profilePath, out } = await setup();
    const lines: string[] = [];
    await runExtract(
      { dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml', dryRun: true },
      (m) => lines.push(m),
    );
    expect(await readdir(dir)).not.toContain('out.csv');
    expect(lines.join('\n')).toMatch(/dry run/i);
  });

  it('rejects a profile whose column is not a real schema xpath', async () => {
    const { dir, out } = await setup();
    const bad = join(dir, 'bad.profile.json');
    await saveProfile(bad, {
      ...profile,
      columns: [profile.columns[0]!, { path: 'MWDL/titel', sources: [] }],
    });
    await expect(
      runExtract({ dir, profile: bad, out, schemaFile: 'schema/_entity.xml' }, () => {}),
    ).rejects.toThrow(/MWDL\/titel/);
  });

  it('creates a starter profile with --init-profile and does not extract', async () => {
    const { dir, out } = await setup();
    const created = join(dir, 'new.profile.json');
    const lines: string[] = [];
    await runExtract(
      { dir, profile: created, out, schemaFile: 'schema/_entity.xml', initProfile: true },
      (m) => lines.push(m),
    );
    expect(JSON.parse(await readFile(created, 'utf8')).pattern).toBe('{part1}.pdf');
    expect(await readdir(dir)).not.toContain('out.csv');
  });

  it('lists skipped files so nothing disappears silently', async () => {
    const { dir, profilePath, out } = await setup();
    await writeFile(join(dir, 'notes.txt'), 'x');
    const lines: string[] = [];
    await runExtract({ dir, profile: profilePath, out, schemaFile: 'schema/_entity.xml' }, (m) => lines.push(m));
    expect(lines.join('\n')).toContain('notes.txt');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extract/cli-extract.test.ts`
Expected: FAIL — cannot find module `../../src/cli/extract.js`.

- [ ] **Step 3: Implement the command body**

```ts
// src/cli/extract.ts
import { readFile, readdir } from 'node:fs/promises';
import { OeqError, ValidationError } from '../core/errors.js';
import { extractDefinition, parseSchemaPaths } from '../core/schema.js';
import { loadProfile, saveProfile, validateAgainstSchema } from '../core/extract/profile.js';
import { starterProfile } from '../core/extract/suggest.js';
import { extractFolder } from '../core/extract/extract.js';
import { writeCsv } from '../core/extract/csv.js';

export interface ExtractCliOptions {
  dir: string;
  profile: string;
  out: string;
  schemaFile: string;
  dryRun?: boolean;
  initProfile?: boolean;
}

const PREVIEW_ROWS = 5;

/** `log` is injected so the command is testable without capturing stdout. */
export async function runExtract(
  options: ExtractCliOptions,
  log: (message: string) => void,
): Promise<void> {
  if (options.initProfile) {
    const names = (await readdir(options.dir, { withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name);
    const profile = starterProfile(names);
    await saveProfile(options.profile, profile);
    log(`Wrote a starter profile to ${options.profile}`);
    log(`Detected pattern: ${profile.pattern}`);
    log(`Add columns to it, then run extract again without --init-profile.`);
    return;
  }

  const profile = await loadProfile(options.profile);

  const schemaPaths = parseSchemaPaths(extractDefinition(await readFile(options.schemaFile, 'utf8')));
  const problems = validateAgainstSchema(profile, schemaPaths);
  if (problems.length > 0) {
    const detail = problems
      .map((p) => {
        const hint = p.suggestions.length > 0 ? ` -- did you mean ${p.suggestions.join(', ')}?` : '';
        return `  ${p.path}${hint}`;
      })
      .join('\n');
    throw new ValidationError(`Profile has columns that are not valid schema paths:\n${detail}`);
  }

  const result = await extractFolder(options.dir, profile);

  if (result.skipped.length > 0) {
    log(`Skipped ${result.skipped.length} file(s):`);
    for (const { file, reason } of result.skipped) log(`  ${file} -- ${reason}`);
  }

  const withNotes = result.rows.filter((r) => r.notes.length > 0).length;
  if (withNotes > 0) {
    log(`${withNotes} of ${result.rows.length} row(s) need review -- see the _notes column.`);
  }

  if (options.dryRun) {
    log(`Dry run -- nothing written. First ${PREVIEW_ROWS} row(s):`);
    for (const row of result.rows.slice(0, PREVIEW_ROWS)) {
      const cells = profile.columns.map((c) => `${c.path}=${row.cells[c.path] ?? ''}`).join(' | ');
      log(`  ${cells}`);
    }
    return;
  }

  if (result.rows.length === 0) {
    throw new OeqError(`No readable files found in ${options.dir}; nothing to write.`);
  }

  await writeCsv(options.out, profile, result.rows);
  log(`Wrote ${result.rows.length} row(s) to ${options.out}`);
  log(`Open it, check the _notes column, then use it with 'oeq-upload plan'.`);
}
```

- [ ] **Step 4: Register the command**

In `src/cli/index.ts`, add this import near the other core imports at the top:

```ts
import { runExtract, type ExtractCliOptions } from './extract.js';
```

Then add this command registration immediately after the existing `.command('check')` block (around line 575):

```ts
  program
    .command('extract')
    .description('build a spreadsheet from a folder of PDFs and .docx files')
    .requiredOption('--dir <path>', 'folder of files to read')
    .requiredOption('--profile <path>', 'extraction profile (.profile.json)')
    .option('--out <path>', 'where to write the spreadsheet', 'extracted.csv')
    .option('--schema-file <path>', 'local schema export', 'schema/_entity.xml')
    .option('--dry-run', 'show the first few rows without writing anything')
    .option('--init-profile', 'write a starter profile for this folder, then stop')
    .action(async (o: ExtractCliOptions) => {
      await runExtract(o, (message) => console.log(message));
    });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/extract/cli-extract.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Verify the command is registered**

Run: `npm run build && node dist/cli/index.js extract --help`
Expected: usage text listing `--dir`, `--profile`, `--out`, `--schema-file`, `--dry-run`, `--init-profile`.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/cli/extract.ts src/cli/index.ts tests/extract/cli-extract.test.ts
git commit -m "feat(cli): add the extract command"
```

---

## Task 15: End-to-end test on real files

**Files:**

- Test: `tests/extract/endToEnd.test.ts`

**Why separate:** every prior test exercises one unit. This one runs the whole path — real PDF and `.docx` bytes on disk, through the real readers, to a CSV that this project's own `readSheet` reads back. It is the test that would have caught the class of bug that has bitten this project repeatedly: units that each pass while the assembled whole is wrong.

- [ ] **Step 1: Write the test**

```ts
// tests/extract/endToEnd.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFolder } from '../../src/core/extract/extract.js';
import { writeCsv } from '../../src/core/extract/csv.js';
import { parseProfile } from '../../src/core/extract/profile.js';
import { readSheet } from '../../src/core/sheet.js';
import { ATTACHMENT_COLUMN } from '../../src/core/extract/types.js';
import { makePdf, makeDocx } from '../fixtures/extract/make.js';

describe('extract end to end', () => {
  it('turns a folder of real files into a spreadsheet this tool can read back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oeq-e2e-'));

    await writeFile(
      join(dir, 'Birch_Rowan_Recital_2026-04-12.pdf'),
      makePdf({ text: 'Instrument: Violin', title: 'ignored, filename wins' }),
    );
    await writeFile(
      join(dir, 'Ash_Quinn_Jury_2026-04-13.docx'),
      makeDocx({ text: 'Instrument: Cello', creator: 'ignored, filename wins' }),
    );
    // A scan: no text layer, but a usable filename and a real property.
    await writeFile(join(dir, 'Cedar_Sam_Recital_2026-04-14.pdf'), makePdf({ title: 'Scanned' }));

    // {ext} absorbs the extension, so one pattern covers both .pdf and .docx.
    // Without it, {date} would capture "2026-04-12.pdf" and the date transform
    // would refuse it -- correctly, but uselessly.
    const profile = parseProfile({
      version: 1,
      pattern: '{last}_{first}_{title}_{date}.{ext}',
      columns: [
        { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
        { path: 'MWDL/title', sources: [{ placeholder: 'title' }] },
        { path: 'MWDL/creators/creator', sources: [{ join: '{last}, {first}' }] },
        { path: 'MWDL/date', sources: [{ placeholder: 'date' }], transform: 'date' },
        { path: 'MWDL/subject', sources: [{ label: 'Instrument' }] },
        { path: 'MWDL/publisher', sources: [], default: 'BYU-Idaho' },
      ],
    });

    const result = await extractFolder(dir, profile);
    expect(result.skipped).toEqual([]);
    expect(result.rows).toHaveLength(3);

    const out = join(dir, 'extracted.csv');
    await writeCsv(out, profile, result.rows);

    const sheet = await readSheet(out);
    expect(sheet.rows).toHaveLength(3);

    const byFile = new Map(sheet.rows.map((r) => [r.cells[ATTACHMENT_COLUMN], r.cells]));

    const pdf = byFile.get('Birch_Rowan_Recital_2026-04-12.pdf')!;
    expect(pdf['MWDL/title']).toBe('Recital');
    expect(pdf['MWDL/creators/creator']).toBe('Birch, Rowan');
    expect(pdf['MWDL/date']).toBe('2026-04-12');
    expect(pdf['MWDL/subject']).toBe('Violin');
    expect(pdf['MWDL/publisher']).toBe('BYU-Idaho');

    const docx = byFile.get('Ash_Quinn_Jury_2026-04-13.docx')!;
    expect(docx['MWDL/creators/creator']).toBe('Ash, Quinn');
    expect(docx['MWDL/subject']).toBe('Cello');

    // The scan: filename data survives, the label lookup finds nothing, and
    // the row says why rather than vanishing.
    const scan = byFile.get('Cedar_Sam_Recital_2026-04-14.pdf')!;
    expect(scan['MWDL/title']).toBe('Recital');
    expect(scan['MWDL/subject']).toBe('');
    expect(scan['_notes']).toMatch(/no text layer/i);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/extract/endToEnd.test.ts`
Expected: PASS, 1 test.

The pattern ends `{date}.{ext}` rather than `{date}.pdf`, so one profile covers both file types. `{ext}` is declared but mapped to no column — that is allowed and is the idiomatic way to absorb a varying suffix. If you instead write `{last}_{first}_{title}_{date}` with no extension at all, `{date}` captures `2026-04-12.pdf` and the date transform rejects it. That behaviour is correct and is asserted in Task 10; **do not loosen `applyPattern`'s anchoring to work around it.**

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: all previous tests still pass, plus the new extract tests. Total should be 403 + roughly 100 new.

- [ ] **Step 4: Commit**

```bash
git add tests/extract/endToEnd.test.ts
git commit -m "test(extract): end-to-end over real PDF and .docx bytes"
```

---

## Task 16: Documentation

**Files:**

- Modify: `README.md` — add an "Extracting metadata from files" section after the existing usage section
- Modify: `CLAUDE.md` — add `src/core/extract/` to the repository layout block
- Modify: `docs/SESSION-HANDOFF.md` — record where this stands

- [ ] **Step 1: Add the README section**

Add after the existing CLI usage section:

````markdown
## Extracting metadata from files

Builds the spreadsheet from a folder of PDFs and `.docx` files, so it does not
have to be typed by hand.

```bash
# 1. Look at the folder and write a starter profile
oeq-upload extract --dir ./files --profile music.profile.json --init-profile

# 2. Edit music.profile.json: add a column per metadata field you want
#    (see the columns array; each column says where its value comes from)

# 3. Check what it will produce, without writing anything
oeq-upload extract --dir ./files --profile music.profile.json --dry-run

# 4. Write the spreadsheet
oeq-upload extract --dir ./files --profile music.profile.json --out rows.csv
```

Then **open `rows.csv` and check it** before uploading. Two columns exist for
that purpose and are ignored by the uploader:

- `_source` — where each value came from, as `field=source` pairs
- `_notes` — problems with that row, such as a filename that did not match the
  pattern or a PDF with no text layer

### What it can and cannot read

| | |
| --- | --- |
| PDF with a text layer | Text and document properties |
| Scanned PDF | Filename and document properties only, flagged in `_notes` |
| `.docx` | Text and core properties |
| `.doc` (Word 2003) | Not supported — save as `.docx` first |

There is no OCR. A scanned page yields no text, and the row says so rather than
guessing.

### Known limitation: extra separators

Placeholders match as little as possible, left to right, so an unexpected extra
separator lands in the **last** placeholder. Against
`{last}_{first}_{title}_{date}`, the file `Smith_Jane_Senior_Recital_2026-04-12.pdf`
yields `title=Senior` and `date=Recital_2026-04-12`. Use `--dry-run` to see this
before it reaches a spreadsheet.
````

- [ ] **Step 2: Update the repository layout in `CLAUDE.md`**

Change the `src/core/` line in the layout block to add, immediately below it:

```text
src/core/extract/ Build the spreadsheet from a folder of files. Never touches the network.
```

- [ ] **Step 3: Update the handoff**

Add to `docs/SESSION-HANDOFF.md` under "Where the project is":

```markdown
**Metadata extractor, stage 1 (core + CLI) is complete** on
`feature/metadata-extractor`. `oeq-upload extract` builds a spreadsheet from a
folder of PDFs and `.docx` files, driven by a profile. Stage 2 (desktop screens)
and stage 3 (MCP tools) are specified but not planned; write their plans from
[the design doc](superpowers/specs/2026-08-05-metadata-extractor-design.md)
once this has been run against a real folder.

**Not yet run against real material.** Before trusting it on a batch, point it
at a folder of genuine files with `--dry-run` and read the `_notes` column.
```

- [ ] **Step 4: Verify and commit**

```bash
npm test
npm run typecheck
git add README.md CLAUDE.md docs/SESSION-HANDOFF.md
git commit -m "docs: document the extract command and its limits"
```

---

## Definition of done for Stage 1

- [ ] `npm test` passes, with roughly 100 new tests
- [ ] `npm run typecheck` is clean
- [ ] `oeq-upload extract --help` shows the command
- [ ] The end-to-end test passes over real PDF and `.docx` bytes
- [ ] `README.md` documents the command, its formats, and the lazy-matching limitation
- [ ] Nothing in `src/cli/index.ts` beyond the new command block has changed
- [ ] No file under `src/core/` outside `src/core/extract/` has changed

That last one matters: this stage is purely additive. If a change to
`sheet.ts`, `schema.ts` or `runner.ts` seems necessary, stop and raise it —
the shipped upload path has run in production and is not in scope here.
