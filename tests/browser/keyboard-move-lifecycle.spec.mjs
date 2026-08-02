import { expect, test } from './helpers/test.mjs';
import { dispatchAppDrag } from './helpers/app-drag.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

/* Cellucid moves things with the pointer in three places: a sidebar panel is
   torn off into a floating window, highlight pages are dropped into the
   category builder and reordered there, and a legend category is dragged onto
   another to merge the two. Each of those had no keyboard path at all
   (CEL-AUDIT-0078, CEL-AUDIT-0079, CEL-AUDIT-0085). They now share one
   grammar — pick up with Enter/Space, aim with the arrow keys, drop with
   Enter/Space, cancel with Escape — announced through one polite live region.
   Every test below also drives the pointer path it replaced, because the fix
   is only correct if the mouse still works. */

const PREPARED_DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=keyboard-move-lifecycle-ci`;

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

async function openPreparedDataset(page) {
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );
}

function panelFloatingState(page) {
  return page.evaluate(() => {
    const panel = document.getElementById('visualization-section');
    if (panel === null) throw new Error('Visualization panel is absent');
    return {
      floating: panel.classList.contains('accordion-floating'),
      parentId: panel.parentElement === null ? '' : panel.parentElement.id,
    };
  });
}

function liveRegionText(page) {
  return page.evaluate(() => {
    const region = document.getElementById('keyboard-move-live-region');
    return region === null ? null : region.textContent;
  });
}

test('a sidebar panel undocks and docks from the keyboard, and still from the pointer', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await openPreparedDataset(page);

  const summary = page.locator('#visualization-section > summary');
  const undockButton = summary.locator('.accordion-undock-btn');
  const dockButton = summary.locator('.accordion-dock-btn');

  /* The way out has to exist before you are through the door: the undock
     control is present and reachable while the panel is still docked. */
  await expect(undockButton).toBeVisible();
  await expect(undockButton).toHaveAttribute(
    'aria-label',
    'Undock panel into a floating window'
  );
  await expect(dockButton).toBeHidden();
  expect(await panelFloatingState(page)).toEqual({
    floating: false,
    parentId: '',
  });

  await undockButton.focus();
  await expect(undockButton).toBeFocused();
  await page.keyboard.press('Enter');

  expect(await panelFloatingState(page)).toEqual({
    floating: true,
    parentId: 'floating-panels-root',
  });
  /* Focus follows the panel: the control that was activated is now hidden, so
     it hands over to the one that reverses it. */
  await expect(dockButton).toBeVisible();
  await expect(dockButton).toBeFocused();
  await expect(undockButton).toBeHidden();
  expect(await liveRegionText(page)).toContain('is now a floating window');

  await page.keyboard.press('Enter');
  expect(await panelFloatingState(page)).toEqual({
    floating: false,
    parentId: '',
  });
  await expect(undockButton).toBeFocused();
  expect(await liveRegionText(page)).toContain('docked in the sidebar again');

  /* The pointer path this replaced still tears the panel off and puts it
     back. */
  const dockedBox = await summary.boundingBox();
  if (dockedBox === null) throw new Error('Docked summary has no box');
  await page.mouse.move(dockedBox.x + 40, dockedBox.y + dockedBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    dockedBox.x + 540,
    dockedBox.y + dockedBox.height / 2 - 150,
    { steps: 12 }
  );
  await page.mouse.up();
  expect(await panelFloatingState(page)).toEqual({
    floating: true,
    parentId: 'floating-panels-root',
  });
  await expect(page.locator('#visualization-section')).not.toHaveClass(
    /floating-enter/,
  );

  /* The floating panel's only size control was pointer-only and
     `aria-hidden`. It is a focusable window splitter now. */
  const widthHandle = page.locator(
    '#visualization-section .accordion-width-handle'
  );
  await expect(widthHandle).toHaveAttribute('role', 'separator');
  await expect(widthHandle).toHaveAttribute('aria-label', 'Panel width');
  await expect(widthHandle).not.toHaveAttribute('aria-hidden', 'true');
  await widthHandle.focus();
  await expect(widthHandle).toBeFocused();
  const widthBefore = await page.evaluate(
    () => document.getElementById('visualization-section').getBoundingClientRect().width
  );
  await page.keyboard.press('ArrowRight');
  const widthAfter = await page.evaluate(
    () => document.getElementById('visualization-section').getBoundingClientRect().width
  );
  expect(widthAfter - widthBefore).toBeGreaterThanOrEqual(8);
  /* The reported value tracks the rendered box; engines disagree with each
     other by a border's width, which is not what this asserts. */
  const reportedWide = Number(await widthHandle.getAttribute('aria-valuenow'));
  expect(Number.isSafeInteger(reportedWide)).toBe(true);
  expect(Math.abs(reportedWide - widthAfter)).toBeLessThanOrEqual(2);
  await expect(widthHandle).toHaveAttribute(
    'aria-valuetext',
    `${reportedWide} pixels wide`
  );

  await page.keyboard.press('ArrowLeft');
  const widthRestored = await page.evaluate(
    () => document.getElementById('visualization-section').getBoundingClientRect().width
  );
  expect(widthAfter - widthRestored).toBeGreaterThanOrEqual(8);
  expect(
    Number(await widthHandle.getAttribute('aria-valuenow'))
  ).toBeLessThan(reportedWide);

  const floatingBox = await summary.boundingBox();
  if (floatingBox === null) throw new Error('Floating summary has no box');
  await page.mouse.move(
    floatingBox.x + 40,
    floatingBox.y + floatingBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(200, 400, { steps: 12 });
  await page.mouse.up();
  expect(await panelFloatingState(page)).toEqual({
    floating: false,
    parentId: '',
  });

  expect(productErrors).toEqual([]);
});

function droppedLabels(page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll('#dropzone-items .dropzone-item-label')
    ).map(input => input.value)
  );
}

async function openCategoryBuilder(page, extraPages) {
  const addPage = page.getByRole('button', { name: 'Add highlight page' });
  for (let index = 0; index < extraPages; index++) await addPage.click();
  const header = page.locator(
    '#cat-builder-accordion-item .analysis-accordion-header'
  );
  await header.scrollIntoViewIfNeeded();
  await header.click();
  await expect(page.locator('#cat-builder-dropzone')).toBeVisible();
}

test('the category builder can be filled, reordered and confirmed from the keyboard', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await openPreparedDataset(page);
  await openCategoryBuilder(page, 2);

  /* The drop target announced nothing at all: no role, no name. */
  const dropzone = page.locator('#cat-builder-dropzone');
  await expect(dropzone).toHaveAttribute('role', 'group');
  await expect(dropzone).toHaveAttribute('aria-label', 'Category labels');

  const pageSelect = page.locator('#cat-builder-page-select');
  const addButton = page.locator('#cat-builder-add-page');
  const confirmButton = page.locator('#cat-builder-confirm');
  await expect(confirmButton).toBeDisabled();

  /* Three highlight pages exist; each can be moved in without a pointer. */
  await expect(pageSelect.locator('option')).toHaveCount(3);
  for (let index = 0; index < 3; index++) {
    await pageSelect.selectOption({ index: 0 });
    await addButton.click();
  }
  expect(await droppedLabels(page)).toEqual(['Page 1', 'Page 2', 'Page 3']);
  expect(await liveRegionText(page)).toContain(
    'The new column now has 3 category labels'
  );
  /* Nothing is left to add, so the control says so instead of offering
     a choice that does nothing. */
  await expect(pageSelect).toBeDisabled();
  await expect(addButton).toBeDisabled();

  /* Reorder: pick up, aim, drop. */
  const handles = page.locator('#dropzone-items .dropzone-item-handle');
  await expect(handles.first()).toHaveAttribute('role', 'button');
  await expect(handles.first()).toHaveAttribute('tabindex', '0');
  await expect(handles.first()).toHaveAttribute('aria-label', 'Move Page 1');
  await handles.first().focus();
  await page.keyboard.press('Enter');
  expect(await liveRegionText(page)).toContain('Page 1 picked up');
  expect(await liveRegionText(page)).toContain('position 2, Page 2');
  await page.keyboard.press('ArrowDown');
  expect(await liveRegionText(page)).toContain('position 3, Page 3');
  await page.keyboard.press('Enter');
  expect(await droppedLabels(page)).toEqual(['Page 2', 'Page 3', 'Page 1']);
  expect(await liveRegionText(page)).toContain('moved to position 3 of 3');

  /* Escape puts it back exactly where it was. */
  await handles.first().focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  expect(await droppedLabels(page)).toEqual(['Page 2', 'Page 3', 'Page 1']);
  expect(await liveRegionText(page)).toContain('Move cancelled');
  expect(
    await page.evaluate(() =>
      document.querySelectorAll(
        '#dropzone-items .dropzone-item.drag-over, #dropzone-items .dropzone-item.dragging'
      ).length
    )
  ).toBe(0);

  /* The whole point of filling the zone: Create was permanently disabled for a
     keyboard user because nothing could ever be dropped. */
  await page.locator('#cat-builder-name').fill('Keyboard categories');
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();
  await expect(
    page.locator('#categorical-field option', {
      hasText: 'Keyboard categories'
    })
  ).toHaveCount(1);

  expect(productErrors).toEqual([]);
});

test('the category builder still accepts the pointer drags it always accepted', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await openPreparedDataset(page);
  await openCategoryBuilder(page, 1);

  const dropzone = page.locator('#cat-builder-dropzone');
  const tabs = page.locator('.highlight-page-tab');
  await expect(tabs).toHaveCount(2);

  await dispatchAppDrag(tabs.nth(0), dropzone, {
    expectedDataType: 'application/x-highlight-page'
  });
  await dispatchAppDrag(tabs.nth(1), dropzone, {
    expectedDataType: 'application/x-highlight-page'
  });
  expect(await droppedLabels(page)).toEqual(['Page 1', 'Page 2']);

  const items = page.locator('#dropzone-items .dropzone-item');
  await dispatchAppDrag(items.nth(0), items.nth(1));
  expect(await droppedLabels(page)).toEqual(['Page 2', 'Page 1']);

  expect(productErrors).toEqual([]);
});

function legendCategoryNames(page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll('#legend .legend-label-main')
    ).map(label => label.textContent)
  );
}

async function selectCategoricalField(page) {
  const select = page.locator('#categorical-field');
  const value = await select.evaluate(element => {
    const option = Array.from(element.options).find(o => o.value !== '-1');
    if (option === undefined) throw new Error('fixture has no categorical obs');
    return option.value;
  });
  await select.selectOption(value);
  await expect(page.locator('#legend .legend-item')).toHaveCount(3);
}

test('a legend category merges into another from the keyboard, and still by drag', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await openPreparedDataset(page);
  await selectCategoricalField(page);
  expect(await legendCategoryNames(page)).toEqual(['alpha', 'beta', 'gamma']);

  const labels = page.locator('#legend .legend-label');
  /* The label was `draggable` and nothing else — not focusable, no role. */
  await expect(labels.first()).toHaveAttribute('role', 'button');
  await expect(labels.first()).toHaveAttribute('tabindex', '0');
  await expect(labels.first()).toHaveAttribute(
    'aria-roledescription',
    'movable category'
  );
  await expect(labels.first()).toHaveAttribute(
    'aria-describedby',
    'keyboard-move-instructions'
  );

  await labels.first().focus();
  await expect(labels.first()).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await liveRegionText(page)).toContain('alpha picked up');
  expect(await liveRegionText(page)).toContain('Destination 1 of 2: beta');
  /* Aiming paints the row with the class the pointer path paints on
     `dragenter`, so both inputs mark the destination the same way. */
  expect(
    await page.evaluate(() =>
      document.querySelectorAll('#legend .legend-item-drag-over').length
    )
  ).toBe(1);
  await page.keyboard.press('ArrowDown');
  expect(await liveRegionText(page)).toContain('Destination 2 of 2: gamma');

  await page.keyboard.press('Escape');
  expect(await liveRegionText(page)).toContain('Move cancelled');
  expect(
    await page.evaluate(() =>
      document.querySelectorAll(
        '#legend .legend-item-drag-over, #legend .legend-item-dragging'
      ).length
    )
  ).toBe(0);
  expect(await legendCategoryNames(page)).toEqual(['alpha', 'beta', 'gamma']);

  /* Dropping runs the same confirmation the pointer drop runs. */
  await labels.first().focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  const dialog = page.locator('.confirm-dialog');
  await expect(dialog).toContainText('Merge category "alpha" into "beta"?');
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  expect(await legendCategoryNames(page)).toEqual([
    'gamma',
    'merged alpha + beta'
  ]);

  /* And the drag that was the only way in still works. */
  const remaining = page.locator('#legend .legend-item');
  await dispatchAppDrag(
    remaining.nth(0).locator('.legend-label'),
    remaining.nth(1),
    { expectedDataType: 'application/x-cellucid-category' }
  );
  await expect(dialog).toContainText('Merge category "gamma" into');
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(page.locator('#legend .legend-item')).toHaveCount(1);

  expect(productErrors).toEqual([]);
});
