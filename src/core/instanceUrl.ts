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
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new OeqError(
      `"${trimmed}" is not a web address. It should look like https://oeq.yourschool.edu`,
    );
  }
  if (url.protocol !== 'https:') {
    throw new OeqError(
      `The address must start with https, not ${url.protocol.replace(':', '')}. ` +
        `Your password is sent as part of the web address when signing in to openEQUELLA, ` +
        `so an unencrypted connection would expose it.`,
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}
