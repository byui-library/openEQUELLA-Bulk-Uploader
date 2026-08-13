import { describe, it, expect, vi } from 'vitest';
import { registerQuitLogout } from '../../src/desktop/quit.js';

/**
 * ELECTRON'S QUIT DOES NOT WAIT.
 *
 * `before-quit` (and `window-all-closed`) fire synchronously; an `await` in
 * the listener is simply dropped and the process goes away mid-request. The
 * documented way to hold the quit open is `event.preventDefault()` plus a
 * later `app.quit()`, which is what this module does -- and the reason it is
 * a module at all, taking `app` as a parameter, is so the whole sequence can
 * be exercised without booting Electron.
 *
 * THE HOLD MUST BE BOUNDED. An app that will not close is far worse than a
 * session that times out on its own, so an unreachable or slow server has to
 * lose the race and the quit proceeds regardless.
 */
function fakeApp() {
  const listeners: ((event: { preventDefault(): void }) => void)[] = [];
  const preventDefault = vi.fn();
  const quit = vi.fn(() => {
    // The real `app.quit()` re-runs the quit sequence, so `before-quit` fires
    // again. Reproduced here because a hook that intercepts its own quit
    // would never let the app close.
    emit();
  });
  function emit(): void {
    for (const l of [...listeners]) l({ preventDefault });
  }
  return {
    app: {
      on(event: string, listener: (e: { preventDefault(): void }) => void) {
        if (event === 'before-quit') listeners.push(listener);
      },
      quit,
    },
    emit,
    preventDefault,
    quit,
  };
}

/** Lets the microtask queue drain so the hook's own async work can finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('registerQuitLogout', () => {
  it('holds the quit open, ends the sessions, then quits', async () => {
    const { app, emit, preventDefault, quit } = fakeApp();
    const endSessions = vi.fn(async () => 1);
    registerQuitLogout(app, { endSessions, timeoutMs: 1000 });

    emit();
    expect(preventDefault).toHaveBeenCalledTimes(1);
    await settle();

    expect(endSessions).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  /**
   * The whole point of preventDefault here. Without it Electron tears the
   * process down before the PUT leaves, so the session the operator thinks
   * they closed the app on is still live on the server.
   */
  it('does not quit before the logout has finished', async () => {
    const { app, emit, quit } = fakeApp();
    let release = () => {};
    const endSessions = vi.fn(
      () => new Promise<number>((resolve) => (release = () => resolve(1))),
    );
    registerQuitLogout(app, { endSessions, timeoutMs: 1000 });

    emit();
    await settle();
    expect(quit).not.toHaveBeenCalled();

    release();
    await settle();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  /**
   * A slow or unreachable server must not trap an operator in a window they
   * are trying to close. The logout loses the race and the app closes anyway.
   */
  it('quits anyway when the logout never finishes', async () => {
    const { app, emit, quit } = fakeApp();
    registerQuitLogout(app, {
      endSessions: () => new Promise<number>(() => {}),
      timeoutMs: 5,
    });

    emit();
    await new Promise((r) => setTimeout(r, 30));
    expect(quit).toHaveBeenCalledTimes(1);
  });

  // logout() itself never throws (core/passwordAuth.ts), but the registry
  // reports failures rather than swallowing them, and a rejection escaping
  // here would leave the app open with nothing left to finish.
  it('quits anyway when the logout fails', async () => {
    const { app, emit, quit } = fakeApp();
    registerQuitLogout(app, {
      endSessions: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      timeoutMs: 1000,
    });

    emit();
    await settle();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  // A synchronous throw is not a rejected promise, and would escape a plain
  // `.catch()` on the call's result.
  it('quits anyway when ending the sessions throws synchronously', async () => {
    const { app, emit, quit } = fakeApp();
    registerQuitLogout(app, {
      endSessions: () => {
        throw new Error('thrown before any promise existed');
      },
      timeoutMs: 1000,
    });

    emit();
    await settle();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  /**
   * THE HANG THIS COULD OTHERWISE BE. `app.quit()` re-runs the quit sequence,
   * so the listener sees `before-quit` a second time; intercepting that one
   * too would cancel the very quit it just asked for, forever.
   */
  it('lets its own quit through instead of intercepting it again', async () => {
    const { app, emit, preventDefault, quit } = fakeApp();
    const endSessions = vi.fn(async () => 1);
    registerQuitLogout(app, { endSessions, timeoutMs: 1000 });

    emit();
    await settle();

    expect(quit).toHaveBeenCalledTimes(1);
    // The fake app re-emits from quit(); the second pass must not be held.
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(endSessions).toHaveBeenCalledTimes(1);
  });
});
