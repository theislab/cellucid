/**
 * A question an agent asked is moot once the state it was asked about is
 * replaced: a saved session of the same dataset loaded while a connector
 * agent's card waits refuses the card (the history stays the same object,
 * so this is its `loaded` event, not another dataset shown), and Allow can
 * never apply the change to the state just loaded.
 */
import { expect, test } from './helpers/test.mjs';
import { installScriptedModel, observeProductErrors, openAgentDataset, stepFacts } from './helpers/agent-chat.mjs';
import { openPhoneSheet } from './helpers/panels.mjs';
import { clickSaveSession, clickLoadSession } from './helpers/session-buttons.mjs';

const CELL_TYPE = { source: 'obs', key: 'cell_type' };

async function hide(page, category) {
  await page.evaluate(async ({ field, name }) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    await getActions().dispatch('filter.category.visibility', { field, categories: [name], visible: false });
  }, { field: CELL_TYPE, name: category });
}

test('a connector agent\'s waiting card is refused when the person loads a saved session of this dataset', async ({ page }, testInfo) => {
  await page.addInitScript(installScriptedModel);
  const errors = observeProductErrors(page);
  await openAgentDataset(page);
  // A step, the session saved, then the person goes on (gamma hidden too).
  await hide(page, 'beta');
  await openPhoneSheet(page);
  const download = page.waitForEvent('download');
  await clickSaveSession(page);
  const sessionPath = testInfo.outputPath('before.cellucid-session');
  await (await download).saveAs(sessionPath);
  await hide(page, 'gamma');
  // A connector agent asks to change (the person's settings ask before every change).
  await page.evaluate(() => {
    window._cellucidUi.agents.presence.permissions.set({ kinds: { change: 'ask' } });
    window.__outcome = null;
    void (async () => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      try {
        await getActions().dispatch('color.by', { field: { source: 'obs', key: 'cell_type' } }, {
          origin: 'agent', agent: 'ChatGPT', turn: 'turn-c1', connection: { id: 'g1', kind: 'connector', client: 'ChatGPT', host: 'chatgpt.com', known: true },
        });
        window.__outcome = { ok: true };
      } catch (error) {
        window.__outcome = { ok: false, code: error.code ?? null, message: error.message };
      }
    })();
  });
  const card = page.locator('#agent-presence .agent-confirm');
  await expect(card).toHaveCount(1);
  const historyBefore = await page.evaluateHandle(() => window._cellucidHistories.current());

  // The person loads the saved session: the question is refused with its sentence, and nothing is colored.
  const chooser = page.waitForEvent('filechooser');
  await clickLoadSession(page);
  await (await chooser).setFiles(sessionPath);
  await expect(card).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__outcome)).toEqual({
    ok: false, code: 'state-loaded', message: 'A saved state was loaded before the person answered; nothing was done.',
  });
  expect(await page.evaluate(history => window._cellucidHistories.current() === history, historyBefore), 'the same history: its loaded event refuses the card').toBe(true);
  expect((await stepFacts(page)).filter(step => step.type === 'color.by')).toEqual([]);
  expect(errors).toEqual([]);
});
