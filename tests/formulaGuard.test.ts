// tests/formulaGuard.test.ts
import { describe, it, expect } from 'vitest';
import { guardFormula, unguardFormula } from '../src/core/formulaGuard.js';

/**
 * ## Why a pair, and why the round trip is the real test
 *
 * The extractor writes a spreadsheet the operator opens in Excel, and `plan`
 * reads that same spreadsheet back and uploads what it finds. So an escape
 * applied on the way out MUST be removed on the way in: a one-sided guard
 * would put a stray apostrophe into a permanent catalogue record, which is a
 * worse outcome than the injection it prevents.
 */
describe('guardFormula', () => {
  it.each(['=SUM(A1)', '+1+1', '-2+3', '@SUM(A1)', '\tx', '\rx'])(
    'prefixes a value Excel would execute: %j',
    (value) => {
      expect(guardFormula(value)).toBe(`'${value}`);
    },
  );

  it('leaves ordinary text alone', () => {
    expect(guardFormula('Died 2024-01-09; Born 1935-04-03')).toBe('Died 2024-01-09; Born 1935-04-03');
    expect(guardFormula('')).toBe('');
    expect(guardFormula('Fennel, Marcus')).toBe('Fennel, Marcus');
  });

  /**
   * A value that already starts with an apostrophe has to be escaped too, or
   * the reader cannot tell the guard it added from an apostrophe the document
   * really began with, and would strip a character that was always data.
   */
  it('escapes a leading apostrophe so the reader can tell them apart', () => {
    expect(guardFormula("'=SUM(A1)")).toBe("''=SUM(A1)");
    expect(guardFormula("'quoted'")).toBe("''quoted'");
  });
});

describe('unguardFormula', () => {
  it('removes exactly one guarding apostrophe', () => {
    expect(unguardFormula("'=SUM(A1)")).toBe('=SUM(A1)');
    expect(unguardFormula("''=SUM(A1)")).toBe("'=SUM(A1)");
  });

  it('leaves an apostrophe that is not a guard alone', () => {
    expect(unguardFormula("'tis the season")).toBe("'tis the season");
    expect(unguardFormula('ordinary')).toBe('ordinary');
    expect(unguardFormula('')).toBe('');
  });
});

describe('the round trip', () => {
  // Every shape the two functions distinguish, including the ones that only
  // matter because Excel or a document produced them.
  const values = [
    '',
    'ordinary text',
    '=SUM(A1)',
    '+1+1',
    '-2+3',
    '@SUM(A1)',
    '\tx',
    '\rx',
    "'=SUM(A1)",
    "'tis the season",
    "''already doubled",
    '-- see attached',
    'Died 2024-01-09',
  ];

  it.each(values)('survives guard then unguard unchanged: %j', (value) => {
    expect(unguardFormula(guardFormula(value))).toBe(value);
  });
});
