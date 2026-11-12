/**
 * The open chat is a side panel on a wide window, and the plot gives it its
 * width (`app/agent/dock.js`): no cell is under the chat. Found 2026-11-11:
 * the chat over the bottom of the plot hid the cells the agent was changing.
 */
import { expect, test } from './helpers/test.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { installScriptedModel, observeProductErrors, openAgentDataset, openChat, queueReplies, say, COLOR_BY_SCORE } from './helpers/agent-chat.mjs';

const WIDE = { width: 1440, height: 900 };

function geometry(page) {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const dock = document.querySelector('#agent-dock');
    const panel = dock.getBoundingClientRect();
    const canvas = document.querySelector('#glcanvas').getBoundingClientRect();
    const notifications = document.querySelector('.notification-center')?.getBoundingClientRect() ?? null;
    return {
      layout: dock.dataset.layout,
      inset: parseFloat(root.getPropertyValue('--agent-panel-inline-size')),
      panelLeft: panel.left,
      panelWidth: panel.width,
      panelTop: panel.top,
      panelBottom: panel.bottom,
      canvasRight: canvas.right,
      windowWidth: innerWidth,
      windowHeight: innerHeight,
      notificationsRight: notifications === null ? null : notifications.right,
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(WIDE);
  await page.addInitScript(installScriptedModel);
});

test('on a wide window the open chat is a full-height side panel the plot leaves room for; collapsed, the plot has the window again', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openAgentDataset(page);
  const closed = await geometry(page);
  expect(closed.layout).toBe('bar');
  expect(closed.inset).toBe(0);
  expect(closed.canvasRight).toBe(closed.windowWidth);

  await openChat(page);
  const open = await geometry(page);
  expect(open.layout).toBe('side');
  expect(open.inset).toBe(400);
  expect([open.panelTop, open.panelBottom]).toEqual([0, open.windowHeight]);
  expect(open.panelLeft).toBe(open.windowWidth - 400);
  // The canvas ends where the panel begins: no cell is drawn under the chat.
  expect(open.canvasRight).toBe(open.panelLeft);
  // What is anchored to the window's right moves in with it.
  if (open.notificationsRight !== null) expect(open.notificationsRight).toBeLessThanOrEqual(open.panelLeft);
  // The views are laid out in what is left (the viewer's presented area).
  const presented = await page.evaluate(() => {
    const area = window._cellucidViewer?.getPresentedLayout?.()?.presentedArea ?? null;
    return area === null ? null : area.cssLeft + area.cssWidth;
  });
  if (presented !== null) expect(presented).toBeLessThanOrEqual(open.panelLeft + 0.5);

  // A turn's rows: the agent's name once for calls one after another.
  await queueReplies(page, [{ calls: [COLOR_BY_SCORE] }, { calls: [{ name: 'fields_list', args: {} }] }, { text: 'Done.' }]);
  await say(page, 'Color by score.');
  await expect(page.locator('#agent-chat-log .agent-msg-agent .agent-msg-who:visible')).toHaveCount(1);
  await expect(page.locator('#agent-chat-log .agent-msg-agent[data-continued="true"]')).toHaveCount(2);

  await page.locator('#agent-chat-collapse').click();
  const collapsed = await geometry(page);
  expect(collapsed.layout).toBe('bar');
  expect(collapsed.canvasRight).toBe(collapsed.windowWidth);
  await expect(page.locator('#agent-chat-toggle')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the panel\'s edge sets its width: by keys and by dragging (taken on release), remembered across a reload, reset by a double click', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openAgentDataset(page);
  await openChat(page);
  const grip = page.locator('#agent-dock-grip');
  await expect(grip).toBeVisible();
  await grip.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await geometry(page)).inset).toBe(448);
  await expect(grip).toHaveAttribute('aria-valuenow', '448');

  // A drag moves a guide; the panel and the canvas change once, on release.
  const box = await grip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, 450);
  await page.mouse.down();
  await page.mouse.move(WIDE.width - 600, 450, { steps: 6 });
  expect((await geometry(page)).inset).toBe(448);
  await expect(page.locator('#agent-dock')).toHaveAttribute('data-resizing', 'true');
  await page.mouse.up();
  await expect.poll(async () => (await geometry(page)).inset).toBe(600);
  // Never so wide that the plot beside it and the sidebar is under 480 px
  // (nor over half the window): widening stops there, still a panel.
  const sidebarRight = await page.evaluate(() => document.querySelector('#sidebar').getBoundingClientRect().right);
  const widest = Math.min(WIDE.width / 2, Math.floor(WIDE.width - sidebarRight - 480));
  await grip.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => (await geometry(page)).inset).toBe(widest);
  expect((await geometry(page)).layout).toBe('side');
  for (let i = 0; i < 20; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await geometry(page)).inset).toBe(320);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#agent-dock')).toHaveAttribute('data-layout', 'side');
  await expect.poll(async () => (await geometry(page)).inset).toBe(320);
  await page.locator('#agent-dock-grip').dblclick();
  await expect.poll(async () => (await geometry(page)).inset).toBe(400);
  expect(errors).toEqual([]);
});

test('on a narrow window the open chat stays a bar over the plot\'s foot, and becomes the side panel when the window widens', async ({ page }) => {
  const errors = observeProductErrors(page);
  await page.setViewportSize({ width: 900, height: 800 });
  await openAgentDataset(page);
  await openChat(page);
  const narrow = await geometry(page);
  expect(narrow.layout).toBe('bar');
  expect(narrow.inset).toBe(0);
  await expect(page.locator('#agent-dock-grip')).toBeHidden();
  await page.setViewportSize(WIDE);
  await expect.poll(async () => (await geometry(page)).layout).toBe('side');
  expect(errors).toEqual([]);
});

test('the prompt cache is offered for a provider that has a choice of cache length, and is remembered', async ({ page }) => {
  await openAgentDataset(page);
  await openChat(page);
  await page.locator('#agent-chat-settings-btn').click();
  // The scripted model caches nothing: no choice to offer.
  await expect(page.locator('#agent-chat-cache-row')).toBeHidden();
  await page.locator('#agent-chat-provider').selectOption('anthropic');
  await expect(page.locator('#agent-chat-cache-row')).toBeVisible();
  await expect(page.locator('#agent-chat-cache')).toHaveValue('5m');
  await page.locator('#agent-chat-cache').selectOption('1h');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cellucid:agent-chat')).cache)).toBe('1h');
});
