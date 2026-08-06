import { describe, it, expect } from 'vitest';
import { screenFor } from '../../../../src/desktop/ui/extract/mount.js';
import { initialExtractState } from '../../../../src/desktop/ui/extract/state.js';
import { ATTACHMENT_COLUMN, type Profile } from '../../../../src/core/extract/types.js';

const profile: Profile = {
  version: 1,
  pattern: '{a}.pdf',
  columns: [{ path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true }],
};

describe('screenFor', () => {
  // The columns and save steps must carry a profile, or the guard below
  // correctly sends them back to the folder step. Supplying one here is what
  // makes this test about step mapping rather than about the guard.
  it('maps each step to its screen', () => {
    expect(screenFor({ ...initialExtractState(), step: 'folder' })).toBe('folder');
    expect(screenFor({ ...initialExtractState(), step: 'columns', profile })).toBe('columns');
    expect(screenFor({ ...initialExtractState(), step: 'save', profile })).toBe('save');
  });

  it('falls back to the folder step when a profile is somehow missing on the columns step', () => {
    expect(screenFor({ ...initialExtractState(), step: 'columns', profile: null })).toBe('folder');
  });
});
