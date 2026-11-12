/**
 * F87 (2026-11-11): on a narrow window the open chat is a bar over the plot's
 * foot; while a camera path played it covered the lower part of every frame
 * of the film. Now it folds to its button while a path plays (Play, or the
 * `camera-path.play` action an agent takes) and comes back when the path
 * stops, unless the person is writing a message or opens it again during the
 * play. The side panel of a wide window covers no cell and stays.
 */
import { expect, test } from './helpers/test.mjs';
import { installScriptedModel, observeProductErrors, openAgentDataset, openChat } from './helpers/agent-chat.mjs';

const NARROW = { width: 760, height: 900 };
const WIDE = { width: 1440, height: 900 };

function dispatch(page, type, params = {}) {
  return page.evaluate(async ([actionType, actionParams]) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    const { outcome } = await getActions().dispatch(actionType, actionParams);
    return outcome;
  }, [type, params]);
}

/** A path of two keyframes, 20 s apart: it plays until stopped here. */
async function makePath(page) {
  const camera = await page.evaluate(() => window._cellucidViewer.getCameraState());
  const pose = theta => ({ ...camera, orbit: { ...camera.orbit, theta } });
  await dispatch(page, 'camera-path.keyframe.add', { camera: pose(0.1), label: 'Wide' });
  await dispatch(page, 'camera-path.keyframe.add', { camera: pose(1.4), label: 'Turn' });
  await dispatch(page, 'camera-path.duration.set', { seconds: 20 });
}

/** Play the path as an agent does; the action answers when the path ends, so it is not awaited. */
async function play(page) {
  await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    void getActions().dispatch('camera-path.play', {}).catch(() => {});
  });
  await expect.poll(() => page.evaluate(() => window._cellucidUi.cinematicCamera.getPlaybackController().getState())).toBe('PLAYING');
}

/** Stop as the transport's Stop does (the `camera-path.play` action still runs, so another action would wait for it). */
async function stop(page) {
  await page.evaluate(() => window._cellucidUi.cinematicCamera.getPlaybackController().stop({ resetCamera: false }));
  await expect.poll(() => page.evaluate(() => window._cellucidUi.cinematicCamera.getPlaybackController().getState())).toBe('STOPPED');
}

const panel = page => page.locator('#agent-chat-panel');
const toggle = page => page.locator('#agent-chat-toggle');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installScriptedModel);
});

test('on a narrow window the chat bar folds to its button while a path plays and comes back when it stops', async ({ page }) => {
  await page.setViewportSize(NARROW);
  const errors = observeProductErrors(page);
  await openAgentDataset(page);
  await openChat(page);
  await expect(page.locator('#agent-dock')).toHaveAttribute('data-layout', 'bar');
  await page.locator('#agent-chat-input').focus();
  await makePath(page);

  await play(page);
  await expect(panel(page)).toBeHidden();
  await expect(toggle(page)).toBeVisible();
  await expect(page.locator('#agent-dock')).toHaveAttribute('data-chat-open', 'false');
  // Folded for the film, not closed: the person's choice is kept.
  expect(await page.evaluate(() => {
    const chat = window._cellucidUi.agents.chat;
    return { open: chat.open, folded: chat.foldedForFilm };
  })).toEqual({ open: true, folded: true });

  await stop(page);
  await expect(panel(page)).toBeVisible();
  await expect(page.locator('#agent-dock')).toHaveAttribute('data-chat-open', 'true');
  // The message field it had has the focus again.
  await expect(page.locator('#agent-chat-input')).toBeFocused();

  // Paused, the person looks at the frame with the chat.
  await play(page);
  await expect(panel(page)).toBeHidden();
  await page.evaluate(() => window._cellucidUi.cinematicCamera.getPlaybackController().pause());
  await expect(panel(page)).toBeVisible();
  await stop(page);
  expect(errors).toEqual([]);
});

test('a message being written, or the chat opened again during the play, keeps it open', async ({ page }) => {
  await page.setViewportSize(NARROW);
  const errors = observeProductErrors(page);
  await openAgentDataset(page);
  await openChat(page);
  await makePath(page);

  // A draft in the field: the person is writing, the chat stays.
  await page.locator('#agent-chat-input').fill('Why does the beta cluster');
  await play(page);
  await expect(panel(page)).toBeVisible();
  await stop(page);
  await page.locator('#agent-chat-input').fill('');

  // Folded, then opened by the person: open for the rest of this play.
  await play(page);
  await expect(panel(page)).toBeHidden();
  await toggle(page).click();
  await expect(panel(page)).toBeVisible();
  // The chat decides again on every render while the path plays (a resize is one): it stays.
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  expect(await page.evaluate(() => window._cellucidUi.agents.chat.foldedForFilm)).toBe(false);
  await expect(panel(page)).toBeVisible();
  await stop(page);
  await expect(panel(page)).toBeVisible();
  // The next play folds it again.
  await play(page);
  await expect(panel(page)).toBeHidden();
  await stop(page);

  // A collapsed chat stays collapsed after the play.
  await page.locator('#agent-chat-collapse').click();
  await play(page);
  await stop(page);
  await expect(panel(page)).toBeHidden();
  expect(errors).toEqual([]);
});

test('on a wide window the side panel stays while a path plays: it covers no cell and the plot keeps its width', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const errors = observeProductErrors(page);
  await openAgentDataset(page);
  await openChat(page);
  await expect(page.locator('#agent-dock')).toHaveAttribute('data-layout', 'side');
  const canvasRight = () => page.evaluate(() => document.querySelector('#glcanvas').getBoundingClientRect().right);
  const before = await canvasRight();
  await makePath(page);
  await play(page);
  await expect(panel(page)).toBeVisible();
  await expect(page.locator('#agent-dock')).toHaveAttribute('data-layout', 'side');
  expect(await canvasRight()).toBe(before);
  await stop(page);
  expect(errors).toEqual([]);
});
