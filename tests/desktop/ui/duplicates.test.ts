import { describe, it, expect } from 'vitest';
import { rowsToSkip } from '../../../src/desktop/ui/duplicates.js';
import type { DuplicateFinding, DuplicateTier } from '../../../src/core/duplicates.js';

function finding(rowNumber: number, tier: DuplicateTier): DuplicateFinding {
  return {
    rowNumber,
    fileName: `row-${rowNumber}.mp4`,
    tier,
    detail: 'because',
    existing: [],
  };
}

describe('rowsToSkip', () => {
  it('skips a near-certain row the operator left alone', () => {
    expect(rowsToSkip([finding(4, 'near-certain')], {})).toEqual([4]);
  });

  // A title match alone is ordinary; dropping a real item over one is worse
  // than a visible duplicate.
  it('does not skip a possible row the operator left alone', () => {
    expect(rowsToSkip([finding(4, 'possible')], {})).toEqual([]);
  });

  it('does not skip an unchecked row the operator left alone', () => {
    expect(
      rowsToSkip([finding(4, 'not-checkable'), finding(5, 'could-not-check')], {}),
    ).toEqual([]);
  });

  it('lets an explicit upload override a near-certain default', () => {
    expect(rowsToSkip([finding(4, 'near-certain')], { 4: 'upload' })).toEqual([]);
  });

  it('lets an explicit skip override a possible default', () => {
    expect(rowsToSkip([finding(4, 'possible')], { 4: 'skip' })).toEqual([4]);
  });

  // The manifest is keyed by row number too, so a choice with no finding
  // behind it must never reach it.
  it('ignores a choice for a row that was never flagged', () => {
    expect(rowsToSkip([finding(4, 'possible')], { 9: 'skip' })).toEqual([]);
  });

  it('returns nothing when nothing was flagged', () => {
    expect(rowsToSkip([], { 9: 'skip' })).toEqual([]);
  });

  it("returns the findings' own row numbers, not their positions", () => {
    const found = [finding(11, 'near-certain'), finding(2, 'possible'), finding(37, 'near-certain')];
    expect(rowsToSkip(found, {})).toEqual([11, 37]);
  });
});
