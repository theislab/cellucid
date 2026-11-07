import path from 'node:path';

import {
  expect,
  test as playwrightTest,
} from '@playwright/test';

import { installDevice } from './device.mjs';
import { guardFirefoxAriaReflection } from './firefox-aria-reflection.mjs';
import { watchDownloadNames } from './downloads.mjs';
import { ignoreEmulatedFileChooserCancel } from './file-chooser-cancel.mjs';
import { setAsideLeavingReports } from './leaving-document.mjs';
import { expectNoOutsideRequests, watchOutsideRequests } from './outside-requests.mjs';
import { expectNoSplitClicks, forgetSplitClicks, watchSplitClicks } from './split-clicks.mjs';
import { annotateNonFinitePointerEvents, watchNonFinitePointerEvents } from './non-finite-pointer-events.mjs';

export async function retirePageApplication(page) {
  if (page.isClosed()) return;

  await page.evaluate(async () => {
    const viewer = window._cellucidViewer ?? null;
    const dispose = window._cellucidDispose;

    // A document that stopped before viewer construction owns no application
    // runtime. Once the viewer exists, however, the stable application
    // disposer is mandatory: force-closing a Playwright page does not dispatch
    // pagehide in Chromium, Firefox, or WebKit.
    if (dispose === undefined && viewer === null) return;
    if (typeof dispose !== 'function') {
      throw new Error(
        'A constructed Cellucid viewer has no application teardown owner.',
      );
    }

    const firstTask = dispose();
    const secondTask = dispose();
    if (
      firstTask === null ||
      typeof firstTask !== 'object' ||
      typeof firstTask.then !== 'function' ||
      secondTask !== firstTask
    ) {
      throw new Error(
        'Cellucid application teardown must publish one stable Promise.',
      );
    }
    await firstTask;

    if (viewer !== null) {
      if (
        typeof viewer.isDisposed !== 'function' ||
        typeof viewer.isDisposalSettled !== 'function' ||
        viewer.isDisposed() !== true ||
        viewer.isDisposalSettled() !== true
      ) {
        throw new Error(
          'Cellucid application teardown did not settle viewer disposal.',
        );
      }
    }
  });
}

export async function retireContextApplications(context) {
  const outcomes = await Promise.allSettled(
    context.pages().map(page => retirePageApplication(page)),
  );
  const failures = outcomes
    .filter(outcome => outcome.status === 'rejected')
    .map(outcome => outcome.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'One or more browser applications could not be retired.',
    );
  }
}

export async function closePageWithApplicationRetirement(page) {
  const failures = [];
  try {
    await retirePageApplication(page);
  } catch (error) {
    failures.push(error);
  }
  try {
    await page.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'Application retirement and page closure both failed.',
    );
  }
}

export async function closeContextWithApplicationRetirement(context) {
  const failures = [];
  try {
    await retireContextApplications(context);
  } catch (error) {
    failures.push(error);
  }
  try {
    await context.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'Application retirement and browser-context closure both failed.',
    );
  }
}

/** Contexts watched already (`watchContextsLostAtCreation`). */
const contextsWatchedForLoss = new WeakSet();

/**
 * Note every WebGL context a page of `context` is handed already lost. A
 * browser whose graphics process was reset gives every later context lost
 * (WebKit after a GPU reset on a hosted macOS runner: WebKit bug 328185, run
 * 42274413675), and the test that asked for one then failed on a shader that
 * does not compile, naming nothing of the cause. A failed test names it
 * (`annotateContextsLostAtCreation`). Only what the browser itself handed
 * back is noted: a spec that loses a context on purpose does so after.
 */
async function watchContextsLostAtCreation(context) {
  // Once a context: the fixture meets a test's own context twice (through
  // `browser.newContext` and as `context`), and a second wrapper of
  // `getContext` would count every lost context twice.
  if (contextsWatchedForLoss.has(context)) return;
  contextsWatchedForLoss.add(context);
  await context.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
      const made = getContext.call(this, kind, ...rest);
      if ((kind === 'webgl2' || kind === 'webgl') && made !== null && made.isContextLost()) {
        window.__cellucidContextsLostAtCreation = (window.__cellucidContextsLostAtCreation ?? 0) + 1;
      }
      return made;
    };
  });
}

async function annotateContextsLostAtCreation(context, testInfo) {
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    const lost = await page.evaluate(() => window.__cellucidContextsLostAtCreation ?? 0).catch(() => 0);
    if (lost === 0) continue;
    const description = `${page.url()}: the browser handed ${lost} WebGL context(s) already lost: its graphics process was reset or stopped before this test drew (not this test's code; WebKit bug 328185)`;
    testInfo.annotations.push({ type: 'webgl-lost-at-creation', description });
    console.log(`[webgl-lost-at-creation] ${testInfo.title} -> ${description}`);
  }
}

async function annotateStartupPhases(context, testInfo) {
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    const phase = await page.evaluate(
      () => document.documentElement.dataset.startupPhase ?? null,
    ).catch(() => 'unreadable');
    const description = `${page.url()}: ${phase ?? 'not started'}`;
    testInfo.annotations.push({ type: 'startup-phase', description });
    console.log(`[startup-phase] ${testInfo.title} -> ${description}`);
  }
}

/**
 * Remove everything an origin keeps in a context's storage: its
 * origin-private file system, IndexedDB databases and local storage. From
 * an empty page of the origin (answered by a route, never by the server).
 * An engine that gives pages no Storage API keeps no origin-private file
 * system to remove: Playwright's Linux WebKit had no `navigator.storage` in
 * any context, persistent ones included, through 1.62 (r2336; Playwright's
 * own suite expects it, microsoft/playwright#18235).
 *
 * The empty page is the one the persistent context opened with, which no
 * test uses (the `page` fixture opens its own), and it stays open until the
 * context closes. It is not a page opened and closed here: on macOS WebKit,
 * closing a page moments after it reached an http(s) address can end the
 * browser process (the Screen Time observer of `-[WKWebView dealloc]`,
 * `helpers/downloads.mjs`), and every test sharing that browser then fails
 * with "Target page, context or browser has been closed".
 */
async function clearOriginStorage(context, origin) {
  const [page] = context.pages();
  if (page === undefined) throw new Error('The persistent context has no page of its own to clear storage from.');
  const address = new URL('/__clear-origin-storage__', origin).href;
  if (page.url() !== address) {
    await page.route(address, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>storage</title>' }));
    await page.goto(address);
  }
  await page.evaluate(async () => {
    if (navigator.storage !== undefined) {
      const root = await navigator.storage.getDirectory();
      for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
    }
    for (const { name } of await indexedDB.databases()) {
      await new Promise(resolve => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      });
    }
    localStorage.clear();
  });
}

/**
 * `CELLUCID_BROWSER_TEST_CPU_THROTTLE=<rate>` slows the main thread of every
 * page by that factor (Chromium only: the DevTools protocol's CPU
 * throttling), so a developer machine orders work as a slow hosted runner
 * does: what a spec read "right after" an action is then not there yet. It
 * slows a page's own thread, not its workers or the GPU. Unset in CI.
 */
const CPU_THROTTLE = Number(process.env.CELLUCID_BROWSER_TEST_CPU_THROTTLE ?? 0);

function throttleCpu(context, browserName) {
  if (!(CPU_THROTTLE > 1) || browserName !== 'chromium') return;
  const throttle = async page => {
    const session = await context.newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  };
  context.on('page', page => { throttle(page).catch(() => {}); });
}

/**
 * `CELLUCID_FIGURE_EXPORT_POINT_PASS=page` runs every figure export's point
 * passes on the page, as on a browser whose workers have no WebGL2
 * (WebKitGTK, WPE): the run exercises that placement in any engine.
 */
const POINT_PASS_ON_PAGE = process.env.CELLUCID_FIGURE_EXPORT_POINT_PASS === 'page';

export const test = playwrightTest.extend({
  /**
   * Run the test in a browser context that keeps an origin-private file
   * system, as a browser's ordinary window does: `test.use({ persistentStorage: true })`.
   * Chromium's and Firefox's test contexts have one already. Playwright's
   * WebKit gives its ephemeral contexts none (`getDirectory()` fails with
   * UnknownError, in the page and in workers, and IndexedDB fails with them,
   * as in a Safari private window), so there the context is a persistent
   * one in the test's own output folder, where Safari's sync access handles
   * in workers work as in Safari itself.
   */
  persistentStorage: [false, { option: true }],
  /**
   * The device the test runs on (`helpers/device.mjs`): every input the
   * page measures of its device and acts on by itself, fixed, the same on
   * every machine. A spec about one of those choices sets its own:
   * `test.use({ device: { gpu: { frameMs: 60 } } })`.
   */
  device: [{}, { option: true }],
  // A context a spec opens itself (`browser.newContext`) runs on the same
  // device as the test's own, or on the one it names:
  // `browser.newContext({ device: { openingMsPerCell: 2 } })`.
  deviceForNewContexts: [async ({ browser, browserName, device }, use) => {
    const newContext = browser.newContext;
    browser.newContext = async function newContextOnDevice({ device: own, ...options } = {}) {
      const context = await newContext.call(this, options);
      await guardFirefoxAriaReflection(context, browserName);
      await installDevice(context, own ?? device);
      await ignoreEmulatedFileChooserCancel(context, browserName);
      setAsideLeavingReports(context);
      watchOutsideRequests(context);
      await watchSplitClicks(context);
      await watchDownloadNames(context);
      await watchContextsLostAtCreation(context);
      await watchNonFinitePointerEvents(context);
      throttleCpu(context, browserName);
      return context;
    };
    // Every context of the test is watched for clicks a layout change split
    // (`split-clicks.mjs`); the test that had one fails here, naming it.
    forgetSplitClicks();
    try {
      await use();
    } finally {
      browser.newContext = newContext;
    }
    expectNoSplitClicks();
  }, { auto: true }],
  context: async ({ context, browserName, persistentStorage, device, playwright }, use, testInfo) => {
    if (!persistentStorage || browserName !== 'webkit') {
      await guardFirefoxAriaReflection(context, browserName);
      await installDevice(context, device);
      await ignoreEmulatedFileChooserCancel(context, browserName);
      setAsideLeavingReports(context);
      watchOutsideRequests(context);
      await watchSplitClicks(context);
      await watchDownloadNames(context);
      await watchContextsLostAtCreation(context);
      await watchNonFinitePointerEvents(context);
      await use(context);
      await expectNoOutsideRequests();
      return;
    }
    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL, headless, locale } = testInfo.project.use;
    // The profile folder is named by the test's id, not its title: WebKit on
    // Linux refuses a non-ASCII argument ("Cannot parse arguments: Invalid
    // byte sequence in conversion input"), and a title such as "Folder…"
    // puts one in the test's output folder.
    const profile = path.join(testInfo.project.outputDir, 'webkit-storage', `${testInfo.testId}-${testInfo.repeatEachIndex}-${testInfo.retry}`);
    const persistent = await playwright.webkit.launchPersistentContext(profile, {
      viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL, headless: headless ?? true, locale,
    });
    // WebKit keeps a persistent context's origin storage outside its
    // profile folder (measured: one test's kept stores were found by the
    // next): every test starts and ends with the origin's storage empty.
    try {
      await clearOriginStorage(persistent, baseURL);
      await installDevice(persistent, device);
      setAsideLeavingReports(persistent);
      watchOutsideRequests(persistent);
      await watchSplitClicks(persistent);
      await watchDownloadNames(persistent);
      await watchContextsLostAtCreation(persistent);
      await watchNonFinitePointerEvents(persistent);
      throttleCpu(persistent, browserName);
      await use(persistent);
      await expectNoOutsideRequests();
    } finally {
      await clearOriginStorage(persistent, baseURL).catch(() => {});
      await persistent.close();
    }
  },
  // Override the lazy page fixture instead of installing an auto context
  // fixture. An auto fixture materializes an otherwise unused default context
  // in browser-only tests, and its teardown can run after Playwright has
  // already closed the base page. This boundary retires the application while
  // both its document and context are still live.
  page: async ({ context, page }, use, testInfo) => {
    if (POINT_PASS_ON_PAGE) {
      await page.addInitScript(() => {
        // Only a document served by the application's origin can load it (not
        // the initial about:blank). The address is absolute: an init script
        // has no base URL of its own in WebKit.
        if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
        const client = new URL(
          '/assets/js/app/ui/modules/figure-export/utils/figure-export-worker-client.js',
          location.href,
        );
        import(client.href).then(module => module.setFigureExportWorkerWebgl2(false));
      });
    }
    try {
      await use(page);
      // Before the application retires, which stops what it still asks.
      await expectNoOutsideRequests();
    } finally {
      // A failed test names the startup phase each page stopped in, so a
      // stalled bootstrap reports where it waited instead of only that the
      // dataset name never appeared.
      try {
        if (testInfo.status !== testInfo.expectedStatus) {
          await annotateStartupPhases(context, testInfo);
          await annotateContextsLostAtCreation(context, testInfo);
          await annotateNonFinitePointerEvents(context, testInfo);
        }
      } finally {
        await retireContextApplications(context);
      }
    }
  },
});

export { expect };
