import { describe, it, expect } from 'vitest';
import { canContinueReview } from '../../../src/desktop/ui/review.js';

describe('canContinueReview', () => {
  it('is true when there are no columns at all', () => {
    expect(canContinueReview([], {})).toBe(true);
  });

  it('is true when every column is already valid, regardless of overrides', () => {
    const columns = [
      { header: 'title', valid: true },
      { header: 'MWDL/creator', valid: true },
    ];
    expect(canContinueReview(columns, {})).toBe(true);
  });

  it('is false when one column is invalid and has no override', () => {
    const columns = [{ header: 'titel', valid: false }];
    expect(canContinueReview(columns, {})).toBe(false);
  });

  it('is true once the only invalid column has a chosen override', () => {
    const columns = [{ header: 'titel', valid: false }];
    expect(canContinueReview(columns, { titel: 'title' })).toBe(true);
  });

  it('treats a whitespace-only override as unmapped', () => {
    const columns = [{ header: 'titel', valid: false }];
    expect(canContinueReview(columns, { titel: '   ' })).toBe(false);
  });

  it('treats an empty-string override as unmapped', () => {
    const columns = [{ header: 'titel', valid: false }];
    expect(canContinueReview(columns, { titel: '' })).toBe(false);
  });

  it('is false when only some of several invalid columns are mapped', () => {
    const columns = [
      { header: 'titel', valid: false },
      { header: 'creater', valid: false },
    ];
    expect(canContinueReview(columns, { titel: 'title' })).toBe(false);
  });

  it('is true once all invalid columns among a mix of valid and invalid are mapped', () => {
    const columns = [
      { header: 'title', valid: true },
      { header: 'titel', valid: false },
      { header: 'creater', valid: false },
    ];
    expect(
      canContinueReview(columns, { titel: 'title', creater: 'MWDL/creator' }),
    ).toBe(true);
  });

  it('ignores an override keyed to a header that is not in the column list', () => {
    const columns = [{ header: 'titel', valid: false }];
    expect(canContinueReview(columns, { 'unrelated-header': 'title' })).toBe(false);
  });

  it('does not mutate its inputs', () => {
    const columns = [{ header: 'titel', valid: false }];
    const overrides = { titel: 'title' };
    const columnsCopy = JSON.parse(JSON.stringify(columns));
    const overridesCopy = { ...overrides };
    canContinueReview(columns, overrides);
    expect(columns).toEqual(columnsCopy);
    expect(overrides).toEqual(overridesCopy);
  });
});
