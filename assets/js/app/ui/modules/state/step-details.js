/**
 * @fileoverview The details a graph row opens with its `›` button (History
 * v2 §3.10): only the facts that apply, then the row's own actions.
 *
 * - **A step:** who acted (the agent and its model, the turn ↗), when, how
 *   long it took, its branch; why it is stale or flagged (with Run again
 *   when the action brings its result up to date: `rerun`);
 *   its code (⧉ copies it); what it changed (What changed › compares it with
 *   the step before); a squashed step's count and authors; Show this
 *   step's view (its camera, the history not moved); its notes; then
 *   Show, Branch here, Compare…, and ⋯ (Bookmark…, Revert, Branch without
 *   this step, Copy code, Delete…).
 * - **A branch** (a fork stub): where it starts, its steps, who made it,
 *   main or locked, its notes; Show, Rename…, Compare, ⋯.
 * - **A turn:** the agent, its model, what it was asked, when, its steps and
 *   summary; Undo turn, Merge into one step….
 * - **A group:** its steps by kind, who acted, when; its notes; Rename…,
 *   Ungroup, Merge into one step….
 * - **A folded run:** its steps by kind; Expand, Group…, Merge into one step….
 *
 * Every action is the panel's operation (`ops`), the same one its menu and
 * its key run. Values wrap; nothing is cut short.
 *
 * @module ui/modules/state/step-details
 */

import { outsideOfTurn } from '../../../agent/history-link.js';
import { outsideText } from '../../../agent/presence/activity.js';
import { authorOf, flagOf, formatStepTime, runLabel } from './model.js';
import { notesBlock } from './notes.js';
import { idNumber } from '../../../history/model.js';
import { parameterFacts } from '../../../history/exports/step-text.js';
import { formatCountOf } from '../../../../utils/format-units.js';

/**
 * @typedef {object} DetailsContext
 * @property {Document} doc
 * @property {import('./history-source.js').TrackerView} view
 * @property {(type: string, params: object) => Promise<unknown>} act - a history action
 * @property {object|null} catalog - the action catalogue (parameter schemas)
 * @property {(domain: string) => string} domainName
 * @property {() => number} now
 * @property {object} ops - the panel's operations (index.js)
 */

function fact(doc, label, value, className = '') {
  const row = doc.createElement('div');
  row.className = `history-detail-fact ${className}`.trim();
  const term = doc.createElement('span');
  term.className = 'history-detail-term';
  term.textContent = label;
  const body = doc.createElement('span');
  body.className = 'history-detail-value';
  if (value instanceof Node) body.append(value);
  else body.textContent = value;
  row.append(term, body);
  return row;
}

function button(doc, label, run, { title = null, disabled = false, primary = false, ariaLabel = null } = {}) {
  const element = doc.createElement('button');
  element.type = 'button';
  element.className = `btn btn-compact${primary ? ' btn-primary' : ''}`;
  element.textContent = label;
  if (title) element.title = title;
  if (ariaLabel) element.setAttribute('aria-label', ariaLabel);
  element.disabled = disabled;
  element.addEventListener('click', event => {
    event.stopPropagation();
    run(element);
  });
  return element;
}

function actions(doc, ...buttons) {
  const row = doc.createElement('div');
  row.className = 'history-detail-actions';
  row.append(...buttons.filter(Boolean));
  return row;
}

function line(doc, text, className = 'history-detail-line') {
  const p = doc.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}

/**
 * The details of `row`.
 * @param {import('./graph-layout.js').GraphRow} row
 * @param {DetailsContext} context
 * @returns {HTMLElement}
 */
export function detailsFor(row, context) {
  const root = context.doc.createElement('div');
  switch (row.kind) {
    case 'step': root.append(...stepDetails(row, context)); break;
    case 'fork': root.append(...branchDetails(row, context)); break;
    case 'turn': root.append(...turnDetails(row, context)); break;
    case 'group': root.append(...groupDetails(row, context)); break;
    case 'run': root.append(...runDetails(row, context)); break;
    default: break;
  }
  return root;
}

function byLine(doc, by, type, { turn = null, ops }) {
  const author = authorOf(by, type);
  const span = doc.createElement('span');
  span.textContent = by?.origin === 'agent' && by.model ? `${author.name} (${by.model})` : author.name;
  if (turn !== null && ops.canOpenChat(turn)) {
    span.append(' · ');
    span.append(button(doc, 'turn ↗', () => ops.openChat(turn), { ariaLabel: 'Show this turn in the chat' }));
  }
  return span;
}

function stepDetails(row, { doc, view, act, catalog, domainName, now, ops }) {
  const step = row.step;
  const out = [];
  if (step.parent !== null) out.push(fact(doc, 'By', byLine(doc, step.by, step.type, { turn: step.by?.turn ?? null, ops })));
  const when = [formatStepTime(step.at, now())];
  if (step.merged > 1) when.push(`${step.merged} changes`);
  if (Number.isFinite(step.ms) && step.ms >= 100) when.push(`took ${(step.ms / 1000).toFixed(step.ms >= 10_000 ? 0 : 1)} s`);
  when.push(`branch ${view.branch(step.branch)?.name ?? step.branch}`);
  out.push(fact(doc, 'When', when.join(' · ')));
  if (row.stale !== null) {
    const cause = row.stale.cause === null ? 'the result no longer matches its inputs'
      : `step ${idNumber(row.stale.cause.id)} (“${row.stale.cause.label}”)`;
    const changed = row.stale.inputs.map(input => (input === 'history' ? 'the branch it shows moved on' : `${domainName(input)} changed`));
    const box = doc.createElement('div');
    box.className = 'history-detail-warning';
    box.append(line(doc, `⚠ Stale since ${cause}${changed.length > 0 ? `: ${changed.join(', ')}.` : '.'}`));
    // Only an action whose dispatch again brings this result up to date
    // (`rerun` in the catalogue); another adds a second of what it made, or
    // changes nothing.
    if (step.type !== null && catalog?.has?.(step.type) && catalog.get(step.type).rerun) {
      box.append(button(doc, 'Run again', () => ops.runAgain(step), { title: 'Bring this result up to date with what it reads now, as a new step' }));
    }
    out.push(box);
  }
  const flag = flagOf(step);
  if (flag !== null) out.push(line(doc, `⚠ ${flag.text}`, 'history-detail-warning'));
  if (step.kind === 'squashed') {
    const sq = step.squashed;
    const who = (sq?.by ?? []).map(each => authorOf(each, null).name);
    out.push(fact(doc, 'Stands for', sq?.cause === 'paused' ? 'Changes made while recording was paused'
      : sq?.cause === 'share' ? 'A state shared without its history'
        : `${formatCountOf(sq?.count ?? 0, 'step')} merged into one${who.length > 0 ? `, by ${[...new Set(who)].join(', ')}` : ''}`));
  }
  if (step.code) {
    const code = doc.createElement('span');
    const text = doc.createElement('code');
    text.textContent = step.code;
    code.append(text, ' ', button(doc, '⧉', () => ops.copyCode(step), { ariaLabel: 'Copy the code', title: 'Copy the code' }));
    out.push(fact(doc, 'Code', code, 'history-detail-code'));
  } else if (step.kind === 'action' || step.kind === 'outside') {
    const definition = step.type !== null && catalog?.has?.(step.type) ? catalog.get(step.type) : null;
    for (const each of parameterFacts(step.params ?? {}, definition?.params ?? null)) out.push(fact(doc, each.label, each.value));
  }
  if (step.touches.length > 0) {
    const changed = doc.createElement('span');
    changed.append(step.touches.map(domainName).join(', '), ' ');
    changed.append(button(doc, 'What changed ›', () => ops.whatChanged(step), { title: 'Compare the state before and after this step' }));
    out.push(fact(doc, 'Changed', changed));
  } else if (step.parent !== null && step.kind !== 'squashed') {
    out.push(fact(doc, 'Changed', step.reason ?? 'Nothing'));
  }
  if (step.bookmark) out.push(fact(doc, 'Bookmark', `★ ${step.bookmark}`));
  // Its camera, as the step kept it, without moving the history (§3.15.5:
  // applied even while camera moves are not recorded, as it is asked for).
  if (ops.canShowView()) {
    out.push(fact(doc, 'View', button(doc, 'Show this step’s view', () => ops.showView(step), {
      title: 'Put the camera where it was at this step; nothing else changes',
    })));
  }
  const notes = doc.createElement('div');
  notes.className = 'history-detail-notes';
  notes.append(notesBlock({ doc, notes: step.notes ?? [], target: { step: step.id }, act, now }));
  out.push(fact(doc, 'Notes', notes));
  const shown = view.headId === step.id;
  out.push(actions(doc,
    button(doc, shown ? 'Shown' : 'Show', () => ops.show(row), { disabled: shown, primary: !shown }),
    button(doc, 'Branch here', () => ops.branchHere(step.id), { title: 'The next change starts a new branch from this step' }),
    button(doc, 'Compare…', () => ops.compare(step.id)),
    button(doc, '⋯', anchor => ops.stepMenu(row, anchor), { ariaLabel: `More for step ${idNumber(step.id)}` }),
  ));
  return out;
}

function branchDetails(row, { doc, view, act, now, ops }) {
  const branch = row.branch;
  const base = view.step(row.base);
  const out = [];
  out.push(fact(doc, 'From', base === undefined ? '—' : `step ${idNumber(base.id)}, “${base.label}”`));
  out.push(fact(doc, 'Steps', `${formatCountOf(row.count, 'step')}${row.continues ? ' after the fork' : ''}, last change ${formatStepTime(row.last, now())}`));
  out.push(fact(doc, 'By', authorOf(branch.by, null).name));
  const flags = [branch.id === view.mainBranch ? '★ Main' : null, branch.locked ? '🔒 Locked' : null].filter(Boolean);
  if (flags.length > 0) out.push(fact(doc, 'Is', flags.join(' · ')));
  const notes = doc.createElement('div');
  notes.append(notesBlock({ doc, notes: branch.notes ?? [], target: { branch: branch.id }, act, now }));
  out.push(fact(doc, 'Notes', notes));
  out.push(actions(doc,
    button(doc, 'Show', () => ops.show(row), { primary: true, title: 'Show its last step and continue on it' }),
    button(doc, 'Rename…', () => ops.renameBranch(branch.id), { disabled: branch.locked, title: branch.locked ? 'Unlock it first' : '' }),
    button(doc, 'Compare', () => ops.compareBranch(branch.id), { title: 'Its last step beside the shown one, in kept views' }),
    button(doc, '⋯', anchor => ops.branchMenu(branch.id, anchor), { ariaLabel: `More for branch “${branch.name}”` }),
  ));
  return out;
}

function turnDetails(row, { doc, view, act, now, ops }) {
  const out = [];
  const turn = row.turn;
  out.push(fact(doc, 'By', byLine(doc, row.by, null, { turn: row.turnId, ops })));
  if (turn?.label) out.push(fact(doc, 'Asked', turn.label));
  out.push(fact(doc, 'When', `${formatStepTime(row.first, now())}–${formatStepTime(row.last, now())} · ${formatCountOf(row.count, 'step')}`));
  // What it did outside the state (a vote published, a file written): no step, and Undo turn leaves it done.
  const outside = outsideText(outsideOfTurn(turn));
  if (outside !== null) {
    out.push(fact(doc, 'Outside', `${outside}, not undoable: ${(turn.outside ?? []).map(act => `“${act.label}”`).join(', ')}`));
  }
  if (turn !== null) {
    const notes = doc.createElement('div');
    notes.append(notesBlock({ doc, notes: turn.notes ?? [], target: { turn: turn.id }, act, now, addLabel: 'Summary' }));
    out.push(fact(doc, 'Summary', notes));
  }
  const undone = row.position === 'undone';
  out.push(actions(doc,
    button(doc, undone ? 'Undone' : 'Undo turn', () => ops.undoTurn(row.turnId), { disabled: undone || row.position === null }),
    button(doc, 'Merge into one step…', () => ops.squash(row.stepIds[0], row.stepIds[row.stepIds.length - 1]), { disabled: row.count < 2 }),
  ));
  return out;
}

function kinds(view, stepIds, domainName) {
  const counts = new Map();
  for (const id of stepIds) {
    const step = view.step(id);
    const name = step?.touches?.[0] === undefined ? 'Other' : domainName(step.touches[0]);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => (count === 1 ? name : `${name} ×${count}`)).join(' · ');
}

function authors(view, stepIds) {
  return [...new Set(stepIds.map(id => authorOf(view.step(id)?.by ?? null, view.step(id)?.type ?? null).name))].join(', ');
}

function groupDetails(row, { doc, view, act, now, domainName, ops }) {
  const group = row.group;
  const out = [];
  out.push(fact(doc, 'Steps', `${formatCountOf(row.count, 'step')}: ${kinds(view, row.stepIds, domainName)}`));
  out.push(fact(doc, 'By', authors(view, row.stepIds)));
  out.push(fact(doc, 'When', `${formatStepTime(row.first, now())}–${formatStepTime(row.last, now())}`));
  if (row.forksInside > 0) out.push(fact(doc, 'Branches', `⑂ ${formatCountOf(row.forksInside, 'branch', 'branches')} start inside`));
  const notes = doc.createElement('div');
  notes.append(notesBlock({ doc, notes: group.notes ?? [], target: { group: group.id }, act, now }));
  out.push(fact(doc, 'Notes', notes));
  out.push(actions(doc,
    button(doc, 'Show last step', () => ops.show(row)),
    button(doc, 'Rename…', () => ops.renameGroup(group.id)),
    button(doc, 'Ungroup', () => ops.ungroup(group.id)),
    button(doc, 'Merge into one step…', () => ops.squash(row.stepIds[0], row.stepIds[row.stepIds.length - 1]), { disabled: row.count < 2 }),
  ));
  return out;
}

function runDetails(row, { doc, view, domainName, now, ops }) {
  const out = [];
  out.push(fact(doc, 'Steps', `${formatCountOf(row.count, 'step')}: ${row.filtered ? 'not matching the search' : kinds(view, row.stepIds, domainName)}`));
  out.push(fact(doc, 'When', `${formatStepTime(row.first, now())}–${formatStepTime(row.last, now())}`));
  if (!row.filtered) out.push(line(doc, `${runLabel(row)}: folded for reading. Undo still goes step by step.`, 'history-detail-hint'));
  out.push(actions(doc,
    button(doc, row.expanded ? 'Fold' : 'Expand', () => ops.toggleRow(row)),
    button(doc, 'Group…', () => ops.group(row.stepIds[0], row.stepIds[row.stepIds.length - 1])),
    button(doc, 'Merge into one step…', () => ops.squash(row.stepIds[0], row.stepIds[row.stepIds.length - 1]), { disabled: row.count < 2 }),
  ));
  return out;
}
