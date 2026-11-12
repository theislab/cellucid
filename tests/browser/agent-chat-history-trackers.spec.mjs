/**
 * An agent's history actions that show another tracker go on in its turn
 * (live pass 3, L12-8). Verifying a branch replays it on a scratch tracker of
 * its own and comes back; starting, using or replaying a tracker shows that
 * one. The chat took each change of the tracker shown for the person's and
 * stopped the turn, then continued the conversation it had kept, whose
 * running call it answered "The page closed before this call finished;
 * nothing was applied", with "The page closed during this turn": an Opus
 * turn asked to verify the Pdx1 path on Pancreas ended there, mid-sentence.
 * Starting a tracker also failed for every agent (L12-11: the new tracker's
 * opening named a turn it did not hold). With the scripted model
 * (`helpers/agent-chat.mjs`).
 */
import { expect, test } from './helpers/test.mjs';
import {
  AGENT_DATASET_URL, CELL_TYPE, COLOR_BY_SCORE, agentRequests, installScriptedModel, observeProductErrors, openAgentDataset, openChat, queueReplies,
  resultJson, say, waitForTurnEnd,
} from './helpers/agent-chat.mjs';
import { continueWhereLeftOff, dismissWelcome } from './helpers/welcome.mjs';

test.describe('agent chat: history actions that show another tracker', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installScriptedModel);
  });

  test('verifying a branch and starting a tracker go on in the turn: no stop, no call said lost, the conversation kept where it ends', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await openChat(page);
    const log = page.locator('#agent-chat-log');
    await queueReplies(page, [
      { calls: [COLOR_BY_SCORE] },
      { calls: [{ name: 'history_verify', args: { branch: 'Main' } }] },
      { calls: [{ name: 'history_tracker_start', args: { name: 'Second look' } }] },
      { text: 'Main replays exactly, and a second tracker is started.' },
    ]);
    await say(page, 'Color by score, verify Main, then start a second tracker');
    await waitForTurnEnd(page);
    await expect(log.locator('.agent-msg-agent').last()).toContainText('Main replays exactly, and a second tracker is started.');
    await expect(log.locator('.agent-msg-note')).toHaveCount(0);

    const kept = await page.evaluate(() => {
      const history = window._cellucidHistories.current();
      const messages = window._cellucidUi.agents.chat.conversation.messages;
      const results = messages.filter(message => message.role === 'tool').flatMap(message => message.results);
      return {
        tracker: history.active.name,
        chats: history.chatsOf(history.active.id).map(([, transcript]) => transcript.messages.map(message => message.role)),
        results: results.map(result => ({ name: result.name, isError: result.isError, interrupted: result.interrupted === true })),
        verified: results.find(result => result.name === 'history_verify')?.content?.[0]?.text ?? '',
      };
    });
    expect(kept.results).toEqual([
      { name: 'color_by', isError: false, interrupted: false },
      { name: 'history_verify', isError: false, interrupted: false },
      { name: 'history_tracker_start', isError: false, interrupted: false },
    ]);
    expect(kept.verified).toContain('"reproduced":true');
    expect(kept.tracker).toBe('Second look');
    expect(kept.chats).toEqual([['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool', 'assistant']]);
    expect(errors).toEqual([]);
  });

  test('opening a saved state to continue it goes on in the turn that opened it (F114)', async ({ page }) => {
    // Asked to "continue my saved work", an agent could only replay it
    // (live pass 3, L12-13); `history_saved_open` is Load…'s Open. The load
    // it makes is the turn's own: the chat stopped a turn at any load.
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await openChat(page);
    const log = page.locator('#agent-chat-log');
    await queueReplies(page, [
      { calls: [COLOR_BY_SCORE] },
      { calls: [{ name: 'history_save', args: { name: 'Scored' } }] },
      { text: 'Saved as Scored.' },
    ]);
    await say(page, 'Color by score and save it as Scored');
    const saved = await page.evaluate(async () => (await window._cellucidHistories.savedStates.list()).find(state => state.name === 'Scored').id);
    await queueReplies(page, [
      { calls: [{ name: 'color_by', args: { field: CELL_TYPE } }] },
      { calls: [{ name: 'history_saved_open', args: { saved } }] },
      { text: 'Scored is open again.' },
    ]);
    await say(page, 'Color by cell type, then continue my saved work Scored');
    await waitForTurnEnd(page);
    await expect(log.locator('.agent-msg-agent').last()).toContainText('Scored is open again.');
    await expect(log.locator('.agent-msg-note')).toHaveCount(0);
    const after = await page.evaluate(() => {
      const results = window._cellucidUi.agents.chat.conversation.messages
        .filter(message => message.role === 'tool').flatMap(message => message.results);
      const opened = results.find(result => result.name === 'history_saved_open');
      return { isError: opened.isError, text: opened.content[0].text, field: window._cellucidState.getActiveField()?.key ?? null };
    });
    expect(after.isError).toBe(false);
    expect(resultJson(after.text)).toMatchObject({ saved, name: 'Scored', dataset_opened: false, already_shown: false });
    // The saved state's own coloring is shown again.
    expect(after.field).toBe('score');
    expect(errors).toEqual([]);
  });

  test('what the person did between turns is told with the next message: after a reload, and when another history is shown (F270)', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await openChat(page);
    await queueReplies(page, [{ calls: [COLOR_BY_SCORE] }, { text: 'Colored by score.' }]);
    await say(page, 'Color by score');
    // The person recolors by hand between turns, then the page reloads and they continue.
    await page.evaluate(async field => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      await getActions().dispatch('color.by', { field });
    }, CELL_TYPE);
    await page.evaluate(() => window._cellucidHistories.flush());
    await page.goto(AGENT_DATASET_URL, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await continueWhereLeftOff(page);
    // The chat was open and the scripted model chosen: this browser remembers both; the conversation is back.
    await expect(page.locator('#agent-chat-panel')).toBeVisible();
    await expect(page.locator('#agent-chat-log .agent-msg-user .agent-msg-text')).toHaveText('Color by score');
    await queueReplies(page, [{ text: 'You colored by cell type since.' }]);
    await say(page, 'What did I change?');
    const lastUserText = requests => {
      const messages = requests.at(-1).messages;
      const user = messages.findLast(message => message.role === 'user');
      return typeof user.text === 'string' ? user.text : JSON.stringify(user);
    };
    expect(lastUserText(await agentRequests(page))).toMatch(/\[Cellucid: Since your last turn the history changed: The person's step <cellucid-data>"Colored by cell_type"<\/cellucid-data> is now in effect\./);
    // The person starts another tracker: the chat shows a new conversation, whose first message says which history is shown.
    await page.evaluate(async () => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      await getActions().dispatch('history.tracker.start', { name: 'Second look' });
    });
    await expect.poll(() => page.evaluate(() => window._cellucidUi.agents.chat.conversation.messages.length)).toBe(0);
    await queueReplies(page, [{ text: 'This is a new history.' }]);
    await say(page, 'Same questions please');
    const told = lastUserText(await agentRequests(page));
    expect(told).toMatch(/\[Cellucid: Since your last turn the person changed what is shown: the history shown is now <cellucid-data>"Second look"<\/cellucid-data> \(it was <cellucid-data>"[^"]+"<\/cellucid-data>\); no step is in effect there yet; this conversation is not the one of your last turn/);
    expect(errors).toEqual([]);
  });
});
