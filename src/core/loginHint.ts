// src/core/loginHint.ts

/**
 * The instruction `getToken()` gives when it has no usable token.
 *
 * ## Why this is its own module
 *
 * It lives apart from `authCode.ts` so the SANDBOXED RENDERER can import it.
 * `authCode.ts` reaches `node:crypto` for the OAuth `state` value, and anything
 * reachable from `src/desktop/ui/` that touches `node:*` kills the whole module
 * graph and renders a blank window -- silently, with nothing on the terminal
 * (see the renderer purity rule in CLAUDE.md). The renderer needs the string,
 * not the provider.
 *
 * ## Why the default names a CLI command at all
 *
 * `AuthorizationCodeAuth` has no notion of which front end is asking, so it can
 * only ever name one. The CLI's is the default because the CLI is where the
 * flow it describes actually exists; every other surface is expected to
 * substitute its own. `core/preflight.ts` does it for `check` and for MCP;
 * `desktop/ui/errors.ts` does it for the app, where the operator has a button
 * and no terminal.
 *
 * A substring find-and-replace rather than a parallel error-construction path,
 * deliberately: the REASON a token was unusable -- absent, expired, issued for
 * another instance -- is built in one place and must stay built there.
 */
export const DEFAULT_LOGIN_HINT = 'Run:  oeq-upload login';
