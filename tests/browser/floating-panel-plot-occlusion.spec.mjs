import { writeFile } from 'node:fs/promises';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { expectFloatingSettled } from './helpers/panels.mjs';

/* A floating panel must never take the plot away from somewhere it does not
   cover.

   A panel whose content overflows has a scroller of its own, and that scroller
   is an opaque compositor layer. While it sat directly over the WebGL canvas,
   Chromium's software compositor culled the canvas under it at the vertically
   mirrored position (the canvas texture is bottom-left origin, and the culled
   part of it was drawn flipped), so the page background showed through at the
   scroller's mirror image across the canvas centre: a band under the Session
   panel, the same width as the panel, until the panel was docked again. The
   canvas's own pixels were right all along; only what reached the screen was
   wrong. `_accordion.css` now composites each floating window as one surface,
   so none of its layers occludes the plot.

   The check is therefore the screen against the canvas: a viewport screenshot
   of the region that went missing must show the canvas's own pixels. A crop
   (`screenshot({ clip })`) is a separately composited capture and is not used.
   The canvas keeps its drawing buffer (`preserveDrawingBuffer`), so it can be
   read back after the screenshot. */

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=floating-panel-plot-occlusion-ci';

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

function frameOf(page, panelId) {
  return page.locator(`.accordion-panel:has(> #${panelId})`);
}

async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  await page.evaluate(() => {
    for (const button of document.querySelectorAll('.notification-dismiss')) {
      button.click();
    }
  });
}

async function undock(page, panelId, edge = 's') {
  const frame = frameOf(page, panelId);
  await page.evaluate(id => { document.getElementById(id).open = true; }, panelId);
  await frame.locator('> .accordion-panel-actions > .accordion-undock-btn').click();
  // The region beside the frame is measured from its box and its card's
  // shadow, so both must be the settled ones: read during the lift, the box
  // was up to 4 % short and the shadow `--shadow-sm`/`--shadow-md` instead of
  // `--shadow-lg`, and the region then ran under the frame (WebKit: the panel
  // "covers" it) or under the tail of its final shadow (Firefox, Chromium:
  // the region's top device rows three levels dark).
  await expectFloatingSettled(frame);
  // The panel only has a scroller of its own, and so only ever lost the plot,
  // when its content overflows the window. A panel opens as tall as its
  // content, so it is made shorter from one edge, 16 px a key, until it
  // overflows and lies within its half of the plot (where its mirror image
  // is): the bottom edge for a panel in the top half, the top edge for one
  // in the lower half.
  const content = frame.locator('.accordion-content');
  const ready = () => frame.evaluate((element, fromBottom) => {
    const inner = element.querySelector('.accordion-content');
    const box = element.getBoundingClientRect();
    const middle = window.innerHeight / 2;
    const inHalf = fromBottom ? box.bottom < middle : box.top > middle;
    return inner.scrollHeight > inner.clientHeight && inHalf;
  }, edge === 's');
  const handle = frame.locator(`> .accordion-resize-handle[data-edge="${edge}"]`);
  await handle.focus();
  for (let press = 0; press < 80 && !(await ready()); press++) {
    await page.keyboard.press(edge === 's' ? 'ArrowUp' : 'ArrowDown');
  }
  expect(await ready()).toBe(true);
  expect(await content.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  // Away from the handle, so its focus ring is not in the comparison.
  await page.evaluate(() => document.activeElement?.blur());
}

/**
 * The plot region beside a floating frame, on the side of its mirror image
 * across the canvas centre: below a frame in the top half of the canvas,
 * above one in the bottom half. Kept clear of the frame's shadow and of the
 * viewport edges.
 *
 * The shadow's reach is read from the frame and its card, not assumed. CSS
 * defines a blur radius as a Gaussian of standard deviation half that radius,
 * and engines draw it out to three deviations (1.5 blur radii), where it is
 * below one level; the radius itself is only two deviations. A fixed 24 px
 * did not clear the card's `--shadow-lg` (6 px down, 16 px blur) everywhere:
 * on Linux WebKit the region's top three device rows were its tail, three
 * levels darker than the plot, a constant mismatch however long it waited.
 */
async function regionBeside(frame) {
  return frame.evaluate(element => {
    const box = element.getBoundingClientRect();
    const plot = document.getElementById('glcanvas').getBoundingClientRect();
    // Reflecting a y across the canvas centre gives `mirror - y`.
    const mirror = plot.top + plot.bottom;
    const below = box.top + box.bottom < mirror;
    // How far outside the frame any outset shadow of it or its card reaches.
    let reach = 0;
    for (const caster of [element, ...element.children]) {
      const shadows = getComputedStyle(caster).boxShadow;
      if (shadows === 'none') continue;
      // Each layer is a colour and then its lengths, `x y blur spread`.
      for (const layer of shadows.split(/,(?![^(]*\))/)) {
        if (/\binset\b/.test(layer)) continue;
        const [x = 0, y = 0, blur = 0, spread = 0] = (
          layer.replace(/(rgba?|hsla?|color)\([^)]*\)/g, '').match(/-?[\d.]+px/g) ?? []
        ).map(Number.parseFloat);
        const extent = spread + 1.5 * blur;
        reach = Math.max(reach, Math.abs(x) + extent, Math.abs(y) + extent);
      }
    }
    const margin = Math.ceil(reach) + 2;
    const top = below ? box.bottom + margin : Math.max(plot.top + 8, mirror - box.bottom);
    const bottom = below ? Math.min(plot.bottom - 8, mirror - box.top) : box.top - margin;
    return {
      x: Math.round(box.left + margin),
      y: Math.round(top),
      width: Math.round(box.width - 2 * margin),
      height: Math.round(Math.min(80, bottom - top)),
    };
  });
}

/**
 * Compares a viewport screenshot with the canvas's own pixels over `region`
 * (CSS pixels) and returns the fraction of device pixels that differ.
 */
async function screenMismatch(page, region) {
  expect(region.width).toBeGreaterThan(100);
  expect(region.height).toBeGreaterThan(40);
  const shot = await page.screenshot();
  return page.evaluate(async ({ png, region }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const scale = image.width / window.innerWidth;
    const x = Math.round(region.x * scale);
    const y = Math.round(region.y * scale);
    const width = Math.round(region.width * scale);
    const height = Math.round(region.height * scale);

    // Only the compared region is drawn and read back: a full-size surface
    // per source is two viewport-sized fills and reads at deviceScaleFactor 2,
    // seconds of main-thread work on a hosted runner, for pixels never looked
    // at. `draw` maps a region of the screenshot's device pixels onto the
    // surface's origin.
    const pixels = draw => {
      const surface = document.createElement('canvas');
      surface.width = width;
      surface.height = height;
      const context = surface.getContext('2d', { willReadFrequently: true });
      draw(context);
      return { surface, data: context.getImageData(0, 0, width, height).data };
    };
    const plot = document.getElementById('glcanvas');
    const box = plot.getBoundingClientRect();
    // Nothing but the plot may be in front of the region being compared.
    for (const [px, py] of [
      [region.x, region.y],
      [region.x + region.width, region.y],
      [region.x, region.y + region.height],
      [region.x + region.width, region.y + region.height],
      [region.x + region.width / 2, region.y + region.height / 2],
    ]) {
      const hit = document.elementsFromPoint(px, py)
        .find(element => element.id !== 'lasso-overlay');
      if (hit !== plot) return { error: `${hit?.id || hit?.className} covers ${px},${py}` };
    }
    const screenCrop = pixels(context => context.drawImage(
      image,
      x,
      y,
      width,
      height,
      0,
      0,
      width,
      height,
    ));
    // The plot's drawing buffer is placed where it sits on the screen, then
    // shifted so the region's corner lands on the surface's origin.
    const canvasCrop = pixels(context => context.drawImage(
      plot,
      box.left * scale - x,
      box.top * scale - y,
      box.width * scale,
      box.height * scale,
    ));
    const screen = screenCrop.data;
    const canvas = canvasCrop.data;
    let differing = 0;
    for (let index = 0; index < screen.length; index += 4) {
      const delta = Math.max(
        Math.abs(screen[index] - canvas[index]),
        Math.abs(screen[index + 1] - canvas[index + 1]),
        Math.abs(screen[index + 2] - canvas[index + 2]),
      );
      // The plot's own background is a few levels off the page's, so a
      // missing plot differs from the canvas by little more than that.
      if (delta > 2) differing++;
    }
    const fraction = differing / (screen.length / 4);
    // A mismatch carries both crops, so a failure shows which pixels differ.
    return fraction < 0.01
      ? { fraction }
      : {
          fraction,
          screen: screenCrop.surface.toDataURL('image/png'),
          canvas: canvasCrop.surface.toDataURL('image/png'),
        };
  }, { png: shot.toString('base64'), region });
}

async function expectPlotShownBeside(page, panelId) {
  const region = await regionBeside(frameOf(page, panelId));
  // The plot settles (a sidebar slide, the frame after a layout change), and
  // the screenshot and the read-back must catch the same frame. The poll keeps
  // the suite's expect timeout: one comparison is a full-viewport screenshot
  // at deviceScaleFactor 2 and a read-back of the plot, and on hosted macOS
  // Firefox that single comparison took 36 s and found no mismatch at all,
  // after a fixed fifteen-second poll had already expired.
  let last = null;
  try {
    await expect.poll(async () => {
      last = await screenMismatch(page, region);
      return last.error ?? last.fraction;
    }).toBeLessThan(0.01);
  } catch (error) {
    // Written to the test's output directory (not attached as an in-memory
    // body, which only a reporter keeps), so CI uploads them with the rest
    // of the failure evidence.
    for (const source of ['screen', 'canvas']) {
      if (typeof last?.[source] !== 'string') continue;
      const file = test.info().outputPath(`${panelId}-${source}.png`);
      await writeFile(file, Buffer.from(last[source].split(',')[1], 'base64'));
      await test.info().attach(`${panelId}-${source}.png`, { path: file, contentType: 'image/png' });
    }
    throw error;
  }
}

// One test per sidebar state, each undocking the panel first, so the closed
// case still slides the sidebar away from under a floating panel. Together
// they were two full-viewport comparisons at deviceScaleFactor 2 in one test,
// more than one test's time on a runner that renders in software.
for (const sidebar of ['open', 'closed']) {
  test(`the plot shows below an undocked panel, with the sidebar ${sidebar}`, async ({
    page,
  }) => {
    await openDataset(page);
    await undock(page, 'session-section');
    if (sidebar === 'closed') {
      await page.locator('#sidebar-toggle').click();
      await expect(page.locator('#sidebar')).toHaveClass(/\bhidden\b/);
    }
    await expectPlotShownBeside(page, 'session-section');
  });
}

test('the plot shows above an undocked panel in the lower half', async ({
  page,
}) => {
  await openDataset(page);
  await undock(page, 'visualization-section', 'n');
  const frame = frameOf(page, 'visualization-section');
  const box = await frame.boundingBox();
  expect(box.y + box.height / 2).toBeGreaterThan(450);
  await expectPlotShownBeside(page, 'visualization-section');
});
