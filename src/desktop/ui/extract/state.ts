// src/desktop/ui/extract/state.ts
import type { ExtractScan } from '../../ipc.js';
import type { Column, ExtractedRow, Profile } from '../../../core/extract/types.js';

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
  /** Templates shipped with the app, for the "start from" choice. Empty if none are bundled. */
  templates: { id: string; label: string }[];
  /** The selected template's id, or '' for the generic scanned starter. */
  templateId: string;
  /** True while an IPC call is in flight. Disables the controls rather than stacking calls. */
  busy: boolean;
  error: string | null;
  /** Set once the spreadsheet has been written. */
  savedPath: string | null;
  /** Rows actually written by the run, which can be fewer than the folder scan found. */
  savedWritten: number;
  savedFlagged: number;
  /** True while the Add-column picker is open. */
  adding: boolean;
  /** The picker's search box. */
  addQuery: string;
  /** The most recently removed column, kept so it can be put back where it was. */
  removed: { column: Column; index: number } | null;
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
    templates: [],
    templateId: '',
    busy: false,
    error: null,
    savedPath: null,
    savedWritten: 0,
    savedFlagged: 0,
    adding: false,
    addQuery: '',
    removed: null,
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
