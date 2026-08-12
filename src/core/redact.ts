/**
 * Removing a secret from text that may echo it back.
 *
 * Both auth flows in this tool put their secret in a QUERY STRING -- the
 * password on `/api/auth/login`, the client secret on `/oauth/access_token`.
 * That is openEQUELLA's API, not a choice made here. It means any server that
 * echoes the request line back (a proxy error page, a verbose 400) hands us
 * the secret in its ENCODED form, and that form has to be recognised too.
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
 * All three forms are redacted: literal, `encodeURIComponent`, and
 * `URLSearchParams`.
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
  // Longest first, so a form that contains another (e.g. the literal inside a
  // partially-escaped variant) cannot be half-replaced and left unmatched.
  const forms = [...secretWireForms(secret)].sort((a, b) => b.length - a.length);
  for (const form of forms) {
    result = result.split(form).join('[REDACTED]');
  }
  return result;
}
