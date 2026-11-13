/**
 * Every action of the catalog, called by a real model: a drift guard for
 * the tools. For each action a task is made from the catalog itself (its
 * tool name, summary and example), so an action added tomorrow is in the
 * sweep without an edit here. Claude's cheapest model (Anthropic, the main
 * provider) gets each task in a new conversation on the fixture dataset.
 *
 * Per action: the model called its tool and it ran; or every call was
 * refused for a fact of the fixture the action cannot get past, named by the
 * refusal's exact code (`FIXTURE_FACTS`: community annotation is not
 * connected here; never a refusal in general, which is a precondition the
 * model did not put in place or a defect), or not called after the turn met
 * that refusal; and the turn undone (and the
 * history moved back where it was) puts every state domain back exactly
 * (opening a dataset, which Undo does not bring back by design, is followed
 * by opening the fixture again). A turn that does not end within `TURN_MS` (a tool that never
 * answers) is stopped and fails by name, and the sweep goes on. Each
 * catalog group is one test; it lists every action that failed with why,
 * and prints what each action did.
 *
 * `CELLUCID_SWEEP_ACTIONS` (action types, comma-separated) runs only those,
 * to check a fix without the whole sweep (hours).
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

/**
 * Refusals that are true facts of the fixture, by action and the refusal's
 * exact code (as the chat keeps it, `agent-loop.js`): the action answered
 * correctly. The fixture cannot connect a community annotation repository
 * (a GitHub sign-in the browser opens only from a person's click).
 */
const FIXTURE_FACTS = Object.freeze({
  'annotation.suggestions': { code: 'unavailable', why: 'community annotation is not connected on the fixture' },
  'annotation.publish': { code: 'unavailable', why: 'community annotation is not connected on the fixture' },
});
const ONLY = (process.env.CELLUCID_SWEEP_ACTIONS ?? '').split(',').map(type => type.trim()).filter(Boolean);
const DOCUMENT = catalogDocument(getActionCatalog());
const SWEPT = DOCUMENT.actions.filter(action => ONLY.length === 0 || ONLY.includes(action.type));
const UNKNOWN = ONLY.filter(type => !DOCUMENT.actions.some(action => action.type === type));
if (UNKNOWN.length > 0) throw new Error(`CELLUCID_SWEEP_ACTIONS names no action of the catalogue: ${UNKNOWN.join(', ')}`);
const GROUPS = [...new Set(SWEPT.map(action => action.group))];

/**
 * What some actions need in place first that the fixture, as it opens, does
 * not have (its history is one branch, Main; no highlight, filter or note):
 * said in the task so a model makes it rather than asking which or reporting
 * there was nothing to act on.
 */
const SETUP = Object.freeze({
  'history.branch.archive': 'First make a branch other than Main (`history_branch_create` from an earlier step, then one change), and archive that branch.',
  'history.branch.delete': 'First make a branch other than Main (`history_branch_create` from an earlier step, then one change), and delete that branch.',
  'history.journal.undo': 'First make an edit of the history that Recently deleted keeps (add a note, then remove it), then restore that entry.',
  'history.note.edit': 'First add a note of your own (`history_note_add`) and edit that one.',
  'history.note.remove': 'First add a note of your own (`history_note_add`) and remove that one.',
  'history.group.extend': 'The last two steps of the history are mine: group the first of them (`history_group_create`), then extend the group to the second.',
  'highlight.group.toggle': 'First highlight a category of cell_type (`highlight_category`), then turn that group off.',
  'cells.export': 'First highlight a category of cell_type (`highlight_category`), then export the highlighted cells as the CSV.',
  'filter.enable': 'First hide one category of cell_type (`filter_category_visibility`), then turn that filter off.',
  'dataset.open': 'Open the dataset the list of datasets names, the one open now too.',
});

/**
 * What the person does before the task, for an action that can only work on
 * steps outside the agent's turn: a turn's later steps join its own group, so
 * a group extends only to another turn's steps.
 */
const PREPARE = Object.freeze({
  'history.group.extend': page => page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    await getActions().dispatch('color.by', { field: { source: 'obs', key: 'score' } });
    // Not back to cell_type: a change that puts back the one before it takes that step out (`retracted`).
    await getActions().dispatch('filter.category.visibility', { field: { source: 'obs', key: 'cell_type' }, categories: ['gamma'], visible: false });
    await window._cellucidHistories.current().idle();
  }),
});

// A hint names actions and tools of the catalog only: one renamed fails here, not as a model's confusion.
for (const [type, hint] of Object.entries(SETUP)) {
  if (!DOCUMENT.actions.some(action => action.type === type)) throw new Error(`SETUP names no action: ${type}`);
  for (const [, tool] of hint.matchAll(/`([a-z_]+)`/g)) {
    if (!DOCUMENT.actions.some(action => action.tool === tool)) throw new Error(`SETUP for ${type} names no tool: ${tool}`);
  }
}

function taskOf(action) {
  return [
    `This is a test of one tool, and I ask for it on purpose: call ${action.tool} (${action.title}). What it does: ${action.summary}`,
    `Its arguments look like this example, but use what exists in this dataset (its fields, categories, genes, views, embeddings, highlights, steps, notes): ${JSON.stringify(action.example)}.`,
    'Read what you need first. If it can only work once something else is in place (a keyframe, a filter, a deleted field, a highlight group, an open analysis, a later step, a note of yours, an undone step), take that step first.',
    'Every choice is yours (which category, which cells, which name, which genes, which values, which dataset): pick ones that exist, say which, and do not ask me.',
    ...(SETUP[action.type] ? [SETUP[action.type]] : []),
    `Then call ${action.tool} so that it succeeds. If it is refused for something you can put in place, put it in place and call it again. Reply in one short sentence. Do nothing else.`,
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
    const actions = SWEPT.filter(action => action.group === group);
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
        // Back to `head` after the turn puts the person's preparation away too.
        await PREPARE[action.type]?.(page);
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
        // Refused for a fact of the fixture, by its exact code: answered correctly. Any other refusal is not.
        // Not called is answered too only when the turn met the fact first (the read before it refused with
        // that code: a vote on suggestions that cannot be read is not tried).
        const fact = FIXTURE_FACTS[action.type] ?? null;
        const metFact = call => call.isError && call.code === fact.code;
        const answeredByFact = !succeeded && fact !== null
          && (calls.length > 0 ? calls.every(metFact) : turn.calls.some(metFact));
        let left = [];
        let restored = true;
        if (action.effect === 'dataset' && succeeded) {
          // Opening a dataset replaces the open one, and Undo does not bring it back (by design, its
          // description says so): the fixture is opened again, its history as this browser kept it.
          await openLiveChat(page, RUN);
        } else {
          // Back to where the task started: the turn undone, the history's head where it was. A turn that
          // made no step (it only read, or changed nothing) has no record and nothing to undo, as its chat
          // offers no Undo turn; the state must then be as it was all the same.
          await page.evaluate(async ({ id, headBefore }) => {
            const history = window._cellucidHistories.current();
            await history.idle();
            if (history.active.turns.has(id)) await history.undoTurn(id);
            if (history.active.headId !== headBefore) await history.jump(headBefore);
            await history.idle();
          }, { id: turn.turn, headBefore: head });
          const after = await fingerprint(page);
          // The domains the undone turn left changed, by name (what to look at when it fails).
          left = Object.keys({ ...before.domains, ...after.domains })
            .filter(domain => JSON.stringify(before.domains?.[domain]) !== JSON.stringify(after.domains?.[domain]));
          restored = left.length === 0 && JSON.stringify(after) === JSON.stringify(before);
        }
        const errors = turn.notes.filter(note => note.kind === 'error').map(note => note.text);
        const outcome = stalled ? `did not end within ${TURN_MS / 60_000} min (stopped); calls: ${turn.calls.map(call => call.name).join(', ') || 'none'}`
          : calls.length === 0 ? (answeredByFact ? `not called after a refusal (${fact.code}: ${fact.why})` : 'not called')
            : schemaRefused ? `schema refused: ${calls.at(-1).text}`
              : `${succeeded ? 'ran' : answeredByFact ? `refused (${fact.code}: ${fact.why})` : `refused (${calls.at(-1).code ?? 'no code'}): ${calls.at(-1).text}`}${restored ? '' : `; undo did NOT restore the state (${left.join(', ') || 'its shape'})`}`;
        report.push({ type: action.type, outcome });
        const answered = succeeded || answeredByFact;
        if (stalled || !answered || !restored || errors.length > 0) failures.push(`${action.type}: ${outcome}${errors.length ? ` (${errors.join(' ')})` : ''}`);
      }
      expect(failures).toEqual([]);
    });
  }
});
