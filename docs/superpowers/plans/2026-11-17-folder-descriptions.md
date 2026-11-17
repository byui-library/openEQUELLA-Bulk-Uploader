# Model-written descriptions for folder rows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the language-model pass write a description for a row built from a folder (one volume, several issues), after the template's fixed sentence, checked against every issue.

**Architecture:**
- **Profile:** a new `after: true` flag on the `ai` source, honoured by `eligible.ts` and `fill.ts`.
- **What is sent:** a new pure `sliceFolder` in `slice.ts` builds what the model reads.
- **Pass input:** `FillTarget` may carry several documents, and verification reads all of them.
- **Folder rows:** `extractFolders` gains the `onRow` hook `extractFolder` has, so the CLI and desktop feed folder rows to the same pass.

**Tech Stack:** TypeScript, Node, vitest, zod (profile schema), Electron (desktop).

**Spec:** [docs/superpowers/specs/2026-11-17-folder-descriptions-design.md](../specs/2026-11-17-folder-descriptions-design.md)

**One deviation from the spec, decided while planning:**
- **The spec:** `FillTarget` becomes `{ row, docs }`.
- **This plan:** it becomes a union, `{ row, doc } | { row, docs }`.
- **Why:** the 70 single-document targets in `tests/ai/fill.test.ts` and every existing caller stay unchanged. One helper, `documentsOf`, turns either form into a list.

**Conventions that bite here (CLAUDE.md):**
- **Line endings:** source files are CRLF in the working copy. Make edits with the Edit tool; a `sed` pattern containing `\n` silently matches nothing.
- **Typecheck limits:** `noUnusedLocals` is OFF, so grep for dead imports.
- **Environment:** unset `ELECTRON_RUN_AS_NODE` before any npm/electron command.
- **Commands:**
  - tests: `npx vitest run <path>`
  - typecheck: `npx tsc --noEmit -p .`
  - desktop build: `npm run build:desktop`
- **Invented fixtures only:** every person, date and town in a test is invented. Never paste document text from the real batch.
- **Every commit message ends with:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

---

## File map

| File | Change |
| --- | --- |
| `src/core/extract/types.ts` | `Source` gains `{ ai: true; after?: true }` |
| `src/core/extract/profile.ts` | zod accepts `after: true` on `ai` only |
| `src/core/ai/eligible.ts` | `after` columns: eligible unless `aiWritten` has them |
| `src/core/ai/slice.ts` | new `sliceFolder(docs, budget)`; `SliceShape` gains `'issues'` |
| `src/core/ai/prompt.ts` | `PromptInput.documents` (count); folder wording |
| `src/core/ai/fill.ts` | union `FillTarget`, `documentsOf`, folder slice + evidence, lead/room/write, `'folder-row'` reason deleted |
| `src/core/extract/extract.ts` | `extractFolders` `onRow(row, docs)` |
| `src/cli/extract.ts` | `--ai --per-folder` allowed; folder branch runs the pass |
| `src/desktop/extractHandlers.ts` | folder branch runs the pass |
| `src/desktop/ui/extract/controller.ts` | asks consent in per-folder mode too |
| `templates/snake-river-echoes.profile.json` | lead with full stop, `{ai, after}`, `aiInstruction`, `aiProvenance` |
| README, CLAUDE.md, handoff | document it |

---

### Task 1: `after` on the `ai` source

**Files:**
- Modify: `src/core/extract/types.ts` (the `| { ai: true };` member of `Source`)
- Modify: `src/core/extract/profile.ts:34` (`z.object({ ai: z.literal(true) }).strict()`)
- Test: `tests/extract/profile.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `tests/extract/profile.test.ts`; it already imports `parseProfile` and `ValidationError`. Check the top of the file and add whatever is missing.)

```ts
describe('parseProfile -- a model writing after the other sources', () => {
  const withSources = (sources: unknown[]) =>
    JSON.stringify({
      version: 1,
      pattern: '{name}',
      columns: [
        { path: 'attachment name', sources: [{ filename: true }], locked: true },
        { path: 'MWDL/description', sources },
      ],
    });

  it('accepts "after": true on an ai source', () => {
    const profile = parseProfile(withSources([{ join: 'Lead.' }, { ai: true, after: true }]));
    expect(profile.columns[1]!.sources[1]).toEqual({ ai: true, after: true });
  });

  it('refuses "after": false -- leave it out instead', () => {
    expect(() => parseProfile(withSources([{ ai: true, after: false }]))).toThrow(ValidationError);
  });

  it('refuses "after" on any other source', () => {
    expect(() => parseProfile(withSources([{ opening: true, after: true }]))).toThrow(ValidationError);
  });
});
```

- [ ] **Step 2: Run, expect the first test to FAIL** (`after` is an unrecognised key under `.strict()`).

Run: `npx vitest run tests/extract/profile.test.ts`

- [ ] **Step 3: Implement.** In `types.ts`, replace `| { ai: true };` with:

```ts
  | {
      ai: true;
      /**
       * Write the model's text AFTER what this column's other sources
       * produced, joined by one space, instead of only into an empty or
       * flagged cell. The earlier value is never replaced; if the model fails
       * or is refused, it stands alone. See eligible.ts and fill.ts, and
       * docs/superpowers/specs/2026-11-17-folder-descriptions-design.md.
       */
      after?: true;
    };
```

In `profile.ts`, replace `z.object({ ai: z.literal(true) }).strict(),` with:

```ts
  z.object({ ai: z.literal(true), after: z.literal(true).optional() }).strict(),
```

- [ ] **Step 4: Run, expect PASS.** Then `npx tsc --noEmit -p .`. Fix any exhaustiveness errors (e.g. `describeSource` in `src/desktop/ui/extract/sources.ts`, which already matches `'ai' in source`, needs no change).

- [ ] **Step 5: Commit**

```bash
git add src/core/extract/types.ts src/core/extract/profile.ts tests/extract/profile.test.ts
git commit -m "feat(profile): an ai source may write after the column's other sources"
```

---

### Task 2: eligibility for an `after` column

**Files:**
- Modify: `src/core/ai/eligible.ts` (`eligibleColumns`)
- Test: `tests/ai/eligible.test.ts`

- [ ] **Step 1: Write the failing tests** (append; reuse the file's existing row-builder helpers, or this inline one):

```ts
describe('eligibleColumns -- a model writing after', () => {
  const profile: Profile = {
    version: 1,
    pattern: '{name}',
    columns: [
      { path: 'MWDL/description', sources: [{ join: 'Lead.' }, { ai: true, after: true }] },
    ],
  };
  const row = (cell: string, over: Partial<ExtractedRow> = {}): ExtractedRow => ({
    cells: { 'MWDL/description': cell },
    sources: {},
    notes: [],
    flagged: {},
    aiWritten: {},
    ...over,
  });

  it('is eligible when the cell already holds the lead, unflagged', () => {
    expect(eligibleColumns(profile, row('Lead.'))).toEqual(['MWDL/description']);
  });

  it('is eligible when the cell is empty', () => {
    expect(eligibleColumns(profile, row(''))).toEqual(['MWDL/description']);
  });

  it('is not eligible once a model has written it', () => {
    const written = row('Lead. Summary.', { aiWritten: { 'MWDL/description': { note: 'n', factField: false } } });
    expect(eligibleColumns(profile, written)).toEqual([]);
  });
});
```

(Check the `aiWritten` entry shape in `src/core/extract/types.ts`, `ExtractedRow.aiWritten`, and match it.)

- [ ] **Step 2: Run, expect the first test to FAIL.** Run: `npx vitest run tests/ai/eligible.test.ts`

- [ ] **Step 3: Implement.** In `eligible.ts`, add above `eligibleColumns`:

```ts
/** True when this column's model writes AFTER its other sources (`{ ai: true, after: true }`). */
export function writesAfter(column: Column): boolean {
  return column.sources.some((s) => 'ai' in s && s.after === true);
}
```

and change the filter in `eligibleColumns` to:

```ts
    .filter((column) => {
      // AN `after` COLUMN KEEPS WHAT IS THERE AND ADDS TO IT, so whether the
      // cell is empty or flagged does not decide it. What does is whether a
      // model has already added to it: a second pass must not pay to append
      // twice.
      if (writesAfter(column)) return row.aiWritten[column.path] === undefined;
      const value = (row.cells[column.path] ?? '').trim();
      return value === '' || row.flagged[column.path] !== undefined;
    })
```

Add a sentence to the module's docblock saying the `after` rule exists and why.

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(ai): an after column is filled on every row a model has not written`

---

### Task 3: `sliceFolder`

**Files:**
- Modify: `src/core/ai/slice.ts`
- Test: `tests/ai/slice.test.ts`

- [ ] **Step 1: Write the failing tests** (append):

```ts
describe('sliceFolder', () => {
  const issue = (name: string, text: string) => ({
    name,
    doc: { text, hasTextLayer: true, properties: {}, tables: [] },
  });
  const words = (word: string, n: number) => Array.from({ length: n }, () => word).join(' ');

  it('gives each issue an equal share of the budget, in order, labelled', () => {
    const s = sliceFolder(
      [issue('No1.pdf', words('alpha', 500)), issue('No2.pdf', words('beta', 500))],
      2000,
    );
    expect(s.shape).toBe('issues');
    expect(s.text.indexOf('[No1.pdf]')).toBeLessThan(s.text.indexOf('[No2.pdf]'));
    expect(s.text.length).toBeLessThanOrEqual(2000);
    const second = s.text.split('[No2.pdf]')[1]!;
    expect(second.length).toBeGreaterThan(800);
  });

  it('sends a short issue whole and does not pad it', () => {
    const s = sliceFolder([issue('No1.pdf', 'A short masthead.'), issue('No2.pdf', words('beta', 50))], 2000);
    expect(s.text).toContain('A short masthead.');
  });

  it('cuts each share at a word boundary', () => {
    const s = sliceFolder([issue('No1.pdf', words('alphabet', 400))], 300);
    const body = s.text.replace('[No1.pdf]\n', '');
    expect(body.endsWith('alphabet')).toBe(true);
  });

  it('leaves out an issue with no text', () => {
    const s = sliceFolder([issue('No1.pdf', ''), issue('No2.pdf', words('beta', 50))], 2000);
    expect(s.text).not.toContain('[No1.pdf]');
    expect(s.text).toContain('[No2.pdf]');
  });

  it('is empty when no issue has text', () => {
    expect(sliceFolder([issue('No1.pdf', '  ')], 2000)).toEqual({ text: '', shape: 'empty' });
  });
});
```

Add `sliceFolder` to the file's import from `../../src/core/ai/slice.js`.

- [ ] **Step 2: Run, expect FAIL** (`sliceFolder` not exported).

- [ ] **Step 3: Implement.** In `slice.ts`:
  - Change `SliceShape` to `'whole' | 'opening+sections' | 'issues' | 'empty'`.
  - Document `'issues'`: the start of each of several documents, in order.
  - Add:

```ts
/**
 * What the model reads for a row built from a FOLDER: the START of each
 * document, in attachment order, each labelled with its file name.
 *
 * THE START, NOT `readOpening`'s first prose line. A journal issue opens with
 * its masthead and contents, which are the best summary of what is in it, and
 * a contents page is exactly what `isProse` rejects.
 *
 * THE BUDGET IS DIVIDED EVENLY across the documents that have text, so a
 * four-issue volume at the default 8,000 sends about 2,000 of each -- one
 * budget, one setting, and the consent dialog's `requests x budget` stays a
 * true maximum. A document shorter than its share is sent whole; its leftover
 * is not redistributed (a short masthead says what it says).
 *
 * A document with no text is left out here; `fill.ts` names it in the notes.
 */
export function sliceFolder(
  docs: readonly { name: string; doc: { text: string } }[],
  budget: number,
): Slice {
  assertUsableBudget(budget);
  const withText = docs.filter((d) => d.doc.text.trim() !== '');
  if (withText.length === 0) return { text: '', shape: 'empty' };

  const parts = withText.map((d) => `[${d.name}]\n`);
  const overhead = parts.reduce((n, label) => n + label.length, 0) + SEPARATOR.length * (parts.length - 1);
  const share = Math.floor((budget - overhead) / withText.length);
  if (share < MIN_USEFUL) return { text: '', shape: 'empty' };

  const text = withText
    .map((d, i) => {
      const body = d.doc.text.trim();
      return `${parts[i]}${body.length <= share ? body : cutAtWord(body, share)}`;
    })
    .join(SEPARATOR);
  return { text, shape: 'issues' };
}

/** `text` cut to at most `limit` characters at the last space, or hard at the limit when there is none. */
function cutAtWord(text: string, limit: number): string {
  const head = text.slice(0, limit);
  const lastSpace = head.lastIndexOf(' ');
  return (lastSpace >= MIN_USEFUL ? head.slice(0, lastSpace) : head).trimEnd();
}
```

(`MIN_USEFUL` and `SEPARATOR` already exist in `slice.ts`; read them first and confirm their values. If `MIN_USEFUL` is not module-level, hoist it.)

- [ ] **Step 4: Run, expect PASS.** Run the whole `tests/ai` folder too: a `SliceShape` switch elsewhere may now be non-exhaustive (`sentClause` in `fill.ts` handles it in Task 5).
- [ ] **Step 5: Commit** — `feat(ai): sliceFolder -- the start of every issue, the budget divided evenly`

---

### Task 4: the prompt says "volume of N issues"

**Files:**
- Modify: `src/core/ai/prompt.ts` (`PromptInput`, `buildPrompt`)
- Test: `tests/ai/prompt.test.ts`

- [ ] **Step 1: Write the failing tests:**

```ts
describe('buildPrompt -- several documents', () => {
  it('describes a volume made of the issues below', () => {
    const p = buildPrompt({ field: 'a description', document: 'x', instruction: null, maxLength: 900, documents: 4 });
    expect(p).toMatch(/^Write a description of the volume below, made up of 4 issues, for a library catalogue\./);
  });

  it('keeps the single-document wording for one document', () => {
    const p = buildPrompt({ field: 'a description', document: 'x', instruction: null, maxLength: 900, documents: 1 });
    expect(p).toMatch(/^Write a description for the document below, for a library catalogue\./);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (type error on `documents` / wording).

- [ ] **Step 3: Implement.** Add to `PromptInput`:

```ts
  /** How many documents the slice holds. More than one is a folder row: one
   *  item -- a volume -- whose files are its issues. Absent means one. */
  documents?: number;
```

In `buildPrompt`, replace the first array element:

```ts
    (input.documents ?? 1) > 1
      ? `Write ${input.field} of the volume below, made up of ${input.documents} issues, for a library catalogue.`
      : `Write ${input.field} for the document below, for a library catalogue.`,
```

Leave every other line as it is, including the "the document" fence wording: the fence is one block holding all the issues.

- [ ] **Step 4: Run, expect PASS** (all of `tests/ai/prompt.test.ts`).
- [ ] **Step 5: Commit** — `feat(ai): the prompt names a volume of N issues`

---

### Task 5: the pass — several documents, and writing after

**Files:**
- Modify: `src/core/ai/fill.ts`
- Test: `tests/ai/fill.test.ts`

- [ ] **Step 1: Write the failing tests** (append; the file's `row`, `doc`, `provider`, `promptsOf`, `options` helpers exist at its top):

```ts
describe('fillWithModel -- a folder row, written after a lead', () => {
  const lead = 'Valley Quarterly, Volume 2.';
  const afterProfile: Profile = {
    version: 1,
    pattern: '{name}',
    columns: [
      { path: 'MWDL/description', sources: [{ join: lead }, { ai: true, after: true }] },
    ],
  };
  const issues = [
    { name: 'No1.pdf', doc: doc('Spring issue. The Aster ferry crossing opened in 1884.') },
    { name: 'No2.pdf', doc: doc('Summer issue. Notes on the Birch irrigation canal.') },
    { name: 'No3.pdf', doc: doc('Autumn issue. The Cedar Creek school, built in 1902.') },
  ];
  const target = () => ({ row: row({ cells: { 'MWDL/description': lead } }), docs: issues });

  it('keeps the lead and adds the summary after one space', async () => {
    const t = target();
    await fillWithModel([t], afterProfile, provider('The issues cover river crossings and schools.'), options());
    expect(t.row.cells['MWDL/description']).toBe(`${lead} The issues cover river crossings and schools.`);
  });

  it('sends every issue, labelled, and names the volume', async () => {
    const p = provider('Summary.');
    await fillWithModel([target()], afterProfile, p, options({ budget: 3000 }));
    const prompt = promptsOf(p)[0]!;
    expect(prompt).toContain('made up of 3 issues');
    for (const name of ['[No1.pdf]', '[No2.pdf]', '[No3.pdf]']) expect(prompt).toContain(name);
  });

  it('tells the model only the room left after the lead', async () => {
    const p = provider('Summary.');
    await fillWithModel([target()], afterProfile, p, options());
    expect(promptsOf(p)[0]).toContain(`no more than ${1000 - lead.length - 1} characters`);
  });

  it('accepts a date only the third issue supports', async () => {
    const t = target();
    await fillWithModel([t], afterProfile, provider('Includes a school built in 1902.'), options());
    expect(t.row.cells['MWDL/description']).toBe(`${lead} Includes a school built in 1902.`);
  });

  it('refuses a date no issue supports, and leaves the lead alone', async () => {
    const t = target();
    await fillWithModel([t], afterProfile, provider('A school built in 1907.'), options());
    expect(t.row.cells['MWDL/description']).toBe(lead);
    expect(t.row.aiWritten).toEqual({});
  });

  it('sends nothing when the lead leaves too little room', async () => {
    const t = { row: row({ cells: { 'MWDL/description': 'x'.repeat(950) } }), docs: issues };
    const p = provider('Summary.');
    await fillWithModel([t], afterProfile, p, options());
    expect(p.complete).not.toHaveBeenCalled();
    expect(t.row.notes.join(' ')).toMatch(/leaves fewer than 100 of this column's 1000 characters/);
  });

  it('writes the summary alone into an empty cell', async () => {
    const t = { row: row(), docs: issues };
    await fillWithModel([t], afterProfile, provider('Summary.'), options());
    expect(t.row.cells['MWDL/description']).toBe('Summary.');
  });

  it('records the write, so a second pass does not append again', async () => {
    const t = target();
    const p = provider('Summary.');
    await fillWithModel([t], afterProfile, p, options());
    await fillWithModel([t], afterProfile, p, options());
    expect(p.complete).toHaveBeenCalledTimes(1);
  });

  it('names an issue with no text, and still sends the others', async () => {
    const t = { row: row({ cells: { 'MWDL/description': lead } }), docs: [...issues, { name: 'No4.pdf', doc: doc('') }] };
    await fillWithModel([t], afterProfile, provider('Summary.'), options());
    expect(t.row.notes.join(' ')).toMatch(/'No4\.pdf' has no text to read, so it was not sent/);
    expect(t.row.cells['MWDL/description']).toBe(`${lead} Summary.`);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (type error on `docs` in a target).

- [ ] **Step 3: Implement.** In `fill.ts`:

1. **Imports:**
   - Add `sliceFolder` to the import from `./slice.js`.
   - Add `type FolderDoc` from `../extract/rows.js`.
   - Add `writesAfter` from `./eligible.js`.

2. **Replace `FillTarget`:**

```ts
/**
 * One row and what it was built from: ONE document for a file row, or every
 * document of a FOLDER row in attachment order. A union rather than one shape
 * so the single-document callers did not change.
 */
export type FillTarget =
  | { row: ExtractedRow; doc: DocumentData }
  | { row: ExtractedRow; docs: readonly FolderDoc[] };

/** A target's documents as a list, whichever form it took. */
function documentsOf(target: FillTarget, file: string): readonly FolderDoc[] {
  return 'docs' in target ? target.docs : [{ name: file, doc: target.doc }];
}

/** The fewest characters worth asking a model to describe a volume in. */
const MIN_ROOM = 100;
```

3. **The type, the reason and the note:** delete `'folder-row'` from `MissingModelReason` and from `MISSING_MODEL`, and delete the paragraph about it in the docblock above the type.

4. **The loop in `fillWithModel`:**
   - Change `for (const { row, doc } of targets) {` to `for (const target of targets) { const { row } = target;`.
   - Move the `file` constant (it reads `row.cells[ATTACHMENT_COLUMN]`) up to just after that line.
   - Replace `const text = doc.text;` and the `sliceForModel` call with:

```ts
    const docs = documentsOf(target, file);
    // The WHOLE of every document, joined: verification reads this, never the
    // slice -- a claim another page or another issue supports is a coincidence,
    // not a fabrication.
    const text = docs.map((d) => d.doc.text).join('\n\n');
    const slice =
      docs.length > 1
        ? sliceFolder(docs, options.budget)
        : sliceForModel(text, { budget: options.budget, sections: options.sections });
    for (const d of docs.length > 1 ? docs : []) {
      if (d.doc.text.trim() === '') {
        row.notes.push(`'${d.name}' has no text to read, so it was not sent to the model`);
      }
    }
```

5. **Inside the per-column loop**, before `used += 1`, add:

```ts
      // AN `after` COLUMN KEEPS ITS LEAD AND ADDS TO IT. The model is given
      // only the room the lead leaves, so the finished cell is within the limit.
      const after = writesAfter(column);
      const lead = after ? (row.cells[path] ?? '').trim() : '';
      const limit = lead === '' ? limitFor(column) : limitFor(column) - lead.length - 1;
      if (after && limit < MIN_ROOM) {
        row.notes.push(
          `${path}: not sent to the model -- the fixed text leaves fewer than ${MIN_ROOM} of this ` +
            `column's ${limitFor(column)} characters`,
        );
        continue;
      }
```

   - Delete the existing `const limit = limitFor(column);` line that this replaces.
   - Pass `documents: docs.length` into `buildPrompt({...})`.

6. **Where the value is written:** change `row.cells[path] = cleaned.text;` to:

```ts
      row.cells[path] = lead === '' ? cleaned.text : `${lead} ${cleaned.text}`;
```

7. **In `sentClause`**, handle `'issues'`:

```ts
  if (shape === 'whole') return '';
  if (shape === 'issues') return ' The model was sent the start of each file in this folder, not all of it.';
  return ' Only part of the document was sent: its opening and any named sections, not all of it.';
```

8. **The outcome wording:** in the `outcome` computation (`'left blank' : 'not replaced'`), the lead is in the cell, so "not replaced" is already what it says. No change.

- [ ] **Step 4: Run** `npx vitest run tests/ai` and `npx tsc --noEmit -p .`. **Expect** the new tests to PASS, with compile errors at callers still passing `'folder-row'` (fixed in Tasks 7 and 8).
  - **To get green in this task:** at the two call sites (`src/cli/extract.ts` and `src/desktop/extractHandlers.ts`), temporarily delete the `if (wantsModel) noteMissingModel(result.rows, ..., 'folder-row');` lines.
  - **Why it's safe:** Tasks 7 and 8 replace those branches.
  - **Also:** delete any test asserting the `folder-row` note, and say so in the commit.
- [ ] **Step 5: Mutation-check.** With the Edit tool:
  - change `` `${lead} ${cleaned.text}` `` to `cleaned.text`, and confirm the "keeps the lead" test fails;
  - change `- lead.length - 1` to `- 0`, and confirm the "room" test fails.

  Restore both.
- [ ] **Step 6: Commit** — `feat(ai): the pass takes a folder row's issues, and writes after a lead`

---

### Task 6: `extractFolders` hands each row's documents out

**Files:**
- Modify: `src/core/extract/extract.ts` (`extractFolders` options and the per-folder loop)
- Test: `tests/extract/extract.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
it('hands each folder row its documents, in attachment order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oeq-extract-onrow-'));
  await mkdir(join(dir, 'Gazette_V2'));
  await writeFile(join(dir, 'Gazette_V2', 'b.pdf'), 'x');
  await writeFile(join(dir, 'Gazette_V2', 'a.pdf'), 'x');
  const seen: string[][] = [];
  await extractFolders(dir, ordered, {
    reader: async () => emptyDoc,
    onRow: (_row, docs) => { seen.push(docs.map((d) => d.name)); },
  });
  expect(seen).toEqual([['a.pdf', 'b.pdf']]);
});
```

(Place it in the `extractFolders` describe that defines `ordered` and `emptyDoc`.)

- [ ] **Step 2: Run, expect FAIL** (`onRow` not accepted).

- [ ] **Step 3: Implement.**
  - Change the options type of `extractFolders` to include `onRow?: (row: ExtractedRow, docs: readonly FolderDoc[]) => void`.
  - Destructure `onRow` from the options.
  - After `rows.push(row);` in the loop, add `onRow?.(row, docs);`.
  - Replace the docblock paragraph "THERE IS NO `onRow` HOOK, deliberately…" with one saying: `onRow` hands the model pass each row's documents, as `extractFolder`'s does.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(extract): extractFolders hands each row's documents to onRow`

---

### Task 7: the CLI runs the pass on folder rows

**Files:**
- Modify: `src/cli/extract.ts`
- Test: `tests/cli/extract.test.ts` (find the existing `--per-folder` and `--ai` tests with `grep -n "per-folder\|perFolder" tests/cli/*.ts`)

- [ ] **Step 1: Write the failing test.** Find the existing test asserting `--ai cannot be used with --per-folder` and replace it with one that:
  - runs `extractAction` with `perFolder: true, ai: true, yes: true`, an env pointing `OEQ_MODEL_BASE_URL` at `http://localhost:11434/v1` and `OEQ_MODEL` at `m`, and a stub `fetchImpl` returning an OpenAI-shaped reply (copy the stub the file's existing `--ai` tests use);
  - uses a two-folder fixture and a profile whose description column is `[{ join: 'Lead.' }, { ai: true, after: true }]`;
  - asserts the written CSV's description cells read `Lead. <reply>`, and that the stub was called once per folder.

- [ ] **Step 2: Run, expect FAIL** (the refusal throws).

- [ ] **Step 3: Implement.** In `src/cli/extract.ts`:
  - Delete the `if (options.perFolder === true && options.ai === true) { throw … }` block and its comment.
  - Remove the early `if (options.perFolder === true) { … return; }` branch at "ONE ROW PER SUBFOLDER".
  - Let the per-folder case flow through the same `sending` / `unfilled` / `targets` logic as single files, with these differences:
    - **The count:** when `sending !== null`, the consent count is the number of subfolders. Take `const found = await listSubfolders(options.dir)` and call `approve(options, profile, sending, found.folders.length, log)`.
    - **The run:** `const result = await extractFolders(options.dir, profile, { listing: found, ...(sending === null ? {} : { onRow: (row, docs) => { targets.push({ row, docs }); } }) })`.
    - **Afterwards:** `await reportProblems(options, result.problems ?? [], log)`, then the model pass or `noteMissingModel(result.rows, profile, unfilled)`, then `finishExtract`.
  - Keep the single-file path byte-identical. A small `if (options.perFolder === true) { … } else { … }` around the listing and extraction calls is enough; read the whole function first, and keep the dry-run line.
  - Update the `--per-folder` option help text in `src/cli/index.ts`: remove "(cannot be combined with --ai)".

- [ ] **Step 4: Run** `npx vitest run tests/cli` and the typecheck. **Expect** PASS.
- [ ] **Step 5: Commit** — `feat(cli): --ai --per-folder runs the model on each volume`

---

### Task 8: the desktop runs the pass on folder rows

**Files:**
- Modify: `src/desktop/extractHandlers.ts` (`CHANNELS.extractRun` handler)
- Modify: `src/desktop/ui/extract/controller.ts` (`save()`)
- Test: `tests/desktop/extractHandlers.test.ts`, `tests/desktop/ui/extract/controller.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - **The handler:** the existing test "runs one row per subfolder, sends nothing to a model even when approved, and says why" (`tests/desktop/extractHandlers.test.ts`) changes to "runs one row per subfolder and fills its model column when approved". Same fixture and same `modelFor` and `fetchImpl` stubs; make `fetchImpl` return an OpenAI-shaped reply (copy from the file's single-file model tests). Assert `fetchImpl` was called once per folder, and that the CSV's `MWDL/description` reads the reply.
  - **The controller:** change the test asserting no consent dialog in per-folder mode so that it asserts `confirm` IS called, with `documents` equal to the number of scanned folders.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.**
  - **In `extractHandlers.ts`:** replace the per-folder early branch, so the per-folder path uses the same `settings` resolution as single files (`wantsModel && args.modelApproved === true ? await modelSettingsFor(args.instanceId) : null`):

```ts
      if (args.perFolder === true) {
        const targets: FillTarget[] = [];
        const result = await extractFolders(
          args.dir,
          args.profile,
          settings === null ? {} : { onRow: (row, docs) => { targets.push({ row, docs }); } },
        );
        if (wantsModel) {
          if (settings === null) {
            noteMissingModel(result.rows, args.profile, args.modelApproved === true ? 'not-configured' : 'not-approved');
          } else {
            await runModelPass(targets, args.profile, settings, options.fetchImpl, options.onModelProgress);
          }
        }
        const problems = await writeProblemsLog(args.outPath, result.problems ?? []);
        await writeCsv(args.outPath, args.profile, result.rows);
        return { outPath: args.outPath, written: result.rows.length, flagged: countNeedingReview(result.rows), aiWritten: countModelWritten(result.rows), problems };
      }
```

    Move the `const settings = …` line above this branch, and update the comment above it to say both modes now run the pass.
  - **In `controller.ts` `save()`:** replace the `state.perFolder ? { proceed: true, sendToModel: false } : await approveModelRun(state.profile)` ternary with `await approveModelRun(state.profile)`, and delete the "NO QUESTION IS ASKED IN PER-FOLDER MODE" comment. `state.scan.supported` already holds the folder names in per-folder mode, so the count is right; add a one-line comment saying so where `documents:` is set.

- [ ] **Step 4: Run** `npx vitest run tests/desktop`, the typecheck, and `npm run build:desktop`. **Expect** PASS and a clean build. `tests/desktop/rendererPurity.test.ts` must still pass: the controller gains no imports.
- [ ] **Step 5: Commit** — `feat(desktop): a folder batch asks before sending, then fills each volume's description`

---

### Task 9: the Snake River Echoes template

**Files:**
- Modify: `templates/snake-river-echoes.profile.json`
- Test: `tests/extract/templates.test.ts` (or wherever the shipped templates are loaded; `grep -rln "snake-river-echoes" tests`)

- [ ] **Step 1: Write the failing test:**

```ts
it('Snake River Echoes: a fixed lead, then a model summary, disclosed in the item', async () => {
  const profile = await loadTemplate('templates', 'snake-river-echoes');
  const description = profile.columns.find((c) => c.path === 'MWDL/description')!;
  expect(description.sources).toEqual([
    { join: 'Upper Snake River Valley Historical Society Quarterly, Volume {group}.' },
    { ai: true, after: true },
  ]);
  expect(profile.aiInstruction).toMatch(/subjects/);
  expect(profile.aiProvenance).toEqual({
    path: 'MWDL/conversionSpecifications',
    append: 'Description partly generated by a language model ({model})',
  });
});
```

(Match the existing `loadTemplate` call signature used in that test file.)

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** In the template:
  - Set the description column's `sources` to the two above. Note the full stop after `{group}`.
  - Add, at the top level:

```json
  "aiInstruction": "Summarise the subjects the issues cover -- the topics, places, people, events and periods -- in one or two sentences of plain prose. Do not repeat the journal's title or the volume number, which are already given. Do not list article titles.",
  "aiProvenance": {
    "path": "MWDL/conversionSpecifications",
    "append": "Description partly generated by a language model ({model})"
  },
```

- [ ] **Step 4: Run the template test, and the whole suite:** `npx vitest run`. **Expect** all PASS.
  - Fix any other test that pins the old description sources: grep `Historical Society Quarterly` in `tests/`.
  - Then run the extractor offline, with no model, against a temp copy of the invented fixtures. The description should read the lead alone with a `not-requested` note.
- [ ] **Step 5: Commit** — `feat(templates): Snake River Echoes -- a summary of the volume after the fixed sentence, disclosed`

---

### Task 10: documentation

**Files:**
- Modify: `README.md`:
  - "Several files on one contribution": replace the bullet that says the model does not fill folder rows;
  - "Letting a language model write a description": add the `after` setting and the folder slice.
- Modify: `docs/INSTALL.md`: the folder-upload steps mention the consent dialog now appears for folder batches with a model column.
- Modify: `CLAUDE.md`:
  - the multi-file Status paragraph;
  - the layout entry for `slice.ts`;
  - a short key fact: folder rows are verified against all issues joined, and `after` never replaces.
- Modify: `docs/SESSION-HANDOFF.md`: the resume point and next steps (the live run).

- [ ] **Step 1: Write the doc changes.**
  - **README, folder section, the bullet to add:**

```markdown
- **A language model can describe the whole folder.** It reads the start of
  every file in it — about 2,000 characters each from a four-issue volume at
  the default budget — and every date or other checkable claim must be found
  somewhere in those files. With `{ "ai": true, "after": true }` the model's
  text follows what the column's other sources wrote, so a template's fixed
  sentence stays first; if the model fails or is refused, that sentence stands
  alone.
```

  - **README, model section:** add a short subsection, "Writing after a fixed sentence", describing `after`:
    - the room rule (limit minus the lead);
    - the 100-character floor;
    - that a written cell is never appended to twice.
- [ ] **Step 2: Commit** — `docs: model descriptions for folder rows`

---

### Task 11: review, then the live run

- [ ] **Step 1:** Run the `code-review` skill on the range from the spec commit to HEAD (`555a3d2..HEAD`) and fix confirmed findings. Then run `simplify` on the same range and apply its fixes. Commit each, with the test suite green.
- [ ] **Step 2:** Push: `git push`.
- [ ] **Step 3: Live run, operator present. Ask before running.**
  - **Folder:** copy four or five real volume folders from `Snake River Echoes\SRE` into the session scratchpad.
  - **Desktop:** pick that folder, the Snake River Echoes template and one-item-per-folder, then Save.
  - **Consent:** the dialog must appear, and the operator approves.
  - **Model:** the operator's LM Studio model at `http://127.0.0.1:1234/v1`.
- [ ] **Step 4:** The operator reads each description against its volume. Record, in the handoff only and with no document text:
  - how many were written and how many refused;
  - each refusal's reason;
  - whether any refusal was wrong;
  - the operator's verdict on quality.
- [ ] **Step 5:** Commit the handoff update and push.
