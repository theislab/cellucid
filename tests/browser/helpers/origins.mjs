// Every absolute address a browser-test spec needs, derived from the one module
// that also decides where the servers bind.
//
// `scripts/browser-test-ports.mjs` honours CELLUCID_BROWSER_TEST_PORT and
// CELLUCID_BROWSER_TEST_SAMPLE_PORT so a second concurrent run can move off a
// taken address. A spec that spelled the port out would defeat that from the
// inside: the page would load from the moved address and then ask for its
// fixtures at the old one, which fails the whole spec rather than the one
// request. So a spec never writes an origin down, it asks for one here.
//
// Most fixture roots travel to the application inside the `exportsBaseUrl`
// query parameter and so arrive percent-encoded. `encodedAppUrl` builds that
// form by encoding the resolved URL, never by editing an already-encoded
// literal — substituting a port inside `http%3A%2F%2F…%3A<port>%2F…` is how the
// surrounding escape sequences get corrupted.
//
// Everything here is a Node-side binding. `page.evaluate`, `addInitScript` and
// `waitForFunction` serialise their callback and run it in the page, where none
// of these names exist — a literal used to survive that boundary because it was
// part of the function source, and an identifier does not. Pass the value in as
// an argument instead:
//
//     await page.evaluate(origin => { … }, APP_ORIGIN);

import { resolveBrowserTestPorts } from '../../../scripts/browser-test-ports.mjs';

const { host, port, samplePort, origin, sampleOrigin } =
  resolveBrowserTestPorts();

/** Loopback host both browser-test servers bind. */
export const APP_HOST = host;

/** Port serving the application under test. */
export const APP_PORT = port;

/** Port serving the same tree with permissive CORS. */
export const SAMPLE_PORT = samplePort;

/** Origin of the application under test, e.g. `http://<host>:<port>`. */
export const APP_ORIGIN = origin;

/** Origin of the permissive-CORS server, e.g. `http://<host>:<samplePort>`. */
export const SAMPLE_ORIGIN = sampleOrigin;

function join(originValue, pathname) {
  if (!pathname.startsWith('/')) {
    throw new TypeError(
      `A browser-test URL path must be absolute; received ${JSON.stringify(pathname)}.`
    );
  }
  return `${originValue}${pathname}`;
}

/**
 * Absolute URL of a path served by the application server.
 *
 * @param {string} pathname A root-relative path, e.g. `/_cellucid/health`.
 * @returns {string}
 */
export function appUrl(pathname) {
  return join(APP_ORIGIN, pathname);
}

/**
 * Absolute URL of a path served by the permissive-CORS sample server.
 *
 * @param {string} pathname A root-relative path.
 * @returns {string}
 */
export function sampleUrl(pathname) {
  return join(SAMPLE_ORIGIN, pathname);
}

/**
 * The same URL as {@link appUrl}, percent-encoded for a query-parameter value.
 *
 * @param {string} pathname A root-relative path.
 * @returns {string}
 */
export function encodedAppUrl(pathname) {
  return encodeURIComponent(appUrl(pathname));
}

/** Root the prepared export fixtures are served from. */
export const EXPORTS_BASE_URL = appUrl('/tests/browser/fixtures/exports/');

/** {@link EXPORTS_BASE_URL} as an `exportsBaseUrl` query-parameter value. */
export const ENCODED_EXPORTS_BASE_URL = encodedAppUrl(
  '/tests/browser/fixtures/exports/'
);
