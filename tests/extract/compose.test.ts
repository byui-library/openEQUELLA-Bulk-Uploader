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
    expect(composeValue('Died {death}', { death: 'January 9, 2024' })).toBe('Died January 9, 2024');
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

  /**
   * A placeholder inside an optional group cannot keep a clause alive on its
   * own. Without this, a missing required value left orphaned punctuation:
   * "Died : Rigby".
   */
  it('drops a clause whose required placeholder is empty, group or no group', () => {
    expect(composeValue('Died {death}[: {place}]', { death: '', place: 'Rigby' })).toBe('');
  });

  it('keeps the clause when the required placeholder is filled and the group is not', () => {
    expect(composeValue('Died {death}[: {place}]', { death: 'A', place: '' })).toBe('Died A');
  });

  /**
   * A clause whose only placeholders sat inside optional groups is empty when
   * those are, or "Born [{b}]" survives as the dangling label "Born".
   */
  it('drops a clause left as a bare label by a dropped group', () => {
    expect(composeValue('Died {d}; Born [{b}]', { d: 'A', b: '' })).toBe('Died A');
  });

  it('keeps such a clause when the group is filled', () => {
    expect(composeValue('Died {d}; Born [{b}]', { d: 'A', b: 'B' })).toBe('Died A; Born B');
  });
});
