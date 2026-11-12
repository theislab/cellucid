/**
 * Bring your own key, against the real providers, in whichever engine runs
 * it (Chromium, Firefox, WebKit): the chat bar with the person's own key and
 * no connector ever set up. Anthropic (the main provider) and OpenAI (parity),
 * each on its cheapest model:
 *
 * - the provider lets the deployed site call it from the browser (CORS for
 *   https://www.cellucid.com, asked from Node: a preflight, and an answer
 *   with the key);
 * - a turn's tool call is a step of the agent;
 * - a reload keeps a key kept for the tab; a new tab has it only once
 *   Remember is ticked;
 * - offline, the turn waits; back online, it goes through.
 *
 * Anthropic's turn also runs on each other kind of dataset: a link, a local
 * file, a dataset a notebook serves.
 *
 * Local only, with the owner's keys (`live-harness.mjs`); skipped otherwise.
 * Assertions are on the app's state and history, never on what a model wrote.
 */
import { fileURLToPath } from 'node:url';

import { closePageWithApplicationRetirement, expect, test } from '../helpers/test.mjs';
import { ANTHROPIC_VERSION } from '../../../assets/js/app/agent/providers/anthropic.js';
import { APP_ORIGIN, ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from '../helpers/origins.mjs';
import { H5AD_PATH } from '../helpers/dataset-loading.mjs';
import { chooseFiles } from '../helpers/file-input.mjs';
import { goOffline } from '../helpers/offline.mjs';
import { serveAnnDataServer } from '../helpers/anndata-server.mjs';
import { dismissWelcome } from '../helpers/welcome.mjs';
import { waitForHistory } from '../helpers/state-history.mjs';
import {
  LIVE_DATASET_URL, LIVE_USE, createLedger, liveKey, liveSkipReason, liveTurn, routeLiveKey, standInKey, stepsOfTurn,
} from './live-harness.mjs';

const RUNS = [
  {
    provider: 'anthropic', model: 'claude-haiku-5-5', agent: 'Claude', label: 'Anthropic',
    preflight: { url: 'https://api.anthropic.com/v1/messages', headers: 'content-type,x-api-key,anthropic-version,anthropic-dangerous-direct-browser-access' },
    models: key => ({ url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' } }),
  },
  {
    provider: 'openai', model: 'gpt-6-luna', agent: 'ChatGPT', label: 'OpenAI',
    preflight: { url: 'https://api.openai.com/v1/responses', headers: 'content-type,authorization' },
    models: key => ({ url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${key}` } }),
  },
];
const DEPLOYED = 'https://www.cellucid.com';
// A field the dataset does not open colored by (it opens colored by its cell types, F21), so the turn changes the coloring.
const TASK = 'Color the cells by the first continuous field of this dataset. Read the fields first. Reply in one short sentence.';

// No trace, screenshot or video: nothing that could keep a request.
test.use(LIVE_USE);

async function openChatWithKey(page, run, { remember = false } = {}) {
  if (await page.locator('#agent-chat-panel').isHidden()) await page.locator('#agent-chat-toggle').click();
  if (await page.locator('#agent-chat-settings').isHidden()) await page.locator('#agent-chat-settings-btn').click();
  await page.locator('#agent-chat-provider').selectOption(run.provider);
  await page.locator('#agent-chat-key').fill(standInKey(run.provider));
  await page.locator('#agent-chat-key').press('Enter');
  // Remember is offered once a key is kept: ticking it moves the key to this browser's storage.
  if (remember) await page.locator('#agent-chat-remember').check();
  await expect(page.locator(`#agent-chat-model option[value="${run.model}"]`)).toHaveCount(1);
  await page.locator('#agent-chat-model').selectOption(run.model);
  await page.locator('#agent-chat-settings-btn').click();
}

async function openFixture(page) {
  await page.goto(LIVE_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await waitForHistory(page);
}

for (const run of RUNS) {
  test.describe(`live BYOK: ${run.provider} ${run.model}`, () => {
    const ledger = createLedger();
    test.skip(() => liveSkipReason(run.provider) !== null, liveSkipReason(run.provider) ?? '');
    test.afterAll(({ browserName }) => {
      console.log(ledger.report(`Live BYOK, ${run.provider}, ${browserName}`));
    });

    async function turnMakesAStep(page) {
      const turn = await liveTurn(page, TASK);
      for (const usage of turn.usage) ledger.add(usage.model, usage);
      const steps = await stepsOfTurn(page, turn.turn);
      expect(steps.some(step => step.type === 'color.by' && step.origin === 'agent' && step.agent === run.agent), 'the turn colored the cells, as the agent').toBe(true);
      return turn;
    }

    test(`${run.label} lets ${DEPLOYED} call it from the browser`, async () => {
      // Node asks as the deployed page's browser would; the key stays in Node.
      const preflight = await fetch(run.preflight.url, {
        method: 'OPTIONS',
        headers: { Origin: DEPLOYED, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': run.preflight.headers },
      });
      expect(preflight.status, 'the preflight is answered').toBeLessThan(300);
      expect(preflight.headers.get('access-control-allow-origin')).toMatch(/^(\*|https:\/\/www\.cellucid\.com)$/);
      const allowed = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase();
      for (const header of run.preflight.headers.split(',')) {
        expect(allowed === '*' || allowed.split(/\s*,\s*/).includes(header), `${header} is allowed`).toBe(true);
      }
      const { url, headers } = run.models(liveKey(run.provider));
      const answer = await fetch(url, { headers: { Origin: DEPLOYED, ...headers } });
      expect(answer.status).toBe(200);
      expect(answer.headers.get('access-control-allow-origin')).toMatch(/^(\*|https:\/\/www\.cellucid\.com)$/);
      await answer.body?.cancel();
    });

    test('a turn is a step of the agent; a reload keeps the tab key; a new tab has it once remembered; offline, then back', async ({ page, context }) => {
      test.setTimeout(10 * 60_000);
      await routeLiveKey(context, run.provider);
      await openFixture(page);
      await openChatWithKey(page, run);
      await turnMakesAStep(page);
      expect(await page.evaluate(provider => localStorage.getItem(`cellucid:agent-key:${provider}`), run.provider)).toBeNull();

      await page.reload({ waitUntil: 'domcontentloaded' });
      await dismissWelcome(page);
      await waitForHistory(page);
      if (await page.locator('#agent-chat-panel').isHidden()) await page.locator('#agent-chat-toggle').click();
      await expect(page.locator('#agent-chat-status')).not.toHaveText('Add an API key to start.');
      await turnMakesAStep(page);

      const second = await context.newPage();
      await openFixture(second);
      if (await second.locator('#agent-chat-panel').isHidden()) await second.locator('#agent-chat-toggle').click();
      await expect(second.locator('#agent-chat-status')).toHaveText('Add an API key to start.');
      await openChatWithKey(second, run, { remember: true });
      const third = await context.newPage();
      await openFixture(third);
      if (await third.locator('#agent-chat-panel').isHidden()) await third.locator('#agent-chat-toggle').click();
      await expect(third.locator('#agent-chat-status')).not.toHaveText('Add an API key to start.');

      await goOffline(context);
      await expect(third.locator('#agent-chat-status')).toHaveText('This browser is offline; a message waits until it is back.');
      await third.locator('#agent-chat-input').fill(TASK);
      await third.locator('#agent-chat-input').press('Enter');
      await expect(third.locator('#agent-chat-log .agent-chat-working')).toHaveAttribute('data-phase', 'waiting');
      await context.setOffline(false);
      await expect(third.locator('#agent-chat-send')).toBeVisible({ timeout: 5 * 60_000 });
      const steps = await third.evaluate(() => [...window._cellucidHistories.current().active.steps.values()].filter(step => step.by.origin === 'agent').map(step => step.type));
      expect(steps).toContain('color.by');
      await closePageWithApplicationRetirement(second);
      await closePageWithApplicationRetirement(third);
    });

    if (run.provider === 'anthropic') {
      const KINDS = [
        ['a link', async page => {
          const link = `${SAMPLE_ORIGIN}/tests/browser/fixtures/current-ui-smoke.h5ad`;
          await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(link)}`, { waitUntil: 'domcontentloaded' });
          await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
          await waitForHistory(page);
        }],
        ['a local file', async page => {
          await openFixture(page);
          await chooseFiles(page.locator('#user-data-file-input'), H5AD_PATH);
          await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
          await waitForHistory(page);
        }],
        ['a notebook-served dataset', async page => {
          const file = fileURLToPath(new URL('../fixtures/catalog/current-ui.h5ad', import.meta.url));
          await serveAnnDataServer(page, APP_ORIGIN, { id: 'current-ui', name: 'Current UI fixture', file, cells: 120, genes: 6 }, { viewerHost: true });
          const url = new URL('/', APP_ORIGIN);
          url.searchParams.set('viewer', 'true');
          url.searchParams.set('viewerId', 'viewer-1');
          url.searchParams.set('viewerToken', 'token-1');
          await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
          await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
          await waitForHistory(page);
        }],
      ];
      for (const [kind, open] of KINDS) {
        test(`on ${kind}, a turn is a step of the agent`, async ({ page }) => {
          test.setTimeout(5 * 60_000);
          await routeLiveKey(page, run.provider);
          await open(page);
          await openChatWithKey(page, run);
          await turnMakesAStep(page);
        });
      }
    }
  });
}
