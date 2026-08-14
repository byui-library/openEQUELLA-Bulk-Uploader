// tests/ai/fill.test.ts
import { describe, it, expect, vi } from 'vitest';
import { fillWithModel } from '../../src/core/ai/fill.js';
import { ValidationError } from '../../src/core/errors.js';
import type { DocumentData, ExtractedRow, Profile } from '../../src/core/extract/types.js';

/**
 * Real prose. `readOpening` refuses to call anything an opening unless it has
 * ten words of two letters or more, a sentence ending, and is mostly lowercase
 * -- so a run of `x`s produces an EMPTY slice and would exercise the wrong path
 * in half of these tests.
 */
const PROSE =
  'This obituary records what the family said about a long life in a small town, ' +
  'and what the college meant to it. ';

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

/**
 * A document that counts how many times its text was read.
 *
 * The slice depends on the document alone, so computing it per eligible column
 * is paid work repeated for nothing. Reads of `text` are the only externally
 * visible trace of that, which is why this exists rather than a spy on
 * `sliceForModel`: it asserts the property without mocking the module under
 * test's collaborators.
 */
const countingDoc = (text: string): DocumentData & { reads: () => number } => {
  let reads = 0;
  return {
    get text() {
      reads += 1;
      return text;
    },
    hasTextLayer: true,
    properties: {},
    tables: [],
    reads: () => reads,
  };
};

const row = (over: Partial<ExtractedRow> = {}): ExtractedRow => ({
  cells: { 'MWDL/description': '' },
  sources: {},
  notes: [],
  flagged: {},
  ...over,
});

const provider = (reply: string) => ({ complete: vi.fn(async () => reply) });

/** The options every test starts from. Overridden field by field. */
const options = (over: Partial<Parameters<typeof fillWithModel>[3]> = {}) => ({
  budget: 1000,
  sections: [],
  cap: 10,
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

  it('sends nothing at all when no row is eligible', async () => {
    const p = provider('x');
    const rows = [{ row: row({ cells: { 'MWDL/description': 'Stated.' } }), doc: doc('A doc.') }];
    await fillWithModel(rows, profile, p, options());
    expect(p.complete).not.toHaveBeenCalled();
  });
});

describe('a call that fails', () => {
  /** A failure leaves a blank and a reason. Never a partial, never a retry loop. */
  it('leaves the cell blank, says why, and does not try again', async () => {
    const p = {
      complete: vi.fn(async () => {
        throw new Error('The model returned 429. rate limited');
      }),
    };
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, p, options());
    expect(rows[0]!.row.cells['MWDL/description']).toBe('');
    expect(rows[0]!.row.notes.join(' ')).toMatch(/429/);
    expect(p.complete).toHaveBeenCalledTimes(1);
  });

  /**
   * Node's own fetch throws `TypeError: fetch failed` and hides the real reason
   * on `cause`, so `error.message` writes a sentence that fits a wrong address,
   * a stopped server and an expired certificate alike. The shared reader exists
   * for exactly this and must be the one used here.
   */
  it('reads the reason through the cause chain rather than the top message', async () => {
    const p = {
      complete: vi.fn(async () => {
        throw new TypeError('fetch failed', {
          cause: new Error('connect ECONNREFUSED 127.0.0.1:11434'),
        });
      }),
    };
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, p, options());
    expect(rows[0]!.row.notes.join(' ')).toContain('ECONNREFUSED');
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

  it('gives each of the three its own wording', async () => {
    const notes = [
      await noteFor("I'm sorry, I cannot help with that."),
      await noteFor('Here is the description:\n\n'),
      await noteFor('   '),
    ];
    expect(new Set(notes).size).toBe(3);
  });

  /**
   * THE SAFETY PROPERTY OF THIS PATH. A refusal reads as content in a
   * catalogue record and survives review by skimming, so it must never reach a
   * cell. The quote below lives in `_notes`, which `schema.ts` never uploads.
   */
  it('never writes what it discarded into the cell', async () => {
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, provider("I'm sorry, I cannot help with that."), options());
    expect(rows[0]!.row.cells['MWDL/description']).toBe('');
    expect(rows[0]!.row.cells['MWDL/description']).not.toContain('sorry');
  });

  /**
   * The model spoke and this tool threw the answer away. A note implying it
   * said nothing is the same misreport this codebase keeps shipping, wearing
   * the other face -- and both discards are heuristics that can be wrong, so
   * the operator is given enough to judge whether the cleaner was right.
   */
  it('quotes what it discarded, so the operator can see the model did answer', async () => {
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, provider("I'm sorry, I cannot help with that."), options());
    expect(rows[0]!.row.notes.join(' ')).toContain("I'm sorry, I cannot help with that.");
  });

  /** A note is a spreadsheet cell somebody reads, not a transcript. */
  it('cuts a long discarded reply down rather than pasting it into the sheet', async () => {
    const long = `I cannot do that. ${'and here is a great deal more text. '.repeat(20)}`;
    const rows = [{ row: row(), doc: doc('A document.') }];
    await fillWithModel(rows, profile, provider(long), options());
    const note = rows[0]!.row.notes.join(' ');
    expect(note).toContain('...');
    expect(note.length).toBeLessThan(400);
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

describe('the document is read once per row, not once per column', () => {
  const twoColumns: Profile = {
    version: 1,
    pattern: '{name}.pdf',
    columns: [
      { path: 'MWDL/description', sources: [{ ai: true }] },
      { path: 'MWDL/abstract', sources: [{ ai: true }] },
    ],
  };

  it('slices once for a row with two eligible columns', async () => {
    const counting = countingDoc('A document.');
    const rows = [
      { row: row({ cells: { 'MWDL/description': '', 'MWDL/abstract': '' } }), doc: counting },
    ];
    await fillWithModel(rows, twoColumns, provider('Text.'), options());
    expect(rows[0]!.row.cells['MWDL/abstract']).toBe('Text.');
    expect(counting.reads()).toBe(1);
  });

  it('does not read the document at all when nothing on the row is eligible', async () => {
    const counting = countingDoc('A document.');
    const rows = [
      {
        row: row({ cells: { 'MWDL/description': 'Stated.', 'MWDL/abstract': 'Stated.' } }),
        doc: counting,
      },
    ];
    await fillWithModel(rows, twoColumns, provider('Text.'), options());
    expect(counting.reads()).toBe(0);
  });
});

/**
 * A mistyped budget is a CONFIGURATION fault affecting every row, not a
 * per-row failure. Four hundred identical notes after a run that spent nothing
 * and looks like it tried is the wrong shape entirely.
 */
describe('a budget that cannot be used', () => {
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
    await expect(
      fillWithModel(rows, profile, p, options({ cap: Number.NaN })),
    ).rejects.toThrow(/limit/i);
    expect(p.complete).not.toHaveBeenCalled();
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

  const fill = async (p: Profile, cells: Record<string, string>) => {
    const rows = [{ row: row({ cells }), doc: doc('A document.') }];
    await fillWithModel(rows, p, provider('A value.'), options());
    return rows[0]!.row.notes;
  };

  it('says a date column holds a date, and why that matters more', async () => {
    const notes = await fill(mixed, { 'MWDL/description': '', 'MWDL/deathDate': '' });
    const fact = notes.find((n) => n.startsWith('MWDL/deathDate'))!;
    expect(fact).toMatch(/date/i);
    expect(fact).toMatch(/cannot be told from a real one/i);
  });

  it('does not put that warning on a prose column', async () => {
    const notes = await fill(mixed, { 'MWDL/description': '', 'MWDL/deathDate': '' });
    const prose = notes.find((n) => n.startsWith('MWDL/description'))!;
    expect(prose).toMatch(/written by a language model/i);
    expect(prose).not.toMatch(/cannot be told from a real one/i);
  });

  it('gives the two different wording', async () => {
    const notes = await fill(mixed, { 'MWDL/description': '', 'MWDL/deathDate': '' });
    const fact = notes.find((n) => n.startsWith('MWDL/deathDate'))!;
    const prose = notes.find((n) => n.startsWith('MWDL/description'))!;
    expect(fact.replace('MWDL/deathDate', '')).not.toBe(prose.replace('MWDL/description', ''));
  });

  it('reads a name column as a fact field too', async () => {
    const people: Profile = {
      version: 1,
      pattern: '{name}.pdf',
      columns: [{ path: 'MWDL/creators/creator', sources: [{ ai: true }], transform: 'people' }],
    };
    const notes = await fill(people, { 'MWDL/creators/creator': '' });
    expect(notes.join(' ')).toMatch(/name/i);
    expect(notes.join(' ')).toMatch(/cannot be told from a real one/i);
  });

  /**
   * A column asking for a date through its sources is a date column whether or
   * not it declared a transform -- and the obituary template's own death-date
   * column is sourced exactly this way.
   */
  it('reads a column whose sources ask for a date as a fact field', async () => {
    const dated: Profile = {
      version: 1,
      pattern: '{name}.pdf',
      columns: [
        {
          path: 'MWDL/deathDate',
          sources: [{ dateNear: ['passed away'] }, { ai: true }],
        },
      ],
    };
    const notes = await fill(dated, { 'MWDL/deathDate': '' });
    expect(notes.join(' ')).toMatch(/cannot be told from a real one/i);
  });
});
