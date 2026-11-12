/**
 * The access of remote files behind a sign-in or an expiring link, owned by
 * the page.
 *
 * A provider that reads a file with a bearer token (Google Drive) or through
 * a pre-authenticated URL that expires (OneDrive) registers the file's
 * access here: `target({refresh})` answers the URL and headers the next
 * request goes to, `{url, headers?, expiresAt?}`. The file's resource then
 * names only `{provider, ref, stale, changed, unreadable, limited, versioned}`
 * (`stale`: statuses beyond 401 that mean the target went stale; `changed`:
 * statuses that mean the version the target names is gone, a file replaced
 * since it was opened; `unreadable`: what an answer the page is not let read
 * means at this provider, or null; `limited`: what a rate limit means at
 * this provider -- whose quota it is --, or null; `versioned`: whether the
 * provider can tell that the version the file was opened as still holds,
 * `confirmVersion`), which crosses to the
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
 * A provider whose reads cannot name the version they read (Google Drive's
 * public reads: its API key may not read a revision, measured, and its
 * answers carry no validator) says, from its own evidence, whether the
 * version the file was opened as still holds (`version.confirm()`: Drive
 * asks for the file's checksum again): what a reader keeps of the file
 * (`formats/io/kept-parts.js`) is filed under that version only once it is
 * confirmed (`{event: 'source-version'}`, answered from
 * `confirmSourceVersion`).
 *
 * Tokens and pre-authenticated URLs stay in memory here and in the worker:
 * never in a resource, a session, a URL, the Transfers log, the console or an
 * error.
 *
 * An access lives as long as the source that reads its file, which lets it
 * go (`releaseSourceAccessesOf`): a provider registers it only once the file
 * is described (a refusal registers none); the reading source
 * (`AnnDataFileSource`) releases it when the source is replaced or closed, or
 * its opening is not adopted; whoever took an opening releases it when the
 * opening fails before a reader took it (the link source, a catalog entry).
 * Nothing else keeps a registration, so a day of opening linked files keeps
 * only the ones open.
 *
 * @module data/sources/access
 */

import { createOpaqueId } from '../../utils/opaque-id.js';
import { createListenerSet } from '../../utils/listener-set.js';

/** @type {Map<string, {provider: string, target: Function, confirm: Function|null, checking: Promise<boolean>|null, version: Function|null}>} */
const registrations = new Map();
const revokeListeners = createListenerSet('a source access revoked');

/**
 * Register one file's access; the descriptor goes into its resource.
 *
 * @param {{provider: string, target: (request: {refresh: boolean}) => Promise<{url: string,
 *   headers?: Object<string, string>, expiresAt?: number}>, stale?: number[], changed?: number[],
 *   unreadable?: {text: string, confirm: () => Promise<boolean>}|null, limited?: string|null,
 *   version?: {confirm: () => Promise<boolean>}|null}} options
 *   `unreadable.text`: what an answer the page is not let read means at this
 *   provider; `unreadable.confirm()`: whether the provider's own evidence says
 *   the file is unreadable now; `limited`: a sentence saying what a rate
 *   limit means here; `version.confirm()`: whether the version the file was
 *   opened as still holds
 * @returns {Readonly<{provider: string, ref: string, stale: number[], changed: number[], unreadable: string|null,
 *   limited: string|null, versioned: boolean}>}
 */
export function registerSourceAccess({ provider, target, stale = [], changed = [], unreadable = null, limited = null, version = null }) {
  if (typeof provider !== 'string' || provider === '') {
    throw new TypeError('A source access names its provider.');
  }
  if (typeof target !== 'function') throw new TypeError('A source access needs target({refresh}).');
  for (const [name, list] of [['stale', stale], ['changed', changed]]) {
    if (!Array.isArray(list) || list.some(status => !Number.isInteger(status))) {
      throw new TypeError(`A source access ${name} list holds HTTP statuses.`);
    }
  }
  if (limited !== null && (typeof limited !== 'string' || limited.trim() === '')) {
    throw new TypeError('A source access limited text is a sentence.');
  }
  if (version !== null && typeof version?.confirm !== 'function') {
    throw new TypeError('A source access version confirms itself: version.confirm().');
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
  registrations.set(ref, { provider, target, confirm: unreadable?.confirm ?? null, checking: null, version: version?.confirm ?? null });
  return Object.freeze({
    provider,
    ref,
    stale: Object.freeze([...stale]),
    changed: Object.freeze([...changed]),
    unreadable: unreadable?.text ?? null,
    limited,
    versioned: version !== null,
  });
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
 * Whether the version one registered access's file was opened as still
 * holds (`version.confirm()`). A check that fails, or an access that names
 * none, confirms nothing (false): nothing is filed under a version not
 * confirmed.
 *
 * @param {string} ref
 * @returns {Promise<boolean>}
 */
export function confirmSourceVersion(ref) {
  const registration = registrations.get(ref);
  if (registration === undefined || registration.version === null) return Promise.resolve(false);
  return Promise.resolve()
    .then(() => registration.version())
    .then(holds => holds === true, () => false);
}

/**
 * Let one file's access go: its target and the provider closure it holds
 * (the item, the token getter). A read still asking for it after this is told
 * to open the file again (`resolveSourceAccess`); letting go twice is nothing.
 *
 * @param {{ref: string}} descriptor - What `registerSourceAccess` returned
 */
export function releaseSourceAccess(descriptor) {
  if (typeof descriptor?.ref !== 'string') throw new TypeError('A source access is released by its descriptor.');
  registrations.delete(descriptor.ref);
}

/**
 * Let go of every access a reader's source names: its remote file
 * (`{file}`) and the files of a remote file set (`{files}`); a source of
 * files on this computer or a store names none.
 *
 * @param {{file?: Object|null, files?: Map<string, Object>}|null} source
 */
export function releaseSourceAccessesOf(source) {
  for (const file of sourceFiles(source)) {
    if (file?.access != null) releaseSourceAccess(file.access);
  }
}

/** The files of a reader's source that may name an access. */
function sourceFiles(source) {
  if (source === null || typeof source !== 'object') return [];
  return [
    ...(source.file == null ? [] : [source.file]),
    ...(source.files instanceof Map ? source.files.values() : []),
  ];
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
    revokeListeners.notify(ref);
  }
}

/**
 * Be told of each access revoked, by its ref.
 *
 * @param {(ref: string) => void} listener
 * @returns {() => void}
 */
export function onSourceAccessRevoked(listener) {
  return revokeListeners.add(listener);
}
