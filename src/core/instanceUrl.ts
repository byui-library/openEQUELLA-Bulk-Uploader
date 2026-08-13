import { OeqError } from './errors.js';

/**
 * Validate and normalise an openEQUELLA address typed by an operator.
 *
 * HTTPS is required, not preferred. openEQUELLA's `/api/auth/login` takes the
 * password as a query parameter (confirmed in schema/swagger.json), so over
 * http it would travel in clear text in the request line. There is no
 * degraded mode worth offering, so this throws rather than warning.
 */
export function normaliseInstanceUrl(raw: string): string {
  const trimmed = raw.trim();
  // Blank is the empty-form case, not a malformed address. Quoting nothing
  // back at the operator ('"" is not a web address') tells them nothing.
  if (!trimmed) {
    throw new OeqError(
      'Enter the address of your openEQUELLA site, for example https://oeq.yourschool.edu',
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new OeqError(
      `"${trimmed}" is not a web address. It should look like https://oeq.yourschool.edu`,
    );
  }
  if (url.protocol === 'http:') {
    // The security explanation belongs to http and only http -- this is a
    // real downgrade the operator might otherwise argue with.
    throw new OeqError(
      'The address must start with https, not http. ' +
        'Your password is sent as part of the web address when signing in to openEQUELLA, ' +
        'so an unencrypted connection would expose it.',
    );
  }
  if (url.protocol !== 'https:') {
    // Anything else is a typo ('htps://...' parses happily), so a lecture
    // about password exposure would just be confusing noise.
    throw new OeqError(`The address must start with https:// -- "${trimmed}" does not.`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/**
 * Build the URL of an endpoint on an instance, KEEPING any path prefix the
 * instance's base URL carries.
 *
 * WHY THIS EXISTS, AND WHY NOT `new URL(path, base)`. That form silently
 * discards the prefix, because an absolute path replaces the base's path
 * outright:
 *
 *   new URL('/api/auth/login', 'https://host/oeq')
 *     -> https://host/api/auth/login          the /oeq is gone
 *
 * openEQUELLA is very commonly deployed under a prefix -- `/equella` is the
 * vendor's own default in many installs -- so at such a site EVERY request
 * built that way goes somewhere that does not exist, and the failure looks
 * like "the address is wrong" rather than "the tool is wrong".
 * `normaliseInstanceUrl` above goes to deliberate trouble to preserve a
 * prefix; ten call sites across auth.ts, authCode.ts, passwordAuth.ts and
 * client.ts then threw it away again one line later.
 *
 * The fix is to make the path RELATIVE and the base directory-like, so
 * resolution appends instead of replacing:
 *
 *   https://host       + /api/auth/login  -> https://host/api/auth/login
 *   https://host/oeq   + /api/auth/login  -> https://host/oeq/api/auth/login
 *   https://host/oeq/  + api/auth/login   -> https://host/oeq/api/auth/login
 *
 * A query string already baked into `path` survives -- `client.ts` funnels
 * every API call through here with one (`/api/collection?full=true&...`), so
 * dropping it would break search and discovery at a prefixed site only.
 *
 * Returns a `URL` rather than a string because most callers go on to set
 * search params on it, and callers that must NOT expose those (the
 * `safeEndpoint()` methods in auth.ts and passwordAuth.ts, which build a
 * string for error messages that would otherwise carry a password or a client
 * secret) read `origin` and `pathname` off it explicitly.
 *
 * This is the third URL-shaped assumption to cost this project real time --
 * after `/oauth/authorise` vs `/authorize`, and the staging area being a
 * `?file=` query parameter rather than a body field. Build instance URLs
 * here, not inline.
 */
export function instanceEndpoint(baseUrl: string, path: string): URL {
  // Trailing slashes are collapsed to exactly one rather than merely tested
  // for: a base of `https://host/oeq//` is directory-like already, so
  // appending would otherwise yield `/oeq//api/...`. Leading slashes come off
  // `path` for the reason the whole function exists -- one is enough to make
  // resolution absolute.
  return new URL(path.replace(/^\/+/, ''), `${baseUrl.replace(/\/+$/, '')}/`);
}

/**
 * The stable key an instance is stored under (desktop/secrets.ts).
 *
 * DERIVED from the address rather than typed, and derived through
 * `normaliseInstanceUrl` specifically, so that two spellings of one site --
 * `https://oeq.example.edu/` typed today and `https://oeq.example.edu` typed
 * next month -- resolve to a single entry. Keying off the raw string instead
 * would silently produce two entries for one site: the operator would be
 * asked for a client secret they had already supplied, and the two copies
 * would then drift, with no way to tell from the UI which one a sign-in
 * actually used.
 *
 * It throws for the same reasons `normaliseInstanceUrl` does. An address that
 * cannot be normalised has no key, and inventing one for it would store
 * credentials under something no later lookup could reproduce.
 */
export function instanceKey(rawUrl: string): string {
  return normaliseInstanceUrl(rawUrl);
}
