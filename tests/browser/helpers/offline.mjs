/**
 * Taking a browser context offline.
 *
 * A page still loading something of its own when the connection goes reports
 * that load's failure, as it should, beside whatever the spec is about: the
 * analysis tools the page imports as it starts (hundreds of files that keep
 * arriving long after the first view on a loaded machine; hosted WebKit, Web
 * contracts run 42180485733: `decoder-memory.js`, `worker-script.js`, then
 * "Importing a module script failed"), or a read of the opening still under
 * way (its gene list, a tree its frames asked for).
 *
 * `goOffline` waits, on every page of the context that runs the app, for what
 * the page started by itself to be over (`waitForPageAtRest`) and for its
 * startup code to be in (`whenStartupCodeLoaded`), then takes the context
 * offline. Specs go offline only through it
 * (`tests/browser-spec-offline-contract.test.mjs`), so none can forget
 * either wait, however slow the machine.
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
  }
  await context.setOffline(true);
}
