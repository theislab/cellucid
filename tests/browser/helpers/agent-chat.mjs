/**
 * The chat bar on a real page with the scripted model
 * (`assets/js/app/agent/providers/scripted.js`), for the specs of the chat
 * and the agent presence: the model answers from a queue the spec fills
 * (`window.__agentReplies`) and records what it was sent
 * (`window.__agentRequests`: the messages, the number of tools, the effort).
 */
import { expect } from './test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './origins.mjs';
import { dismissWelcome } from './welcome.mjs';
import { waitForHistory } from './state-history.mjs';

/** A tool result's JSON value: its text between the data tags (`relay-protocol.js` `RESULT_DATA_TAGS`). */
export function resultJson(text) {
  const open = '<cellucid-data>';
  const close = '</cellucid-data>';
  if (!text.startsWith(open) || !text.includes(close)) throw new Error(`Not a result's data: ${text.slice(0, 80)}`);
  return JSON.parse(text.slice(open.length, text.indexOf(close)));
}

export const AGENT_DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=agent-chat-ci`;
export const CELL_TYPE = Object.freeze({ source: 'obs', key: 'cell_type' });
export const COLOR_BY_CELL_TYPE = Object.freeze({ name: 'color_by', args: { field: CELL_TYPE } });

/** Console errors and uncaught errors of the page, as lines. */
export function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

/** The scripted model, installed before the page's modules run (`page.addInitScript`). */
export function installScriptedModel() {
  window.__agentReplies = [];
  window.__agentRequests = [];
  window.__agentHolds = {};
  window.__CELLUCID_AGENT_SCRIPT__ = {
    agent: 'Claude',
    reply(messages, tools, options) {
      window.__agentRequests.push({ messages, tools: tools.length, toolsText: JSON.stringify(tools), effort: options?.effort ?? null });
      const next = window.__agentReplies.shift() ?? { text: 'Nothing more to do.' };
      // `hold: name`: the reply waits after its text, still answering, until the test lets it go (`releaseHold`).
      if (typeof next.hold !== 'string') return next;
      const name = next.hold;
      return { ...next, hold: new Promise(resolve => { window.__agentHolds[name] = resolve; }) };
    },
  };
}

/** Wait until the reply queued with `hold: name` has streamed its text and waits (the model still answering). */
export async function waitForHold(page, name) {
  await page.waitForFunction(held => typeof window.__agentHolds[held] === 'function', name);
}

/** Let the reply queued with `hold: name` go on. */
export async function releaseHold(page, name) {
  await page.evaluate(held => window.__agentHolds[held](), name);
}

export async function openAgentDataset(page) {
  await page.goto(AGENT_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await waitForHistory(page);
}

/** Open the chat and choose the scripted model (as a person picks a provider). */
export async function openChat(page) {
  await page.locator('#agent-chat-toggle').click();
  await expect(page.locator('#agent-chat-panel')).toBeVisible();
  // No key for the first provider yet: the settings open by themselves.
  await expect(page.locator('#agent-chat-settings')).toBeVisible();
  await page.locator('#agent-chat-provider').selectOption('scripted');
  await expect(page.locator('#agent-chat-settings-status')).toHaveText('Scripted model needs no key.');
  await page.locator('#agent-chat-settings-btn').click();
  await expect(page.locator('#agent-chat-settings')).toBeHidden();
  await expect(page.locator('#agent-chat-status')).toHaveText('Claude · Scripted');
}

export async function queueReplies(page, replies) {
  await page.evaluate(list => window.__agentReplies.push(...list), replies);
}

/** Send a message and wait for the turn to end. */
export async function say(page, text) {
  await page.locator('#agent-chat-input').fill(text);
  await page.locator('#agent-chat-input').press('Enter');
  // Taken in the same task as the turn begins: from here on, Stop says whether it runs.
  await expect(page.locator('#agent-chat-input')).toHaveValue('');
  await waitForTurnEnd(page);
}

export async function waitForTurnEnd(page) {
  await expect(page.locator('#agent-chat-stop')).toBeHidden();
  await expect(page.locator('#agent-chat-send')).toBeVisible();
}

/** What the scripted model was sent, oldest call first. */
export async function agentRequests(page) {
  return page.evaluate(() => window.__agentRequests);
}

export async function fingerprint(page) {
  return page.evaluate(async () => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint } = await import('/assets/js/app/state/domains/fingerprint.js');
    return stateFingerprint(getStateDomains());
  });
}

/** The steps of the tracker shown, oldest first, as plain facts. */
export async function stepFacts(page) {
  return page.evaluate(() => {
    const tree = window._cellucidHistories.current().active;
    return [...tree.steps.values()].filter(step => step.type !== null)
      .map(step => ({ id: step.id, type: step.type, origin: step.by.origin, agent: step.by.agent, turn: step.by.turn, label: step.label }));
  });
}

/** The key of the first categorical field of the dataset shown (what a scripted turn colours by). */
export async function firstCategoricalField(page) {
  return page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    const { outcome } = await getActions().dispatch('fields.list', { kind: 'categorical' });
    return outcome.fields[0].key;
  });
}

/** The model the played Anthropic API lists. */
export const PLAYED_MODEL = Object.freeze({ id: 'claude-played', label: 'Claude (played)' });

/** One reply of the played Anthropic API as its server-sent events (`{text, calls}`). */
function anthropicEventsOf({ text = '', calls = [] }) {
  const events = [{ event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 40, output_tokens: 1 } } } }];
  let index = 0;
  if (text !== '') {
    events.push(
      { event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index } },
    );
    index += 1;
  }
  for (const [n, call] of calls.entries()) {
    events.push(
      { event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${n}_${call.name}`, name: call.name, input: {} } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args ?? {}) } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index } },
    );
    index += 1;
  }
  events.push(
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: calls.length > 0 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 8 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  );
  return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/**
 * Anthropic's API, played by the spec on the page or its whole context (a
 * new tab too): its model list, and each message answered from `replies`
 * (`{text, calls}`) in order, as server-sent events with the headers a
 * browser needs to read them (CORS). A key in `refused` is answered 401;
 * `offline` set makes every request fail as a dropped connection. Records
 * each request's path, key and browser header.
 */
export async function playAnthropic(target, { replies = [], refused = [] } = {}) {
  const api = { replies: [...replies], requests: [], offline: false };
  const cors = { 'access-control-allow-origin': '*' };
  await target.route('https://api.anthropic.com/**', async route => {
    const request = route.request();
    if (api.offline) return route.abort('internetdisconnected');
    const headers = request.headers();
    api.requests.push({ path: new URL(request.url()).pathname, key: headers['x-api-key'] ?? null, direct: headers['anthropic-dangerous-direct-browser-access'] ?? null });
    if (refused.includes(headers['x-api-key'])) {
      return route.fulfill({ status: 401, contentType: 'application/json', headers: cors, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
    }
    if (request.url().includes('/v1/models')) {
      return route.fulfill({
        status: 200, contentType: 'application/json', headers: cors,
        body: JSON.stringify({ data: [{ id: PLAYED_MODEL.id, display_name: PLAYED_MODEL.label, max_input_tokens: 200_000, max_tokens: 8192, capabilities: {} }], has_more: false }),
      });
    }
    const reply = api.replies.shift() ?? { text: 'Nothing more to do.' };
    return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: cors, body: anthropicEventsOf(reply) });
  });
  return api;
}

/** Choose Anthropic in the chat settings with `key` (Remember ticked when asked) and the played model. */
export async function useAnthropicKey(page, key, { remember = false } = {}) {
  if (await page.locator('#agent-chat-settings').isHidden()) await page.locator('#agent-chat-settings-btn').click();
  await page.locator('#agent-chat-provider').selectOption('anthropic');
  await page.locator('#agent-chat-key').fill(key);
  await page.locator('#agent-chat-key').press('Enter');
  // Remember is offered once a key is kept: ticking it moves the key to this browser's storage.
  if (remember) await page.locator('#agent-chat-remember').check();
  await expect(page.locator(`#agent-chat-model option[value="${PLAYED_MODEL.id}"]`)).toHaveCount(1);
  await page.locator('#agent-chat-model').selectOption(PLAYED_MODEL.id);
  await page.locator('#agent-chat-settings-btn').click();
  await expect(page.locator('#agent-chat-settings')).toBeHidden();
}
