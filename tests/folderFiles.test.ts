import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orderFiles, clutterReason, listFolderFiles } from '../src/core/folderFiles.js';

describe('orderFiles', () => {
  it('sorts numbers by value, not by character', () => {
    expect(orderFiles(['Issue10.pdf', 'Issue9.pdf', 'Issue1.pdf'])).toEqual([
      'Issue1.pdf',
      'Issue9.pdf',
      'Issue10.pdf',
    ]);
  });

  it('ignores case and punctuation between words', () => {
    expect(orderFiles(['Ledger_No2.pdf', 'ledger-no1.pdf', 'LEDGER No3.pdf'])).toEqual([
      'ledger-no1.pdf',
      'Ledger_No2.pdf',
      'LEDGER No3.pdf',
    ]);
  });

  // PINNED, NOT ENDORSED. A hyphenated year range compares its second half
  // against the next word, and digits sort before letters, so this issue sorts
  // first. The decision is "rename to fix", and the plan shows the order so
  // the operator can see it. This test exists so the order cannot change
  // without someone noticing.
  it('puts a hyphenated year range before the plain year (rename to fix)', () => {
    expect(
      orderFiles(['Gazette_1972_V2_No1.pdf', 'Gazette_1972-73_V2_No3.pdf', 'Gazette_1972_V2_No2.pdf']),
    ).toEqual(['Gazette_1972-73_V2_No3.pdf', 'Gazette_1972_V2_No1.pdf', 'Gazette_1972_V2_No2.pdf']);
  });

  it('keeps an ampersand name in its numeric place', () => {
    expect(orderFiles(['G_No4.pdf', 'G_No2&3.pdf', 'G_No1.pdf'])).toEqual([
      'G_No1.pdf',
      'G_No2&3.pdf',
      'G_No4.pdf',
    ]);
  });

  it('is total: names equal to the collator still get a fixed order', () => {
    const a = orderFiles(['b.pdf', 'B.pdf', 'b_.pdf']);
    const b = orderFiles(['b_.pdf', 'B.pdf', 'b.pdf']);
    expect(a).toEqual(b);
  });

  it('does not mutate its input', () => {
    const input = ['b', 'a'];
    orderFiles(input);
    expect(input).toEqual(['b', 'a']);
  });
});

describe('clutterReason', () => {
  it.each(['Thumbs.db', 'thumbs.DB', 'desktop.ini', '.DS_Store', '.hidden', '~$draft.docx'])(
    'names %s as clutter',
    (name) => expect(clutterReason(name)).not.toBeNull(),
  );
  it('passes an ordinary file', () => expect(clutterReason('Issue1.pdf')).toBeNull());
});

describe('listFolderFiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oeq-ff-'));
  });

  it('lists files in upload order with sizes, skipping clutter by name', async () => {
    await writeFile(join(dir, 'No10.pdf'), 'xx');
    await writeFile(join(dir, 'No9.pdf'), 'x');
    await writeFile(join(dir, 'Thumbs.db'), 'x');
    const r = await listFolderFiles(dir);
    expect(r.refusal).toBeUndefined();
    expect(r.files).toEqual([
      { name: 'No9.pdf', size: 1 },
      { name: 'No10.pdf', size: 2 },
    ]);
    expect(r.skipped).toEqual([{ name: 'Thumbs.db', reason: 'a Windows thumbnail cache' }]);
  });

  it('refuses a folder holding a folder, naming it', async () => {
    await writeFile(join(dir, 'a.pdf'), 'x');
    await mkdir(join(dir, 'extras'));
    const r = await listFolderFiles(dir);
    expect(r.refusal).toMatch(/'extras'/);
  });

  it('skips a hidden folder rather than refusing', async () => {
    await writeFile(join(dir, 'a.pdf'), 'x');
    await mkdir(join(dir, '.sync'));
    const r = await listFolderFiles(dir);
    expect(r.refusal).toBeUndefined();
    expect(r.skipped.map((s) => s.name)).toEqual(['.sync']);
  });

  it('refuses an empty folder', async () => {
    expect((await listFolderFiles(dir)).refusal).toBe('the folder is empty');
  });

  it('refuses a folder holding only skipped files, and says so', async () => {
    await writeFile(join(dir, 'desktop.ini'), 'x');
    expect((await listFolderFiles(dir)).refusal).toBe('the folder holds only skipped files');
  });
});
