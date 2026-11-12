/**
 * @fileoverview Share this history (History v2 §3.10, §3.11, §3.15.3): what
 * the session file holds, chosen, never total.
 *
 * - **Share:** the History (the trackers and branches ticked; by default
 *   every tracker with its main branch and the branch it shows, archived
 *   ones not), the Current state only (one
 *   step, "Shared state": no notes, conversations, agents or times), or the
 *   Steps only (a replay plan for any dataset: no cells, no values).
 * - **Include:** notes and bookmarks (on), conversations (off; how many there
 *   are), Recently deleted (off).
 * - **Results** (analysis results kept, or computed again on open), **Times**
 *   (exact, dates, none) and **Dataset** (its name and where it opens, or
 *   its name only).
 *
 * The summary line counts what the file will hold, and What's inside lists
 * each kind of content with its count: the privacy statement made concrete.
 * Save file is `history.share` with these choices (the core writes the file).
 *
 * @module ui/modules/state/share-dialog
 */

import { authorOf } from './model.js';
import { wireAppDialog } from '../../components/app-dialog.js';
import { setControlAvailability } from '../../core/control-availability.js';
import { createSegmented } from '../../components/controls.js';
import { formatCountOf } from '../../../../utils/format-units.js';

/** The dialog's four choices: the name the core reads, its label, its options (value, words). */
const CHOICES = Object.freeze({
  content: { label: 'Share', options: [['history', 'History'], ['state', 'Current state'], ['steps', 'Steps only']] },
  results: { label: 'Results', options: [['include', 'Include'], ['recompute', 'Compute on open']] },
  times: { label: 'Times', options: [['exact', 'Exact'], ['dates', 'Dates'], ['none', 'None']] },
  source: { label: 'Dataset', options: [['full', 'Name and where'], ['name', 'Name only']] },
});

const CONTENT_NOTES = Object.freeze({
  history: 'The chosen branches with every value: it opens as it is on this dataset.',
  state: 'Only what is shown now, as one step: the receiver sees the state, without how you got there.',
  steps: 'The steps without cells or values: a replay plan for any dataset.',
});

/**
 * @param {object} options
 * @param {HTMLDialogElement} options.dialog
 * @param {(type: string, params: object) => Promise<unknown>} options.act
 * @param {() => object|null} options.history - the history shown
 * @param {(view: object) => import('./history-source.js').TrackerView} options.viewOf
 * @param {(step: object) => boolean} options.isResult - an analysis result
 * @param {(text: string, tone?: string) => void} options.notify
 */
export function createShareDialog({ dialog, act, history, viewOf, isResult, notify }) {
  const doc = dialog.ownerDocument;
  const app = wireAppDialog(dialog);
  const controller = new AbortController();
  const { signal } = controller;
  const part = id => doc.getElementById(id);
  const branchesBox = part('history-share-branches');
  const include = part('history-share-include');
  const notes = part('history-share-notes');
  const chats = part('history-share-chats');
  const chatsRow = part('history-share-chats-row');
  const chatsLabel = part('history-share-chats-label');
  const journal = part('history-share-journal');
  const note = part('history-share-content-note');
  const summary = part('history-share-summary');
  const inside = part('history-share-inside');
  const insideButton = part('history-share-inside-btn');
  const save = part('history-share-save');
  let trackers = [];
  /** tracker id → Set of branch ids ticked */
  let ticked = new Map();
  let timesChosen = false;

  /** name → {root, setValue} of each choice's segmented control, and the value chosen. */
  const choices = {};
  const values = {};
  for (const [name, { label, options }] of Object.entries(CHOICES)) {
    const control = createSegmented({
      label,
      options: options.map(([value, words]) => ({ value, label: words })),
      value: options[0][0],
      onChange: value => {
        values[name] = value;
        if (name === 'times') timesChosen = true;
        write();
      },
    });
    values[name] = options[0][0];
    dialog.querySelector(`[data-share-choice="${name}"]`).replaceChildren(control.root);
    choices[name] = control;
  }
  const choice = name => values[name];
  function choose(name, value) {
    values[name] = value;
    choices[name].setValue(value);
  }

  /** Draw the tracker and branch boxes again, keeping focus on the box it was on. */
  function drawBranches() {
    const focused = branchesBox.contains(doc.activeElement) ? doc.activeElement.dataset.key : undefined;
    const nodes = [];
    for (const { view } of trackers) {
      const box = doc.createElement('div');
      box.className = 'history-share-tracker';
      const head = doc.createElement('label');
      head.className = 'checkbox-inline history-share-tracker-name';
      const all = doc.createElement('input');
      all.type = 'checkbox';
      all.dataset.key = view.id;
      const chosen = ticked.get(view.id) ?? new Set();
      const own = view.branches().filter(branch => !branch.archived || chosen.has(branch.id));
      all.checked = chosen.size > 0;
      all.indeterminate = chosen.size > 0 && chosen.size < own.length;
      all.addEventListener('change', () => {
        ticked.set(view.id, all.checked ? new Set([view.mainBranch, view.activeBranch]) : new Set());
        drawBranches();
        write();
      });
      head.append(all, ` ${view.name}${view.tracker.start?.kind === 'replay' ? ' (a replay)' : ''}`);
      const list = doc.createElement('div');
      list.className = 'history-share-branch-list';
      for (const branch of own) {
        const label = doc.createElement('label');
        label.className = 'checkbox-inline';
        const box2 = doc.createElement('input');
        box2.type = 'checkbox';
        box2.dataset.key = `${view.id} ${branch.id}`;
        box2.checked = chosen.has(branch.id);
        box2.addEventListener('change', () => {
          const set = new Set(ticked.get(view.id) ?? []);
          if (box2.checked) set.add(branch.id);
          else set.delete(branch.id);
          ticked.set(view.id, set);
          drawBranches();
          write();
        });
        label.append(box2, ` ${branch.name}${branch.id === view.mainBranch ? ' ★' : ''}`);
        list.append(label);
      }
      box.append(head, list);
      nodes.push(box);
    }
    branchesBox.replaceChildren(...nodes);
    if (focused !== undefined) [...branchesBox.querySelectorAll('input')].find(input => input.dataset.key === focused)?.focus({ preventScroll: true });
  }

  /** What the file would hold, counted from the records chosen. */
  function counts() {
    const content = choice('content');
    const out = { steps: 0, branches: 0, results: 0, notes: 0, bookmarks: 0, chats: 0, agents: new Set(), people: new Set(), trackers: 0 };
    for (const { view } of trackers) {
      const chosen = content === 'state' ? (view.id === trackers[0].view.id ? new Set([view.activeBranch]) : new Set()) : ticked.get(view.id) ?? new Set();
      if (chosen.size === 0) continue;
      out.trackers += 1;
      out.branches += chosen.size;
      out.chats += view.chatCount;
      const seen = new Set();
      for (const id of chosen) {
        for (const step of [...pathSteps(view, view.branch(id)?.tip)]) {
          if (seen.has(step.id)) continue;
          seen.add(step.id);
          if (step.parent !== null) out.steps += 1;
          if (isResult(step)) out.results += 1;
          out.notes += step.notes?.length ?? 0;
          if (step.bookmark) out.bookmarks += 1;
          if (step.by?.origin === 'agent') out.agents.add(authorOf(step.by, null).badge);
          if (step.by?.person) out.people.add(step.by.person);
        }
      }
    }
    if (content === 'state') return { ...out, steps: 1, branches: 1, trackers: 1, notes: 0, bookmarks: 0, agents: new Set(), people: new Set() };
    return out;
  }

  function* pathSteps(view, tipId) {
    for (let at = view.step(tipId); at !== undefined; at = at.parent === null ? undefined : view.step(at.parent)) yield at;
  }

  function write() {
    const content = choice('content');
    const state = content === 'state';
    const steps = content === 'steps';
    note.textContent = CONTENT_NOTES[content];
    include.hidden = state;
    for (const input of [notes, chats, journal]) {
      setControlAvailability(input, state ? 'Current state shares what is shown now, without its steps; choose History to include them' : null);
    }
    for (const button of choices.results.root.querySelectorAll('.segmented-btn')) button.disabled = steps;
    if (steps) choose('results', 'recompute');
    if (!timesChosen) choose('times', state ? 'none' : 'exact');
    const n = counts();
    chatsRow.hidden = n.chats === 0 && !state;
    chatsLabel.textContent = n.chats === 0 ? 'Conversations' : `Conversations (${n.chats})`;
    const nothing = !state && n.branches === 0;
    save.disabled = nothing;
    summary.textContent = nothing ? 'Choose a branch to share.'
      : [formatCountOf(n.steps, 'step'), formatCountOf(n.branches, 'branch', 'branches'),
        n.results > 0 && choice('results') === 'include' ? formatCountOf(n.results, 'result') : null,
        n.trackers > 1 ? formatCountOf(n.trackers, 'tracker') : null].filter(Boolean).join(' · ');
    summary.dataset.tone = nothing ? 'warning' : 'muted';
    if (!inside.hidden) writeInside(n);
  }

  function writeInside(n = counts()) {
    const content = choice('content');
    const yes = (on, what) => (on ? what : 'Not included');
    const rows = [
      ['Steps', content === 'steps' ? `${n.steps}, without cells or values` : String(n.steps)],
      ['Branches', String(n.branches)],
      ['Cell sets and values', content === 'steps' ? 'Not included' : 'The cells of every filter, label and highlight'],
      ['Analysis results', content === 'steps' || choice('results') === 'recompute' ? 'Computed again on open' : String(n.results)],
      ['Notes and bookmarks', content === 'state' ? 'Not included' : yes(notes.checked, `${formatCountOf(n.notes, 'note')}, ${formatCountOf(n.bookmarks, 'bookmark')}`)],
      ['Conversations', content === 'state' ? 'Not included' : yes(chats.checked, String(n.chats))],
      ['Agents and models', content === 'state' || n.agents.size === 0 ? 'None' : [...n.agents].join(', ')],
      ['Names of people', n.people.size === 0 ? 'None' : [...n.people].join(', ')],
      ['Recently deleted', content === 'state' ? 'Not included' : yes(journal.checked, 'Included')],
      ['Times', { exact: 'Exact', dates: 'Dates only', none: 'None' }[choice('times')]],
      ['The dataset', choice('source') === 'full' ? 'Its name and where it opens (file name, link or server)' : 'Its name only'],
    ];
    const table = doc.createElement('table');
    table.className = 'history-share-inside-table';
    const body = doc.createElement('tbody');
    for (const [kind, value] of rows) {
      const tr = doc.createElement('tr');
      const th = doc.createElement('th');
      th.scope = 'row';
      th.textContent = kind;
      const td = doc.createElement('td');
      td.textContent = value;
      tr.append(th, td);
      body.append(tr);
    }
    table.append(body);
    inside.replaceChildren(table);
  }

  for (const input of [notes, chats, journal]) input.addEventListener('change', write, { signal });
  insideButton.addEventListener('click', () => {
    inside.hidden = !inside.hidden;
    insideButton.setAttribute('aria-expanded', String(!inside.hidden));
    if (!inside.hidden) writeInside();
  }, { signal });

  save.addEventListener('click', async () => {
    const content = choice('content');
    const params = {
      content,
      results: choice('results'),
      times: choice('times'),
      source: choice('source'),
    };
    if (content !== 'state') {
      params.include = trackers.filter(({ view }) => (ticked.get(view.id)?.size ?? 0) > 0)
        .map(({ view }) => ({ tracker: view.id, branches: [...ticked.get(view.id)] }));
      params.notes = notes.checked;
      params.chats = chats.checked;
      params.journal = journal.checked;
    }
    save.disabled = true;
    try {
      // A failure was told once by the panel (no outcome); a file not written
      // (the person closed the save picker) names none. Either way the
      // dialog stays, with the choices made.
      const outcome = await act('history.share', params);
      if (typeof outcome?.file !== 'string' || outcome.file.length === 0) return;
      app.close();
      notify(`Saved ${outcome.file}.`, 'success');
    } finally {
      save.disabled = false;
    }
  }, { signal });

  return {
    /** @param {HTMLElement|null} [opener] */
    open(opener = null) {
      const current = history();
      if (current?.active == null) return;
      const shown = viewOf(current);
      const others = (current.trackers?.() ?? []).filter(each => each.id !== shown.id && (each.removed ?? null) === null);
      trackers = [{ view: shown }, ...others.map(each => ({ view: viewOf({ active: each }) }))];
      // Every tracker, each with its main branch and the branch it shows.
      ticked = new Map(trackers.map(({ view }) => [view.id, new Set([view.mainBranch, view.activeBranch])]));
      timesChosen = false;
      choose('content', 'history');
      choose('results', 'include');
      choose('times', 'exact');
      choose('source', 'full');
      notes.checked = true;
      chats.checked = false;
      journal.checked = false;
      inside.hidden = true;
      insideButton.setAttribute('aria-expanded', 'false');
      drawBranches();
      write();
      app.open(opener);
    },
    close: () => app.close(),
    destroy() {
      controller.abort();
      app.destroy();
    },
  };
}
