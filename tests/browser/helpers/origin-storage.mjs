/**
 * What this browser keeps for the app's origin, seen from a page of it.
 *
 * Files the app reads whole once (R objects, MatrixMarket folders, files a
 * host serves only whole) and gene indexes are kept in the origin-private
 * file system by the reader worker, for later visits. A browser without one
 * keeps them in memory for the tab: a Safari or Firefox private window, and
 * Playwright's Linux WebKit through 1.62 (r2336), which had no
 * `navigator.storage` at all.
 * A spec asks the page which it is (`workersKeepFiles`), never the engine's
 * name, and holds the app to the behaviour of that case.
 */

/**
 * Whether a dedicated worker of this page can open the origin-private file
 * system, as the app's reader worker does to keep what it converts.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>}
 */
export async function workersKeepFiles(page) {
  return page.evaluate(() => {
    const source = 'onmessage = async () => { try { await navigator.storage.getDirectory(); postMessage(true); } catch { postMessage(false); } };';
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    return new Promise(resolve => {
      worker.onmessage = event => {
        worker.terminate();
        resolve(event.data === true);
      };
      worker.postMessage(null);
    });
  });
}

/**
 * The directories this origin keeps converted stores and gene indexes in,
 * sorted, or null where the page has no origin-private file system.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]|null>}
 */
export async function keptStoreDirectories(page) {
  return page.evaluate(async () => {
    let root;
    try {
      root = await navigator.storage.getDirectory();
    } catch {
      return null;
    }
    const names = [];
    try {
      const parent = await root.getDirectoryHandle('cellucid-transcoded');
      for await (const [name] of parent.entries()) names.push(name);
    } catch {
      return [];
    }
    return names.sort();
  });
}

/**
 * Where the Dataset box says the open dataset, read whole once, is kept: the
 * conversion line's attributes (`ui/modules/dataset-card.js`).
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{kept: string|null, persistent: string|null, reused: string|null}>}
 */
export async function conversionPlace(page) {
  return page.locator('#dataset-conversion').evaluate(line => ({
    kept: line.dataset.kept ?? null,
    persistent: line.dataset.persistent ?? null,
    reused: line.dataset.reused ?? null,
  }));
}
