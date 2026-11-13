/**
 * A spatial tree asked for while this browser is offline: the worker that
 * builds it cannot load its code. The failure says so, once (not "unknown
 * error", and not again at every frame), the worker is retired instead of
 * swallowing every later build, and the tree is built once the browser is
 * online again (`high-perf-renderer.js` `_requestSpatialIndex`,
 * `workers/worker-failure.js`).
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { waitForPageAtRest } from './helpers/dataset-ready.mjs';
import { goOffline } from './helpers/offline.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui`;

const hasTree = page => page.evaluate(() => {
  const viewer = window._cellucidViewer;
  return viewer.getHPRenderer().hasSpatialIndex(viewer.getViewDimension('live'));
});

const frames = (page, count) => page.evaluate(n => new Promise(resolve => {
  const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), count);

test('a tree asked for offline says its code could not be loaded, once, and is built once online', async ({ page, context }) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  // The opening is over before the link goes: a read of it still under way
  // (its gene list) would fail offline on its own, beside the tree's.
  await waitForPageAtRest(page);
  expect(await hasTree(page)).toBe(false);

  await goOffline(context);
  // Culling draws from the tree: the next frame asks for it.
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    viewer.setFrustumCulling(true);
    viewer.resume();
  });
  const failure = page.locator('#notification-center .notification-error');
  await expect(failure).toHaveCount(1);
  await expect(failure).toContainText(
    'Background spatial index worker failed: its code could not be loaded: this browser is offline',
  );
  // Asked again by every frame while offline, and not built again.
  await page.evaluate(() => window._cellucidViewer.resume());
  await frames(page, 10);
  await expect(failure).toHaveCount(1);
  expect(await hasTree(page)).toBe(false);

  await context.setOffline(false);
  await page.evaluate(() => window._cellucidViewer.resume());
  await expect.poll(() => hasTree(page), { timeout: 60_000 }).toBe(true);
  await expect(failure).toHaveCount(1);
});
