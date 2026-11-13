/**
 * The page of a viewer that Python or R opened, as its host sees it and as the
 * person sees it: a hover and a click on a cell reach the host as the host's
 * cell, and the host stopping the viewer leaves one still picture of the last
 * view with the reason on it, a page that takes no more pointer input, and an
 * application that has let go of its renderer.
 *
 * The host is played on the page's own origin (`serveAnnDataServer`): it
 * serves one dataset, answers the viewer channel, records what the viewer
 * sends, and sends the viewer its own messages.
 */
import path from 'node:path';

import { expect, test } from './helpers/test.mjs';
import { serveAnnDataServer } from './helpers/anndata-server.mjs';
import { APP_ORIGIN, appUrl } from './helpers/origins.mjs';
import {
  START,
  UNLISTED_OPTION,
  demoCatalogDirectory,
  expectSettledOn,
  observePage,
} from './helpers/dataset-loading.mjs';

function viewerHostUrl() {
  const url = new URL('/', appUrl('/'));
  url.searchParams.set('viewer', 'true');
  url.searchParams.set('viewerId', 'viewer-1');
  url.searchParams.set('viewerToken', 'token-1');
  return url.toString();
}

/** A point of the canvas that shows a cell, and that cell's index. */
async function findCellPoint(page) {
  const found = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const box = document.getElementById('glcanvas').getBoundingClientRect();
    for (let y = Math.ceil(box.top) + 2; y < box.bottom - 2; y += 3) {
      for (let x = Math.ceil(box.left) + 2; x < box.right - 2; x += 3) {
        const cell = viewer.pickCellAtScreen(x, y);
        if (cell >= 0) return { x, y, cell };
      }
    }
    return null;
  });
  expect(found).not.toBeNull();
  return found;
}

const sentOfType = (events, type) => events.filter(event => event?.type === type);

test('a host viewer sends hover and click as the host\'s cells, and a stop leaves its last picture', async ({
  page,
}) => {
  const productErrors = await observePage(page);
  const host = await serveAnnDataServer(page, APP_ORIGIN, {
    ...START,
    file: path.join(demoCatalogDirectory, `${START.id}.zarr.zip`),
  }, { viewerHost: true, hostEvents: ['ready', 'hover', 'click'] });
  await page.goto(viewerHostUrl(), { waitUntil: 'domcontentloaded' });
  await expectSettledOn(page, { ...START, select: UNLISTED_OPTION });
  await expect.poll(() => sentOfType(host.events, 'ready').length).toBe(1);

  const point = await findCellPoint(page);

  await test.step('a hover on a cell, then off the canvas, reaches the host', async () => {
    await page.mouse.move(point.x, point.y);
    await expect.poll(() => sentOfType(host.events, 'hover').at(-1)?.cell ?? null).toBe(point.cell);
    const hovered = sentOfType(host.events, 'hover').at(-1);
    for (const axis of ['x', 'y', 'z']) expect(Number.isFinite(hovered.position[axis])).toBe(true);
    // Leaving the canvas says no cell is hovered.
    await page.locator('#glcanvas').dispatchEvent('mouseleave');
    await expect.poll(() => sentOfType(host.events, 'hover').at(-1)).toEqual({
      type: 'hover', cell: null, position: null,
    });
  });

  await test.step('a click on a cell reaches the host with its button and keys', async () => {
    await page.keyboard.down('Shift');
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Shift');
    await expect.poll(() => sentOfType(host.events, 'click')).toEqual([{
      type: 'click', cell: point.cell, button: 0, shift: true, ctrl: false,
    }]);
  });

  await test.step('the host stopping the viewer leaves its last view, said on it', async () => {
    host.send({ type: 'freeze' });
    const overlay = page.locator('#cellucid-viewer-host-freeze-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('img[alt="The last view of the stopped viewer"]')).toHaveCount(1);
    await expect(page.locator('#cellucid-viewer-host-freeze-caption strong')).toHaveText('Viewer stopped');
    await expect(page.locator('#notification-center .notification-error')).toContainText('Viewer stopped');
    // The application lets go of its renderer: one picture is all it holds.
    await expect.poll(() => page.evaluate(() => window._cellucidViewer.isDisposed())).toBe(true);
  });

  await test.step('the stopped viewer takes no more pointer input', async () => {
    // The canvas's listeners run as the event is dispatched: a frozen view
    // asks the viewer for no cell, so it neither sends nor fails.
    const answered = await page.evaluate(({ x, y }) => {
      const viewer = window._cellucidViewer;
      const canvas = document.getElementById('glcanvas');
      let picks = 0;
      viewer.pickCellRecordAtScreen = () => { picks += 1; return null; };
      for (const type of ['mousemove', 'click']) {
        canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
      }
      return picks;
    }, point);
    expect(answered).toBe(0);
  });

  expect(productErrors).toEqual([]);
});
