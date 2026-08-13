// tests/extract/names.test.ts
import { describe, it, expect } from 'vitest';
import { missingFilenameWords } from '../../src/core/extract/names.js';

/**
 * A real file was named "Brandon Lythoe Obituary.pdf" while the document said
 * "Lythgoe" throughout. Since the filename becomes the item's permanent title,
 * that misspelling would have been catalogued.
 */
describe('missingFilenameWords', () => {
  it('reports a word the document does not contain', () => {
    expect(missingFilenameWords('Brandon Lythoe.pdf', 'Brandon Lythgoe passed away', [])).toEqual([
      'Lythoe',
    ]);
  });

  it('reports nothing when every word appears', () => {
    expect(missingFilenameWords('Clyde Williams.pdf', 'Clyde L Williams was born', [])).toEqual([]);
  });

  /**
   * Whole words, not the whole name. "Clyde Williams" never appears
   * contiguously -- the document reads "Clyde L Williams" -- so matching the
   * full name would flag nine rows out of ten.
   */
  it('does not require the words to be adjacent', () => {
    expect(missingFilenameWords('Mary Allred.pdf', 'Mary Ellen Swann Allred', [])).toEqual([]);
  });

  it('ignores case', () => {
    expect(missingFilenameWords('DEAN RITCHIE.pdf', 'dean ritchie was born', [])).toEqual([]);
  });

  it('ignores words the caller asks it to', () => {
    expect(missingFilenameWords('Eric Scott Obituary.pdf', 'Eric Scott died', ['Obituary'])).toEqual(
      [],
    );
  });

  it('ignores those words case-insensitively too', () => {
    expect(missingFilenameWords('Eric Scott OBITUARY.pdf', 'Eric Scott died', ['obituary'])).toEqual(
      [],
    );
  });

  // Initials and stray single characters carry no signal and appear everywhere.
  it('ignores one-character words', () => {
    expect(missingFilenameWords('Clyde L Williams.pdf', 'Clyde Williams', [])).toEqual([]);
  });

  it('drops the extension before checking', () => {
    expect(missingFilenameWords('Eric Scott.pdf', 'Eric Scott died', [])).toEqual([]);
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

  /**
   * WHOLE words, which is what this function has always claimed to do. A
   * substring test called "Ann" present in a document whose only "ann" is
   * inside "Anniversary", so a filename genuinely disagreeing with the
   * document went unreported -- and reporting that disagreement is the entire
   * reason the operator asked for this check.
   */
  it('does not count a word found only inside a longer word', () => {
    expect(
      missingFilenameWords('Ann Palmer.pdf', 'The Palmer family 50th Anniversary', []),
    ).toEqual(['Ann']);
  });

  it('does not count a word found only as the tail of a longer word', () => {
    expect(missingFilenameWords('Ann Palmer.pdf', 'Leann Palmer was born', [])).toEqual(['Ann']);
  });

  it('still matches a word standing on its own next to punctuation', () => {
    expect(missingFilenameWords('Ann Palmer.pdf', 'Palmer, Ann -- 1932-2024', [])).toEqual([]);
  });

  /**
   * A digit is a word character on both sides of this comparison, so a year in
   * the filename must not be satisfied by a longer number in the document.
   */
  it('does not count a number found inside a longer number', () => {
    expect(missingFilenameWords('Class 1957.pdf', 'Class photograph, item 195712', [])).toEqual([
      '1957',
    ]);
  });
});
