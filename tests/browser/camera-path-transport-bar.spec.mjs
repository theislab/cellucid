import { expect, test } from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import {
  TRANSPORT_BAR_HIDE_DELAY_MS,
} from '../../assets/js/app/ui/modules/cinematic-camera/transport-bar.js';

const PREPARED_DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=camera-transport-ci`;

/* The assertions below straddle the product's own idle deadline. A margin of a
   fifth of it on either side of every boundary is far larger than input
   delivery latency, and a loaded runner can only make the product's timer fire
   later, never earlier. */
const STRADDLE_MARGIN_MS = Math.ceil(TRANSPORT_BAR_HIDE_DELAY_MS / 5);
// Timer and performance.now() rounding differ by engine; a hide is "early"
// only when it lands more than this before the deadline.
const TIMER_ROUNDING_TOLERANCE_MS = 50;

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      errors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return errors;
}

async function openCameraPathWithTwoKeyframes(page) {
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );
  await page.locator('#cinematic-camera-section > summary').click();
  await page.locator('#cinematic-save-btn').click();
  await page.locator('#cinematic-save-btn').click();
  await expect(page.locator('.cinematic-keyframe-item')).toHaveCount(2);
  await expect(page.locator('.cinematic-transport-bar')).toHaveCount(1);
}

test('the transport bar occupies a bounded strip and leaves the rest of the viewport clickable', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await openCameraPathWithTwoKeyframes(page);
  await expect(page.locator('.cinematic-transport-bar')).toHaveClass(/visible/);

  const layout = await page.evaluate(() => {
    const bar = document.querySelector('.cinematic-transport-bar');
    const inner = document.querySelector('.cinematic-transport-inner');
    const barBox = bar.getBoundingClientRect();
    const innerBox = inner.getBoundingClientRect();
    const sidebar = document.getElementById('sidebar').getBoundingClientRect();
    return {
      trackWidth: barBox.width,
      barWidth: innerBox.width,
      barLeft: innerBox.left,
      barRight: innerBox.right,
      barTop: innerBox.top,
      barHeight: innerBox.height,
      sidebarRight: sidebar.right,
      viewportWidth: window.innerWidth
    };
  });

  // The visible bar is a bounded strip, not the full viewport width.
  expect(layout.barWidth).toBeLessThanOrEqual(620);
  expect(layout.barWidth).toBeLessThan(layout.trackWidth);
  expect(layout.barWidth).toBeLessThan(layout.viewportWidth * 0.6);
  // It never overlaps the sidebar.
  expect(layout.barLeft).toBeGreaterThan(layout.sidebarRight);

  // The positioning track spans the viewport so the bar can centre inside it.
  // It must stay transparent to the pointer, or it swallows canvas clicks.
  const hitTests = await page.evaluate((box) => {
    const y = Math.round(box.barTop + box.barHeight / 2);
    const at = (x) => {
      const element = document.elementFromPoint(Math.round(x), y);
      return element === null
        ? null
        : {
          id: element.id,
          classes: element.getAttribute('class'),
          insideBar: element.closest('.cinematic-transport-bar') !== null
        };
    };
    return {
      rightOfBar: at(box.barRight + 30),
      leftOfBar: at(box.barLeft - 30),
      onBar: at(box.barLeft + 15)
    };
  }, layout);

  expect(hitTests.rightOfBar.insideBar).toBe(false);
  expect(hitTests.leftOfBar.insideBar).toBe(false);
  expect(hitTests.onBar.insideBar).toBe(true);

  expect(productErrors).toEqual([]);
});

test('sidebar work keeps the transport bar alive, and idle time still retires it', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await openCameraPathWithTwoKeyframes(page);
  const bar = page.locator('.cinematic-transport-bar');
  await expect(bar).toHaveClass(/visible/);

  const sidebarPoint = await page.evaluate(() => {
    const box = document.getElementById('cinematic-save-btn').getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  });

  // Working in the sidebar is activity: the Camera Path accordion that feeds
  // this bar lives there. The last activity before this point is the second
  // keyframe save. One sidebar move part-way through the countdown, then a
  // check past the point where the *unrenewed* countdown would have expired,
  // proves the move re-armed it: without the renewal the bar is already gone.
  const renewAfterMs = TRANSPORT_BAR_HIDE_DELAY_MS - STRADDLE_MARGIN_MS * 2;
  await page.waitForTimeout(renewAfterMs);
  await expect(bar).toHaveClass(/visible/);
  await page.mouse.move(sidebarPoint.x + 1, sidebarPoint.y + 1);
  await page.waitForTimeout(STRADDLE_MARGIN_MS * 3);
  await expect(bar).toHaveClass(/visible/);

  // A pointer resting on the bar itself holds it open past the deadline.
  await page.locator('.cinematic-transport-inner').hover();
  await page.waitForTimeout(TRANSPORT_BAR_HIDE_DELAY_MS + STRADDLE_MARGIN_MS);
  await expect(bar).toHaveClass(/visible/);

  // Move the pointer off every surface and let it go idle. Timestamp the last
  // activity the product sees and the moment the bar actually retires, in the
  // page's own clock: it must survive the full deadline and then retire.
  await page.evaluate(() => {
    const target = document.querySelector('.cinematic-transport-bar');
    const probe = { lastActivityAt: null, retiredAt: null };
    const markActivity = () => {
      probe.lastActivityAt = performance.now();
    };
    document.addEventListener('mousemove', markActivity, { passive: true });
    document.addEventListener('mouseleave', markActivity, { capture: true });
    new MutationObserver((records, observer) => {
      if (!target.classList.contains('visible')) {
        probe.retiredAt = performance.now();
        observer.disconnect();
        document.removeEventListener('mousemove', markActivity);
        document.removeEventListener('mouseleave', markActivity, { capture: true });
      }
    }).observe(target, { attributes: true, attributeFilter: ['class'] });
    window.__cellucidTransportIdleProbe = probe;
  });
  await page.mouse.move(
    Math.round(page.viewportSize().width / 2),
    page.viewportSize().height - 20
  );
  await expect(bar).not.toHaveClass(/visible/);
  const idle = await page.evaluate(() => window.__cellucidTransportIdleProbe);
  expect(idle.lastActivityAt).not.toBeNull();
  expect(idle.retiredAt).not.toBeNull();
  expect(idle.retiredAt - idle.lastActivityAt).toBeGreaterThanOrEqual(
    TRANSPORT_BAR_HIDE_DELAY_MS - TIMER_ROUNDING_TOLERANCE_MS
  );

  expect(productErrors).toEqual([]);
});

test('navigation lives in its own panel, and Camera Path follows it', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  // One mode select, in the Navigation panel; Camera Path carries no copy.
  await expect(page.locator('#navigation-section #navigation-mode')).toHaveCount(1);
  await expect(page.locator('#cinematic-camera-section select#cinematic-nav-mode')).toHaveCount(0);

  // Each mode reveals exactly its own settings box.
  const panels = {
    orbit: '#orbit-controls',
    planar: '#planar-controls',
    free: '#freefly-controls'
  };
  for (const mode of Object.keys(panels)) {
    await page.locator('#navigation-mode').selectOption(mode);
    for (const [other, selector] of Object.entries(panels)) {
      await expect(page.locator(selector)).toBeVisible({ visible: other === mode });
    }
  }

  // A keyframe saved in one mode brings the panel back to that mode on Go to.
  await page.locator('#navigation-mode').selectOption('free');
  await page.locator('#cinematic-camera-section > summary').click();
  await page.locator('#cinematic-save-btn').click();
  await page.locator('#navigation-mode').selectOption('planar');
  await page.locator('#cinematic-keyframe-list [data-action="goto"]').first().click();
  await expect(page.locator('#navigation-mode')).toHaveValue('free');
  await expect(page.locator('#freefly-controls')).toBeVisible();

  // The camera-path tip explains keyframes and points at the docs.
  await page.locator('#camera-path-info-btn').click();
  const tip = page.locator('#camera-path-info-tooltip');
  await expect(tip).toContainText('With two or more, a playback bar appears');
  await expect(tip.locator('a.info-tip-link')).toHaveAttribute(
    'href',
    /^https:\/\/docs\.cellucid\.com\/en\/latest\/user_guide\/web_app\/c_core_interactions\/02_camera_controls_advanced\.html#camera-path-playback-is-opt-in$/
  );

  expect(productErrors).toEqual([]);
});

test('keyframe list editing is keyboard operable, rejects bad durations, and keeps focus', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await openCameraPathWithTwoKeyframes(page);
  const items = page.locator('.cinematic-keyframe-item');

  // A duration below 0.1 s is reported on the field and nothing is stored;
  // there is no longest duration.
  const duration = page.locator('.cinematic-duration-input[data-pair-index="0"]');
  await duration.fill('0.05');
  await duration.press('Tab');
  await expect(duration).toHaveValue('');
  expect(await duration.evaluate(input => input.validationMessage))
    .toMatch(/at least 0\.1 seconds/);
  await duration.fill('500');
  await duration.press('Tab');
  await expect(page.locator('.cinematic-duration-input[data-pair-index="0"]'))
    .toHaveValue('500');
  await duration.fill('2.5');
  await duration.press('Tab');
  await expect(page.locator('.cinematic-duration-input[data-pair-index="0"]'))
    .toHaveValue('2.5');

  const setAll = page.locator('#cinematic-set-all-duration');
  await setAll.fill('0');
  await page.locator('#cinematic-set-all-btn').click();
  await expect(setAll).toHaveValue('');
  expect(await setAll.evaluate(input => input.validationMessage))
    .toMatch(/at least 0\.1 seconds/);
  await expect(page.locator('.cinematic-duration-input[data-pair-index="0"]'))
    .toHaveValue('2.5');

  // Rename is a real button: Enter starts editing, Enter commits, and focus
  // returns to the renamed keyframe's label after the list rebuilds.
  const firstLabel = items.first().locator('.cinematic-keyframe-label');
  await expect(firstLabel).toHaveRole('button');
  await firstLabel.focus();
  await page.keyboard.press('Enter');
  const rename = items.first().locator('.cinematic-keyframe-rename');
  await expect(rename).toBeFocused();
  await rename.fill('Opening shot');
  await rename.press('Enter');
  await expect(items.first().locator('.cinematic-keyframe-label'))
    .toHaveText('Opening shot');
  await expect(items.first().locator('.cinematic-keyframe-label'))
    .toBeFocused();

  // Escape abandons the edit and keeps focus on the label.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(items.first().locator('.cinematic-keyframe-rename')).toHaveCount(0);
  await expect(items.first().locator('.cinematic-keyframe-label')).toBeFocused();

  // Reordering rebuilds the list; focus follows the moved keyframe's control.
  await items.first().locator('[data-action="down"]').focus();
  await page.keyboard.press('Enter');
  await expect(items.nth(1).locator('.cinematic-keyframe-label'))
    .toHaveText('Opening shot');
  await expect(items.nth(1).locator('[data-action="up"]')).toBeFocused();

  expect(productErrors).toEqual([]);
});

test('the shown transport bar never covers a multiview title chip', async ({
  page
}) => {
  // Each multiview cell centres its title chip 20px below the top of the plot,
  // which is exactly the strip the transport bar occupies. With a camera path
  // and two views the bar used to sit on the second view's chip, hiding its
  // name and taking the click that focuses that view.
  const productErrors = observeProductErrors(page);
  await openCameraPathWithTwoKeyframes(page);
  await page.locator('#split-keep-view-btn').click();
  const chips = page.locator('.view-title-chip');
  await expect(chips).toHaveCount(2);

  const bar = page.locator('.cinematic-transport-bar');
  await page.mouse.move(900, 500);
  await expect(bar).toHaveClass(/visible/);

  const overlaps = async () => page.evaluate(() => {
    const inner = document.querySelector('.cinematic-transport-inner')
      .getBoundingClientRect();
    return [...document.querySelectorAll('.view-title-chip')].map(chip => {
      const box = chip.getBoundingClientRect();
      return box.left < inner.right && box.right > inner.left &&
        box.top < inner.bottom && box.bottom > inner.top;
    });
  });
  await expect.poll(overlaps).toEqual([false, false]);

  // Every chip stays the topmost element at its own centre, so it is clickable.
  const topmost = await page.evaluate(() =>
    [...document.querySelectorAll('.view-title-chip')].map(chip => {
      const box = chip.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      return hit === chip;
    }));
  expect(topmost).toEqual([true, true]);
  expect(productErrors).toEqual([]);
});
