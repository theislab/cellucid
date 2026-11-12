import { expect } from './test.mjs';

/**
 * The browser tests' default catalog listing, instead of `current-ui`, the
 * file beside it with the same cells and a vector field on their UMAP
 * (`fixtures/catalog/current-ui-vector.h5ad`: `velocity_umap_2d`, bound by
 * default; `scripts/generate-browser-catalog-fixtures.py`).
 */
export const VECTOR_DATASET = Object.freeze({
  id: 'current-ui-vector',
  name: 'Current UI vector fixture',
});

export async function listVectorDataset(page) {
  await page.route('**/tests/browser/fixtures/catalog/datasets.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schema: 2,
      default: VECTOR_DATASET.id,
      datasets: [{ id: VECTOR_DATASET.id, path: `${VECTOR_DATASET.id}.h5ad` }],
    }),
  }));
}

/**
 * Watch the velocity overlay's next build, from before the action that
 * starts it. Its card ("Preparing velocity overlay…") is held back for its
 * first second (`NOTICE_AFTER_MS`, notification-center.js), and a build that
 * ends sooner ends without a card or a "Velocity overlay ready" success: the
 * particles appearing say it. Built is either way the card went: completed
 * as ready, or removed without failing. Cards present before the watch
 * (an earlier build's failure) are not this build.
 */
export async function watchVelocityBuild(page) {
  await page.evaluate(() => {
    const center = document.getElementById('notification-center');
    const before = new Set(center.querySelectorAll('.notification'));
    const cards = new Set();
    const build = { started: false, built: false, failed: false };
    window.__cellucidVelocityBuild = build;
    const look = () => {
      for (const card of center.querySelectorAll('.notification')) {
        if (!before.has(card) && /velocity overlay/i.test(card.textContent)) cards.add(card);
      }
      build.started = cards.size > 0;
      for (const card of cards) {
        const message = card.querySelector('.notification-message')?.textContent.trim() ?? '';
        if (card.dataset.type === 'error') build.failed = true;
        else if (message.startsWith('Velocity overlay ready') || !card.isConnected) build.built = true;
      }
    };
    new MutationObserver(look).observe(center, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  });
}

/** The build watched by `watchVelocityBuild` ended, and did not fail. */
export async function expectVelocityBuilt(page) {
  await expect.poll(
    () => page.evaluate(() => ({ ...window.__cellucidVelocityBuild })),
    { message: 'the velocity overlay builds' },
  ).toEqual({ started: true, built: true, failed: false });
}
