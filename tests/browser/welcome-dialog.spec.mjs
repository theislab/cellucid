/**
 * The welcome dialog: every way of closing it, and how it sits on a phone.
 *
 * A plain start opens the catalog's default sample behind the dialog.
 * Start exploring, Escape, the backdrop (a tap outside the card) all close
 * it and nothing else: no panel opens, focus goes back where it was, and the
 * Sample dataset dropdown is left alone (not focused, so it neither looks
 * chosen nor opens on the next key press). Learn more opens the
 * documentation beside the app and leaves the dialog up.
 *
 * On a phone the card fits what the screen shows, upright and on its side
 * and after turning the device: inside the viewport with its margins, nothing
 * scrolling sideways, the page behind never scrolled, its two choices on
 * screen at once and at least 41 px tall, each label on one line; and once it
 * closes the plot is what a touch reaches.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { expectWelcomeShown } from './helpers/welcome.mjs';

const PLAIN_START_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}` +
  '&acceptance=welcome-dialog';
const CATALOG_DEFAULT = 'dataset:local-demo:current-ui';
const DOCS_ORIGIN = 'https://docs.cellucid.com';

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

async function openPlainStart(page) {
  await page.goto(PLAIN_START_URL, { waitUntil: 'domcontentloaded' });
  await expectWelcomeShown(page);
}

/** The catalog default is open and the dropdown shows it, untouched. */
async function expectDefaultLoadedAndSelectInactive(page) {
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  const datasetSelect = page.locator('#dataset-select');
  await expect(datasetSelect).toBeEnabled();
  await expect(datasetSelect).toHaveValue(CATALOG_DEFAULT);
  await expect(datasetSelect).not.toBeFocused();
  expect(
    await datasetSelect.evaluate(
      select => select.matches(':focus, :focus-visible, :active'),
    ),
  ).toBe(false);
  expect(
    await page.evaluate(() => document.activeElement?.id ?? null),
  ).not.toBe('dataset-select');
}

test('Start exploring closes the dialog and opens nothing else', async ({
  page,
}) => {
  const errors = observeProductErrors(page);
  await openPlainStart(page);
  const start = page.locator('#welcome-start-btn');
  await expect(start).toHaveText(/Start exploring/);
  const sessionOpen = await page.locator('#session-section').evaluate(section => section.open);

  // Chosen before the default sample has finished loading: nothing queued
  // for later may move focus into the dropdown when the catalog arrives.
  await start.click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
  expect(await page.locator('#session-section').evaluate(section => section.open)).toBe(sessionOpen);
  await expect(page.locator('#session-section > summary')).not.toBeFocused();

  await expectDefaultLoadedAndSelectInactive(page);
  expect(errors).toEqual([]);
});

test('Start exploring from the keyboard closes the dialog and leaves the dropdown inactive', async ({
  page,
}) => {
  const errors = observeProductErrors(page);
  await openPlainStart(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('#welcome-start-btn')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expect(page.locator('#session-section > summary')).not.toBeFocused();

  await expectDefaultLoadedAndSelectInactive(page);
  // The next key press does not land in the dropdown either.
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#dataset-select')).toHaveValue(CATALOG_DEFAULT);
  expect(errors).toEqual([]);
});

test('Escape closes onboarding without activating the dropdown', async ({
  page,
}) => {
  const errors = observeProductErrors(page);
  await openPlainStart(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expectDefaultLoadedAndSelectInactive(page);
  expect(errors).toEqual([]);
});

test('the backdrop closes onboarding without activating the dropdown', async ({
  page,
}) => {
  const errors = observeProductErrors(page);
  await openPlainStart(page);
  await page.locator('#welcome-modal .welcome-backdrop').click({
    position: { x: 8, y: 8 },
  });
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expectDefaultLoadedAndSelectInactive(page);
  expect(errors).toEqual([]);
});

test('Learn more leaves the dropdown inactive before and after closing', async ({
  page,
  context,
}) => {
  const errors = observeProductErrors(page);
  await context.route(`${DOCS_ORIGIN}/**`, route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>Docs</title>',
  }));
  await openPlainStart(page);

  const popupPromise = page.waitForEvent('popup');
  await page.locator('#welcome-modal').getByRole('link', {
    name: /Learn more/,
  }).click();
  const popup = await popupPromise;
  await popup.close();
  await page.bringToFront();

  // The link opens the documentation beside the app; the dialog stays.
  await expectWelcomeShown(page);
  await expect(page.locator('#dataset-select')).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expectDefaultLoadedAndSelectInactive(page);
  expect(errors).toEqual([]);
});

/** What a phone shows of the dialog, read in the page. */
function readCard(page) {
  return page.evaluate(() => {
    const card = document.querySelector('#welcome-modal .welcome-content');
    const box = card.getBoundingClientRect();
    const choices = [...card.querySelectorAll('.welcome-btn')].map(element => element.getBoundingClientRect());
    const wraps = [...card.querySelectorAll('.welcome-btn-title, .welcome-btn-desc, .welcome-tagline')]
      .filter(element => {
        const style = getComputedStyle(element);
        const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.25;
        return element.getBoundingClientRect().height > line * 1.5 || element.scrollWidth > element.clientWidth + 0.5;
      })
      .map(element => element.textContent.trim());
    window.scrollTo(0, 400);
    const pageScrolled = window.scrollY !== 0 || document.scrollingElement.scrollTop !== 0;
    window.scrollTo(0, 0);
    return {
      inside: box.left >= 1 && box.top >= 1 && box.right <= innerWidth - 1 && box.bottom <= innerHeight - 1,
      box: [box.left, box.top, box.right, box.bottom].map(Math.round),
      viewport: [innerWidth, innerHeight],
      sideways: document.documentElement.scrollWidth > innerWidth,
      pageScrolled,
      choicesOnScreen: choices.every(rect => rect.top >= box.top && rect.bottom <= box.bottom),
      smallestChoice: Math.min(...choices.map(rect => rect.height)),
      wraps,
    };
  });
}

async function expectCardFits(page, label) {
  const card = await readCard(page);
  expect(card.inside, `${label}: the card ${card.box} inside ${card.viewport}`).toBe(true);
  expect(card.sideways, `${label}: nothing scrolls sideways`).toBe(false);
  expect(card.pageScrolled, `${label}: the page behind does not scroll`).toBe(false);
  expect(card.choicesOnScreen, `${label}: both choices on screen`).toBe(true);
  expect(card.smallestChoice, `${label}: touch targets`).toBeGreaterThanOrEqual(41);
  expect(card.wraps, `${label}: one line each`).toEqual([]);
}

/** Once the dialog has closed and the dataset is drawn, a touch on the plot reaches the plot. */
async function expectPlotReachable(page) {
  // The sample's opening is shown over the plot until its first view is
  // drawn, a moment after its name is in the panel: on WebKit the point was
  // read in between, 1 run in 12, and was the opening's panel.
  await expect(page.locator('.opening-overlay')).toBeHidden();
  expect(await page.evaluate(() => (
    document.elementFromPoint(innerWidth / 2, innerHeight * 0.4)?.id
  ))).toBe('glcanvas');
}

for (const [layout, viewport] of [
  ['a small phone', { width: 360, height: 640 }],
  ['a phone on its side', { width: 844, height: 390 }],
]) {
  test.describe(`on ${layout}`, () => {
    test.use({ viewport, hasTouch: true });

    test('the card fits the screen, and Start exploring leaves the plot', async ({ page }) => {
      const errors = observeProductErrors(page);
      await openPlainStart(page);
      await expectCardFits(page, layout);
      await page.locator('#welcome-start-btn').tap();
      await expect(page.locator('#welcome-modal')).toBeHidden();
      await expectDefaultLoadedAndSelectInactive(page);
      await expectPlotReachable(page);
      expect(errors).toEqual([]);
    });

    test('a tap outside the card closes it', async ({ page }) => {
      await openPlainStart(page);
      await page.touchscreen.tap(4, 4);
      await expect(page.locator('#welcome-modal')).toBeHidden();
      // Once the sample behind it is drawn (until then its opening shows there).
      await expectDefaultLoadedAndSelectInactive(page);
      await expectPlotReachable(page);
    });
  });
}

test.describe('on a phone turned while the dialog is open', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the card still fits, on its side and upright again', async ({ page }) => {
    await openPlainStart(page);
    await expectCardFits(page, 'upright');
    await page.setViewportSize({ width: 844, height: 390 });
    await expectCardFits(page, 'on its side');
    await page.setViewportSize({ width: 390, height: 844 });
    await expectCardFits(page, 'upright again');
  });
});
