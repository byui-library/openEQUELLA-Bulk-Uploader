/**
 * Strips Electron's `ipcRenderer.invoke()` error-wrapping so the
 * operator-facing text written for `src/core/errors.ts` (surfaced verbatim
 * by handlers.ts) reaches the user unchanged, instead of prefixed with an
 * IPC channel name and a JS class name.
 *
 * Verified live against the real bridge (a fresh Electron instance, real
 * handlers and a disposable scratch harness covering shapes the real
 * handlers don't produce): EVERY `ipcMain.handle` rejection Electron
 * delivers to the renderer is a NEW `Error` whose `.message` is
 *
 *   `Error invoking remote method '<channel>': ${original}`
 *
 * where `${original}` is the ORIGINAL thrown value's own string form. For a
 * proper `Error`/`OeqError` subclass that is `${name}: ${message}`
 * (`Error.prototype.toString`, and every class in errors.ts sets
 * `this.name = new.target.name`); for a thrown/rejected non-Error value
 * (string, number, plain object) it is just that value's string form, with
 * NO second prefix at all. Confirmed for a wrapped `OeqError`, a wrapped
 * plain `Error`, a thrown string, a thrown number and a rejected string --
 * all five come back `instanceof Error` in the renderer regardless of what
 * was actually thrown.
 *
 * Both prefixes are stripped, each AT MOST ONCE, each anchored to the START
 * of the string being matched -- never a global replace, never scanning for
 * a colon anywhere else in the message:
 *
 *   1. The remote-method wrapper is tried first. If it is not present, the
 *      message never went through `ipcRenderer.invoke()` at all and is
 *      returned completely untouched. This matters: a message that
 *      legitimately starts with something matching the class-name pattern
 *      below (a bare Windows drive letter, e.g. "C:\Users\...") must never
 *      be touched when it did not arrive wrapped -- stripping
 *      unconditionally would eat the "C:" off an unwrapped path.
 *   2. Only once that wrapper is confirmed present is a class-name prefix
 *      stripped, and only ONE such prefix. This is what keeps an internal
 *      colon anywhere else in the message intact -- both an unrelated colon
 *      inside the text ("Row 14 (Sears, Rivka 072126.MP4): POST /api/item
 *      failed") and a drive-letter colon inside a Windows path that is
 *      itself the error's own message (live-verified: wrapping a
 *      `SheetError` built from `${path}: ${message}`, see core/sheet.ts,
 *      produces "...': SheetError: C:\Users\someone\file.xlsx: parse
 *      failed"; stripping the class-name prefix exactly once leaves
 *      "C:\Users\someone\file.xlsx: parse failed" fully intact).
 */
const REMOTE_METHOD_PREFIX = /^Error invoking remote method '[^']*':\s*/;
const CLASS_NAME_PREFIX = /^[A-Za-z_$][\w$]*:\s*/;

export function stripElectronWrapper(raw: string): string {
  const unwrapped = raw.replace(REMOTE_METHOD_PREFIX, '');
  if (unwrapped === raw) {
    // Not wrapped by Electron -- nothing of ours to strip.
    return raw;
  }
  return unwrapped.replace(CLASS_NAME_PREFIX, '');
}

/**
 * Every `window.oeq.*` rejection funnels through this before being shown to
 * the user. Core errors already carry operator-facing text; this is what
 * makes that text reach the screen verbatim instead of behind Electron's
 * wrapper.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return stripElectronWrapper(err.message);
  return String(err);
}
