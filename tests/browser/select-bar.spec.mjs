/**
 * The selection bar: Select mode on the plot.
 *
 * On a phone the menu covers the whole screen, so it is closed while
 * selecting. Without the bar, a selection made with the lone Select mode pill
 * could not be confirmed, discarded, combined, or cleared without opening the
 * menu again, and a tap on empty space said nothing. The bar holds
 * all of that, as second surfaces of the Highlighting panel's own controls.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openPhoneSheet } from './helpers/panels.mjs';
import { readyForGesture } from './helpers/selection-gesture.mjs';
import { whenActionsShown } from './helpers/dataset-ready.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=select-bar-ci';

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  return errors;
}

async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  // A phone starts with the panel as its peek bar; its controls are used open.
  await openPhoneSheet(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  // An annotation press reads the pressed pane's field from the state, so
  // the field is live for Alt+click once the state holds it.
  await expect.poll(
    () => page.evaluate(() => window._cellucidState.getActiveField()?.kind),
  ).toBe('category');
}

/** A screen point the viewer's own picker resolves to a cell, off the bar. */
async function findCellPoint(page) {
  const point = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    for (let y = 80; y < innerHeight - 40; y += 4) {
      for (let x = 20; x < innerWidth - 20; x += 4) {
        const hit = document.elementFromPoint(x, y);
        if (hit === null || hit.id !== 'glcanvas') continue;
        const cellIndex = viewer.pickCellAtScreen(x, y);
        if (cellIndex >= 0) return { x, y, cellIndex };
      }
    }
    return null;
  });
  expect(point).not.toBeNull();
  return point;
}

/** A screen point on the plot where no cell is drawn. */
async function findEmptyPoint(page) {
  const point = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    for (let y = 80; y < innerHeight - 40; y += 6) {
      for (let x = 20; x < innerWidth - 20; x += 6) {
        const hit = document.elementFromPoint(x, y);
        if (hit === null || hit.id !== 'glcanvas') continue;
        let near = false;
        for (let dy = -24; dy <= 24 && !near; dy += 6) {
          for (let dx = -24; dx <= 24 && !near; dx += 6) {
            near = viewer.pickCellAtScreen(x + dx, y + dy) >= 0;
          }
        }
        if (!near) return { x, y };
      }
    }
    return null;
  });
  expect(point).not.toBeNull();
  return point;
}

/** Tap a cell once the page can take the gesture; the tool then reports a step. */
async function tapToSelect(page, point) {
  await readyForGesture(page);
  await page.touchscreen.tap(point.x, point.y);
  await expect(page.locator('#select-bar-steps')).toBeVisible();
}

/**
 * Turn Select mode on from the bar, and wait until the page shows it.
 *
 * The card grows to its rows at once, but the agents' dock above it is placed
 * from the bar's height, which a ResizeObserver publishes in the next
 * rendering update, before that frame is painted (`select-bar-placement.js`,
 * `--select-bar-block-size`). Until then the layout still has the dock where
 * it stood above the switch alone: over the card's new hint row, in a state
 * no frame ever shows. A person taps what was painted; a spec that read the
 * hint's box and tapped its coordinates in between would reach the dock's
 * chat button instead (a rendering update can take seconds on a hosted
 * runner). So every point is read once the page has shown the switch's
 * action.
 */
async function turnOnSelectModeFromBar(page) {
  const toggle = page.locator('#select-bar-mode');
  await toggle.tap();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await whenActionsShown(page);
}

/**
 * Wait until the next tap is a press of its own. A tap within the platform's
 * double-tap time of the last, near it, continues that press (its click's
 * `detail` is 2), and after a primary button the page drops it
 * (`ui/core/press-guard.js`): what took the button's place is not pressed by
 * an accidental double tap. A person reads the bar between two choices;
 * waiting past the double-tap time (Chromium counts taps 400 ms apart, a
 * desktop's double click 500 ms) makes the spec's next tap one too.
 */
async function nextPress(page) {
  await page.waitForTimeout(800);
}

const groupsOf = page => page.evaluate(
  () => window._cellucidState.getHighlightedGroups().length,
);
const unifiedState = page => page.evaluate(
  () => {
    // The candidates are a cell list (Uint32Array); hand them over as numbers.
    const state = window._cellucidViewer.getUnifiedSelectionState();
    return { ...state, candidates: Array.from(state.candidates) };
  },
);
const cameraOf = page => page.evaluate(
  () => window._cellucidViewer.getCameraState(),
);

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the bar on a phone: a finger on it, notices above it, an empty tap, then a selection confirmed and cleared', async ({
    page,
  }) => {
    const productErrors = observeProductErrors(page);
    await openDataset(page);
    await page.locator('#sidebar-toggle').tap();
    await expect(page.locator('#sidebar')).toHaveClass(/\bhidden\b/);
    await turnOnSelectModeFromBar(page);

    await test.step('a finger on the bar never reaches the plot', async () => {
      const card = await page.locator('.select-bar-card').boundingBox();
      const hint = await page.locator('#select-bar-hint').boundingBox();
      const start = { x: hint.x + hint.width / 2, y: hint.y + hint.height / 2 };
      const before = await cameraOf(page);

      // A tap and a drag that start on the card, dispatched where a finger's
      // pointers would be: on the element under the finger.
      await page.touchscreen.tap(start.x, start.y);
      await page.evaluate(({ from, to }) => {
        const target = document.elementFromPoint(from.x, from.y);
        const fire = (type, point) => target.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 61,
          pointerType: 'touch',
          isPrimary: true,
          button: type === 'pointermove' ? -1 : 0,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX: point.x,
          clientY: point.y,
        }));
        fire('pointerdown', from);
        for (let i = 1; i <= 12; i++) {
          fire('pointermove', {
            x: from.x + ((to.x - from.x) * i) / 12,
            y: from.y + ((to.y - from.y) * i) / 12,
          });
        }
        fire('pointerup', to);
      }, { from: start, to: { x: start.x - 120, y: card.y - 200 } });

      expect(await page.evaluate(({ x, y }) => (
        document.elementFromPoint(x, y).closest('#select-bar') !== null
      ), start)).toBe(true);
      expect((await unifiedState(page)).inProgress).toBe(false);
      await expect(page.locator('#annotation-step-controls')).toHaveCount(0);
      await expect(page.locator('#select-bar-notice')).toBeHidden();
      const after = await cameraOf(page);
      expect(after.orbit.theta).toBeCloseTo(before.orbit.theta, 6);
      expect(after.orbit.phi).toBeCloseTo(before.orbit.phi, 6);
      expect(after.orbit.target).toEqual(before.orbit.target);
      expect(productErrors).toEqual([]);
    });

    await test.step('notifications stack above the bar instead of covering it', async () => {
      await expect(page.locator('.select-bar-card')).toBeVisible();
      // The notifications are published here, with the bar up, rather than
      // borrowed from startup: those dismiss themselves after four seconds,
      // which a runner that draws a frame every second or two spends before the
      // bar is up. Two, so the stack is measured and not only a single card.
      await page.evaluate(async () => {
        const { getNotificationCenter } = await import(
          '/assets/js/app/notification-center.js'
        );
        const center = getNotificationCenter();
        center.info('A first notice over the plot', { duration: 0 });
        center.info('A second notice over the plot', { duration: 0 });
      });
      for (const text of ['A first notice', 'A second notice']) {
        await expect(page.locator('.notification', { hasText: text })).toBeVisible();
      }
      // The bar's height reaches the notifications from a ResizeObserver, which
      // runs before the next paint, so the overlap is measured after a frame:
      // what a user can see, not the layout between the tap and that frame.
      const overlaps = await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const card = document.querySelector('.select-bar-card').getBoundingClientRect();
          resolve([...document.querySelectorAll('.notification')]
            .map(element => element.getBoundingClientRect())
            .filter(box => box.height > 0)
            .filter(box => box.bottom > card.top + 1 && box.top < card.bottom
              && box.right > card.left && box.left < card.right).length);
        }));
      }));
      expect(overlaps).toBe(0);
      // The two notices stand until dismissed; the next steps tap the plot under them.
      await page.evaluate(async () => {
        const { getNotificationCenter } = await import(
          '/assets/js/app/notification-center.js'
        );
        getNotificationCenter().dismissAll();
      });
      await expect(page.locator('.notification', { hasText: 'notice over the plot' })).toHaveCount(0);
    });

    await test.step('a tap on empty plot changes nothing and the bar says so', async () => {
      const empty = await findEmptyPoint(page);
      const notice = page.locator('#select-bar-notice');
      await expect(notice).toBeHidden();
      await page.touchscreen.tap(empty.x, empty.y);
      await expect(notice).toHaveText('No cell there. Nothing changed; zoom in to hit cells.');
      expect((await unifiedState(page)).inProgress).toBe(false);
      expect(await groupsOf(page)).toBe(0);

      // The next real selection replaces the notice.
      await tapToSelect(page, await findCellPoint(page));
      await expect(notice).toBeHidden();
      expect(productErrors).toEqual([]);
      // Discard the selection, so the walk below starts from none.
      await page.locator('#select-bar-cancel').tap();
      await expect(page.locator('#select-bar-steps')).toBeHidden();
    });

    await test.step('select, confirm, clear and leave Select mode without the menu', async () => {
      const bar = page.locator('#select-bar');
      const barSwitch = page.locator('#select-bar-mode');
      await expect(page.locator('#select-bar-hint'))
        .toHaveText('Annotation: tap or click a cell to select its group.');
      await expect(page.locator('#select-bar-combine')).toBeVisible();

      // A tap selects; the bar says how much and offers the tool's own steps.
      const point = await findCellPoint(page);
      await tapToSelect(page, point);
      const selected = await unifiedState(page);
      expect(selected.inProgress).toBe(true);
      await expect(page.locator('#select-bar-selection'))
        .toHaveText(`${selected.candidateCount} cells selected`);
      await expect(page.locator('#select-bar-steps')).toHaveAttribute('data-tool', 'annotation');
      await expect(page.locator('#select-bar-hint')).toBeHidden();

      // Cancel discards it, as the panel's Cancel does.
      await page.locator('#select-bar-cancel').tap();
      await expect(page.locator('#select-bar-steps')).toBeHidden();
      expect((await unifiedState(page)).inProgress).toBe(false);
      await expect(page.locator('#annotation-step-controls')).toHaveCount(0);

      // Select again and confirm it onto the page.
      await tapToSelect(page, point);
      await page.locator('#select-bar-confirm').tap();
      await expect(page.locator('#select-bar-steps')).toBeHidden();
      expect(await groupsOf(page)).toBe(1);
      const countText = await page.locator('#highlight-count').textContent();
      await expect(page.locator('#select-bar-count')).toHaveText(countText);
      await expect(page.locator('#select-bar-page')).toBeVisible();

      // Clear empties the page exactly as the panel's Clear does: a press of
      // its own, not the second tap of Confirm's.
      await nextPress(page);
      await page.locator('#select-bar-clear').tap();
      await expect.poll(() => groupsOf(page)).toBe(0);
      await expect(page.locator('#select-bar-page')).toBeHidden();
      await expect(page.locator('#highlight-count')).toHaveText('No cells highlighted');
      await expect(page.locator('#clear-all-highlights')).toBeHidden();

      // Leaving Select mode collapses the bar to its switch.
      await barSwitch.tap();
      await expect(barSwitch).toHaveAttribute('aria-checked', 'false');
      await expect(bar).toBeVisible();
      await expect(page.locator('#select-bar-combine')).toBeHidden();
      await expect(page.locator('#select-bar-hint')).toBeHidden();
      await expect(page.locator('#highlight-select-mode'))
        .toHaveAttribute('aria-checked', 'false');
      expect(productErrors).toEqual([]);
    });
  });
});

test.describe('on a tablet', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

  test('the bar centres in the plot the sidebar leaves uncovered', async ({ page }) => {
    await openDataset(page);
    const centre = () => page.evaluate(() => {
      const box = document.querySelector('.select-bar-card').getBoundingClientRect();
      const sidebar = document.getElementById('sidebar');
      const covered = sidebar.classList.contains('hidden')
        ? 0
        : sidebar.getBoundingClientRect().right;
      return {
        card: box.left + box.width / 2,
        plot: (covered + innerWidth) / 2,
        clearOfSidebar: box.left >= covered,
      };
    });
    await expect(page.locator('#select-bar')).toBeVisible();
    let placed = await centre();
    expect(placed.clearOfSidebar).toBe(true);
    expect(Math.abs(placed.card - placed.plot)).toBeLessThan(2);

    await page.locator('#sidebar-toggle').tap();
    await expect(page.locator('#sidebar')).toHaveClass(/\bhidden\b/);
    await expect.poll(async () => {
      placed = await centre();
      return Math.abs(placed.card - placed.plot);
    }).toBeLessThan(2);
  });
});

test.describe('with a mouse', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the bar appears with Select mode and is keyboard operable', async ({
    page,
  }) => {
    const productErrors = observeProductErrors(page);
    await openDataset(page);
    const bar = page.locator('#select-bar');
    await expect(bar).toBeHidden();
    await page.locator('#highlight-select-mode').click();
    await expect(bar).toBeVisible();
    await expect(page.getByRole('region', { name: 'Selection' })).toBeVisible();
    for (const id of ['select-bar-selection', 'select-bar-notice']) {
      await expect(page.locator(`#${id}`)).toHaveAttribute('aria-live', 'polite');
    }

    // The combine choice from the bar reaches the panel, and the keyboard
    // reaches every control on the bar.
    await page.locator('#select-bar-combine-subtract').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#highlight-select-combine-subtract'))
      .toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window._cellucidViewer.getSelectMode()))
      .toEqual({ enabled: true, combine: 'subtract' });

    await page.locator('#select-bar-mode').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#highlight-select-mode'))
      .toHaveAttribute('aria-checked', 'false');
    await expect(bar).toBeHidden();
    expect(productErrors).toEqual([]);
  });
});
