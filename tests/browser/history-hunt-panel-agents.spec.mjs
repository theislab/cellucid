/**
 * History hunt: the State panel and agents meeting the history. Undo then
 * redo pressed back to back lands where it started; an agent's turn undone
 * after the person acted, with only the agent's steps chosen, takes back
 * only those steps, exactly. (A
 * click selects a row and a double-click shows it: history-graph.spec.mjs.)
 */
import { expect, test } from './helpers/test.mjs';
import { takeSteps, waitForHistory } from './helpers/state-history.mjs';
import {
  CELL_TYPE, COLOR_BY_SCORE, SCORE, installScriptedModel, openAgentDataset, openChat, queueReplies, say,
} from './helpers/agent-chat.mjs';
import { observeOutsideChanges, observeProductErrors } from './helpers/history-hunt.mjs';

const hide = categories => ['filter.category.visibility', { field: CELL_TYPE, categories, visible: false }];

/** The step shown, every step on the path to it (label and status) and the fingerprint of every domain, once idle. */
function facts(page) {
  return page.evaluate(async () => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint } = await import('/assets/js/app/state/domains/fingerprint.js');
    const history = window._cellucidHistories.current();
    await history.idle();
    const tree = history.active;
    const path = [];
    for (let step = tree.steps.get(tree.headId); step; step = tree.steps.get(step.parent)) path.unshift(`${step.label}:${step.status}`);
    return { head: tree.headId, path, domains: (await stateFingerprint(getStateDomains())).domains };
  });
}

test('undo then redo pressed back to back lands on the step it started from', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openAgentDataset(page);
  // The dataset opens colored by cell_type (its first coloring): score is the step.
  const ids = await takeSteps(page, [['color.by', { field: SCORE }], hide(['gamma'])]);
  const before = await facts(page);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await facts(page)).head).toBe(ids[1]);
  expect((await facts(page)).domains).toEqual(before.domains);
  expect(errors).toEqual([]);
});

test.describe('agents', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installScriptedModel);
  });

  test('Undo turn after the person acted, only the agent\'s steps: the person\'s step stays exactly', async ({ page }) => {
    const errors = observeProductErrors(page);
    const outside = observeOutsideChanges(page);
    await openAgentDataset(page);
    await waitForHistory(page);
    await openChat(page);
    const opening = await facts(page);
    await queueReplies(page, [{ calls: [COLOR_BY_SCORE, { name: 'setting_set', args: { setting: 'point-size', value: 30 } }] }, { text: 'Done.' }]);
    await say(page, 'Color by score and make the points bigger');
    const turn = await page.locator('#agent-chat-log .agent-msg-user').last().getAttribute('data-turn');
    // The person acts after the turn.
    await takeSteps(page, [hide(['gamma'])]);
    const foot = page.locator(`#agent-chat-log .agent-turn-foot[data-turn="${turn}"]`);
    await expect(foot.locator('.agent-turn-steps')).toHaveText(/^2 steps/);
    await foot.locator('.agent-turn-undo').click();
    // Someone acted after the turn began: the person chooses; only the agent's own steps go.
    const choice = page.locator('.confirm-dialog');
    await expect(choice.locator('.confirm-dialog-confirm')).toHaveText("Only Claude's 2 steps");
    await choice.locator('.confirm-dialog-confirm').click();
    await expect.poll(async () => (await facts(page)).path.length).toBe(2);
    // The turn's footer says where its steps went: Recently deleted, where they can be restored.
    await expect(foot.locator('.agent-turn-steps')).toHaveText('2 steps in Recently deleted');
    await expect(foot.locator('.agent-turn-undo')).toBeHidden();
    const after = await facts(page);
    // Only the hide remains: the state is the opening plus the hide (the filters domain), nothing else.
    const differs = Object.keys(opening.domains).filter(id => opening.domains[id] !== after.domains[id]);
    expect(differs).toEqual(['filters']);
    expect(after.path.at(-1)).toBe('Hid gamma of cell_type:applied');
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  });
});
