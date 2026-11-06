/**
 * The chat bar against the real providers when things go wrong: a key the
 * provider refuses, a model that does not exist, Stop in the middle of a
 * turn (and the conversation the provider still accepts afterwards), and a
 * dropped connection followed by a provider asking to slow down, both waited
 * out until the turn goes through. Anthropic and OpenAI each, on their
 * cheapest models.
 *
 * Local only, with the owner's keys (`live-harness.mjs`); skipped otherwise.
 */
import { expect, test } from '../helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from '../helpers/origins.mjs';
import { dismissWelcome } from '../helpers/welcome.mjs';
import { waitForHistory } from '../helpers/state-history.mjs';
import { LIVE_USE, createLedger, lastTurn, liveSkipReason, liveTurn, openLiveChat, routeLiveKey } from './live-harness.mjs';

const RUNS = [
  { provider: 'anthropic', model: 'claude-haiku-5-5', label: 'Anthropic', api: 'https://api.anthropic.com/v1/messages', refusedKey: 'sk-ant-api03-not-a-key' },
  { provider: 'openai', model: 'gpt-6-luna', label: 'OpenAI', api: 'https://api.openai.com/v1/responses', refusedKey: 'sk-proj-not-a-key' },
];

// No trace, screenshot or video: nothing that could keep a request.
test.use(LIVE_USE);

for (const run of RUNS) {
  test.describe(`live robustness: ${run.provider}`, () => {
    const ledger = createLedger();
    test.skip(() => liveSkipReason(run.provider) !== null, liveSkipReason(run.provider) ?? '');
    test.afterAll(() => {
      console.log(ledger.report(`Live robustness, ${run.provider}`));
    });

    async function record(page) {
      for (const usage of (await lastTurn(page)).usage) ledger.add(usage.model, usage);
    }

    test('a key the provider refuses is said in the settings, in one sentence', async ({ page }) => {
      await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=live-agents`, { waitUntil: 'domcontentloaded' });
      await dismissWelcome(page);
      await waitForHistory(page);
      await page.locator('#agent-chat-toggle').click();
      await page.locator('#agent-chat-provider').selectOption(run.provider);
      await page.locator('#agent-chat-key').fill(run.refusedKey);
      await page.locator('#agent-chat-key').press('Enter');
      await expect(page.locator('#agent-chat-settings-status')).toHaveText(`${run.label} did not accept this API key. Check it in the chat settings.`);
      await expect(page.locator('#agent-chat-settings-status')).toHaveAttribute('data-tone', 'danger');
    });

    test('a model that does not exist is refused as a model this key cannot use', async ({ page }) => {
      await routeLiveKey(page, run.provider);
      await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=live-agents`, { waitUntil: 'domcontentloaded' });
      await dismissWelcome(page);
      const failure = await page.evaluate(async ({ provider, standIn }) => {
        const { providersForPage } = await import('/assets/js/app/agent/providers/index.js');
        const chosen = providersForPage().find(candidate => candidate.id === provider);
        try {
          for await (const event of chosen.stream({ key: standIn, model: 'no-such-model-cellucid', system: 'Say hi.', messages: [{ role: 'user', text: 'Hi' }], tools: [] })) void event;
          return null;
        } catch (error) {
          return { kind: error.kind, message: error.message };
        }
      }, { provider: run.provider, standIn: run.provider === 'anthropic' ? 'sk-ant-live-harness-stand-in' : 'sk-live-harness-stand-in' });
      expect(failure?.kind).toBe('model');
      expect(failure.message).toMatch(new RegExp(`^This model is not available to this ${run.label} API key; choose another in the chat settings\\.`));
    });

    test('Stop in the middle of a turn, and the provider still accepts the conversation afterwards', async ({ page }) => {
      test.setTimeout(10 * 60_000);
      await openLiveChat(page, run);
      await page.locator('#agent-chat-input').fill('List every field, then read the categories of each categorical field one call at a time, then colour by each field in turn, one after the other.');
      await page.locator('#agent-chat-input').press('Enter');
      await expect(page.locator('#agent-chat-log .agent-tool').first()).toBeVisible({ timeout: 120_000 });
      await page.locator('#agent-chat-stop').click();
      await expect(page.locator('#agent-chat-send')).toBeVisible();
      await expect(page.locator('#agent-chat-log .agent-msg-note[data-kind="stopped"] p').last()).toHaveText('Stopped.');
      await record(page);
      const after = await liveTurn(page, 'Never mind. Reply with one short sentence and call no tool.');
      for (const usage of after.usage) ledger.add(usage.model, usage);
      expect(after.notes).toEqual([]);
      expect(after.replied).toBe(true);
    });

    test('a dropped connection, then a provider asking to slow down: both waited out, and the turn goes through', async ({ page }) => {
      test.setTimeout(10 * 60_000);
      await openLiveChat(page, run);
      let failures = 0;
      await page.route(run.api, async route => {
        failures += 1;
        if (failures === 1) return route.abort('internetdisconnected');
        if (failures === 2) {
          return route.fulfill({
            status: 429, contentType: 'application/json',
            headers: { 'retry-after': '2', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'retry-after' },
            body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'Rate limited by the spec.' } }),
          });
        }
        return route.fallback();
      });
      await page.locator('#agent-chat-input').fill('Reply with one short sentence and call no tool.');
      await page.locator('#agent-chat-input').press('Enter');
      await expect(page.locator('#agent-chat-log .agent-chat-working[data-phase="waiting"]')).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('#agent-chat-send')).toBeVisible({ timeout: 120_000 });
      const turn = await lastTurn(page);
      for (const usage of turn.usage) ledger.add(usage.model, usage);
      expect(failures).toBeGreaterThanOrEqual(3);
      expect(turn.notes).toEqual([]);
      expect(turn.replied).toBe(true);
    });
  });
}
