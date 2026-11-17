// src/desktop/ui/extract/pace.ts
//
// IMPORTS NOTHING. Renderer code: a `node:` import anywhere in this graph
// blanks the window (CLAUDE.md).

/**
 * How long the model pass has left, from its OWN pace -- never guessed in
 * advance. A local model's speed depends on the machine and the model loaded,
 * so an estimate before anything has run would be a number with nothing
 * behind it.
 *
 * FED BY THE EVENTS THAT ALREADY ARRIVE: each row's first "asking" event
 * carries its position. No timers, no polling, no extra requests -- one
 * timestamp per row.
 *
 * - **Nothing until two rows have finished.** One duration is an anecdote.
 * - **The middle of the last few, not the mean,** so one slow volume -- a
 *   long issue, a model warming up -- does not swing the estimate.
 * - **Only a row followed directly by the next is timed.** A row with nothing
 *   to fill sends no event, so the gap from row 5 to row 31 holds one slow
 *   request and 25 instant skips; dividing it out recorded a near-zero pace
 *   and promised "less than a minute" with eight slow rows to go. Skipped
 *   stretches are not timed at all, and the rows left are all counted as
 *   asking -- so the estimate errs long, never short.
 */
export interface Pace {
  /** Row `row` (1-based) began at `now`. Repeats for the same row are ignored. */
  started(row: number, now: number): void;
  /** Milliseconds left, counting the current row, or null when too little is known. */
  remainingMs(row: number, rows: number): number | null;
}

/** How many recent rows the estimate looks at. */
const RECENT = 5;

/** Rows that must have finished before an estimate is given. */
const ENOUGH = 2;

export function createPace(): Pace {
  let lastRow: number | null = null;
  let lastAt = 0;
  let perRow: number[] = [];

  return {
    started(row, now) {
      if (lastRow !== null && row <= lastRow) return;
      if (lastRow !== null && row === lastRow + 1) {
        perRow.push(now - lastAt);
        if (perRow.length > RECENT) perRow = perRow.slice(-RECENT);
      }
      lastRow = row;
      lastAt = now;
    },
    remainingMs(row, rows) {
      if (perRow.length < ENOUGH) return null;
      // The true median: with an even count, the mean of the two middle values
      // -- with two samples, not simply the slower of them.
      const sorted = [...perRow].sort((a, b) => a - b);
      const half = Math.floor(sorted.length / 2);
      const middle = sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
      return middle * Math.max(0, rows - row + 1);
    },
  };
}

/** "about 6 minutes left": whole minutes, because the estimate has no finer precision. */
export function describeRemaining(ms: number): string {
  if (ms < 60_000) return 'less than a minute left';
  const minutes = Math.round(ms / 60_000);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'} left`;
}
