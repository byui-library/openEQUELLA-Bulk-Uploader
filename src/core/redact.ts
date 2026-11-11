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
 * Redacted: the literal secret, its two URL encodings, and ANY JSON-string
 * spelling of it (see `jsonSpelling`). An echo in some other encoding --
 * base64, HTML entities -- is not caught, and nothing here claims otherwise.
 */

/**
 * The fixed forms a secret takes on the wire: literal, `encodeURIComponent`,
 * `URLSearchParams`, and `JSON.stringify`'s spelling. Empty for an empty
 * secret. `redactSecret` ALSO matches every other JSON spelling, which cannot
 * be listed -- see `jsonSpelling`.
 */
export function secretWireForms(secret: string): Set<string> {
  if (!secret) return new Set();
  return new Set([
    secret,
    encodeURIComponent(secret),
    // `p=` prefix then sliced off: the only way to get URLSearchParams' own
    // encoder to serialise a bare value.
    new URLSearchParams({ p: secret }).toString().slice(2),
    JSON.stringify(secret).slice(1, -1),
  ]);
}

/** JSON's two-character escapes. `\/` is optional in JSON and some use it. */
const SHORT_ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '/': '\\/',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A pattern matching EVERY JSON-string spelling of `secret`, in any mix.
 *
 * The password travels in a JSON body (passwordAuth.ts), and a server echoing
 * that body back serialises it its own way. A list of spellings cannot keep
 * up: openEQUELLA is Java, Jackson writes `\u001F` where JavaScript writes
 * `\u001f`, Gson escapes `<`, `>`, `&`, `=` and `'` as `<` and the rest by
 * default, and any serialiser may escape `/` or any other character it likes.
 * So each UTF-16 code unit of the secret matches itself, its `\uXXXX` escape
 * in either hex case, or its short escape where JSON has one.
 *
 * Hex digits are case-insensitive ONE AT A TIME (`[dD]`), not via the `i`
 * flag, which would also make the secret's own letters match their other case.
 */
function jsonSpelling(secret: string): RegExp {
  let source = '';
  for (let i = 0; i < secret.length; i++) {
    const unit = secret[i]!;
    const hex = secret.charCodeAt(i).toString(16).padStart(4, '0');
    const unicode =
      '\\\\u' + [...hex].map((d) => (/[a-f]/.test(d) ? `[${d}${d.toUpperCase()}]` : d)).join('');
    const alternatives = [reEscape(unit), unicode];
    const short = SHORT_ESCAPES[unit];
    if (short) alternatives.push(reEscape(short));
    source += `(?:${alternatives.join('|')})`;
  }
  return new RegExp(source, 'g');
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
  if (secret) result = result.replace(jsonSpelling(secret), '[REDACTED]');
  return result;
}
