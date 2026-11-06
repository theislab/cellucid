/**
 * Every action of the catalogue, called by a real model: a drift guard for
 * the tools. For each action a task is made from the catalogue itself (its
 * tool name, summary and example), so an action added tomorrow is in the
 * sweep without an edit here. Claude's cheapest model (Anthropic, the main
 * provider) gets each task in a new conversation on the fixture dataset.
 *
 * Per action: the model called its tool at least once, with arguments the
 * action's schema accepts (a refusal because the dataset has nothing it could
 * act on is the action answering, not a broken schema); and the turn undone
 * (and the history moved back where it was) puts every state domain back
 * exactly. A turn that does not end within `TURN_MS` (a tool that never
 * answers) is stopped and fails by name, and the sweep goes on. Each
 * catalogue group is one test; it lists every action that failed with why,
 * and prints what each action did.
 *
 * Local only, with the owner's key (`live-harness.mjs`); skipped otherwise.
 */
import { expect, test } from '../helpers/test.mjs';
import { getActionCatalog } from '../../../assets/js/app/actions/index.js';
import { catalogDocument } from '../../../assets/js/app/actions/catalog.js';
import { LIVE_USE, createLedger, fingerprint, lastTurn, liveSkipReason, liveTurn, openLiveChat } from './live-harness.mjs';

/** How long one action's turn may take before it is stopped and reported (a tool that never answers fails by name). */
const TURN_MS = 3 * 60_000;

const RUN = Object.freeze({ provider: 'anthropic', model: 'claude-haiku-5-5', agent: 'Claude' });
const DOCUMENT = catalogDocument(getActionCatalog());
const GROUPS = [...new Set(DOCUMENT.actions.map(action => action.group))];

function taskOf(action) {
  return [
    `Use the tool ${action.tool} (${action.title}): ${action.summary}`,
    `Its arguments look like this example, but name what exists in this dataset: ${JSON.stringify(action.example)}.`,
    'Read what you need first. If it can only work once something else is in place (a keyframe, a deleted field, a highlight group, an open analysis, an undone step), take that step first.',
    `Then call ${action.tool} so that it succeeds, and reply in one short sentence. Do nothing else.`,
  ].join(' ');
}

// No trace, screenshot or video: nothing that could keep a request.
test.use(LIVE_USE);

test.describe('live every-action sweep: anthropic claude-haiku-5-5', () => {
  const ledger = createLedger();
  const report = [];
  test.skip(() => liveSkipReason(RUN.provider) !== null, liveSkipReason(RUN.provider) ?? '');
  test.afterAll(() => {
    console.log(report.map(row => `  ${row.type}: ${row.outcome}`).join('\n'));
    console.log(ledger.report('Live every-action sweep, anthropic'));
  });

  for (const group of GROUPS) {
    const actions = DOCUMENT.actions.filter(action => action.group === group);
    test(`${group}: ${actions.map(action => action.tool).join(', ')}`, async ({ page }) => {
      test.setTimeout(actions.length * (TURN_MS + 60_000));
      await openLiveChat(page, RUN);
      const failures = [];
      for (const action of actions) {
        // A new conversation per action; New chat is offered once the one shown has a message.
        if (await page.locator('#agent-chat-new').isEnabled()) await page.locator('#agent-chat-new').click();
        await expect(page.locator('#agent-chat-log .agent-msg')).toHaveCount(0);
        // The state at rest (what the last undo set off recorded or redrawn), as the control walk takes it.
        await page.evaluate(() => window._cellucidHistories.current().idle());
        const before = await fingerprint(page);
        const head = await page.evaluate(() => window._cellucidHistories.current().active.headId);
        let turn;
        let stalled = false;
        try {
          turn = await liveTurn(page, taskOf(action), { timeout: TURN_MS });
        } catch {
          // The turn did not end (a tool that never answers): Stop it, report it by name, go on.
          stalled = true;
          await page.locator('#agent-chat-stop').click().catch(() => {});
          await expect(page.locator('#agent-chat-send')).toBeVisible();
          turn = await lastTurn(page);
        }
        for (const usage of turn.usage) ledger.add(usage.model, usage);
        const calls = turn.calls.filter(call => call.name === action.tool);
        const schemaRefused = calls.length > 0 && calls.every(call => call.isError && call.text?.startsWith(action.type));
        const succeeded = calls.some(call => call.isError === false);
        // Back to where the task started: the turn undone, the history's head where it was.
        await page.evaluate(async ({ id, headBefore }) => {
          const history = window._cellucidHistories.current();
          await history.idle();
          await history.undoTurn(id);
          if (history.active.headId !== headBefore) await history.jump(headBefore);
          await history.idle();
        }, { id: turn.turn, headBefore: head });
        const after = await fingerprint(page);
        // The domains the undone turn left changed, by name (what to look at when it fails).
        const left = Object.keys({ ...before.domains, ...after.domains })
          .filter(domain => JSON.stringify(before.domains?.[domain]) !== JSON.stringify(after.domains?.[domain]));
        const restored = left.length === 0 && JSON.stringify(after) === JSON.stringify(before);
        const errors = turn.notes.filter(note => note.kind === 'error').map(note => note.text);
        const outcome = stalled ? `did not end within ${TURN_MS / 60_000} min (stopped); calls: ${turn.calls.map(call => call.name).join(', ') || 'none'}`
          : calls.length === 0 ? 'not called'
            : schemaRefused ? `schema refused: ${calls.at(-1).text}`
              : `${succeeded ? 'ran' : `refused: ${calls.at(-1).text}`}${restored ? '' : `; undo did NOT restore the state (${left.join(', ') || 'its shape'})`}`;
        report.push({ type: action.type, outcome });
        if (stalled || calls.length === 0 || schemaRefused || !restored || errors.length > 0) failures.push(`${action.type}: ${outcome}${errors.length ? ` (${errors.join(' ')})` : ''}`);
      }
      expect(failures).toEqual([]);
    });
  }
});
