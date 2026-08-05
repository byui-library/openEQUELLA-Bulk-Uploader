// tests/desktop/ui/extract/state.test.ts
import { describe, it, expect } from 'vitest';
import { initialExtractState, canContinue, type ExtractState } from '../../../../src/desktop/ui/extract/state.js';
import { ATTACHMENT_COLUMN, type Profile } from '../../../../src/core/extract/types.js';

const profile: Profile = {
  version: 1,
  pattern: '{a}.pdf',
  columns: [{ path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true }],
};

function state(over: Partial<ExtractState> = {}): ExtractState {
  return { ...initialExtractState(), ...over };
}

describe('initialExtractState', () => {
  it('starts on the folder step with nothing chosen', () => {
    const s = initialExtractState();
    expect(s.step).toBe('folder');
    expect(s.dir).toBeNull();
    expect(s.profile).toBeNull();
  });
});

describe('canContinue', () => {
  it('is false on the folder step until a folder with supported files is chosen', () => {
    expect(canContinue(state())).toBe(false);
    expect(canContinue(state({ dir: 'C:/x', scan: { supported: [], skipped: [], labels: [], properties: [], starter: { version: 1 as const, pattern: '{part1}.pdf', columns: [{ path: ATTACHMENT_COLUMN, sources: [{ filename: true as const }], locked: true }] } } }))).toBe(false);
  });

  it('is true once the folder holds at least one supported file', () => {
    expect(
      canContinue(state({ dir: 'C:/x', scan: { supported: ['a.pdf'], skipped: [], labels: [], properties: [], starter: { version: 1 as const, pattern: '{part1}.pdf', columns: [{ path: ATTACHMENT_COLUMN, sources: [{ filename: true as const }], locked: true }] } } })),
    ).toBe(true);
  });

  it('is false on the columns step without a profile', () => {
    expect(canContinue(state({ step: 'columns' }))).toBe(false);
  });

  it('is true on the columns step with a profile', () => {
    expect(canContinue(state({ step: 'columns', profile }))).toBe(true);
  });

  it('is false while a run is in flight, on any step', () => {
    expect(canContinue(state({ step: 'columns', profile, busy: true }))).toBe(false);
  });
});
