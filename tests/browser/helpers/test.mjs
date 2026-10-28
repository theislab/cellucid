import {
  expect,
  test as playwrightTest,
} from '@playwright/test';

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
 */
async function clearOriginStorage(context, origin) {
  const page = await context.newPage();
  const address = new URL('/__clear-origin-storage__', origin).href;
  try {
    await page.route(address, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>storage</title>' }));
    await page.goto(address);
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
      for (const { name } of await indexedDB.databases()) {
        await new Promise(resolve => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = request.onerror = request.onblocked = () => resolve();
        });
      }
      localStorage.clear();
    });
  } finally {
    await page.close();
  }
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
  context: async ({ context, browserName, persistentStorage, playwright }, use, testInfo) => {
    if (!persistentStorage || browserName !== 'webkit') {
      await use(context);
      return;
    }
    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL, headless, locale } = testInfo.project.use;
    const persistent = await playwright.webkit.launchPersistentContext(testInfo.outputPath('webkit-storage'), {
      viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL, headless: headless ?? true, locale,
    });
    // WebKit keeps a persistent context's origin storage outside its
    // profile folder (measured: one test's kept stores were found by the
    // next): every test starts and ends with the origin's storage empty.
    try {
      await clearOriginStorage(persistent, baseURL);
      await use(persistent);
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
    } finally {
      // A failed test names the startup phase each page stopped in, so a
      // stalled bootstrap reports where it waited instead of only that the
      // dataset name never appeared.
      try {
        if (testInfo.status !== testInfo.expectedStatus) {
          await annotateStartupPhases(context, testInfo);
        }
      } finally {
        await retireContextApplications(context);
      }
    }
  },
});

export { expect };
