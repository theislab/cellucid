/**
 * Agents, either way in or both: the acceptance matrix of "bring your own
 * key and/or the connector; it just works, regardless".
 *
 * 1. **BYOK alone** (the chat bar with the person's key, no connector ever
 *    set up), against Anthropic's API played by the spec
 *    (`helpers/agent-chat.mjs` `playAnthropic`, with the headers a browser
 *    needs): the direct-browser header on every request; a key kept for the
 *    tab across a reload but not in a new tab; a remembered key in a new
 *    tab; offline, then back online, the turn goes through. And on every
 *    kind of dataset (a sample, a link, a local file, a notebook-served
 *    dataset), with the scripted model. The real providers, in each engine,
 *    are `live-agents/byok.spec.mjs`.
 * 2. **Connector alone** (Claude or ChatGPT through a relay played by the
 *    spec, `helpers/relay-play.mjs`; the chat bar never opened, no key): the
 *    presence's activity line and Undo turn, its card ("This connection"),
 *    Deny, the permissions in the Agents panel and the tool list that says
 *    them.
 * 3. **Both at once** in one tab: the dispatcher orders their changes; each
 *    its own turn and agent in the history; the activity line shows both;
 *    Undo turn takes back only that agent's turn; both asks queue, each card
 *    names who asks; "This chat" and "This connection" stay apart; Stop
 *    stops only the chat. And both named Claude (the chat's and Claude
 *    Desktop through the connector): two lines, two cards, each named with
 *    its way in, Undo turn of one only.
 * 4. **One failing leaves the other working**: a refused key, a provider
 *    down, the relay down, a tab never paired; each says in one line what
 *    to do.
 */
import { goOffline } from './helpers/offline.mjs';
import { fileURLToPath } from 'node:url';

import { closeContextWithApplicationRetirement, closePageWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { APP_ORIGIN, ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { H5AD_PATH, START, expectSettledOn, startUrl } from './helpers/dataset-loading.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { waitForHistory } from './helpers/state-history.mjs';
import { chooseFiles } from './helpers/file-input.mjs';
import { serveAnnDataServer } from './helpers/anndata-server.mjs';
import {
  agentRequests, fingerprint, firstCategoricalField, installScriptedModel, observeProductErrors, openChat, playAnthropic,
  queueReplies, releaseHold, say, stepFacts, useAnthropicKey, waitForHold, waitForTurnEnd,
} from './helpers/agent-chat.mjs';
import { pairTab, playRelay, received, startTool, toolList } from './helpers/relay-play.mjs';

const CHATGPT = Object.freeze({ agent: 'ChatGPT', grant: 'g1', client: 'ChatGPT', host: 'chatgpt.com' });
const CLAUDE_DESKTOP = Object.freeze({ agent: 'Claude', grant: 'g1', client: 'Claude Desktop', host: 'claude.ai' });
const card = page => page.locator('#agent-presence .agent-confirm');
const line = (page, agent) => page.locator(`#agent-presence .agent-activity[data-agent="${agent}"]`);

const colourBy = key => ({ field: { source: 'obs', key } });

/** The steps on the path to the step shown, oldest first: type, agent, turn. */
function pathFacts(page) {
  return page.evaluate(() => {
    const tree = window._cellucidHistories.current().active;
    const out = [];
    for (let step = tree.steps.get(tree.headId); step && step.type !== null; step = tree.steps.get(step.parent)) {
      out.unshift({ type: step.type, agent: step.by.agent, turn: step.by.turn });
    }
    return out;
  });
}

/** Colouring estimated, by the page's own measure, to take 30 s here: heavy work, which asks first. */
async function makeColouringHeavy(page) {
  await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    getActions().provideEstimate('color.by', () => ({ ms: 30_000, bytes: null, what: 'colouring every cell' }));
  });
}

async function openStart(page) {
  await page.goto(startUrl(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expectSettledOn(page, START);
  await waitForHistory(page);
}

async function keysKept(page) {
  return page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter(key => key.startsWith('cellucid:agent-key')));
}

// ------------------------------------------------------------ 1. BYOK alone

test('BYOK alone: the direct-browser header; a tab key across a reload, not in a new tab; a remembered key in a new tab; offline, then back', async ({ page, context }) => {
  const errors = observeProductErrors(page);
  const api = await playAnthropic(context);
  const KEY = 'sk-ant-played-key';
  await openStart(page);
  await expect(page.locator('#agent-connect-status')).toHaveText('Not connected yet');
  const field = await firstCategoricalField(page);
  await page.locator('#agent-chat-toggle').click();
  await useAnthropicKey(page, KEY);
  api.replies.push({ text: 'Colouring.', calls: [{ name: 'color_by', args: colourBy(field) }] }, { text: 'Coloured.' });
  await say(page, 'Colour by the first field');
  expect((await stepFacts(page)).map(step => [step.type, step.agent])).toEqual([['color.by', 'Claude']]);
  // Every request went to Anthropic from this tab, with the key and the direct-browser header.
  expect(api.requests.length).toBeGreaterThanOrEqual(3);
  expect(api.requests.every(request => request.key === KEY && request.direct === 'true')).toBe(true);
  expect(await keysKept(page)).toEqual(['cellucid:agent-key:anthropic']);
  expect(await page.evaluate(() => localStorage.getItem('cellucid:agent-key:anthropic'))).toBeNull();

  // A reload of the tab: the key kept for the tab is still there; the chat goes on.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await waitForHistory(page);
  if (await page.locator('#agent-chat-panel').isHidden()) await page.locator('#agent-chat-toggle').click();
  await expect(page.locator('#agent-chat-status')).toHaveText('Claude (played)');
  api.replies.push({ text: 'Still here.' });
  await say(page, 'Are you there?');
  await expect(page.locator('#agent-chat-log .agent-msg-agent').last()).toContainText('Still here.');

  // A new tab: a key kept for a tab is not there; Remember keeps it for the next.
  const second = await context.newPage();
  const errorsSecond = observeProductErrors(second);
  await openStart(second);
  if (await second.locator('#agent-chat-panel').isHidden()) await second.locator('#agent-chat-toggle').click();
  await expect(second.locator('#agent-chat-status')).toHaveText('Add an API key to start.');
  await useAnthropicKey(second, KEY, { remember: true });
  expect(await second.evaluate(() => localStorage.getItem('cellucid:agent-key:anthropic'))).toBe(KEY);
  const third = await context.newPage();
  const errorsThird = observeProductErrors(third);
  await openStart(third);
  if (await third.locator('#agent-chat-panel').isHidden()) await third.locator('#agent-chat-toggle').click();
  await expect(third.locator('#agent-chat-status')).toHaveText('Claude (played)');

  // Offline: the turn waits and says so; back online, it goes through at once.
  await goOffline(context);
  api.offline = true;
  await expect(third.locator('#agent-chat-status')).toHaveText('This browser is offline; a message waits until it is back.');
  api.replies.push({ text: 'Back online.' });
  await third.locator('#agent-chat-input').fill('Hello again');
  await third.locator('#agent-chat-input').press('Enter');
  await expect(third.locator('#agent-chat-log .agent-chat-working')).toHaveAttribute('data-phase', 'waiting');
  api.offline = false;
  await context.setOffline(false);
  await waitForTurnEnd(third);
  await expect(third.locator('#agent-chat-log .agent-msg-agent').last()).toContainText('Back online.');
  await closePageWithApplicationRetirement(second);
  await closePageWithApplicationRetirement(third);
  // Offline, each engine logs the requests that got no answer in its own words (Firefox: "CORS request did not succeed").
  const offlineWords = /ERR_INTERNET_DISCONNECTED|internet|network|Failed to load resource|CORS request did not succeed/i;
  expect([...errors, ...errorsSecond, ...errorsThird].filter(error => !offlineWords.test(error))).toEqual([]);
});

const DATASET_KINDS = Object.freeze([
  {
    kind: 'a sample',
    async open(page) { await openStart(page); },
  },
  {
    kind: 'a link',
    async open(page) {
      const link = `${SAMPLE_ORIGIN}/tests/browser/fixtures/current-ui-smoke.h5ad`;
      await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(link)}`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
      await waitForHistory(page);
    },
  },
  {
    kind: 'a local file',
    async open(page) {
      await openStart(page);
      await chooseFiles(page.locator('#user-data-file-input'), H5AD_PATH);
      await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
      await waitForHistory(page);
    },
  },
  {
    kind: 'a notebook-served dataset',
    async open(page) {
      const file = new URL('./fixtures/catalog/current-ui.h5ad', import.meta.url);
      await serveAnnDataServer(page, APP_ORIGIN, { id: 'current-ui', name: 'Current UI fixture', file: fileURLToPath(file), cells: 120, genes: 6 }, { viewerHost: true });
      const url = new URL('/', APP_ORIGIN);
      url.searchParams.set('viewer', 'true');
      url.searchParams.set('viewerId', 'viewer-1');
      url.searchParams.set('viewerToken', 'token-1');
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
      await waitForHistory(page);
    },
  },
]);

for (const { kind, open } of DATASET_KINDS) {
  test(`the chat bar works on ${kind}: a turn's change is a step of its agent, and Undo turn takes it back`, async ({ page }) => {
    const errors = observeProductErrors(page);
    await page.addInitScript(installScriptedModel);
    await open(page);
    const field = await firstCategoricalField(page);
    const before = await fingerprint(page);
    await openChat(page);
    await queueReplies(page, [{ calls: [{ name: 'fields_list', args: {} }, { name: 'color_by', args: colourBy(field) }] }, { text: 'Coloured.' }]);
    await say(page, 'Colour by the first field');
    expect((await stepFacts(page)).map(step => [step.type, step.agent])).toEqual([['color.by', 'Claude']]);
    await page.locator('#agent-chat-log .agent-turn-foot .agent-turn-undo').click();
    await expect(page.locator('#agent-chat-log .agent-turn-foot .agent-turn-undo')).toHaveText('Undone');
    expect(await fingerprint(page)).toEqual(before);
    expect(errors).toEqual([]);
  });
}

// --------------------------------------------------------- 2. Connector alone

test('connector alone: with no chat bar opened and no key, the presence follows, asks, refuses and undoes for it', async ({ page }) => {
  const errors = observeProductErrors(page);
  const relay = await playRelay(page);
  await pairTab(page);
  await openStart(page);
  await expect(page.locator('#agent-connect-status')).toHaveText('Ready · no agent yet');
  const field = await firstCategoricalField(page);
  const before = await fingerprint(page);

  // A change: allowed by default, a step of the agent's turn; its line has Undo turn.
  const coloured = await startTool(relay, 'color_by', colourBy(field), CHATGPT).result();
  expect(coloured.result.isError).toBe(false);
  await expect(line(page, 'ChatGPT')).toHaveAttribute('data-state', 'done');
  await expect(line(page, 'ChatGPT').locator('.agent-activity-text')).toHaveText(/^ChatGPT \(chatgpt\.com\) · 1 step · /);
  await line(page, 'ChatGPT').locator('.agent-activity-undo').click();
  await expect(line(page, 'ChatGPT')).toHaveAttribute('data-state', 'undone');
  expect(await fingerprint(page)).toEqual(before);
  await line(page, 'ChatGPT').locator('.agent-activity-dismiss').click();

  // Heavy work asks on a card, and the relay tells the agent it waits; This connection holds for that connection only.
  await makeColouringHeavy(page);
  const heavy = startTool(relay, 'color_by', colourBy(field), CHATGPT);
  await expect(card(page)).toHaveAttribute('data-asking', 'heavy');
  await expect(card(page)).toHaveAttribute('data-agent', 'ChatGPT');
  await expect(card(page).locator('.agent-confirm-why')).toHaveText('It is heavy work: Colouring every cell, about 30.0 s on this device.');
  await received(relay, 'asking', message => message.id === heavy.id);
  await card(page).locator('.agent-confirm-allow-here').click();
  expect((await heavy.result()).result.isError).toBe(false);
  await received(relay, 'answered', message => message.id === heavy.id && message.allowed === true);
  expect((await startTool(relay, 'color_by', { field: null }, CHATGPT).result()).result.isError).toBe(false);
  await expect(card(page)).toHaveCount(0);
  const other = startTool(relay, 'color_by', colourBy(field), { agent: 'Claude', grant: 'g2', client: 'Claude', host: 'claude.ai' });
  await expect(card(page)).toHaveAttribute('data-agent', 'Claude');
  await card(page).locator('.agent-confirm-deny').click();
  const denied = (await other.result()).result;
  expect(denied.isError).toBe(true);
  expect(denied.content[0].text).toMatch(/The person declined/);

  // Read only, set in the Agents panel: a change is refused with its sentence and its tool says so; reads still run.
  await page.evaluate(() => { document.getElementById('agents-section').open = true; });
  await page.locator('#agent-connect-permissions-change').click();
  await page.locator('#agent-permissions-dialog input[name="agent-permission-mode"][value="read-only"]').check();
  await page.locator('#agent-permissions-dialog .app-dialog-close').click();
  await expect(page.locator('#agent-connect-permissions-summary')).toHaveText('Read only');
  const tools = await toolList(relay, 'g1');
  expect(tools.find(tool => tool.name === 'color_by').description).toMatch(/The person's settings refuse this for you/);
  const refused = (await startTool(relay, 'color_by', colourBy(field), CHATGPT).result()).result;
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toMatch(/do not let agents change anything in this tab/);
  expect((await startTool(relay, 'fields_list', {}, CHATGPT).result()).result.isError).toBe(false);

  // Nothing of it needed the chat bar or a key.
  await expect(page.locator('#agent-chat-panel')).toBeHidden();
  expect(await keysKept(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('connector: while a card waits, its turn\'s line shows Stop; Stop withdraws the card and answers the agent it was stopped', async ({ page }) => {
  const errors = observeProductErrors(page);
  const relay = await playRelay(page);
  await pairTab(page);
  await openStart(page);
  const field = await firstCategoricalField(page);
  await makeColouringHeavy(page);
  const before = await fingerprint(page);
  const heavy = startTool(relay, 'color_by', colourBy(field), CHATGPT);
  await expect(card(page)).toHaveAttribute('data-agent', 'ChatGPT');
  // The action has not started (the person is asked first), yet its turn acts and can be stopped.
  await expect(line(page, 'ChatGPT')).toHaveAttribute('data-state', 'acting');
  await expect(line(page, 'ChatGPT').locator('.agent-activity-stop')).toBeVisible();
  await line(page, 'ChatGPT').locator('.agent-activity-stop').click();
  await expect(card(page)).toHaveCount(0);
  const stopped = (await heavy.result()).result;
  expect(stopped.isError).toBe(true);
  expect(stopped.content[0].text).toBe('Stopped before it finished: The person stopped ChatGPT (chatgpt.com).');
  await expect(line(page, 'ChatGPT')).toHaveAttribute('data-state', 'stopped');
  await expect(line(page, 'ChatGPT').locator('.agent-activity-stop')).toBeHidden();
  expect(await fingerprint(page)).toEqual(before);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------- 3. Both at once

test('both at once: ordered changes, each agent its own turn and line, Undo turn of one only, both asks queued and apart, Stop of the chat only', async ({ page }) => {
  const errors = observeProductErrors(page);
  await page.addInitScript(installScriptedModel);
  const relay = await playRelay(page);
  await pairTab(page);
  await openStart(page);
  await expect(page.locator('#agent-connect-status')).toHaveText('Ready · no agent yet');
  const field = await firstCategoricalField(page);
  await openChat(page);

  // The chat's turn is answering (held before its call) while ChatGPT acts through the connector;
  // both changes are steps, each of its agent and turn.
  await queueReplies(page, [{ text: 'Colouring the cells now. '.repeat(4), chunks: 4, hold: 'both', calls: [{ name: 'color_by', args: colourBy(field) }] }, { text: 'Coloured.' }]);
  await page.locator('#agent-chat-input').fill('Colour by the first field');
  await page.locator('#agent-chat-input').press('Enter');
  await waitForHold(page, 'both');
  const page1 = await startTool(relay, 'highlight_page_create', {}, CHATGPT).result();
  expect(page1.result.isError).toBe(false);
  await releaseHold(page, 'both');
  await waitForTurnEnd(page);
  const chatTurn = await page.locator('#agent-chat-log .agent-msg-user').last().getAttribute('data-turn');
  const steps = await pathFacts(page);
  expect(steps.map(step => [step.type, step.agent])).toEqual([['highlight.page.create', 'ChatGPT'], ['color.by', 'Claude']]);
  expect(steps[1].turn).toBe(chatTurn);
  expect(steps[0].turn).not.toBe(chatTurn);
  // The chat shows its own calls only.
  await expect(page.locator('#agent-chat-log .agent-tool')).toHaveCount(1);
  await expect(page.locator('#agent-chat-log .agent-tool[data-tool="color_by"]')).toHaveAttribute('data-state', 'step');

  // Collapsed, the activity line shows both; Undo turn of ChatGPT's asks (Claude acted after it
  // began) and takes back its step only, Claude's applied again.
  await page.locator('#agent-chat-collapse').click();
  await expect(line(page, 'ChatGPT')).toHaveAttribute('data-state', 'done');
  await expect(line(page, 'Claude')).toHaveAttribute('data-state', 'done');
  await line(page, 'ChatGPT').locator('.agent-activity-undo').click();
  const choice = page.locator('.confirm-dialog');
  await expect(choice.locator('.confirm-dialog-message')).toContainText("1 change came after ChatGPT's turn began (1 of Claude's).");
  await expect(choice.locator('.confirm-dialog-alternative')).toHaveText('All 2 steps since');
  await choice.locator('.confirm-dialog-confirm', { hasText: "Only ChatGPT's 1 step" }).click();
  await expect(line(page, 'ChatGPT')).toHaveAttribute('data-state', 'undone');
  expect((await pathFacts(page)).map(step => [step.type, step.agent, step.turn])).toEqual([['color.by', 'Claude', chatTurn]]);
  await line(page, 'ChatGPT').locator('.agent-activity-dismiss').click();
  await page.locator('#agent-chat-toggle').click();

  // Both ask at once: two cards, each naming who asks and where the grant would hold.
  await makeColouringHeavy(page);
  await queueReplies(page, [{ calls: [{ name: 'color_by', args: { field: null } }] }, { text: 'Done.' }]);
  await page.locator('#agent-chat-input').fill('Take the colour away');
  await page.locator('#agent-chat-input').press('Enter');
  const fromConnector = startTool(relay, 'color_by', colourBy(field), CHATGPT);
  await expect(card(page)).toHaveCount(2);
  const chatCard = card(page).and(page.locator('[data-agent="Claude"]'));
  const connectorCard = card(page).and(page.locator('[data-agent="ChatGPT"]'));
  await expect(chatCard.locator('.agent-confirm-allow-here')).toHaveText('This chat');
  await expect(connectorCard.locator('.agent-confirm-allow-here')).toHaveText('This connection');
  await expect(page.locator('#agent-chat-status')).toHaveText('Waiting for your answer above…');
  await chatCard.locator('.agent-confirm-allow-here').click();
  await waitForTurnEnd(page);
  await expect(card(page)).toHaveCount(1);
  await connectorCard.locator('.agent-confirm-allow').click();
  expect((await fromConnector.result()).result.isError).toBe(false);
  // "This chat" holds for the chat only: the connector is asked again, the chat is not.
  const again = startTool(relay, 'color_by', colourBy(field), CHATGPT);
  await expect(connectorCard).toHaveCount(1);
  await queueReplies(page, [{ calls: [{ name: 'color_by', args: { field: null } }] }, { text: 'Done.' }]);
  await say(page, 'Take the colour away again');
  expect((await pathFacts(page)).at(-1)).toMatchObject({ type: 'color.by', agent: 'Claude' });
  await expect(card(page)).toHaveCount(1);

  // Stop stops only the chat: the connector's question stays, and is answered after.
  await queueReplies(page, [{ text: 'Thinking it over at length. '.repeat(10), chunks: 5, hold: 'long' }]);
  await page.locator('#agent-chat-input').fill('Take your time');
  await page.locator('#agent-chat-input').press('Enter');
  await waitForHold(page, 'long');
  await expect(page.locator('#agent-chat-log [data-streaming="true"]')).toContainText('Thinking it over');
  await page.locator('#agent-chat-stop').click();
  await waitForTurnEnd(page);
  await expect(page.locator('#agent-chat-log .agent-msg-note[data-kind="stopped"] p')).toHaveText('Stopped.');
  await expect(connectorCard).toHaveCount(1);
  await connectorCard.locator('.agent-confirm-allow').click();
  expect((await again.result()).result.isError).toBe(false);
  expect((await pathFacts(page)).at(-1)).toMatchObject({ type: 'color.by', agent: 'ChatGPT' });
  expect(errors).toEqual([]);
});

test('both named Claude: the chat\'s and Claude Desktop\'s turns are two lines and two cards, each named with its way in; Undo turn of one only', async ({ page }) => {
  const errors = observeProductErrors(page);
  await page.addInitScript(installScriptedModel);
  const relay = await playRelay(page);
  await pairTab(page);
  await openStart(page);
  const field = await firstCategoricalField(page);
  await openChat(page);

  // A turn of each, one after the other: each a step of Claude, of its own turn.
  await queueReplies(page, [{ calls: [{ name: 'color_by', args: colourBy(field) }] }, { text: 'Coloured.' }]);
  await say(page, 'Colour by the first field');
  const created = await startTool(relay, 'highlight_page_create', {}, CLAUDE_DESKTOP).result();
  expect(created.result.isError).toBe(false);
  const steps = await pathFacts(page);
  expect(steps.map(step => [step.type, step.agent])).toEqual([['color.by', 'Claude'], ['highlight.page.create', 'Claude']]);
  expect(steps[0].turn).not.toBe(steps[1].turn);

  // Collapsed, the line shows both turns, the later one not replacing the other: each names its way in.
  await page.locator('#agent-chat-collapse').click();
  const chatLine = line(page, 'Claude').and(page.locator('[data-connection="chat"]'));
  const desktopLine = line(page, 'Claude').and(page.locator('[data-connection="connector"]'));
  await expect(line(page, 'Claude')).toHaveCount(2);
  await expect(chatLine.locator('.agent-activity-text')).toHaveText(/^Claude \(chat\) · 1 step · /);
  await expect(desktopLine.locator('.agent-activity-text')).toHaveText(/^Claude \(Claude Desktop\) · 1 step · /);
  // Undo turn of Claude Desktop's (the last step): its step only, the chat's stays.
  await desktopLine.locator('.agent-activity-undo').click();
  await expect(desktopLine).toHaveAttribute('data-state', 'undone');
  await expect(desktopLine.locator('.agent-activity-text')).toHaveText("Claude (Claude Desktop)'s turn is undone");
  await expect(chatLine).toHaveAttribute('data-state', 'done');
  expect((await pathFacts(page)).map(step => [step.type, step.turn])).toEqual([['color.by', steps[0].turn]]);
  await desktopLine.locator('.agent-activity-dismiss').click();
  await page.locator('#agent-chat-toggle').click();

  // Both ask at once: two cards of Claude, told apart by their way in, each answered on its own.
  await makeColouringHeavy(page);
  await queueReplies(page, [{ calls: [{ name: 'color_by', args: { field: null } }] }, { text: 'Done.' }]);
  await page.locator('#agent-chat-input').fill('Take the colour away');
  await page.locator('#agent-chat-input').press('Enter');
  const fromDesktop = startTool(relay, 'color_by', { field: null }, CLAUDE_DESKTOP);
  await expect(card(page)).toHaveCount(2);
  const chatCard = card(page).and(page.locator('[data-connection="chat"]'));
  const desktopCard = card(page).and(page.locator('[data-connection="connector"]'));
  await expect(chatCard).toHaveAttribute('data-agent', 'Claude');
  await expect(desktopCard).toHaveAttribute('data-agent', 'Claude');
  await expect(chatCard.locator('.agent-confirm-title')).toHaveText(/^Claude \(chat\) asks to colour the cells by a field or gene: “.+”\.$/);
  await expect(desktopCard.locator('.agent-confirm-title')).toHaveText(/^Claude \(Claude Desktop\) asks to colour the cells by a field or gene: “.+”\.$/);
  await expect(chatCard.locator('.agent-confirm-allow-here')).toHaveText('This chat');
  await expect(desktopCard.locator('.agent-confirm-allow-here')).toHaveText('This connection');
  await desktopCard.locator('.agent-confirm-deny').click();
  expect((await fromDesktop.result()).result.content[0].text).toMatch(/The person declined/);
  await expect(chatCard).toHaveCount(1);
  await chatCard.locator('.agent-confirm-allow').click();
  await waitForTurnEnd(page);
  expect((await pathFacts(page)).at(-1)).toMatchObject({ type: 'color.by', agent: 'Claude' });

  // Claude Desktop acts after the chat's turn: the chat's Undo turn asks; only its own step goes,
  // and its footer then says so, with nothing left to undo.
  expect((await startTool(relay, 'highlight_page_create', {}, CLAUDE_DESKTOP).result()).result.isError).toBe(false);
  const foot = page.locator('#agent-chat-log .agent-turn-foot').last();
  await foot.locator('.agent-turn-undo').click();
  const choice = page.locator('.confirm-dialog');
  await expect(choice.locator('.confirm-dialog-message')).toContainText("1 change came after Claude's turn began (1 from another Claude turn).");
  await choice.locator('.confirm-dialog-confirm').click();
  // Its own step went to Recently deleted, and the footer says so.
  await expect(foot.locator('.agent-turn-steps')).toHaveText('1 step in Recently deleted');
  await expect(foot.locator('.agent-turn-undo')).toBeHidden();
  await expect(foot.locator('.agent-turn-undo')).toBeDisabled();
  expect((await pathFacts(page)).at(-1)).toMatchObject({ type: 'highlight.page.create', agent: 'Claude' });
  expect(errors).toEqual([]);
});

// --------------------------------------------- 4. One failing, the other works

test('a refused key and a provider down leave the connector working; each says what to do', async ({ page }) => {
  const errors = observeProductErrors(page);
  await page.addInitScript(installScriptedModel);
  await playAnthropic(page, { refused: ['sk-ant-refused'] });
  const relay = await playRelay(page);
  await pairTab(page);
  await openStart(page);
  const field = await firstCategoricalField(page);
  await page.locator('#agent-chat-toggle').click();
  await page.locator('#agent-chat-key').fill('sk-ant-refused');
  await page.locator('#agent-chat-key').press('Enter');
  await expect(page.locator('#agent-chat-settings-status')).toHaveText('Anthropic did not accept this API key. Check it in the chat settings.');
  expect((await startTool(relay, 'color_by', colourBy(field), CHATGPT).result()).result.isError).toBe(false);

  // The scripted provider busy: the chat waits and says so; the connector acts meanwhile; Stop ends the wait.
  await page.locator('#agent-chat-provider').selectOption('scripted');
  await page.locator('#agent-chat-settings-btn').click();
  await queueReplies(page, [{ error: { kind: 'busy', message: 'The provider is busy; Cellucid tries again shortly.', retryAfterMs: 60_000 } }]);
  await page.locator('#agent-chat-input').fill('Hello');
  await page.locator('#agent-chat-input').press('Enter');
  await expect(page.locator('#agent-chat-log .agent-chat-working')).toHaveAttribute('data-phase', 'waiting');
  await expect(page.locator('#agent-chat-status')).toHaveText(/^The provider is busy; Cellucid tries again shortly\. Next try in /);
  const undone = await startTool(relay, 'history_undo', {}, CHATGPT).result();
  expect(undone.result.isError).toBe(false);
  await page.locator('#agent-chat-stop').click();
  await waitForTurnEnd(page);
  expect(await agentRequests(page)).toHaveLength(1);
  expect(errors.filter(error => !/401/.test(error))).toEqual([]);
});

test('the relay down, or a tab never paired, leaves the chat bar working; the Agents panel says so in one line', async ({ page, browser }) => {
  const errors = observeProductErrors(page);
  await page.addInitScript(installScriptedModel);
  await playRelay(page, { refuseFirst: Number.POSITIVE_INFINITY });
  await pairTab(page);
  await openStart(page);
  await expect(page.locator('#agent-connect-status')).toHaveText(/^Offline · retrying/);
  const field = await firstCategoricalField(page);
  await openChat(page);
  await queueReplies(page, [{ calls: [{ name: 'color_by', args: colourBy(field) }] }, { text: 'Coloured.' }]);
  await say(page, 'Colour by the first field');
  expect((await stepFacts(page)).map(step => [step.type, step.agent])).toEqual([['color.by', 'Claude']]);

  // Another browser, never paired: the Agents panel says so, the chat bar works.
  const fresh = await browser.newContext();
  const unpaired = await fresh.newPage();
  const errorsUnpaired = observeProductErrors(unpaired);
  await unpaired.addInitScript(installScriptedModel);
  await openStart(unpaired);
  await expect(unpaired.locator('#agent-connect-status')).toHaveText('Not connected yet');
  await openChat(unpaired);
  await queueReplies(unpaired, [{ calls: [{ name: 'color_by', args: colourBy(field) }] }, { text: 'Coloured.' }]);
  await say(unpaired, 'Colour by the first field');
  expect((await stepFacts(unpaired)).map(step => [step.type, step.agent])).toEqual([['color.by', 'Claude']]);
  await closeContextWithApplicationRetirement(fresh);
  expect(errors.filter(error => !/WebSocket/i.test(error))).toEqual([]);
  expect(errorsUnpaired).toEqual([]);
});
