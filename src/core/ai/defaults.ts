// src/core/ai/defaults.ts
//
// DELIBERATELY IMPORTS NOTHING. Setup's form reads these, and Setup runs in the
// sandboxed renderer, where a `node:*` or `electron` import anywhere in the
// graph blanks the window with nothing on the terminal. Two numbers living
// beside `runModelPass` would have pulled `fill.ts` -> `rows.ts` and
// `provider.ts` into the renderer's import graph to fetch a pair of integers.
// A leaf module cannot acquire that problem later.

/**
 * What the model numbers default to when nobody has said otherwise.
 *
 * ONE COPY FOR BOTH SURFACES. Setup's form pre-fills from these and the CLI
 * falls back to them when `OEQ_MODEL_BUDGET` / `OEQ_MODEL_CAP` are unset, so an
 * operator who leaves the box alone and one who never sets the variable get the
 * same run. Two sets of defaults would be a quiet way for one batch to cost
 * something different depending on which front end started it.
 *
 * The TIME LIMIT is deliberately not here: `MODEL_TIMEOUT_MS` in provider.ts is
 * argued out at length beside the code that enforces it, and a second copy is
 * the first thing that would rot.
 */
export const MODEL_DEFAULTS = {
  /** Characters from one document. A page of prose is well under it, so most
   *  documents go whole -- which matters, because a death date can be in the
   *  last line (see slice.ts). */
  budget: 8000,
  /** Requests per run -- a ceiling on one batch, not a monthly allowance. */
  cap: 500,
} as const;
