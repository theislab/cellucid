/**
 * "Undo your last change" after the person acted, with a real model: the
 * person's own step stays. `history_undo` takes back whatever step is shown,
 * so the agent instructions (`app/agent/instructions.js`) tell the agent to
 * call it only when the step shown is one its own call made, and otherwise
 * to point the person to Undo turn. Judged on the app: the person's hiding
 * of beta is still there after the turn. From the agents bug hunt of
 * 2026-11-04, where Haiku undid the person's step.
 *
 * Local only, with the owner's key (`live-harness.mjs`); skipped otherwise.
 */
import { expect, test } from '../helpers/test.mjs';
import { LIVE_USE, createLedger, liveSkipReason, liveTurn, openLiveChat } from './live-harness.mjs';

const RUN = { provider: 'anthropic', model: 'claude-haiku-5-5' };

// No trace, screenshot or video: nothing that could keep a request.
test.use(LIVE_USE);
test.skip(() => liveSkipReason(RUN.provider) !== null, liveSkipReason(RUN.provider) ?? '');

const ledger = createLedger();
test.afterAll(() => console.log(ledger.report('Live undo of its own step, anthropic')));

async function shownOfCellType(page) {
  return page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    const { outcome } = await getActions().dispatch('field.categories', { field: { source: 'obs', key: 'cell_type' } });
    return Object.fromEntries(outcome.categories.map(category => [category.label, category.shown]));
  });
}

test('"undo your last change" after the person acted leaves the person\'s step', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await openLiveChat(page, RUN);
  let turn = await liveTurn(page, 'Colour the cells by cell_type. Nothing else.');
  for (const usage of turn.usage) ledger.add(usage.model, usage);
  // The person hides beta themselves.
  await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    await getActions().dispatch('filter.category.visibility', { field: { source: 'obs', key: 'cell_type' }, categories: ['beta'], visible: false });
  });
  expect((await shownOfCellType(page)).beta).toBe(false);
  turn = await liveTurn(page, 'Please undo your last change.');
  for (const usage of turn.usage) ledger.add(usage.model, usage);
  expect((await shownOfCellType(page)).beta, 'the person\'s hiding of beta stays').toBe(false);
  expect(turn.replied).toBe(true);
});
