# Series Index Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one HTML page (plus CSS and JS) listing a serial's volumes and issues from a search of openEQUELLA, and let staff save it as files for a web server and/or upload it as an openEQUELLA item that a rebuild updates in place.

**Architecture:** Pure core modules in `src/core/seriesIndex/` (collect -> record -> render), two thin I/O modules (files, publish) and one orchestrator (`build.ts`) shared by a new CLI command and a new desktop flow. The desktop main process holds each build by id, so saving and uploading use the exact bytes the operator previewed.

**Tech Stack:** TypeScript on Node, vitest, zod (profiles), commander (CLI), Electron (sandboxed renderer, typed IPC).

**Spec:** [docs/superpowers/specs/2026-11-18-series-index-design.md](../specs/2026-11-18-series-index-design.md)

---

## Read before starting

- `CLAUDE.md` -- especially: the repository is PUBLIC and every name in a test is invented; source files are CRLF, so edit with the Edit tool, never `sed` with `\n`; the renderer may not import `node:*` or `electron` (checked by `tests/desktop/rendererPurity.test.ts`); never put a `style` attribute in rendered markup; never build an instance URL with `new URL('/path', base)` -- use `instanceEndpoint`.
- **Typecheck with `npm run typecheck`** (it covers tests; `npx tsc -p .` does not).
- Run one test file with `npx vitest run <path>`; the whole suite with `npx vitest run`.
- Commit after every task with a message ending in
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Two deliberate deviations from the spec, recorded in it by Task 15

1. **`index.groupPatterns`.** The real Snake River Echoes volumes 16-20 are ONE file each with no issue number (`SRE_1991_Vol20.pdf`), so the sequence patterns (which require `{part}`) never match them and they would land in "not in the series". A template's `index` section may therefore list extra patterns that read only a `{group}` (`"{year}_Vol{group}"`), tried after the sequence patterns. Configuration, not code.
2. **The desktop preview is a list, not an iframe.** The app's CSP (`default-src 'self'`) and the sandbox make an embedded copy of the page fragile for no gain; the preview shows the same substance (volumes, issue labels, counts) in the app's own markup. Saved files can be opened in a browser.

## File structure

| File | Responsibility |
|---|---|
| `src/core/extract/sequenceChecks.ts` (modify) | export `readName` -- what one file name says (parts, group, years) |
| `src/core/extract/types.ts`, `profile.ts` (modify) | the template's optional `index` section |
| `src/core/seriesIndex/types.ts` | shared types: `IndexHit`, `SeriesIndex`, `IndexFiles`, ... |
| `src/core/seriesIndex/collect.ts` | PURE. search hits + template rule -> volumes, held back, not in series |
| `src/core/seriesIndex/record.ts` | PURE. template `index` section + schema -> the index item's record |
| `src/core/seriesIndex/assets.ts` | the constant CSS and JS |
| `src/core/seriesIndex/render.ts` | PURE. `SeriesIndex` -> the three files |
| `src/core/seriesIndex/files.ts` | write the three files to a folder, never replacing without consent |
| `src/core/seriesIndex/publish.ts` | find the existing index item; create or edit it |
| `src/core/seriesIndex/build.ts` | orchestration shared by CLI and desktop; preview lines |
| `src/core/client.ts` (modify) | `searchCollection`, `findByField`, `getItemBean`, `editItem` |
| `src/cli/indexPage.ts` + `src/cli/index.ts` (modify) | `oeq-upload index` |
| `templates/snake-river-echoes.profile.json` (modify) | its `index` section |
| `src/desktop/ipc.ts`, `preload.cts` (modify) | four channels and their types |
| `src/desktop/indexHandlers.ts` + `handlers.ts` (modify) | main-process side; builds held by id |
| `src/desktop/ui/seriesIndex/state.ts`, `controller.ts`, `screen.ts` | the renderer flow |
| `src/desktop/ui/screens/choose.ts`, `results.ts`, `ui/app.ts` (modify) | "Build an index..." entry points |
| `tests/helpers/mockServer.ts` (modify) | collection listing, field search, item GET/PUT |

---

### Task 1: `readName` -- what one file name says

**Files:**
- Modify: `src/core/extract/sequenceChecks.ts` (function `read`, and a new export after it)
- Test: `tests/extract/sequenceChecks.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `tests/extract/sequenceChecks.test.ts`; add `readName` to its import from `../../src/core/extract/sequenceChecks.js`)

```ts
describe('readName', () => {
  const patterns = ['{year}_Vol{group}_No{part}', '{year}_Vol{group}'];

  it('reads part, group and year by the first pattern that matches', () => {
    expect(readName(patterns, 'SRE_1972-73_Vol2_No3.pdf')).toEqual({
      parts: [3],
      group: 2,
      years: { from: 1972, to: 1973 },
    });
  });

  it('reads a combined issue as every part it names', () => {
    expect(readName(patterns, 'SRE_1975_Vol4_No2&3.pdf')?.parts).toEqual([2, 3]);
  });

  it('reads a group with NO parts from a pattern that has no {part}', () => {
    // Without the guard, the part index is -1 and the whole match -- year and
    // group digits -- would be read as part numbers.
    expect(readName(patterns, 'SRE_1991_Vol20.pdf')).toEqual({
      parts: [],
      group: 20,
      years: { from: 1991, to: 1991 },
    });
  });

  it('returns null when no pattern matches', () => {
    expect(readName(patterns, 'SRE_1998_Commemorative.pdf')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** -- `npx vitest run tests/extract/sequenceChecks.test.ts` -> `readName is not a function` (or not exported).

- [ ] **Step 3: Implement.** In `read()`, replace the line that reads the part:

```ts
    const part = match[names.indexOf('part') + 1] ?? '';
```

with:

```ts
    // A pattern with no {part} (an index's group pattern) reads no parts:
    // index -1 + 1 would otherwise be match[0], the whole match.
    const partAt = names.indexOf('part');
    const part = partAt === -1 ? '' : (match[partAt + 1] ?? '');
```

Then add directly after the `read` function:

```ts
/**
 * What one file name says, by the first of `patterns` that matches it: its
 * part numbers (none for a pattern without {part}), its group and its years.
 * Null when no pattern matches. The series index reads published items'
 * file names with this, so a name the extractor's checks accepted is a name
 * the index reads the same way.
 */
export function readName(
  patterns: readonly string[],
  name: string,
): { parts: number[]; group: number | null; years: YearSpan | null } | null {
  return read(patterns.map(compile), name);
}
```

- [ ] **Step 4: Run, expect PASS** -- same command; then `npx vitest run tests/extract` (nothing else changed behaviour: sequence patterns are required to contain `{part}`).

- [ ] **Step 5: Commit** -- `git add src/core/extract/sequenceChecks.ts tests/extract/sequenceChecks.test.ts && git commit -m "feat(extract): readName -- what one file name says, for the series index"`

---

### Task 2: The template's `index` section

**Files:**
- Modify: `src/core/extract/types.ts` (the `Profile` interface, after `checks`)
- Modify: `src/core/extract/profile.ts` (`profileSchema`, `parseProfile`)
- Test: `tests/extract/profile.test.ts`

- [ ] **Step 1: Write the failing tests** (append; `parseProfile` is already imported there)

```ts
describe('the index section', () => {
  const base = {
    version: 1,
    pattern: 'BOX_{group}',
    columns: [{ path: 'attachment name', sources: [{ filename: true }] }],
    checks: { sequence: { patterns: ['Box{group}_F{part}'] } },
  };

  it('accepts columns and group patterns', () => {
    const p = parseProfile({
      ...base,
      index: {
        columns: [{ path: 'DC/title', value: 'Box index' }],
        groupPatterns: ['Box{group}'],
      },
    });
    expect(p.index?.columns[0]).toEqual({ path: 'DC/title', value: 'Box index' });
    expect(p.index?.groupPatterns).toEqual(['Box{group}']);
  });

  it('refuses an unknown key', () => {
    expect(() => parseProfile({ ...base, index: { columns: [{ path: 'DC/title', value: 'x' }], extra: 1 } })).toThrow(
      /not valid/,
    );
  });

  it('refuses an index section without sequence patterns to read volumes with', () => {
    const { checks: _drop, ...noChecks } = base;
    expect(() => parseProfile({ ...noChecks, index: { columns: [{ path: 'DC/title', value: 'x' }] } })).toThrow(
      /checks\.sequence/,
    );
  });

  it('refuses a path named twice', () => {
    expect(() =>
      parseProfile({
        ...base,
        index: { columns: [{ path: 'DC/title', value: 'a' }, { path: 'DC/title', value: 'b' }] },
      }),
    ).toThrow(/names 'DC\/title' twice/);
  });

  it('refuses a group pattern with no {group}', () => {
    expect(() =>
      parseProfile({ ...base, index: { columns: [{ path: 'DC/title', value: 'a' }], groupPatterns: ['Box{part}'] } }),
    ).toThrow(/has no \{group\}/);
  });

  it('refuses a group pattern with a placeholder nothing understands', () => {
    expect(() =>
      parseProfile({
        ...base,
        index: { columns: [{ path: 'DC/title', value: 'a' }], groupPatterns: ['Box{group}_{shelf}'] },
      }),
    ).toThrow(/\{shelf\}/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** -- `npx vitest run tests/extract/profile.test.ts` (the first test fails: `index` is an unknown key under `.strict()`).

- [ ] **Step 3: Implement.**

In `src/core/extract/types.ts`, inside `interface Profile`, after the `checks?: { ... };` member:

```ts
  /**
   * The series index's own record, and how to read a volume from a file the
   * sequence patterns cannot (a volume issued as one file with no issue
   * number). Optional: a template without it is never offered for an index.
   * See core/seriesIndex/ and docs/superpowers/specs/2026-11-18-series-index-design.md.
   */
  index?: {
    /** One literal value per schema path, written as the index item's metadata. */
    columns: { path: string; value: string }[];
    /** Read only a {group} (and optionally {year}); tried after the sequence patterns. */
    groupPatterns?: string[];
  };
```

In `src/core/extract/profile.ts`, inside `profileSchema`'s object, after the `checks: ...optional(),` member:

```ts
    index: z
      .object({
        columns: z.array(z.object({ path: z.string().min(1), value: z.string().min(1) }).strict()).min(1),
        groupPatterns: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
```

In `parseProfile`, directly after the `for (const pattern of profile.checks?.sequence?.patterns ?? [])` loop closes:

```ts
  // The index reads volumes and issues from file names, so it needs the
  // patterns that say how; and it writes one value per path.
  if (profile.index) {
    if (!profile.checks?.sequence) {
      throw new ValidationError(
        'The "index" section needs "checks.sequence": the index reads volumes and issues from ' +
          'file names with those patterns.',
      );
    }
    const seen = new Set<string>();
    for (const column of profile.index.columns) {
      if (seen.has(column.path)) {
        throw new ValidationError(`The "index" section names '${column.path}' twice.`);
      }
      seen.add(column.path);
    }
    for (const pattern of profile.index.groupPatterns ?? []) {
      const names = placeholders(pattern);
      if (!names.includes('group')) {
        throw new ValidationError(`The index group pattern '${pattern}' has no {group}, so it could never find one.`);
      }
      const unknown = names.filter((n) => n !== 'group' && n !== 'year' && n !== 'part');
      if (unknown.length > 0) {
        throw new ValidationError(
          `The index group pattern '${pattern}' uses ${unknown.map((n) => `{${n}}`).join(', ')}; ` +
            `only {group}, {year} and {part} mean anything there.`,
        );
      }
    }
  }
```

- [ ] **Step 4: Run, expect PASS** -- `npx vitest run tests/extract/profile.test.ts tests/extract/templates.test.ts`

- [ ] **Step 5: Commit** -- `git commit -am "feat(profile): an optional index section -- the index item's record and group patterns"` (add `tests/extract/profile.test.ts` if new).

---

### Task 3: Collect -- search hits to volumes

**Files:**
- Create: `src/core/seriesIndex/types.ts`
- Create: `src/core/seriesIndex/collect.ts`
- Test: `tests/seriesIndex/collect.test.ts`

- [ ] **Step 1: Create the types** (`src/core/seriesIndex/types.ts`) -- no test of its own:

```ts
// src/core/seriesIndex/types.ts
/**
 * The series index: one page listing a serial's volumes and their issues,
 * built from a SEARCH of openEQUELLA (never from a job file), so it shows
 * what is actually there. Spec: docs/superpowers/specs/2026-11-18-series-index-design.md
 */

/** One item the search returned, as the index needs to see it. */
export interface IndexHit {
  uuid: string;
  version: number;
  /** `live`, `draft`, `archived`, ... as openEQUELLA reports it. */
  status: string;
  /** Null when the server sent none -- production's search omits it. */
  name: string | null;
  /** FILE attachments only, in the item's own order. */
  files: { filename: string; uuid: string }[];
}

export interface IndexIssue {
  label: string;
  url: string;
}

export interface IndexVolume {
  group: number;
  heading: string;
  itemUrl: string;
  issues: IndexIssue[];
}

/** A volume the page does not list until a person sorts it out. */
export interface HeldBack {
  /** Null when one item's own files disagree about which volume it is. */
  group: number | null;
  reason: string;
  items: { uuid: string; name: string }[];
}

/** An item the search found that is not one of the series' volumes. */
export interface LeftOut {
  uuid: string;
  name: string;
  reason: string;
}

export interface SeriesIndex {
  volumes: IndexVolume[];
  heldBack: HeldBack[];
  notInSeries: LeftOut[];
}

/** The three files, by the names they are saved and attached under. */
export const INDEX_FILE_NAMES = ['index.html', 'index.css', 'index.js'] as const;
export type IndexFileName = (typeof INDEX_FILE_NAMES)[number];
export type IndexFiles = Record<IndexFileName, string>;
```

- [ ] **Step 2: Write the failing tests** (`tests/seriesIndex/collect.test.ts`). Every name is invented (public repository).

```ts
import { describe, it, expect } from 'vitest';
import { collectIndex, issueLabel, fileUrl, itemUrl } from '../../src/core/seriesIndex/collect.js';
import type { IndexHit } from '../../src/core/seriesIndex/types.js';

const BASE = 'https://oeq.example.edu/repo';
const RULE = {
  patterns: ['{year}_Vol{group}_No{part}'],
  groupPatterns: ['{year}_Vol{group}'],
  labels: { part: 'issue', group: 'volume' },
};

const hit = (uuid: string, files: string[], over: Partial<IndexHit> = {}): IndexHit => ({
  uuid,
  version: 1,
  status: 'live',
  name: `Fernbrook Quarterly ${uuid}`,
  files: files.map((filename, i) => ({ filename, uuid: `${uuid}-a${i}` })),
  ...over,
});

describe('collectIndex', () => {
  it('lists volumes in numeric order with issues in attachment order', () => {
    const index = collectIndex(
      [
        hit('v10', ['FQ_1981_Vol10_No1.pdf', 'FQ_1981_Vol10_No2.pdf']),
        hit('v2', ['FQ_1972_Vol2_No1.pdf', 'FQ_1972-73_Vol2_No2.pdf']),
      ],
      RULE,
      BASE,
    );
    expect(index.volumes.map((v) => v.group)).toEqual([2, 10]);
    expect(index.volumes[0]!.issues.map((i) => i.label)).toEqual(['Issue 1 (1972)', 'Issue 2 (1972–1973)']);
    expect(index.volumes[0]!.itemUrl).toBe(`${BASE}/items/v2/0/`);
    expect(index.volumes[0]!.issues[0]!.url).toBe(`${BASE}/items/v2/0/FQ_1972_Vol2_No1.pdf`);
  });

  it('lists draft and live alike', () => {
    const index = collectIndex([hit('a', ['FQ_1971_Vol1_No1.pdf'], { status: 'draft' })], RULE, BASE);
    expect(index.volumes).toHaveLength(1);
  });

  it('leaves out a withdrawn item, saying why', () => {
    const index = collectIndex([hit('a', ['FQ_1971_Vol1_No1.pdf'], { status: 'archived' })], RULE, BASE);
    expect(index.volumes).toEqual([]);
    expect(index.notInSeries).toEqual([{ uuid: 'a', name: 'Fernbrook Quarterly a', reason: 'its status is archived' }]);
  });

  it('holds back a volume two items claim, naming both', () => {
    const index = collectIndex(
      [hit('a', ['FQ_1971_Vol1_No1.pdf']), hit('b', ['FQ_1971_Vol1_No1.pdf']), hit('c', ['FQ_1972_Vol2_No1.pdf'])],
      RULE,
      BASE,
    );
    expect(index.volumes.map((v) => v.group)).toEqual([2]);
    expect(index.heldBack).toEqual([
      {
        group: 1,
        reason: '2 items claim volume 1',
        items: [
          { uuid: 'a', name: 'Fernbrook Quarterly a' },
          { uuid: 'b', name: 'Fernbrook Quarterly b' },
        ],
      },
    ]);
  });

  it('holds back an item whose files name different volumes', () => {
    const index = collectIndex([hit('a', ['FQ_1971_Vol1_No1.pdf', 'FQ_1972_Vol2_No1.pdf'])], RULE, BASE);
    expect(index.heldBack[0]).toEqual({
      group: null,
      reason: 'its files name more than one volume: 1, 2',
      items: [{ uuid: 'a', name: 'Fernbrook Quarterly a' }],
    });
  });

  it('lists an item no pattern fits as not in the series -- the index item itself lands here', () => {
    const index = collectIndex([hit('idx', ['index.html', 'index.css', 'index.js'])], RULE, BASE);
    expect(index.notInSeries).toEqual([
      { uuid: 'idx', name: 'Fernbrook Quarterly idx', reason: "none of its files fits the template's file-name patterns" },
    ]);
  });

  it('reads a one-file volume through a group pattern', () => {
    const index = collectIndex([hit('v20', ['FQ_1991_Vol20.pdf'])], RULE, BASE);
    expect(index.volumes[0]!.group).toBe(20);
    expect(index.volumes[0]!.issues[0]!.label).toBe('FQ_1991_Vol20');
  });

  it('labels an unnumbered file by its stem and keeps its position', () => {
    const index = collectIndex(
      [hit('v27', ['FQ_1998_Vol27_No1.pdf', 'FQ_1998_Vol27_No2.pdf', 'FQ_1998_Commemorative.pdf'])],
      RULE,
      BASE,
    );
    expect(index.volumes[0]!.issues.map((i) => i.label)).toEqual([
      'Issue 1 (1998)',
      'Issue 2 (1998)',
      'FQ_1998_Commemorative',
    ]);
  });

  it('falls back to the label when the server sent no name', () => {
    const index = collectIndex([hit('a', ['FQ_1971_Vol1_No1.pdf'], { name: null })], RULE, BASE);
    expect(index.volumes[0]!.heading).toBe('Volume 1');
  });

  it('encodes a file name in its URL', () => {
    expect(fileUrl(BASE, 'u1', 'FQ_1975_Vol4_No2&3.pdf')).toBe(`${BASE}/items/u1/0/FQ_1975_Vol4_No2%263.pdf`);
    expect(itemUrl(`${BASE}/`, 'u1')).toBe(`${BASE}/items/u1/0/`);
  });
});

describe('issueLabel', () => {
  const labels = { part: 'issue', parts: 'issues', group: 'volume', groups: 'volumes' };
  it('names a run of parts as a span', () => {
    expect(issueLabel({ parts: [2, 3], group: 4, years: { from: 1975, to: 1975 } }, 'x.pdf', labels)).toBe(
      'Issues 2–3 (1975)',
    );
  });
  it('lists parts that are not a run', () => {
    expect(issueLabel({ parts: [1, 3], group: 4, years: null }, 'x.pdf', labels)).toBe('Issues 1, 3');
  });
});
```

- [ ] **Step 3: Run, expect FAIL** -- `npx vitest run tests/seriesIndex/collect.test.ts` -> cannot find module.

- [ ] **Step 4: Implement** (`src/core/seriesIndex/collect.ts`):

```ts
// src/core/seriesIndex/collect.ts
import { readName, resolveLabels } from '../extract/sequenceChecks.js';
import type { SequenceLabels } from '../extract/types.js';
import { instanceEndpoint } from '../instanceUrl.js';
import type { HeldBack, IndexHit, IndexVolume, LeftOut, SeriesIndex } from './types.js';

/**
 * Search hits -> the series' volumes. PURE.
 *
 * NEVER GUESSES. Two items claiming one volume, or one item whose files name
 * two, is HELD BACK and named: nothing here can know which copy is right, and
 * a page offering both -- or a silently chosen one -- is worse than a gap a
 * person can see. An item no pattern fits is LISTED as not in the series.
 *
 * Draft and live are listed alike (operator, 2026-11-18): an item's links do
 * not change with its state. A withdrawn item is left out, saying so.
 */

export interface IndexRule {
  /** The template's `checks.sequence.patterns` -- each has {part}. */
  patterns: readonly string[];
  /** The template's `index.groupPatterns` -- tried after `patterns`. */
  groupPatterns?: readonly string[];
  labels?: Partial<SequenceLabels>;
}

const LISTED = new Set(['live', 'draft']);

/** The item, at whatever its latest version is (`/items/{uuid}/0/`, checked live 2026-11-17). */
export function itemUrl(base: string, uuid: string): string {
  return instanceEndpoint(base, `items/${encodeURIComponent(uuid)}/0/`).href;
}

/** One of its files, at the latest version. */
export function fileUrl(base: string, uuid: string, filename: string): string {
  return instanceEndpoint(base, `items/${encodeURIComponent(uuid)}/0/${encodeURIComponent(filename)}`).href;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const stem = (filename: string) => filename.replace(/\.[^.]+$/, '');
const isRun = (parts: number[]) => parts.every((p, i) => i === 0 || p === parts[i - 1]! + 1);

type Read = ReturnType<typeof readName>;

/** "Issue 2 (1972)", "Issues 2–3", or the file's stem when it states no part. */
export function issueLabel(read: Read, filename: string, labels: SequenceLabels): string {
  if (!read || read.parts.length === 0) return stem(filename);
  const parts = read.parts;
  const numbers =
    parts.length === 1 ? `${parts[0]}` : isRun(parts) ? `${parts[0]}–${parts[parts.length - 1]}` : parts.join(', ');
  const word = capital(parts.length === 1 ? labels.part : labels.parts);
  const years = read.years
    ? ` (${read.years.from === read.years.to ? read.years.from : `${read.years.from}–${read.years.to}`})`
    : '';
  return `${word} ${numbers}${years}`;
}

export function collectIndex(hits: readonly IndexHit[], rule: IndexRule, base: string): SeriesIndex {
  const labels = resolveLabels(rule.labels);
  const patterns = [...rule.patterns, ...(rule.groupPatterns ?? [])];
  const notInSeries: LeftOut[] = [];
  const heldBack: HeldBack[] = [];
  const byGroup = new Map<number, { hit: IndexHit; reads: Read[] }[]>();
  const nameOf = (hit: IndexHit) => hit.name ?? hit.uuid;

  for (const hit of hits) {
    if (!LISTED.has(hit.status)) {
      notInSeries.push({ uuid: hit.uuid, name: nameOf(hit), reason: `its status is ${hit.status}` });
      continue;
    }
    const reads = hit.files.map((f) => readName(patterns, f.filename));
    const groups = [...new Set(reads.flatMap((r) => (r && r.group !== null ? [r.group] : [])))].sort(
      (a, b) => a - b,
    );
    if (groups.length === 0) {
      notInSeries.push({
        uuid: hit.uuid,
        name: nameOf(hit),
        reason: "none of its files fits the template's file-name patterns",
      });
      continue;
    }
    if (groups.length > 1) {
      heldBack.push({
        group: null,
        reason: `its files name more than one ${labels.group}: ${groups.join(', ')}`,
        items: [{ uuid: hit.uuid, name: nameOf(hit) }],
      });
      continue;
    }
    const group = groups[0]!;
    byGroup.set(group, [...(byGroup.get(group) ?? []), { hit, reads }]);
  }

  const volumes: IndexVolume[] = [];
  for (const group of [...byGroup.keys()].sort((a, b) => a - b)) {
    const claims = byGroup.get(group)!;
    if (claims.length > 1) {
      heldBack.push({
        group,
        reason: `${claims.length} items claim ${labels.group} ${group}`,
        items: claims.map((c) => ({ uuid: c.hit.uuid, name: nameOf(c.hit) })),
      });
      continue;
    }
    const { hit, reads } = claims[0]!;
    volumes.push({
      group,
      heading: hit.name ?? `${capital(labels.group)} ${group}`,
      itemUrl: itemUrl(base, hit.uuid),
      issues: hit.files.map((f, i) => ({
        label: issueLabel(reads[i] ?? null, f.filename, labels),
        url: fileUrl(base, hit.uuid, f.filename),
      })),
    });
  }
  return { volumes, heldBack, notInSeries };
}
```

- [ ] **Step 5: Run, expect PASS** -- `npx vitest run tests/seriesIndex/collect.test.ts`, then `npm run typecheck`.

- [ ] **Step 6: Commit** -- `git add src/core/seriesIndex tests/seriesIndex && git commit -m "feat(index): collect -- search hits to volumes, holding back what it cannot decide"`

---

### Task 4: Render -- the three files

**Files:**
- Create: `src/core/seriesIndex/assets.ts`
- Create: `src/core/seriesIndex/render.ts`
- Test: `tests/seriesIndex/render.test.ts`

- [ ] **Step 1: Write the failing tests** (`tests/seriesIndex/render.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { renderIndex } from '../../src/core/seriesIndex/render.js';
import { INDEX_JS } from '../../src/core/seriesIndex/assets.js';
import type { SeriesIndex } from '../../src/core/seriesIndex/types.js';

const index: SeriesIndex = {
  volumes: [
    {
      group: 1,
      heading: 'Fernbrook <Quarterly> "One"',
      itemUrl: 'https://oeq.example.edu/items/u1/0/',
      issues: [{ label: 'Issue 1 (1971)', url: 'https://oeq.example.edu/items/u1/0/FQ_No2%263.pdf' }],
    },
  ],
  heldBack: [],
  notInSeries: [],
};
const page = { title: 'Fernbrook & Co. index', description: 'Every volume <b>so far</b>.', groups: 'volumes' };

describe('renderIndex', () => {
  const files = renderIndex(index, page);
  const html = files['index.html'];

  it('escapes every value it writes', () => {
    expect(html).toContain('Fernbrook &lt;Quarterly&gt; &quot;One&quot;');
    expect(html).toContain('<title>Fernbrook &amp; Co. index</title>');
    expect(html).toContain('Every volume &lt;b&gt;so far&lt;/b&gt;.');
    expect(html).toContain('href="https://oeq.example.edu/items/u1/0/FQ_No2%263.pdf"');
  });

  it('has no inline style, no inline script and no event handler attributes', () => {
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
  });

  it('links the stylesheet and script beside it, relatively', () => {
    expect(html).toContain('<link rel="stylesheet" href="index.css">');
    expect(html).toContain('<script src="index.js"></script>');
  });

  it('gives each volume its searchable text for the filter', () => {
    expect(html).toContain('data-volume="Fernbrook &lt;Quarterly&gt; &quot;One&quot; Issue 1 (1971)"');
    expect(html).toContain('<div id="volumes" data-groups="volumes">');
  });

  it('is deterministic -- the same input gives the same bytes', () => {
    expect(renderIndex(index, page)).toEqual(files);
  });

  it('ships the constant CSS and JS', () => {
    expect(files['index.js']).toBe(INDEX_JS);
    expect(files['index.css']).toContain(':focus-visible');
  });
});

describe('the filter script', () => {
  // Run the shipped text as it is, outside a browser: with no `document` it
  // hands back its matching function instead of wiring up the page.
  const mod: { exports: { matches?: (q: string, t: string) => boolean } } = { exports: {} };
  new Function('module', INDEX_JS)(mod);
  const matches = mod.exports.matches!;

  it('matches case-blind on any part of the text', () => {
    expect(matches('vol 12', 'Fernbrook Vol 12 Issue 1 (1983)')).toBe(true);
    expect(matches('1983', 'Fernbrook Vol 12 Issue 1 (1983)')).toBe(true);
    expect(matches('1990', 'Fernbrook Vol 12 Issue 1 (1983)')).toBe(false);
  });

  it('treats an empty or blank box as matching everything', () => {
    expect(matches('   ', 'anything')).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** -- `npx vitest run tests/seriesIndex/render.test.ts`

- [ ] **Step 3: Implement the assets** (`src/core/seriesIndex/assets.ts`):

```ts
// src/core/seriesIndex/assets.ts
/**
 * The page's stylesheet and script. CONSTANT, so a rebuild with nothing
 * changed produces identical files.
 *
 * The script is a PROGRESSIVE ENHANCEMENT: the page is complete without it.
 * It inserts the filter box itself, so with scripting off there is no dead
 * control. Outside a browser (no `document`) it exports its matching function
 * instead -- which is how the test runs the shipped text rather than a copy.
 */

export const INDEX_CSS = `:root { color-scheme: light dark; --fg: #1b1b1b; --bg: #ffffff; --muted: #555555; --link: #0b57a4; --rule: #d0d0d0; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececec; --bg: #161616; --muted: #b0b0b0; --link: #8cb8ff; --rule: #3a3a3a; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 1rem/1.5 system-ui, sans-serif; }
main { max-width: 48rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
h1 { font-size: 1.75rem; line-height: 1.25; }
h2 { font-size: 1.2rem; margin: 1.5rem 0 0.25rem; }
a { color: var(--link); }
a:focus-visible, input:focus-visible { outline: 3px solid var(--link); outline-offset: 2px; }
ul { margin: 0; padding-left: 1.25rem; }
section { border-top: 1px solid var(--rule); }
.note { color: var(--muted); }
.filter { margin: 1rem 0; }
.filter label { display: block; font-weight: 600; }
.filter input { width: 100%; max-width: 24rem; padding: 0.4rem; font: inherit; }
[hidden] { display: none; }
`;

export const INDEX_JS = `(function () {
  'use strict';
  function normalise(text) { return String(text).toLowerCase().replace(/\\s+/g, ' ').trim(); }
  function matches(query, text) {
    var q = normalise(query);
    return q === '' || normalise(text).indexOf(q) !== -1;
  }
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined') module.exports = { matches: matches };
    return;
  }
  var list = document.getElementById('volumes');
  var volumes = Array.prototype.slice.call(document.querySelectorAll('[data-volume]'));
  if (!list || volumes.length === 0) return;
  var box = document.createElement('div');
  box.className = 'filter';
  var label = document.createElement('label');
  label.htmlFor = 'filter-input';
  label.textContent = 'Filter by name, number or year';
  var input = document.createElement('input');
  input.type = 'search';
  input.id = 'filter-input';
  input.autocomplete = 'off';
  var status = document.createElement('p');
  status.className = 'note';
  status.setAttribute('aria-live', 'polite');
  box.appendChild(label);
  box.appendChild(input);
  box.appendChild(status);
  list.parentNode.insertBefore(box, list);
  var noun = list.getAttribute('data-groups') || 'volumes';
  function update() {
    var shown = 0;
    volumes.forEach(function (v) {
      var hit = matches(input.value, v.getAttribute('data-volume'));
      v.hidden = !hit;
      if (hit) shown += 1;
    });
    status.textContent = 'Showing ' + shown + ' of ' + volumes.length + ' ' + noun + '.';
  }
  input.addEventListener('input', update);
  update();
})();
`;
```

- [ ] **Step 4: Implement render** (`src/core/seriesIndex/render.ts`):

```ts
// src/core/seriesIndex/render.ts
import { INDEX_CSS, INDEX_JS } from './assets.js';
import type { IndexFiles, SeriesIndex } from './types.js';

/**
 * The three files. PURE and DETERMINISTIC -- no date, no counter -- so a
 * rebuild with nothing changed is byte-identical and a diff of two builds
 * shows only real changes.
 *
 * No inline style, no inline script, no event-handler attribute: the page
 * must work under a strict Content-Security-Policy on whatever server
 * receives it. Every value is escaped: names and file names come from
 * openEQUELLA and were typed by people.
 */

export interface PageText {
  title: string;
  description: string;
  /** The plural for the filter's status line: "volumes". */
  groups: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderIndex(index: SeriesIndex, page: PageText): IndexFiles {
  const volumes = index.volumes.map((v) => {
    const searchable = [v.heading, ...v.issues.map((i) => i.label)].join(' ');
    const issues = v.issues.map((i) => `<li><a href="${escapeHtml(i.url)}">${escapeHtml(i.label)}</a></li>`);
    return [
      `<section data-volume="${escapeHtml(searchable)}">`,
      `<h2><a href="${escapeHtml(v.itemUrl)}">${escapeHtml(v.heading)}</a></h2>`,
      '<ul>',
      ...issues,
      '</ul>',
      '</section>',
    ].join('\n');
  });

  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(page.title)}</title>`,
    '<link rel="stylesheet" href="index.css">',
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeHtml(page.title)}</h1>`,
    `<p>${escapeHtml(page.description)}</p>`,
    '<p class="note">Each heading opens the item in openEQUELLA; each entry beneath it opens that file.</p>',
    `<div id="volumes" data-groups="${escapeHtml(page.groups)}">`,
    ...volumes,
    '</div>',
    '</main>',
    '<script src="index.js"></script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');

  return { 'index.html': html, 'index.css': INDEX_CSS, 'index.js': INDEX_JS };
}
```

- [ ] **Step 5: Run, expect PASS** -- `npx vitest run tests/seriesIndex/render.test.ts`; `npm run typecheck`.

- [ ] **Step 6: Commit** -- `git add src/core/seriesIndex tests/seriesIndex && git commit -m "feat(index): render the page, its stylesheet and its filter script"`

---

### Task 5: The index item's record

**Files:**
- Create: `src/core/seriesIndex/record.ts`
- Test: `tests/seriesIndex/record.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { indexRecord } from '../../src/core/seriesIndex/record.js';

const schema = {
  titleHeader: 'DC/title',
  descriptionHeader: 'DC/description',
  paths: new Set(['DC/title', 'DC/description', 'DC/identifier', 'DC/type']),
};
const section = {
  columns: [
    { path: 'DC/title', value: 'Fernbrook Quarterly: index' },
    { path: 'DC/description', value: 'Every volume.' },
    { path: 'DC/identifier', value: 'FQ_index' },
    { path: 'DC/type', value: 'Text' },
  ],
};

describe('indexRecord', () => {
  it('reads title, description, identifier and every field', () => {
    const r = indexRecord(section, schema);
    expect(r.title).toBe('Fernbrook Quarterly: index');
    expect(r.description).toBe('Every volume.');
    expect(r.identifier).toEqual({ path: 'DC/identifier', value: 'FQ_index' });
    expect(r.identifierProblem).toBeNull();
    expect(r.fields).toEqual({
      'DC/title': ['Fernbrook Quarterly: index'],
      'DC/description': ['Every volume.'],
      'DC/identifier': ['FQ_index'],
      'DC/type': ['Text'],
    });
  });

  it('refuses a path the schema does not have', () => {
    expect(() =>
      indexRecord({ columns: [...section.columns, { path: 'DC/nope', value: 'x' }] }, schema),
    ).toThrow(/DC\/nope/);
  });

  it('refuses when the schema declares no name path', () => {
    expect(() => indexRecord(section, { ...schema, titleHeader: null })).toThrow(/name path/);
  });

  it('refuses when the section gives no title', () => {
    expect(() => indexRecord({ columns: section.columns.slice(1) }, schema)).toThrow(/DC\/title/);
  });

  it('refuses when the section gives no description', () => {
    expect(() =>
      indexRecord({ columns: section.columns.filter((c) => c.path !== 'DC/description') }, schema),
    ).toThrow(/DC\/description/);
  });

  it('reports -- never throws -- when the schema has no identifier field', () => {
    const r = indexRecord(
      { columns: section.columns.filter((c) => c.path !== 'DC/identifier') },
      { ...schema, paths: new Set(['DC/title', 'DC/description', 'DC/type']) },
    );
    expect(r.identifier).toBeNull();
    expect(r.identifierProblem).toMatch(/no identifier field/);
  });

  it('reports when the section gives no identifier value', () => {
    const r = indexRecord({ columns: section.columns.filter((c) => c.path !== 'DC/identifier') }, schema);
    expect(r.identifier).toBeNull();
    expect(r.identifierProblem).toMatch(/DC\/identifier/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** -- `npx vitest run tests/seriesIndex/record.test.ts`

- [ ] **Step 3: Implement** (`src/core/seriesIndex/record.ts`):

```ts
// src/core/seriesIndex/record.ts
import { ValidationError } from '../errors.js';
import { resolveIdentifierPath } from '../plan.js';
import type { Profile } from '../extract/types.js';

/**
 * The index item's own catalogue record, from the template's `index`
 * section and the collection's schema. PURE.
 *
 * Title and description are REQUIRED -- the page shows both -- and are read
 * at the paths the schema DECLARES, never at a literal. The identifier is how
 * a rebuild finds the item it is updating; without one the openEQUELLA
 * destination is refused (reported, not thrown) and saving files still works.
 */

export interface IndexSchema {
  titleHeader: string | null;
  descriptionHeader: string | null;
  paths: Set<string>;
}

export interface IndexRecord {
  title: string;
  description: string;
  /** Every column, ready for buildMetadataXml. */
  fields: Record<string, string[]>;
  identifier: { path: string; value: string } | null;
  /** Why the openEQUELLA destination cannot be used; null when it can. */
  identifierProblem: string | null;
}

export function indexRecord(section: NonNullable<Profile['index']>, schema: IndexSchema): IndexRecord {
  const unknown = section.columns.map((c) => c.path).filter((p) => !schema.paths.has(p));
  if (unknown.length > 0) {
    throw new ValidationError(
      `The template's index section names ${unknown.join(', ')}, which this collection's schema does not have.`,
    );
  }
  const value = (path: string) => section.columns.find((c) => c.path === path)?.value;

  if (schema.titleHeader === null) {
    throw new ValidationError("This collection's schema declares no name path, so the index has no title to show.");
  }
  const title = value(schema.titleHeader);
  if (title === undefined) {
    throw new ValidationError(`The template's index section gives no ${schema.titleHeader}, the index's title.`);
  }
  if (schema.descriptionHeader === null) {
    throw new ValidationError("This collection's schema declares no description path, so the index has no description to show.");
  }
  const description = value(schema.descriptionHeader);
  if (description === undefined) {
    throw new ValidationError(
      `The template's index section gives no ${schema.descriptionHeader}, the index's description.`,
    );
  }

  const fields: Record<string, string[]> = {};
  for (const c of section.columns) fields[c.path] = [c.value];

  const identifierPath = resolveIdentifierPath({ titleHeader: schema.titleHeader, paths: schema.paths });
  let identifier: IndexRecord['identifier'] = null;
  let identifierProblem: string | null = null;
  if (identifierPath === null) {
    identifierProblem =
      "This collection's schema has no identifier field, so a rebuild could not find the index item to update. " +
      'Save the page as files instead.';
  } else {
    const id = value(identifierPath);
    if (id === undefined) {
      identifierProblem =
        `The template's index section gives no ${identifierPath}, which is how a rebuild finds the index item ` +
        'to update. Add it to the template, or save the page as files instead.';
    } else {
      identifier = { path: identifierPath, value: id };
    }
  }
  return { title, description, fields, identifier, identifierProblem };
}
```

- [ ] **Step 4: Run, expect PASS**; `npm run typecheck`.

- [ ] **Step 5: Commit** -- `git add src/core/seriesIndex/record.ts tests/seriesIndex/record.test.ts && git commit -m "feat(index): the index item's record, from the template and the schema"`

---

### Task 6: Client -- collection search, field search, item edit

**Files:**
- Modify: `src/core/client.ts` (new interface near `SearchHit`; four methods after `searchByTitle`)
- Modify: `tests/helpers/mockServer.ts` (state + routes)
- Test: `tests/client.test.ts`

- [ ] **Step 1: Extend the mock server.**

In `MockState`, after `existingItems: ...;` add:

```ts
  /**
   * The collection listing and field search the series index uses. Each item
   * carries `fields` (header-form path -> value) so a `where` on a path other
   * than the title path can match it.
   */
  collectionItems: {
    uuid: string;
    version: number;
    status: string;
    name?: string;
    attachments: { type: string; filename: string; uuid: string }[];
    fields: Record<string, string>;
  }[];
  /** Every `PUT /api/item/{uuid}/{version}` received: the body and its staging area. */
  edits: { uuid: string; version: number; staging: string; bean: Record<string, unknown> }[];
```

In the initial `state` object add `collectionItems: [],` and `edits: [],`.

In the `/api/search` route, inside `if (where) { ... }`, BEFORE the line `const hits =` add:

```ts
          if (askedPath !== state.titlePath) {
            const found = state.collectionItems.filter((i) => showAll && i.fields[askedPath] === wanted);
            return send(res, 200, {
              start: 0,
              length: found.length,
              available: found.length,
              results: found.map((i) => ({ uuid: i.uuid, version: i.version, status: i.status, name: i.name })),
            });
          }
```

and after the `if (where) { ... }` block closes, BEFORE `const q = url.searchParams.get('q') ?? '';` add:

```ts
        if (!url.searchParams.has('q')) {
          const visible = state.collectionItems.filter((i) => showAll || i.status === 'live');
          const start = Number(url.searchParams.get('start') ?? '0');
          const length = Number(url.searchParams.get('length') ?? '10');
          const page = visible.slice(start, start + length);
          return send(res, 200, {
            start,
            length: page.length,
            available: visible.length,
            results: page.map((i) => ({
              uuid: i.uuid,
              version: i.version,
              status: i.status,
              ...(i.name === undefined ? {} : { name: i.name }),
              attachments: i.attachments,
            })),
          });
        }
```

Add two routes next to the `/api/item` POST route:

```ts
      const itemAt = /^\/api\/item\/([^/]+)\/(\d+)\/?$/.exec(path);
      if (itemAt && req.method === 'GET') {
        const found = state.collectionItems.find((i) => i.uuid === itemAt[1] && i.version === Number(itemAt[2]));
        if (!found) return send(res, 404, { error: 'not found' });
        return send(res, 200, {
          uuid: found.uuid,
          version: found.version,
          status: found.status,
          collection: { uuid: 'c1' },
          metadata: '<xml/>',
          attachments: found.attachments.map((a) => ({ ...a, description: a.filename })),
        });
      }
      if (itemAt && req.method === 'PUT') {
        const staging = url.searchParams.get('file');
        if (!staging || !state.stagingAreas.has(staging)) return send(res, 404, { error: 'no such staging area' });
        const bean = JSON.parse((await readBody(req)).toString('utf8')) as Record<string, unknown>;
        state.edits.push({ uuid: itemAt[1]!, version: Number(itemAt[2]), staging, bean });
        return send(res, 200, '');
      }
```

- [ ] **Step 2: Write the failing tests** (append to `tests/client.test.ts`, inside or after the main `describe`):

```ts
describe('series index calls', () => {
  const item = (uuid: string, status = 'live') => ({
    uuid,
    version: 1,
    status,
    name: `Fernbrook ${uuid}`,
    attachments: [{ type: 'file', filename: `${uuid}.pdf`, uuid: `${uuid}-a` }],
    fields: { 'DC/identifier': uuid },
  });

  it('pages through the whole collection, drafts included', async () => {
    mock.state.collectionItems = Array.from({ length: 120 }, (_, i) => item(`u${i}`, i % 2 ? 'draft' : 'live'));
    const items = await client.searchCollection('c1');
    expect(items).toHaveLength(120);
    expect(items[1]).toEqual({
      uuid: 'u1',
      version: 1,
      status: 'draft',
      name: 'Fernbrook u1',
      attachments: [{ type: 'file', filename: 'u1.pdf', uuid: 'u1-a' }],
    });
    expect(mock.state.searchUrls.every((u) => u.includes('showall=true'))).toBe(true);
    expect(mock.state.searchUrls).toHaveLength(3);
  });

  it('reports a guest session instead of an empty collection', async () => {
    // available > 0 with no rows is how openEQUELLA answers a guest.
    mock.state.collectionItems = [item('u1')];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/search')) {
        return new Response(JSON.stringify({ available: 29, results: [] }), { status: 200 });
      }
      return original(input, init);
    }) as typeof fetch;
    try {
      await expect(client.searchCollection('c1')).rejects.toThrow(/not signed in/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('finds items by an exact field value', async () => {
    mock.state.collectionItems = [item('a'), item('b')];
    const found = await client.findByField('c1', 'DC/identifier', 'b');
    expect(found.map((f) => f.uuid)).toEqual(['b']);
  });

  it('reads an item and edits it with a staging area', async () => {
    mock.state.collectionItems = [item('a')];
    const bean = await client.getItemBean('a', 1);
    expect(bean['uuid']).toBe('a');
    const staging = await client.createStagingArea();
    await client.editItem('a', 1, { ...bean, metadata: '<xml><x/></xml>' }, staging);
    expect(mock.state.edits[0]).toMatchObject({ uuid: 'a', version: 1, staging, bean: { metadata: '<xml><x/></xml>' } });
  });
});
```

- [ ] **Step 3: Run, expect FAIL** -- `npx vitest run tests/client.test.ts`

- [ ] **Step 4: Implement.** In `src/core/client.ts`, after the `SearchHit` interface:

```ts
/** One item of a collection listing, as the series index reads it. */
export interface CollectionItem {
  uuid: string;
  version: number;
  status: string;
  /** Null when the server sent none: production omits it, content-test sends it. */
  name: string | null;
  attachments: { type: string; filename: string; uuid: string }[];
}

function parseCollectionItem(r: Record<string, unknown>): CollectionItem {
  const attachments = Array.isArray(r['attachments']) ? (r['attachments'] as Record<string, unknown>[]) : [];
  const name = typeof r['name'] === 'string' && r['name'] !== '' ? r['name'] : null;
  return {
    uuid: String(r['uuid'] ?? ''),
    version: typeof r['version'] === 'number' ? r['version'] : 1,
    status: typeof r['status'] === 'string' ? r['status'] : '',
    name,
    attachments: attachments.map((a) => ({
      type: String(a['type'] ?? ''),
      filename: String(a['filename'] ?? a['description'] ?? ''),
      uuid: String(a['uuid'] ?? ''),
    })),
  };
}
```

and after `searchByTitle` inside `OeqClient`:

```ts
  /**
   * Every item in a collection, drafts included (`showall=true`), with its
   * attachments -- read a page of 50 at a time until `available` is reached.
   *
   * `available > 0` with no rows on the FIRST page is openEQUELLA's answer to
   * a guest (CLAUDE.md, "openEQUELLA answers an unauthenticated request with
   * 200"), and is reported as that, never as an empty collection.
   */
  async searchCollection(collectionUuid: string, pageSize = 50): Promise<CollectionItem[]> {
    const items: CollectionItem[] = [];
    for (let start = 0; ; ) {
      const url =
        `/api/search?collections=${encodeURIComponent(collectionUuid)}` +
        `&info=${encodeURIComponent('basic,attachment')}&showall=true&length=${pageSize}&start=${start}`;
      const body = (await (await this.request(url)).json()) as {
        available?: number;
        results?: Record<string, unknown>[];
      };
      const results = body.results ?? [];
      const available = body.available ?? 0;
      if (start === 0 && available > 0 && results.length === 0) {
        throw new ValidationError(
          `openEQUELLA reports ${available} items in this collection but returned none -- the session is ` +
            'not signed in, or has expired. Sign in again and retry.',
        );
      }
      items.push(...results.map(parseCollectionItem));
      start += results.length;
      if (results.length === 0 || start >= available) return items;
    }
  }

  /** Items whose `path` is EXACTLY `value` -- the `where` mechanism of searchByTitle, for any path. */
  async findByField(collectionUuid: string, path: string, value: string): Promise<CollectionItem[]> {
    const clause = `/xml/${path} = '${escapeWhereValue(value)}'`;
    const url =
      `/api/search?collections=${encodeURIComponent(collectionUuid)}` +
      `&where=${encodeURIComponent(clause)}&info=basic&showall=true&length=50`;
    const body = (await (await this.request(url)).json()) as { results?: Record<string, unknown>[] };
    return (body.results ?? []).map(parseCollectionItem);
  }

  /** The item's full bean, as `editItem` sends it back. */
  async getItemBean(uuid: string, version: number): Promise<Record<string, unknown>> {
    const res = await this.request(`/api/item/${encodeURIComponent(uuid)}/${version}/`);
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * Replace an item's files and record IN PLACE: `PUT /api/item/{uuid}/{v}/
   * ?file={staging}` with its bean. CONFIRMED on content-test 2026-11-17: same
   * item, same version, same attachment uuids, files replaced, title changed.
   */
  async editItem(uuid: string, version: number, bean: Record<string, unknown>, stagingUuid: string): Promise<void> {
    await this.request(
      `/api/item/${encodeURIComponent(uuid)}/${version}/?file=${encodeURIComponent(stagingUuid)}`,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bean) },
    );
  }
```

- [ ] **Step 5: Run, expect PASS** -- `npx vitest run tests/client.test.ts`; then the full suite `npx vitest run` (the mock change must not disturb existing search tests); `npm run typecheck`.

- [ ] **Step 6: Commit** -- `git add src/core/client.ts tests/client.test.ts tests/helpers/mockServer.ts && git commit -m "feat(client): page a collection, search a field, read and edit an item"`

---

### Task 7: Publish -- find, create or update the index item

**Files:**
- Create: `src/core/seriesIndex/publish.ts`
- Test: `tests/seriesIndex/publish.test.ts`

- [ ] **Step 1: Write the failing tests** (a fake client records every call; no network):

```ts
import { describe, it, expect } from 'vitest';
import { findExistingIndex, publishIndex, type IndexClient } from '../../src/core/seriesIndex/publish.js';
import type { IndexRecord } from '../../src/core/seriesIndex/record.js';
import type { CollectionItem } from '../../src/core/client.js';

const record: IndexRecord = {
  title: 'Fernbrook index',
  description: 'Every volume.',
  fields: { 'DC/title': ['Fernbrook index'], 'DC/identifier': ['FQ_index'] },
  identifier: { path: 'DC/identifier', value: 'FQ_index' },
  identifierProblem: null,
};
const files = { 'index.html': '<h1>x</h1>', 'index.css': 'a{}', 'index.js': ';' };

function fake(found: CollectionItem[] = [], failOn?: string) {
  const calls: string[] = [];
  const state = { created: null as unknown, edited: null as unknown, uploads: [] as string[] };
  const client: IndexClient = {
    async findByField(_c, path, value) {
      calls.push(`find ${path}=${value}`);
      return found;
    },
    async createStagingArea() {
      calls.push('stage');
      return 'stg-1';
    },
    async uploadToStaging(_s, name) {
      if (failOn === 'upload') throw new Error('network down');
      state.uploads.push(name);
    },
    async deleteStagingArea(s) {
      calls.push(`delete ${s}`);
    },
    async createItem(req) {
      state.created = req;
      return { uuid: 'new-1', version: 1, attachmentUuids: [] };
    },
    async getItemBean(uuid, version) {
      return {
        uuid,
        version,
        status: 'live',
        metadata: '<xml/>',
        attachments: [
          { type: 'file', filename: 'index.html', uuid: 'keep-html' },
          { type: 'url', url: 'https://example.org', uuid: 'keep-url' },
        ],
      };
    },
    async editItem(uuid, version, bean, staging) {
      state.edited = { uuid, version, bean, staging };
    },
  };
  return { client, calls, state };
}
const hit = (uuid: string, status = 'live'): CollectionItem => ({ uuid, version: 2, status, name: uuid, attachments: [] });

describe('findExistingIndex', () => {
  it('none, one or many', async () => {
    expect(await findExistingIndex(fake().client, 'c1', record)).toEqual({ kind: 'none' });
    expect(await findExistingIndex(fake([hit('a', 'draft')]).client, 'c1', record)).toEqual({
      kind: 'one',
      uuid: 'a',
      version: 2,
      status: 'draft',
    });
    expect(await findExistingIndex(fake([hit('a'), hit('b')]).client, 'c1', record)).toEqual({
      kind: 'many',
      items: [
        { uuid: 'a', name: 'a' },
        { uuid: 'b', name: 'b' },
      ],
    });
  });

  it('is unavailable, without searching, when the record has no identifier', async () => {
    const f = fake();
    const r = await findExistingIndex(f.client, 'c1', { ...record, identifier: null, identifierProblem: 'no field' });
    expect(r).toEqual({ kind: 'unavailable', reason: 'no field' });
    expect(f.calls).toEqual([]);
  });
});

describe('publishIndex', () => {
  it('creates a new item with the three files and the draft flag', async () => {
    const f = fake();
    const r = await publishIndex(f.client, { collectionUuid: 'c1', record, files, existing: { kind: 'none' }, draft: true });
    expect(r).toEqual({ kind: 'created', uuid: 'new-1', version: 1 });
    expect(f.state.uploads).toEqual(['index.html', 'index.css', 'index.js']);
    expect(f.state.created).toMatchObject({
      collectionUuid: 'c1',
      stagingUuid: 'stg-1',
      draft: true,
      attachments: [
        { filename: 'index.html', description: 'index.html' },
        { filename: 'index.css', description: 'index.css' },
        { filename: 'index.js', description: 'index.js' },
      ],
    });
  });

  it('updates the one existing item in place, keeping attachment uuids and anything else attached', async () => {
    const f = fake();
    const r = await publishIndex(f.client, {
      collectionUuid: 'c1',
      record,
      files,
      existing: { kind: 'one', uuid: 'a', version: 2, status: 'live' },
      draft: true, // ignored: an update keeps the item's state
    });
    expect(r).toEqual({ kind: 'updated', uuid: 'a', version: 2 });
    const edited = f.state.edited as { bean: { attachments: { filename?: string; uuid: string }[]; status: string; metadata: string } };
    expect(edited.bean.status).toBe('live');
    expect(edited.bean.metadata).toContain('<identifier>FQ_index</identifier>');
    expect(edited.bean.attachments.find((a) => a.filename === 'index.html')!.uuid).toBe('keep-html');
    expect(edited.bean.attachments.some((a) => a.uuid === 'keep-url')).toBe(true);
    expect(edited.bean.attachments).toHaveLength(4);
  });

  it('refuses several matches or no identifier, and stages nothing', async () => {
    const f = fake();
    await expect(
      publishIndex(f.client, {
        collectionUuid: 'c1',
        record,
        files,
        existing: { kind: 'many', items: [{ uuid: 'a', name: 'A' }, { uuid: 'b', name: 'B' }] },
        draft: true,
      }),
    ).rejects.toThrow(/A, B/);
    await expect(
      publishIndex(f.client, { collectionUuid: 'c1', record, files, existing: { kind: 'unavailable', reason: 'no field' }, draft: true }),
    ).rejects.toThrow(/no field/);
    expect(f.calls).toEqual([]);
  });

  it('deletes the staging area when anything fails', async () => {
    const f = fake([], 'upload');
    await expect(
      publishIndex(f.client, { collectionUuid: 'c1', record, files, existing: { kind: 'none' }, draft: true }),
    ).rejects.toThrow(/network down/);
    expect(f.calls).toContain('delete stg-1');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** -- `npx vitest run tests/seriesIndex/publish.test.ts`

- [ ] **Step 3: Implement** (`src/core/seriesIndex/publish.ts`):

```ts
// src/core/seriesIndex/publish.ts
import { randomUUID } from 'node:crypto';
import type { CollectionItem, CreateItemRequest, CreateItemResult } from '../client.js';
import { ValidationError } from '../errors.js';
import { buildMetadataXml } from '../metadata.js';
import type { IndexRecord } from './record.js';
import { INDEX_FILE_NAMES, type IndexFiles } from './types.js';

/**
 * The openEQUELLA destination. ONE index item per identifier: none -> create,
 * one -> update IN PLACE (checked live 2026-11-17), several -> refuse and name
 * them, because nothing here can know which one readers already link to.
 *
 * An update KEEPS THE ITEM'S STATE: it never publishes a draft or unpublishes
 * a live item. An edit copies the bean whole and changes what it names
 * (CLAUDE.md) -- so attachments other than the three index files stay.
 */

export interface IndexClient {
  findByField(collectionUuid: string, path: string, value: string): Promise<CollectionItem[]>;
  createStagingArea(): Promise<string>;
  uploadToStaging(stagingUuid: string, filename: string, body: BodyInit): Promise<void>;
  deleteStagingArea(uuid: string): Promise<void>;
  createItem(req: CreateItemRequest): Promise<CreateItemResult>;
  getItemBean(uuid: string, version: number): Promise<Record<string, unknown>>;
  editItem(uuid: string, version: number, bean: Record<string, unknown>, stagingUuid: string): Promise<void>;
}

export type ExistingIndex =
  | { kind: 'none' }
  | { kind: 'one'; uuid: string; version: number; status: string }
  | { kind: 'many'; items: { uuid: string; name: string }[] }
  | { kind: 'unavailable'; reason: string };

export async function findExistingIndex(
  client: Pick<IndexClient, 'findByField'>,
  collectionUuid: string,
  record: IndexRecord,
): Promise<ExistingIndex> {
  if (record.identifier === null) {
    return { kind: 'unavailable', reason: record.identifierProblem ?? 'The index has no identifier.' };
  }
  const found = await client.findByField(collectionUuid, record.identifier.path, record.identifier.value);
  if (found.length === 0) return { kind: 'none' };
  if (found.length === 1) {
    const one = found[0]!;
    return { kind: 'one', uuid: one.uuid, version: one.version, status: one.status };
  }
  return { kind: 'many', items: found.map((f) => ({ uuid: f.uuid, name: f.name ?? f.uuid })) };
}

export interface PublishArgs {
  collectionUuid: string;
  record: IndexRecord;
  files: IndexFiles;
  existing: ExistingIndex;
  /** For a NEW item only; an update keeps the item's state. */
  draft: boolean;
}

export type PublishResult = { kind: 'created' | 'updated'; uuid: string; version: number };

export async function publishIndex(client: IndexClient, args: PublishArgs): Promise<PublishResult> {
  const { existing } = args;
  if (existing.kind === 'unavailable') throw new ValidationError(existing.reason);
  if (existing.kind === 'many') {
    throw new ValidationError(
      `${existing.items.length} items already carry this index's identifier (${existing.items
        .map((i) => i.name)
        .join(', ')}). Remove the extra ones in openEQUELLA, then build again.`,
    );
  }

  const metadata = buildMetadataXml(args.record.fields);
  const staging = await client.createStagingArea();
  try {
    for (const name of INDEX_FILE_NAMES) await client.uploadToStaging(staging, name, args.files[name]);

    if (existing.kind === 'none') {
      const created = await client.createItem({
        collectionUuid: args.collectionUuid,
        metadata,
        stagingUuid: staging,
        draft: args.draft,
        attachments: INDEX_FILE_NAMES.map((name) => ({ filename: name, description: name, uuid: randomUUID() })),
      });
      return { kind: 'created', uuid: created.uuid, version: created.version };
    }

    const bean = await client.getItemBean(existing.uuid, existing.version);
    const current = Array.isArray(bean['attachments']) ? (bean['attachments'] as Record<string, unknown>[]) : [];
    const ours = new Set<string>(INDEX_FILE_NAMES);
    const uuidOf = (name: string) =>
      current.find((a) => a['type'] === 'file' && a['filename'] === name)?.['uuid'];
    const attachments = [
      ...INDEX_FILE_NAMES.map((name) => ({
        type: 'file',
        filename: name,
        description: name,
        uuid: typeof uuidOf(name) === 'string' ? (uuidOf(name) as string) : randomUUID(),
      })),
      ...current.filter((a) => !(a['type'] === 'file' && ours.has(String(a['filename'])))),
    ];
    await client.editItem(existing.uuid, existing.version, { ...bean, metadata, attachments }, staging);
    return { kind: 'updated', uuid: existing.uuid, version: existing.version };
  } catch (err) {
    await client.deleteStagingArea(staging);
    throw err;
  }
}
```

- [ ] **Step 4: Run, expect PASS**; `npm run typecheck`. (If `buildMetadataXml` wraps values differently than `<identifier>FQ_index</identifier>`, read `src/core/metadata.ts` and adjust only the test's expected substring.)

- [ ] **Step 5: Commit** -- `git add src/core/seriesIndex/publish.ts tests/seriesIndex/publish.test.ts && git commit -m "feat(index): create the index item, or update the one that exists in place"`

---

### Task 8: Files -- the web-server copy

**Files:**
- Create: `src/core/seriesIndex/files.ts`
- Test: `tests/seriesIndex/files.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveIndexFiles } from '../../src/core/seriesIndex/files.js';

const files = { 'index.html': '<h1>x</h1>', 'index.css': 'a{}', 'index.js': ';' };
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oeq-index-'));
});

describe('saveIndexFiles', () => {
  it('writes the three files', async () => {
    const r = await saveIndexFiles(dir, files, false);
    expect(r).toEqual({ kind: 'saved', paths: ['index.html', 'index.css', 'index.js'].map((n) => join(dir, n)) });
    expect(await readFile(join(dir, 'index.html'), 'utf8')).toBe('<h1>x</h1>');
  });

  it('writes nothing while any of the three already exists, and names them', async () => {
    await writeFile(join(dir, 'index.css'), 'mine');
    await writeFile(join(dir, 'other.txt'), 'untouched');
    const r = await saveIndexFiles(dir, files, false);
    expect(r).toEqual({ kind: 'exists', names: ['index.css'] });
    expect(await readFile(join(dir, 'index.css'), 'utf8')).toBe('mine');
    expect((await readdir(dir)).sort()).toEqual(['index.css', 'other.txt']);
  });

  it('replaces them when told to, leaving other files alone', async () => {
    await writeFile(join(dir, 'index.css'), 'mine');
    await writeFile(join(dir, 'other.txt'), 'untouched');
    await saveIndexFiles(dir, files, true);
    expect(await readFile(join(dir, 'index.css'), 'utf8')).toBe('a{}');
    expect(await readFile(join(dir, 'other.txt'), 'utf8')).toBe('untouched');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** -- `npx vitest run tests/seriesIndex/files.test.ts`

- [ ] **Step 3: Implement** (`src/core/seriesIndex/files.ts`):

```ts
// src/core/seriesIndex/files.ts
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { INDEX_FILE_NAMES, type IndexFiles } from './types.js';

/**
 * The web-server copy: the three files in a chosen folder. NEVER replaces a
 * file of the same name without `replace` -- the folder may be a live site's
 * -- and never touches any other file there.
 */
export type SaveFilesResult = { kind: 'saved'; paths: string[] } | { kind: 'exists'; names: string[] };

export async function saveIndexFiles(dir: string, files: IndexFiles, replace: boolean): Promise<SaveFilesResult> {
  if (!replace) {
    const names: string[] = [];
    for (const name of INDEX_FILE_NAMES) {
      try {
        await access(join(dir, name));
        names.push(name);
      } catch {
        // absent: fine
      }
    }
    if (names.length > 0) return { kind: 'exists', names };
  }
  const paths: string[] = [];
  for (const name of INDEX_FILE_NAMES) {
    const path = join(dir, name);
    await writeFile(path, files[name], 'utf8');
    paths.push(path);
  }
  return { kind: 'saved', paths };
}
```

- [ ] **Step 4: Run, expect PASS**; `npm run typecheck`.

- [ ] **Step 5: Commit** -- `git add src/core/seriesIndex/files.ts tests/seriesIndex/files.test.ts && git commit -m "feat(index): save the page as files, never replacing without consent"`

---

### Task 9: Build -- one orchestration for both front ends

**Files:**
- Create: `src/core/seriesIndex/build.ts`
- Test: `tests/seriesIndex/build.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { buildIndex, previewLines, resolveIndexSchema } from '../../src/core/seriesIndex/build.js';
import { parseProfile } from '../../src/core/extract/profile.js';
import type { CollectionItem } from '../../src/core/client.js';

const profile = parseProfile({
  version: 1,
  pattern: 'FQ_Vol{group}',
  columns: [{ path: 'attachment name', sources: [{ filename: true }] }],
  checks: { sequence: { patterns: ['{year}_Vol{group}_No{part}'], labels: { part: 'issue', group: 'volume' } } },
  index: {
    columns: [
      { path: 'DC/title', value: 'Fernbrook index' },
      { path: 'DC/description', value: 'Every volume.' },
      { path: 'DC/identifier', value: 'FQ_index' },
    ],
  },
});
const schema = {
  titleHeader: 'DC/title',
  descriptionHeader: 'DC/description',
  paths: new Set(['DC/title', 'DC/description', 'DC/identifier']),
};
const listing: CollectionItem[] = [
  {
    uuid: 'v1',
    version: 1,
    status: 'live',
    name: 'Fernbrook Vol 1',
    attachments: [
      { type: 'file', filename: 'FQ_1971_Vol1_No1.pdf', uuid: 'a1' },
      { type: 'url', filename: '', uuid: 'skip' },
    ],
  },
  { uuid: 'idx', version: 1, status: 'live', name: 'Fernbrook index', attachments: [{ type: 'file', filename: 'index.html', uuid: 'h' }] },
];
const client = {
  searchCollection: async () => listing,
  findByField: async () => [listing[1]!],
};

describe('buildIndex', () => {
  it('collects, renders and finds the existing index item', async () => {
    const b = await buildIndex({ client, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', profile, schema });
    expect(b.index.volumes).toHaveLength(1);
    expect(b.index.volumes[0]!.issues).toHaveLength(1); // the URL attachment is ignored
    expect(b.files['index.html']).toContain('<h1>Fernbrook index</h1>');
    expect(b.existing).toEqual({ kind: 'one', uuid: 'idx', version: 1, status: 'live' });
  });

  it('refuses a template with no index section', async () => {
    const { index: _drop, ...rest } = profile;
    await expect(
      buildIndex({ client, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', profile: rest, schema }),
    ).rejects.toThrow(/no "index" section/);
  });

  it('describes the build in plain lines', async () => {
    const b = await buildIndex({ client, baseUrl: 'https://oeq.example.edu', collectionUuid: 'c1', profile, schema });
    expect(previewLines(b)).toEqual([
      '1 volume, 1 issue.',
      'Not in the series (1): Fernbrook index -- none of its files fits the template\'s file-name patterns',
      'openEQUELLA: updates the existing index item, which stays live.',
    ]);
  });
});

describe('resolveIndexSchema', () => {
  const s = { uuid: 's1', namePath: '/DC/title', titleHeader: 'DC/title', descriptionPath: null, descriptionHeader: null, paths: new Set<string>() };
  it("uses the collection's schema, else the fallback, else refuses", async () => {
    const asked: string[] = [];
    const c = (schemaUuid: string) => ({
      getCollection: async () => ({ uuid: 'c1', name: 'C', schemaUuid }),
      getSchema: async (uuid: string) => (asked.push(uuid), s),
    });
    await resolveIndexSchema(c('from-collection'), 'c1', 'fallback');
    await resolveIndexSchema(c(''), 'c1', 'fallback');
    expect(asked).toEqual(['from-collection', 'fallback']);
    await expect(resolveIndexSchema(c(''), 'c1', '')).rejects.toThrow(/schema/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** -- `npx vitest run tests/seriesIndex/build.test.ts`

- [ ] **Step 3: Implement** (`src/core/seriesIndex/build.ts`):

```ts
// src/core/seriesIndex/build.ts
import type { CollectionItem, CollectionSummary } from '../client.js';
import type { SchemaInfo } from '../discovery.js';
import { ValidationError } from '../errors.js';
import { resolveLabels } from '../extract/sequenceChecks.js';
import type { Profile } from '../extract/types.js';
import { collectIndex } from './collect.js';
import { findExistingIndex, type ExistingIndex, type IndexClient } from './publish.js';
import { indexRecord, type IndexRecord, type IndexSchema } from './record.js';
import { renderIndex } from './render.js';
import type { IndexFiles, IndexHit, SeriesIndex } from './types.js';

/**
 * ONE build, used by the CLI and the desktop alike, so the preview, the files
 * and the uploaded item are one set of bytes.
 */

export interface IndexBuild {
  collectionUuid: string;
  index: SeriesIndex;
  record: IndexRecord;
  files: IndexFiles;
  existing: ExistingIndex;
  /** The template's own words: "issue"/"issues", "volume"/"volumes". */
  labels: SequenceLabels;
}

export interface BuildArgs {
  client: { searchCollection(collectionUuid: string): Promise<CollectionItem[]> } & Pick<IndexClient, 'findByField'>;
  baseUrl: string;
  collectionUuid: string;
  profile: Profile;
  schema: IndexSchema;
}

const toHit = (item: CollectionItem): IndexHit => ({
  uuid: item.uuid,
  version: item.version,
  status: item.status,
  name: item.name,
  files: item.attachments.filter((a) => a.type === 'file').map((a) => ({ filename: a.filename, uuid: a.uuid })),
});

export async function buildIndex(args: BuildArgs): Promise<IndexBuild> {
  const { profile } = args;
  if (!profile.index) throw new ValidationError('This template has no "index" section, so it cannot build an index.');
  const sequence = profile.checks?.sequence;
  if (!sequence) throw new ValidationError('This template has no file-name patterns to read volumes and issues with.');

  const record = indexRecord(profile.index, args.schema);
  const listing = await args.client.searchCollection(args.collectionUuid);
  const index = collectIndex(
    listing.map(toHit),
    { patterns: sequence.patterns, groupPatterns: profile.index.groupPatterns, labels: sequence.labels },
    args.baseUrl,
  );
  const labels = resolveLabels(sequence.labels);
  const files = renderIndex(index, { title: record.title, description: record.description, groups: labels.groups });
  const existing = await findExistingIndex(args.client, args.collectionUuid, record);
  return { collectionUuid: args.collectionUuid, index, record, files, existing, labels };
}

/** The collection's schema, else the site's saved one, else a refusal naming both. */
export async function resolveIndexSchema(
  client: { getCollection(uuid: string): Promise<CollectionSummary>; getSchema(uuid: string): Promise<SchemaInfo> },
  collectionUuid: string,
  fallbackSchemaUuid: string,
): Promise<SchemaInfo> {
  const fromCollection = (await client.getCollection(collectionUuid)).schemaUuid ?? '';
  const uuid = fromCollection !== '' ? fromCollection : fallbackSchemaUuid;
  if (uuid === '') {
    throw new ValidationError(
      "openEQUELLA did not say which schema this collection uses, and none is saved for this site, so the index's " +
        'title and description fields cannot be found. Choose the collection on Setup, or set OEQ_SCHEMA_UUID.',
    );
  }
  return client.getSchema(uuid);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the preview says, as plain lines -- the CLI prints them; the desktop shows the same facts. */
export function previewLines(b: IndexBuild): string[] {
  const L = b.labels;
  const issues = b.index.volumes.reduce((n, v) => n + v.issues.length, 0);
  const lines = [`${plural(b.index.volumes.length, L.group, L.groups)}, ${plural(issues, L.part, L.parts)}.`];
  for (const h of b.index.heldBack) {
    lines.push(`Held back: ${h.reason} -- ${h.items.map((i) => i.name).join(', ')}`);
  }
  if (b.index.notInSeries.length > 0) {
    lines.push(
      `Not in the series (${b.index.notInSeries.length}): ` +
        b.index.notInSeries.map((l) => `${l.name} -- ${l.reason}`).join('; '),
    );
  }
  lines.push(existingLine(b.existing));
  return lines;
}

export function existingLine(existing: ExistingIndex): string {
  switch (existing.kind) {
    case 'none':
      return 'openEQUELLA: creates a new index item.';
    case 'one':
      return `openEQUELLA: updates the existing index item, which stays ${existing.status}.`;
    case 'many':
      return `openEQUELLA: refused -- ${existing.items.length} items carry this identifier (${existing.items
        .map((i) => i.name)
        .join(', ')}).`;
    case 'unavailable':
      return `openEQUELLA: unavailable -- ${existing.reason}`;
  }
}
```

Add `import type { SequenceLabels } from '../extract/types.js';` to the imports (`Profile` already comes from there -- merge them into one import).

- [ ] **Step 4: Run, expect PASS**; `npm run typecheck`.

- [ ] **Step 5: Commit** -- `git add src/core/seriesIndex/build.ts tests/seriesIndex/build.test.ts && git commit -m "feat(index): one build for both front ends, and its preview"`

---

### Task 10: The command line -- `oeq-upload index`

**Files:**
- Create: `src/cli/indexPage.ts`
- Modify: `src/cli/index.ts` (`buildProgram`, after the `extract` command)
- Test: `tests/cli-index.test.ts`

- [ ] **Step 1: Write the failing tests** -- the flag rules, which need no network:

```ts
import { describe, it, expect } from 'vitest';
import { checkIndexFlags } from '../src/cli/indexPage.js';

describe('oeq-upload index flags', () => {
  it('previews when given no destination', () => {
    expect(checkIndexFlags({ template: 't.json' })).toEqual({ out: null, upload: null });
  });
  it('requires exactly one of --draft and --publish with --upload', () => {
    expect(() => checkIndexFlags({ template: 't', upload: true })).toThrow(/--draft or --publish/);
    expect(() => checkIndexFlags({ template: 't', upload: true, draft: true, publish: true })).toThrow(/--draft or --publish/);
    expect(checkIndexFlags({ template: 't', upload: true, publish: true }).upload).toEqual({ draft: false });
  });
  it('refuses --force without --out, and --draft/--publish without --upload', () => {
    expect(() => checkIndexFlags({ template: 't', force: true })).toThrow(/--force/);
    expect(() => checkIndexFlags({ template: 't', draft: true })).toThrow(/--upload/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** -- `npx vitest run tests/cli-index.test.ts`

- [ ] **Step 3: Implement** (`src/cli/indexPage.ts`):

```ts
// src/cli/indexPage.ts
import { loadConfig, createAuthProvider } from '../core/config.js';
import { OeqClient } from '../core/client.js';
import { assertNotGuest } from '../core/identity.js';
import { ValidationError } from '../core/errors.js';
import { loadProfile } from '../core/extract/profile.js';
import { buildIndex, previewLines, resolveIndexSchema } from '../core/seriesIndex/build.js';
import { saveIndexFiles } from '../core/seriesIndex/files.js';
import { publishIndex } from '../core/seriesIndex/publish.js';
import { itemUrl } from '../core/seriesIndex/collect.js';

type Env = Record<string, string | undefined>;

export interface IndexCliOptions {
  template: string;
  out?: string;
  force?: boolean;
  upload?: boolean;
  draft?: boolean;
  publish?: boolean;
}

/** Flag rules, checked before any I/O. No destination is a preview -- the CLI's "preview first". */
export function checkIndexFlags(o: IndexCliOptions): { out: string | null; upload: { draft: boolean } | null } {
  if (o.force && !o.out) throw new ValidationError('--force replaces files in the --out folder, so it needs --out.');
  if ((o.draft || o.publish) && !o.upload) throw new ValidationError('--draft and --publish only mean something with --upload.');
  if (o.upload && Boolean(o.draft) === Boolean(o.publish)) {
    throw new ValidationError('--upload needs exactly one of --draft or --publish. Refusing to guess.');
  }
  return { out: o.out ?? null, upload: o.upload ? { draft: Boolean(o.draft) } : null };
}

export async function indexAction(o: IndexCliOptions, env: Env = process.env): Promise<number> {
  const flags = checkIndexFlags(o);
  const cfg = loadConfig(env);
  const client = new OeqClient(cfg.baseUrl, createAuthProvider(cfg, env));
  assertNotGuest(await client.currentUser(), 'Run `oeq-upload login` first.');

  const profile = await loadProfile(o.template);
  const schema = await resolveIndexSchema(client, cfg.collectionUuid, cfg.schemaUuid);
  const build = await buildIndex({ client, baseUrl: cfg.baseUrl, collectionUuid: cfg.collectionUuid, profile, schema });
  for (const line of previewLines(build)) console.log(line);

  if (!flags.out && !flags.upload) {
    console.log('\nPreview only. Add --out <dir> and/or --upload --draft|--publish to build.');
    return 0;
  }
  if (build.index.volumes.length === 0) {
    console.error('\nNothing to build: no volume could be listed.');
    return 1;
  }

  let code = 0;
  if (flags.out) {
    const saved = await saveIndexFiles(flags.out, build.files, Boolean(o.force));
    if (saved.kind === 'exists') {
      console.error(`\nNot saved: ${saved.names.join(', ')} already exist in ${flags.out}. Add --force to replace them.`);
      code = 1;
    } else {
      console.log(`\nSaved: ${saved.paths.join(', ')}`);
    }
  }
  if (flags.upload) {
    const result = await publishIndex(client, {
      collectionUuid: cfg.collectionUuid,
      record: build.record,
      files: build.files,
      existing: build.existing,
      draft: flags.upload.draft,
    });
    console.log(`\n${result.kind === 'created' ? 'Created' : 'Updated'} the index item: ${itemUrl(cfg.baseUrl, result.uuid)}index.html`);
  }
  return code;
}
```

In `src/cli/index.ts`: add `import { indexAction, type IndexCliOptions } from './indexPage.js';` with the other imports, and in `buildProgram` after the `extract` command's `.action(...)`:

```ts
  program
    .command('index')
    .description(
      "Build a series' index page from what is in openEQUELLA. With no --out or --upload, previews only.",
    )
    .requiredOption('--template <path>', 'a template with sequence patterns and an "index" section')
    .option('--out <dir>', 'save index.html, index.css and index.js to this folder')
    .option('--force', 'replace those three files if the folder already has them')
    .option('--upload', 'create the index item, or update the existing one in place')
    .option('--draft', 'with --upload: a NEW index item is a draft')
    .option('--publish', 'with --upload: a NEW index item is published')
    .action(async (o: IndexCliOptions) => {
      process.exitCode = await indexAction(o, env);
    });
```

(`cfg.schemaUuid` is `OEQ_SCHEMA_UUID`, already read by `loadConfig` -- see `src/core/config.ts`.)

- [ ] **Step 4: Run, expect PASS** -- `npx vitest run tests/cli-index.test.ts tests/cli.test.ts`; `npm run typecheck`.

- [ ] **Step 5: Commit** -- `git add src/cli tests/cli-index.test.ts && git commit -m "feat(cli): oeq-upload index -- preview, save files, create or update the item"`

---

### Task 11: Snake River Echoes gets its index section

**Files:**
- Modify: `templates/snake-river-echoes.profile.json`
- Test: `tests/extract/templates.test.ts`

- [ ] **Step 1: Write the failing test** (append):

```ts
it('Snake River Echoes carries an index section that reads every kind of volume', async () => {
  const p = await loadTemplate('snake-river-echoes');
  expect(p.index?.columns.map((c) => c.path)).toEqual([
    'MWDL/title',
    'MWDL/description',
    'MWDL/identifier',
    'MWDL/genres/genre',
    'BYUI_extended/byui_rights/restrict_to_byui',
  ]);
  expect(p.index?.groupPatterns).toEqual(['{year}_Vol{group}']);
});
```

(Import `loadTemplate` from `../../src/core/extract/templates.js` if the file does not already.)

- [ ] **Step 2: Run, expect FAIL** -- `npx vitest run tests/extract/templates.test.ts`

- [ ] **Step 3: Implement.** In `templates/snake-river-echoes.profile.json`, after the `"aiProvenance": {...},` member add:

```json
  "index": {
    "columns": [
      { "path": "MWDL/title", "value": "Snake River Echoes: an index of volumes and issues" },
      { "path": "MWDL/description", "value": "An index to Snake River Echoes, the quarterly of the Upper Snake River Valley Historical Society. Each volume links to its item, and each issue to its PDF." },
      { "path": "MWDL/identifier", "value": "SRE_index" },
      { "path": "MWDL/genres/genre", "value": "Periodical" },
      { "path": "BYUI_extended/byui_rights/restrict_to_byui", "value": "Public" }
    ],
    "groupPatterns": ["{year}_Vol{group}"]
  },
```

- [ ] **Step 4: Run, expect PASS** -- `npx vitest run tests/extract`; check the bundled schema has every path: `npx vitest run tests/extract/templates.test.ts` (if an existing test validates templates against `schema/_entity.xml`, it now covers these paths too; if none does, add `expect(validateAgainstSchema(...))`-style coverage is NOT needed -- `indexRecord` refuses unknown paths at build time).

- [ ] **Step 5: Commit** -- `git commit -am "feat(templates): Snake River Echoes builds an index"`

---

### Task 12: Desktop main process -- channels and handlers

**Files:**
- Modify: `src/desktop/ipc.ts` (types, `OeqApi`, `CHANNELS`)
- Modify: `src/desktop/preload.cts` (`CHANNELS` copy and `api`)
- Create: `src/desktop/indexHandlers.ts`
- Modify: `src/desktop/handlers.ts` (register them)
- Test: `tests/desktop/indexHandlers.test.ts`

- [ ] **Step 1: Add the contract.** In `src/desktop/ipc.ts` add types (near the other exported interfaces) -- type-only imports keep the renderer pure:

```ts
import type { TemplateSummary } from '../core/extract/templates.js';

/** What the renderer is shown of one index build; the build itself stays in the main process. */
export interface IndexPreview {
  buildId: string;
  title: string;
  volumes: { heading: string; issues: string[] }[];
  issueCount: number;
  heldBack: { reason: string; items: string[] }[];
  notInSeries: { name: string; reason: string }[];
  existing:
    | { kind: 'none' }
    | { kind: 'one'; status: string }
    | { kind: 'many'; names: string[] }
    | { kind: 'unavailable'; reason: string };
}
export type IndexSaveResult = { kind: 'saved'; paths: string[] } | { kind: 'exists'; names: string[] };
export interface IndexUploadResult {
  kind: 'created' | 'updated';
  url: string;
}
```

To `OeqApi` add:

```ts
  /** Templates that can build an index: sequence patterns AND an `index` section. */
  indexTemplates(): Promise<TemplateSummary[]>;
  indexPreview(args: { instanceId: string; collectionUuid: string; templateId: string }): Promise<IndexPreview>;
  indexSaveFiles(args: { buildId: string; dir: string; replace: boolean }): Promise<IndexSaveResult>;
  indexUpload(args: { buildId: string; draft: boolean }): Promise<IndexUploadResult>;
```

To `CHANNELS` add:

```ts
  indexTemplates: 'oeq:indexTemplates',
  indexPreview: 'oeq:indexPreview',
  indexSaveFiles: 'oeq:indexSaveFiles',
  indexUpload: 'oeq:indexUpload',
```

In `src/desktop/preload.cts` add the same four entries to its `CHANNELS` copy, and to `api`:

```ts
  indexTemplates: () => invoke(CHANNELS.indexTemplates),
  indexPreview: (args) => invoke(CHANNELS.indexPreview, args),
  indexSaveFiles: (args) => invoke(CHANNELS.indexSaveFiles, args),
  indexUpload: (args) => invoke(CHANNELS.indexUpload, args),
```

- [ ] **Step 2: Write the failing tests** (`tests/desktop/indexHandlers.test.ts`) -- the handler logic is tested through `createIndexHandlers`, with no Electron:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIndexHandlers, type IndexConnection } from '../../src/desktop/indexHandlers.js';

async function templatesDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-tpl-'));
  await mkdir(dir, { recursive: true });
  const base = {
    version: 1,
    pattern: 'FQ_Vol{group}',
    columns: [{ path: 'attachment name', sources: [{ filename: true }] }],
    checks: { sequence: { patterns: ['{year}_Vol{group}_No{part}'] } },
  };
  await writeFile(
    join(dir, 'with-index.profile.json'),
    JSON.stringify({
      ...base,
      index: {
        columns: [
          { path: 'DC/title', value: 'Fernbrook index' },
          { path: 'DC/description', value: 'Every volume.' },
          { path: 'DC/identifier', value: 'FQ_index' },
        ],
      },
    }),
  );
  await writeFile(join(dir, 'without-index.profile.json'), JSON.stringify(base));
  return dir;
}

function connect() {
  const created: unknown[] = [];
  const client = {
    currentUser: async () => ({ id: 'u', username: 'u', firstName: '', lastName: '', guest: false }),
    getCollection: async () => ({ uuid: 'c1', name: 'C', schemaUuid: 's1' }),
    getSchema: async () => ({
      uuid: 's1',
      namePath: '/DC/title',
      titleHeader: 'DC/title',
      descriptionPath: '/DC/description',
      descriptionHeader: 'DC/description',
      paths: new Set(['DC/title', 'DC/description', 'DC/identifier']),
    }),
    searchCollection: async () => [
      { uuid: 'v1', version: 1, status: 'draft', name: 'Fernbrook Vol 1', attachments: [{ type: 'file', filename: 'FQ_1971_Vol1_No1.pdf', uuid: 'a' }] },
    ],
    findByField: async () => [],
    createStagingArea: async () => 'stg',
    uploadToStaging: async () => {},
    deleteStagingArea: async () => {},
    createItem: async (req: unknown) => (created.push(req), { uuid: 'new', version: 1, attachmentUuids: [] }),
    getItemBean: async () => ({}),
    editItem: async () => {},
  };
  // The fake implements only what the flow calls; the cast says so once.
  return {
    created,
    deps: async (): Promise<IndexConnection> => ({
      client: client as unknown as IndexConnection['client'],
      baseUrl: 'https://oeq.example.edu',
      fallbackSchemaUuid: '',
    }),
  };
}

describe('index handlers', () => {
  it('offers only templates that can build an index', async () => {
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: connect().deps });
    expect((await h.templates()).map((t) => t.id)).toEqual(['with-index']);
  });

  it('previews, then uploads THE SAME build by id', async () => {
    const c = connect();
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: c.deps, newId: () => 'b1' });
    const preview = await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    expect(preview).toMatchObject({
      buildId: 'b1',
      title: 'Fernbrook index',
      volumes: [{ heading: 'Fernbrook Vol 1', issues: ['Issue 1 (1971)'] }],
      issueCount: 1,
      existing: { kind: 'none' },
    });
    const up = await h.upload({ buildId: 'b1', draft: true });
    expect(up).toEqual({ kind: 'created', url: 'https://oeq.example.edu/items/new/0/index.html' });
    expect(c.created[0]).toMatchObject({ draft: true });
  });

  it('refuses an unknown or superseded build id', async () => {
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: connect().deps });
    await expect(h.upload({ buildId: 'nope', draft: true })).rejects.toThrow(/Preview again/);
  });

  it('saves the build to a folder, reporting files already there', async () => {
    const h = createIndexHandlers({ templatesDir: await templatesDir(), connect: connect().deps, newId: () => 'b1' });
    await h.preview({ instanceId: 'i', collectionUuid: 'c1', templateId: 'with-index' });
    const dir = await mkdtemp(join(tmpdir(), 'oeq-out-'));
    expect((await h.saveFiles({ buildId: 'b1', dir, replace: false })).kind).toBe('saved');
    expect(await h.saveFiles({ buildId: 'b1', dir, replace: false })).toEqual({
      kind: 'exists',
      names: ['index.html', 'index.css', 'index.js'],
    });
  });
});
```

- [ ] **Step 3: Run, expect FAIL** -- `npx vitest run tests/desktop/indexHandlers.test.ts`

- [ ] **Step 4: Implement** (`src/desktop/indexHandlers.ts`):

```ts
// src/desktop/indexHandlers.ts
import { randomUUID } from 'node:crypto';
import type { IpcMain } from 'electron';
import { CHANNELS, type IndexPreview, type IndexSaveResult, type IndexUploadResult, type OeqApi } from './ipc.js';
import type { CollectionItem, CollectionSummary, CurrentUser } from '../core/client.js';
import type { SchemaInfo } from '../core/discovery.js';
import { assertNotGuest } from '../core/identity.js';
import { ValidationError } from '../core/errors.js';
import { listTemplates, loadTemplate, type TemplateSummary } from '../core/extract/templates.js';
import { buildIndex, resolveIndexSchema, type IndexBuild } from '../core/seriesIndex/build.js';
import { saveIndexFiles } from '../core/seriesIndex/files.js';
import { publishIndex, type IndexClient } from '../core/seriesIndex/publish.js';
import { itemUrl } from '../core/seriesIndex/collect.js';

/**
 * The series index's main-process side. The BUILD STAYS HERE, held by id, and
 * the renderer gets a summary: saving and uploading then use the exact bytes
 * the operator previewed, and a new preview supersedes the old id.
 */

export type IndexConnection = {
  client: IndexClient & {
    currentUser(): Promise<CurrentUser>;
    getCollection(uuid: string): Promise<CollectionSummary>;
    getSchema(uuid: string): Promise<SchemaInfo>;
    searchCollection(collectionUuid: string): Promise<CollectionItem[]>;
  };
  baseUrl: string;
  /** The schema Setup read for this site, for a collection that names none. */
  fallbackSchemaUuid: string;
};

export interface IndexHandlerDeps {
  templatesDir?: string;
  connect(instanceId: string): Promise<IndexConnection>;
  newId?: () => string;
}

export function createIndexHandlers(deps: IndexHandlerDeps) {
  const newId = deps.newId ?? randomUUID;
  let held: { id: string; build: IndexBuild; connection: IndexConnection } | null = null;

  const take = (buildId: string) => {
    if (held === null || held.id !== buildId) {
      throw new ValidationError('That index preview is no longer current. Preview again, then save or upload.');
    }
    return held;
  };

  return {
    async templates(): Promise<TemplateSummary[]> {
      const all = await listTemplates(deps.templatesDir);
      const usable: TemplateSummary[] = [];
      for (const t of all) {
        const p = await loadTemplate(t.id, deps.templatesDir);
        if (p.index && p.checks?.sequence) usable.push(t);
      }
      return usable;
    },

    async preview(args: Parameters<OeqApi['indexPreview']>[0]): Promise<IndexPreview> {
      held = null;
      const connection = await deps.connect(args.instanceId);
      const { client } = connection;
      assertNotGuest(await client.currentUser(), 'Sign in to this site again, then build the index.');
      const profile = await loadTemplate(args.templateId, deps.templatesDir);
      const schema = await resolveIndexSchema(client, args.collectionUuid, connection.fallbackSchemaUuid);
      const build = await buildIndex({
        client,
        baseUrl: connection.baseUrl,
        collectionUuid: args.collectionUuid,
        profile,
        schema,
      });
      const id = newId();
      held = { id, build, connection };
      const e = build.existing;
      return {
        buildId: id,
        title: build.record.title,
        volumes: build.index.volumes.map((v) => ({ heading: v.heading, issues: v.issues.map((i) => i.label) })),
        issueCount: build.index.volumes.reduce((n, v) => n + v.issues.length, 0),
        heldBack: build.index.heldBack.map((h) => ({ reason: h.reason, items: h.items.map((i) => i.name) })),
        notInSeries: build.index.notInSeries.map((l) => ({ name: l.name, reason: l.reason })),
        existing:
          e.kind === 'one'
            ? { kind: 'one', status: e.status }
            : e.kind === 'many'
              ? { kind: 'many', names: e.items.map((i) => i.name) }
              : e,
      };
    },

    async saveFiles(args: Parameters<OeqApi['indexSaveFiles']>[0]): Promise<IndexSaveResult> {
      return saveIndexFiles(args.dir, take(args.buildId).build.files, args.replace);
    },

    async upload(args: Parameters<OeqApi['indexUpload']>[0]): Promise<IndexUploadResult> {
      const { build, connection } = take(args.buildId);
      const result = await publishIndex(connection.client, {
        collectionUuid: build.collectionUuid,
        record: build.record,
        files: build.files,
        existing: build.existing,
        draft: args.draft,
      });
      return { kind: result.kind, url: `${itemUrl(connection.baseUrl, result.uuid)}index.html` };
    },
  };
}

export function registerIndexHandlers(ipcMain: IpcMain, deps: IndexHandlerDeps): void {
  const h = createIndexHandlers(deps);
  ipcMain.handle(CHANNELS.indexTemplates, () => h.templates());
  ipcMain.handle(CHANNELS.indexPreview, (_e, args: Parameters<OeqApi['indexPreview']>[0]) => h.preview(args));
  ipcMain.handle(CHANNELS.indexSaveFiles, (_e, args: Parameters<OeqApi['indexSaveFiles']>[0]) => h.saveFiles(args));
  ipcMain.handle(CHANNELS.indexUpload, (_e, args: Parameters<OeqApi['indexUpload']>[0]) => h.upload(args));
}
```

In `src/desktop/handlers.ts`: `import { registerIndexHandlers } from './indexHandlers.js';`, and at the end of `registerHandlers`, after `registerExtractHandlers(...)`:

```ts
  // Series index. Its own module, like extract; the client is built per call
  // exactly as listCollections builds one.
  registerIndexHandlers(ipcMain, {
    templatesDir: resolveResourcePath(resourcePathOpts(), 'templates'),
    connect: async (instanceId: string) => {
      const { inst, settings } = await requireSettings(instanceId);
      const cfg = buildConfig(inst, settings, 'unused');
      return {
        client: buildClient(cfg, buildAuth(cfg, tokens(), inst.id)),
        baseUrl: inst.baseUrl,
        fallbackSchemaUuid: inst.schemaUuid,
      };
    },
  });
```

- [ ] **Step 5: Run, expect PASS** -- `npx vitest run tests/desktop/indexHandlers.test.ts tests/desktop/preload-channels.test.ts tests/desktop/rendererPurity.test.ts`; `npm run typecheck`.

- [ ] **Step 6: Commit** -- `git add src/desktop tests/desktop/indexHandlers.test.ts && git commit -m "feat(desktop): index channels; the build is held in the main process by id"`

---

### Task 13: Desktop renderer -- the flow's state and controller

**Files:**
- Create: `src/desktop/ui/seriesIndex/state.ts`
- Create: `src/desktop/ui/seriesIndex/controller.ts`
- Test: `tests/desktop/ui/seriesIndex/controller.test.ts`

- [ ] **Step 1: Create the state** (`src/desktop/ui/seriesIndex/state.ts`):

```ts
// src/desktop/ui/seriesIndex/state.ts
import type { IndexPreview } from '../../ipc.js';
import type { TemplateSummary } from '../../../core/extract/templates.js';

export interface IndexFlowState {
  templates: TemplateSummary[] | null;
  templateId: string | null;
  loading: boolean;
  preview: IndexPreview | null;
  saveFiles: boolean;
  folder: string | null;
  upload: boolean;
  draft: boolean;
  working: boolean;
  done: string[];
  error: string | null;
}

export function initialIndexState(): IndexFlowState {
  return {
    templates: null,
    templateId: null,
    loading: false,
    preview: null,
    saveFiles: false,
    folder: null,
    upload: false,
    draft: true,
    working: false,
    done: [],
    error: null,
  };
}

/** Build is offered only when every chosen destination can actually be used. */
export function canBuild(s: IndexFlowState): boolean {
  if (s.working || s.preview === null || s.preview.volumes.length === 0) return false;
  if (!s.saveFiles && !s.upload) return false;
  if (s.saveFiles && s.folder === null) return false;
  if (s.upload && (s.preview.existing.kind === 'many' || s.preview.existing.kind === 'unavailable')) return false;
  return true;
}
```

- [ ] **Step 2: Write the failing tests** (`tests/desktop/ui/seriesIndex/controller.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { createIndexController } from '../../../../src/desktop/ui/seriesIndex/controller.js';
import { canBuild, initialIndexState } from '../../../../src/desktop/ui/seriesIndex/state.js';
import type { IndexPreview, OeqApi } from '../../../../src/desktop/ipc.js';

const preview = (over: Partial<IndexPreview> = {}): IndexPreview => ({
  buildId: 'b1',
  title: 'Fernbrook index',
  volumes: [{ heading: 'Vol 1', issues: ['Issue 1'] }],
  issueCount: 1,
  heldBack: [],
  notInSeries: [],
  existing: { kind: 'none' },
  ...over,
});

function setup(opts: { confirm?: boolean; exists?: boolean; p?: IndexPreview } = {}) {
  const calls: string[] = [];
  let saveAttempts = 0;
  const api = {
    indexTemplates: async () => [{ id: 'sre', label: 'Snake River Echoes' }],
    indexPreview: async () => (calls.push('preview'), opts.p ?? preview()),
    chooseFolder: async () => 'C:/out',
    indexSaveFiles: async (a: { replace: boolean }) => {
      calls.push(`save replace=${a.replace}`);
      saveAttempts += 1;
      return opts.exists && saveAttempts === 1 ? { kind: 'exists' as const, names: ['index.html'] } : { kind: 'saved' as const, paths: ['C:/out/index.html'] };
    },
    indexUpload: async (a: { draft: boolean }) => (calls.push(`upload draft=${a.draft}`), { kind: 'created' as const, url: 'https://x/items/n/0/index.html' }),
  } as unknown as OeqApi;
  const confirms: string[] = [];
  const c = createIndexController({
    api,
    instanceId: 'i',
    collectionUuid: 'c1',
    confirm: (text: string) => (confirms.push(text), opts.confirm ?? true),
    onExit: () => calls.push('exit'),
    render: () => {},
  });
  return { c, calls, confirms };
}

describe('index flow controller', () => {
  it('loads templates, previews the chosen one, and builds both destinations', async () => {
    const { c, calls } = setup();
    await c.start();
    expect(c.state().templates).toHaveLength(1);
    await c.setTemplate('sre');
    expect(c.state().preview?.buildId).toBe('b1');
    c.setSaveFiles(true);
    await c.chooseFolder();
    c.setUpload(true);
    expect(canBuild(c.state())).toBe(true);
    await c.build();
    expect(calls).toEqual(['preview', 'save replace=false', 'upload draft=true']);
    expect(c.state().done).toHaveLength(2);
  });

  it('asks before replacing files, and replaces only on yes', async () => {
    const { c, calls, confirms } = setup({ exists: true, confirm: true });
    await c.start();
    await c.setTemplate('sre');
    c.setSaveFiles(true);
    await c.chooseFolder();
    await c.build();
    expect(confirms[0]).toMatch(/index\.html/);
    expect(calls).toContain('save replace=true');
  });

  it('asks before publishing a NEW item, and uploads nothing on no', async () => {
    const { c, calls } = setup({ confirm: false });
    await c.start();
    await c.setTemplate('sre');
    c.setUpload(true);
    c.setDraft(false);
    await c.build();
    expect(calls.some((x) => x.startsWith('upload'))).toBe(false);
  });

  it('cannot build an upload the server would refuse', () => {
    const s = { ...initialIndexState(), preview: preview({ existing: { kind: 'many', names: ['A', 'B'] } }), upload: true };
    expect(canBuild(s)).toBe(false);
  });
});
```

- [ ] **Step 3: Run, expect FAIL** -- `npx vitest run tests/desktop/ui/seriesIndex/controller.test.ts`

- [ ] **Step 4: Implement** (`src/desktop/ui/seriesIndex/controller.ts`):

```ts
// src/desktop/ui/seriesIndex/controller.ts
import type { OeqApi } from '../../ipc.js';
import { errorMessage } from '../errors.js';
import { canBuild, initialIndexState, type IndexFlowState } from './state.js';

/**
 * The "Build an index" flow. Owns its state and render loop, as the extract
 * flow does; app.ts hands over the root element and gets it back on exit.
 *
 * Two confirmations, both naming what will happen: replacing files that are
 * already in the folder, and PUBLISHING a new item (the collection may have no
 * moderation queue). An update keeps the item's state and asks nothing more.
 */
export interface IndexControllerOptions {
  api: OeqApi;
  instanceId: string;
  collectionUuid: string;
  confirm?: (text: string) => boolean;
  onExit(): void;
  render(state: IndexFlowState): void;
}

export function createIndexController(options: IndexControllerOptions) {
  let state = initialIndexState();
  const confirm = options.confirm ?? ((text: string) => window.confirm(text));
  const set = (patch: Partial<IndexFlowState>) => {
    state = { ...state, ...patch };
    options.render(state);
  };

  return {
    state: () => state,

    async start(): Promise<void> {
      try {
        set({ templates: await options.api.indexTemplates() });
      } catch (err) {
        set({ templates: [], error: errorMessage(err) });
      }
    },

    async setTemplate(id: string): Promise<void> {
      set({ templateId: id, loading: true, preview: null, done: [], error: null });
      try {
        const preview = await options.api.indexPreview({
          instanceId: options.instanceId,
          collectionUuid: options.collectionUuid,
          templateId: id,
        });
        set({ preview, loading: false });
      } catch (err) {
        set({ loading: false, error: errorMessage(err) });
      }
    },

    setSaveFiles(on: boolean): void {
      set({ saveFiles: on });
    },
    setUpload(on: boolean): void {
      set({ upload: on });
    },
    setDraft(draft: boolean): void {
      set({ draft });
    },

    async chooseFolder(): Promise<void> {
      const folder = await options.api.chooseFolder();
      if (folder !== null) set({ folder });
    },

    async build(): Promise<void> {
      if (!canBuild(state) || state.preview === null) return;
      const { buildId, existing } = state.preview;
      const done: string[] = [];
      set({ working: true, error: null, done });
      try {
        if (state.saveFiles && state.folder !== null) {
          let saved = await options.api.indexSaveFiles({ buildId, dir: state.folder, replace: false });
          if (saved.kind === 'exists') {
            const ok = confirm(`${saved.names.join(', ')} already exist in ${state.folder}. Replace them?`);
            saved = ok ? await options.api.indexSaveFiles({ buildId, dir: state.folder, replace: true }) : saved;
          }
          done.push(saved.kind === 'saved' ? `Saved ${saved.paths.join(', ')}` : 'Files not saved: you kept the ones already there.');
        }
        if (state.upload) {
          const publishing = existing.kind === 'none' && !state.draft;
          if (publishing && !confirm('Publish the new index item? It will be live in the collection straight away.')) {
            done.push('Not uploaded: you chose not to publish.');
          } else {
            const up = await options.api.indexUpload({ buildId, draft: state.draft });
            done.push(`${up.kind === 'created' ? 'Created' : 'Updated'} the index item: ${up.url}`);
          }
        }
        set({ working: false, done: [...done] });
      } catch (err) {
        set({ working: false, done: [...done], error: errorMessage(err) });
      }
    },

    exit(): void {
      options.onExit();
    },
  };
}

export type IndexController = ReturnType<typeof createIndexController>;
```

- [ ] **Step 5: Run, expect PASS**; `npx vitest run tests/desktop/rendererPurity.test.ts`; `npm run typecheck`.

- [ ] **Step 6: Commit** -- `git add src/desktop/ui/seriesIndex tests/desktop/ui/seriesIndex && git commit -m "feat(desktop): the index flow's state and controller"`

---

### Task 14: Desktop renderer -- the screen and its entry points

**Files:**
- Create: `src/desktop/ui/seriesIndex/screen.ts`
- Modify: `src/desktop/ui/screens/choose.ts`, `src/desktop/ui/screens/results.ts`, `src/desktop/ui/app.ts`
- Modify tests: `tests/desktop/ui/choose.test.ts`, `tests/desktop/ui/results.test.ts` (their `props()` helpers gain `onBuildIndex: () => {}`)
- Test: `tests/desktop/ui/seriesIndex/screen.test.ts`

- [ ] **Step 1: Write the failing markup tests** (`tests/desktop/ui/seriesIndex/screen.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { indexFlowMarkup } from '../../../../src/desktop/ui/seriesIndex/screen.js';
import { initialIndexState } from '../../../../src/desktop/ui/seriesIndex/state.js';

const preview = {
  buildId: 'b1',
  title: 'Fernbrook <index>',
  volumes: [{ heading: 'Vol 1', issues: ['Issue 1', 'Issue 2'] }],
  issueCount: 2,
  heldBack: [{ reason: '2 items claim volume 3', items: ['A', 'B'] }],
  notInSeries: [{ name: 'Fernbrook index', reason: 'none of its files fits' }],
  existing: { kind: 'one' as const, status: 'draft' },
};

describe('index flow markup', () => {
  it('offers only usable templates, and says so when there are none', () => {
    expect(indexFlowMarkup({ ...initialIndexState(), templates: [] })).toContain('No template can build an index');
  });

  it('shows counts, what was held back and why, escaped', () => {
    const html = indexFlowMarkup({ ...initialIndexState(), templates: [{ id: 'sre', label: 'SRE' }], preview });
    expect(html).toContain('1 volume, 2 issues');
    expect(html).toContain('2 items claim volume 3: A, B');
    expect(html).toContain('Fernbrook &lt;index&gt;');
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('says an update keeps the item as it is instead of offering Draft/Publish', () => {
    const html = indexFlowMarkup({ ...initialIndexState(), templates: [], preview, upload: true });
    expect(html).toContain('Updates the existing index item, which stays draft');
    expect(html).not.toContain('id="index-publish"');
  });

  it('offers Draft/Publish for a new item', () => {
    const html = indexFlowMarkup({
      ...initialIndexState(),
      templates: [],
      preview: { ...preview, existing: { kind: 'none' } },
      upload: true,
    });
    expect(html).toContain('id="index-publish"');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** -- `npx vitest run tests/desktop/ui/seriesIndex/screen.test.ts`

- [ ] **Step 3: Implement** (`src/desktop/ui/seriesIndex/screen.ts`):

```ts
// src/desktop/ui/seriesIndex/screen.ts
import { escapeHtml } from '../dom.js';
import type { IndexPreview } from '../../ipc.js';
import { canBuild, type IndexFlowState } from './state.js';
import type { IndexController } from './controller.js';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function existingMarkup(s: IndexFlowState, e: IndexPreview['existing']): string {
  switch (e.kind) {
    case 'one':
      return `<p class="note">Updates the existing index item, which stays ${escapeHtml(e.status)}.</p>`;
    case 'many':
      return `<p class="error">Cannot upload: ${e.names.length} items carry this index's identifier (${escapeHtml(e.names.join(', '))}). Remove the extra ones in openEQUELLA, then preview again.</p>`;
    case 'unavailable':
      return `<p class="error">Cannot upload: ${escapeHtml(e.reason)}</p>`;
    case 'none':
      return `
        <p>A new index item will be created as:</p>
        <label><input type="radio" name="index-state" id="index-draft" ${s.draft ? 'checked' : ''}> Draft</label>
        <label><input type="radio" name="index-state" id="index-publish" ${s.draft ? '' : 'checked'}> Published</label>`;
  }
}

function previewMarkup(s: IndexFlowState, p: IndexPreview): string {
  const held = p.heldBack.length
    ? `<h2>Held back (${p.heldBack.length})</h2><ul>${p.heldBack
        .map((h) => `<li>${escapeHtml(`${h.reason}: ${h.items.join(', ')}`)}</li>`)
        .join('')}</ul><p class="hint">Remove the extra items in openEQUELLA, then preview again.</p>`
    : '';
  const left = p.notInSeries.length
    ? `<details><summary>Not in the series (${p.notInSeries.length})</summary><ul>${p.notInSeries
        .map((l) => `<li>${escapeHtml(`${l.name} -- ${l.reason}`)}</li>`)
        .join('')}</ul></details>`
    : '';
  const volumes = `<details><summary>Show the ${plural(p.volumes.length, 'volume', 'volumes')}</summary><ul>${p.volumes
    .map((v) => `<li>${escapeHtml(v.heading)}<ul>${v.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul></li>`)
    .join('')}</ul></details>`;
  return `
    <h2>${escapeHtml(p.title)}</h2>
    <p>${plural(p.volumes.length, 'volume', 'volumes')}, ${plural(p.issueCount, 'issue', 'issues')}.</p>
    ${held}${left}${volumes}
    <fieldset>
      <legend>Where should it go?</legend>
      <label><input type="checkbox" id="index-save-files" ${s.saveFiles ? 'checked' : ''}> Save as files for a web server</label>
      ${s.saveFiles ? `<button id="index-folder" type="button">Choose folder…</button> <span class="path">${s.folder ? escapeHtml(s.folder) : 'No folder chosen yet.'}</span>` : ''}
      <label><input type="checkbox" id="index-upload" ${s.upload ? 'checked' : ''}> Create or update the openEQUELLA item</label>
      ${s.upload ? existingMarkup(s, p.existing) : ''}
    </fieldset>
    <div class="button-row"><button id="index-build" type="button" ${canBuild(s) ? '' : 'disabled'}>${s.working ? 'Building…' : 'Build'}</button></div>`;
}

export function indexFlowMarkup(s: IndexFlowState): string {
  const templates =
    s.templates === null
      ? '<p class="note">Loading templates…</p>'
      : s.templates.length === 0
        ? '<p class="note">No template can build an index: it needs file-name patterns and an "index" section.</p>'
        : `<label for="index-template">Template</label>
           <select id="index-template"><option value="">Choose…</option>${s.templates
             .map((t) => `<option value="${escapeHtml(t.id)}" ${t.id === s.templateId ? 'selected' : ''}>${escapeHtml(t.label)}</option>`)
             .join('')}</select>`;
  return `
    <section class="screen">
      <h1>Build an index</h1>
      <p class="hint">One page listing every volume in this collection, each linking to its item and its issues to their files.</p>
      ${templates}
      ${s.loading ? '<p class="note">Searching the collection…</p>' : ''}
      ${s.preview ? previewMarkup(s, s.preview) : ''}
      ${s.done.map((d) => `<p class="note">${escapeHtml(d)}</p>`).join('')}
      ${s.error ? `<p class="error" role="alert">${escapeHtml(s.error)}</p>` : ''}
      <p class="reset-row"><button id="index-back" type="button" class="link-button">Back</button></p>
    </section>`;
}

export function renderIndexFlow(root: HTMLElement, s: IndexFlowState, c: IndexController): void {
  root.innerHTML = indexFlowMarkup(s);
  const on = (id: string, event: string, fn: (el: HTMLInputElement) => void) =>
    root.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener(event, (e) => fn(e.target as HTMLInputElement));
  on('index-template', 'change', (el) => {
    if (el.value) void c.setTemplate(el.value);
  });
  on('index-save-files', 'change', (el) => c.setSaveFiles(el.checked));
  on('index-upload', 'change', (el) => c.setUpload(el.checked));
  on('index-draft', 'change', () => c.setDraft(true));
  on('index-publish', 'change', () => c.setDraft(false));
  on('index-folder', 'click', () => void c.chooseFolder());
  on('index-build', 'click', () => void c.build());
  on('index-back', 'click', () => c.exit());
}
```

- [ ] **Step 4: Entry points.**

`src/desktop/ui/screens/choose.ts`: add to `ChooseProps`, after `onExtract(): void;`:

```ts
  /** "Build an index…" -- needs a chosen collection; see ui/seriesIndex. */
  onBuildIndex(): void;
```

In the markup, inside the `1. Collection` fieldset after `${collectionSection}`:

```ts
        <button id="choose-build-index" type="button" ${props.collectionUuid ? '' : 'disabled'}>
          Build an index of this collection&hellip;
        </button>
```

and with the other listeners:

```ts
  root.querySelector<HTMLButtonElement>('#choose-build-index')?.addEventListener('click', () => props.onBuildIndex());
```

`src/desktop/ui/screens/results.ts`: add `onBuildIndex(): void;` to `ResultsProps` after `onAnotherBatch(): void;`; after the `results-another-btn` button inside the same `button-row`:

```ts
        <button id="results-build-index" type="button">
          Build an index of this collection&hellip;
        </button>
```

and the listener:

```ts
  root.querySelector<HTMLButtonElement>('#results-build-index')?.addEventListener('click', () => props.onBuildIndex());
```

Add `onBuildIndex: () => {},` to the `props()` helpers in `tests/desktop/ui/choose.test.ts` and `tests/desktop/ui/results.test.ts`, and anywhere else `npm run typecheck` reports a missing `onBuildIndex`.

`src/desktop/ui/app.ts`: add imports

```ts
import { createIndexController } from './seriesIndex/controller.js';
import { renderIndexFlow } from './seriesIndex/screen.js';
```

add a function near `render()`:

```ts
/**
 * The index flow, from Choose or Results. Like the extract flow, it owns its
 * own state and render loop and hands the root back on exit.
 */
function openIndexFlow(): void {
  if (!state.collectionUuid) return;
  const root = requireEl('app');
  const controller = createIndexController({
    api: window.oeq,
    instanceId: state.instanceId,
    collectionUuid: state.collectionUuid,
    onExit: () => render(),
    render: (s) => renderIndexFlow(root, s, controller),
  });
  renderIndexFlow(root, controller.state(), controller);
  void controller.start();
}
```

and pass `onBuildIndex: openIndexFlow,` in both the `renderChoose(...)` and `renderResults(...)` props.

- [ ] **Step 5: Run, expect PASS** -- `npx vitest run tests/desktop`; `npm run typecheck`; `npm run build:desktop`.

- [ ] **Step 6: Commit** -- `git add src/desktop tests/desktop && git commit -m "feat(desktop): Build an index -- preview, then files and/or the openEQUELLA item"`

---

### Task 14A: Volume links -- core

The operator's addition (2026-11-18): every volume item carries a link to the index page as its FIRST attachment, before its PDFs. Decisions: the link points at the openEQUELLA index item's page (`{base}/items/{indexUuid}/0/index.html`); adding the links is an optional checkbox on the build, which says how many items it will edit and asks first.

**Checked live on content-test, 2026-11-18:** a draft item with two files; `PUT /api/item/{uuid}/1/` with NO `file` parameter and its bean with `{ type: 'url', url, description }` put FIRST in `attachments` answered 200. The url attachment was given a uuid; the two file attachments kept their uuids and their files (`/file/...` still 200); the version stayed 1; and openEQUELLA's own item page listed "Index of all volumes" first under "Links to resources". The test item was purged.

**Files:**
- Modify: `src/core/seriesIndex/types.ts` (`IndexVolume` gains `uuid` and `version`)
- Modify: `src/core/seriesIndex/collect.ts` (fill them)
- Modify: `src/core/client.ts` (`editItem`'s staging area becomes optional)
- Create: `src/core/seriesIndex/links.ts`
- Test: `tests/seriesIndex/links.test.ts`, `tests/seriesIndex/collect.test.ts`, `tests/client.test.ts`

- [ ] **Step 1: Volumes carry their item.** In `types.ts`, add to `IndexVolume`:

```ts
  /** The volume's item, so the index link can be added to it. */
  uuid: string;
  version: number;
```

In `collect.ts`'s `volumes.push({ ... })` add `uuid: hit.uuid, version: hit.version,`. In `tests/seriesIndex/collect.test.ts` add to the first test: `expect(index.volumes[0]).toMatchObject({ uuid: 'v2', version: 1 });`. Fix any test or fixture (e.g. `tests/seriesIndex/render.test.ts`'s literal `SeriesIndex`) that `npm run typecheck` now reports, by adding `uuid`/`version` to it.

- [ ] **Step 2: `editItem` without new files.** In `client.ts`, change the signature to `editItem(uuid, version, bean, stagingUuid?: string)` and build the URL as

```ts
    const query = stagingUuid === undefined ? '' : `?file=${encodeURIComponent(stagingUuid)}`;
    await this.request(`/api/item/${encodeURIComponent(uuid)}/${version}/${query}`, { ... });
```

Update the `IndexClient.editItem` type in `publish.ts` to match (`stagingUuid?: string`). In `tests/helpers/mockServer.ts`'s PUT route, accept a missing `file` (record `staging: ''`), but still 404 a `file` that names an unknown staging area. Add a client test: `editItem('a', 1, bean)` sends no `file` parameter and the mock records `staging: ''`.

- [ ] **Step 3: Write the failing tests** (`tests/seriesIndex/links.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { linkVolumes, indexPageUrl, type LinkClient } from '../../src/core/seriesIndex/links.js';

const URL_ = 'https://oeq.example.edu/items/idx/0/index.html';

function fake(beans: Record<string, Record<string, unknown>>, failOn?: string) {
  const edits: { uuid: string; attachments: Record<string, unknown>[] }[] = [];
  const client: LinkClient = {
    async getItemBean(uuid) {
      if (uuid === failOn) throw new Error('server said no');
      return structuredClone(beans[uuid]!);
    },
    async editItem(uuid, _v, bean, staging) {
      expect(staging).toBeUndefined();
      edits.push({ uuid, attachments: bean['attachments'] as Record<string, unknown>[] });
    },
  };
  return { client, edits };
}
const file = (name: string) => ({ type: 'file', filename: name, uuid: `${name}-u` });

describe('linkVolumes', () => {
  it('puts the link first and keeps every other attachment', async () => {
    const f = fake({ v1: { uuid: 'v1', version: 1, attachments: [file('a.pdf'), file('b.pdf')] } });
    const r = await linkVolumes(f.client, [{ uuid: 'v1', version: 1, heading: 'Vol 1' }], URL_, 'Index of all volumes');
    expect(r).toEqual({ added: 1, alreadyThere: 0, failed: [] });
    expect(f.edits[0]!.attachments).toEqual([
      { type: 'url', url: URL_, description: 'Index of all volumes' },
      file('a.pdf'),
      file('b.pdf'),
    ]);
  });

  it('leaves a volume alone when the link is already first', async () => {
    const link = { type: 'url', url: URL_, description: 'Index of all volumes', uuid: 'l' };
    const f = fake({ v1: { attachments: [link, file('a.pdf')] } });
    const r = await linkVolumes(f.client, [{ uuid: 'v1', version: 1, heading: 'Vol 1' }], URL_, 'Index of all volumes');
    expect(r).toEqual({ added: 0, alreadyThere: 1, failed: [] });
    expect(f.edits).toEqual([]);
  });

  it('moves the link to first place, keeping its uuid, rather than adding a second', async () => {
    const link = { type: 'url', url: URL_, description: 'Old words', uuid: 'l' };
    const f = fake({ v1: { attachments: [file('a.pdf'), link] } });
    await linkVolumes(f.client, [{ uuid: 'v1', version: 1, heading: 'Vol 1' }], URL_, 'Index of all volumes');
    expect(f.edits[0]!.attachments).toEqual([{ ...link, description: 'Index of all volumes' }, file('a.pdf')]);
  });

  it('carries on past a failure and names the volume', async () => {
    const f = fake({ v2: { attachments: [file('a.pdf')] } }, 'v1');
    const r = await linkVolumes(
      f.client,
      [
        { uuid: 'v1', version: 1, heading: 'Vol 1' },
        { uuid: 'v2', version: 1, heading: 'Vol 2' },
      ],
      URL_,
      'Index of all volumes',
    );
    expect(r).toEqual({ added: 1, alreadyThere: 0, failed: [{ heading: 'Vol 1', reason: 'server said no' }] });
  });

  it('builds the index page address from the index item', () => {
    expect(indexPageUrl('https://oeq.example.edu/repo', 'idx')).toBe('https://oeq.example.edu/repo/items/idx/0/index.html');
  });
});
```

- [ ] **Step 4: Run, expect FAIL** -- `npx vitest run tests/seriesIndex/links.test.ts`

- [ ] **Step 5: Implement** (`src/core/seriesIndex/links.ts`):

```ts
// src/core/seriesIndex/links.ts
import { describeReason } from '../errorReason.js';
import { itemUrl } from './collect.js';

/**
 * A link to the index on every volume, as its FIRST attachment (operator,
 * 2026-11-18). Checked live: a PUT with no staging area and the bean's
 * attachments reordered keeps every file and its uuid, and openEQUELLA's item
 * page lists them in that order.
 *
 * IDEMPOTENT: a volume that already has a link to THIS index page (matched by
 * url) is left alone when it is first, or moved to first keeping its uuid --
 * never given a second. Carries on past a failure and names it: one refused
 * volume must not leave the rest unlinked with nobody told.
 */

export interface LinkClient {
  getItemBean(uuid: string, version: number): Promise<Record<string, unknown>>;
  editItem(uuid: string, version: number, bean: Record<string, unknown>, stagingUuid?: string): Promise<void>;
}

export interface LinkResult {
  added: number;
  alreadyThere: number;
  failed: { heading: string; reason: string }[];
}

export function indexPageUrl(base: string, indexUuid: string): string {
  return `${itemUrl(base, indexUuid)}index.html`;
}

export async function linkVolumes(
  client: LinkClient,
  volumes: readonly { uuid: string; version: number; heading: string }[],
  url: string,
  label: string,
): Promise<LinkResult> {
  const result: LinkResult = { added: 0, alreadyThere: 0, failed: [] };
  for (const v of volumes) {
    try {
      const bean = await client.getItemBean(v.uuid, v.version);
      const current = Array.isArray(bean['attachments']) ? (bean['attachments'] as Record<string, unknown>[]) : [];
      const at = current.findIndex((a) => a['type'] === 'url' && a['url'] === url);
      if (at === 0 && current[0]!['description'] === label) {
        result.alreadyThere += 1;
        continue;
      }
      const link = at === -1 ? { type: 'url', url, description: label } : { ...current[at]!, description: label };
      const rest = current.filter((_, i) => i !== at);
      await client.editItem(v.uuid, v.version, { ...bean, attachments: [link, ...rest] });
      result.added += 1;
    } catch (err) {
      result.failed.push({ heading: v.heading, reason: describeReason(err) });
    }
  }
  return result;
}
```

(`describeReason` is the core's one way to turn an error into words, following its `cause` chain. Do NOT import from `src/desktop/ui/errors.ts`, which is renderer code.)

- [ ] **Step 6: Run, expect PASS** -- `npx vitest run tests/seriesIndex tests/client.test.ts`; `npm run typecheck`.

- [ ] **Step 7: Commit** -- `feat(index): a link to the index as every volume's first attachment`

---

### Task 14B: Volume links -- CLI and desktop

**Files:**
- Modify: `src/cli/indexPage.ts` (`--link-volumes`)
- Modify: `src/desktop/ipc.ts`, `src/desktop/preload.cts`, `src/desktop/indexHandlers.ts` (channel `indexLinkVolumes`)
- Modify: `src/desktop/ui/seriesIndex/state.ts`, `controller.ts`, `screen.ts` (the third checkbox)
- Tests: `tests/cli-index.test.ts`, `tests/desktop/indexHandlers.test.ts`, `tests/desktop/ui/seriesIndex/controller.test.ts`, `screen.test.ts`

Rules (both front ends):
- The links can be added only when the index item exists or is being created in the same build -- `existing.kind === 'one'`, or the upload destination is chosen and `existing.kind === 'none'`. Otherwise the option is not offered (desktop) or refused (CLI: "--link-volumes needs the index item: add --upload, or upload it first").
- The link's address is `indexPageUrl(base, indexUuid)`; its words are `Index of all ${labels.groups}` (e.g. "Index of all volumes").
- Only LISTED volumes are linked; held-back volumes are not, and the summary says so.
- It runs AFTER the upload, so a newly created index item's uuid is known.
- The result line: "Linked N volumes to the index (M already had it). Not linked: Vol 3 -- reason; ...".

- [ ] **Step 1: CLI.** `IndexCliOptions` gains `linkVolumes?: boolean`; `checkIndexFlags` returns `link: boolean` and refuses `--link-volumes` without `--upload` unless... keep it simple and strict: `--link-volumes` REQUIRES `--upload` (the upload is idempotent -- an existing item is updated in place -- so this costs nothing and guarantees the index item exists). Test: `checkIndexFlags({ template: 't', linkVolumes: true })` throws `/--link-volumes needs --upload/`. In `indexAction`, after the upload: `const r = await linkVolumes(client, build.index.volumes, indexPageUrl(cfg.baseUrl, result.uuid), \`Index of all ${build.labels.groups}\`)` and print the result line. Register `.option('--link-volumes', 'with --upload: add a link to the index as every listed volume\'s first attachment')`.

- [ ] **Step 2: Desktop main.** Add to `ipc.ts`: `indexLinkVolumes(args: { buildId: string }): Promise<{ added: number; alreadyThere: number; failed: { heading: string; reason: string }[] }>` and `CHANNELS.indexLinkVolumes = 'oeq:indexLinkVolumes'` (mirror in `preload.cts`). `IndexPreview` gains `volumeCount` is already derivable from `volumes.length` -- add nothing else. In `indexHandlers.ts`, `upload` records the uploaded index uuid on the held build (`held.indexUuid = result.uuid`); `existing.kind === 'one'` also sets it at preview time. `linkVolumes({ buildId })` refuses (ValidationError: "Upload the index item first.") when no index uuid is known, otherwise calls core `linkVolumes`. Test: preview -> upload -> linkVolumes edits each listed volume (fake client records `editItem` calls); linkVolumes before upload with `existing: none` is refused.

- [ ] **Step 3: Desktop renderer.** `IndexFlowState` gains `linkVolumes: boolean` (default false). The screen shows a third checkbox, `id="index-link-volumes"`, labelled `Add a link to the index on every volume (edits N items)` where N is `preview.volumes.length`, offered only when `existing.kind === 'one'` OR (`existing.kind === 'none'` AND `upload` is checked). `canBuild` is unchanged except that `linkVolumes` alone (no files, no upload) is allowed when `existing.kind === 'one'`. In `build()`, after the upload step: if `linkVolumes`, `confirm(\`Add a link to the index as the first attachment of ${n} volume items? This edits each of them in openEQUELLA.\`)`, then `api.indexLinkVolumes({ buildId })` and push the result line into `done`. Tests: the checkbox is absent with `existing.kind === 'none'` and upload unchecked; present otherwise; build with linkVolumes asks, then calls `indexLinkVolumes` after `indexUpload`; a "no" skips it and says "Volumes not linked: you chose not to edit them."

- [ ] **Step 4:** `npx vitest run tests/cli-index.test.ts tests/desktop`; `npm run typecheck`; `npm run build:desktop`.

- [ ] **Step 5: Commit** -- `feat(index): add the index link to every volume, from the CLI and the desktop`

---

### Task 15: Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-11-18-series-index-design.md` (record the two deviations above under a heading "Changes during planning")
- Modify: `README.md` (a "Series index page" section: what it does, the template `index` section with `groupPatterns`, `oeq-upload index` flags, the desktop entry points, that drafts and live are listed alike, that duplicates are held back)
- Modify: `CLAUDE.md` (Status paragraph for the feature; repository-layout lines for `src/core/seriesIndex/`, `src/cli/indexPage.ts`, `src/desktop/indexHandlers.ts`, `src/desktop/ui/seriesIndex/`; a Key domain fact: `/items/{uuid}/0/` and `/items/{uuid}/0/{file}` are the stable addresses, `/file/{uuid}/0/` is a 500, and an in-place `PUT /api/item/{uuid}/{v}/?file=` keeps uuid, version and attachment uuids)
- Modify: `docs/SESSION-HANDOFF.md` (new RESUME HERE: built, what is left -- the live run)

- [ ] **Step 1:** Write each change. Keep every example name invented.
- [ ] **Step 2:** `npx vitest run` (all green) and `npm run typecheck`.
- [ ] **Step 3: Commit** -- `git commit -am "docs: the series index page"` and `git push`.

---

### Task 16: Code review, /simplify, and the live run

- [ ] **Step 1:** Run `/code-review` over `main...HEAD`, fix what is real, commit.
- [ ] **Step 2:** Run `/simplify` over the same range, apply, commit, push.
- [ ] **Step 3: Live run on content-test (operator present, agreed first).** Desktop app: sign in, choose the Snake River Echoes collection (`7b6aea89-...` on content-test), "Build an index of this collection…", choose Snake River Echoes. Expect: the eight duplicated volumes (15, 22, 25, 27, 31, 35, 36, 37) HELD BACK and named; volumes 16-20 listed through the group pattern. Save as files to a scratch folder and open `index.html` in a browser; upload as a Draft; open the item's `index.html`; follow one volume link and one issue link; type a year into the filter. Then build again and confirm "Updates the existing index item" and that the same item changed. Then tick "Add a link to the index on every volume", confirm, and check in openEQUELLA that a volume's first attachment is "Index of all volumes" and opens the index; build once more with it ticked and confirm the result says every volume already had it.
- [ ] **Step 4:** Record the results in `docs/SESSION-HANDOFF.md`, commit, push; open the PR (read the automated review comments before merging).
