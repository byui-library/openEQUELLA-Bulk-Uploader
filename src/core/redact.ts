/**
 * Removing a secret from text that may echo it back.
 *
 * The OAuth flow puts its client secret in a QUERY STRING on
 * `/oauth/access_token` -- openEQUELLA's API, not a choice made here. Any
 * server that echoes the request line back (a proxy error page, a verbose 400)
 * hands us the secret in its ENCODED form, and that form has to be recognised
 * too. The password used to travel the same way; since openEQUELLA moved
 * `/api/auth/login` to a JSON body (measured 2026-11-11) it travels as a JSON
 * string instead, which is the fourth form below.
 *
 * The trap: those URLs are built with `URLSearchParams`, which serialises
 * application/x-www-form-urlencoded -- NOT the same as `encodeURIComponent`.
 * They disagree on:
 *
 *   - space          `+`     vs `%20`
 *   - `!` `'` `(` `)` `~`    escaped vs left literal
 *
 * Redacting only the `encodeURIComponent` form therefore misses exactly what
 * a real server sends back. `!` is the most common special character in
 * institutional password policies, so `Summer2026!` -- echoed on the wire as
 * `Summer2026%21` -- would pass into an error body verbatim.
 *
 * Redacted: literal, `encodeURIComponent`, `URLSearchParams`, and the
 * JSON-string escape in each spelling a server's serialiser may choose (see
 * `jsonForms`). These are the forms this module KNOWS; an echo in some other
 * encoding is not caught, and nothing here claims otherwise.
 */

/** Every form a secret can take on the wire. Empty for an empty secret. */
export function secretWireForms(secret: string): Set<string> {
  if (!secret) return new Set();
  return new Set([
    secret,
    encodeURIComponent(secret),
    // `p=` prefix then sliced off: the only way to get URLSearchParams' own
    // encoder to serialise a bare value.
    new URLSearchParams({ p: secret }).toString().slice(2),
    ...jsonForms(secret),
  ]);
}

/**
 * The JSON-string forms, quotes stripped. The password travels in a JSON body
 * (passwordAuth.ts), and JSON escapes `"` and `\`, so a server echoing that
 * body back sends a form no URL encoding matches.
 *
 * NOT ONLY `JSON.stringify`'s spelling. openEQUELLA is Java, and serialisers
 * there may also escape `/` as `\/` and non-ASCII as `\uXXXX`, in either hex
 * case. Each choice is independent, so every combination is listed: six
 * strings at most, fewer once the Set collapses the ones a secret without
 * `/` or non-ASCII makes identical.
 */
function jsonForms(secret: string): string[] {
  const base = JSON.stringify(secret).slice(1, -1);
  const unicode = (s: string, upper: boolean) =>
    s.replace(/[\u0080-￿]/g, (c) => {
      const hex = c.charCodeAt(0).toString(16).padStart(4, '0');
      return `\\u${upper ? hex.toUpperCase() : hex}`;
    });
  const forms: string[] = [];
  for (const s of [base, base.replace(/\//g, '\\/')]) {
    forms.push(s, unicode(s, false), unicode(s, true));
  }
  return forms;
}

/**
 * Replace every form of `secret` in `text` with `[REDACTED]`.
 *
 * An empty secret redacts nothing -- guarding this matters, because splitting
 * on an empty string would otherwise shred the text into single characters.
 */
export function redactSecret(text: string, secret: string): string {
  let result = text;
  // Longest first is hygiene, not a security guard. Where one form contains
  // another, replacing the shorter first can leave cosmetic residue around
  // the marker; it cannot leave a recoverable secret, and reversing this sort
  // keeps every test green. Sorted anyway so the output reads cleanly.
  const forms = [...secretWireForms(secret)].sort((a, b) => b.length - a.length);
  for (const form of forms) {
    result = result.split(form).join('[REDACTED]');
  }
  return result;
}
