/**
 * @fileoverview Code the app loads after it has started: the one place a
 * failed `import()` is told apart from a page that outlived its build.
 *
 * Every module URL names its bytes (index.html, CELLUCID_MODULE_VERSIONS), so
 * a page never mixes builds it fetches itself. A page kept open across a
 * deploy still asks for the modules of its own build when it imports a part
 * it has not loaded yet, and the server now has only the next build's: the
 * import can fail to link, or the file can be gone. A failed load asks the
 * server which build it serves; when that is not this page's, a notice says
 * Cellucid was updated and offers to reload. The caller's own handling of
 * the failure runs either way: the rejection is passed on unchanged.
 *
 * Workers are the same case: a deployed page starts each from its bundle,
 * whose name is its bytes (`workers/worker-script.js`), and a page that
 * outlived its build asks for a bundle the server no longer has. Every worker
 * the page starts reports a script that fails to load or run here, and gets
 * the same check.
 *
 * @module app-code
 */

import { getNotificationCenter } from './notification-center.js';
import { onWorkerScriptFailure } from '../workers/worker-script.js';

const BUILD_ID_META = /<meta\s+name="cellucid-web-build-id"\s+content="([^"]+)"/;
const UPDATE_NOTICE_ID = 'cellucid-code-updated';

/**
 * The build the server answers for this page's address now, or null when it
 * cannot be read (no connection, a page without the build stamp).
 *
 * @param {{ fetchImpl?: typeof fetch, locationRef?: Location }} [options]
 * @returns {Promise<string|null>}
 */
export async function readDeployedBuildId({
  fetchImpl = globalThis.fetch,
  locationRef = globalThis.location
} = {}) {
  try {
    const response = await fetchImpl(locationRef.pathname, {
      cache: 'no-store',
      credentials: 'same-origin'
    });
    if (!response.ok) return null;
    return BUILD_ID_META.exec(await response.text())?.[1] ?? null;
  } catch {
    return null;
  }
}

/** This page's build, as its head names it. */
export function pageBuildId(documentOwner = globalThis.document) {
  return documentOwner.querySelector('meta[name="cellucid-web-build-id"]')
    ?.getAttribute('content') ?? null;
}

let updateCheck = null;

/**
 * Say once, when the server serves another build than this page's, that
 * Cellucid was updated and the page must be reloaded to load the rest of
 * its code.
 *
 * @returns {Promise<boolean>} whether the page outlived its build
 */
export function announceIfUpdated({
  documentOwner = globalThis.document,
  fetchImpl = globalThis.fetch,
  locationRef = globalThis.location,
  notifications = getNotificationCenter()
} = {}) {
  updateCheck ??= readDeployedBuildId({ fetchImpl, locationRef }).then(deployed => {
    const page = pageBuildId(documentOwner);
    const updated = deployed !== null && page !== null && deployed !== page;
    if (!updated) {
      // A failure on the current build is the caller's to report; a later
      // one asks again.
      updateCheck = null;
      return false;
    }
    documentOwner.documentElement.dataset.codeUpdated = 'true';
    if (!notifications.hasNotification(UPDATE_NOTICE_ID)) {
      notifications.error(
        'This page was opened before Cellucid was updated, so it cannot load the rest of its ' +
          'code. Reload to use the current version. Reloading starts over: to keep what you ' +
          'have open, save a session file first (Session file, Save).',
        {
          id: UPDATE_NOTICE_ID,
          title: 'Cellucid has been updated',
          action: { label: 'Reload', run: () => locationRef.reload() }
        }
      );
    }
    return true;
  });
  return updateCheck;
}

onWorkerScriptFailure(() => {
  void announceIfUpdated();
});

/**
 * Load a part of the app that is imported on demand.
 *
 * @template T
 * @param {() => Promise<T>} load the `import()` itself, written at the call
 *   site so its specifier resolves against the importing module
 * @returns {Promise<T>}
 */
export async function loadAppCode(load) {
  try {
    return await load();
  } catch (error) {
    void announceIfUpdated();
    throw error;
  }
}
