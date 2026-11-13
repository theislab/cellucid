/**
 * @fileoverview Where agent conversations and the history meet: the one
 * place that knows both, so either can change by changing this module.
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
 *   meta); the chat bar registers how its message is shown
 *   (`registerTurnLink`). A turn of an agent outside the chat bar (the
 *   connector) has no message here.
 * - **A turn's summary note** (`noteTurn`): the chat's one-line account of a
 *   turn (`chat/export.js` `turnNoteOf`) kept as the turn's note through
 *   `history.note.add` (`from_reply`), when the agent wrote none.
 * - **Undo an agent's turn** (`undoAgentTurn`: the one Undo turn of the
 *   chat, the activity line and the State panel), through
 *   the history's own undo of a turn (`history.undoTurn`, what
 *   `history.turn.undo` runs). The turn alone at the end of the branch shown:
 *   back to the step before it, kept for redo. Someone else acted after it
 *   began (the person, another agent at the same time): the person chooses,
 *   in one dialog, between only the turn's own steps (they go to Recently
 *   deleted, where they can be restored; only the later steps that changed
 *   or read what they changed are applied again, and one that needed them
 *   stays, marked as no longer applying, and is reported) and everything
 *   since the turn began (back to the step before it, kept for redo).
 * - **What changed since an agent's last turn** (`historySeen`,
 *   `historySinceSentence`): the steps in effect as a turn ends are kept; the
 *   person's next message tells the model, in one sentence, which of them are
 *   no longer in effect (its own turn undone, a step removed) and which steps
 *   came in (the person's, another agent's, a notebook's), by their labels,
 *   so it never reports as standing what the person took back (after Undo
 *   turn, a model not told says "the Ductal cells are still hidden");
 *   another history shown (a session file loaded beside, a saved state,
 *   another dataset) is said as which one, where from, and its latest
 *   steps. What an agent saw is kept with its conversation (chat) or
 *   for its connection (`bridge/agent-calls.js`). Steps only, never data.
 *
 * @module app/agent/history-link
 */

import { showConfirmDialog } from '../ui/components/confirm-dialog.js';
import { getNotificationCenter } from '../notification-center.js';
import { originOf } from '../history/exports/step-text.js';
import { turnFacts } from '../history/turns.js';
import { pathTo } from '../history/tree.js';
import { quoteName } from '../actions/targets/names.js';
import { getActions } from '../actions/index.js';
import { countOutside, outsideText } from './presence/activity.js';
import { countNoun, formatCountOf } from '../../utils/format-units.js';
import { createListenerSet } from '../../utils/listener-set.js';

let stepRevealer = null;
let turnLink = null;
const turnListeners = createListenerSet('the chat\'s turns shown');

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
 * How a chat shows its turns' messages. Returns the unregister.
 * @param {{reveal: (turn: string) => boolean}} link
 */
export function registerTurnLink(link) {
  turnLink = link;
  return () => { if (turnLink === link) turnLink = null; };
}

/** The chat shows other turns now (another conversation): the history's panel draws its turns again. */
export function turnsChanged() {
  turnListeners.notify();
}

/** Be told when the chat shows other turns (`turnsChanged`). Returns the unsubscribe. */
export function subscribeTurns(listener) {
  return turnListeners.add(listener);
}

/**
 * Keep a chat's account of a turn as the turn's summary note, when the turn
 * made steps and has no note yet: the agent wrote none. Resolves whether a note was added.
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
 * @returns {{agent: string, own: object[], others: object[], elsewhere: number, othersWho: string}|null}
 *   `othersWho`: whose the others are, in a few words (the dialog's)
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
  const agent = originOf(own[0].by).name;
  return { agent, own, others, elsewhere: inTree - own.length, othersWho: othersPhrase(tree, turn, agent, others) };
}

/**
 * Whose the steps after the turn began are, in a few words ("2 of yours,
 * 9 from 3 later turns of this chat, 1 of ChatGPT's"): the same agent's later
 * turns of the same conversation are counted as such (never as "another
 * Claude turn"), its turns elsewhere (another chat, a
 * connector) as other turns.
 */
function othersPhrase(tree, turn, agent, others) {
  const conversationOf = id => (id === null ? null : tree.turns?.get?.(id)?.conversation ?? null);
  const chat = conversationOf(turn);
  const groups = new Map();
  for (const step of others) {
    const origin = originOf(step.by);
    const sameAgent = origin.key !== 'person' && origin.key !== 'outside' && origin.name === agent;
    const key = origin.key === 'person' ? 'person' : origin.key === 'outside' ? 'outside'
      : sameAgent ? (chat !== null && conversationOf(step.by.turn) === chat ? 'chat' : 'agent') : `of ${origin.name}'s`;
    if (!groups.has(key)) groups.set(key, { steps: 0, turns: new Set() });
    const group = groups.get(key);
    group.steps += 1;
    if (step.by.turn !== null) group.turns.add(step.by.turn);
  }
  return [...groups].map(([key, { steps, turns }]) => {
    if (key === 'person') return `${steps} of yours`;
    if (key === 'outside') return `${steps} not recorded as an action`;
    if (key === 'chat') return `${steps} from ${formatCountOf(turns.size, 'later turn')} of this chat`;
    if (key === 'agent') return `${steps} from ${turns.size === 1 ? `another ${agent} turn` : formatCountOf(turns.size, `other ${agent} turn`)}`;
    return `${steps} ${key}`;
  }).join(', ');
}

/**
 * Ask the person how to undo a turn others acted after: `'own'` (only the
 * turn's steps), `'since'` (everything since it began) or null (neither).
 * @param {{agent: string, own: object[], others: object[], elsewhere: number, othersWho: string}} plan
 * @returns {Promise<'own'|'since'|null>}
 */
export function askHowToUndoTurn(plan) {
  const { agent, own, others, elsewhere, othersWho } = plan;
  const total = own.length + others.length;
  const them = own.length === 1 ? 'it' : 'them';
  const message = [
    `${formatCountOf(others.length, 'change')} came after ${agent}'s turn began (${othersWho}).`,
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
 *   the turn did outside the state (the page's catalog when left out)
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

/**
 * What a conversation knows of the history as its turn ends: the tracker
 * and branch shown, each step in effect (on the path to the step shown, the
 * opening left out) with its label and author, so a step removed later is
 * still named, and the tracker's next step number (the steps made since,
 * anywhere). Null without a tracker.
 *
 * A step someone else took while the turn ran (the person coloring
 * mid-turn: numbered from `from`, the tracker's next step number as the
 * turn began, and not of `ownTurns`) is not something the agent saw: it is
 * left out of the steps seen and listed in `during`, so the next message
 * tells it (in the snapshot it would never be "new").
 * The record is plain data, kept with the conversation (`chat/conversation.js`
 * `transcriptOf`: a reload, a saved state or a shared session keeps what its
 * agent last saw) and by an outside agent's connection (`bridge/agent-calls.js`);
 * `isHistorySeen` checks one read back. It names the tracker (id, name) and its
 * dataset, so the next message can say the history shown is another one
 * (a session loaded beside, another dataset opened).
 * @param {object|null} tree - the tracker shown
 * @param {{from?: number|null, ownTurns?: Set<string>, conversation?: string|null}} [turn] - `from`: the
 *   tracker's next step number as the turn began (null: none known, every
 *   step in effect counts as seen); `ownTurns`: the turns of the conversation;
 *   `conversation`: the chat's conversation of that turn (a chat that follows
 *   the tracker shown carries the record into the conversation it shows next)
 * @returns {{tracker: string, name: string, dataset: {id: string|null, name: string|null},
 *   branch: {id: string, name: string}|null, next: number,
 *   steps: Array<{id: string, label: string, by: object}>, during: string[]}|null}
 */
export function historySeen(tree, { from = null, ownTurns = new Set(), conversation = null } = {}) {
  if (!tree) return null;
  const inEffect = pathTo(tree, tree.headId).filter(step => step.parent !== null).map(seenStep);
  const tookDuring = step => from !== null && stepNumber(step.id) >= from && !(step.by.turn !== null && ownTurns.has(step.by.turn));
  const branch = tree.branches?.get?.(tree.activeBranch) ?? null;
  return {
    tracker: tree.id,
    name: typeof tree.name === 'string' ? tree.name : '',
    dataset: { id: tree.dataset?.id ?? null, name: tree.dataset?.name ?? null },
    branch: branch === null ? null : { id: branch.id, name: branch.name },
    next: tree.nextStep ?? 0,
    steps: inEffect.filter(step => !tookDuring(step)),
    during: inEffect.filter(tookDuring).map(step => step.id),
    ...(conversation === null ? {} : { conversation }),
  };
}

const SEEN_KEYS = new Set(['tracker', 'name', 'dataset', 'branch', 'next', 'steps', 'during', 'conversation']);
const isText = value => typeof value === 'string';
const isTextOrNull = value => value === null || typeof value === 'string';

/**
 * Whether `value` is a `historySeen` record read back (a saved conversation's,
 * a connection's): every field of its shape, nothing else trusted.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isHistorySeen(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { tracker, name, dataset, branch, next, steps, during, conversation } = value;
  const isBy = by => by !== null && typeof by === 'object' && isText(by.origin) && isTextOrNull(by.agent) && isTextOrNull(by.turn);
  return isText(tracker) && tracker.length > 0 && isText(name)
    && dataset !== null && typeof dataset === 'object' && isTextOrNull(dataset.id) && isTextOrNull(dataset.name)
    && (branch === null || (typeof branch === 'object' && isText(branch.id) && isText(branch.name)))
    && Number.isInteger(next) && next >= 0
    && Array.isArray(steps) && steps.every(step => step !== null && typeof step === 'object' && isText(step.id) && isText(step.label) && isBy(step.by))
    && Array.isArray(during) && during.every(isText)
    && (conversation === undefined || (isText(conversation) && conversation.length > 0))
    && Object.keys(value).every(key => SEEN_KEYS.has(key));
}

/** A step id's number ("s12" → 12). */
function stepNumber(id) {
  return Number(String(id).slice(1));
}

function seenStep(step) {
  return { id: step.id, label: step.label, by: { origin: step.by.origin, agent: step.by.agent ?? null, turn: step.by.turn ?? null } };
}

/** Whether `stepId` is on the path to `tipId` (the branch shown's tip): an undo there is redone by redo. */
function onPathTo(tree, stepId, tipId) {
  for (let step = tree.steps.get(tipId); step; step = step.parent === null ? null : tree.steps.get(step.parent)) {
    if (step.id === stepId) return true;
  }
  return false;
}

/** Who took a step, as the agent of `ownTurns` is told it. */
function authorOf(by, ownTurns) {
  if (by.turn !== null && ownTurns.has(by.turn)) return { key: 'own', who: 'Your', name: 'you' };
  if (by.origin === 'user') return { key: 'person', who: 'The person\'s', name: 'the person' };
  if (by.origin === 'host') return { key: 'host', who: 'A notebook\'s', name: 'a notebook' };
  return { key: `agent:${by.agent ?? ''}`, who: `${by.agent ?? 'Another agent'}'s`, name: by.agent ?? 'another agent' };
}

/** Labels quoted as data, one run of the same label said once with its count. */
function labelList(steps) {
  const runs = [];
  for (const step of steps) {
    const last = runs.at(-1);
    if (last?.label === step.label) last.count += 1;
    else runs.push({ label: step.label, count: 1 });
  }
  return runs.map(run => `${quoteName(run.label)}${run.count > 1 ? ` (${formatCountOf(run.count, 'time')})` : ''}`).join(', ');
}

/** Steps grouped by author, in order of their first step. */
function byAuthor(steps, ownTurns) {
  const groups = new Map();
  for (const step of steps) {
    const author = authorOf(step.by, ownTurns);
    if (!groups.has(author.key)) groups.set(author.key, { who: author.who, name: author.name, steps: [] });
    groups.get(author.key).steps.push(step);
  }
  return [...groups.values()];
}

/** How many labels of the steps in effect a switch names (the latest ones). */
const SWITCH_LABELS = 5;

/** A tracker and its dataset, as the model is told them. */
function trackerWords(name, dataset, otherDataset) {
  const named = quoteName(name === '' ? 'Tracker' : name);
  return dataset !== null && dataset !== otherDataset ? `${named} of the dataset ${quoteName(dataset)}` : named;
}

/** Where a tracker came from, as the model is told it (a session file loaded, a replay), or null. */
function startWords(tree) {
  const start = tree.start ?? null;
  if (start?.kind === 'import' && typeof start.from?.file === 'string') return `loaded from the session file ${quoteName(start.from.file)}`;
  if (start?.kind === 'replay' && typeof start.from?.tracker?.name === 'string') return `a replay of ${quoteName(start.from.tracker.name)}`;
  return null;
}

/**
 * The history shown is another tracker than the one `seen` names (a session
 * file loaded beside, a saved state opened, another dataset or tracker
 * shown): which one, where it came from, and its steps in effect, compactly
 * (a count by author, the latest labels), so the model never takes the
 * history before for this one (a "same questions please" would read as a
 * first look).
 */
function switchSentence(tree, seen, ownTurns, { conversation = null } = {}) {
  const now = historySeen(tree);
  const parts = [`the history shown is now ${trackerWords(now.name, now.dataset.name, seen.dataset?.name ?? null)}`];
  const from = startWords(tree);
  if (from !== null) parts[0] += `, ${from}`;
  parts[0] += ` (it was ${trackerWords(seen.name ?? '', seen.dataset?.name ?? null, now.dataset.name)})`;
  if (now.steps.length === 0) {
    parts.push('no step is in effect there yet');
  } else {
    const groups = byAuthor(now.steps, ownTurns).map(group => `${group.name} ${group.steps.length}`);
    const latest = now.steps.slice(-SWITCH_LABELS);
    parts.push(`${formatCountOf(now.steps.length, 'step')} ${countNoun(now.steps.length, 'is', 'are')} in effect there (by ${groups.join(', ')}); `
      + `the ${latest.length === now.steps.length ? countNoun(latest.length, 'step', 'steps') : `latest ${latest.length}`}: ${labelList(latest)}`);
  }
  if (conversation !== null && seen.conversation !== undefined && seen.conversation !== conversation) {
    parts.push(`this conversation is not the one of your last turn: that one stays with ${trackerWords(seen.name ?? '', seen.dataset?.name ?? null, now.dataset.name)}`);
  }
  return `Since your last turn the person changed what is shown: ${parts.join('; ')}. Read this history before relying on it; it is not the one your earlier replies spoke of.`;
}

/**
 * What changed in the history since `seen` (`historySeen` as the agent's last
 * turn ended), as one sentence for the model, or null when nothing did. On
 * the same tracker: its steps undone, removed, taken by others (by label);
 * another tracker shown (a session loaded beside, a saved state, another
 * dataset): which, where from, and its steps in effect (`switchSentence`).
 * `ownTurns`: the turns of the agent's conversation (or connection);
 * `conversation`: the conversation this message is in, when `seen` was
 * carried from another one (the chat followed the tracker shown).
 * @param {object|null} tree - the tracker shown now
 * @param {ReturnType<typeof historySeen>} seen
 * @param {Set<string>} ownTurns
 * @param {{conversation?: string|null}} [options]
 * @returns {string|null}
 */
export function historySinceSentence(tree, seen, ownTurns, options = {}) {
  if (!tree || !seen) return null;
  if (seen.tracker !== tree.id) return switchSentence(tree, seen, ownTurns, options);
  const nowSeen = historySeen(tree);
  const now = nowSeen.steps;
  const nowIds = new Set(now.map(step => step.id));
  const seenIds = new Set(seen.steps.map(step => step.id));
  const gone = seen.steps.filter(step => !nowIds.has(step.id));
  const came = now.filter(step => !seenIds.has(step.id));
  // Steps made since that are not in effect (taken on the branch the person then left).
  const offPath = [...tree.steps.values()]
    .filter(step => step.parent !== null && !nowIds.has(step.id) && stepNumber(step.id) >= seen.next)
    .map(seenStep);
  const switched = seen.branch !== null && nowSeen.branch !== null && seen.branch.id !== nowSeen.branch.id;
  if (gone.length === 0 && came.length === 0 && offPath.length === 0 && !switched) return null;
  const tip = tree.branches?.get?.(tree.activeBranch)?.tip ?? tree.headId;
  const branchName = step => {
    const id = tree.steps.get(step.id)?.branch;
    return tree.branches?.get?.(id)?.name ?? null;
  };
  const parts = [];
  if (switched) parts.push(`the branch shown is now ${quoteName(nowSeen.branch.name)} (it was ${quoteName(seen.branch.name)})`);
  for (const group of byAuthor(gone, ownTurns)) {
    const live = group.steps.filter(step => tree.steps.has(step.id));
    const undone = live.filter(step => onPathTo(tree, step.id, tip));
    const elsewhere = live.filter(step => !onPathTo(tree, step.id, tip));
    const removed = group.steps.filter(step => !tree.steps.has(step.id));
    if (undone.length > 0) parts.push(`${group.who} ${countNoun(undone.length, 'step')} ${labelList(undone)} ${countNoun(undone.length, 'was', 'were')} undone (kept for redo, no longer in effect)`);
    const onBranches = new Map();
    for (const step of elsewhere) {
      const name = branchName(step);
      if (!onBranches.has(name)) onBranches.set(name, []);
      onBranches.get(name).push(step);
    }
    for (const [name, steps] of onBranches) {
      parts.push(`${group.who} ${countNoun(steps.length, 'step')} ${labelList(steps)} ${countNoun(steps.length, 'stays', 'stay')} on ${name === null ? 'another branch' : `the branch ${quoteName(name)}`}, not in effect on the branch shown`);
    }
    if (removed.length > 0) parts.push(`${group.who} ${countNoun(removed.length, 'step')} ${labelList(removed)} ${countNoun(removed.length, 'was', 'were')} removed (to Recently deleted, no longer in effect)`);
  }
  // Taken by others while the last turn ran (`historySeen` `during`), then the steps made since.
  const during = new Set(seen.during ?? []);
  for (const group of byAuthor(came.filter(step => during.has(step.id)), ownTurns)) {
    parts.push(`${group.who} ${countNoun(group.steps.length, 'step')} ${labelList(group.steps)} ${countNoun(group.steps.length, 'was', 'were')} taken while your last turn ran and ${countNoun(group.steps.length, 'is', 'are')} in effect`);
  }
  for (const group of byAuthor(came.filter(step => !during.has(step.id)), ownTurns)) {
    parts.push(`${group.who} ${countNoun(group.steps.length, 'step')} ${labelList(group.steps)} ${countNoun(group.steps.length, 'is', 'are')} now in effect`);
  }
  for (const group of byAuthor(offPath, ownTurns)) {
    const names = [...new Set(group.steps.map(branchName))];
    parts.push(`${group.who} ${countNoun(group.steps.length, 'step')} ${labelList(group.steps)} ${countNoun(group.steps.length, 'was', 'were')} taken on ${names.length === 1 && names[0] !== null ? `the branch ${quoteName(names[0])}` : 'other branches'}, not the one shown`);
  }
  return `Since your last turn the history changed: ${parts.join('; ')}. Rely on the state as it is now, not on what your earlier replies said.`;
}
