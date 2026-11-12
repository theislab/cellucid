/**
 * @fileoverview Turns: one agent's or one notebook's turn as a record of
 * its tracker (History v2 §3.3.10, §3.12). A turn is made with its first
 * step (the dispatch's meta names it: `turn`, `turnLabel`, `agent`, `model`,
 * `conversation`, `message`), acts on one branch (where it started, or
 * where the agent switched to), and is undone as one: back to before it when
 * its steps are the last on the path shown, or, when someone else's steps
 * came in between, either everything since it started or only its own
 * steps. Pure data, no page.
 *
 * @module app/history/turns
 */

import { ActionRefused } from '../actions/dispatcher.js';
import { createOutsideAct, createTurn, HISTORY_SENTENCES } from './model.js';
import { branchOf, pathTo, stepOf } from './tree.js';

/** The `By` of a dispatch's meta (who acted), with the person's name only when they chose to record it. */
export function byOfMeta(meta, person = null) {
  const origin = meta.origin;
  const agent = origin === 'agent' ? meta.agent : null;
  const model = origin === 'agent' ? (meta.model ?? null) : null;
  const host = origin === 'host' ? (meta.host ?? null) : null;
  const turn = origin === 'agent' || origin === 'host' ? (meta.turn ?? null) : null;
  return { origin, agent, model, host, person: origin === 'user' ? person : null, turn };
}

/**
 * The refusal an agent's next dispatch gets when the person moved the history
 * to another branch during its turn (code `moved`), or null. A branch another
 * agent's step started (the head was not its branch's tip) is no move of the
 * person's: `personMovedSince(turnId)` says whether the person moved since
 * the turn's last step (or since its own undo or move).
 * @param {object} tracker
 * @param {{origin: string, turn: string|null}} meta
 * @param {(turnId: string) => boolean} [personMovedSince]
 */
export function bindingRefusal(tracker, meta, personMovedSince = () => true) {
  if (meta.origin !== 'agent' || meta.turn === null) return null;
  const turn = tracker.turns.get(meta.turn);
  if (turn === undefined || turn.branch === tracker.activeBranch || !tracker.branches.has(turn.branch)) return null;
  if (!personMovedSince(turn.id)) return null;
  const now = branchOf(tracker, tracker.activeBranch);
  return new ActionRefused(HISTORY_SENTENCES.moved({ name: now.name }), { code: 'moved' });
}

/**
 * Keep the turn a step belongs to: made with its first step (the label the
 * meta gives, else the step's), its end moved with every later one, its
 * branch where the step went.
 * @returns {object|null} the turn record, null for a step of no turn
 */
export function noteTurnStep(tracker, step, meta) {
  if (step.by.turn === null) return null;
  let turn = tracker.turns.get(step.by.turn);
  if (turn === undefined) {
    turn = createTurn({
      id: step.by.turn, by: { ...step.by }, label: meta.turnLabel ?? step.label,
      conversation: meta.conversation ?? null, message: meta.message ?? null, startedAt: step.at, branch: step.branch,
    });
    tracker.turns.set(turn.id, turn);
  } else {
    turn.endedAt = step.until ?? step.at;
    turn.branch = step.branch;
    if (turn.message === null && meta.message) turn.message = meta.message;
    if (turn.conversation === null && meta.conversation) turn.conversation = meta.conversation;
  }
  return turn;
}

/**
 * Keep what a turn did outside the state (an act that records no step and
 * that no undo takes back: a vote published, a file written) in its record,
 * the turn made with it when it has no step yet (on the branch shown).
 * @param {object} tracker
 * @param {{type: string, label: string, at: number|null}} act
 * @param {object} meta - the dispatch's meta (`by`: `byOfMeta`)
 * @param {object} by
 * @returns {object|null} the turn record, null for a dispatch of no turn
 */
export function noteTurnOutside(tracker, act, meta, by) {
  if (by.turn === null) return null;
  let turn = tracker.turns.get(by.turn);
  if (turn === undefined) {
    turn = createTurn({
      id: by.turn, by: { ...by }, label: meta.turnLabel ?? act.label,
      conversation: meta.conversation ?? null, message: meta.message ?? null, startedAt: act.at, branch: tracker.activeBranch,
    });
    tracker.turns.set(turn.id, turn);
  } else if (act.at !== null && (turn.endedAt === null || act.at > turn.endedAt)) {
    turn.endedAt = act.at;
  }
  turn.outside.push(createOutsideAct(act));
  return turn;
}

/**
 * What undoing `turnId` would do on the branch shown: its steps on the path
 * to the head, whether they are the last there (`contiguous`: back to before
 * its first, kept for redo), how many steps "everything since it started"
 * takes back, and the branches holding more of its steps.
 *
 * @returns {{turn: object, first: string|null, own: string[], since: number, contiguous: boolean,
 *   otherBranches: Array<{id: string, name: string}>}}
 */
export function turnUndoPlan(tracker, turnId) {
  const turn = tracker.turns.get(turnId);
  if (turn === undefined) {
    throw new ActionRefused(HISTORY_SENTENCES.noTurn({ turn: turnId, tracker: tracker.name, then: 'nothing to undo' }), { code: 'no-target' });
  }
  const path = pathTo(tracker, tracker.headId);
  const at = path.findIndex(step => step.by.turn === turnId);
  const own = at === -1 ? [] : path.slice(at).filter(step => step.by.turn === turnId).map(step => step.id);
  const onPath = new Set(path.map(step => step.id));
  const others = new Map();
  for (const step of tracker.steps.values()) {
    if (step.by.turn !== turnId || onPath.has(step.id)) continue;
    const branch = tracker.branches.get(step.branch);
    if (branch !== undefined) others.set(branch.id, { id: branch.id, name: branch.name });
  }
  return {
    turn,
    first: at === -1 ? null : path[at].id,
    own,
    since: at === -1 ? 0 : path.length - at,
    contiguous: at !== -1 && path.slice(at).every(step => step.by.turn === turnId),
    otherBranches: [...others.values()],
  };
}

/** The steps of each turn, `{inTree, onPath, last}`, read from the records (the chat's turn chips). */
export function turnFacts(tracker) {
  const out = new Map();
  if (!tracker) return out;
  for (const turn of tracker.turns.values()) out.set(turn.id, { inTree: 0, onPath: 0, last: null });
  for (const step of tracker.steps.values()) {
    const facts = step.by.turn === null ? undefined : out.get(step.by.turn);
    if (facts === undefined) continue;
    facts.inTree += 1;
    facts.last ??= step.id;
  }
  const seen = new Set();
  for (let step = stepOf(tracker, tracker.headId); ; step = stepOf(tracker, step.parent)) {
    const facts = step.by.turn === null ? undefined : out.get(step.by.turn);
    if (facts !== undefined) {
      facts.onPath += 1;
      if (!seen.has(step.by.turn)) { seen.add(step.by.turn); facts.last = step.id; }
    }
    if (step.parent === null) break;
  }
  return out;
}
