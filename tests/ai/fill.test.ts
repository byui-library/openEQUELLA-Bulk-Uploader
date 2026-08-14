// tests/ai/fill.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fillWithModel } from '../../src/core/ai/fill.js';
import { ValidationError } from '../../src/core/errors.js';
import { buildRow, expectedButEmptyNote } from '../../src/core/extract/rows.js';
import { needsReview } from '../../src/core/ai/review.js';
import { writeCsv } from '../../src/core/extract/csv.js';
import {
  ATTACHMENT_COLUMN,
  type DocumentData,
  type ExtractedRow,
  type Profile,
} from '../../src/core/extract/types.js';

/**
 * Real prose. `readOpening` refuses to call anything an opening unless it has
 * ten words of two letters or more, a sentence ending, and is mostly lowercase
 * -- so a run of `x`s produces an EMPTY slice and would exercise the wrong path
 * in half of these tests.
 */
const PROSE =
  'This obituary records what the family said about a long life in a small town, ' +
  'and what the college meant to it. ';

/** Long enough not to fit a small budget, with one named section carrying a
 *  marker that cannot be confused with its own heading. */
const LONG_WITH_SECTION = [
  PROSE.repeat(6),
  'Abstract',
  'ABSTRACTMARK the body of the abstract states the finding in one line.',
  'Keywords',
  'reading, undergraduates, libraries',
].join('\n');

const profile: Profile = {
  version: 1,
  pattern: '{name}.pdf',
  columns: [{ path: 'MWDL/description', sources: [{ opening: true }, { ai: true }] }],
};

const doc = (text: string): DocumentData => ({
  text,
  hasTextLayer: true,
  properties: {},
  tables: [],
});

const row = (over: Partial<ExtractedRow> = {}): ExtractedRow => ({
  cells: { 'MWDL/description': '' },
  sources: {},
  notes: [],
  flagged: {},
  aiWritten: {},
  ...over,
});

const provider = (reply: string) => ({ complete: vi.fn(async (_prompt: string) => reply) });

/** Every prompt the provider was handed, in order. The seam this module exists
 *  to provide, and the only one nothing used to look at. */
const promptsOf = (p: ReturnType<typeof provider>): string[] =>
  p.complete.mock.calls.map((call) => call[0]);

/** What sat inside the prompt's document fence. Coupled to `prompt.ts`'s
 *  markers on purpose: that fence is the contract between the two modules. */
const documentIn = (prompt: string): string =>
  prompt.split('--- document ---')[1]!.split('--- end of document ---')[0]!;

/** The options every test starts from. Overridden field by field. */
const options = (over: Partial<Parameters<typeof fillWithModel>[3]> = {}) => ({
  budget: 1000,
  sections: [],
  cap: 10,
  // Only the provenance note ever reads it, so most tests never look at it --
  // but it is required, so that a caller who wires the pass up and forgets to
  // say which model ran cannot silently disclose an empty name.
  model: 'llama3',
  ...over,
});

describe('fillWithModel', () => {
  it('writes the model value into an eligible cell', async () => {
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, provider('A description.'), options());
    expect(rows[0]!.row.cells['MWDL/description']).toBe('A description.');
  });

  /** Always flagged, without exception -- a model output is a guess. */
  it('flags every cell it writes', async () => {
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, provider('A description.'), options());
    expect(rows[0]!.row.sources['MWDL/description']).toBe('ai');
    expect(rows[0]!.row.notes.join(' ')).toMatch(/written by a language model/i);
  });

  it('leaves a stated value alone and asks the model nothing about it', async () => {
    const p = provider('A description.');
    const rows = [{ row: row({ cells: { 'MWDL/description': 'Stated.' } }), doc: doc('A document.') }];
    await fillWithModel(rows, profile, p, options());
    expect(rows[0]!.row.cells['MWDL/description']).toBe('Stated.');
    expect(p.complete).not.toHaveBeenCalled();
  });
});

/**
 * WHAT THE PROVIDER IS ACTUALLY HANDED -- the one property this module exists
 * to provide, and the one no assertion used to touch. Every other test here
 * reads the canned reply, so `document: ''` on every call, a dropped house
 * style and an ignored section list were all invisible: the cap would be spent
 * in full on empty fences and every test stayed green.
 */
describe('the prompt the model receives', () => {
  it('carries the sliced document', async () => {
    const p = provider('A description.');
    const rows = [{ row: row(), doc: doc('An obituary of a bookbinder.') }];
    await fillWithModel(rows, profile, p, options());
    expect(documentIn(promptsOf(p)[0]!)).toContain('An obituary of a bookbinder.');
  });

  it('carries the house style the profile asked for', async () => {
    const p = provider('A description.');
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(
      rows,
      profile,
      p,
      options({ instruction: 'Write one line: Died <date>; Born <date>.' }),
    );
    expect(promptsOf(p)[0]).toContain('Died <date>; Born <date>.');
  });

  /** The field word comes from the column being written, not from a constant
   *  -- the whole point of a mechanism that is configuration rather than code. */
  it('names the field from the column path, with the right article', async () => {
    const named = async (path: string): Promise<string> => {
      const p = provider('A value.');
      const one: Profile = {
        version: 1,
        pattern: '{name}.pdf',
        columns: [{ path, sources: [{ ai: true }] }],
      };
      await fillWithModel(
        [{ row: row({ cells: { [path]: '' } }), doc: doc('A document.') }],
        one,
        p,
        options(),
      );
      return promptsOf(p)[0]!;
    };
    expect(await named('MWDL/description')).toContain('Write a description for the document');
    expect(await named('BYUI_extended/deathDate')).toContain('Write a death date for the document');
    expect(await named('MWDL/abstract')).toContain('Write an abstract for the document');
  });

  /** The section list reaches the slice. Every other test passes `sections: []`,
   *  so half of `slice.ts` was unreachable through this module. */
  it('prefers the named sections when the document does not fit whole', async () => {
    const withSections = provider('A description.');
    await fillWithModel(
      [{ row: row(), doc: doc(LONG_WITH_SECTION) }],
      profile,
      withSections,
      options({ budget: 400, sections: ['Abstract'] }),
    );
    expect(documentIn(promptsOf(withSections)[0]!)).toContain('ABSTRACTMARK');

    const without = provider('A description.');
    await fillWithModel(
      [{ row: row(), doc: doc(LONG_WITH_SECTION) }],
      profile,
      without,
      options({ budget: 400, sections: [] }),
    );
    expect(documentIn(promptsOf(without)[0]!)).not.toContain('ABSTRACTMARK');
  });

  /** One slice per row, observed the only way that is stable: both columns are
   *  handed the same document. Counting reads of `doc.text` would pass a
   *  mutation that re-sliced per column and fail a harmless inlining. */
  it('hands both eligible columns of a row the same document', async () => {
    const twoColumns: Profile = {
      version: 1,
      pattern: '{name}.pdf',
      columns: [
        { path: 'MWDL/description', sources: [{ ai: true }] },
        { path: 'MWDL/abstract', sources: [{ ai: true }] },
      ],
    };
    const p = provider('Text.');
    await fillWithModel(
      [
        {
          row: row({ cells: { 'MWDL/description': '', 'MWDL/abstract': '' } }),
          doc: doc(LONG_WITH_SECTION),
        },
      ],
      twoColumns,
      p,
      options({ budget: 400, sections: ['Abstract'] }),
    );
    const [first, second] = promptsOf(p);
    expect(promptsOf(p)).toHaveLength(2);
    expect(documentIn(first!)).toBe(documentIn(second!));
  });
});

describe('a call that fails', () => {
  const failing = (error: unknown) => ({
    complete: vi.fn(async (_prompt: string): Promise<string> => {
      throw error;
    }),
  });

  /** A failure leaves the cell as it found it, and a reason. Never a partial,
   *  never a retry loop. */
  it('leaves an empty cell blank, says why, and does not try again', async () => {
    const p = failing(new Error('The model returned 429. rate limited'));
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, p, options());
    expect(rows[0]!.row.cells['MWDL/description']).toBe('');
    expect(rows[0]!.row.notes.join(' ')).toMatch(/429/);
    expect(p.complete).toHaveBeenCalledTimes(1);
  });

  /**
   * THE DESIGN'S HEADLINE CASE. The eligible set is "empty OR flagged", so a
   * failure here happens on a cell that still holds the extractor's flagged
   * guess. Keeping that value is right -- blanking it would destroy evidence
   * the design says may only be replaced by something better -- but then "was
   * left blank" is a false sentence about a populated cell, and an operator
   * filtering `_notes` for it gets rows that are not blank.
   */
  it('says the value was not replaced when the cell was not empty', async () => {
    const p = failing(new Error('The model returned 429. rate limited'));
    const rows = [
      {
        row: row({
          cells: { 'MWDL/description': 'Opening paragraph the extractor guessed.' },
          flagged: { 'MWDL/description': 'taken from the start of the document' },
        }),
        doc: doc('A document.'),
      },
    ];
    await fillWithModel(rows, profile, p, options());
    expect(rows[0]!.row.cells['MWDL/description']).toBe('Opening paragraph the extractor guessed.');
    const note = rows[0]!.row.notes.join(' ');
    expect(note).toMatch(/not replaced/i);
    expect(note).not.toMatch(/left blank/i);
  });

  it('says a refusal did not replace a flagged value either', async () => {
    const rows = [
      {
        row: row({
          cells: { 'MWDL/description': 'Opening paragraph the extractor guessed.' },
          flagged: { 'MWDL/description': 'taken from the start of the document' },
        }),
        doc: doc('A document.'),
      },
    ];
    await fillWithModel(rows, profile, provider("I'm sorry, I cannot help."), options());
    expect(rows[0]!.row.notes.join(' ')).toMatch(/not replaced/i);
  });

  /**
   * Node's own fetch throws `TypeError: fetch failed` and hides the real reason
   * on `cause`, so `error.message` writes a sentence that fits a wrong address,
   * a stopped server and an expired certificate alike. The shared reader exists
   * for exactly this and must be the one used here.
   */
  it('reads the reason through the cause chain rather than the top message', async () => {
    const p = failing(
      new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:11434') }),
    );
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, p, options());
    expect(rows[0]!.row.notes.join(' ')).toContain('ECONNREFUSED');
  });

  /** That reason can carry up to 200 characters of a SERVER'S response body --
   *  the one string here nobody chose. A newline ends the note visually and a
   *  control character is invisible in the cell and present in the file. */
  it('flattens a reason carrying newlines and control characters', async () => {
    const p = failing(new Error('rate limited\n<html>\n  <body>slow down</body>\n</html>'));
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, p, options());
    const note = rows[0]!.row.notes[0]!;
    expect(note).not.toMatch(/[\n\r]/);
    expect(note).toContain('rate limited <html> <body>slow down</body> </html>');
  });
});

/**
 * `cleanReply` reports three different failures, and one sentence for all three
 * is false for two of them: the model DID answer and this tool binned what it
 * said. Each must reach the operator as its own note.
 */
describe('a reply the cleaner could not use', () => {
  const noteFor = async (reply: string): Promise<string> => {
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, provider(reply), options());
    expect(rows[0]!.row.cells['MWDL/description']).toBe('');
    expect(rows[0]!.row.sources['MWDL/description']).toBeUndefined();
    return rows[0]!.row.notes.join(' ');
  };

  it('says the model declined when it refused', async () => {
    expect(await noteFor("I'm sorry, I cannot help with that.")).toMatch(/declined/i);
  });

  it('says there was an introduction and nothing under it', async () => {
    expect(await noteFor('Here is the description:\n\n')).toMatch(/introduction/i);
  });

  it('says the reply had no usable text when it was blank', async () => {
    expect(await noteFor('   ')).toMatch(/no text that could be used/i);
  });

  /**
   * THE SAFETY PROPERTY OF THIS PATH, and both halves of it at once. A refusal
   * reads as content in a catalogue record and survives review by skimming, so
   * it must never reach a cell -- but the model DID answer, and a note implying
   * silence is the same misreport wearing its other face. The quote lives in
   * `_notes`, which `plan.ts` drops with every annotation column before
   * anything is uploaded.
   */
  it('quotes what it discarded in the note and never in the cell', async () => {
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, provider("I'm sorry, I cannot help with that."), options());
    expect(rows[0]!.row.cells['MWDL/description']).toBe('');
    expect(rows[0]!.row.notes.join(' ')).toContain("I'm sorry, I cannot help with that.");
  });

  /** A note is a spreadsheet cell somebody reads, not a transcript. Pinned to
   *  the exact cut, so raising the limit is a failing test rather than a
   *  quietly longer note. */
  it('cuts a long discarded reply to eighty characters', async () => {
    const long = `I cannot do that. ${'and here is a great deal more text. '.repeat(20)}`;
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, provider(long), options());
    const shown = /which was not used: "([^"]*)"/.exec(rows[0]!.row.notes[0]!)?.[1];
    expect(shown).toBe(`${[...long.trim()].slice(0, 80).join('')}...`);
  });
});

describe('the run cap', () => {
  /** The cap is a ceiling on spend, so what it stops must be visible. */
  it('stops at the cap and says the rest were not attempted', async () => {
    const p = provider('A description.');
    const rows = [1, 2, 3].map(() => ({ row: row(), doc: doc('A document.') }));
    await fillWithModel(rows, profile, p, options({ cap: 2 }));
    expect(p.complete).toHaveBeenCalledTimes(2);
    expect(rows[2]!.row.cells['MWDL/description']).toBe('');
    expect(rows[2]!.row.notes.join(' ')).toMatch(/limit of 2/i);
  });

  it('sends nothing at all at a cap of zero, and says so on every row', async () => {
    const p = provider('A description.');
    const rows = [1, 2].map(() => ({ row: row(), doc: doc('A document.') }));
    await fillWithModel(rows, profile, p, options({ cap: 0 }));
    expect(p.complete).not.toHaveBeenCalled();
    expect(rows[0]!.row.notes.join(' ')).toMatch(/limit of 0/i);
    expect(rows[1]!.row.notes.join(' ')).toMatch(/limit of 0/i);
  });

  /**
   * THE CAP COUNTS CALLS, NOT ROWS. Two enabled columns on one row is two
   * requests and two lots of spend; counting rows would let a cap of 2 make
   * four calls, which is the one number the operator was shown and agreed to.
   */
  it('counts calls rather than rows when a row has two eligible columns', async () => {
    const twoColumns: Profile = {
      version: 1,
      pattern: '{name}.pdf',
      columns: [
        { path: 'MWDL/description', sources: [{ ai: true }] },
        { path: 'MWDL/abstract', sources: [{ ai: true }] },
      ],
    };
    const p = provider('Text.');
    const rows = [1, 2].map(() => ({
      row: row({ cells: { 'MWDL/description': '', 'MWDL/abstract': '' } }),
      doc: doc('A document.'),
    }));
    await fillWithModel(rows, twoColumns, p, options({ cap: 2 }));
    expect(p.complete).toHaveBeenCalledTimes(2);
    expect(rows[0]!.row.cells['MWDL/abstract']).toBe('Text.');
    expect(rows[1]!.row.cells['MWDL/description']).toBe('');
    expect(rows[1]!.row.notes.join(' ')).toMatch(/limit of 2/i);
  });

  /** A document that could not be sent cost nothing, so it must not spend the
   *  budget the operator agreed to. */
  it('does not spend the cap on a row that had nothing to send', async () => {
    const p = provider('A description.');
    const rows = [
      { row: row(), doc: doc('') },
      { row: row(), doc: doc('A document.') },
    ];
    await fillWithModel(rows, profile, p, options({ cap: 1 }));
    expect(p.complete).toHaveBeenCalledTimes(1);
    expect(rows[1]!.row.cells['MWDL/description']).toBe('A description.');
  });
});

/**
 * `slice.shape === 'empty'` means three different things -- an empty document,
 * a document with no opening and no named section, and a budget too small for
 * any part to survive. Only the first is knowable from the shape, and a note
 * asserting a cause it cannot know is this codebase's oldest defect.
 */
describe('a document with nothing to send', () => {
  it('says the file has no text when the file really has none', async () => {
    const p = provider('x');
    const rows = [{ row: row(), doc: doc('   ') }];
    await fillWithModel(rows, profile, p, options());
    expect(p.complete).not.toHaveBeenCalled();
    expect(rows[0]!.row.notes.join(' ')).toMatch(/no text to read/i);
  });

  it('does not claim a document full of text has none', async () => {
    const p = provider('x');
    const rows = [{ row: row(), doc: doc(PROSE.repeat(3)) }];
    await fillWithModel(rows, profile, p, options({ budget: 50 }));
    expect(p.complete).not.toHaveBeenCalled();
    const note = rows[0]!.row.notes.join(' ');
    expect(note).not.toMatch(/no text to read/i);
    expect(note).toMatch(/budget/i);
    expect(note).toContain('50');
  });
});

describe('what was actually sent', () => {
  /**
   * An operator whose 12,000-character document was cut to a 200-character
   * opening otherwise has no way to know the model saw a fraction of the file,
   * and reads a thin description as a bad model.
   */
  it('says on the note when only part of the document went', async () => {
    const rows = [{ row: row(), doc: doc(PROSE.repeat(20)) }];
    await fillWithModel(rows, profile, provider('A description.'), options({ budget: 300 }));
    expect(rows[0]!.row.cells['MWDL/description']).toBe('A description.');
    expect(rows[0]!.row.notes.join(' ')).toMatch(/only part of the document/i);
  });

  /** One clause on the existing note, never a second note per cell: a batch of
   *  400 rows with two notes each is a wall nobody reads. */
  it('adds no second note for it', async () => {
    const rows = [{ row: row(), doc: doc(PROSE.repeat(20)) }];
    await fillWithModel(rows, profile, provider('A description.'), options({ budget: 300 }));
    expect(rows[0]!.row.notes).toHaveLength(1);
  });

  it('says nothing about it when the whole document went', async () => {
    const rows = [{ row: row(), doc: doc('A short document.') }];
    await fillWithModel(rows, profile, provider('A description.'), options());
    expect(rows[0]!.row.notes.join(' ')).not.toMatch(/only part of the document/i);
  });

  /** A refusal on a document the model only half saw is exactly the surprising
   *  output the recorded shape exists to explain. */
  it('says it on a failure note too', async () => {
    const rows = [{ row: row(), doc: doc(PROSE.repeat(20)) }];
    await fillWithModel(
      rows,
      profile,
      provider("I'm sorry, I cannot help with that."),
      options({ budget: 300 }),
    );
    expect(rows[0]!.row.notes.join(' ')).toMatch(/only part of the document/i);
  });
});

/**
 * A finished row has to be able to answer "did a model write this cell?"
 * without anybody parsing note prose. Two things need it: a second pass, which
 * must not pay for a cell the first one wrote; and the review counters, which
 * read `notes.length > 0` and would otherwise report "400 of 400 need review"
 * the moment a model is enabled -- destroying the very signal `flagIfEmpty`
 * exists to protect.
 */
describe('the record a finished row keeps of the model pass', () => {
  it('records each write as the exact note it pushed', async () => {
    const rows = [
      {
        row: row({ notes: ['no text layer -- nothing could be read from inside this file'] }),
        doc: doc('A document.'),
      },
    ];
    await fillWithModel(rows, profile, provider('A description.'), options());
    const finished = rows[0]!.row;

    expect(Object.keys(finished.aiWritten)).toEqual(['MWDL/description']);
    // The operation Task 11's counter performs: subtract by identity, no
    // string matching, no arithmetic on note counts.
    const written = new Set(Object.values(finished.aiWritten).map((w) => w.note));
    expect(finished.notes.filter((note) => !written.has(note))).toEqual([
      'no text layer -- nothing could be read from inside this file',
    ]);
  });

  it('records nothing for a cell it failed on', async () => {
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, provider("I'm sorry, I cannot help."), options());
    expect(rows[0]!.row.aiWritten).toEqual({});
  });

  /** The note `flagged` holds describes a value that is no longer in the cell,
   *  and the rule reads `flagged` to decide what may be replaced. */
  it('clears the flag that made the cell eligible', async () => {
    const rows = [
      {
        row: row({
          cells: { 'MWDL/description': 'Opening paragraph the extractor guessed.' },
          flagged: { 'MWDL/description': 'taken from the start of the document' },
        }),
        doc: doc('A document.'),
      },
    ];
    await fillWithModel(rows, profile, provider('A description.'), options());
    expect(rows[0]!.row.flagged).toEqual({});
  });

  it('leaves the flag alone on a cell it could not write', async () => {
    const rows = [
      {
        row: row({
          cells: { 'MWDL/description': 'Opening paragraph the extractor guessed.' },
          flagged: { 'MWDL/description': 'taken from the start of the document' },
        }),
        doc: doc('A document.'),
      },
    ];
    await fillWithModel(rows, profile, provider("I'm sorry, I cannot help."), options());
    expect(rows[0]!.row.flagged['MWDL/description']).toBe('taken from the start of the document');
  });

  /** Nothing calls it twice today -- which is exactly why the next task will
   *  assume this was handled here. */
  it('sends nothing on a second pass over the same rows', async () => {
    const p = provider('A description.');
    const rows = [
      {
        row: row({
          cells: { 'MWDL/description': 'Opening paragraph the extractor guessed.' },
          flagged: { 'MWDL/description': 'taken from the start of the document' },
        }),
        doc: doc('A document.'),
      },
    ];
    await fillWithModel(rows, profile, p, options());
    await fillWithModel(rows, profile, p, options());
    expect(p.complete).toHaveBeenCalledTimes(1);
    expect(rows[0]!.row.cells['MWDL/description']).toBe('A description.');
  });

  /**
   * `flagIfEmpty` fires on precisely the empty cells the model then fills, so
   * without this the commonest case ships a row telling the operator to
   * hand-fill a cell that now has content. Driven through `buildRow` so the
   * note removed is genuinely the one the extractor writes.
   */
  it('takes back the "fill this in by hand" note when it fills that cell', async () => {
    const template: Profile = {
      version: 1,
      pattern: '{name}.pdf',
      columns: [
        { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
        { path: 'MWDL/description', sources: [{ ai: true }], flagIfEmpty: true },
      ],
    };
    const built = buildRow(template, 'a.pdf', doc('A document.'));
    expect(built.notes.join(' ')).toMatch(/Fill that cell in by hand/);

    await fillWithModel(
      [{ row: built, doc: doc('A document.') }],
      template,
      provider('A description.'),
      options(),
    );
    expect(built.notes.join(' ')).not.toMatch(/Fill that cell in by hand/);
    expect(built.notes).toHaveLength(1);
  });

  it('leaves that note alone when the model could not fill the cell', async () => {
    const template: Profile = {
      version: 1,
      pattern: '{name}.pdf',
      columns: [
        { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
        { path: 'MWDL/description', sources: [{ ai: true }], flagIfEmpty: true },
      ],
    };
    const built = buildRow(template, 'a.pdf', doc('A document.'));
    await fillWithModel(
      [{ row: built, doc: doc('A document.') }],
      template,
      provider("I'm sorry, I cannot help."),
      options(),
    );
    expect(built.notes.join(' ')).toMatch(/Fill that cell in by hand/);
  });
});

/**
 * A mistyped budget or cap is a CONFIGURATION fault affecting every row, not a
 * per-row failure. Four hundred identical notes after a run that spent nothing
 * and looks like it tried is the wrong shape entirely.
 */
describe('a setting that cannot be used', () => {
  it('fails before a single call is made', async () => {
    const p = provider('A description.');
    const rows = [1, 2, 3].map(() => ({ row: row(), doc: doc('A document.') }));
    await expect(fillWithModel(rows, profile, p, options({ budget: Number.NaN }))).rejects.toThrow(
      ValidationError,
    );
    expect(p.complete).not.toHaveBeenCalled();
    expect(rows[0]!.row.notes).toEqual([]);
  });

  it('names the setting rather than the file', async () => {
    const rows = [{ row: row(), doc: doc('A document.') }];
    await expect(
      fillWithModel(rows, profile, provider('x'), options({ budget: 0 })),
    ).rejects.toThrow(/budget/i);
  });

  /** A NaN cap compares false against everything, so every row is sent and the
   *  ceiling the operator agreed to does not exist. */
  it('refuses a cap that is not a number, before spending anything', async () => {
    const p = provider('A description.');
    const rows = [{ row: row(), doc: doc('A document.') }];
    await expect(fillWithModel(rows, profile, p, options({ cap: Number.NaN }))).rejects.toThrow(
      /limit/i,
    );
    expect(p.complete).not.toHaveBeenCalled();
  });

  /** A negative cap behaves as zero, which reads as "the model is broken"
   *  rather than "that box is wrong". Refused, like the budget. */
  it('refuses a negative cap rather than silently sending nothing', async () => {
    const rows = [{ row: row(), doc: doc('A document.') }];
    await expect(fillWithModel(rows, profile, provider('x'), options({ cap: -1 }))).rejects.toThrow(
      /limit/i,
    );
  });
});

/**
 * THE SPEC REQUIREMENT: "Fact fields ... stay flagged for review even when an
 * operator enables them, and the flag says which kind of field it was."
 *
 * A description that reads oddly is a quality problem a cataloguer fixes. A
 * fabricated death date is indistinguishable from a real one to everyone
 * downstream, for ever, in a collection with no moderation queue.
 */
describe('a fact field is flagged differently from a prose field', () => {
  const mixed: Profile = {
    version: 1,
    pattern: '{name}.pdf',
    columns: [
      { path: 'MWDL/description', sources: [{ ai: true }] },
      { path: 'MWDL/deathDate', sources: [{ ai: true }], transform: 'date' },
    ],
  };

  const notesFrom = async (p: Profile, cells: Record<string, string>): Promise<string[]> => {
    const rows = [{ row: row({ cells }), doc: doc('A document.') }];
    await fillWithModel(rows, p, provider('A value.'), options());
    return rows[0]!.row.notes;
  };

  it('says a date column holds a date, and why that matters more', async () => {
    const notes = await notesFrom(mixed, { 'MWDL/description': '', 'MWDL/deathDate': '' });
    const fact = notes.find((n) => n.startsWith('MWDL/deathDate'))!;
    expect(fact).toMatch(/date/i);
    expect(fact).toMatch(/cannot be told from a real one/i);
  });

  it('does not put that warning on a prose column', async () => {
    const notes = await notesFrom(mixed, { 'MWDL/description': '', 'MWDL/deathDate': '' });
    const prose = notes.find((n) => n.startsWith('MWDL/description'))!;
    expect(prose).toMatch(/written by a language model/i);
    expect(prose).not.toMatch(/cannot be told from a real one/i);
  });

  it('reads a name column as a fact field too', async () => {
    const people: Profile = {
      version: 1,
      pattern: '{name}.pdf',
      columns: [{ path: 'MWDL/creators/creator', sources: [{ ai: true }], transform: 'people' }],
    };
    const notes = await notesFrom(people, { 'MWDL/creators/creator': '' });
    expect(notes.join(' ')).toMatch(/holds a name/i);
    expect(notes.join(' ')).toMatch(/cannot be told from a real one/i);
  });

  it('reads a declared date format as a date', async () => {
    const formatted: Profile = {
      version: 1,
      pattern: '{name}.pdf',
      columns: [
        { path: 'MWDL/deathDate', sources: [{ ai: true }], transform: { date: 'MMDDYYYY' } },
      ],
    };
    const notes = await notesFrom(formatted, { 'MWDL/deathDate': '' });
    expect(notes.join(' ')).toMatch(/holds a date/i);
  });

  /**
   * A column asking for a date through its sources is a date column whether or
   * not it declared a transform -- and the obituary template's own death-date
   * column is sourced exactly this way. Nothing else covers this branch.
   */
  it('reads a column whose sources ask for a date as a fact field', async () => {
    const dated: Profile = {
      version: 1,
      pattern: '{name}.pdf',
      columns: [{ path: 'MWDL/deathDate', sources: [{ dateNear: ['passed away'] }, { ai: true }] }],
    };
    const notes = await notesFrom(dated, { 'MWDL/deathDate': '' });
    expect(notes.join(' ')).toMatch(/cannot be told from a real one/i);
  });
});

/**
 * Disclosure in the item -- a note in the RECORD, not in `_notes`.
 *
 * `_notes` is dropped by `plan.ts` before anything is uploaded, so everything
 * else this module writes is invisible to a future reader of the catalogue.
 * This is the one thing that is not.
 *
 * EVERY PROFILE HERE DECLARES THE PROVENANCE PATH AS A COLUMN, because
 * `parseProfile` now refuses one that does not -- see the matching block in
 * tests/extract/profile.test.ts for why. A fixture that skipped it would pass
 * every assertion below while describing a profile the loader would never hand
 * to this function.
 */
describe('disclosure in the item', () => {
  const provenanceColumn = { path: 'MWDL/conversionSpecifications', sources: [] };

  const withProvenance: Profile = {
    version: 1,
    pattern: '{name}.pdf',
    columns: [{ path: 'MWDL/description', sources: [{ ai: true }] }, provenanceColumn],
    aiProvenance: {
      path: 'MWDL/conversionSpecifications',
      append: 'Description generated by {model}',
    },
  };

  it('appends a provenance note to the named field', async () => {
    const rows = [
      {
        row: row({
          cells: { 'MWDL/description': '', 'MWDL/conversionSpecifications': 'Scanned to PDF' },
        }),
        doc: doc(PROSE),
      },
    ];
    await fillWithModel(rows, withProvenance, provider('A description.'), options({ model: 'llama3' }));
    expect(rows[0]!.row.cells['MWDL/conversionSpecifications']).toBe(
      'Scanned to PDF; Description generated by llama3',
    );
  });

  /** The tool never picks the field. No profile setting, no write. */
  it('writes nothing to the item when no profile names a field', async () => {
    const rows = [
      {
        row: row({
          cells: { 'MWDL/description': '', 'MWDL/conversionSpecifications': 'Scanned to PDF' },
        }),
        doc: doc(PROSE),
      },
    ];
    await fillWithModel(rows, profile, provider('A description.'), options({ model: 'llama3' }));
    expect(rows[0]!.row.cells['MWDL/conversionSpecifications']).toBe('Scanned to PDF');
  });

  /**
   * ONCE PER ROW, NOT ONCE PER WRITTEN CELL. A row with two enabled columns
   * would otherwise carry the same sentence twice in one catalogue field, and
   * a batch with eight would carry it eight times -- in a record nobody can
   * edit afterwards without going back into openEQUELLA.
   */
  it('writes the note once even when several columns were filled', async () => {
    const two: Profile = {
      ...withProvenance,
      columns: [
        { path: 'MWDL/description', sources: [{ ai: true }] },
        { path: 'MWDL/abstract', sources: [{ ai: true }] },
        provenanceColumn,
      ],
    };
    const rows = [
      {
        row: row({
          cells: { 'MWDL/description': '', 'MWDL/abstract': '', 'MWDL/conversionSpecifications': '' },
        }),
        doc: doc(PROSE),
      },
    ];
    await fillWithModel(rows, two, provider('Text.'), options({ model: 'llama3' }));
    expect(rows[0]!.row.cells['MWDL/conversionSpecifications']).toBe('Description generated by llama3');
  });

  it('writes nothing when the model wrote nothing', async () => {
    const rows = [
      {
        row: row({ cells: { 'MWDL/description': '', 'MWDL/conversionSpecifications': '' } }),
        doc: doc(PROSE),
      },
    ];
    await fillWithModel(
      rows,
      withProvenance,
      provider("I'm sorry, I cannot help."),
      options({ model: 'llama3' }),
    );
    expect(rows[0]!.row.cells['MWDL/conversionSpecifications']).toBe('');
  });

  /** A run that reached its cap before this row made no call, so there is
   *  nothing to disclose and the field must not be touched. */
  it('writes nothing on a row the cap stopped', async () => {
    const rows = [1, 2].map(() => ({
      row: row({ cells: { 'MWDL/description': '', 'MWDL/conversionSpecifications': '' } }),
      doc: doc(PROSE),
    }));
    await fillWithModel(rows, withProvenance, provider('A description.'), options({ cap: 1, model: 'llama3' }));
    expect(rows[0]!.row.cells['MWDL/conversionSpecifications']).toBe('Description generated by llama3');
    expect(rows[1]!.row.cells['MWDL/conversionSpecifications']).toBe('');
  });

  it('substitutes the model that was actually used', async () => {
    const rows = [
      {
        row: row({ cells: { 'MWDL/description': '', 'MWDL/conversionSpecifications': '' } }),
        doc: doc(PROSE),
      },
    ];
    await fillWithModel(rows, withProvenance, provider('A description.'), options({ model: 'gpt-4o-mini' }));
    expect(rows[0]!.row.cells['MWDL/conversionSpecifications']).toBe(
      'Description generated by gpt-4o-mini',
    );
  });

  /**
   * THE ASSERTION THE ROW-LEVEL ONES CANNOT MAKE.
   *
   * `csv.ts` builds its columns from `profile.columns`, so a value written into
   * `row.cells` under any other path is created and then dropped on the floor.
   * Every test above would still pass in that world -- the value really is on
   * the row -- and the operator would never see it. This is the one that opens
   * the file the operator opens.
   */
  it('reaches the spreadsheet the operator opens', async () => {
    const rows = [
      {
        row: row({
          cells: {
            [ATTACHMENT_COLUMN]: 'a.pdf',
            'MWDL/description': '',
            'MWDL/conversionSpecifications': 'Scanned to PDF',
          },
        }),
        doc: doc(PROSE),
      },
    ];
    const sheetProfile: Profile = {
      ...withProvenance,
      columns: [
        { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
        ...withProvenance.columns,
      ],
    };
    await fillWithModel(rows, sheetProfile, provider('A description.'), options({ model: 'llama3' }));

    const dir = await mkdtemp(join(tmpdir(), 'oeq-fill-csv-'));
    const out = join(dir, 'out.csv');
    await writeCsv(out, sheetProfile, [rows[0]!.row]);
    expect(await readFile(out, 'utf8')).toContain('Scanned to PDF; Description generated by llama3');
  });
});

/**
 * `aiWritten` records WHICH KIND OF COLUMN was written, not merely that one was.
 *
 * `review.ts` subtracts a routine model write from the "needs review" count, and
 * that reasoning holds for prose and not for facts -- the design puts them in
 * different buckets. The judgement is made here, once, by the code that already
 * had to make it in order to word the note, because the counter runs on surfaces
 * that hold a row and no profile.
 */
describe('what a write records about the column it wrote', () => {
  const dateProfile: Profile = {
    version: 1,
    pattern: '{name}.pdf',
    columns: [{ path: 'MWDL/deathDate', sources: [{ ai: true }], transform: 'date' }],
  };

  it('marks a prose column as not a fact field', async () => {
    const rows = [{ row: row(), doc: doc(PROSE) }];
    await fillWithModel(rows, profile, provider('A description.'), options());
    expect(rows[0]!.row.aiWritten['MWDL/description']?.factField).toBe(false);
  });

  /**
   * The document has to STATE the date the model returns, or `verify.ts` refuses
   * the value and there is no write to record anything about. It states it in
   * words while the model answers in ISO, which is the ordinary case and is
   * incidentally a second demonstration that the two forms of one day are one
   * date.
   */
  it('marks a date column as a fact field', async () => {
    const rows = [
      { row: row({ cells: { 'MWDL/deathDate': '' } }), doc: doc(`${PROSE} He died on April 2, 1998.`) },
    ];
    await fillWithModel(rows, dateProfile, provider('1998-04-02'), options());
    expect(rows[0]!.row.aiWritten['MWDL/deathDate']?.factField).toBe(true);
  });

  it('stores the exact note it pushed, either way', async () => {
    const rows = [{ row: row(), doc: doc(PROSE) }];
    await fillWithModel(rows, profile, provider('A description.'), options());
    const write = rows[0]!.row.aiWritten['MWDL/description']!;
    expect(rows[0]!.row.notes).toContain(write.note);
  });
});

/**
 * ## The profile that reaches the fill pass has not necessarily been through the
 * loader since
 *
 * `parseProfile` refuses an `aiProvenance` whose path is not a writable column.
 * The desktop's column editor then rewrites the profile IN MEMORY --
 * `removeColumn` returns `{ ...profile, columns: filtered }` -- and `extractRun`
 * never re-parses. So the loader's guarantee is a statement about a profile that
 * may no longer exist, and the note that survives the upload would be written
 * into `row.cells`, dropped by `csv.ts`, and gone with nothing said.
 */
describe('disclosure when the profile no longer has the column', () => {
  const orphaned: Profile = {
    version: 1,
    pattern: '{name}.pdf',
    columns: [{ path: 'MWDL/description', sources: [{ ai: true }] }],
    aiProvenance: { path: 'MWDL/conversionSpecifications', append: 'Written by {model}' },
  };

  it('says so in the notes rather than writing into nothing', async () => {
    const rows = [{ row: row(), doc: doc(PROSE) }];
    await fillWithModel(rows, orphaned, provider('A description.'), options());
    expect(rows[0]!.row.notes.join(' ')).toMatch(/MWDL\/conversionSpecifications/);
    expect(rows[0]!.row.notes.join(' ')).toMatch(/no such column|could not be written/i);
  });

  /** And it counts as a problem: the disclosure genuinely did not happen. */
  it('leaves the row needing review', async () => {
    const rows = [{ row: row(), doc: doc(PROSE) }];
    await fillWithModel(rows, orphaned, provider('A description.'), options());
    expect(needsReview(rows[0]!.row)).toBe(true);
  });

  /** A composeOnly column is filtered out of the sheet by `csv.ts`, so it is as
   *  good as absent -- the same silent drop wearing a different hat. */
  it('treats a composeOnly column the same way', async () => {
    const composeOnly: Profile = {
      ...orphaned,
      columns: [
        { path: 'MWDL/description', sources: [{ ai: true }] },
        { path: 'MWDL/conversionSpecifications', sources: [], composeOnly: true, as: 'conv' },
      ],
    };
    const rows = [
      { row: row({ cells: { 'MWDL/description': '', 'MWDL/conversionSpecifications': '' } }), doc: doc(PROSE) },
    ];
    await fillWithModel(rows, composeOnly, provider('A description.'), options());
    expect(rows[0]!.row.cells['MWDL/conversionSpecifications']).toBe('');
    expect(rows[0]!.row.notes.join(' ')).toMatch(/could not be written/i);
  });
});

/**
 * The provenance cell is a filled cell and is recorded like one.
 *
 * `_source` is how a reviewer sorts a spreadsheet to read only what this pass
 * touched. A cell that changed without appearing there reads as one the document
 * supplied -- which, for a sentence naming a language model, is precisely the
 * wrong impression.
 */
describe('what the provenance write records about itself', () => {
  const provenanceColumn = { path: 'MWDL/conversionSpecifications', sources: [] };
  const declared: Profile = {
    version: 1,
    pattern: '{name}.pdf',
    columns: [{ path: 'MWDL/description', sources: [{ ai: true }] }, provenanceColumn],
    aiProvenance: { path: 'MWDL/conversionSpecifications', append: 'Written by {model}' },
  };

  it('records a source for the cell it wrote', async () => {
    const rows = [
      { row: row({ cells: { 'MWDL/description': '', 'MWDL/conversionSpecifications': '' } }), doc: doc(PROSE) },
    ];
    await fillWithModel(rows, declared, provider('A description.'), options());
    expect(rows[0]!.row.sources['MWDL/conversionSpecifications']).toBeDefined();
  });

  /** NOT `ai`: no model wrote that sentence. The profile author did, and this
   *  tool stamped a model's name into it. A reviewer reading everything a
   *  machine composed must not be handed their own words. */
  it('does not claim a model wrote it', async () => {
    const rows = [
      { row: row({ cells: { 'MWDL/description': '', 'MWDL/conversionSpecifications': '' } }), doc: doc(PROSE) },
    ];
    await fillWithModel(rows, declared, provider('A description.'), options());
    expect(rows[0]!.row.sources['MWDL/conversionSpecifications']).not.toBe('ai');
    expect(rows[0]!.row.sources['MWDL/description']).toBe('ai');
  });

  /** "Fill that cell in by hand" is false once it has content -- cleared for the
   *  same reason, and by the same means, as for the model's own writes. */
  it('clears a flagIfEmpty note for a cell it has just filled', async () => {
    const flagged: Profile = {
      ...declared,
      columns: [
        { path: 'MWDL/description', sources: [{ ai: true }] },
        { ...provenanceColumn, flagIfEmpty: true },
      ],
    };
    const built = buildRow(flagged, 'a.pdf', doc(PROSE));
    expect(built.notes.join(' ')).toMatch(/MWDL\/conversionSpecifications/);
    await fillWithModel([{ row: built, doc: doc(PROSE) }], flagged, provider('A description.'), options());
    expect(built.notes.some((n) => n === expectedButEmptyNote('MWDL/conversionSpecifications'))).toBe(false);
    expect(built.cells['MWDL/conversionSpecifications']).toBe('Written by llama3');
  });
});

/**
 * ## A REPLY WHOSE FACTS THE DOCUMENT DOES NOT SUPPORT IS REFUSED WHOLE
 *
 * Run against a real batch with a small local model on 2026-08-14, two of ten
 * generated descriptions contained fabricated facts -- a full ISO death date on
 * a document stating no date of any kind (a DIFFERENT one each run, at
 * temperature zero), and an affiliation asserted for documents mentioning none.
 * The shipped prompt forbids exactly that in as many words, so the prompt cannot
 * be the defence: the tool cannot know how capable the model behind an endpoint
 * is. See `core/ai/verify.ts`.
 *
 * The whole value goes, never part of it. Stripping the offending clause would
 * leave a half-removed sentence that reads as complete while meaning something
 * different, and this tool does not edit generated prose.
 *
 * Every fixture here is invented, and modelled on the SHAPE of those failures.
 */
describe('a reply the document does not support', () => {
  /** A document that states no date, no number and no affiliation -- exactly the
   *  shape that drew an invented date out of a real model. */
  const SILENT =
    'Alder Hawthorn died at his home in Marrowfield, quietly and with his family beside ' +
    'him, on an afternoon at the end of the harvest. He will be missed by the many friends ' +
    'he made over a long working life in the town.';

  const refused = async (reply: string, text = SILENT, p: Profile = profile) => {
    const rows = [{ row: row(), doc: doc(text) }];
    await fillWithModel(rows, p, provider(reply), options());
    return rows[0]!.row;
  };

  it('leaves the cell exactly as it was', async () => {
    const result = await refused('Alder Hawthorn died on 2024-01-06.');
    expect(result.cells['MWDL/description']).toBe('');
  });

  it('does not replace a flagged value the extractor had put there', async () => {
    const rows = [
      {
        row: row({
          cells: { 'MWDL/description': 'Opening paragraph the extractor guessed.' },
          flagged: { 'MWDL/description': 'taken from the start of the document' },
        }),
        doc: doc(SILENT),
      },
    ];
    await fillWithModel(rows, profile, provider('Alder Hawthorn died on 2024-01-06.'), options());
    expect(rows[0]!.row.cells['MWDL/description']).toBe('Opening paragraph the extractor guessed.');
    // The source's doubt has NOT been acted on, so the flag must survive -- the
    // cell is still a candidate for a better value.
    expect(rows[0]!.row.flagged['MWDL/description']).toBe('taken from the start of the document');
  });

  it('records no source for a cell it did not write', async () => {
    const result = await refused('Alder Hawthorn died on 2024-01-06.');
    expect(result.sources['MWDL/description']).toBeUndefined();
  });

  /**
   * NOT RECORDED IN `aiWritten`, and this is the counter's whole basis.
   * `review.ts` subtracts that map from the notes to tell a routine model write
   * from a real problem; a refusal recorded there would be subtracted out, and
   * the row would report as needing no review while holding an empty cell.
   */
  it('records nothing in aiWritten, so the row still counts as needing review', async () => {
    const rows = [{ row: row(), doc: doc(SILENT) }];
    await fillWithModel(rows, profile, provider('Alder Hawthorn died on 2024-01-06.'), options());
    expect(rows[0]!.row.aiWritten).toEqual({});
    expect(needsReview(rows[0]!.row)).toBe(true);
  });

  it('names the claim that failed and why, and quotes what it threw away', async () => {
    const result = await refused('Alder Hawthorn died on 2024-01-06.');
    const note = result.notes.join(' ');
    expect(note).toContain('MWDL/description:');
    expect(note).toContain('2024-01-06');
    expect(note).toMatch(/states no such date/i);
    expect(note).toContain('What it said, which was not used:');
  });

  /**
   * THREE DIFFERENT EVENTS, THREE DIFFERENT SENTENCES -- the rule this module
   * already applies to a cleaner discard and a failed call. A refusal is neither:
   * the model answered, the call succeeded, and this tool declined the answer.
   * An operator told "the model gave no answer" would go and look at the model.
   */
  it('reads as a refusal, not as an empty answer and not as a failed call', async () => {
    const note = (await refused('Alder Hawthorn died on 2024-01-06.')).notes.join(' ');
    expect(note).toMatch(/refused/i);
    expect(note).not.toMatch(/gave no answer|no text that could be used|declined to write/i);
  });

  it('names every failed claim, not just the first', async () => {
    const note = (
      await refused('Alder Hawthorn died on 2024-01-06 after 47 years in the trade.')
    ).notes.join(' ');
    expect(note).toContain('2024-01-06');
    expect(note).toContain('47');
  });

  /** The row wrote nothing, so there is nothing to disclose. A provenance note
   *  claiming a model contributed to a record it never touched is a false
   *  statement in a permanent catalogue. */
  it('discloses nothing in the item', async () => {
    const withProvenance: Profile = {
      ...profile,
      columns: [
        ...profile.columns,
        { path: 'MWDL/conversionSpecifications', sources: [] },
      ],
      aiProvenance: { path: 'MWDL/conversionSpecifications', append: 'Written by {model}' },
    };
    const result = await refused('Alder Hawthorn died on 2024-01-06.', SILENT, withProvenance);
    expect(result.cells['MWDL/conversionSpecifications']).toBeUndefined();
  });

  /**
   * THE CHECK MUST BE INVISIBLE TO A GOOD ANSWER. Eight of those ten outputs
   * were fine, and a verifier that also rejected them would be worse than none.
   */
  it('writes a value whose every checkable claim the document states', async () => {
    const rows = [
      {
        row: row(),
        doc: doc('Alder Hawthorn passed away on January 6, 2024, after 47 years in the trade.'),
      },
    ];
    await fillWithModel(
      rows,
      profile,
      provider('A bookbinder of Marrowfield. Died 2024-01-06, after 47 years in the trade.'),
      options(),
    );
    expect(rows[0]!.row.cells['MWDL/description']).toBe(
      'A bookbinder of Marrowfield. Died 2024-01-06, after 47 years in the trade.',
    );
    expect(rows[0]!.row.aiWritten['MWDL/description']).toBeDefined();
  });

  /**
   * CHECKED AGAINST THE WHOLE DOCUMENT, NOT THE SLICE THAT WAS SENT. The model
   * cannot have read more than the slice, so a claim the rest of the file
   * supports is a coincidence rather than a fabrication -- and checking the
   * slice would make a supported value depend on the character budget, so
   * lowering a setting would start refusing descriptions that had been fine.
   */
  it('accepts a date stated in the part of the document the budget left out', async () => {
    const rows = [
      {
        row: row(),
        doc: doc(`${PROSE.repeat(8)}\nHe passed away on January 6, 2024, at home.`),
      },
    ];
    await fillWithModel(rows, profile, provider('Died 2024-01-06.'), options({ budget: 200 }));
    expect(rows[0]!.row.cells['MWDL/description']).toBe('Died 2024-01-06.');
  });

  /**
   * THE ASSERTION CHECK'S VOCABULARY IS THE PROFILE'S OWN. A `presence` source
   * declares a trigger list; where the reply names one and the document names
   * none, the model has asserted something a check this tool already ran found
   * no evidence for. Nothing in the code knows what the triggers mean, and a
   * profile declaring none gets no check at all.
   */
  it('refuses an assertion a presence source in the profile found no evidence for', async () => {
    const withPresence: Profile = {
      version: 1,
      pattern: '{name}.pdf',
      columns: [
        {
          path: 'MWDL/relation',
          composeOnly: true,
          sources: [
            { presence: { any: ['Larkspur Academy', 'Larkspur Institute'], then: 'Attended Larkspur Academy' } },
          ],
        },
        { path: 'MWDL/description', sources: [{ ai: true }] },
      ],
    };
    const asserted = 'A bookbinder of Marrowfield who attended Larkspur Academy.';

    const refusedRow = await refused(asserted, SILENT, withPresence);
    expect(refusedRow.cells['MWDL/description']).toBe('');
    expect(refusedRow.notes.join(' ')).toContain('Larkspur Academy');

    // The same reply, over a document that does evidence it, is written.
    const evidenced = await refused(
      asserted,
      `${SILENT} He was a graduate of Larkspur Academy.`,
      withPresence,
    );
    expect(evidenced.cells['MWDL/description']).toBe(asserted);
  });
});
