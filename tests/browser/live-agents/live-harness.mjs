/**
 * The live agent specs' harness: the chat bar driven by a real model
 * (Anthropic, OpenAI) with the owner's API keys, run locally only.
 *
 * **Keys never enter the page.** The harness reads them in Node (the
 * environment's `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, else the `.env` file
 * `CELLUCID_AGENT_ENV` names, else this checkout's `.env`); the page is given a
 * stand-in key, and the request leaving for the provider's API has the
 * stand-in replaced by the real key in flight (`page.route`). So no key is in
 * the DOM, a storage, a page log, a screenshot or a trace; the specs turn
 * traces, screenshots and videos off besides, and print only token counts and
 * costs. A spec without its key, or in CI, is skipped with the reason.
 *
 * Assertions are on the app's state and history (steps exist, by the agent of
 * the turn; Undo turn restores the state fingerprint), never on what a model
 * wrote.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from '../helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from '../helpers/origins.mjs';
import { dismissWelcome } from '../helpers/welcome.mjs';
import { waitForHistory } from '../helpers/state-history.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const LIVE_DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=live-agents`;

/** What the live specs use of Playwright: nothing that could keep a request. */
export const LIVE_USE = Object.freeze({ trace: 'off', screenshot: 'off', video: 'off' });

const PROVIDERS = Object.freeze({
  anthropic: { env: 'ANTHROPIC_API_KEY', api: 'https://api.anthropic.com/**', standIn: 'sk-ant-live-harness-stand-in', header: 'x-api-key', value: key => key },
  openai: { env: 'OPENAI_API_KEY', api: 'https://api.openai.com/**', standIn: 'sk-live-harness-stand-in', header: 'authorization', value: key => `Bearer ${key}` },
});

function envFile() {
  const file = process.env.CELLUCID_AGENT_ENV ?? path.join(ROOT, '.env');
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split('\n')
    .map(line => line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/))
    .filter(Boolean)
    .map(([, name, value]) => [name, value.replace(/^(['"])(.*)\1$/, '$2')]));
}

/** The key of `provider`, or null; never printed. */
export function liveKey(provider) {
  const name = PROVIDERS[provider].env;
  return process.env[name] || envFile()[name] || null;
}

/** Why a live spec of `provider` does not run here, or null when it does. */
export function liveSkipReason(provider) {
  if (process.env.CI) return 'Live agent specs never run in CI: they spend the owner\'s API credit.';
  if (liveKey(provider) === null) return `${PROVIDERS[provider].env} is not set (environment, CELLUCID_AGENT_ENV or .env): the live ${provider} specs need it.`;
  return null;
}

/** The stand-in key the page is given for `provider` (the real one replaces it in flight). */
export function standInKey(provider) {
  return PROVIDERS[provider].standIn;
}

/** Replace the stand-in key with the real one on every request to the provider's API (a page, or a whole context: its new tabs too). */
export async function routeLiveKey(target, provider) {
  const { api, standIn, header, value } = PROVIDERS[provider];
  const key = liveKey(provider);
  await target.route(api, async route => {
    const headers = { ...route.request().headers() };
    if (headers[header] === value(standIn)) headers[header] = value(key);
    await route.continue({ headers });
  });
}

/**
 * Prices per million tokens of the models the live specs use (input, cache
 * read, cache write, output), for the cost each run prints; a model not
 * listed prints its tokens only. Anthropic's from its price list (2026-10),
 * OpenAI's from its pricing page as quoted 2026-10-13.
 */
export const PRICES = Object.freeze({
  'claude-opus-5-5': { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
  'claude-sonnet-5-5': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  'claude-haiku-5-5': { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
  'gpt-6-luna': { input: 0.1, cacheRead: 0.01, cacheWrite: 0, output: 0.5 },
});

/** Tokens and cost of every model call of the run, by model. */
export function createLedger() {
  const byModel = new Map();
  return {
    add(model, usage) {
      const entry = byModel.get(model) ?? { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      entry.calls += 1;
      for (const field of ['input', 'cacheRead', 'cacheWrite', 'output']) entry[field] += usage[field] ?? 0;
      byModel.set(model, entry);
    },
    /** One line per model and the total cost, as printed at the end of a run. */
    report(title) {
      const lines = [`${title}: tokens and cost`];
      let total = 0;
      let priced = true;
      for (const [model, entry] of byModel) {
        const price = PRICES[model];
        // Input counts the whole prompt; the cached parts are priced as cache reads and writes.
        const fresh = entry.input - entry.cacheRead - entry.cacheWrite;
        const cost = price === undefined ? null
          : (fresh * price.input + entry.cacheRead * price.cacheRead + entry.cacheWrite * price.cacheWrite + entry.output * price.output) / 1e6;
        if (cost === null) priced = false; else total += cost;
        lines.push(`  ${model}: ${entry.calls} calls, ${entry.input} prompt tokens (${entry.cacheRead} cache reads, ${entry.cacheWrite} cache writes), ${entry.output} output tokens${cost === null ? '' : `, $${cost.toFixed(4)}`}`);
      }
      lines.push(`  total: $${total.toFixed(4)}${priced ? '' : ' (models without a listed price not counted)'}`);
      return lines.join('\n');
    },
  };
}

/** Open the fixture and the chat with `provider` and `model`, its key given as the stand-in. */
export async function openLiveChat(page, { provider, model }) {
  await routeLiveKey(page, provider);
  await page.goto(LIVE_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await waitForHistory(page);
  await page.locator('#agent-chat-toggle').click();
  if (await page.locator('#agent-chat-settings').isHidden()) await page.locator('#agent-chat-settings-btn').click();
  await page.locator('#agent-chat-provider').selectOption(provider);
  await page.locator('#agent-chat-key').fill(PROVIDERS[provider].standIn);
  await page.locator('#agent-chat-key').press('Enter');
  // The key's models listed: the stand-in was replaced and the provider accepted the real key.
  await expect(page.locator(`#agent-chat-model option[value="${model}"]`)).toHaveCount(1);
  await page.locator('#agent-chat-model').selectOption(model);
  await page.locator('#agent-chat-settings-btn').click();
}

/**
 * Send `text` and wait for the turn to end, answering what the person's
 * permissions ask about as a person who lets the agent go on in this chat
 * does ("This chat"); resolves to what the turn did (from the
 * conversation), with how many questions were answered.
 */
export async function liveTurn(page, text, { timeout = 5 * 60_000 } = {}) {
  await page.locator('#agent-chat-input').fill(text);
  await page.locator('#agent-chat-input').press('Enter');
  await expect(page.locator('#agent-chat-stop')).toBeVisible();
  let answered = 0;
  await expect.poll(async () => {
    const cards = page.locator('#agent-presence .agent-confirm');
    if (await cards.count() > 0) {
      await cards.first().locator('.agent-confirm-allow-here').click();
      answered += 1;
    }
    return page.locator('#agent-chat-send').isVisible();
  }, { timeout, intervals: [250] }).toBe(true);
  return { ...(await lastTurn(page)), answered };
}

/** The last turn of the chat: its id, tool calls with results, notes, and each model call's usage. */
export function lastTurn(page) {
  return page.evaluate(() => {
    const messages = window._cellucidUi.agents.chat.conversation.messages;
    const start = messages.findLastIndex(message => message.role === 'user');
    const turn = messages[start].turn;
    const own = messages.slice(start).filter(message => message.turn === turn);
    const results = new Map(own.filter(message => message.role === 'tool').flatMap(message => message.results).map(result => [result.id, result]));
    return {
      turn,
      calls: own.filter(message => message.role === 'assistant').flatMap(message => message.parts
        .filter(part => part.type === 'tool-call')
        .map(part => {
          const result = results.get(part.id) ?? null;
          return { name: part.name, args: part.args, isError: result?.isError ?? null, step: result?.step ?? null, text: result?.content?.[0]?.text ?? null };
        })),
      notes: own.filter(message => message.role === 'note').map(message => ({ kind: message.kind, text: message.text })),
      usage: own.filter(message => message.role === 'assistant' && message.usage).map(message => ({ model: message.model, ...message.usage })),
      replied: own.some(message => message.role === 'assistant' && message.parts.some(part => part.type === 'text' && part.text.trim() !== '')),
    };
  });
}

/** The history steps of `turn`, oldest first. */
export function stepsOfTurn(page, turn) {
  return page.evaluate(id => {
    const tree = window._cellucidHistories.current().active;
    return [...tree.steps.values()].filter(step => step.by.turn === id)
      .map(step => ({ type: step.type, origin: step.by.origin, agent: step.by.agent, label: step.label }));
  }, turn);
}

export async function fingerprint(page) {
  return page.evaluate(async () => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint } = await import('/assets/js/app/state/domains/fingerprint.js');
    return stateFingerprint(getStateDomains());
  });
}

/** Undo the turn as the person does (its footer's Undo turn); resolves when it is done. */
export async function undoTurnByClick(page, turn) {
  const foot = page.locator(`#agent-chat-log .agent-turn-foot[data-turn="${turn}"]`);
  await foot.locator('.agent-turn-undo').click();
  await expect(foot.locator('.agent-turn-undo')).toHaveText('Undone');
}
