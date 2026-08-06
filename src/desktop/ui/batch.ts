// src/desktop/ui/batch.ts
import type { ItemState } from '../../core/types.js';
import type { ColumnReport, PlanReport, RunProgress, RunReport } from '../ipc.js';
import type { ProgressLogEntry } from './screens/progress.js';
import type { InterruptedEntry } from './screens/results.js';

/**
 * The parts of the app's state that belong to ONE batch.
 *
 * Kept here, separate from app.ts, so what a second batch inherits is a
 * testable list rather than a hand-written spread inside a click handler --
 * the failure mode being a field quietly left behind and a stale plan uploaded
 * a second time.
 */
export interface BatchState {
  sheetPath: string | null;
  folderPath: string | null;
  chooseError: string | null;
  readyMessage: string | null;

  reviewLoadingColumns: boolean;
  reviewColumns: ColumnReport[] | null;
  reviewOverrides: Record<string, string>;
  reviewChecking: boolean;
  reviewChecked: boolean;
  reviewPlan: PlanReport | null;
  reviewError: string | null;

  itemState: ItemState;
  typedCount: string;
  uploading: boolean;
  confirmError: string | null;

  progress: RunProgress | null;
  progressLog: ProgressLogEntry[];

  runReport: RunReport | null;
  interruptedEntries: InterruptedEntry[];
  retrying: boolean;
  resultsError: string | null;
}

/**
 * A clean slate for the next spreadsheet.
 *
 * The instance, the signed-in user and the chosen collection are deliberately
 * NOT here: they survive. Only the batch is finished.
 *
 * `itemState` returns to `draft` rather than inheriting the last choice. The
 * target collection has no moderation workflow, so a published item is live
 * immediately with nothing to catch a mistake -- an operator who chose "live"
 * once must choose it again deliberately.
 */
export function clearedForNextBatch(): BatchState {
  return {
    sheetPath: null,
    folderPath: null,
    chooseError: null,
    readyMessage: null,

    reviewLoadingColumns: false,
    reviewColumns: null,
    reviewOverrides: {},
    reviewChecking: false,
    reviewChecked: false,
    reviewPlan: null,
    reviewError: null,

    itemState: 'draft',
    typedCount: '',
    uploading: false,
    confirmError: null,

    progress: null,
    progressLog: [],

    runReport: null,
    interruptedEntries: [],
    retrying: false,
    resultsError: null,
  };
}
