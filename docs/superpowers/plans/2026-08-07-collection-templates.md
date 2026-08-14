# Collection Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a saved profile carry a collection's specialised knowledge, so an "Alumni Obituary" template extracts a death date and a name without any code being written per collection.

**Architecture:** Three new generic sources (`dateNear`, `datePair`, `compose`) and one new check (`filenameWordsInText`) are added to the profile format. The specialisation lives entirely in a shipped profile JSON. Each new capability is a pure module with no I/O, wired into the existing `resolve`/`buildRow` machinery.

**Tech Stack:** TypeScript on Node 22, vitest, zod for profile validation, `moduleResolution: nodenext` (relative imports need `.js`), `strict` + `noUncheckedIndexedAccess`.

**Spec:** [../specs/2026-08-07-collection-templates-design.md](../specs/2026-08-07-collection-templates-design.md)

---

## Before you start

```bash
git checkout main && git pull
git checkout -b feature/collection-templates
npm install && npm test        # expect 808 passing across 64 files
```

House rules a reviewer will reject you for breaking:

- **Relative imports end in `.js`**, even from `.ts` files.
- **Nothing reachable from `src/desktop/ui/` may import `node:*` or `electron`.** The renderer is sandboxed; such an import blanks the window silently. `tests/desktop/rendererPurity.test.ts` fails the build if you do it.
- Comments explain **why**, referencing real incidents. Narration comments are a defect here.

**Test documents:** `tests/test files/obits` holds the ten real OCR'd obituaries this feature was designed against. It is gitignored — never commit its contents, and never put a real person's details in `tests/fixtures/`.

## File structure

| File | Responsibility |
| --- | --- |
| `src/core/extract/dates.ts` | **New.** The spelled-date pattern, `dateNear`, `datePair`. Pure. |
| `src/core/extract/compose.ts` | **New.** `composeValue` — a template with optional groups. Pure. |
| `src/core/extract/names.ts` | **New.** `missingFilenameWords`. Pure. |
| `src/core/extract/types.ts` | **Modify.** Three sources on the `Source` union; `as` on `Column`; `checks` on `Profile`. |
| `src/core/extract/profile.ts` | **Modify.** Zod for the above, plus alias validation. |
| `src/core/extract/rows.ts` | **Modify.** Resolve the new sources; two-pass fill; run the check. |
| `templates/alumni-obituary.profile.json` | **New.** The shipped template. |
| `src/core/extract/templates.ts` | **New.** List and load shipped templates. |

---

## Task 1: `composeValue`

**Files:**
- Create: `src/core/extract/compose.ts`
- Create: `tests/extract/compose.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/extract/compose.test.ts
import { describe, it, expect } from 'vitest';
import { composeValue } from '../../src/core/extract/compose.js';

/**
 * Builds one field from others, so a death date can appear in the description
 * as well as in its own field -- which is what the existing catalogue records
 * do. The rules exist so a missing piece never produces `Died ; Born`.
 */
describe('composeValue', () => {
  it('substitutes a value', () => {
    expect(composeValue('Died {death}', { death: 'March 5, 2019' })).toBe('Died March 5, 2019');
  });

  it('substitutes several', () => {
    expect(composeValue('Died {death}; Born {birth}', { death: 'A', birth: 'B' })).toBe(
      'Died A; Born B',
    );
  });

  // A clause whose placeholders are all empty is dropped, punctuation and all.
  it('drops a clause whose only placeholder is missing', () => {
    expect(composeValue('Died {death}; Born {birth}', { death: 'A', birth: '' })).toBe('Died A');
  });

  it('drops the first clause just as readily as the last', () => {
    expect(composeValue('Died {death}; Born {birth}', { death: '', birth: 'B' })).toBe('Born B');
  });

  it('returns nothing at all when every clause is empty', () => {
    expect(composeValue('Died {death}; Born {birth}', { death: '', birth: '' })).toBe('');
  });

  // An optional group takes its punctuation with it, so a missing residence
  // cannot leave a dangling colon.
  it('drops an optional group and its punctuation', () => {
    expect(composeValue('Died {death}[: {place}]', { death: 'A', place: '' })).toBe('Died A');
  });

  it('keeps an optional group when its placeholders are filled', () => {
    expect(composeValue('Died {death}[: {place}]', { death: 'A', place: 'Rigby' })).toBe(
      'Died A: Rigby',
    );
  });

  it('drops an optional group if ANY placeholder inside it is missing', () => {
    expect(composeValue('X[ {a} and {b}]', { a: 'A', b: '' })).toBe('X');
  });

  it('treats a clause as empty when only its optional group had content', () => {
    expect(composeValue('Died {death}; Born{ x}[{birth}]', { death: 'A', birth: '' })).toBe('Died A');
  });

  it('leaves literal text with no placeholders alone', () => {
    expect(composeValue('Alumni Obituary', {})).toBe('Alumni Obituary');
  });

  it('treats an unknown placeholder as empty rather than printing it', () => {
    expect(composeValue('Died {nope}', {})).toBe('');
  });

  it('trims the result and collapses the space a dropped clause leaves', () => {
    expect(composeValue('Died {death};  Born {birth}', { death: 'A', birth: '' })).toBe('Died A');
  });

  it('ignores surrounding whitespace in a value', () => {
    expect(composeValue('Died {death}', { death: '  A  ' })).toBe('Died A');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/extract/compose.test.ts`
Expected: FAIL, cannot resolve `../../src/core/extract/compose.js`. You MUST see this.

- [ ] **Step 3: Implement**

```typescript
// src/core/extract/compose.ts

/**
 * Build one field's value from other fields.
 *
 * Two rules, and the second is the one that earns its keep:
 *
 * - `[...]` is an OPTIONAL GROUP. If any placeholder inside it is empty, the
 *   whole group goes, punctuation included -- so a missing residence cannot
 *   leave `Died March 5, 2019: `.
 * - A `;`-separated CLAUSE whose placeholders are all empty is dropped
 *   entirely, so the output is never `Died March 5, 2019; ;`.
 *
 * An unknown name is treated as empty rather than printed. A template naming a
 * column that does not exist is rejected when the profile loads (profile.ts),
 * so reaching here with one means the column exists and simply had no value.
 */
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

function fillGroups(text: string, values: Readonly<Record<string, string>>): string {
  // Optional groups first, so a group dropped whole cannot leave its
  // placeholders behind for the clause rule to see as "present".
  return text.replace(/\[([^\][]*)\]/g, (_, inner: string) => {
    const names = [...inner.matchAll(PLACEHOLDER)].map((m) => m[1]!);
    const anyEmpty = names.some((n) => (values[n] ?? '').trim() === '');
    return anyEmpty ? '' : inner;
  });
}

function fillClause(clause: string, values: Readonly<Record<string, string>>): string {
  const names = [...clause.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  // A clause with no placeholders is literal text and always survives.
  if (names.length > 0 && names.every((n) => (values[n] ?? '').trim() === '')) return '';
  return clause.replace(PLACEHOLDER, (_, name: string) => (values[name] ?? '').trim());
}

export function composeValue(template: string, values: Readonly<Record<string, string>>): string {
  return template
    .split(';')
    .map((clause) => fillClause(fillGroups(clause, values), values))
    .map((c) => c.trim())
    .filter((c) => c !== '')
    .join('; ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/extract/compose.test.ts`
Expected: PASS, 13 tests.

Then `npx vitest run` — expect 821 passing (808 + 13), and `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/extract/compose.ts tests/extract/compose.test.ts
git commit -m "feat(extract): compose one field from others"
```

---

## Task 2: reading a spelled-out date

**Files:**
- Create: `src/core/extract/dates.ts`
- Create: `tests/extract/dates.test.ts`

Context you need: the obituaries state dates two ways. In prose — *"passed away on September 8, 2019"* — and as a bare pair after the name — *"Gideon olwyn Alder April 5, 1954 - October 2, 2019"*. Four of ten use the second form with no phrase at all.

**The pattern must tolerate whitespace around punctuation.** Hollis Bracken's death date reads `February 11 , 2019`, with a space before the comma. A first pass missed it and reported his *funeral* date instead. That is a requirement, not a detail.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/extract/dates.test.ts
import { describe, it, expect } from 'vitest';
import { dateNear, datePair } from '../../src/core/extract/dates.js';

describe('dateNear', () => {
  it('finds a date after the phrase', () => {
    expect(dateNear('He passed away on September 8, 2019, at home.', ['passed away'])).toBe(
      'September 8, 2019',
    );
  });

  it('tries each phrase in turn', () => {
    const t = 'Marcus graduated this world on March 5, 2019.';
    expect(dateNear(t, ['passed away', 'graduated this world'])).toBe('March 5, 2019');
  });

  /**
   * OCR put a space before the comma in one real file, and the first pattern
   * missed it -- which made the tool report that man's funeral date as his
   * date of death.
   */
  it('tolerates a space before the comma', () => {
    expect(dateNear('died Thursday, February 11 , 2019 at home', ['died'])).toBe('February 11 , 2019');
  });

  it('tolerates a missing comma', () => {
    expect(dateNear('died February 11 2019', ['died'])).toBe('February 11 2019');
  });

  it('ignores case in the phrase', () => {
    expect(dateNear('DIED on August 5, 1952', ['died'])).toBe('August 5, 1952');
  });

  /**
   * Without a window, "died" near the top of a document reaches a funeral date
   * hundreds of characters later. The longest real gap in the batch is
   * "returned home to his Heavenly Father on", at 39 characters.
   */
  it('does not reach a date far beyond the phrase', () => {
    const far = 'died' + ' '.repeat(120) + 'September 8, 2019';
    expect(dateNear(far, ['died'])).toBe('');
  });

  it('reaches a date within the window', () => {
    const near = 'died' + ' '.repeat(40) + 'September 8, 2019';
    expect(dateNear(near, ['died'])).toBe('September 8, 2019');
  });

  it('returns nothing when no phrase appears', () => {
    expect(dateNear('nothing relevant here', ['passed away'])).toBe('');
  });

  it('returns nothing when the phrase appears but no date follows it', () => {
    expect(dateNear('he died at home surrounded by family', ['died'])).toBe('');
  });

  it('looks only forwards, never behind the phrase', () => {
    expect(dateNear('September 8, 2019 was the year he died', ['died'])).toBe('');
  });

  /**
   * "died" often appears in a heading before it appears in the sentence that
   * carries the date. Checking only the first occurrence reports nothing while
   * the answer sits further down.
   */
  it('keeps looking past an occurrence with no date after it', () => {
    const t = 'Obituary and Death Notice. He died at home. He died on September 8, 2019.';
    expect(dateNear(t, ['died'])).toBe('September 8, 2019');
  });
});

describe('datePair', () => {
  const line = 'Gideon olwyn Alder April 5, 1954 - October 2, 2019 Wheatfield, Utah';

  it('takes the second date of a dash pair', () => {
    expect(datePair(line, 'second')).toBe('October 2, 2019');
  });

  it('takes the first date of a dash pair', () => {
    expect(datePair(line, 'first')).toBe('April 5, 1954');
  });

  // One real file separates them with nothing but a space.
  it('accepts a pair separated by only a space', () => {
    expect(datePair('Corwin Ames Teasel August 14, 1951 May 1, 2019 Corwin', 'second')).toBe(
      'May 1, 2019',
    );
  });

  it('accepts the punctuation OCR leaves behind', () => {
    expect(datePair('Name December 8, 1947 ~ - July 3, 2019', 'second')).toBe('July 3, 2019');
  });

  /**
   * Two dates in separate sentences are not a pair. Without this, a birth date
   * and an unrelated later date would be read as a name-and-dates line.
   */
  it('is not fooled by two dates far apart', () => {
    const apart = 'Born October 12, 1946 and after a long life in Missouri he died April 9, 2018';
    expect(datePair(apart, 'second')).toBe('');
  });

  it('returns nothing when there is only one date', () => {
    expect(datePair('Born October 12, 1946 and nothing else', 'second')).toBe('');
  });

  it('returns nothing when there are no dates', () => {
    expect(datePair('no dates here at all', 'first')).toBe('');
  });

  it('takes the FIRST pair when a document holds several', () => {
    const two = 'A April 5, 1954 - October 2, 2019 then B October 12, 1946 - April 9, 2018';
    expect(datePair(two, 'second')).toBe('October 2, 2019');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/extract/dates.test.ts`
Expected: FAIL, cannot resolve `../../src/core/extract/dates.js`.

- [ ] **Step 3: Implement**

```typescript
// src/core/extract/dates.ts

/**
 * A date written in words: "March 5, 2019".
 *
 * Deliberately tolerant of whitespace around the comma, and of the comma being
 * absent. OCR of a scanned newspaper clipping produced `February 11 , 2019`,
 * and the first version of this pattern missed it -- which made the tool
 * report that man's FUNERAL date as his date of death.
 *
 * Spelled-out dates are used rather than the numeric ones these documents also
 * carry, because letters survive OCR far better than digits: the same batch
 * mangled a numeric birth date into an unreadable run of digits and a numeric
 * death date into two characters, while
 * every spelled date came through clean. Reading the prose took recovery from
 * 3 of 10 files to 9 of 10.
 */
const MONTH =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const DATE = `${MONTH}\\s+\\d{1,2}\\s*,?\\s*\\d{4}`;

/** How far past a phrase a date may sit and still belong to it. */
const WINDOW = 80;

/**
 * How much may separate the two halves of a name-and-dates line.
 *
 * No letter or digit may appear between them, so a dash, a space, or the
 * debris OCR leaves all qualify, while two dates in separate sentences do not.
 */
const PAIR_GAP = 12;

/**
 * The first date following any of `phrases`, within `WINDOW` characters.
 *
 * Phrases are tried in order, so the profile's ordering is its preference.
 * Looks only forwards: "September 8, 2019 was the year he died" must not yield a
 * date for the phrase "died".
 */
export function dateNear(text: string, phrases: readonly string[]): string {
  const haystack = text.toLowerCase();
  for (const phrase of phrases) {
    const needle = phrase.toLowerCase();
    // EVERY occurrence, not just the first. "died" often appears in a heading
    // before it appears in the sentence that carries the date, and stopping at
    // the first would report nothing while the answer sat further down.
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
      const from = at + needle.length;
      const found = new RegExp(DATE, 'i').exec(text.slice(from, from + WINDOW));
      if (found) return found[0];
    }
  }
  return '';
}

/**
 * One half of a name-and-dates line: `April 5, 1954 - October 2, 2019`.
 *
 * Four of ten real obituaries state the dates this way, with no phrase at all
 * to anchor on, so `dateNear` cannot see them. The two are combined by the
 * profile's ordered source list, not by either knowing about the other.
 */
export function datePair(text: string, which: 'first' | 'second'): string {
  const pair = new RegExp(`(${DATE})[^A-Za-z0-9]{0,${PAIR_GAP}}(${DATE})`, 'i').exec(text);
  if (!pair) return '';
  return (which === 'first' ? pair[1] : pair[2]) ?? '';
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/extract/dates.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Prove the window and the gap bite**

Temporarily set `WINDOW = 400`; the test "does not reach a date far beyond the phrase" must FAIL. Put it back.
Temporarily set `PAIR_GAP = 120`; "is not fooled by two dates far apart" must FAIL. Put it back.
**Report both results.** A constant no test constrains is a constant someone will change.

- [ ] **Step 6: Commit**

```bash
git add src/core/extract/dates.ts tests/extract/dates.test.ts
git commit -m "feat(extract): read a date written in words"
```

---

## Task 3: the filename/contents name check

**Files:**
- Create: `src/core/extract/names.ts`
- Create: `tests/extract/names.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/extract/names.test.ts
import { describe, it, expect } from 'vitest';
import { missingFilenameWords } from '../../src/core/extract/names.js';

/**
 * A real file was named "Alden Larkspar Obituary.pdf" while the document said
 * "Larkspur" throughout. Since the filename becomes the item's permanent title,
 * that misspelling would have been catalogued.
 */
describe('missingFilenameWords', () => {
  it('reports a word the document does not contain', () => {
    expect(missingFilenameWords('Alden Larkspar.pdf', 'Alden Larkspur passed away', [])).toEqual([
      'Larkspar',
    ]);
  });

  it('reports nothing when every word appears', () => {
    expect(missingFilenameWords('Marcus Fennel.pdf', 'Marcus T Fennel was born', [])).toEqual([]);
  });

  /**
   * Whole words, not the whole name. "Marcus Fennel" never appears
   * contiguously -- the document reads "Marcus T Fennel" -- so matching the
   * full name would flag nine rows out of ten.
   */
  it('does not require the words to be adjacent', () => {
    expect(missingFilenameWords('Rosalind Willow.pdf', 'Rosalind Maren Vess Willow', [])).toEqual([]);
  });

  it('ignores case', () => {
    expect(missingFilenameWords('HOLLIS BRACKEN.pdf', 'hollis bracken was born', [])).toEqual([]);
  });

  it('ignores words the caller asks it to', () => {
    expect(missingFilenameWords('Gideon Alder Obituary.pdf', 'Gideon Alder died', ['Obituary'])).toEqual(
      [],
    );
  });

  it('ignores those words case-insensitively too', () => {
    expect(missingFilenameWords('Gideon Alder OBITUARY.pdf', 'Gideon Alder died', ['obituary'])).toEqual(
      [],
    );
  });

  // Initials and stray single characters carry no signal and appear everywhere.
  it('ignores one-character words', () => {
    expect(missingFilenameWords('Marcus T Fennel.pdf', 'Marcus Fennel', [])).toEqual([]);
  });

  it('drops the extension before checking', () => {
    expect(missingFilenameWords('Gideon Alder.pdf', 'Gideon Alder died', [])).toEqual([]);
  });

  it('reports several missing words', () => {
    expect(missingFilenameWords('Alan Turing.pdf', 'nothing relevant', [])).toEqual([
      'Alan',
      'Turing',
    ]);
  });

  it('reports nothing for a document with no text, rather than everything', () => {
    expect(missingFilenameWords('Alan Turing.pdf', '', [])).toEqual([]);
  });
});
```

Note the last test: a document with no text layer is already flagged by `buildRow` with its own note. Flagging every word as missing as well would bury that message under noise.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/extract/names.test.ts`
Expected: FAIL, cannot resolve the module.

- [ ] **Step 3: Implement**

```typescript
// src/core/extract/names.ts

/**
 * Words in the filename that the document does not contain.
 *
 * A real file was named "Alden Larkspar Obituary.pdf" while the obituary said
 * "Larkspur" throughout. The filename becomes the item's permanent title, so
 * that misspelling would have been catalogued and never noticed.
 *
 * WHOLE WORDS, not the whole name. "Marcus Fennel" never appears contiguously
 * in its own document -- the text reads "Marcus T Fennel" -- so requiring the
 * full name would flag nine of ten real files. Checking each word separately
 * flagged exactly one, the one that deserved it.
 *
 * It survives OCR damage for the same reason: middle names came out as
 * `!;ennick`, `E>or1an` and `olwyn`, and none is a filename word, so none is
 * ever tested.
 *
 * `ignore` is supplied by the profile rather than known here -- "Obituary" is
 * meaningless to this function and specific to one collection.
 */
export function missingFilenameWords(
  filename: string,
  text: string,
  ignore: readonly string[],
): string[] {
  // A document with no text is already reported by buildRow's own note.
  // Listing every word as missing too would bury that under noise.
  if (text.trim() === '') return [];

  const haystack = text.toLowerCase();
  const skip = new Set(ignore.map((w) => w.toLowerCase()));

  return filename
    .replace(/\.[^.\\/]+$/, '')
    .split(/[^A-Za-z0-9']+/)
    .filter((word) => word.length > 1 && !skip.has(word.toLowerCase()))
    .filter((word) => !haystack.includes(word.toLowerCase()));
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/extract/names.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/extract/names.ts tests/extract/names.test.ts
git commit -m "feat(extract): flag a filename its document does not agree with"
```

---

## Task 4: the profile format

**Files:**
- Modify: `src/core/extract/types.ts`
- Modify: `src/core/extract/profile.ts`
- Test: `tests/extract/profile.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/extract/profile.test.ts`:

```typescript
describe('profiles using the new sources', () => {
  const base = (columns: unknown[]) => ({ version: 1, pattern: '{a}.pdf', columns });

  it('accepts dateNear, datePair and compose', () => {
    expect(() =>
      parseProfile(
        base([
          { path: 'MWDL/date', as: 'death', sources: [{ dateNear: ['died'] }, { datePair: 'second' }] },
          { path: 'MWDL/description', sources: [{ compose: 'Died {death}' }] },
        ]),
      ),
    ).not.toThrow();
  });

  it('rejects an empty phrase list, which would match nothing', () => {
    expect(() => parseProfile(base([{ path: 'MWDL/date', sources: [{ dateNear: [] }] }]))).toThrow();
  });

  it('rejects a datePair that is neither first nor second', () => {
    expect(() =>
      parseProfile(base([{ path: 'MWDL/date', sources: [{ datePair: 'third' }] }])),
    ).toThrow();
  });

  /**
   * A template naming a column that does not exist would silently compose to
   * nothing on every row. Rejecting it at load matches how a malformed date
   * format is handled: fail before the batch, not part-way through.
   */
  it('rejects a compose naming a column that does not exist', () => {
    expect(() =>
      parseProfile(base([{ path: 'MWDL/description', sources: [{ compose: 'Died {nope}' }] }])),
    ).toThrow(/nope/);
  });

  /**
   * Composed columns are filled in a second pass from the first pass's values,
   * so one cannot read another. Forbidding it outright makes a cycle
   * impossible by construction rather than by detection.
   */
  it('rejects a compose naming another composed column', () => {
    expect(() =>
      parseProfile(
        base([
          { path: 'MWDL/abstract', as: 'a', sources: [{ compose: 'x' }] },
          { path: 'MWDL/description', sources: [{ compose: '{a}' }] },
        ]),
      ),
    ).toThrow();
  });

  it('rejects two columns claiming the same alias', () => {
    expect(() =>
      parseProfile(
        base([
          { path: 'MWDL/date', as: 'd', sources: [] },
          { path: 'MWDL/abstract', as: 'd', sources: [] },
        ]),
      ),
    ).toThrow(/d/);
  });

  it('accepts the filenameWordsInText check', () => {
    expect(() =>
      parseProfile({
        version: 1,
        pattern: '{a}.pdf',
        columns: [{ path: 'MWDL/title', sources: [] }],
        checks: { filenameWordsInText: { ignore: ['Obituary'] } },
      }),
    ).not.toThrow();
  });

  it('rejects an unknown check rather than ignoring it', () => {
    expect(() =>
      parseProfile({
        version: 1,
        pattern: '{a}.pdf',
        columns: [{ path: 'MWDL/title', sources: [] }],
        checks: { somethingElse: true },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/extract/profile.test.ts -t "new sources"`
Expected: FAIL — the first test throws, because `dateNear` is not in the union.

- [ ] **Step 3: Extend the types**

In `src/core/extract/types.ts`, add to the `Source` union, before `{ filename: true }`:

```typescript
  /**
   * The first date written in words following any of these phrases.
   * "passed away on September 8, 2019".
   */
  | { dateNear: string[] }
  /**
   * One half of a name-and-dates line: `April 5, 1954 - October 2, 2019`.
   * Four of ten real obituaries state the dates this way, with no phrase to
   * anchor on.
   */
  | { datePair: 'first' | 'second' }
  /**
   * Built from other columns' values rather than from the document. Referenced
   * columns are named by their `as`, and are filled in an earlier pass.
   */
  | { compose: string }
```

Add to `Column`:

```typescript
  /**
   * A short name other columns' `compose` templates can refer to. Without one,
   * a column cannot be referenced -- xpaths are far too long to write inside a
   * template, and naming the reference explicitly means renaming a column
   * cannot silently break one.
   */
  as?: string;
```

Add to `Profile`:

```typescript
  /** Checks that report on a row without producing a value. */
  checks?: {
    /**
     * Flag a row when a word from its filename does not appear in the
     * document. `ignore` lists words that carry no signal for this collection,
     * such as "Obituary" in every filename of an obituary batch.
     */
    filenameWordsInText?: { ignore?: string[] };
  };
```

- [ ] **Step 4: Extend the schema and validation**

In `src/core/extract/profile.ts`, add to `sourceSchema`'s union:

```typescript
  z.object({ dateNear: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ datePair: z.union([z.literal('first'), z.literal('second')]) }).strict(),
  z.object({ compose: z.string().min(1) }).strict(),
```

Add `as: z.string().min(1).optional(),` to `columnSchema`, and to `profileSchema`:

```typescript
    checks: z
      .object({
        filenameWordsInText: z.object({ ignore: z.array(z.string()).optional() }).strict().optional(),
      })
      .strict()
      .optional(),
```

Then, in `parseProfile` after the schema parse, alongside the existing duplicate-path check:

```typescript
  // Aliases must be unique, or a compose template would silently read
  // whichever column happened to be declared last.
  const aliases = profile.columns.map((c) => c.as).filter((a): a is string => a !== undefined);
  const dupeAlias = aliases.find((a, i) => aliases.indexOf(a) !== i);
  if (dupeAlias !== undefined) {
    throw new ValidationError(`Two columns both use the name '${dupeAlias}'.`);
  }

  // A compose naming a column that does not exist would compose to nothing on
  // every row, silently. Fail here rather than after three hundred files --
  // the same reason a malformed date format is rejected at load.
  const composedAliases = new Set(
    profile.columns.filter((c) => c.sources.some((s) => 'compose' in s)).map((c) => c.as),
  );
  for (const column of profile.columns) {
    for (const source of column.sources) {
      if (!('compose' in source)) continue;
      for (const name of joinPlaceholders(source.compose)) {
        if (!aliases.includes(name)) {
          throw new ValidationError(
            `Column '${column.path}' composes from '{${name}}', but no column is named '${name}'. ` +
              `Add "as": "${name}" to the column it should read.`,
          );
        }
        if (composedAliases.has(name)) {
          throw new ValidationError(
            `Column '${column.path}' composes from '{${name}}', which is itself composed. ` +
              `Composed columns are filled after all others, so they cannot read each other.`,
          );
        }
      }
    }
  }
```

`joinPlaceholders` already exists in this file and uses the same `{name}` syntax — reuse it, do not write a second parser.

- [ ] **Step 5: Run and watch it pass**

Run: `npx vitest run tests/extract/profile.test.ts` — PASS.
Then `npx vitest run` and `npm run typecheck` — both clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/extract/types.ts src/core/extract/profile.ts tests/extract/profile.test.ts
git commit -m "feat(extract): profile format for templated collections"
```

---

## Task 5: wire the sources into row building

**Files:**
- Modify: `src/core/extract/rows.ts`
- Test: `tests/extract/rows.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/extract/rows.test.ts`:

```typescript
describe('buildRow with templated sources', () => {
  const doc = (text: string): DocumentData => ({
    text,
    hasTextLayer: true,
    properties: {},
    tables: [],
  });

  const obitProfile: Profile = {
    version: 1,
    pattern: '{name}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      {
        path: 'MWDL/date',
        as: 'death',
        sources: [{ dateNear: ['passed away', 'died'] }, { datePair: 'second' }],
        transform: 'date',
      },
      { path: 'MWDL/description', sources: [{ compose: 'Died {death}' }] },
    ],
  };

  it('reads a death date from prose and normalises it', () => {
    const row = buildRow(obitProfile, 'a.pdf', doc('He passed away on September 8, 2019 at home.'));
    expect(row.cells['MWDL/date']).toBe('2019-09-08');
    expect(row.sources['MWDL/date']).toBe('dateNear');
  });

  it('falls back to the dash pair when no phrase appears', () => {
    const row = buildRow(obitProfile, 'a.pdf', doc('Gideon Alder April 5, 1954 - October 2, 2019 Utah'));
    expect(row.cells['MWDL/date']).toBe('2019-10-02');
    expect(row.sources['MWDL/date']).toBe('datePair');
  });

  /**
   * The composed column must see the OTHER column's finished value, including
   * its transform -- not the raw text it was read from.
   */
  it('composes from the transformed value of another column', () => {
    const row = buildRow(obitProfile, 'a.pdf', doc('He died September 8, 2019.'));
    expect(row.cells['MWDL/description']).toBe('Died 2019-09-08');
    expect(row.sources['MWDL/description']).toBe('compose');
  });

  it('composes to nothing when the column it reads is empty', () => {
    const row = buildRow(obitProfile, 'a.pdf', doc('No date is stated anywhere in this document.'));
    expect(row.cells['MWDL/date']).toBe('');
    expect(row.cells['MWDL/description']).toBe('');
  });

  it('is not confused by column order', () => {
    const reversed: Profile = {
      ...obitProfile,
      columns: [obitProfile.columns[2]!, obitProfile.columns[1]!, obitProfile.columns[0]!],
    };
    expect(buildRow(reversed, 'a.pdf', doc('died September 8, 2019')).cells['MWDL/description']).toBe(
      'Died 2019-09-08',
    );
  });
});

describe('buildRow and the filename check', () => {
  const withCheck: Profile = {
    version: 1,
    pattern: '{name}.pdf',
    columns: [{ path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true }],
    checks: { filenameWordsInText: { ignore: ['Obituary'] } },
  };
  const doc = (text: string): DocumentData => ({ text, hasTextLayer: true, properties: {}, tables: [] });

  it('flags a filename word the document does not contain', () => {
    const row = buildRow(withCheck, 'Alden Larkspar Obituary.pdf', doc('Alden Larkspur passed away'));
    expect(row.notes.join(' ')).toContain('Larkspar');
  });

  it('says nothing when every word appears', () => {
    const row = buildRow(withCheck, 'Marcus Fennel Obituary.pdf', doc('Marcus T Fennel was born'));
    expect(row.notes).toEqual([]);
  });

  it('does not run the check when the profile does not ask for it', () => {
    const noCheck: Profile = { ...withCheck, checks: undefined };
    expect(buildRow(noCheck, 'Alden Larkspar.pdf', doc('Alden Larkspur')).notes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/extract/rows.test.ts -t templated`
Expected: FAIL — the cell is empty, because `resolve` does not know `dateNear`.

- [ ] **Step 3: Implement**

In `src/core/extract/rows.ts`:

Add the imports:

```typescript
import { dateNear, datePair } from './dates.js';
import { composeValue } from './compose.js';
import { missingFilenameWords } from './names.js';
```

Add to `Context`:

```typescript
  /** Alias -> finished value, from the first pass. Empty during that pass. */
  composed: Record<string, string>;
```

Add to `sourceKind`, before the final `return`:

```typescript
  if ('dateNear' in source) return 'dateNear';
  if ('datePair' in source) return 'datePair';
  if ('compose' in source) return 'compose';
```

Add to `resolve`, before the `tableColumn` branch:

```typescript
  if ('dateNear' in source) return { value: dateNear(context.doc.text, source.dateNear) };

  if ('datePair' in source) return { value: datePair(context.doc.text, source.datePair) };

  if ('compose' in source) return { value: composeValue(source.compose, context.composed) };
```

Then make `buildRow` fill in two passes. Replace the single column loop with:

```typescript
  const context: Context = {
    filename,
    parts,
    labels: findLabels(doc.text),
    doc,
    composed: {},
  };

  const cells: Record<string, string> = {};
  const sources: Record<string, string> = {};

  // Two passes, because a composed column reads other columns' FINISHED values
  // -- after their transforms, not the raw text they came from. Composed
  // columns cannot read each other; profile.ts rejects that at load, which is
  // what makes one extra pass sufficient and a cycle impossible.
  const isComposed = (c: Column) => c.sources.some((s) => 'compose' in s);

  for (const column of profile.columns.filter((c) => !isComposed(c))) {
    const { value, source } = fill(column, context, notes);
    cells[column.path] = column.path === ATTACHMENT_COLUMN ? filename : value;
    if (source !== undefined && cells[column.path] !== '') sources[column.path] = source;
    if (column.as !== undefined) context.composed[column.as] = cells[column.path] ?? '';
  }

  for (const column of profile.columns.filter(isComposed)) {
    const { value, source } = fill(column, context, notes);
    cells[column.path] = value;
    if (source !== undefined && value !== '') sources[column.path] = source;
  }

  if (profile.checks?.filenameWordsInText) {
    const missing = missingFilenameWords(
      filename,
      doc.text,
      profile.checks.filenameWordsInText.ignore ?? [],
    );
    if (missing.length > 0) {
      notes.push(
        `the file is named '${filename}' but the document does not contain ` +
          `${missing.map((w) => `'${w}'`).join(', ')} -- check the spelling before uploading`,
      );
    }
  }

  return { cells, sources, notes };
```

`Column` must be imported as a type in this file — check the existing import from `./types.js` and add it if missing.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/extract/rows.test.ts` — PASS.
Then `npx vitest run` and `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/extract/rows.ts tests/extract/rows.test.ts
git commit -m "feat(extract): fill composed columns in a second pass"
```

---

## Task 6: the shipped template

**Files:**
- Create: `templates/alumni-obituary.profile.json`
- Create: `src/core/extract/templates.ts`
- Create: `tests/extract/templates.test.ts`

- [ ] **Step 1: Write the template**

```json
{
  "version": 1,
  "pattern": "{first} {last} Obituary.pdf",
  "checks": { "filenameWordsInText": { "ignore": ["Obituary"] } },
  "columns": [
    { "path": "attachment name", "sources": [{ "filename": true }], "locked": true },
    { "path": "MWDL/identifier", "sources": [{ "filename": true }] },
    { "path": "MWDL/title", "sources": [{ "join": "Alumni Obituary: {first} {last}" }] },
    {
      "path": "BYUI_extended/BYUI_information/special_collections/alumni_obituary/death_date",
      "as": "death_date",
      "sources": [
        { "dateNear": ["passed away", "died", "returned home", "graduated this world"] },
        { "datePair": "second" }
      ],
      "transform": "date"
    },
    { "path": "MWDL/description", "sources": [{ "compose": "Died {death_date}" }] },
    { "path": "MWDL/genres/genre", "sources": [], "default": "Alumni Obituary" },
    { "path": "MWDL/subjects/subject", "sources": [], "default": "History; Religion; MCK Special Collections" },
    { "path": "MWDL/contributors/contributor", "sources": [], "default": "BYUI Alumni Office" },
    { "path": "MWDL/conversionSpecifications", "sources": [], "default": "Scanned to PDF" },
    { "path": "MWDL/source", "sources": [], "default": "None" },
    { "path": "BYUI_extended/byui_rights/restrict_to_byui", "sources": [], "default": "Public" }
  ]
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/extract/templates.test.ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { listTemplates, loadTemplate } from '../../src/core/extract/templates.js';
import { parseProfile } from '../../src/core/extract/profile.js';
import { buildRow } from '../../src/core/extract/rows.js';
import { extractDefinition, parseSchemaPaths } from '../../src/core/schema.js';
import { ATTACHMENT_COLUMN, type DocumentData } from '../../src/core/extract/types.js';

const doc = (text: string): DocumentData => ({ text, hasTextLayer: true, properties: {}, tables: [] });

describe('shipped templates', () => {
  it('lists the alumni obituary template', async () => {
    expect((await listTemplates()).map((t) => t.id)).toContain('alumni-obituary');
  });

  it('gives it a name a person can read', async () => {
    const found = (await listTemplates()).find((t) => t.id === 'alumni-obituary');
    expect(found?.label).toBe('Alumni Obituary');
  });

  it('loads as a valid profile', async () => {
    const raw = JSON.parse(await readFile('templates/alumni-obituary.profile.json', 'utf8'));
    expect(() => parseProfile(raw)).not.toThrow();
  });

  /**
   * A template naming an xpath the schema does not have would fail at upload,
   * long after the operator built the batch.
   */
  it('names only real schema paths', async () => {
    const paths = parseSchemaPaths(extractDefinition(await readFile('schema/_entity.xml', 'utf8')));
    for (const column of (await loadTemplate('alumni-obituary')).columns) {
      if (column.path === ATTACHMENT_COLUMN) continue;
      expect(paths.has(column.path), `${column.path} is not in the schema`).toBe(true);
    }
  });

  it('extracts a death date and composes a description', async () => {
    const profile = await loadTemplate('alumni-obituary');
    const row = buildRow(
      profile,
      'Marcus Fennel Obituary.pdf',
      doc('Marcus T Fennel graduated this world on March 5, 2019. He was born November 13, 1907.'),
    );
    expect(
      row.cells['BYUI_extended/BYUI_information/special_collections/alumni_obituary/death_date'],
    ).toBe('2019-03-05');
    expect(row.cells['MWDL/description']).toBe('Died 2019-03-05');
    expect(row.cells['MWDL/title']).toBe('Alumni Obituary: Marcus Fennel');
    expect(row.cells['MWDL/genres/genre']).toBe('Alumni Obituary');
  });

  it('leaves the date blank rather than guessing when none is stated', async () => {
    const profile = await loadTemplate('alumni-obituary');
    const row = buildRow(
      profile,
      'Alden Larkspar Obituary.pdf',
      doc('Alden Larkspur died quietly at home on an afternoon at the end of the harvest.'),
    );
    expect(
      row.cells['BYUI_extended/BYUI_information/special_collections/alumni_obituary/death_date'],
    ).toBe('');
    expect(row.notes.join(' ')).toContain('Larkspar');
  });

  it('rejects an unknown template id rather than returning a broken profile', async () => {
    await expect(loadTemplate('no-such-template')).rejects.toThrow();
  });
});

```

Every test above reads the template through `readFile`, never `require` — this project is ESM (`moduleResolution: nodenext`) and `require` is not available in a `.ts` test.

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/extract/templates.test.ts`
Expected: FAIL, cannot resolve `templates.js`.

- [ ] **Step 4: Implement**

```typescript
// src/core/extract/templates.ts
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { OeqError } from '../errors.js';
import { parseProfile } from './profile.js';
import type { Profile } from './types.js';

/**
 * Templates shipped with the app: a profile carrying one collection's
 * knowledge, chosen instead of starting from a generic scan.
 *
 * A template is ONLY a profile JSON. That is the whole design -- a code pack
 * per collection would need a developer every time and would be its own thing
 * to test, whereas this is one mechanism, tested once, configured many times.
 * The operator authors a new one by saving a profile from the app.
 */
export interface TemplateSummary {
  id: string;
  label: string;
}

/** Where the shipped templates live, relative to the working directory. */
const DIR = 'templates';

const SUFFIX = '.profile.json';

/** "alumni-obituary" -> "Alumni Obituary" */
function labelFor(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export async function listTemplates(dir = DIR): Promise<TemplateSummary[]> {
  const names = await readdir(dir);
  return names
    .filter((n) => n.endsWith(SUFFIX))
    .map((n) => n.slice(0, -SUFFIX.length))
    .sort()
    .map((id) => ({ id, label: labelFor(id) }));
}

/**
 * Validated on the way in, so a template broken by an edit fails here rather
 * than part-way through a batch -- the same reason profiles are validated when
 * the operator opens one.
 */
export async function loadTemplate(id: string, dir = DIR): Promise<Profile> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new OeqError(`Not a template name: '${id}'.`);
  try {
    return parseProfile(JSON.parse(await readFile(join(dir, id + SUFFIX), 'utf8')));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new OeqError(`Could not load the '${id}' template: ${detail}`);
  }
}
```

- [ ] **Step 5: Run and watch it pass**

Run: `npx vitest run tests/extract/templates.test.ts` — PASS.
Then `npx vitest run` and `npm run typecheck` — clean.

- [ ] **Step 6: Make sure the template ships**

`templates/` must reach the packaged app. Check `package.json`'s `build.files` (electron-builder) and add `"templates/**/*"` if it is not already covered. Also confirm `.gitignore` does not exclude it: `git check-ignore -v templates/alumni-obituary.profile.json` must print nothing.

- [ ] **Step 7: Commit**

```bash
git add templates src/core/extract/templates.ts tests/extract/templates.test.ts package.json
git commit -m "feat(extract): ship an Alumni Obituary template"
```

---

## Task 7: verify against the ten real obituaries

**Files:** none — this is a measurement, and the numbers go in the commit message.

- [ ] **Step 1: Write a throwaway script**

```typescript
// verify.tmp.mts  (delete before committing)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listFolder } from './src/core/extract/extract.js';
import { readDocument } from './src/core/extract/readers/index.js';
import { loadTemplate } from './src/core/extract/templates.js';
import { buildRow } from './src/core/extract/rows.js';

const DEATH = 'BYUI_extended/BYUI_information/special_collections/alumni_obituary/death_date';
const dir = 'tests/test files/obits';
const profile = await loadTemplate('alumni-obituary');
const { supported } = await listFolder(dir);
const out: string[] = [];
let got = 0;
for (const f of supported) {
  const doc = await readDocument(join(dir, f));
  const row = buildRow(profile, f, doc);
  if ((row.cells[DEATH] ?? '') !== '') got++;
  out.push(
    `${(row.cells[DEATH] || '(none)').padEnd(12)} ${(row.sources[DEATH] ?? '-').padEnd(9)} ` +
      `${f.replace(' Obituary.pdf', '').padEnd(16)} ${row.notes.join(' | ')}`,
  );
}
out.push(`\ndeath date found: ${got} of ${supported.length}`);
writeFileSync('verify.out.txt', out.join('\n'));
```

Run: `npx tsx verify.tmp.mts` then read `verify.out.txt`.

- [ ] **Step 2: Check it against what the spec predicted**

All of these must hold. If any does not, **fix the code, not the expectation**:

1. **Death date found on 9 of 10.**
2. **Alden Larkspar has none**, and is not guessed. His obituary places the death by season and time of day and states no date.
3. **The three files whose numeric header survived OCR agree with it** — this is an independent cross-check, not a restatement of the same extraction:
   - Marcus Fennel → `2019-03-05` (header said `03/05/2019`)
   - Gideon Alder → `2019-10-02` (header said `10/02/2019`)
   - Thaddeus Hawthorn → `2019-07-03` (header said `07/03/2019`)
4. **Hollis Bracken → `2019-02-11`, not `2019-02-19`.** The 19th is his funeral. His death date is written `February 11 , 2019` with a space before the comma, and an earlier pattern missed it and reported the funeral instead.
5. **Exactly one row carries a filename note**, Alden's, naming `Larkspar`.
6. `_source` reads `dateNear` for the prose files and `datePair` for Gideon, Delphine, Thaddeus and Corwin.

- [ ] **Step 3: Delete the script and commit the numbers**

```bash
rm verify.tmp.mts verify.out.txt
git commit --allow-empty -m "test: verify the obituary template against ten real files

<paste the real counts here: how many of ten yielded a death date, which
source each came from, and confirmation of the three header cross-checks and
the single filename flag>"
```

---

## Task 8: offer the template in the app

**Files:**
- Modify: `src/desktop/ipc.ts`, `src/desktop/preload.cts`, `src/desktop/extractHandlers.ts`
- Modify: `src/desktop/ui/screens/extractFolder.ts`, `src/desktop/ui/extract/controller.ts`

- [ ] **Step 1: Add the IPC**

In `src/desktop/ipc.ts`, add to `OeqApi`:

```typescript
  /** Templates shipped with the app, for the "start from" choice. */
  listTemplates(): Promise<{ id: string; label: string }[]>;
  /** A shipped template, validated, ready to use as the starting profile. */
  loadTemplate(id: string): Promise<Profile>;
```

and to `CHANNELS`:

```typescript
  listTemplates: 'oeq:listTemplates',
  loadTemplate: 'oeq:loadTemplate',
```

Mirror both into `src/desktop/preload.cts`'s duplicated `CHANNELS` and its method table, following the shape of the entries already there. Run `npx vitest run tests/desktop/preload-channels.test.ts` — it must pass; it exists to catch exactly this drift.

- [ ] **Step 2: Handle them**

In `src/desktop/extractHandlers.ts`:

```typescript
  ipcMain.handle(CHANNELS.listTemplates, () => listTemplates(options.templatesDir));
  ipcMain.handle(CHANNELS.loadTemplate, (_e, id: string) => loadTemplate(id, options.templatesDir));
```

Add `templatesDir: string` to `ExtractHandlerOptions`, and resolve it where `schemaFile` is resolved in `src/desktop/main.ts` — the packaged app and the development tree differ, and `schemaFile` already solves that problem; copy how it does it rather than inventing a second way.

- [ ] **Step 3: Offer the choice on the folder screen**

In `src/desktop/ui/screens/extractFolder.ts`, after the folder is chosen, render a select:

```html
<label for="extract-template">Start from</label>
<select id="extract-template">
  <option value="">Generic — work it out from the files</option>
  <!-- one <option value="alumni-obituary">Alumni Obituary</option> per template -->
</select>
```

Choosing a template calls `loadTemplate(id)` and uses the result as the profile instead of the scanned starter; choosing the blank option keeps today's behaviour exactly. The screen's props gain `templates: {id,label}[]`, `templateId: string`, and `onTemplateChange(id: string): void`.

**This select must NOT use `keepCaret`** — that is for text inputs whose `input` event triggers a re-render. A `<select>` fires `change`, and its value is restored by the `selected` attribute on re-render.

- [ ] **Step 4: Verify by hand**

```bash
npm run build:desktop
npx electron dist-desktop/desktop/main.js
```

Choose the obits folder, pick "Alumni Obituary", and confirm the preview shows a death date and `Alumni Obituary: …` titles. `npx vitest run` and `npm run typecheck` must both stay clean.

- [ ] **Step 5: Commit**

```bash
git add src/desktop
git commit -m "feat(desktop): start an extraction from a collection template"
```

---

## Task 9: documentation

**Files:** `README.md`, `docs/SESSION-HANDOFF.md`, `CLAUDE.md`

- [ ] **Step 1: README**

Add after "Where a description comes from": what a template is (a profile JSON, nothing more), the four new capabilities with one example each, how to author one (build a profile in the app and save it), and the Alumni Obituary template's contents. State plainly what it does **not** extract — cause of death, birthplace, residence, the Ricks College connection — and that this is deliberate, because a wrong fact in a permanent record is worse than an absent one.

- [ ] **Step 2: Handoff and CLAUDE.md**

In `docs/SESSION-HANDOFF.md`, record the measured result from Task 7 and the reason the feature exists: the OCR was fine, the wrong part of the page was being read, and reading prose instead of the numeric header took death dates from 3 of 10 to 9 of 10.

In `CLAUDE.md`, add one line to "Key domain facts":

```markdown
- **A collection template is just a profile JSON** in `templates/`. Specialised
  collections are configuration, never code -- a code pack per collection would
  need a developer each time. `dateNear`, `datePair` and `compose` are generic
  sources; nothing in the code knows what an obituary is.
```

Update the test count at the top of the handoff to whatever `npx vitest run` reports.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/SESSION-HANDOFF.md CLAUDE.md
git commit -m "docs: collection templates"
```

---

## Self-review notes

Checked against the spec:

| Spec section | Task |
| --- | --- |
| A template is a profile JSON | 6 |
| `dateNear`, with the 80-character window | 2 |
| `datePair`, with the 12-character gap | 2 |
| `compose`, optional groups and clause dropping | 1 |
| Placeholders name a column via `as` | 4 |
| Composed columns resolve after others; cycles impossible | 4 (rejects compose→compose), 5 (two passes) |
| `filenameWordsInText`, whole words, `ignore` from the profile | 3, 5 |
| The Alumni Obituary template's contents | 6 |
| Deliberately not extracted | 9 (documented) |
| `_source` gains the new kinds | 5 |
| Whitespace around punctuation tolerated | 2, and re-checked in 7 |
| Verification against the ten real files | 7 |

One refinement the spec did not state: **`compose` may not reference another composed column.** The spec spoke of rejecting cycles; forbidding the reference outright makes a cycle impossible by construction and means one extra pass is provably enough. Task 4 rejects it at load with a message saying why.
