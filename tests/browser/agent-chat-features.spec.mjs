/**
 * The chat bar's settings and tools on a real page, with the scripted model
 * (`helpers/agent-chat.mjs`): the person's permissions for agents (read only
 * refuses a change with the sentence the model reads, and the model is told
 * the permissions with the message; heavy work, judged from the owner's
 * estimate, asks first with the estimate, and "This chat" and "Always"
 * answer it), the effort chosen and sent, a message and its steps finding
 * each other (Show, the timeline's turn with its agent and model, its Chat
 * button), and the chat's own tools: Copy, what was sent, the tokens, Edit,
 * Export, Try again, the first prompts offered, `/`, and a token budget;
 * and the chat across datasets (the chat belongs to the tab, a history to
 * its dataset): the agent opening another dataset goes on there, the person
 * opening one stops the turn, each history keeps its part. The Agents
 * panel shows the same permissions line.
 */
import { readFile } from 'node:fs/promises';

import { expect, test } from './helpers/test.mjs';
import { expectDownloadNamed } from './helpers/downloads.mjs';
import { START, TRAJECTORY, expectSettledOn, startUrl } from './helpers/dataset-loading.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { tabKey } from './helpers/dialog-keys.mjs';
import {
  COLOR_BY_SCORE, agentRequests, installScriptedModel, observeProductErrors, openAgentDataset, openChat,
  queueReplies, say, stepFacts, waitForHold, waitForTurnEnd,
} from './helpers/agent-chat.mjs';

/** A clipboard that keeps what was copied (`window.__copied`), the same in every engine. */
function installClipboard() {
  window.__copied = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async text => { window.__copied.push(text); } },
  });
}

async function openSettings(page) {
  await page.locator('#agent-chat-settings-btn').click();
  await expect(page.locator('#agent-chat-settings')).toBeVisible();
}

async function closeSettings(page) {
  await page.locator('#agent-chat-settings-btn').click();
  await expect(page.locator('#agent-chat-settings')).toBeHidden();
}

async function storedPermissions(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('cellucid:agent-permissions') ?? 'null'));
}

test.describe('agent chat features', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installScriptedModel);
    await page.addInitScript(installClipboard);
  });

  test('read only refuses an agent\'s change with the sentence the model reads; the model is told the permissions with the message', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await openChat(page);
    await openSettings(page);
    await expect(page.locator('#agent-chat-permissions-summary')).toHaveText('Ask before heavy');
    await page.locator('#agent-chat-permissions-change').click();
    const dialog = page.locator('#agent-permissions-dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('input[name="agent-permission-mode"][value="read-only"]').check();
    await expect(dialog.locator('select[data-kind="change"]')).toHaveValue('deny');
    await dialog.locator('.app-dialog-close').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#agent-chat-permissions-summary')).toHaveText('Read only');
    expect((await storedPermissions(page)).kinds.change).toBe('deny');
    await closeSettings(page);
    // The Agents panel shows the same settings: they govern Claude and ChatGPT through the connector too.
    await page.evaluate(() => { document.getElementById('agents-section').open = true; });
    await expect(page.locator('#agent-connect-permissions-summary')).toHaveText('Read only');
    // One line in the sidebar, nothing wrapped.
    for (const mode of ['ask', 'allow-undoable', 'read-only']) {
      const lines = await page.evaluate(async chosen => {
        window._cellucidUi.agents.presence.permissions.set({ mode: chosen });
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('agent-connect-permissions-summary'));
        return range.getClientRects().length;
      }, mode);
      expect(lines, `${mode}: one line`).toBe(1);
    }
    await page.evaluate(() => window._cellucidUi.agents.presence.permissions.set({ mode: 'read-only' }));
    await page.locator('#agent-connect-permissions-change').click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('input[name="agent-permission-mode"][value="read-only"]')).toBeChecked();
    await dialog.locator('.app-dialog-close').click();
    await expect(dialog).toBeHidden();

    await queueReplies(page, [{ calls: [COLOR_BY_SCORE] }, { text: 'I may only read here.' }]);
    await say(page, 'Color by score');
    await expect(page.locator('#agent-chat-log .agent-tool[data-tool="color_by"]')).toHaveAttribute('data-state', 'refused');
    // No step of the agent's (opening the Agents section above is the person's own step of the layout).
    expect((await stepFacts(page)).filter(step => step.origin === 'agent')).toEqual([]);
    const requests = await agentRequests(page);
    // Told with the message, as Cellucid's addition the model reads.
    expect(requests[0].messages[0].text).toMatch(/^Color by score\n\n\[Cellucid: Permissions: The person's permissions for agents in Cellucid now \(Read only\): /);
    const refusal = requests[1].messages.at(-1).results[0];
    expect(refusal.isError).toBe(true);
    expect(refusal.content[0].text).toMatch(/do not let agents change anything in this tab, so “Color the cells by a field or gene” was not done/);
    // Unchanged permissions are not told again.
    await queueReplies(page, [{ text: 'Still reading only.' }]);
    await say(page, 'Fine');
    expect((await agentRequests(page)).at(-1).messages.at(-1).text).toBe('Fine');
    // Changed, they are told with the next message; the tools stay exactly the same all chat long
    // (a model's reasoning is bound to the tools it was given), and none says a permission.
    await page.evaluate(() => window._cellucidUi.agents.presence.permissions.set({ mode: 'allow-undoable' }));
    await queueReplies(page, [{ text: 'Now I may change things.' }]);
    await say(page, 'Go on');
    const all = await agentRequests(page);
    expect(all.at(-1).messages.at(-1).text).toMatch(/^Go on\n\n\[Cellucid: Permissions: The person's permissions for agents in Cellucid now \(Allow everything undoable without asking\): /);
    expect(new Set(all.map(request => request.toolsText)).size).toBe(1);
    expect(all[0].toolsText).not.toMatch(/The person's settings/);
    expect(errors).toEqual([]);
  });

  test('a card waiting with the chat collapsed: its turn\'s line shows Stop; Stop withdraws the card and ends the turn', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await page.evaluate(async () => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      getActions().provideEstimate('color.by', () => ({ ms: 30_000, bytes: null, what: 'coloring every cell' }));
    });
    await openChat(page);
    const card = page.locator('#agent-presence .agent-confirm');
    await queueReplies(page, [{ calls: [COLOR_BY_SCORE] }, { text: 'never asked for' }]);
    await page.locator('#agent-chat-input').fill('Color by score');
    await page.locator('#agent-chat-input').press('Enter');
    await expect(card).toHaveAttribute('data-asking', 'heavy');
    await page.locator('#agent-chat-collapse').click();
    const line = page.locator('#agent-presence .agent-activity[data-agent="Claude"]');
    await expect(line).toHaveAttribute('data-state', 'acting');
    await line.locator('.agent-activity-stop').click();
    await expect(card).toHaveCount(0);
    await expect(line).toHaveAttribute('data-state', 'stopped');
    await page.locator('#agent-chat-toggle').click();
    await expect(page.locator('#agent-chat-send')).toBeVisible();
    await expect(page.locator('#agent-chat-log .agent-msg-note[data-kind="stopped"] p').last()).toHaveText('Stopped.');
    expect((await stepFacts(page)).filter(step => step.origin === 'agent')).toEqual([]);
    expect(await agentRequests(page)).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('heavy work asks first with its estimate; This chat allows it in that chat only; Always sets the kind', async ({ page, browserName }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    // Coloring estimated, by the page's own measure, to take 30 s here.
    await page.evaluate(async () => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      getActions().provideEstimate('color.by', () => ({ ms: 30_000, bytes: null, what: 'coloring every cell' }));
    });
    await openChat(page);
    const card = page.locator('#agent-presence .agent-confirm');

    await queueReplies(page, [{ calls: [COLOR_BY_SCORE] }, { text: 'Colored.' }]);
    await page.locator('#agent-chat-input').fill('Color by score');
    await page.locator('#agent-chat-input').press('Enter');
    await expect(card).toHaveAttribute('data-asking', 'heavy');
    await expect(card.locator('.agent-confirm-title')).toHaveText(/^Claude \(chat\) asks to color the cells by a field or gene: [^“”]+\.$/);
    await expect(card.locator('.agent-confirm-why')).toHaveText('It is heavy work: Coloring every cell, about 30.0 s on this device.');
    await expect(page.locator('#agent-chat-log .agent-chat-working')).toHaveAttribute('data-phase', 'asking');
    await expect(page.locator('#agent-chat-status')).toHaveText('Waiting for your answer above…');
    await expect(card.locator('.agent-confirm-allow-here')).toHaveText('This chat');
    // A keyboard user is brought to the question, reaches its answers with Tab, and is brought back after.
    await expect(card).toBeFocused();
    // WebKit on macOS moves to buttons with Option-Tab (Tab alone skips them, as Safari does by default).
    await page.keyboard.press(tabKey(browserName));
    await expect.poll(() => card.evaluate(element => element.contains(document.activeElement) && element !== document.activeElement)).toBe(true);
    await card.locator('.agent-confirm-allow-here').focus();
    await page.keyboard.press('Enter');
    await waitForTurnEnd(page);
    await expect(card).toHaveCount(0);
    await expect(page.locator('#agent-chat-input')).toBeFocused();
    expect((await stepFacts(page)).map(step => step.type)).toEqual(['color.by']);

    // The same chat: allowed without asking.
    await queueReplies(page, [{ calls: [{ name: 'color_by', args: { field: null } }] }, { text: 'Back to none.' }]);
    await say(page, 'Take the color away');
    expect((await stepFacts(page)).map(step => step.type)).toEqual(['color.by', 'color.by']);

    // A new chat asks again; Always sets heavy work to Allow for every agent.
    await page.locator('#agent-chat-new').click();
    await queueReplies(page, [{ calls: [COLOR_BY_SCORE] }, { text: 'Colored again.' }]);
    await page.locator('#agent-chat-input').fill('Color by score again');
    await page.locator('#agent-chat-input').press('Enter');
    await expect(card).toHaveCount(1);
    await card.locator('.agent-confirm-allow-always').click();
    await waitForTurnEnd(page);
    expect((await stepFacts(page)).map(step => step.type)).toEqual(['color.by', 'color.by', 'color.by']);
    expect((await storedPermissions(page)).kinds.heavy).toBe('allow');
    await openSettings(page);
    await expect(page.locator('#agent-chat-permissions-summary')).toHaveText('Allow undoable');
    await page.locator('#agent-chat-permissions-change').click();
    await expect(page.locator('#agent-permissions-dialog .agent-permission-grants')).toContainText('1 kind allowed for a chat or connection until this page closes.');
    await page.locator('#agent-permissions-dialog .agent-permission-grants button').click();
    await expect(page.locator('#agent-permissions-dialog .agent-permission-grants')).toContainText('Nothing allowed for one chat or connection.');
    expect(errors).toEqual([]);
  });

  test('the effort the model takes is chosen in the settings, sent with each call, and remembered for that model', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await openChat(page);
    await openSettings(page);
    await expect(page.locator('#agent-chat-effort-row')).toBeVisible();
    await expect(page.locator('#agent-chat-effort option')).toHaveText(['Model\'s default', 'Low', 'High']);
    await expect(page.locator('#agent-chat-effort')).toHaveValue('');
    await page.locator('#agent-chat-effort').selectOption('high');
    await expect(page.locator('#agent-chat-status')).toHaveText('Claude · Scripted · high effort');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cellucid:agent-chat')).efforts)).toEqual({ 'scripted:scripted': 'high' });
    await closeSettings(page);
    await say(page, 'Think hard');
    expect((await agentRequests(page)).at(-1).effort).toBe('high');
    await openSettings(page);
    await page.locator('#agent-chat-effort').selectOption('');
    await expect(page.locator('#agent-chat-status')).toHaveText('Claude · Scripted');
    await closeSettings(page);
    await say(page, 'As usual');
    expect((await agentRequests(page)).at(-1).effort).toBe(null);
    expect(errors).toEqual([]);
  });

  test('a message and its steps find each other: Show opens the step in the history; the timeline\'s turn names agent and model and opens the message', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await openChat(page);
    await queueReplies(page, [{ calls: [COLOR_BY_SCORE] }, { text: 'Colored by score. Low to high.' }]);
    await say(page, 'Color by score.');
    const [step] = await stepFacts(page);
    const log = page.locator('#agent-chat-log');

    await page.evaluate(() => { document.getElementById('state-section').open = false; });
    await log.locator('.agent-tool[data-tool="color_by"] .agent-tool-show').click();
    await expect(page.locator('#state-section')).toHaveAttribute('open', '');
    // The chat's Show reveals the turn in the graph, its row selected.
    const turn = page.locator(`#history-graph .hg-row[data-kind="turn"][data-key^="t:${step.turn}@"]`);
    await expect(turn).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(`#history-graph .hg-row[data-key="s:${step.id}"]`)).toBeVisible();
    // The turn's steps button shows its last step the same way.
    await expect(log.locator(`.agent-turn-foot[data-turn="${step.turn}"] .agent-turn-steps`)).toHaveText('1 step ↗');
    await page.locator('#history-graph .hg-row[data-kind="step"]').first().click();
    await expect(turn).toHaveAttribute('aria-selected', 'false');
    // The steps chip opens the turn's rows and selects the turn.
    await log.locator(`.agent-turn-foot[data-turn="${step.turn}"] .agent-turn-steps`).click();
    await expect(turn).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(`#history-graph .hg-row[data-key="s:${step.id}"]`)).toBeVisible();

    // The turn's row names the agent and its model on one line, and its ↗ opens the message.
    // The model as the step records it (its id; a Claude id reads as "Sonnet 4.6").
    await expect(turn.locator('.hg-label')).toHaveText('Claude · scripted');
    expect(await turn.locator('.hg-label').evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getClientRects().length;
    }), 'the agent and model: one line').toBe(1);
    await page.locator('#agent-chat-collapse').click();
    await expect(page.locator('#agent-chat-panel')).toBeHidden();
    await turn.locator('.hg-chat').click();
    await expect(page.locator('#agent-chat-panel')).toBeVisible();
    await expect(log.locator(`.agent-msg-user[data-turn="${step.turn}"]`)).toBeInViewport();
    expect(errors).toEqual([]);
  });

  test('Send comes back with the turn\'s last reply in the log, however late the next frame is', async ({ page }) => {
    await openAgentDataset(page);
    await openChat(page);
    // Frames come late once the first reply is drawn: a turn ends well before the next one.
    await page.evaluate(() => {
      const nextFrame = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => nextFrame(time => {
        if (document.querySelector('#agent-chat-log .agent-msg-agent') === null) callback(time);
        else window.setTimeout(() => callback(time), 3000);
      });
    });
    await queueReplies(page, [{ calls: [COLOR_BY_SCORE] }, { text: 'Colored by **score**.' }]);
    await page.locator('#agent-chat-input').fill('Color by score');
    await page.locator('#agent-chat-input').press('Enter');
    await expect(page.locator('#agent-chat-input')).toHaveValue('');
    await expect(page.locator('#agent-chat-stop')).toBeHidden();
    // Read once, in the same moment: not a wait for the frame.
    expect(await page.evaluate(() => [...document.querySelectorAll('#agent-chat-log .agent-msg-agent')].at(-1)?.textContent ?? '')).toContain('Colored by');
  });

  test('Copy, what was sent, the tokens, Edit, Export and Try again', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await openChat(page);
    await queueReplies(page, [{ calls: [COLOR_BY_SCORE] }, { text: 'Colored by **score**.', usage: { input: 1200, output: 30 } }]);
    await say(page, 'Color by score');
    const log = page.locator('#agent-chat-log');

    const reply = log.locator('.agent-msg-agent').last();
    await reply.locator('.agent-msg-copy').click();
    await expect(reply.locator('.agent-msg-copy')).toHaveText('Copied');
    expect(await page.evaluate(() => window.__copied)).toEqual(['Colored by **score**.']);

    const foot = log.locator('.agent-turn-foot').last();
    await expect(foot.locator('.agent-turn-sent-line')).toBeHidden();
    await foot.locator('.agent-turn-sent').click();
    await expect(foot.locator('.agent-turn-sent')).toHaveAttribute('aria-expanded', 'true');
    await expect(foot.locator('.agent-turn-sent-line')).toHaveText(/^Sent to Scripted model: your message and 1 tool result \([\d,]+ characters\)\. That is all that left this browser for this turn; the dataset's files stay here, but a result can carry part of the data \(the values of cells, a picture of the plot\)\. This turn: [\d,]+ tokens read \(0 from the cache\), 30 written, in 2 calls\.$/);
    await openSettings(page);
    await expect(page.locator('#agent-chat-usage')).toHaveText(/^This chat: [\d,]+ tokens read \(0 from the cache\), 30 written, in 2 calls\.$/);
    await closeSettings(page);

    await log.locator('.agent-msg-user .agent-msg-edit').click();
    await expect(page.locator('#agent-chat-input')).toHaveValue('Color by score');
    await expect(page.locator('#agent-chat-input')).toBeFocused();
    await page.locator('#agent-chat-input').fill('');

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#agent-chat-export').click();
    const download = await downloadPromise;
    await expectDownloadNamed(download, /^cellucid-chat-\d{8}_\d{6}\.md$/);
    const markdown = await readFile(await download.path(), 'utf8');
    expect(markdown).toContain('# Cellucid chat: Current UI fixture');
    expect(markdown).toContain('**You**\n\n> Color by score');
    expect(markdown).toContain('- `color_by` — step "Colored by score"');
    expect(markdown).toContain('Colored by **score**.');

    // A failed turn offers Try again, which sends its message again as a new turn.
    await queueReplies(page, [{ error: { kind: 'auth', message: 'The provider did not accept this key.' } }]);
    await say(page, 'Are you there?');
    const note = log.locator('.agent-msg-note[data-kind="error"]');
    await expect(note).toContainText('The provider did not accept this key.');
    await queueReplies(page, [{ text: 'Here now.' }]);
    await note.locator('.agent-msg-retry').click();
    await waitForTurnEnd(page);
    await expect(log.locator('.agent-msg-user .agent-msg-text').last()).toHaveText('Are you there?');
    await expect(log.locator('.agent-msg-agent').last()).toContainText('Here now.');
    expect(errors).toEqual([]);
  });

  test('the empty chat offers first prompts from the dataset; / opens the chat at its message; a budget stops the chat before its next call', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await openChat(page);
    const chips = page.locator('#agent-chat-log .agent-chat-suggestion');
    await expect(chips.first()).toHaveText('Give me a first look at this dataset');
    // The chips are the dataset's own (its clustering, its field of the cells' identity).
    const offered = await page.evaluate(async () => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      const { readSuggestionFacts, suggestionsFor } = await import('/assets/js/app/agent/chat/suggestions.js');
      return suggestionsFor(await readSuggestionFacts(getActions(), 0));
    });
    expect(offered.length).toBeGreaterThan(1);
    await expect(chips).toHaveText(offered);

    // `/` outside a field: the collapsed chat opens; open, it focuses the message.
    await page.locator('#agent-chat-collapse').click();
    await page.locator('body').press('/');
    await expect(page.locator('#agent-chat-panel')).toBeVisible();
    await page.locator('#agent-chat-title').click();
    await page.locator('body').press('/');
    await expect(page.locator('#agent-chat-input')).toBeFocused();
    await expect(page.locator('#agent-chat-input')).toHaveValue('');

    await queueReplies(page, [{ text: 'A first look.', usage: { input: 900, output: 100 } }]);
    await chips.first().click();
    await waitForTurnEnd(page);
    await expect(page.locator('#agent-chat-log .agent-msg-user .agent-msg-text')).toHaveText('Give me a first look at this dataset');

    await openSettings(page);
    await page.locator('#agent-chat-budget').fill('500');
    await page.locator('#agent-chat-budget').press('Tab');
    await expect(page.locator('#agent-chat-usage')).toHaveText('This chat: 900 tokens read (0 from the cache), 100 written, in 1 call. Budget 500 tokens: spent.');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cellucid:agent-chat')).budget)).toBe(500);
    await closeSettings(page);
    const calls = (await agentRequests(page)).length;
    await say(page, 'Go on');
    await expect(page.locator('#agent-chat-log .agent-msg-note[data-kind="limit"]'))
      .toContainText('This chat used 1,000 tokens, its budget is 500; raise it in the chat settings to go on.');
    expect((await agentRequests(page)).length).toBe(calls);
    expect(errors).toEqual([]);
  });

  test('the chat belongs to the tab, a history to its dataset: the agent opening another dataset goes on there; the person opening one stops the turn', async ({ page }) => {
    const errors = observeProductErrors(page);
    await page.goto(startUrl(), { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await expectSettledOn(page, START);
    await openChat(page);
    const log = page.locator('#agent-chat-log');
    const chatsShown = () => page.evaluate(() => {
      const history = window._cellucidHistories.current();
      return history.chatsOf(history.active.id).map(([, transcript]) => transcript.messages.map(message => message.role));
    });

    // The agent opens another dataset in its turn: the turn goes on there, kept with that dataset's history.
    await queueReplies(page, [
      { text: 'Opening the trajectory.', calls: [{ name: 'dataset_open', args: { name: 'trajectory' } }] },
      { calls: [{ name: 'fields_list', args: {} }] },
      { text: 'The trajectory is open.' },
    ]);
    await say(page, 'Open the trajectory and look at it');
    await expectSettledOn(page, TRAJECTORY);
    await expect(log.locator('.agent-tool[data-tool="dataset_open"]')).toHaveAttribute('data-state', 'read');
    await expect(log.locator('.agent-msg-agent').last()).toContainText('The trajectory is open.');
    await expect(log.locator('.agent-msg-user')).toHaveCount(1);
    expect(await chatsShown()).toEqual([['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']]);

    // The person opens another dataset while a turn runs: the turn stops, kept where it began; the chat shows the new dataset's.
    await queueReplies(page, [{ text: 'Reading slowly through every field. '.repeat(10), chunks: 5, hold: 'reading' }]);
    await page.locator('#agent-chat-input').fill('Take your time');
    await page.locator('#agent-chat-input').press('Enter');
    await waitForHold(page, 'reading');
    await expect(log.locator('[data-streaming="true"]')).toContainText('Reading slowly');
    await page.locator('#dataset-select').selectOption(START.select);
    await expectSettledOn(page, START);
    await expect(page.locator('#agent-chat-send')).toBeVisible();
    await expect(log.locator('.agent-msg-user')).toHaveCount(0);
    await expect(log.locator('.agent-chat-empty')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
