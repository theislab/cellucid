/**
 * A chat kept mid-turn: the page reloaded, or its tab closed, while a call of
 * the agent waited for the person's answer. The conversation kept with the
 * history then holds the agent's call with no result; continued, each such
 * call is answered with what became of it (here: nothing was applied), its
 * row says interrupted rather than running for ever, and the next message is
 * sent a conversation in which every call has its result (a provider refuses
 * one that has not).
 */
import { closePageWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { continueWhereLeftOff, dismissWelcome } from './helpers/welcome.mjs';
import {
  AGENT_DATASET_URL, COLOR_BY_SCORE, agentRequests, installScriptedModel, observeProductErrors, openAgentDataset, openChat,
  queueReplies, say, stepFacts,
} from './helpers/agent-chat.mjs';

/** Open the page again, by a reload or in a new tab after the first closed. */
async function reopen(context, page, how) {
  let next = page;
  if (how === 'close-tab') {
    next = await context.newPage();
    await next.addInitScript(installScriptedModel);
    // The tab closes as a person closes it: the application retires (the page hides), then the page goes.
    await closePageWithApplicationRetirement(page);
  }
  await next.goto(AGENT_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(next);
  return next;
}

for (const how of ['reload', 'close-tab']) {
  test(`${how} while the agent's call waits for the person: the call is answered as interrupted, and the chat goes on`, async ({ page, context }) => {
    const errors = observeProductErrors(page);
    await page.addInitScript(installScriptedModel);
    await openAgentDataset(page);
    await openChat(page);
    // A first turn with a step, so the history (and the conversation with it) is kept.
    await queueReplies(page, [{ calls: [{ name: 'highlight_cells', args: { cells: [1, 2, 3] } }] }, { text: 'Highlighted.' }]);
    await say(page, 'Highlight three cells');
    // The person's settings ask before every change: the next call waits on a card.
    await page.evaluate(() => window._cellucidUi.agents.presence.permissions.set({ kinds: { change: 'ask' } }));
    // A change (the dataset opens colored by cell_type): were it run, it would be a step.
    await queueReplies(page, [{ text: 'Coloring.', calls: [COLOR_BY_SCORE] }, { text: 'Done.' }]);
    await page.locator('#agent-chat-input').fill('Color by score');
    await page.locator('#agent-chat-input').press('Enter');
    await expect(page.locator('#agent-presence .agent-confirm')).toHaveCount(1);
    // What the autosave keeps now: the call, and no result yet.
    await page.evaluate(() => window._cellucidHistories.flush());
    const stepsBefore = (await stepFacts(page)).length;

    const next = await reopen(context, page, how);
    const errorsAfter = observeProductErrors(next);
    await continueWhereLeftOff(next);
    const log = next.locator('#agent-chat-log');
    await expect(log.locator('.agent-msg-user .agent-msg-text').last()).toHaveText('Color by score');
    const row = log.locator('.agent-tool[data-tool="color_by"]');
    if (how === 'reload') {
      // The page went at once: the kept conversation has the call and no result; it is answered on the way back.
      await expect(row).toHaveAttribute('data-state', 'interrupted');
      await expect(row.locator('.agent-tool-label')).toHaveText('Color the cells by a field or gene: score · interrupted');
      await row.locator('.agent-tool-head').click();
      await expect(row.locator('.agent-tool-result')).toContainText('The page closed before this call finished; nothing was applied.');
    } else {
      // The tab closed as the application retires: the question is refused as the page hides (the call
      // refused, or stopped with its turn), kept if the last save came after that; else it is answered
      // on the way back. Either way nothing ran.
      await expect(row).toHaveAttribute('data-state', /^(stopped|refused|interrupted)$/);
      await row.locator('.agent-tool-head').click();
      await expect(row.locator('.agent-tool-result')).toContainText(/The page closed before this call finished; nothing was applied\.|Stopped before it finished|Not run|The Cellucid tab was closed before the person answered; nothing was done\./);
    }
    expect(await stepFacts(next)).toHaveLength(stepsBefore);
    await expect(log.locator('.agent-tool[data-state="running"]')).toHaveCount(0);

    // The chat goes on: every call it sends is followed by its result.
    await next.evaluate(() => window._cellucidUi.agents.presence.permissions.set({ mode: 'ask' }));
    await queueReplies(next, [{ text: 'Still here.' }]);
    await say(next, 'Are you there?');
    const sent = (await agentRequests(next)).at(-1).messages;
    sent.forEach((message, index) => {
      for (const call of (message.parts ?? []).filter(part => part.type === 'tool-call')) {
        expect(sent[index + 1]?.role, `call ${call.name} is followed by its result`).toBe('tool');
        expect(sent[index + 1].results.map(result => result.id)).toContain(call.id);
      }
    });
    await expect(log.locator('.agent-msg-agent').last()).toContainText('Still here.');
    expect([...(how === 'reload' ? [] : errors), ...errorsAfter]).toEqual([]);
  });
}
