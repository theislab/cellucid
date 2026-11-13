/**
 * Undo and redo from the keys (`ui/modules/state/keyboard.js`), with the
 * focus where a person leaves it: a slider just dragged, a checkbox just
 * clicked. Only text fields keep their own undo; a slider, a checkbox and a
 * select have none, so Ctrl/⌘+Z undoes the step they made (History tip:
 * "except while you type in a field").
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { takeSteps, waitForHistory } from './helpers/state-history.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=history-keys`;

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function open(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await waitForHistory(page);
  await openCollapsedPanels(page);
}

/** The step shown, how many steps there are, and every domain's fingerprint, once nothing is under way. */
function settled(page) {
  return page.evaluate(async () => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint } = await import('/assets/js/app/state/domains/fingerprint.js');
    const history = window._cellucidHistories.current();
    await history.idle();
    const { steps, headId } = history.active;
    return { head: headId, steps: steps.length ?? steps.size, domains: (await stateFingerprint(getStateDomains())).domains };
  });
}

test('Ctrl/⌘+Z with a control focused: a slider, a checkbox, a text field, and undo then redo back to back', async ({ page, browserName }) => {
  const errors = observeProductErrors(page);
  await open(page);

  // WebKit does not focus a slider it drags, so there the key never meets a focused slider.
  if (browserName !== 'webkit') {
    await test.step('a slider dragged, then Ctrl/⌘+Z with the slider focused, undoes the drag exactly', async () => {
      const slider = page.locator('#point-size');
      await slider.scrollIntoViewIfNeeded();
      const before = await settled(page);
      const box = await slider.boundingBox();
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width * 0.3, y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width * 0.3 + i * 8, y);
      await page.mouse.up();
      await expect.poll(async () => (await settled(page)).steps).toBe(before.steps + 1);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('point-size');
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(async () => (await settled(page)).head).toBe(before.head);
      expect((await settled(page)).domains).toEqual(before.domains);
    });
  }

  await test.step('a checkbox clicked, then Ctrl/⌘+Z with the checkbox focused, undoes it', async () => {
    const before = await settled(page);
    const box = page.locator('#sidebar input[type="checkbox"]:visible').first();
    await box.scrollIntoViewIfNeeded();
    await box.click();
    await expect.poll(async () => (await settled(page)).steps).toBe(before.steps + 1);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await settled(page)).head).toBe(before.head);
    expect((await settled(page)).domains).toEqual(before.domains);
  });

  await test.step('a text field keeps its own undo: Ctrl/⌘+Z while typing in it makes no history move', async () => {
    const before = await settled(page);
    const field = page.locator('#sidebar input[type="search"]:visible, #sidebar input[type="text"]:visible').first();
    await field.scrollIntoViewIfNeeded();
    await field.click();
    await page.keyboard.type('ab');
    await page.keyboard.press('ControlOrMeta+z');
    // The key is the field's: the history did not move (settled reads it once nothing is under way).
    expect((await settled(page)).head).toBe(before.head);
    // The field is emptied again, as it was found.
    await field.fill('');
    expect((await settled(page)).head).toBe(before.head);
  });

  await test.step('undo then redo pressed back to back lands on the step it started from', async () => {
    // The dataset opens colored by cell_type (its first coloring): score is the step.
    const ids = await takeSteps(page, [
      ['color.by', { field: { source: 'obs', key: 'score' } }],
      ['filter.category.visibility', { field: { source: 'obs', key: 'cell_type' }, categories: ['gamma'], visible: false }],
    ]);
    const before = await settled(page);
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(async () => (await settled(page)).head).toBe(ids[1]);
    expect((await settled(page)).domains).toEqual(before.domains);
  });

  expect(errors).toEqual([]);
});
