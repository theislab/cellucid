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
 * A page being left stops the loads it still has going, and WebKit fails
 * each as the navigation starts, before the page hides: a part still loading
 * when the person reloads would be said to have failed by a page that is
 * going. `beforeunload` is the first thing every engine says when the page
 * is navigated away from (a reload, a link, the address bar; the Navigation
 * API's `navigate` is not fired for a reload from the browser), before any
 * load is stopped. A load that fails from then on is a failure only if the
 * page stays: it is held until the page hides (left: a `page-left`
 * cancellation, said nowhere) or shows it stays (the person presses a key or
 * a pointer on it, it comes back from the back/forward cache, or the browser
 * reports the navigation failed, `navigateerror`: the failure, said). A
 * navigation can be stopped, answered with a download, or declined at the
 * question of unkept work, so `beforeunload` alone does not mean the page
 * goes; no engine reports the end of one answered with no content or a
 * download, so that failure is said at the next key or pointer press
 * (developer docs, record 38). The code-load watch
 * (`ui/core/code-load-watch.js`, a classic script with no imports) holds the
 * start's own load the same way.
 *
 * @module app-code
 */

import { getNotificationCenter } from './notification-center.js';
import { onWorkerScriptFailure } from '../workers/worker-script.js';
import { PLACES, placePath } from './ui/place-names.js';
import { cancelled } from '../utils/abort.js';
import { promiseWithResolvers } from '../utils/promise-resolvers.js';

const BUILD_ID_META = /<meta\s+name="cellucid-web-build-id"\s+content="([^"]+)"/;
const UPDATE_NOTICE_ID = 'cellucid-code-updated';

/**
 * The build the server answers for this page's address now, or null when it
 * cannot be read (no connection, a page without the build stamp).
 *
 * @param {{ fetchImpl?: typeof fetch, locationRef?: Location }} [options]
 * @returns {Promise<string|null>}
 */
async function readDeployedBuildId({
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
function pageBuildId(documentOwner = globalThis.document) {
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
function announceIfUpdated({
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
          `have open, save a session file first (${placePath(PLACES.state, PLACES.sessionFile)} › Share…, Save file).`,
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
 * Watch whether `windowOwner`'s page is being left (module overview).
 * `leaving()`: null while it is not; from `beforeunload` on, a promise that
 * resolves true once the page hides for good and false once it shows it
 * stays (and from then on null again, until the next `beforeunload`).
 *
 * @param {Pick<Window, 'addEventListener'> & {navigation?: Pick<EventTarget, 'addEventListener'>}} windowOwner
 * @returns {{ leaving: () => Promise<boolean>|null }}
 */
function watchPageLeave(windowOwner) {
  /** @type {{promise: Promise<boolean>, resolve: (left: boolean) => void}|null} */
  let leave = null;
  const stays = () => {
    if (leave === null) return;
    leave.resolve(false);
    leave = null;
  };
  windowOwner.addEventListener('beforeunload', () => {
    leave ??= promiseWithResolvers();
  });
  windowOwner.addEventListener('pagehide', event => {
    // Into the back/forward cache, the page may come back (`pageshow`).
    if (event.persisted) return;
    leave ??= promiseWithResolvers();
    leave.resolve(true);
  });
  windowOwner.addEventListener('pageshow', event => {
    if (event.persisted) stays();
  });
  for (const type of ['pointerdown', 'keydown']) windowOwner.addEventListener(type, stays, { capture: true });
  // A navigation that ends without leaving (Stay at the question of unkept
  // work) is reported where the engine reports it, as `navigateerror`.
  windowOwner.navigation?.addEventListener('navigateerror', stays);
  return { leaving: () => leave?.promise ?? null };
}

const pageLeave = typeof globalThis.window?.addEventListener === 'function' ? watchPageLeave(globalThis.window) : null;

/**
 * What a part of the app's code that did not load ends with (module
 * overview): `failure` itself, checked for a page that outlived its build
 * (`announceIfUpdated`); or, when the page was being left and is left, a
 * `page-left` cancellation, never said. Resolves once that is known.
 *
 * @param {unknown} failure
 * @returns {Promise<unknown>}
 */
export async function failedLoad(failure) {
  const leaving = pageLeave?.leaving() ?? null;
  if (leaving !== null && (await leaving)) {
    return cancelled('page-left', 'The page was left before this part of Cellucid loaded.', failure);
  }
  void announceIfUpdated();
  return failure;
}

/**
 * Load a part of the app that is imported on demand. It rejects with what
 * `failedLoad` makes of a failure: a load cut off by the page being left is
 * a `page-left` cancellation.
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
    throw await failedLoad(error);
  }
}
