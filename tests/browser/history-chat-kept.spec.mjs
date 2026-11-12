/**
 * A conversation with an agent that made no step of the history is kept with
 * the history in this browser, and offered again after a reload: Continue
 * shows it again (bug hunt 2026-11-04: it was lost, since only a history with
 * a step was kept).
 */
import { expect, test } from './helpers/test.mjs';
import { continueOffer, continueWhereLeftOff, dismissWelcome } from './helpers/welcome.mjs';
import { AGENT_DATASET_URL, installScriptedModel, openAgentDataset, openChat, queueReplies, say } from './helpers/agent-chat.mjs';

test('a conversation that made no step survives a reload', async ({ page }) => {
  await page.addInitScript(installScriptedModel);
  await openAgentDataset(page);
  await openChat(page);
  await queueReplies(page, [{ calls: [{ name: 'dataset_summary', args: {} }] }, { text: 'It has 120 cells in three types.' }]);
  await say(page, 'What is in this dataset?');
  await expect.poll(() => page.evaluate(() => {
    const history = window._cellucidHistories.current();
    return history.chatsOf(history.active.id).length;
  })).toBe(1);
  expect(await page.evaluate(() => window._cellucidHistories.current().active.steps.size)).toBe(1);
  await page.evaluate(() => window._cellucidHistories.flush());
  await page.goto(AGENT_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  const offer = continueOffer(page);
  await expect(offer).toContainText('1 conversation');
  await continueWhereLeftOff(page);
  await expect.poll(() => page.evaluate(() => {
    const history = window._cellucidHistories.current();
    return history?.active ? history.chatsOf(history.active.id).length : 0;
  }), { timeout: 60_000 }).toBe(1);
});
