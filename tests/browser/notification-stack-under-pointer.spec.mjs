/**
 * The notification stack stands on the bottom edge, so a card leaving let
 * every card above it fall by its height. A person pressing one card's Dismiss
 * as a card below it left had the button move from under the pointer before
 * the release, and the click landed on the plot behind (Web app tests run
 * 42385814622, WebKit, `empty-dataset-state.spec.mjs`). While the pointer is
 * over the stack a card that leaves keeps its place, and the earlier-messages
 * control under the stack waits; once the pointer leaves, the stack closes up
 * (`notification-center.js` `_holdStackUnderPointer`).
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { waitForPageAtRest } from './helpers/dataset-ready.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const APP_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&acceptance=notification-stack-under-pointer`;

async function openQuietApp(page) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await waitForPageAtRest(page);
  await page.evaluate(async () => {
    const { getNotificationCenter } = await import('/assets/js/app/notification-center.js');
    getNotificationCenter().dismissAll();
  });
  await page.mouse.move(5, 5);
  await expect(page.locator('#notification-center > *')).toHaveCount(0);
}

/** Show cards that stay until dismissed, oldest first (the bottom of the stack); their ids. */
function showCards(page, messages) {
  return page.evaluate(async list => {
    const { getNotificationCenter } = await import('/assets/js/app/notification-center.js');
    return list.map(message => getNotificationCenter().info(message, { duration: 0 }));
  }, messages);
}

function dismissCard(page, id) {
  return page.evaluate(async cardId => {
    const { getNotificationCenter } = await import('/assets/js/app/notification-center.js');
    getNotificationCenter().dismiss(cardId);
  }, id);
}

function card(page, message) {
  return page.locator('#notification-center .notification', { hasText: message });
}

/** Wait for a card's enter animation (it slides in sideways) to end. */
async function settled(locator) {
  await expect(locator).toHaveClass(/notification-enter/);
  await locator.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
}

async function centreOf(locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('The control has no box.');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

test('a card leaving below the pointer does not move the card being pressed', async ({ page }) => {
  await openQuietApp(page);
  const [lower] = await showCards(page, ['Lower card', 'Middle card', 'Upper card']);
  const dismiss = card(page, 'Upper card').locator('.notification-dismiss');
  await expect(dismiss).toBeVisible();
  await settled(card(page, 'Upper card'));

  const before = await centreOf(dismiss);
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await dismissCard(page, lower);
  await expect(card(page, 'Lower card')).toHaveCount(0);
  const during = await centreOf(dismiss);
  expect(during.box, 'the pressed Dismiss stayed under the pointer').toEqual(before.box);
  await page.mouse.up();
  // The press and the release met on the same button, so it was a click.
  await expect(card(page, 'Upper card')).toHaveCount(0);
  await expect(card(page, 'Middle card')).toHaveCount(1);
});

test('the stack closes up once the pointer leaves it, gaps between cards included', async ({ page }) => {
  await openQuietApp(page);
  const [lower] = await showCards(page, ['Lower card', 'Upper card']);
  const upper = card(page, 'Upper card');
  await settled(upper);
  const before = await centreOf(upper);
  await page.mouse.move(before.x, before.y);
  await dismissCard(page, lower);
  await expect(card(page, 'Lower card')).toHaveCount(0);
  expect((await centreOf(upper)).box.y, 'the place of the card that left is kept').toBe(before.box.y);

  // Into the gap where the card that left stood: still the stack's area.
  const spacer = page.locator('#notification-center > .notification-spacer');
  await expect(spacer).toHaveCount(1);
  const gap = await centreOf(spacer);
  await page.mouse.move(gap.x, gap.y, { steps: 4 });
  expect((await centreOf(upper)).box.y).toBe(before.box.y);

  // Off the stack: it closes up.
  await page.mouse.move(gap.box.x - 40, gap.y, { steps: 4 });
  await expect(spacer).toHaveCount(0);
  await expect.poll(async () => (await centreOf(upper)).box.y).toBeGreaterThan(before.box.y);
});

test('the earlier-messages control waits under the stack until the pointer leaves', async ({ page }) => {
  await openQuietApp(page);
  const first = ['Card 1', 'Card 2', 'Card 3', 'Card 4', 'Card 5'];
  await showCards(page, first);
  const top = card(page, 'Card 5');
  await settled(top);
  const before = await centreOf(top);
  await page.mouse.move(before.x, before.y);

  // A sixth card retires the oldest to make room.
  await showCards(page, ['Card 6']);
  await expect(card(page, 'Card 1')).toHaveCount(0);
  await expect(page.locator('#notification-center .notification-overflow')).toHaveCount(0);
  expect((await centreOf(top)).box.y, 'nothing under the pointer moved').toBe(before.box.y);

  await page.mouse.move(5, 5, { steps: 4 });
  await expect(page.locator('#notification-center .notification-overflow-toggle')).toHaveText('Show 1 earlier message');
  await expect(page.locator('#notification-center > .notification-spacer')).toHaveCount(0);
});
