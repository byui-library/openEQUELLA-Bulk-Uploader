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
 * - **Rows the pass skipped** (nothing to fill) count at the same pace: the
 *   time between two row positions is divided by how many rows it covered.
 */
export interface Pace {
  /** Row `row` (1-based) began at `now`. Repeats for the same row are ignored. */
  started(row: number, now: number): void;
  /** Milliseconds left, counting the current row, or null when too little is known. */
  remainingMs(row: number, rows: number): number | null;
  /** Forget everything: a new run is starting. */
  reset(): void;
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
      if (lastRow !== null) {
        perRow.push((now - lastAt) / (row - lastRow));
        if (perRow.length > RECENT) perRow = perRow.slice(-RECENT);
      }
      lastRow = row;
      lastAt = now;
    },
    remainingMs(row, rows) {
      if (perRow.length < ENOUGH) return null;
      const sorted = [...perRow].sort((a, b) => a - b);
      const middle = sorted[Math.floor(sorted.length / 2)]!;
      return middle * Math.max(0, rows - row + 1);
    },
    reset() {
      lastRow = null;
      lastAt = 0;
      perRow = [];
    },
  };
}

/** "about 6 minutes left": whole minutes, because the estimate has no finer precision. */
export function describeRemaining(ms: number): string {
  if (ms < 60_000) return 'less than a minute left';
  const minutes = Math.round(ms / 60_000);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'} left`;
}
