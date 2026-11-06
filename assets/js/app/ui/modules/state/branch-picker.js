/**
 * @fileoverview The branch picker, opened from the status line's "Main ▾"
 * (History v2 §3.10): the tracker in use (its menu switches tracker, starts
 * another, renames or removes it), every branch that is not archived with
 * where it starts, its steps and its last change, main ★ and locked 🔒
 * marked, the one shown current; a ⋯ menu per branch; "N archived" to list
 * those too; a search once there are many; Map ⤢ for the branch map; and
 * "⑂ New branch from the step shown".
 *
 * A box under the status line (like the chat's settings), so it reads the
 * same on a phone. Choosing a branch shows it (its last step) and closes the
 * picker, as do Escape and a press outside it.
 *
 * @module ui/modules/state/branch-picker
 */

import { formatAgo } from './model.js';
import { idNumber } from '../../../history/model.js';
import { formatCountOf } from '../../../../utils/format-units.js';

/** Branches past which the picker offers a search. */
const SEARCH_FROM = 8;

/**
 * @param {object} options
 * @param {HTMLElement} options.box - `#history-branches`
 * @param {HTMLButtonElement} options.button - the status line's "Main ▾"
 * @param {object} options.ops - the panel's operations
 * @param {() => number} [options.now]
 */
export function createBranchPicker({ box, button, ops, now = () => Date.now() }) {
  const doc = box.ownerDocument;
  const controller = new AbortController();
  const { signal } = controller;
  let view = null;
  let trackers = [];
  let showArchived = false;
  let query = '';

  const head = doc.createElement('div');
  head.className = 'history-branches-head';
  const title = doc.createElement('span');
  title.className = 'history-branches-title';
  title.textContent = 'Branches';
  const tracker = doc.createElement('button');
  tracker.type = 'button';
  tracker.className = 'btn btn-compact history-tracker-btn';
  tracker.setAttribute('aria-haspopup', 'menu');
  const map = doc.createElement('button');
  map.type = 'button';
  map.className = 'btn btn-compact';
  map.textContent = 'Map ⤢';
  map.title = 'Every branch as a graph and a table';
  head.append(title, tracker, map);
  const search = doc.createElement('input');
  search.type = 'search';
  search.className = 'obs-select history-branches-search';
  search.placeholder = 'Find a branch';
  search.setAttribute('aria-label', 'Find a branch');
  search.autocomplete = 'off';
  search.spellcheck = false;
  const list = doc.createElement('ul');
  list.className = 'history-branch-list';
  list.setAttribute('aria-label', 'Branches');
  const archived = doc.createElement('button');
  archived.type = 'button';
  archived.className = 'btn btn-compact history-branches-archived';
  archived.setAttribute('aria-expanded', 'false');
  const add = doc.createElement('button');
  add.type = 'button';
  add.className = 'btn btn-compact history-branches-new';
  add.textContent = '⑂ Branch from the step shown';
  add.title = 'The next change starts a new branch from the step shown';
  box.replaceChildren(head, search, list, archived, add);

  /** Draw the list again, keeping focus on the button it was on (the list is rebuilt). */
  function draw() {
    if (view === null || box.hidden) return;
    const focused = list.contains(doc.activeElement)
      ? { branch: doc.activeElement.closest('[data-branch]')?.dataset.branch, more: doc.activeElement.classList.contains('history-branch-more') }
      : null;
    const active = trackers.filter(each => each.removed === null || each.removed === undefined);
    tracker.textContent = `${view.name} ▾`;
    tracker.setAttribute('aria-label', `Tracker ${view.name}: ${formatCountOf(active.length, 'tracker')} on this dataset`);
    const all = view.branches();
    const hidden = all.filter(branch => branch.archived);
    const words = query.trim().toLowerCase();
    const shown = all.filter(branch => (showArchived || !branch.archived)
      && (words === '' || branch.name.toLowerCase().includes(words)));
    search.hidden = all.length < SEARCH_FROM;
    const nowAt = now();
    const activeId = view.activeBranch;
    list.replaceChildren(...shown.map(branch => {
      const own = view.ownSteps(branch.id);
      const tip = own[own.length - 1] ?? view.step(branch.tip);
      const item = doc.createElement('li');
      item.className = `history-branch lane-${branch.lane}`;
      item.dataset.branch = branch.id;
      item.dataset.archived = String(branch.archived);
      const pick = doc.createElement('button');
      pick.type = 'button';
      pick.className = 'history-branch-pick';
      const dot = doc.createElement('span');
      dot.className = 'history-branch-dot';
      dot.setAttribute('aria-hidden', 'true');
      const name = doc.createElement('span');
      name.className = 'history-branch-name';
      name.textContent = `${branch.name}${branch.id === view.mainBranch ? ' ★' : ''}${branch.locked ? ' 🔒' : ''}`;
      const meta = doc.createElement('span');
      meta.className = 'history-branch-meta';
      const ago = formatAgo(tip?.until ?? tip?.at ?? null, nowAt);
      const from = branch.base === null ? '' : `from step ${idNumber(branch.base)} · `;
      meta.textContent = `${from}${formatCountOf(view.branchStepCount(branch.id), 'step')} · ${ago.short}`;
      pick.append(dot, name, meta);
      const current = branch.id === activeId;
      if (current) pick.setAttribute('aria-current', 'true');
      pick.setAttribute('aria-label', `${branch.name}${branch.id === view.mainBranch ? ', main' : ''}${branch.locked ? ', locked' : ''}${branch.archived ? ', archived' : ''}, ${from}${formatCountOf(view.branchStepCount(branch.id), 'step')}, last change ${ago.long}${current ? ', shown' : ''}`);
      pick.addEventListener('click', () => {
        setOpen(false);
        button.focus({ preventScroll: true });
        if (!current || view.headId !== branch.tip) ops.switchBranch(branch.id);
      });
      const more = doc.createElement('button');
      more.type = 'button';
      more.className = 'icon-btn history-branch-more';
      more.setAttribute('aria-label', `Branch “${branch.name}”: actions`);
      more.title = more.getAttribute('aria-label');
      more.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
      more.addEventListener('click', () => ops.branchMenu(branch.id, more));
      item.append(pick, more);
      return item;
    }));
    if (focused !== null) {
      const item = [...list.children].find(each => each.dataset.branch === focused.branch);
      (item?.querySelector(focused.more ? '.history-branch-more' : '.history-branch-pick') ?? list.querySelector('button') ?? search)?.focus({ preventScroll: true });
    }
    archived.hidden = hidden.length === 0;
    archived.textContent = `${showArchived ? '▾' : '▸'} ${formatCountOf(hidden.length, 'archived')}`;
    archived.setAttribute('aria-expanded', String(showArchived));
  }

  function setOpen(open) {
    box.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      draw();
      (list.querySelector('[aria-current="true"]') ?? list.querySelector('button'))?.focus({ preventScroll: true });
    }
  }

  button.addEventListener('click', () => setOpen(box.hidden), { signal });
  box.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      setOpen(false);
      button.focus();
    }
  }, { signal });
  search.addEventListener('input', () => { query = search.value; draw(); }, { signal });
  archived.addEventListener('click', () => {
    showArchived = !showArchived;
    draw();
    // Safari does not focus a clicked button: the picker keeps the focus, so Escape still closes it.
    archived.focus({ preventScroll: true });
  }, { signal });
  add.addEventListener('click', () => {
    const at = view?.headId ?? null;
    setOpen(false);
    button.focus({ preventScroll: true });
    ops.branchHere(at);
  }, { signal });
  // A press outside the picker closes it, as any popup; the menus it opens
  // (a branch's ⋯, the tracker's) and the dialogs over the page do not.
  doc.addEventListener('pointerdown', event => {
    if (box.hidden || !(event.target instanceof Node)) return;
    if (box.contains(event.target) || button.contains(event.target)) return;
    if (event.target instanceof Element && event.target.closest('.history-popup-menu, dialog[open]') !== null) return;
    setOpen(false);
  }, { signal, capture: true });
  map.addEventListener('click', () => ops.openMap(map), { signal });
  tracker.addEventListener('click', () => ops.trackerMenu(tracker), { signal });

  return {
    /**
     * @param {import('./history-source.js').TrackerView|null} next
     * @param {object[]} trackerList - the history's trackers
     */
    render(next, trackerList) {
      view = next;
      trackers = trackerList;
      button.disabled = view === null;
      if (view === null) {
        setOpen(false);
        return;
      }
      const branch = view.branch(view.activeBranch);
      const name = button.querySelector('.history-branch-name');
      const several = trackers.filter(each => each.removed === null || each.removed === undefined).length > 1;
      name.textContent = several ? `${view.name} · ${branch?.name ?? ''}` : branch?.name ?? '';
      button.setAttribute('aria-label', `Branch ${branch?.name ?? ''}${several ? ` of ${view.name}` : ''}: choose a branch`);
      draw();
    },
    open: () => setOpen(true),
    close: () => setOpen(false),
    destroy() {
      controller.abort();
      box.replaceChildren();
    },
  };
}
