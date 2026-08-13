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
