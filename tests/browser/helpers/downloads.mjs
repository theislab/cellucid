/**
 * The name a download was asked to be saved under, and the name it was saved under.
 *
 * The application names each file it hands the browser (`utils/download.js`:
 * an `<a download="…">` on a Blob URL, the one way it downloads). What the
 * person then finds on disk is the browser's: it may rewrite the asked name,
 * and engines differ. `download.suggestedFilename()` reports the browser's
 * name, so a spec that compares it with the app's name is testing the
 * engine's file-name rules, not the app.
 *
 * Measured, Web contracts run 42293355104 (Playwright 1.65.0, WebKit r2388,
 * ubuntu-26.04): Linux WebKit saves `My report.html` as `My_report.html`.
 * Not Playwright (its server passes the engine's name through) and not
 * WebKit's own rules (macOS WebKit keeps the space, as Safari does): the WPE
 * and GTK ports sanitize an `<a download>` name by parsing it as a
 * Content-Disposition filename with libsoup
 * (`ResourceResponseBase::sanitizeSuggestedFilename`, `ResourceResponseSoup.cpp`),
 * and libsoup 3.6.6 replaces every whitespace character in such a filename
 * with `_` (GNOME/libsoup 9e1570c9, "Sanitize filename of content disposition
 * header values"; spaces inside the name are allowed again from 3.7.1 by
 * db09564e, GNOME/libsoup#503, not on the 3.6 branch). Ubuntu 26.04 ships
 * libsoup 3.6.6; Playwright's r2336 WebKit bundled an older libsoup
 * (`minibrowser-wpe/sys/lib/libsoup-3.0.so.0.7.4`), r2388 loads the system's.
 * Epiphany on Ubuntu 26.04 saves the same names.
 *
 * So a spec holds the app to the name it asked for, exactly, and holds the
 * download to the name this browser saves any file asked to be that name
 * (measured in a page of its own, with the same type), exactly:
 * `expectDownloadNamed(download, 'My report.html')`.
 */

import { expect } from '@playwright/test';

/** Contexts watched already: the fixture meets a test's own context twice. */
const watched = new WeakSet();
/** Per context: `${type}\n${name}` → the name the browser saves it under. */
const savedNames = new WeakMap();

/**
 * Record, in every page of `context`, the name and type of each download the
 * page asks for.
 *
 * @param {import('@playwright/test').BrowserContext} context
 */
export async function watchDownloadNames(context) {
  if (watched.has(context)) return;
  watched.add(context);
  await context.addInitScript(() => {
    const types = new Map();
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = function createObjectURL(object) {
      const url = create.call(this, object);
      if (object instanceof Blob) types.set(url, object.type);
      return url;
    };
    URL.revokeObjectURL = function revokeObjectURL(url) {
      types.delete(url);
      return revoke.call(this, url);
    };
    window.__cellucidDownloadsAsked = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function clickRecordingDownload() {
      if (this.hasAttribute('download')) {
        window.__cellucidDownloadsAsked.push({ url: this.href, name: this.download, type: types.get(this.href) ?? null });
      }
      return click.call(this);
    };
  });
}

/**
 * The name and type the page asked `download` to be saved under.
 *
 * @param {import('@playwright/test').Download} download
 * @returns {Promise<{name: string, type: string|null}>}
 */
export async function askedDownload(download) {
  const url = download.url();
  const asked = await download.page().evaluate(address => {
    const list = window.__cellucidDownloadsAsked ?? null;
    if (list === null) return null;
    return list.filter(entry => entry.url === address).at(-1) ?? { url: address, missing: true };
  }, url);
  if (asked === null) throw new Error('This page is not watched for downloads (watchDownloadNames).');
  if (asked.missing) throw new Error(`The page asked for no download of ${url} through an <a download>.`);
  return { name: asked.name, type: asked.type };
}

/**
 * The name this browser saves a Blob of `type` under when a page of the
 * application asks for it to be `name`: an `<a download>` clicked in a page of
 * its own, in the same context, that never leaves `about:blank`.
 *
 * The probe page stays at `about:blank` because macOS WebKit can end its whole
 * browser process when a page that reached an http(s) address is closed
 * moments later. A WKWebView can start a Screen Time observer once its main
 * frame has committed an http(s) URL (on a later commit update, so a page
 * closed at once usually has none yet: no fixed delay makes a close safe)
 * (`-[WKWebView
 * _installScreenTimeWebpageControllerIfNeeded]`, which returns early unless
 * `mainFrame()->url().protocolIsInHTTPFamily()`; started from
 * `PageClientImplCocoa::updateScreenTimeWebpageControllerURL`). That observer
 * watches `configuration.enforcesChildRestrictions` of an
 * `STScreenTimeConfigurationObserver`, whose XPC replies set `configuration`
 * on WebKit's update queue (`WKScreenTimeConfigurationObserver.mm`). Closing
 * the page deallocates the view, and `-[WKWebView dealloc]` removes that
 * observer on the main thread (`_uninstallScreenTimeWebpageController`,
 * `stopObserving`). When the reply is still being applied, KVO throws
 * NSInternalInconsistencyException ("Cannot remove an observer … for the key
 * path configuration.enforcesChildRestrictions"; Apple FB21537703, WebKit bug
 * 303024 made the queue serial, which does not order it against the main
 * thread). Nothing catches it, so the process aborts. Seen in Web contracts
 * run 42368649946 (macOS 26.7.2, WebKit r2388): this helper's probe page,
 * then navigated to the app's origin, was closed 7 ms after its navigation
 * returned, and the browser aborted in that close (crash report
 * `Playwright-2026-11-07-114944.ips`: `-[WKScreenTimeConfigurationObserver
 * stopObserving]` under `-[WKWebView dealloc]`, 11:49:01.47 UTC). The test
 * then read its own, finished download and got "download.path: Target page,
 * context or browser has been closed": the disconnect had closed the context
 * and disposed every artifact of it. Neither the probe's download nor its
 * cancel touches another download (reproduced both ways, 30 of 30 kept).
 *
 * On `about:blank` the observer never starts, so closing the probe races
 * nothing. Measured on macOS 26.7 WebKit r2388: each page that committed an
 * http address opened a connection to `com.apple.ScreenTimeAgent` 22 to 26
 * ms later; 20 `about:blank` pages, each with a download, opened none. The
 * saved name is the same there, since a Blob the probe page makes is
 * same-origin to it: names with a space, a comma, two spaces, no extension,
 * `/ : ?` and non-ASCII letters were each saved exactly as a page of the
 * app's origin saves them, in Chromium, Firefox and WebKit.
 *
 * @param {import('@playwright/test').Page} page a page of the application
 * @param {string} name
 * @param {string|null} type
 * @returns {Promise<string>}
 */
async function nameBrowserSaves(page, name, type) {
  const context = page.context();
  if (!savedNames.has(context)) savedNames.set(context, new Map());
  const known = savedNames.get(context);
  const key = `${type ?? ''}\n${name}`;
  if (known.has(key)) return known.get(key);
  const probe = await context.newPage();
  try {
    const [download] = await Promise.all([
      probe.waitForEvent('download'),
      probe.evaluate(({ name, type }) => {
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(new Blob(['probe'], type === null ? {} : { type }));
        anchor.download = name;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      }, { name, type }),
    ]);
    const saved = download.suggestedFilename();
    await download.cancel();
    known.set(key, saved);
    return saved;
  } finally {
    await probe.close();
  }
}

/**
 * The page asked `download` to be saved as `expected` (a name, or a pattern
 * the name matches), and the browser saved it under the name it gives any
 * file asked to be that name.
 *
 * @param {import('@playwright/test').Download} download
 * @param {string|RegExp} expected
 * @returns {Promise<string>} the name asked for
 */
export async function expectDownloadNamed(download, expected) {
  const { name, type } = await askedDownload(download);
  if (expected instanceof RegExp) expect(name).toMatch(expected);
  else expect(name).toBe(expected);
  expect(download.suggestedFilename()).toBe(await nameBrowserSaves(download.page(), name, type));
  return name;
}
