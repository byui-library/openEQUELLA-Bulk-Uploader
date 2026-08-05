import { describe, it, expect } from 'vitest';
import { progressPercent } from '../../../src/desktop/ui/progress.js';

describe('progressPercent', () => {
  it('is 0 when total is 0, regardless of done', () => {
    expect(progressPercent(0, 0)).toBe(0);
    expect(progressPercent(5, 0)).toBe(0);
  });

  it('is 0 at the very start', () => {
    expect(progressPercent(0, 37)).toBe(0);
  });

  it('is 100 once done reaches total', () => {
    expect(progressPercent(37, 37)).toBe(100);
  });

  it('rounds a fractional percentage', () => {
    expect(progressPercent(5, 37)).toBe(14); // 13.51...% -> 14
  });

  it('never exceeds 100 even if done overshoots total', () => {
    expect(progressPercent(40, 37)).toBe(100);
  });

  it('is never negative for a negative total', () => {
    expect(progressPercent(3, -1)).toBe(0);
  });
});
