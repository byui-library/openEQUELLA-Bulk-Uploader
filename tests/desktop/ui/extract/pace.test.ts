import { describe, it, expect } from 'vitest';
import { createPace, describeRemaining } from '../../../../src/desktop/ui/extract/pace.js';

const MINUTE = 60_000;

describe('createPace', () => {
  it('gives no estimate until two rows have finished', () => {
    const pace = createPace();
    pace.started(1, 0);
    expect(pace.remainingMs(1, 10)).toBeNull();
    pace.started(2, MINUTE);
    expect(pace.remainingMs(2, 10)).toBeNull();
    pace.started(3, 2 * MINUTE);
    expect(pace.remainingMs(3, 10)).toBe(8 * MINUTE);
  });

  // Code review, 2026-11-17: a stretch of skipped rows divided one slow
  // request across them, and promised "less than a minute" too early.
  it('does not time a stretch of skipped rows, so it never errs short', () => {
    const pace = createPace();
    pace.started(1, 0);
    pace.started(2, 2 * MINUTE);
    pace.started(3, 4 * MINUTE);
    pace.started(30, 5 * MINUTE); // 26 skips in a minute: not a pace
    expect(pace.remainingMs(30, 38)).toBe(9 * 2 * MINUTE);
  });

  it('takes the true middle of an even number: not simply the slower', () => {
    const pace = createPace();
    pace.started(1, 0);
    pace.started(2, MINUTE);
    pace.started(3, 4 * MINUTE);
    // One minute and three minutes: two a row, eight rows left.
    expect(pace.remainingMs(3, 10)).toBe(8 * 2 * MINUTE);
  });

  it('is not thrown by one slow row: it takes the middle of the recent ones', () => {
    const pace = createPace();
    let t = 0;
    pace.started(1, t);
    for (const [row, took] of [[2, 1], [3, 1], [4, 9], [5, 1], [6, 1]] as const) {
      t += took * MINUTE;
      pace.started(row, t);
    }
    expect(pace.remainingMs(6, 10)).toBe(5 * MINUTE);
  });

  it('starts again when a new run begins', () => {
    const pace = createPace();
    pace.started(1, 0);
    pace.started(2, MINUTE);
    pace.started(3, 2 * MINUTE);
    pace.reset();
    pace.started(1, 10 * MINUTE);
    expect(pace.remainingMs(1, 10)).toBeNull();
  });
});

describe('describeRemaining', () => {
  it('rounds to whole minutes, and says so plainly under one', () => {
    expect(describeRemaining(30_000)).toBe('less than a minute left');
    expect(describeRemaining(MINUTE)).toBe('about 1 minute left');
    expect(describeRemaining(6.4 * MINUTE)).toBe('about 6 minutes left');
  });
});
