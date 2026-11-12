/**
 * "Undo your last change" after the person acted, with a real model: the
 * person's own step stays. `history_undo` takes back whatever step is shown,
 * so the agent instructions (`app/agent/instructions.js`) tell the agent to
 * call it only when the step shown is one its own call made, and otherwise
 * to point the person to Undo turn. Judged on the app: the person's hiding
 * of beta is still there after the turn. From the agents bug hunt of
 * 2026-11-04, where Haiku undid the person's step. And the other way round:
 * after the person undid only the agent's steps and acted, the next message
 * tells the agent so, and it answers from it (L3-15).
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
  let turn = await liveTurn(page, 'Color the cells by cell_type. Nothing else.');
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

// L3-15 (analyst lane A19): after Undo turn (only Claude's steps) and a step of the person, the
// model was not told, and answered "the Ductal cells are still hidden". The next message carries
// what changed since its turn (`agent/history-link.js` `historySinceSentence`), and the model
// answers from it without reading anything again.
test('after Undo turn of only its steps and a step of the person, the next message tells the agent, and it answers from it', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await openLiveChat(page, RUN);
  const first = await liveTurn(page, 'Hide the gamma cells of cell_type. Reply in one short sentence.');
  for (const usage of first.usage) ledger.add(usage.model, usage);
  expect((await shownOfCellType(page)).gamma).toBe(false);
  // The person colors by score, then undoes only the agent's steps.
  await page.evaluate(async turn => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    await getActions().dispatch('color.by', { field: { source: 'obs', key: 'score' } });
    const history = window._cellucidHistories.current();
    await history.idle();
    await history.undoTurn(turn, { onlyOwn: true });
    await history.idle();
  }, first.turn);
  expect((await shownOfCellType(page)).gamma).toBe(true);
  const second = await liveTurn(page, 'Are the gamma cells hidden now, and what are the cells colored by? Answer from what you already know, without reading anything, in one sentence.');
  for (const usage of second.usage) ledger.add(usage.model, usage);
  const told = await page.evaluate(id => window._cellucidUi.agents.chat.conversation.messages
    .find(message => message.role === 'user' && message.turn === id)?.since ?? null, second.turn);
  expect(told).toMatch(/(was|were) removed \(to Recently deleted, no longer in effect\).*The person's step .*score.* is now in effect/);
  const reply = await page.evaluate(id => window._cellucidUi.agents.chat.conversation.messages
    .filter(message => message.turn === id && message.role === 'assistant')
    .flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text)).join(' '), second.turn);
  expect(reply, 'it says the cells are colored by score').toMatch(/score/i);
  expect(reply, 'it never says gamma is still hidden').not.toMatch(/\b(still|remains?) hidden/i);
});
