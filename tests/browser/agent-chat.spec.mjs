/**
 * The chat bar and the agent presence (`assets/js/app/agent/`) on a real
 * page, with the scripted model (`providers/scripted.js`) so every run is the
 * same: a turn streams its reply, its tool calls run as the page's own
 * actions and become history steps labeled with the agent and the turn,
 * Undo turn puts every state domain back (the state fingerprint), Stop ends
 * a turn mid-reply, the
 * conversation is kept with the history and comes back with a session file
 * (Save asks whether to include it), an agent's action that asks first shows
 * its card (Allow, Deny, the agent giving up), the activity line follows an
 * agent that is not the chat (a connector's), API keys stay out of
 * localStorage unless Remember is ticked, and the chat fits a phone.
 *
 * The scripted model answers from a queue the spec fills, and records what
 * it was sent (`helpers/agent-chat.mjs`). The permissions, the effort, the
 * history link and the chat's own tools are `agent-chat-features.spec.mjs`.
 */
import { expect, test } from './helpers/test.mjs';
import { openPhoneSheet } from './helpers/panels.mjs';
import { sessionManifest } from './helpers/session-files.mjs';
import {
  COLOR_BY_SCORE, SCORE, fingerprint, installScriptedModel, observeProductErrors, openAgentDataset as openDataset,
  openChat, queueReplies, say, stepFacts, waitForHold, waitForTurnEnd,
} from './helpers/agent-chat.mjs';
import { clickSaveSession, clickLoadSession } from './helpers/session-buttons.mjs';

test.describe('agent chat', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installScriptedModel);
  });

  test('a turn streams its reply, runs its tool calls as labelled steps, and Undo turn puts every domain back', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openDataset(page);
    await openChat(page);
    const before = await fingerprint(page);
    await queueReplies(page, [
      { text: 'Let me look.', calls: [{ name: 'fields_list', args: {} }, COLOR_BY_SCORE] },
      { text: 'I colored the cells by **score**: from low to high.', chunks: 6, delayMs: 20 },
    ]);
    // The dataset opens colored by cell_type (its first coloring): score is a change, so a step.
    await say(page, 'Color the cells by score');

    const log = page.locator('#agent-chat-log');
    await expect(log.locator('.agent-msg-user .agent-msg-text')).toHaveText('Color the cells by score');
    await expect(log.locator('.agent-tool[data-tool="fields_list"]')).toHaveAttribute('data-state', 'read');
    await expect(log.locator('.agent-tool[data-tool="fields_list"] .agent-tool-label')).toHaveText('Listed the fields');
    await expect(log.locator('.agent-tool[data-tool="color_by"]')).toHaveAttribute('data-state', 'step');
    await expect(log.locator('.agent-tool[data-tool="color_by"] .agent-tool-label')).toHaveText('Colored by score');
    await expect(log.locator('.agent-msg-agent').last().locator('strong')).toHaveText('score');

    // The step is the agent's, in the turn of the person's message.
    const turn = await log.locator('.agent-msg-user').getAttribute('data-turn');
    expect(turn).toMatch(/^turn-/);
    const steps = await stepFacts(page);
    expect(steps.map(step => [step.type, step.origin, step.agent, step.turn])).toEqual([['color.by', 'agent', 'Claude', turn]]);
    // The graph shows the turn as one row under the agent's name.
    await expect(page.locator(`#history-graph .hg-row[data-kind="turn"][data-key^="t:${turn}@"]`)).toHaveCount(1);

    // The model was sent the catalog's tools, and the tool results.
    const requests = await page.evaluate(() => window.__agentRequests);
    expect(requests).toHaveLength(2);
    // The catalog's tools and the chat's own question with choices (`ask_person`).
    expect(requests[0].tools).toBe(await page.evaluate(async () => (await import('/assets/js/app/actions/index.js')).getActionCatalog().list().length) + 1);
    expect(requests[1].messages.at(-1).role).toBe('tool');
    expect(requests[1].messages.at(-1).results.map(result => [result.name, result.isError])).toEqual([['fields_list', false], ['color_by', false]]);

    // The tool row opens to what was asked and answered.
    await log.locator('.agent-tool[data-tool="color_by"] .agent-tool-head').click();
    await expect(log.locator('.agent-tool[data-tool="color_by"] .agent-tool-args')).toContainText('"key": "score"');
    await expect(log.locator('.agent-tool[data-tool="color_by"] .agent-tool-result')).toContainText('Colored by score');

    // Undo turn: every domain as before the turn.
    const foot = log.locator(`.agent-turn-foot[data-turn="${turn}"]`);
    await expect(foot.locator('.agent-turn-steps')).toHaveText('1 step ↗');
    await foot.locator('.agent-turn-undo').click();
    await expect(foot.locator('.agent-turn-undo')).toHaveText('Undone');
    await expect(foot.locator('.agent-turn-steps')).toHaveText('1 step undone ↗');
    expect(await fingerprint(page)).toEqual(before);
    expect(errors).toEqual([]);
  });

  test('a conversation left (New chat) is let go: neither it nor the elements and listeners drawn for it are kept', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'garbage collection is asked for through the Chromium DevTools protocol');
    const errors = observeProductErrors(page);
    await openDataset(page);
    await openChat(page);
    await queueReplies(page, [{ text: 'Coloring.', calls: [COLOR_BY_SCORE] }, { text: 'Colored.' }]);
    await say(page, 'Color by score');
    await page.locator('#agent-chat-log .agent-tool-head').click();
    await page.evaluate(() => {
      const log = document.getElementById('agent-chat-log');
      window.__left = {
        conversation: new WeakRef(window._cellucidUi.agents.chat.conversation),
        message: new WeakRef(log.querySelector('.agent-msg-user')),
        reply: new WeakRef(log.querySelector('.agent-msg-agent')),
        row: new WeakRef(log.querySelector('.agent-tool')),
        footer: new WeakRef(log.querySelector('.agent-turn-foot')),
      };
    });
    await page.locator('#agent-chat-new').click();
    await expect(page.locator('#agent-chat-log .agent-msg-user')).toHaveCount(0);
    const cdp = await page.context().newCDPSession(page);
    await expect.poll(async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      return page.evaluate(() => Object.entries(window.__left).filter(([, ref]) => ref.deref() !== undefined).map(([name]) => name));
    }, { intervals: [100, 250, 500, 1000] }).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('Stop ends a turn mid-reply: the words so far stay, nothing else runs', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openDataset(page);
    await openChat(page);
    // The model writes, then is still answering (held) when the person stops it, its call not made yet.
    await queueReplies(page, [{ text: 'Reading the clusters one by one, then I will color them. '.repeat(8), chunks: 8, hold: 'mid-reply', calls: [COLOR_BY_SCORE] }]);
    await page.locator('#agent-chat-input').fill('Annotate the clusters');
    await page.locator('#agent-chat-input').press('Enter');
    await waitForHold(page, 'mid-reply');
    await expect(page.locator('#agent-chat-log [data-streaming="true"]')).toContainText('Reading the clusters');
    await expect(page.locator('#agent-chat-status')).toHaveText('Writing…');
    await page.locator('#agent-chat-stop').click();
    await expect(page.locator('#agent-chat-send')).toBeVisible();
    const log = page.locator('#agent-chat-log');
    await expect(log.locator('.agent-msg-note[data-kind="stopped"] p')).toHaveText('Stopped.');
    await expect(log.locator('.agent-msg-agent').last()).toContainText('Reading the clusters');
    await expect(log.locator('.agent-tool')).toHaveCount(0);
    expect(await stepFacts(page)).toEqual([]);
    // The conversation goes on: the next turn sends the words kept, and no tool call without its result.
    await queueReplies(page, [{ text: 'Stopped as asked.' }]);
    await say(page, 'Never mind');
    const sent = await page.evaluate(() => window.__agentRequests.at(-1).messages);
    expect(sent.map(message => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(sent[1].parts.every(part => part.type === 'text')).toBe(true);
    expect(errors).toEqual([]);
  });

  test('the conversation is kept with the history, Save asks about it, and a session file brings it back', async ({ page }, testInfo) => {
    const errors = observeProductErrors(page);
    await openDataset(page);
    await openChat(page);
    await queueReplies(page, [{ calls: [COLOR_BY_SCORE] }, { text: 'Colored by score.' }]);
    await say(page, 'Color by score please');
    const kept = await page.evaluate(() => {
      const history = window._cellucidHistories.current();
      return history.chatsOf(history.active.id).map(([, transcript]) => transcript.messages.map(message => message.role));
    });
    expect(kept).toEqual([['user', 'assistant', 'tool', 'assistant']]);

    await openPhoneSheet(page);
    // Share names the conversations it can carry; unticked (the default) the file holds none.
    await page.locator('#history-share-btn').click();
    await expect(page.locator('#history-share-chats-label')).toHaveText('Conversations (1)');
    await expect(page.locator('#history-share-chats')).not.toBeChecked();
    let downloadPromise = page.waitForEvent('download');
    await page.locator('#history-share-save').click();
    const without = await (await downloadPromise).path();
    const { readFile } = await import('node:fs/promises');
    const withoutManifest = await sessionManifest(await readFile(without));
    expect(withoutManifest.chunks.filter(chunk => chunk.kind === 'chat')).toHaveLength(0);

    // Closing the dialog saves nothing; ticked, the file holds it.
    await page.locator('#history-share-btn').click();
    await page.locator('#history-share-dialog .app-dialog-close').click();
    await expect(page.locator('#history-share-dialog')).toBeHidden();
    downloadPromise = page.waitForEvent('download');
    await clickSaveSession(page, { chats: true });
    const download = await downloadPromise;
    const sessionPath = testInfo.outputPath('with-chat.cellucid-session');
    await download.saveAs(sessionPath);
    const withManifest = await sessionManifest(await readFile(sessionPath));
    expect(withManifest.chunks.filter(chunk => chunk.kind === 'chat')).toHaveLength(1);

    // A new conversation, then the session file: its conversation is shown.
    await page.locator('#agent-chat-new').click();
    await expect(page.locator('#agent-chat-log .agent-chat-empty')).toBeVisible();
    const chooserPromise = page.waitForEvent('filechooser');
    await clickLoadSession(page);
    await (await chooserPromise).setFiles(sessionPath);
    await expect(page.locator('#agent-chat-log .agent-msg-user .agent-msg-text')).toHaveText('Color by score please');
    await expect(page.locator('#agent-chat-log .agent-tool[data-tool="color_by"]')).toHaveAttribute('data-state', 'step');
    await expect(page.locator('#agent-chat-log .agent-turn-foot .agent-turn-undo')).toHaveText('Undo turn');
    expect(errors).toEqual([]);
  });

  // One opening, the chat never opened. The cards of the first step leave the state untouched, so
  // the second reads its fingerprint from there.
  test('an agent from outside the chat: its card answered by Allow, Deny and giving up, then its activity line, Undo turn and the person acting next', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openDataset(page);

    await test.step("an agent's action that asks first shows a card: Allow, Deny and giving up each answer the agent", async () => {
      // A dispatcher of the page's own modules, with an action that writes a file, asking through the page's presence.
      await page.evaluate(async () => {
        const { createActionCatalog, defineAction } = await import('/assets/js/app/actions/catalog.js');
        const { createActionDispatcher } = await import('/assets/js/app/actions/dispatcher.js');
        const catalog = createActionCatalog([defineAction({
          type: 'demo.write', title: 'Write a report file', summary: 'Writes a file.', group: 'Demo',
          params: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } } },
          touches: ['layout'], reads: [], effect: 'state', confirm: 'writes-file', describe: p => `Wrote ${p.name}`, code: () => 'x',
        })]);
        const dispatcher = createActionDispatcher({ catalog });
        dispatcher.provide('demo.write', () => ({ written: true }));
        dispatcher.setConfirmer(window._cellucidUi.agents.presence.confirm);
        window.__demo = { dispatcher, outcomes: [] };
        window.__ask = signal => dispatcher.dispatch('demo.write', { name: 'cells.csv' }, { origin: 'agent', agent: 'ChatGPT', turn: 'turn-demo', signal })
          .then(({ outcome }) => window.__demo.outcomes.push({ ok: outcome.written }), error => window.__demo.outcomes.push({ refused: error.message, code: error instanceof DOMException ? error.name : error.code }));
      });
      const card = page.locator('#agent-presence .agent-confirm');

      await page.evaluate(() => { window.__ask(null); });
      await expect(card).toHaveCount(1);
      await expect(card.locator('.agent-confirm-title')).toHaveText(/^ChatGPT asks to write a report file(: [^“”]+)?\.$/);
      await expect(card.locator('.agent-confirm-why')).toHaveText('It writes a file to this computer, which the history cannot take back.');
      await card.locator('.disclosure-header').click();
      await expect(card.locator('dl')).toContainText('cells.csv');
      await card.locator('.agent-confirm-deny').click();
      await expect(card).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => window.__demo.outcomes)).toEqual([{ refused: 'The person declined, so this was not done: Write a report file (Wrote cells.csv).', code: 'declined' }]);

      await page.evaluate(() => { window.__ask(null); });
      // An agent outside the chat: the card offers this connection, not this chat.
      await expect(card.locator('.agent-confirm-allow')).toHaveText('Once');
      await expect(card.locator('.agent-confirm-allow-here')).toHaveText('This connection');
      await expect(card.locator('.agent-confirm-allow-always')).toHaveText('Always');
      await card.locator('.agent-confirm-allow').click();
      await expect.poll(() => page.evaluate(() => window.__demo.outcomes.length)).toBe(2);
      expect((await page.evaluate(() => window.__demo.outcomes))[1]).toEqual({ ok: true });

      // The agent gives up waiting (its call stopped): the card goes, and the agent hears why.
      await page.evaluate(() => {
        window.__giveUp = new AbortController();
        window.__ask(window.__giveUp.signal);
      });
      await expect(card).toHaveCount(1);
      await page.evaluate(() => window.__giveUp.abort(new DOMException('The agent stopped waiting', 'AbortError')));
      await expect(card).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => window.__demo.outcomes.length)).toBe(3);
      expect((await page.evaluate(() => window.__demo.outcomes))[2]).toEqual({ refused: 'The agent stopped waiting', code: 'AbortError' });
      await expect(page.locator('#agent-presence')).toBeHidden();
      expect(errors).toEqual([]);
    });

    await test.step('the activity line follows an agent acting from outside the chat: its steps, Undo turn, and the person acting next', async () => {
      const before = await fingerprint(page);
      await page.evaluate(async field => {
        const { getActions } = await import('/assets/js/app/actions/index.js');
        await getActions().dispatch('color.by', { field }, { origin: 'agent', agent: 'ChatGPT', turn: 'turn-connector' });
      }, SCORE);
      const line = page.locator('#agent-presence .agent-activity[data-agent="ChatGPT"]');
      await expect(line).toHaveAttribute('data-state', 'done');
      await expect(line.locator('.agent-activity-text')).toHaveText('ChatGPT · 1 step · Colored by score');
      await expect(line.locator('.agent-activity-stop')).toBeHidden();
      await line.locator('.agent-activity-undo').click();
      await expect(line).toHaveAttribute('data-state', 'undone');
      await expect(line.locator('.agent-activity-text')).toHaveText('ChatGPT\'s turn is undone');
      expect(await fingerprint(page)).toEqual(before);
      await line.locator('.agent-activity-dismiss').click();
      // The notice of what agents send (once per dataset, since an agent acted here) stays until answered.
      await expect(page.locator('#agent-presence .agent-notice')).toHaveCount(1);
      await page.locator('#agent-presence .agent-notice-done').click();
      await expect(page.locator('#agent-presence')).toBeHidden();

      // Another turn, then the person acts: the finished turn's line steps aside.
      await page.evaluate(async field => {
        const { getActions } = await import('/assets/js/app/actions/index.js');
        await getActions().dispatch('color.by', { field }, { origin: 'agent', agent: 'ChatGPT', turn: 'turn-connector-2' });
        await getActions().dispatch('color.by', { field: null });
      }, SCORE);
      await expect(page.locator('#agent-presence')).toBeHidden();
      expect(errors).toEqual([]);
    });
  });

  test('the chat bar failing to start takes only the chat bar away: the presence and an agent from outside the chat still work', async ({ page }) => {
    const errors = observeProductErrors(page);
    // The chat's markup drifted: its message field never reaches the page.
    await page.addInitScript(() => {
      new MutationObserver((records, observer) => {
        const input = document.getElementById('agent-chat-input');
        if (input === null) return;
        input.remove();
        observer.disconnect();
      }).observe(document, { childList: true, subtree: true });
    });
    await openDataset(page);
    await expect(page.locator('#agent-chat-toggle')).toBeHidden();
    await expect(page.locator('.notification', { hasText: 'The chat bar could not start, so it is hidden; agents connected through the Agents panel still work.' })).toBeVisible();
    const before = await fingerprint(page);
    await page.evaluate(async field => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      await getActions().dispatch('color.by', { field }, { origin: 'agent', agent: 'ChatGPT', turn: 'turn-outside', connection: { id: 'g1', kind: 'connector', client: 'ChatGPT', host: 'chatgpt.com', known: true } });
    }, SCORE);
    const line = page.locator('#agent-presence .agent-activity[data-agent="ChatGPT"]');
    await expect(line).toHaveAttribute('data-state', 'done');
    await line.locator('.agent-activity-undo').click();
    await expect(line).toHaveAttribute('data-state', 'undone');
    expect(await fingerprint(page)).toEqual(before);
    expect(errors.filter(error => !error.includes('[agents] the chat bar could not start'))).toEqual([]);
    // Said once in the console (how an engine prints the error object after it differs).
    expect(errors.filter(error => error.includes('[agents] the chat bar could not start'))).toHaveLength(1);
  });

  test('an API key is kept for the tab only until Remember is ticked, a refused key is said, and Forget removes it', async ({ page }) => {
    const errors = observeProductErrors(page);
    const seen = [];
    await page.route('https://api.anthropic.com/**', route => {
      seen.push({ url: route.request().url(), key: route.request().headers()['x-api-key'], direct: route.request().headers()['anthropic-dangerous-direct-browser-access'] });
      return route.fulfill({
        status: 401, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
      });
    });
    await openDataset(page);
    await page.locator('#agent-chat-toggle').click();
    await expect(page.locator('#agent-chat-provider')).toHaveValue('anthropic');
    await expect(page.locator('#agent-chat-status')).toHaveText('Add an API key to start.');
    const key = 'sk-ant-spec-not-a-real-key';
    await page.locator('#agent-chat-key').fill(key);
    await page.locator('#agent-chat-key').press('Enter');
    await expect(page.locator('#agent-chat-settings-status')).toHaveText('Anthropic did not accept this API key. Check it in the chat settings.');
    expect(seen[0]).toEqual({ url: 'https://api.anthropic.com/v1/models?limit=1000', key, direct: 'true' });
    // The key is not in the page: the field is emptied, its placeholder says one is kept.
    await expect(page.locator('#agent-chat-key')).toHaveValue('');
    await expect(page.locator('#agent-chat-key')).toHaveAttribute('placeholder', 'Kept · type a new key to replace it');
    const stores = () => page.evaluate(() => ({
      tab: sessionStorage.getItem('cellucid:agent-key:anthropic'),
      browser: localStorage.getItem('cellucid:agent-key:anthropic'),
      everywhere: JSON.stringify({ ...localStorage }).includes('sk-ant-spec'),
    }));
    expect(await stores()).toEqual({ tab: key, browser: null, everywhere: false });
    await page.locator('#agent-chat-remember').check();
    await expect.poll(() => stores()).toEqual({ tab: key, browser: key, everywhere: true });
    await page.locator('#agent-chat-remember').uncheck();
    await expect.poll(() => stores()).toEqual({ tab: key, browser: null, everywhere: false });
    await page.locator('#agent-chat-forget').click();
    await expect.poll(() => stores()).toEqual({ tab: null, browser: null, everywhere: false });
    await expect(page.locator('#agent-chat-settings-status')).toHaveText('Claude needs your Anthropic API key; it stays in this browser.');
    // The refused key was said, not thrown: nothing reached the console as an error but the browser's own 401 line.
    expect(errors.filter(error => !/401/.test(error))).toEqual([]);
  });

  test('Enter takes the message at once while the model list is on its way, and Stop stops the turn there', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openDataset(page);
    let releaseModels = () => {};
    const held = new Promise(resolve => { releaseModels = resolve; });
    const seen = [];
    await page.route('https://api.anthropic.com/**', async route => {
      seen.push(new URL(route.request().url()).pathname);
      await held;
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ data: [], has_more: false }) });
    });
    await page.locator('#agent-chat-toggle').click();
    await expect(page.locator('#agent-chat-settings')).toBeVisible();
    await page.locator('#agent-chat-provider').selectOption('anthropic');
    await page.locator('#agent-chat-key').fill('sk-ant-held');
    await page.locator('#agent-chat-key').press('Enter');
    await expect.poll(() => seen).toEqual(['/v1/models']);
    const input = page.locator('#agent-chat-input');
    await input.fill('Hello');
    await input.press('Enter');
    // Taken as Enter is pressed, not when the list comes (which may be a slow round trip).
    await expect(input).toHaveValue('');
    await expect(page.locator('#agent-chat-log .agent-msg-user')).toContainText('Hello');
    await expect(page.locator('#agent-chat-stop')).toBeVisible();
    await page.locator('#agent-chat-stop').click();
    releaseModels();
    await waitForTurnEnd(page);
    expect(seen.filter(path => path === '/v1/messages'), 'no model call after Stop').toEqual([]);
    expect(errors).toEqual([]);
  });

  test('on a phone the chat fits the screen above the panel bar', async ({ page }) => {
    const errors = observeProductErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openDataset(page);
    await expect(page.locator('#phone-sheet-bar')).toBeVisible();
    const toggle = page.locator('#agent-chat-toggle');
    await expect(toggle).toBeVisible();
    const bar = await page.locator('#phone-sheet-bar').boundingBox();
    const toggleBox = await toggle.boundingBox();
    expect(toggleBox.y + toggleBox.height).toBeLessThanOrEqual(bar.y);
    await openChat(page);
    await queueReplies(page, [{ text: '| Cluster | Label | Markers |\n|---|---|---|\n| 0 | T cells | CD3E, CD3D, IL7R |\n| 1 | B cells | MS4A1, CD79A |' }]);
    await say(page, 'Annotate the clusters');
    const panel = await page.locator('#agent-chat-panel').boundingBox();
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(390);
    expect(panel.y).toBeGreaterThanOrEqual(0);
    expect(panel.y + panel.height).toBeLessThanOrEqual(bar.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect(page.locator('#agent-chat-log table')).toBeVisible();

    // A result table as a model writes one: a long first column
    // and five of numbers. Every word of every cell stays on one line (no
    // word breaks inside it), and the table fits the log.
    await queueReplies(page, [{ text: '| Share of epithelium (mean of 4 donors) | Early | Mid | Late | Adjusted p |\n|---|---|---|---|---|\n| Ciliated cells | 0.04% | 40% | **66%** | 5×10⁻⁴ |\n| Airway progenitors | **38%** | 3.3% | 1.9% | 0.001 |' }]);
    await say(page, 'Which epithelial types change with age?');
    await expect(page.locator('#agent-chat-log table')).toHaveCount(2);
    const split = await page.locator('#agent-chat-log table').last().evaluate(table => {
      const broken = [];
      for (const cell of table.querySelectorAll('th, td')) {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          for (const match of node.data.matchAll(/\S+/g)) {
            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            const lines = new Set([...range.getClientRects()].map(rect => Math.round(rect.top)));
            if (lines.size > 1) broken.push(match[0]);
          }
        }
      }
      return { broken, fits: table.getBoundingClientRect().right <= table.closest('#agent-chat-log').getBoundingClientRect().right + 0.5 };
    });
    expect(split).toEqual({ broken: [], fits: true });
    expect(errors).toEqual([]);
  });
});
