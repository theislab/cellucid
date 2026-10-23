/**
 * Shared harness for the dataset-loading specs: the demo catalog fixtures, a
 * page observer that records every dataset name and notification the user is
 * shown, request holds, and the end-state assertion that the dataset select,
 * the dataset panel, the viewer and the startup phase agree.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './test.mjs';
import {
  APP_HOST,
  SAMPLE_ORIGIN,
  SAMPLE_PORT,
  appUrl,
} from './origins.mjs';
import { fulfillFile } from './anndata-zarr-zip.mjs';
import { jsonResponse, serveAnnDataServer } from './anndata-server.mjs';
import { dismissWelcome } from './welcome.mjs';
import { openCollapsedPanels } from './panels.mjs';

export const fixturesDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
);
export const demoCatalogDirectory = path.join(fixturesDirectory, 'demo-catalog');
export const H5AD_PATH = path.join(fixturesDirectory, 'current-ui-smoke.h5ad');
export const SAMPLE_CATALOG = appUrl('/tests/browser/fixtures/demo-catalog/');

// Each demo dataset is a zipped Zarr store (`<id>.zarr.zip`) in the demo
// catalog (`scripts/generate-browser-catalog-fixtures.py`); `embedding` is the
// `obsm` array it opens on.
export const START = Object.freeze({
  id: 'synthetic-cell-types-2d',
  embedding: 'X_islands',
  name: 'Synthetic cell-type islands — 2D',
  cells: 72,
  genes: 8,
  select: 'dataset:local-demo:synthetic-cell-types-2d',
});
export const TRAJECTORY = Object.freeze({
  id: 'synthetic-trajectory-1d',
  embedding: 'X_trajectory',
  name: 'Synthetic trajectory — 1D',
  cells: 48,
  genes: 6,
  select: 'dataset:local-demo:synthetic-trajectory-1d',
});
export const DEVELOPMENT = Object.freeze({
  id: 'synthetic-development-3d',
  embedding: 'X_branches',
  name: 'Synthetic branching development — 3D',
  cells: 96,
  genes: 10,
  select: 'dataset:local-demo:synthetic-development-3d',
});
export const H5AD = Object.freeze({
  name: 'current-ui-smoke',
  cells: 120,
  select: /^dataset:local-user:/,
});
// The one Zarr store folder of the browser tests, for the folder picker and
// folder drops.
export const ZARR_FOLDER = Object.freeze({
  path: path.join(fixturesDirectory, 'forms-catalog', 'forms-zarr.zarr'),
  name: 'Forms — Zarr folder',
  cells: 48,
  select: /^dataset:local-user:/,
});
export const NONE = Object.freeze({
  name: '—',
  cells: 0,
  select: '__none__',
});
export const PENDING_OPTION = '__dataset_pending__';

export function startUrl() {
  const url = new URL('/', appUrl('/'));
  url.searchParams.set('sampleCatalog', SAMPLE_CATALOG);
  url.searchParams.set('dataset', START.id);
  return url.toString();
}

/**
 * Record what the user is shown: every dataset name the panel publishes and
 * every notification with the type it ends in.
 */
export async function observePage(page) {
  const productErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      productErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    productErrors.push(`page: ${error.stack || error.message}`);
  });
  await page.addInitScript(() => {
    const record = window.__datasetLoadRecord = {
      names: [],
      notifications: new Map(),
    };
    document.addEventListener('DOMContentLoaded', () => {
      const name = document.getElementById('dataset-name');
      new MutationObserver(() => {
        const text = name.textContent;
        if (record.names.at(-1) !== text) record.names.push(text);
      }).observe(name, {
        characterData: true,
        childList: true,
        subtree: true,
      });
      const center = document.getElementById('notification-center');
      // A notification is known by the id it was published with. Dismissing
      // one takes the id off its element while it animates out, and keyed by
      // its current id that exiting card was a second notification with the
      // same text: on a runner slow enough that a success card's four
      // seconds ran out before the check, "announced once" counted two.
      const publishedIds = new WeakMap();
      const capture = () => {
        for (const node of center.querySelectorAll('.notification')) {
          if (!publishedIds.has(node)) publishedIds.set(node, node.id);
          const id = publishedIds.get(node);
          const type = node.dataset.type;
          const text = node.querySelector('.notification-content')
            ?.textContent.replace(/\s+/g, ' ').trim() ?? '';
          record.notifications.set(`${id}|${type}|${text}`, {
            id,
            text,
            type,
          });
        }
      };
      new MutationObserver(capture).observe(center, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
    });
  });
  return productErrors;
}

export async function readRecord(page) {
  return page.evaluate(() => ({
    names: [...window.__datasetLoadRecord.names],
    notifications: [...window.__datasetLoadRecord.notifications.values()],
  }));
}

/**
 * Hold requests matching `pattern` (a URL prefix or a regular expression)
 * until `release()`: every one, or with `when`, those the request predicate
 * accepts, and with `first`, only that many. The page may abort a held
 * request at any time; once released, nothing it aborted is answered.
 */
export async function holdRequests(page, pattern, { when = () => true, first = Infinity } = {}) {
  let release = () => {};
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const held = { release, started: 0, settled: 0 };
  const matches = url => (
    typeof pattern === 'string' ? url.startsWith(pattern) : pattern.test(url)
  );
  const holding = new Set();
  const settle = request => {
    if (holding.delete(request)) held.settled += 1;
  };
  page.context().on('requestfinished', settle);
  page.context().on('requestfailed', settle);
  await page.route(
    url => matches(url.toString()),
    async route => {
      if (held.started >= first || !when(route.request())) {
        await route.fallback().catch(() => {});
        return;
      }
      held.started += 1;
      holding.add(route.request());
      await gate;
      await route.fallback().catch(() => {});
    },
  );
  return held;
}

/** Let the held requests go and wait until every one of them has settled. */
export async function releaseAndDrain(page, held) {
  held.release();
  await expect.poll(async () => {
    const startedBefore = held.started;
    if (held.settled !== startedBefore) return false;
    await page.evaluate(() => new Promise(resolve => {
      setTimeout(() => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }, 0);
    }));
    return held.started === startedBefore && held.settled === startedBefore;
  }).toBe(true);
}

/** The bytes of one demo dataset's `.zarr.zip`. */
export function demoFile(target) {
  return readFileSync(path.join(demoCatalogDirectory, `${target.id}.zarr.zip`));
}

let openingHolds = 0;

/**
 * Hold the opening of one demo dataset, and nothing else, at the AnnData
 * reader worker: its first request to read the embedding it opens on
 * (`readEmbedding` of `target.embedding`) is kept from the worker until
 * `release()`. Only an opening reads an embedding -- a listing reads a
 * file's metadata -- so the hold does not depend on which network reads a
 * listing and an opening make, in what order, or from which transport (a
 * small archive is read whole by whichever comes first). The page may
 * supersede the held opening at any time; a superseded reader worker is
 * gone when the request is let through, and its answer is not awaited.
 *
 * @returns {Promise<{release: () => Promise<void>, started: number, settled: number}>}
 */
export async function holdOpening(page, target) {
  const binding = `__cellucidHeldOpening${openingHolds += 1}`;
  const held = { started: 0, settled: 0, release: () => Promise.resolve() };
  await page.exposeBinding(binding, (_source, event) => {
    if (event === 'start') held.started += 1;
    else held.settled += 1;
  });
  const install = ({ binding: name, embedding }) => {
    const post = Worker.prototype.postMessage;
    const waiting = [];
    let taken = false;
    let released = false;
    Worker.prototype.postMessage = function postMessage(message, ...rest) {
      if (
        !taken
        && message !== null
        && typeof message === 'object'
        && message.method === 'readEmbedding'
        && Array.isArray(message.args)
        && message.args[0] === embedding
      ) {
        taken = true;
        window[name]('start');
        const send = () => {
          post.call(this, message, ...rest);
          window[name]('settle');
        };
        if (released) send();
        else waiting.push(send);
        return undefined;
      }
      return post.call(this, message, ...rest);
    };
    window[`${name}Release`] = () => {
      released = true;
      for (const send of waiting.splice(0)) send();
    };
  };
  const options = { binding, embedding: target.embedding };
  // A page not yet navigated gets the hold with its document; one already
  // showing the app gets it now.
  if (page.url() === 'about:blank') await page.addInitScript(install, options);
  else await page.evaluate(install, options);
  held.release = () => page.evaluate(name => window[`${name}Release`](), binding);
  return held;
}

export async function openWithHeldStart(page) {
  const productErrors = await observePage(page);
  const held = await holdOpening(page, START);
  await page.goto(startUrl(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  // The startup dataset is in flight and every data control is live.
  await expect.poll(() => held.started).toBeGreaterThan(0);
  await expect(page.locator('#dataset-select')).toHaveValue(START.select);
  await expect(page.locator('#dataset-select')).toBeEnabled();
  await expect(page.locator('#user-data-h5ad-input')).toBeEnabled();
  await expect(page.locator('html')).not.toHaveAttribute(
    'data-startup-phase',
    'ready',
  );
  return { held, productErrors };
}

export async function openStarted(page) {
  const productErrors = await observePage(page);
  await page.goto(startUrl(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expectSettledOn(page, START);
  return productErrors;
}

/**
 * The dataset select, the dataset panel, the viewer and the startup phase all
 * describe `target`, and no load is still presented anywhere.
 */
export async function expectSettledOn(page, target) {
  await expect(page.locator('#dataset-name')).toHaveText(target.name);
  await expect(page.locator('#dataset-select')).toHaveValue(target.select);
  await expect
    .poll(() => page.evaluate(() => window._cellucidViewer.getPointCount()))
    .toBe(target.cells);
  await expect(page.locator('#dataset-cells')).toHaveText(
    target.cells === 0 ? '–' : String(target.cells),
  );
  await expect(page.locator('html')).toHaveAttribute(
    'data-startup-phase',
    'ready',
  );
  await expect(page.locator('#dataset-info')).not.toHaveClass(/\bloading\b/);
  await expect(
    page.locator(`#dataset-select option[value="${PENDING_OPTION}"]`),
  ).toHaveCount(0);
  await expect(
    page.locator(
      '#notification-center .notification[data-type="loading"], '
        + '#notification-center .notification[data-type="progress"]',
    ),
  ).toHaveCount(0);
}

/** The superseded dataset never reached the panel after `since` names. */
export async function expectNeverPublished(page, staleName, since = 0) {
  const { names } = await readRecord(page);
  expect(names.slice(since)).not.toContain(staleName);
}

export async function expectNoFailureAnnounced(page) {
  const { notifications } = await readRecord(page);
  expect(
    notifications.filter(entry => entry.type === 'error'),
  ).toEqual([]);
}

/** Exactly one notification matching `pattern` was shown (and stays one). */
export async function expectAnnouncedOnce(page, pattern) {
  const count = async () => {
    const { notifications } = await readRecord(page);
    return new Set(
      notifications
        .filter(entry => pattern.test(entry.text))
        .map(entry => entry.id),
    ).size;
  };
  await expect.poll(count).toBe(1);
}

export async function savedSessionFor(page, testInfo, target, label) {
  // A session belongs to the dataset it was saved from, so it is saved from
  // `target` after giving it a visible, restorable setting.
  if (target !== START) {
    await page.locator('#dataset-select').selectOption(target.select);
    await expectSettledOn(page, target);
  }
  await openCollapsedPanels(page);
  await page.locator('#background-select').selectOption('black');
  await expect(page.locator('#background-select')).toHaveValue('black');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const download = await downloadPromise;
  const sessionPath = testInfo.outputPath(`${label}.cellucid-session`);
  await download.saveAs(sessionPath);
  return sessionPath;
}

export async function chooseSessionFile(page, sessionPath) {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(sessionPath);
}

export { jsonResponse };

/**
 * Serve one demo dataset's `.zarr.zip` at `url`, as a web host serves a
 * file (`HEAD`, `Range`).
 */
export async function serveDemoFile(page, url, target) {
  const bytes = demoFile(target);
  await page.route(url, route => fulfillFile(route, bytes));
}

/**
 * A Cellucid server on the sample origin that serves one dataset. With
 * `webSocketPort`, it also advertises its update socket on that port; the
 * returned `closeSocket()` then drops the connection the way a stopped
 * server does.
 */
export async function serveOneDatasetRemote(
  page,
  target,
  { holdCatalog = null, webSocketPort = null } = {},
) {
  let serverSocket = null;
  if (webSocketPort !== null) {
    await page.routeWebSocket(`ws://${APP_HOST}:${webSocketPort}/`, socket => {
      serverSocket = socket;
    });
  }
  await serveAnnDataServer(page, SAMPLE_ORIGIN, {
    ...target,
    file: path.join(demoCatalogDirectory, `${target.id}.zarr.zip`),
  }, {
    info: {
      host: APP_HOST,
      port: SAMPLE_PORT,
      ...(webSocketPort === null ? {} : { ws_port: webSocketPort }),
    },
    holdDatasets: holdCatalog,
  });
  return Object.freeze({
    socketOpened: () => serverSocket !== null,
    closeSocket: () => serverSocket.close({ code: 1011, reason: 'server stopped' }),
  });
}
