import { endAllSessions } from './session.js';

/**
 * End any openEQUELLA session this process still holds when the app closes.
 *
 * ELECTRON'S QUIT DOES NOT WAIT FOR ASYNC WORK. `window-all-closed` and
 * `before-quit` fire synchronously; an `await` inside either is simply dropped
 * and the process goes away with the request unsent. The documented way to
 * hold the quit open is `event.preventDefault()` in `before-quit` followed by
 * a later `app.quit()`, which is what this does.
 *
 * AND IT IS BOUNDED. A slow or unreachable server must not trap an operator in
 * a window they are trying to close -- an app that will not close is far worse
 * than a session openEQUELLA will time out on its own. The logout races a
 * short timer and the quit proceeds either way, whether the logout finished,
 * failed, or is still hanging.
 *
 * `app` is a parameter, structurally typed, so the whole sequence is testable
 * without booting Electron and so this module imports nothing from `electron`.
 */
export interface QuitApp {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
}

/**
 * How long the quit is held open for the logout.
 *
 * Short on purpose. This is time an operator spends staring at a window that
 * will not close, in exchange for a session that would otherwise expire by
 * itself; the trade is only worth making for a server that answers promptly.
 */
export const LOGOUT_ON_QUIT_TIMEOUT_MS = 2000;

/**
 * `endSessions` is typed by what this hook DOES with the answer, which is
 * nothing. `endAllSessions` reports how many sessions it ended and how many
 * the server never confirmed (session.ts's SessionEndReport), and the sign-out
 * handler passes that to the renderer so the operator can be told -- but there
 * is nobody left to tell here. The window is closing. Naming the report type
 * would only invite a later reader to think this could act on it.
 */
export function registerQuitLogout(
  app: QuitApp,
  deps: { endSessions?: () => Promise<unknown>; timeoutMs?: number } = {},
): void {
  const endSessions = deps.endSessions ?? endAllSessions;
  const timeoutMs = deps.timeoutMs ?? LOGOUT_ON_QUIT_TIMEOUT_MS;
  /**
   * `app.quit()` re-runs the quit sequence, so this listener sees
   * `before-quit` a SECOND time. Intercepting that one too would cancel the
   * very quit it just asked for, and the app would never close.
   */
  let ending = false;

  app.on('before-quit', (event) => {
    if (ending) return;
    ending = true;
    event.preventDefault();
    void bounded(endSessions, timeoutMs).then(() => app.quit());
  });
}

/**
 * Run `work`, and resolve either when it settles or when `ms` elapses,
 * whichever comes first. Never rejects: every outcome here means the same
 * thing to the caller -- stop waiting and quit.
 *
 * `work` is a FUNCTION, not a promise, so a synchronous throw inside it is
 * caught here too rather than escaping past the `.then()` that would otherwise
 * schedule the quit.
 */
function bounded(work: () => Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Nothing should be kept alive purely by this timer -- least of all a
    // process that has been asked to exit.
    timer.unref?.();
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    Promise.resolve()
      .then(work)
      .then(done, done);
  });
}
