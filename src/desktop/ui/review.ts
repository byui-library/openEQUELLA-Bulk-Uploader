/**
 * A column's identity for the Review screen's Continue gate: its header text
 * as reported by `validate()` against the ORIGINAL spreadsheet, and whether
 * that header is a valid schema xpath. `ColumnReport` (ipc.ts) satisfies this
 * shape structurally, so the real IPC type can be passed straight in.
 *
 * This identity is safe to key `overrides` on precisely because it comes
 * from `validate()`, not from `plan()`'s response: `validate()` always
 * reports against the sheet's true original headers, so it never shifts
 * underneath the UI the way a post-override `plan()` report's headers would
 * (buildManifest renames headers in its output to whatever they were
 * overridden to).
 */
export interface ReviewColumnStatus {
  header: string;
  valid: boolean;
}

/**
 * Continue is disabled while any column is invalid AND has no override
 * chosen for it (spec: "Continue disabled while any column is invalid and
 * unmapped"). A column that's invalid but DOES have a non-blank override
 * staged is allowed through this gate -- the click itself re-plans with that
 * override (see handleReviewContinue in app.ts) and `buildManifest` throws
 * if the guess was actually wrong, so a bad override can get this far but
 * can never result in an upload; it just produces a clear error and sends
 * the user back to fix it.
 */
export function canContinueReview(
  columns: readonly ReviewColumnStatus[],
  overrides: Readonly<Record<string, string>>,
): boolean {
  return columns.every((c) => c.valid || Boolean(overrides[c.header]?.trim()));
}
