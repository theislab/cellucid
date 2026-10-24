/**
 * The access of remote files behind a sign-in or an expiring link, owned by
 * the page.
 *
 * A provider that reads a file with a bearer token (Google Drive) or through
 * a pre-authenticated URL that expires (OneDrive) registers the file's
 * access here: `target({refresh})` answers the URL and headers the next
 * request goes to, `{url, headers?, expiresAt?}`. The file's resource then
 * names only `{provider, ref, stale?}` (`stale`: statuses beyond 401 that
 * mean the target went stale), which crosses to the AnnData reader worker
 * like any plain record. The worker asks for a target when it needs one
 * (`{event: 'source-access'}`, answered by the reader client from
 * `resolveSourceAccess`), holds it in memory only, and shares it across its
 * parallel reads (`httpByteSource`'s `access`).
 *
 * Tokens and pre-authenticated URLs stay in memory here and in the worker:
 * never in a resource, a session, a URL, the Transfers log, the console or an
 * error.
 *
 * @module data/sources/access
 */

import { createOpaqueId } from '../../app/utils/opaque-id.js';

/** @type {Map<string, {provider: string, target: Function}>} */
const registrations = new Map();
const revokeListeners = new Set();

/**
 * Register one file's access; the descriptor goes into its resource.
 *
 * @param {{provider: string, target: (request: {refresh: boolean}) => Promise<{url: string,
 *   headers?: Object<string, string>, expiresAt?: number}>, stale?: number[]}} options
 * @returns {Readonly<{provider: string, ref: string, stale: number[]}>}
 */
export function registerSourceAccess({ provider, target, stale = [] }) {
  if (typeof provider !== 'string' || provider === '') {
    throw new TypeError('A source access names its provider.');
  }
  if (typeof target !== 'function') throw new TypeError('A source access needs target({refresh}).');
  if (!Array.isArray(stale) || stale.some(status => !Number.isInteger(status))) {
    throw new TypeError('A source access stale list holds HTTP statuses.');
  }
  const ref = createOpaqueId();
  registrations.set(ref, { provider, target });
  return Object.freeze({ provider, ref, stale: Object.freeze([...stale]) });
}

/**
 * The target one registered access answers now.
 *
 * @param {string} ref
 * @param {{refresh?: boolean}} [options]
 * @returns {Promise<{url: string, headers?: Object<string, string>, expiresAt?: number}>}
 */
export async function resolveSourceAccess(ref, { refresh = false } = {}) {
  const registration = registrations.get(ref);
  if (registration === undefined) {
    throw new Error('This file\'s access is no longer held by the page; open it again.');
  }
  return registration.target({ refresh: refresh === true });
}

/**
 * Drop every target a reader holds for `provider` (a sign-out): the next
 * read asks the page again.
 *
 * @param {string} provider
 */
export function revokeSourceAccess(provider) {
  for (const [ref, registration] of registrations) {
    if (registration.provider !== provider) continue;
    for (const listener of revokeListeners) listener(ref);
  }
}

/**
 * Be told of each access revoked, by its ref.
 *
 * @param {(ref: string) => void} listener
 * @returns {() => void}
 */
export function onSourceAccessRevoked(listener) {
  revokeListeners.add(listener);
  return () => revokeListeners.delete(listener);
}
