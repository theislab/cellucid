/**
 * Taking a browser context offline.
 *
 * A page still loading something of its own when the connection goes reports
 * that load's failure, as it should, beside whatever the spec is about: the
 * analysis tools the page imports as it starts (hundreds of files that keep
 * arriving long after the first view on a loaded machine; WebKit reports
 * "Importing a module script failed"), a read of the opening still under
 * way (its gene list, a tree its frames asked for), or the samples' listing,
 * which reads their files after startup's dataset has settled in a reader
 * worker of its own (`LocalDemoDataSource.whenListed`): a worker whose module
 * graph is still loading when the connection goes fails, and WebKit reports
 * that as a page error too, whoever handles the worker's `error`.
 *
 * `goOffline` waits, on every page of the context that runs the app, for what
 * the page started by itself to be over (`waitForPageAtRest`, and the
 * samples' listing) and for its startup code to be in
 * (`whenStartupCodeLoaded`), then takes the context offline. Specs go
 * offline only through it (`tests/browser-spec-offline-contract.test.mjs`),
 * so none can forget any of these waits, however slow the machine.
 */
import { waitForPageAtRest, whenStartupCodeLoaded } from './dataset-ready.mjs';

/**
 * @param {import('@playwright/test').BrowserContext} context
 */
export async function goOffline(context) {
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    // A page that runs the app: its code marks its first statement (main.js).
    const runsTheApp = await page.evaluate(() => document.documentElement.dataset.codeStarted === 'true');
    if (!runsTheApp) continue;
    await waitForPageAtRest(page);
    await whenStartupCodeLoaded(page);
    await page.evaluate(async () => {
      const { getDataSourceManager } = await import('/assets/js/data/data-source-manager.js');
      await getDataSourceManager().getSource('local-demo')?.whenListed();
    });
  }
  await context.setOffline(true);
}
