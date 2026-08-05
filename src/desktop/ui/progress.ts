/**
 * `done`/`total` -> a 0-100 percentage for the Progress screen's bar.
 *
 * `total <= 0` (a degenerate manifest, or a progress event that could in
 * principle arrive before the first entry) must not divide by zero or
 * produce NaN/Infinity -- reported as 0%, not a crashed render or a bar
 * that reads "stuck at 100%" before anything has actually happened.
 */
export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  const pct = Math.round((done / total) * 100);
  return Math.max(0, Math.min(100, pct));
}
