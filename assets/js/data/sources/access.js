/**
 * The access of remote files behind a sign-in or an expiring link, owned by
 * the page.
 *
 * A provider that reads a file with a bearer token (Google Drive) or through
 * a pre-authenticated URL that expires (OneDrive) registers the file's
 * access here: `target({refresh})` answers the URL and headers the next
 * request goes to, `{url, headers?, expiresAt?}`. The file's resource then
 * names only `{provider, ref, stale, unreadable}` (`stale`: statuses beyond
 * 401 that mean the target went stale; `unreadable`: what an answer the page
 * is not let read means at this provider, or null), which crosses to the
 * AnnData reader worker like any plain record. The worker asks for a target
 * when it needs one (`{event: 'source-access'}`, answered by the reader
 * client from `resolveSourceAccess`), holds it in memory only, and shares it
 * across its parallel reads (`httpByteSource`'s `access`).
 *
 * A provider that names `unreadable` also says, from its own evidence,
 * whether the file is unreadable now (`unreadable.confirm()`: Google Drive
 * asks for the file's details, which answer, and one byte of it, which
 * fails): a read that gets no answer asks it (`{event: 'source-unreadable'}`,
 * answered from `confirmSourceUnreadable`) and, confirmed, fails at once in
 * the provider's words instead of after the generic repeats.
 *
 * Tokens and pre-authenticated URLs stay in memory here and in the worker:
 * never in a resource, a session, a URL, the Transfers log, the console or an
 * error.
 *
 * @module data/sources/access
 */

import { createOpaqueId } from '../../app/utils/opaque-id.js';

/** @type {Map<string, {provider: string, target: Function, confirm: Function|null, checking: Promise<boolean>|null}>} */
const registrations = new Map();
const revokeListeners = new Set();

/**
 * Register one file's access; the descriptor goes into its resource.
 *
 * @param {{provider: string, target: (request: {refresh: boolean}) => Promise<{url: string,
 *   headers?: Object<string, string>, expiresAt?: number}>, stale?: number[],
 *   unreadable?: {text: string, confirm: () => Promise<boolean>}|null}} options
 *   `unreadable.text`: what an answer the page is not let read means at this
 *   provider; `unreadable.confirm()`: whether the provider's own evidence says
 *   the file is unreadable now
 * @returns {Readonly<{provider: string, ref: string, stale: number[], unreadable: string|null}>}
 */
export function registerSourceAccess({ provider, target, stale = [], unreadable = null }) {
  if (typeof provider !== 'string' || provider === '') {
    throw new TypeError('A source access names its provider.');
  }
  if (typeof target !== 'function') throw new TypeError('A source access needs target({refresh}).');
  if (!Array.isArray(stale) || stale.some(status => !Number.isInteger(status))) {
    throw new TypeError('A source access stale list holds HTTP statuses.');
  }
  if (unreadable !== null) {
    if (typeof unreadable?.text !== 'string' || unreadable.text.trim() === '') {
      throw new TypeError('A source access unreadable text is a sentence.');
    }
    if (typeof unreadable.confirm !== 'function') {
      throw new TypeError('A source access that names an unreadable text confirms it: unreadable.confirm().');
    }
  }
  const ref = createOpaqueId();
  registrations.set(ref, { provider, target, confirm: unreadable?.confirm ?? null, checking: null });
  return Object.freeze({ provider, ref, stale: Object.freeze([...stale]), unreadable: unreadable?.text ?? null });
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
 * Whether one registered access's provider says its file is unreadable now
 * (`unreadable.confirm()`): one check at a time, shared by every read that
 * asks while it runs. A check that fails, or an access that names none,
 * confirms nothing.
 *
 * @param {string} ref
 * @returns {Promise<boolean>}
 */
export function confirmSourceUnreadable(ref) {
  const registration = registrations.get(ref);
  if (registration === undefined || registration.confirm === null) return Promise.resolve(false);
  registration.checking ??= Promise.resolve()
    .then(() => registration.confirm())
    .then(unreadable => unreadable === true, () => false)
    .finally(() => {
      registration.checking = null;
    });
  return registration.checking;
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
