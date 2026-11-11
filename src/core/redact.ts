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
 * All four forms are redacted: literal, `encodeURIComponent`,
 * `URLSearchParams`, and the JSON-string escape.
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
    // The JSON-string form, quotes stripped: the password now travels in a
    // JSON body (passwordAuth.ts), and JSON escapes `"` and `\`, so a server
    // echoing that body back sends a form no URL encoding matches.
    JSON.stringify(secret).slice(1, -1),
  ]);
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
