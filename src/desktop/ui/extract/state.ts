// src/desktop/ui/extract/state.ts
import type { ExtractScan } from '../../ipc.js';
import type { ExtractedRow, Profile } from '../../../core/extract/types.js';

export type ExtractStep = 'folder' | 'columns' | 'save';

export interface ExtractState {
  step: ExtractStep;
  dir: string | null;
  scan: ExtractScan | null;
  profile: Profile | null;
  /** Where the profile came from, shown so the operator knows what they are editing. */
  profilePath: string | null;
  preview: ExtractedRow[];
  /** Every valid schema xpath, for the Add-column picker. */
  schemaPaths: string[];
  /** True while an IPC call is in flight. Disables the controls rather than stacking calls. */
  busy: boolean;
  error: string | null;
  /** Set once the spreadsheet has been written. */
  savedPath: string | null;
  savedFlagged: number;
  /** True while the Add-column picker is open. */
  adding: boolean;
  /** The picker's search box. */
  addQuery: string;
}

export function initialExtractState(): ExtractState {
  return {
    step: 'folder',
    dir: null,
    scan: null,
    profile: null,
    profilePath: null,
    preview: [],
    schemaPaths: [],
    busy: false,
    error: null,
    savedPath: null,
    savedFlagged: 0,
    adding: false,
    addQuery: '',
  };
}

/**
 * Whether the current step's Continue is enabled. Kept here rather than in the
 * screens so the rule is testable without a DOM, matching how ui/confirm.ts
 * holds the upload gate for the Confirm screen.
 */
export function canContinue(state: ExtractState): boolean {
  if (state.busy) return false;
  switch (state.step) {
    case 'folder':
      return state.dir !== null && (state.scan?.supported.length ?? 0) > 0;
    case 'columns':
      return state.profile !== null;
    case 'save':
      return state.savedPath === null;
  }
}
