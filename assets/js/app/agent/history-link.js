/**
 * @fileoverview Where agent conversations and the history meet: the one
 * place that knows both, so either can change (the history is being
 * redesigned) by changing this module.
 *
 * - **A turn's steps** (`turnSteps`, `stepsOfTurn`): read from the history's
 *   turn records (`app/history/turns.js` `turnFacts`): how many steps each
 *   turn made in the tracker shown, how many are on the path to the step
 *   shown, and its latest.
 * - **From a message to its steps** (`revealStep`): the chat asks the
 *   history's panel to show one step (the State panel registers how,
 *   `registerStepRevealer`).
 * - **From a step to its message** (`revealTurn`): the history's turn
 *   record keeps the turn's model, conversation and message (the dispatch's
 *   meta, History v2 §3.12); the chat bar registers how its message is shown
 *   (`registerTurnLink`). A turn of an agent outside the chat bar (the
 *   connector) has no message here.
 * - **A turn's summary note** (`noteTurn`): the chat's one-line account of a
 *   turn (`chat/export.js` `turnNoteOf`) kept as the turn's note through
 *   `history.note.add` (`from_reply`), when the agent wrote none.
 * - **Undo an agent's turn** (`undoAgentTurn`: the one Undo turn of the
 *   chat, the activity line and the State panel, History v2 §3.3.10), through
 *   the history's own undo of a turn (`history.undoTurn`, what
 *   `history.turn.undo` runs). The turn alone at the end of the branch shown:
 *   back to the step before it, kept for redo. Someone else acted after it
 *   began (the person, another agent at the same time): the person chooses,
 *   in one dialog, between only the turn's own steps (they go to Recently
 *   deleted, where they can be restored; only the later steps that changed
 *   or read what they changed are applied again, and one that needed them
 *   stays, marked as no longer applying, and is reported) and everything
 *   since the turn began (back to the step before it, kept for redo).
 *
 * @module app/agent/history-link
 */

import { showConfirmDialog } from '../ui/components/confirm-dialog.js';
import { getNotificationCenter } from '../notification-center.js';
import { originOf } from '../history/exports/step-text.js';
import { turnFacts } from '../history/turns.js';
import { getActions } from '../actions/index.js';
import { countOutside, outsideText } from './presence/activity.js';
import { formatCountOf } from '../../utils/format-units.js';

let stepRevealer = null;
let turnLink = null;
const turnListeners = new Set();

/**
 * The steps of each turn of the tracker `tree` shows: `{inTree, onPath, last,
 * deleted}` (`last`: its latest step on the path shown, else in the tree;
 * `deleted`: its steps an Undo turn of only its own steps moved to Recently
 * deleted, not emptied from there since).
 * @param {object|null} tree - a live tracker
 * @returns {Map<string, {inTree: number, onPath: number, last: string|null, deleted: number}>}
 */
export function turnSteps(tree) {
  const facts = turnFacts(tree);
  for (const entry of facts.values()) entry.deleted = 0;
  for (const entry of tree?.journal ?? []) {
    if (entry.purged || entry.op !== 'turn.undo') continue;
    for (const step of entry.before?.steps ?? []) {
      const id = step.by?.turn ?? null;
      if (id === null) continue;
      // Its turn record may have gone with its steps: the turn is still the chat's.
      if (!facts.has(id)) facts.set(id, { inTree: 0, onPath: 0, last: null, deleted: 0 });
      facts.get(id).deleted += 1;
    }
  }
  return facts;
}

/** The steps of one turn (`turnSteps`), or none. */
export function stepsOfTurn(tree, turn) {
  return turnSteps(tree).get(turn) ?? { inTree: 0, onPath: 0, last: null, deleted: 0 };
}

/**
 * How the history's panel shows one step (open, scrolled to, its details
 * open; it may finish later, once the panel's opening is recorded). Returns
 * the unregister.
 * @param {(stepId: string) => (void|Promise<void>)} reveal
 */
export function registerStepRevealer(reveal) {
  stepRevealer = reveal;
  return () => { if (stepRevealer === reveal) stepRevealer = null; };
}

/** Show `stepId` in the history's panel; false when no panel can. */
export function revealStep(stepId) {
  if (stepRevealer === null) return false;
  stepRevealer(stepId);
  return true;
}

/**
 * How a chat shows its turns' messages and names their models. Returns the unregister.
 * @param {{reveal: (turn: string) => boolean, modelLabel?: (model: string) => string}} link
 */
export function registerTurnLink(link) {
  turnLink = link;
  return () => { if (turnLink === link) turnLink = null; };
}

/** The chat shows other turns now (another conversation): the history's panel draws its turns again. */
export function turnsChanged() {
  for (const listener of [...turnListeners]) listener();
}

/** Be told when the chat shows other turns (`turnsChanged`). Returns the unsubscribe. */
export function subscribeTurns(listener) {
  turnListeners.add(listener);
  return () => turnListeners.delete(listener);
}

/**
 * Keep a chat's account of a turn as the turn's summary note (History v2
 * §3.3.10), when the turn made steps and has no note yet: the agent wrote
 * none. Resolves whether a note was added.
 *
 * @param {object|null} history - the current history
 * @param {{turn: string, agent: string, text: string|null}} facts
 */
export async function noteTurn(history, { turn, agent, text }) {
  const record = history?.active?.turns.get(turn) ?? null;
  if (record === null || record.notes.length > 0 || typeof text !== 'string' || text.length === 0) return false;
  await getActions().dispatch('history.note.add', { target: { turn }, text, from_reply: true }, { origin: 'agent', agent, turn });
  return true;
}

/** A turn's model as a person reads it (the chat's name for it), or the id the turn recorded. */
export function modelLabelOf(model) {
  if (typeof model !== 'string' || model.length === 0) return null;
  return turnLink?.modelLabel?.(model) ?? model;
}

/** Show the message of `turn` in its chat; false when no chat here holds it. */
export function revealTurn(turn) {
  return turnLink?.reveal(turn) ?? false;
}

/** The steps from the root to the step `tree` shows, oldest first. */
function pathShown(tree) {
  const path = [];
  for (let step = tree.steps.get(tree.headId); step; step = step.parent === null ? null : tree.steps.get(step.parent)) path.unshift(step);
  return path;
}

/**
 * What undoing `turn` in `tree` takes back: `own`, its steps on the path
 * shown; `others`, the steps of anyone else after its first one there;
 * `elsewhere`, how many of its steps are on another branch (they stay);
 * `agent`, who took it. Null when none of its steps is on the path shown.
 *
 * @param {object|null} tree - a live tracker
 * @param {string} turn
 * @returns {{agent: string, own: object[], others: object[], elsewhere: number}|null}
 */
export function turnUndoPlan(tree, turn) {
  // A step of no turn (the person's) is no turn's to undo.
  if (!tree || typeof turn !== 'string' || turn === '') return null;
  const path = pathShown(tree);
  const at = path.findIndex(step => step.by.turn === turn);
  if (at === -1) return null;
  const own = path.slice(at).filter(step => step.by.turn === turn);
  const others = path.slice(at).filter(step => step.by.turn !== turn);
  let inTree = 0;
  for (const step of tree.steps.values()) if (step.by.turn === turn) inTree += 1;
  return { agent: originOf(own[0].by).name, own, others, elsewhere: inTree - own.length };
}

/** Whose the steps after the turn began are, in a few words ("2 of yours, 1 of ChatGPT's"). */
function othersPhrase(agent, others) {
  const counts = new Map();
  for (const step of others) {
    const origin = originOf(step.by);
    const who = origin.key === 'person' ? 'of yours'
      : origin.key === 'outside' ? 'not recorded as an action'
        : origin.name === agent ? `from another ${agent} turn` : `of ${origin.name}'s`;
    counts.set(who, (counts.get(who) ?? 0) + 1);
  }
  return [...counts].map(([who, count]) => `${count} ${who}`).join(', ');
}

/**
 * Ask the person how to undo a turn others acted after (history-v2
 * §3.3.10): `'own'` (only the turn's steps), `'since'` (everything since
 * it began) or null (neither).
 * @param {{agent: string, own: object[], others: object[], elsewhere: number}} plan
 * @returns {Promise<'own'|'since'|null>}
 */
export function askHowToUndoTurn(plan) {
  const { agent, own, others, elsewhere } = plan;
  const total = own.length + others.length;
  const them = own.length === 1 ? 'it' : 'them';
  const message = [
    `${formatCountOf(others.length, 'change')} came after ${agent}'s turn began (${othersPhrase(agent, others)}).`,
    `Only ${agent}'s ${formatCountOf(own.length, 'step')}: ${own.length === 1 ? 'it goes' : 'they go'} to Recently deleted, where ${own.length === 1 ? 'it' : 'they'} can be restored, and the later steps that needed ${them} are applied again without ${them}. A step that cannot be stays, marked as no longer applying.`,
    `All ${formatCountOf(total, 'step')} since: back to before ${agent}'s turn, kept for redo.`,
    ...(elsewhere > 0 ? [`${elsewhere} of its steps ${elsewhere === 1 ? 'is' : 'are'} on another branch and ${elsewhere === 1 ? 'stays' : 'stay'} there.`] : []),
  ].join(' ');
  return new Promise(resolve => {
    showConfirmDialog({
      title: `Undo ${agent}'s turn?`,
      message,
      confirmText: `Only ${agent}'s ${formatCountOf(own.length, 'step')}`,
      alternativeText: `All ${formatCountOf(total, 'step')} since`,
      onConfirm: () => resolve('own'),
      onAlternative: () => resolve('since'),
      onCancel: () => resolve(null),
    });
  });
}

/**
 * What a turn did outside the state that no undo takes back (its record's
 * `outside`), counted by the words of its actions (`acts`): `[{one, other,
 * count}]`.
 * @param {{outside?: Array<{type: string, label: string}>}|null|undefined} record - a turn record
 * @param {{has: (type: string) => boolean, get: (type: string) => object}} [catalog]
 */
export function outsideOfTurn(record, catalog = getActions().catalog) {
  const acts = (record?.outside ?? []).map(act => {
    const words = catalog?.has?.(act.type) ? catalog.get(act.type).acts : null;
    return words ? { one: words.one, other: words.other } : { one: 'act outside Cellucid', other: 'acts outside Cellucid' };
  });
  return countOutside(acts);
}

/**
 * What an undone turn tells the person, or null when the turn alone was
 * undone and did nothing outside the state (its line and its steps show
 * it): `{text, tone, title}`, `title` naming each step that no longer
 * applies and why. What the turn did outside the state (`outside`, counted:
 * a vote published) stays done, and is said so plainly.
 * @param {{undone: boolean, how: string|null, agent: string|null, steps: number, report: Array<{step: string, label: string, reason: string}>,
 *   outside?: Array<{one: string, other: string, count: number}>}} result
 */
export function turnUndoNote(result) {
  if (!result.undone) return null;
  const outside = outsideText(result.outside ?? []);
  const total = (result.outside ?? []).reduce((sum, act) => sum + act.count, 0);
  const stays = outside === null ? '' : `; ${outside} ${total === 1 ? 'stays' : 'stay'}: Undo cannot take ${total === 1 ? 'it' : 'them'} back`;
  if (result.how === 'end') {
    if (outside === null) return null;
    const undid = `Undid ${result.agent}'s ${formatCountOf(result.steps, 'step')}`;
    return { text: `${undid}${stays}.`, tone: 'warning', title: `${undid}${stays}.` };
  }
  if (result.how === 'since') {
    return { text: `Undid everything since ${result.agent}'s turn began${stays}.`, tone: outside === null ? 'success' : 'warning', title: `${formatCountOf(result.steps, 'step')} undone, kept for redo${stays}.` };
  }
  const undid = `Undid ${result.agent}'s ${formatCountOf(result.steps, 'step')}`;
  if (result.report.length === 0) {
    return { text: `${undid} (to Recently deleted); the steps after them apply again${stays}.`, tone: outside === null ? 'success' : 'warning', title: `${undid}: they are in Recently deleted, where they can be restored, and the steps taken after them were applied again without them${stays}.` };
  }
  return {
    text: `${undid} (to Recently deleted); ${formatCountOf(result.report.length, 'step')} no longer ${result.report.length === 1 ? 'applies' : 'apply'}${stays}.`,
    tone: 'warning',
    title: `${undid}${stays}. ${result.report.map(entry => `“${entry.label}”: ${entry.reason}`).join(' ')}`,
  };
}

/** Tell the person what an undone turn did (a notification; see `turnUndoNote`). */
function tellInNotification(note) {
  const center = getNotificationCenter();
  if (note.tone === 'warning') center.warning(note.text, { category: 'session', details: note.title });
  else center.success(note.text, { category: 'session' });
}

/**
 * Undo `turn` in the tracker shown (the module comment says how).
 *
 * @param {{active: object|null, undoTurn: (turn: string, options?: {onlyOwn?: boolean}) => Promise<object>}} history
 * @param {string} turn
 * @param {{
 *   ask?: (plan: object) => Promise<'own'|'since'|null>,
 *   run?: (task: () => Promise<object|null>) => Promise<object|null|undefined>,
 *   tell?: (note: {text: string, tone: string, title: string}, result: object) => void,
 * }} [options] - `ask`: the choice when others acted after the turn began
 *   (`askHowToUndoTurn`); `run`: how the caller runs the change (busy, its
 *   failure reported; undefined when it failed); `tell`: what the person is
 *   told after (`turnUndoNote`; a notification); `catalog`: the actions whose words count what
 *   the turn did outside the state (the page's catalogue when left out)
 * @returns {Promise<{found: boolean, undone: boolean, how: 'end'|'own'|'since'|null, agent: string|null, steps: number, report: Array<{step: string, label: string, reason: string}>,
 *   outside: Array<{one: string, other: string, count: number}>}>}
 *   `found`: some of its steps are on the path shown; `how`: alone at the end, only its own, or everything since;
 *   `outside`: what it did outside the state, which stays (`outsideOfTurn`)
 */
export async function undoAgentTurn(history, turn, { ask = askHowToUndoTurn, run = task => task(), tell = tellInNotification, catalog = undefined } = {}) {
  const plan = turnUndoPlan(history.active, turn);
  // What it did outside the state stays done whatever is undone (a vote published).
  const outside = outsideOfTurn(history.active?.turns?.get?.(turn) ?? null, catalog);
  const result = { found: plan !== null, undone: false, how: null, agent: plan?.agent ?? null, steps: 0, report: [], outside };
  if (plan === null) return result;
  const choice = plan.others.length === 0 ? 'end' : await ask(plan);
  if (choice === null) return result;
  const done = await run(async () => {
    // The history may have moved while the person chose: the steps are those shown now.
    const now = turnUndoPlan(history.active, turn);
    if (now === null) return null;
    const moved = async () => {
      const head = history.active.headId;
      await history.undoTurn(turn);
      return history.active.headId !== head;
    };
    if (now.others.length === 0) return { how: 'end', undone: await moved(), steps: now.own.length, report: [] };
    if (choice === 'since') return { how: 'since', undone: await moved(), steps: now.own.length + now.others.length, report: [] };
    // Only its own steps: one journaled edit (Recently deleted), the dependants applied again once.
    const { flagged } = await history.undoTurn(turn, { onlyOwn: true });
    const report = flagged.map(entry => ({ ...entry, label: history.active.steps.get(entry.step)?.label ?? entry.step }));
    return { how: 'own', undone: true, steps: now.own.length, report };
  });
  if (done == null) return result;
  Object.assign(result, done);
  const note = turnUndoNote(result);
  if (note !== null) tell(note, result);
  return result;
}
