/**
 * @fileoverview The branch map (History v2 §3.9, §3.10): the overview and
 * the bulk tool, so the sidebar stays compact. On the left, every branch as
 * a lane graph (the sidebar's graph with every branch expanded, the same
 * rows, keys and row rule: click selects, double-click shows, `›` details);
 * on the right, the table of branches (the graph's long description): name,
 * where it starts, its steps and last change, main and locked marked, a ⋯
 * menu each, and a checkbox each for Archive chosen and Delete chosen….
 * Choosing a table row selects its branch in the graph. A search narrows
 * the table; archived branches are listed when asked. On a phone the table
 * alone is shown.
 *
 * @module ui/modules/state/branch-map-dialog
 */

import { createGraph } from './graph.js';
import { formatAgo } from './model.js';
import { idNumber } from '../../../history/model.js';
import { wireAppDialog } from '../../components/app-dialog.js';
import { formatCountOf } from '../../../../utils/format-units.js';

/**
 * @param {object} options
 * @param {HTMLDialogElement} options.dialog
 * @param {() => import('./history-source.js').TrackerView|null} options.view
 * @param {object} options.ops - the panel's operations
 * @param {object} options.graphHandlers - the sidebar graph's handlers (shared)
 * @param {() => object} options.layoutOptions
 * @param {() => number} [options.now]
 */
export function createBranchMap({ dialog, view, ops, graphHandlers, layoutOptions, now = () => Date.now() }) {
  const doc = dialog.ownerDocument;
  const app = wireAppDialog(dialog);
  const controller = new AbortController();
  const { signal } = controller;
  const part = id => doc.getElementById(id);
  const filter = part('history-map-filter');
  const archived = part('history-map-archived');
  const rows = part('history-map-rows');
  const all = part('history-map-all');
  const status = part('history-map-status');
  const archive = part('history-map-archive');
  const remove = part('history-map-delete');
  const graphBox = part('history-map-graph');
  const where = doc.createElement('button');
  where.type = 'button';
  where.hidden = true;
  where.className = 'btn btn-compact history-where';
  graphBox.after(where);
  const graph = createGraph({ container: graphBox, where, handlers: graphHandlers, expandAll: true, now });
  const chosen = new Set();

  function shownBranches(current) {
    const words = filter.value.trim().toLowerCase();
    return current.branches().filter(branch => (archived.checked || !branch.archived)
      && (words === '' || branch.name.toLowerCase().includes(words)));
  }

  function draw() {
    if (!dialog.open) return;
    const current = view();
    if (current === null) {
      app.close();
      return;
    }
    graph.render(current, layoutOptions());
    for (const id of [...chosen]) if (current.branch(id) === undefined) chosen.delete(id);
    const list = shownBranches(current);
    rows.replaceChildren(...list.map(branch => {
      const own = current.ownSteps(branch.id);
      const tip = own[own.length - 1];
      const tr = doc.createElement('tr');
      tr.className = `lane-${branch.lane}`;
      tr.dataset.branch = branch.id;
      tr.dataset.archived = String(branch.archived);
      if (branch.id === current.activeBranch) tr.setAttribute('aria-current', 'true');
      const pickCell = doc.createElement('td');
      const pick = doc.createElement('input');
      pick.type = 'checkbox';
      pick.checked = chosen.has(branch.id);
      pick.setAttribute('aria-label', `Choose ${branch.name}`);
      pick.addEventListener('change', () => {
        if (pick.checked) chosen.add(branch.id);
        else chosen.delete(branch.id);
        writeActions(current);
      });
      pickCell.append(pick);
      const nameCell = doc.createElement('td');
      const name = doc.createElement('button');
      name.type = 'button';
      name.className = 'history-map-name';
      name.textContent = `${branch.name}${branch.id === current.mainBranch ? ' ★' : ''}${branch.locked ? ' 🔒' : ''}${branch.archived ? ' (archived)' : ''}`;
      name.title = 'Select it in the graph; double-click to show it';
      name.addEventListener('click', () => {
        if (!branch.archived) graph.reveal(branch.tip);
      });
      name.addEventListener('dblclick', () => ops.switchBranch(branch.id));
      nameCell.append(name);
      const from = doc.createElement('td');
      from.textContent = branch.base === null ? '—' : String(idNumber(branch.base));
      from.title = branch.base === null ? '' : current.step(branch.base)?.label ?? '';
      const steps = doc.createElement('td');
      steps.textContent = String(current.branchStepCount(branch.id));
      const last = doc.createElement('td');
      last.textContent = formatAgo(tip?.until ?? tip?.at ?? null, now()).short;
      const menuCell = doc.createElement('td');
      const more = doc.createElement('button');
      more.type = 'button';
      more.className = 'icon-btn';
      more.setAttribute('aria-label', `Branch “${branch.name}”: actions`);
      more.title = more.getAttribute('aria-label');
      more.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
      more.addEventListener('click', () => ops.branchMenu(branch.id, more));
      menuCell.append(more);
      tr.append(pickCell, nameCell, from, steps, last, menuCell);
      return tr;
    }));
    all.checked = list.length > 0 && list.every(branch => chosen.has(branch.id));
    all.indeterminate = !all.checked && list.some(branch => chosen.has(branch.id));
    const hidden = current.branches().filter(branch => branch.archived).length;
    status.textContent = `${formatCountOf(current.branches().length, 'branch', 'branches')}${hidden > 0 ? `, ${hidden} archived` : ''}.`;
    writeActions(current);
  }

  function writeActions(current) {
    const list = [...chosen].map(id => current.branch(id)).filter(Boolean);
    const deletable = list.filter(branch => branch.id !== current.mainBranch && !branch.locked);
    archive.disabled = list.length === 0 || list.every(branch => branch.id === current.mainBranch);
    archive.textContent = list.length > 0 && list.every(branch => branch.archived) ? 'Unarchive chosen' : 'Archive chosen';
    remove.disabled = deletable.length === 0;
    remove.title = list.length > deletable.length ? 'Main and locked branches are not deleted' : '';
  }

  filter.addEventListener('input', draw, { signal });
  archived.addEventListener('change', draw, { signal });
  all.addEventListener('change', () => {
    const current = view();
    if (current === null) return;
    for (const branch of shownBranches(current)) {
      if (all.checked) chosen.add(branch.id);
      else chosen.delete(branch.id);
    }
    draw();
  }, { signal });
  archive.addEventListener('click', async () => {
    const current = view();
    if (current === null) return;
    const list = [...chosen].map(id => current.branch(id)).filter(branch => branch && branch.id !== current.mainBranch);
    const to = !list.every(branch => branch.archived);
    for (const branch of list) await ops.archiveBranch(branch.id, to, { quiet: true });
    chosen.clear();
    draw();
  }, { signal });
  remove.addEventListener('click', async () => {
    const current = view();
    if (current === null) return;
    const list = [...chosen].filter(id => id !== current.mainBranch && !current.branch(id)?.locked);
    if (await ops.deleteBranches(list)) chosen.clear();
    draw();
  }, { signal });

  return {
    open(opener = null) {
      chosen.clear();
      filter.value = '';
      archived.checked = false;
      app.open(opener);
      draw();
    },
    refresh: draw,
    get isOpen() { return dialog.open; },
    close: () => app.close(),
    destroy() {
      controller.abort();
      graph.destroy();
      where.remove();
      app.destroy();
    },
  };
}
