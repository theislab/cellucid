/**
 * @fileoverview A picker of the groups (categories) of a field: a summary
 * button ("All 25 groups", "Alpha, Beta", "12 of 25 groups") that opens a searchable
 * checklist with each group's cell count, All / None / Invert, and a
 * `small` flag on groups under the analysis's minimum.
 *
 * The checklist lives in the top layer (the Popover API), so no window or
 * scrolling panel clips it; on a phone (≤ 720 px) the stylesheet shows it as
 * a bottom sheet. It lists any number of groups: only the rows in view are
 * built.
 *
 * Value: `{ mode: 'all' }` or `{ mode: 'subset', ids: [...] }` (the
 * `groups` option kind of `options/option-schema.js`). Every group checked
 * is `all`.
 *
 * @module analysis/ui/components/group-picker
 */

import { createDomId } from '../../../ui/components/dom-id.js';
import { formatCount, formatCountOf } from '../../../../utils/format-units.js';

const ROW_HEIGHT_PX = 28;
const OVERSCAN_ROWS = 8;

/**
 * @param {object} options
 * @param {string} options.label - What is picked ("Groups to test"); the
 *   panel's accessible name.
 * @param {Array<{id: string, name: string, count: number, color?: string}>} options.groups
 * @param {{mode: 'all'}|{mode: 'subset', ids: string[]}} [options.value]
 * @param {number|null} [options.minCells] - Groups with fewer cells are
 *   flagged `small`
 * @param {string} [options.noun='groups']
 * @param {(value: object) => void} [options.onChange]
 * @returns {{ root: HTMLDivElement, toggle: HTMLButtonElement, getValue: () => object,
 *   setValue: (value: object) => void, setGroups: (groups: object[], minCells?: number|null) => void,
 *   open: () => void, close: () => void, destroy: () => void }}
 */
export function createGroupPicker({
  label,
  groups: initialGroups,
  value: initialValue = { mode: 'all' },
  minCells: initialMinCells = null,
  noun = 'groups',
  onChange = null,
}) {
  if (typeof label !== 'string' || label.length === 0) throw new TypeError('A group picker needs its label');
  if (onChange !== null && typeof onChange !== 'function') throw new TypeError('Group picker onChange must be a function');

  let groups = [];
  let minCells = null;
  /** @type {Set<string>} */
  let checked = new Set();
  /**
   * "Every group" as its own intent: it holds while the groups are not known
   * yet (loading) and whatever groups arrive, until the user unchecks one.
   */
  let all = initialValue?.mode !== 'subset';
  let filtered = [];
  const abort = new AbortController();
  const { signal } = abort;

  const root = document.createElement('div');
  root.className = 'group-picker';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'obs-select group-picker-toggle';
  const panelId = createDomId('group-picker');
  toggle.setAttribute('aria-haspopup', 'dialog');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', panelId);
  root.appendChild(toggle);

  const panel = document.createElement('div');
  panel.className = 'group-picker-panel';
  panel.id = panelId;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', label);
  panel.setAttribute('popover', 'auto');

  const grip = document.createElement('div');
  grip.className = 'group-picker-grip';
  grip.setAttribute('aria-hidden', 'true');

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'obs-select group-picker-search';
  search.placeholder = `Search ${noun}`;
  search.setAttribute('aria-label', `Search ${noun}`);
  search.autocomplete = 'off';

  const actions = document.createElement('div');
  actions.className = 'group-picker-actions';
  const actionButton = (text, onClick) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'analysis-link-btn';
    button.textContent = text;
    button.addEventListener('click', onClick, { signal });
    actions.appendChild(button);
    return button;
  };

  const summary = document.createElement('p');
  summary.className = 'group-picker-summary';
  summary.setAttribute('role', 'status');
  summary.setAttribute('aria-live', 'polite');

  const list = document.createElement('div');
  list.className = 'group-picker-list';
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', label);
  list.tabIndex = -1;
  const topSpacer = document.createElement('div');
  const bottomSpacer = document.createElement('div');
  const rows = document.createElement('div');
  list.append(topSpacer, rows, bottomSpacer);

  const footer = document.createElement('div');
  footer.className = 'group-picker-footer';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'btn btn-compact';
  done.textContent = 'Done';
  footer.appendChild(done);

  panel.append(grip, search, actions, summary, list, footer);
  root.appendChild(panel);

  const readValue = () => {
    if (all) return { mode: 'all' };
    // Ids kept while the groups are still unknown are not dropped.
    const ids = groups.length === 0
      ? [...checked]
      : groups.filter(group => checked.has(group.id)).map(group => group.id);
    return { mode: 'subset', ids };
  };

  /** After a manual change: every group checked is "all" again. */
  const settleAll = () => {
    all = groups.length > 0 && groups.every(group => checked.has(group.id));
  };

  const updateSummary = () => {
    const total = groups.length;
    const count = groups.filter(group => checked.has(group.id)).length;
    const chosen = groups.filter(group => checked.has(group.id));
    // One or two groups are named; more are counted.
    toggle.textContent = count === total
      ? `All ${formatCount(total)} ${noun}`
      : count > 0 && count <= 2
        ? chosen.map(group => group.name).join(', ')
        : `${formatCount(count)} of ${formatCount(total)} ${noun}`;
    toggle.title = count > 0 && count < total ? chosen.map(group => group.name).join(', ') : '';
    const small = minCells === null ? 0 : groups.filter(group => group.count < minCells).length;
    const smallText = small > 0 ? ` · ${formatCount(small)} small` : '';
    summary.textContent = `${formatCount(count)} of ${formatCount(total)} selected${smallText}`;
  };

  const emit = () => {
    settleAll();
    updateSummary();
    onChange?.(readValue());
  };

  const buildRow = group => {
    const row = document.createElement('label');
    row.className = 'group-picker-row';
    row.dataset.groupId = group.id;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked.has(group.id);
    box.dataset.groupId = group.id;
    const swatch = document.createElement('span');
    swatch.className = 'group-picker-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    if (group.color) swatch.style.background = group.color;
    const name = document.createElement('span');
    name.className = 'group-picker-name';
    name.textContent = group.name;
    name.title = group.name;
    const count = document.createElement('span');
    count.className = 'group-picker-count';
    count.textContent = formatCount(group.count);
    row.append(box, swatch, name, count);
    if (minCells !== null && group.count < minCells) {
      const flag = document.createElement('span');
      flag.className = 'analysis-chip analysis-chip-warning';
      flag.textContent = 'small';
      flag.title = `Fewer than ${formatCountOf(minCells, 'cell')}`;
      row.appendChild(flag);
    }
    return row;
  };

  let renderedStart = -1;
  let renderedEnd = -1;
  const renderWindow = (force = false) => {
    const viewport = list.clientHeight || ROW_HEIGHT_PX * 10;
    const start = Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT_PX) - OVERSCAN_ROWS);
    const end = Math.min(filtered.length, Math.ceil((list.scrollTop + viewport) / ROW_HEIGHT_PX) + OVERSCAN_ROWS);
    if (!force && start === renderedStart && end === renderedEnd) return;
    renderedStart = start;
    renderedEnd = end;
    topSpacer.style.height = `${start * ROW_HEIGHT_PX}px`;
    bottomSpacer.style.height = `${(filtered.length - end) * ROW_HEIGHT_PX}px`;
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index++) fragment.appendChild(buildRow(filtered[index]));
    rows.replaceChildren(fragment);
    if (filtered.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = groups.length === 0 ? `No ${noun}.` : 'No matches.';
      rows.appendChild(empty);
    }
  };

  const filterGroups = () => {
    const query = search.value.trim().toLowerCase();
    filtered = query.length === 0
      ? groups
      : groups.filter(group => group.name.toLowerCase().includes(query));
  };
  /** A new search starts at the top of its matches. */
  const applyFilter = () => {
    filterGroups();
    list.scrollTop = 0;
    renderWindow(true);
  };

  list.addEventListener('scroll', () => renderWindow(), { signal, passive: true });
  list.addEventListener('change', event => {
    const box = event.target;
    if (!(box instanceof HTMLInputElement) || box.dataset.groupId === undefined) return;
    if (box.checked) checked.add(box.dataset.groupId);
    else checked.delete(box.dataset.groupId);
    emit();
  }, { signal });
  search.addEventListener('input', applyFilter, { signal });

  // All / None / Invert act on the groups the search shows.
  actionButton('All', () => { for (const group of filtered) checked.add(group.id); renderWindow(true); emit(); });
  actionButton('None', () => { for (const group of filtered) checked.delete(group.id); renderWindow(true); emit(); });
  actionButton('Invert', () => {
    for (const group of filtered) {
      if (checked.has(group.id)) checked.delete(group.id);
      else checked.add(group.id);
    }
    renderWindow(true);
    emit();
  });

  const place = () => {
    const rect = toggle.getBoundingClientRect();
    const width = Math.max(rect.width, 260);
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    const below = window.innerHeight - rect.bottom;
    panel.style.setProperty('--group-picker-left', `${left}px`);
    panel.style.setProperty('--group-picker-width', `${width}px`);
    if (below < 320 && rect.top > below) {
      panel.style.setProperty('--group-picker-top', 'auto');
      panel.style.setProperty('--group-picker-bottom', `${window.innerHeight - rect.top + 4}px`);
    } else {
      panel.style.setProperty('--group-picker-top', `${rect.bottom + 4}px`);
      panel.style.setProperty('--group-picker-bottom', 'auto');
    }
  };

  const open = () => {
    if (panel.matches(':popover-open')) return;
    place();
    panel.showPopover();
  };
  const close = () => {
    if (panel.matches(':popover-open')) panel.hidePopover();
  };

  toggle.addEventListener('click', () => {
    if (panel.matches(':popover-open')) close();
    else open();
  }, { signal });
  done.addEventListener('click', () => {
    close();
    toggle.focus();
  }, { signal });
  panel.addEventListener('toggle', event => {
    const opened = event.newState === 'open';
    toggle.setAttribute('aria-expanded', String(opened));
    if (opened) {
      search.value = '';
      applyFilter();
      search.focus({ preventScroll: true });
    }
  }, { signal });
  window.addEventListener('resize', () => {
    if (panel.matches(':popover-open')) place();
  }, { signal, passive: true });

  const setGroups = (nextGroups, nextMinCells = minCells) => {
    if (!Array.isArray(nextGroups)) throw new TypeError('Group picker groups must be an array');
    const next = nextGroups.map(group => ({
      id: String(group.id),
      name: String(group.name),
      count: Number(group.count),
      color: typeof group.color === 'string' ? group.color : null,
    }));
    // The same groups again (the form refreshes after every change): the
    // list, its scroll and its checks stay as the user left them.
    const same = next.length === groups.length && nextMinCells === minCells && next.every((group, i) =>
      group.id === groups[i].id && group.name === groups[i].name && group.count === groups[i].count && group.color === groups[i].color);
    if (same) return;
    groups = next;
    minCells = nextMinCells;
    const known = new Set(groups.map(group => group.id));
    if (all) {
      checked = new Set(known);
    } else if (groups.length > 0) {
      checked = new Set([...checked].filter(id => known.has(id)));
    }
    filterGroups();
    renderWindow(true);
    updateSummary();
  };

  const setValue = value => {
    if (value?.mode === 'all') {
      all = true;
      checked = new Set(groups.map(group => group.id));
    } else if (value?.mode === 'subset' && Array.isArray(value.ids)) {
      all = false;
      checked = new Set(value.ids);
    } else {
      throw new TypeError('Group picker value must be { mode: "all" } or { mode: "subset", ids }');
    }
    renderWindow(true);
    updateSummary();
  };

  setGroups(initialGroups ?? [], initialMinCells);
  setValue(initialValue);

  return {
    root,
    toggle,
    getValue: readValue,
    setValue,
    setGroups,
    open,
    close,
    destroy() {
      close();
      abort.abort();
      root.remove();
    },
  };
}
