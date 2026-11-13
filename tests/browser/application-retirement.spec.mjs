import { expect, test } from './helpers/test.mjs';

import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}` +
  '&dataset=current-ui&acceptance=application-retirement-ci';

test.beforeEach(async ({ page }) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
});

// One opening: the page first survives a pagehide that keeps it (the
// back-forward cache), then an ordinary one retires it.
test('a persisted pagehide keeps the application, an ordinary one retires it whole', async ({
  page,
}) => {
  await test.step('a persisted pagehide preserves the live application generation', async () => {
    const proof = await page.evaluate(() => {
      const viewer = window._cellucidViewer;
      window.dispatchEvent(new PageTransitionEvent('pagehide', {
        persisted: true,
      }));
      return {
        disposed: viewer.isDisposed(),
        pointCount: viewer.getPointCount(),
      };
    });

    expect(proof).toEqual({
      disposed: false,
      pointCount: 120,
    });
  });

  await test.step('an ordinary pagehide owns one complete application teardown', async () => {
    // The event alone retires the application: nothing here asks for its
    // teardown, so a page whose pagehide did not retire it stays live.
    const disposedByTheEvent = await page.evaluate(() => {
      const viewer = window._cellucidViewer;
      window.dispatchEvent(new PageTransitionEvent('pagehide', {
        persisted: false,
      }));
      return viewer.isDisposed();
    });
    expect(disposedByTheEvent).toBe(true);
    // Its teardown runs to the end: every owner's asynchronous part too.
    await expect.poll(() => page.evaluate(() => window._cellucidViewer.isDisposalSettled())).toBe(true);

    const proof = await page.evaluate(() => {
      const viewer = window._cellucidViewer;
      let guardedError = null;
      try {
        viewer.getPointCount();
      } catch (error) {
        guardedError = {
          name: error?.name ?? null,
          message: error?.message ?? String(error),
        };
      }
      return { guardedError };
    });
    expect(proof.guardedError?.name).toMatch(/Error/);
    expect(proof.guardedError?.message).toMatch(/dispose\(\)/i);
  });

  await test.step('what the start-up wired outside the viewer is withdrawn with it', async () => {
    // The page outlives the application: what the start-up wired on it no
    // longer answers. The graphics-reset dialog's Save session
    // (`graphics-reset-session.js`) would say that no session was captured;
    // the connectivity color would be set on a viewer that is gone.
    const answered = await page.evaluate(async () => {
      const save = document.getElementById('graphics-reset-save');
      const color = document.getElementById('connectivity-color');
      if (save === null || color === null) throw new Error('The page lacks Save session or the edge color.');
      const before = document.querySelectorAll('.notification-error').length;
      const thrown = [];
      const onError = event => thrown.push(event.message);
      window.addEventListener('error', onError);
      try {
        save.click();
        color.dispatchEvent(new Event('input'));
      } finally {
        window.removeEventListener('error', onError);
      }
      // Save's answer is a rejected write, said in a microtask: one task
      // later it has been said or never will be.
      await new Promise(resolve => setTimeout(resolve, 0));
      return { notices: document.querySelectorAll('.notification-error').length - before, thrown };
    });
    expect(answered).toEqual({ notices: 0, thrown: [] });
  });
});
