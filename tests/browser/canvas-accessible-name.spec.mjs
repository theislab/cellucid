/**
 * The plot canvas is the first Tab stop in the document. Before CEL-AUDIT-0088
 * it reached that position with an empty accessible name in all three engines,
 * so the first thing a screen-reader user met on every load was an unnamed
 * element.
 *
 * This spec measures the computed name and description in the running browser,
 * because that is the only place the defect was visible. It also reads
 * Chromium's own accessibility node over CDP: an in-page name computation and
 * the engine's accessibility tree do not always agree, and the disagreement is
 * exactly what makes a wrong description host look correct — describing an
 * element inside the collapsed Keyboard Shortcuts panel passes an in-page
 * check and yields no description at all in Chromium.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}` +
  '&dataset=current-ui-prepared&acceptance=canvas-accessible-name-ci';

const CANVAS_NAME = 'Single-cell embedding plot';

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

async function openApp(page) {
  const errors = observeProductErrors(page);
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  return errors;
}

test('the first Tab stop is the named, described plot', async ({ page }) => {
  const errors = await openApp(page);
  const canvas = page.locator('#glcanvas');

  await expect(canvas).toHaveAccessibleName(CANVAS_NAME);
  await expect(canvas).toHaveAccessibleDescription(/\bW A S D\b/);
  await expect(canvas).toHaveAccessibleDescription(/\bR resets the camera\b/);
  await expect(page.getByRole('group', { name: CANVAS_NAME })).toHaveAttribute(
    'id',
    'glcanvas'
  );

  // The description must not depend on a panel the user has not opened.
  await expect(page.locator('#shortcuts-section')).not.toHaveAttribute('open', '');
  await expect(page.locator('#glcanvas-help')).not.toBeInViewport();

  const landedOnBody = await page.evaluate(() => {
    document.getElementById('glcanvas').blur();
    document.body.focus();
    return document.activeElement === document.body;
  });
  expect(landedOnBody).toBe(true);
  await page.keyboard.press('Tab');
  await expect(canvas).toBeFocused();

  expect(errors).toEqual([]);
});

test('the description survives the shortcuts panel being opened and shut', async ({
  page
}) => {
  await openApp(page);
  const canvas = page.locator('#glcanvas');

  await page.locator('#shortcuts-section > summary').click();
  await expect(page.locator('#shortcuts-section')).toHaveAttribute('open', '');
  await expect(canvas).toHaveAccessibleDescription(/\bR resets the camera\b/);

  await page.locator('#shortcuts-section > summary').click();
  await expect(page.locator('#shortcuts-section')).not.toHaveAttribute('open', '');
  await expect(canvas).toHaveAccessibleDescription(/\bR resets the camera\b/);
});

test('Chromium exposes the name and description on its own canvas node', async ({
  page,
  browserName
}) => {
  test.skip(browserName !== 'chromium', 'CDP reads Chromium accessibility only');
  await openApp(page);

  const client = await page.context().newCDPSession(page);
  await client.send('DOM.enable');
  await client.send('Accessibility.enable');
  const { root } = await client.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await client.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '#glcanvas'
  });
  const { nodes } = await client.send('Accessibility.getPartialAXTree', {
    nodeId,
    fetchRelatives: false
  });
  const node = nodes[nodes.length - 1];

  expect(node.ignored).toBe(false);
  expect(node.role?.value).toBe('group');
  expect(node.name?.value).toBe(CANVAS_NAME);
  expect(node.description?.value ?? '').toMatch(/\bR resets the camera\b/);
});
