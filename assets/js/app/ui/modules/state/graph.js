/**
 * @fileoverview The branch graph in the sidebar (History v2 §3.9, §3.10): a
 * virtualised tree of the rows `graph-layout.js` lays out. Only the rows in
 * view (plus a few above and below, and the row with the keyboard focus)
 * exist in the page, so a history of any length opens, scrolls and takes a
 * new step in time with the display: the rows are kept by key and written
 * again only when what they show changed.
 *
 * **Rows grow, never truncate.** A long label wraps to more lines; each
 * row's height is measured when it is drawn (one line until then), and the
 * rows above the view keep their place while heights settle.
 *
 * **Interaction (owner rule, §3.10).** A click only selects a row (and gives
 * it the keyboard focus); Shift+click extends the selection over consecutive
 * rows of one line. A double-click (a double tap on a touch screen) shows
 * the step. The row's `›` button opens or closes its details, inline under
 * it. The ▸ toggle expands a stub, a turn, a group or a run.
 *
 * **Keyboard** (the tree pattern): ↑/↓ move (with Shift, extend the
 * selection), →/← expand or go in / collapse or go to the parent, Home/End,
 * Enter shows, Space opens the details, F2 renames, Delete deletes (asks),
 * Shift+F10 or the Menu key opens the row's menu, `[`/`]` previous/next
 * fork, Alt+↑/↓ show the previous/next step, Ctrl/⌘+G groups the selection,
 * Ctrl/⌘+Shift+B branches from the selected step, `/` searches.
 *
 * **Accessible.** `role="tree"` with `aria-multiselectable`; each row a
 * `treeitem` with its level, its place among its siblings, whether it is
 * expanded and selected, and a name that says the step, its branch, who
 * acted, when, and what starts there.
 *
 * @module ui/modules/state/graph
 */

import { layoutGraph, rowOfStep, revealPlan, selectedSteps } from './graph-layout.js';
import { describeRow, rowGlyph } from './model.js';
import { isPanelShown } from '../../core/visibility-gate.js';
import { StyleManager } from '../../../../utils/style-manager.js';
import { idNumber } from '../../../history/model.js';

/** Rows drawn beyond the view on each side. */
const OVERSCAN = 8;
/** How long a pointer rests on a row before its hint shows (desktop only). */
const HINT_DELAY_MS = 400;
/** Two taps on one row within this long are a double tap. */
const DOUBLE_TAP_MS = 350;
const TIME_REFRESH_MS = 30_000;

/** A small chevron the details button draws (decorative). */
const DETAILS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9 6 6 6-6 6"/></svg>';
const MORE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

/**
 * @param {object} options
 * @param {HTMLElement} options.container - the scrolling tree (`#history-graph`)
 * @param {HTMLButtonElement} options.where - the "Shown: step 12 ↑" pill
 * @param {object} options.handlers
 * @param {(row: object) => void} options.handlers.show - double-click, Enter
 * @param {(row: object, close: () => void) => HTMLElement} options.handlers.details - its details' content
 * @param {(row: object, anchor: Element, selection: {steps: string[], problem: string|null}, at: {x: number, y: number}|null) => void} options.handlers.menu -
 *   `at`: the pointer, for a context menu
 * @param {(row: object) => void} options.handlers.rename
 * @param {(row: object) => void} options.handlers.remove
 * @param {(selection: {steps: string[], problem: string|null}) => void} options.handlers.group
 * @param {(row: object) => void} options.handlers.branchHere
 * @param {(turnId: string) => boolean} options.handlers.canOpenChat - whether a chat here holds the turn
 * @param {(turnId: string) => void} options.handlers.openChat
 * @param {() => void} options.handlers.search
 * @param {(selection: {steps: string[], problem: string|null}) => void} [options.handlers.selectionChanged]
 * @param {boolean} [options.expandAll] - every branch expanded (the branch map's graph)
 * @param {() => number} [options.now]
 */
export function createGraph({ container, where, handlers, expandAll = false, now = () => Date.now() }) {
  const ownerDocument = container.ownerDocument;
  const controller = new AbortController();
  const { signal } = controller;
  container.setAttribute('role', 'tree');
  container.setAttribute('aria-multiselectable', 'true');
  const sizer = ownerDocument.createElement('div');
  sizer.className = 'hg-sizer';
  container.replaceChildren(sizer);
  const hint = ownerDocument.createElement('div');
  hint.className = 'hg-hint';
  hint.setAttribute('role', 'tooltip');
  hint.id = `${container.id}-hint`;
  hint.hidden = true;
  container.after(hint);

  /** What the graph shows: the tracker, the layout and the state of the person's choices. */
  let view = null;
  let trackerId = null;
  let layout = { rows: [], headRow: -1, columns: 1, steps: 0, undone: 0, matches: null, kept: 0 };
  /** The last layout and the view it was laid out from (the next one may extend it). */
  let laidOut = null;
  let layoutOptions = {};
  const expandedForks = new Set();
  const collapsedTurns = new Set();
  const expandedGroups = new Set();
  const expandedRuns = new Set();
  /** key → index in layout.rows */
  let indexOf = new Map();
  /** Measured row heights by key (rows not drawn yet count one line). */
  const heights = new Map();
  let offsets = new Float64Array(1);
  let baseHeight = 28;
  /** Rows drawn: key → {element, signature, parts} */
  const drawn = new Map();
  /** Row elements scrolled out of view, kept to draw the next rows in (scrolling builds no element). */
  const spare = [];
  let focusKey = null;
  let anchorKey = null;
  let detailsKey = null;
  let detailsElement = null;
  let detailsSignature = null;
  /**
   * The history changed since the details were built: they are built again,
   * unless someone is writing in them (a field focused, or a note's editor
   * open), then once that ends. A redraw for any other reason (the panel's
   * busy state, the clock, memory) keeps them as they are, so a control in
   * them is never replaced under the pointer or the keyboard.
   */
  let detailsStale = false;
  /** The history version (`options.version`) the details were last told of. */
  let detailsVersion = null;
  let lastHead = null;
  /** The width the labels last wrapped at: the tree's, and whether the scrollbar strip is kept clear. */
  let lastWidth = '';
  let hintTimer = null;
  let lastTap = { key: null, at: 0 };
  /** When a double tap last showed a row: the dblclick a browser may send for the same taps is not a second. */
  let tapShownAt = -Infinity;

  // ---------------------------------------------------------------- layout

  /**
   * Lay the rows out again. `changed`: the history changed (not the rows
   * opened), so a history that only took new steps is laid out from the
   * layout before (`layoutGraph`'s appends): the rows kept keep their keys'
   * places and their offsets.
   */
  function relayout(changed = false) {
    const before = layout;
    if (view === null) {
      layout = { rows: [], headRow: -1, columns: 1, steps: 0, undone: 0, matches: null, kept: 0 };
    } else {
      const forks = expandAll ? new Set(view.branches().map(branch => branch.id)) : expandedForks;
      const options = { ...layoutOptions, expandedForks: forks, collapsedTurns, expandedGroups, expandedRuns };
      const same = laidOut !== null && laidOut.view.id === view.id && laidOut.offDomains === offDomainsKey(layoutOptions) && !expandAll;
      layout = layoutGraph(view, options, changed && same ? laidOut : null);
      laidOut = { view, layout, offDomains: offDomainsKey(layoutOptions) };
    }
    const kept = layout.kept ?? 0;
    if (kept > 0) {
      for (let index = kept; index < before.rows.length; index++) indexOf.delete(before.rows[index].key);
      for (let index = kept; index < layout.rows.length; index++) indexOf.set(layout.rows[index].key, index);
    } else {
      indexOf = new Map(layout.rows.map((row, index) => [row.key, index]));
    }
    if (focusKey !== null && !indexOf.has(focusKey)) focusKey = null;
    if (anchorKey !== null && !indexOf.has(anchorKey)) anchorKey = null;
    if (detailsKey !== null && !indexOf.has(detailsKey)) closeDetailsNow();
    computeOffsets(kept);
  }

  /** The domains not recorded now, as a key: a layout from another set lays out again. */
  function offDomainsKey(options) {
    return [...(options?.offDomains ?? [])].sort().join(' ');
  }

  /** Each row's top from row `from` on (the rows above keep theirs). */
  function computeOffsets(from = 0) {
    const rows = layout.rows;
    if (offsets.length < rows.length + 1) {
      const grown = new Float64Array(Math.max(rows.length + 1, offsets.length * 2));
      grown.set(offsets.subarray(0, Math.min(offsets.length, from + 1)));
      offsets = grown;
    }
    let at = from === 0 ? 0 : offsets[from];
    for (let index = from; index < rows.length; index++) {
      offsets[index] = at;
      at += heights.get(rows[index].key) ?? baseHeight;
    }
    offsets[rows.length] = at;
    // On the tree itself: its own height follows it (up to its most), and the sizer inherits it.
    StyleManager.setVariable(container, '--hg-total', `${at}px`);
  }

  /** The first row whose bottom is below `y`. */
  function rowAt(y) {
    let lo = 0;
    let hi = layout.rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] <= y) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo);
  }

  // ---------------------------------------------------------------- drawing

  function signatureOf(row, words) {
    return [row.kind, row.level, row.indent, row.column, row.color, row.position, row.expanded, row.dim, row.posInSet, row.setSize,
      row.segments.map(s => `${s.column}${s.part}${s.color}${s.faded ? 'f' : ''}`).join(','),
      row.elbow ? `${row.elbow.from}` : '', words.label, words.meta, words.badge, words.time, words.name,
      row.step?.bookmark ?? '', row.step?.notes?.length ?? 0, row.stale ? 1 : 0, row.flagged ? 1 : 0,
      row.kind === 'turn' ? `${handlers.canOpenChat(row.turnId)}` : '', row.branch?.locked ?? '', row.branch?.id === view?.mainBranch,
    ].join('\u0001');
  }

  function buildRow() {
    const element = ownerDocument.createElement('div');
    element.className = 'hg-row';
    element.setAttribute('role', 'treeitem');
    element.tabIndex = -1;
    const line = ownerDocument.createElement('div');
    line.className = 'hg-line';
    const rail = ownerDocument.createElement('span');
    rail.className = 'hg-rail';
    rail.setAttribute('aria-hidden', 'true');
    const toggle = ownerDocument.createElement('span');
    toggle.className = 'hg-toggle';
    toggle.setAttribute('aria-hidden', 'true');
    const flags = ownerDocument.createElement('span');
    flags.className = 'hg-flags';
    flags.setAttribute('aria-hidden', 'true');
    const label = ownerDocument.createElement('span');
    label.className = 'hg-label';
    const meta = ownerDocument.createElement('span');
    meta.className = 'hg-meta';
    meta.setAttribute('aria-hidden', 'true');
    const badge = ownerDocument.createElement('span');
    badge.className = 'history-badge';
    badge.setAttribute('aria-hidden', 'true');
    const time = ownerDocument.createElement('span');
    time.className = 'hg-time';
    time.setAttribute('aria-hidden', 'true');
    const tools = ownerDocument.createElement('span');
    tools.className = 'hg-tools';
    line.append(rail, toggle, flags, label, meta, badge, time, tools);
    element.append(line);
    return { element, signature: null, parts: { line, rail, toggle, flags, label, meta, badge, time, tools } };
  }

  function laneSpan(className, column, color, faded) {
    const span = ownerDocument.createElement('span');
    span.className = `${className} lane-${color}${faded ? ' is-faded' : ''}`;
    StyleManager.setVariable(span, '--hg-column', column);
    return span;
  }

  function toolButton(className, label, html, data = {}) {
    const button = ownerDocument.createElement('button');
    button.type = 'button';
    button.className = `hg-tool ${className}`;
    button.tabIndex = -1;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML = html;
    for (const [key, value] of Object.entries(data)) button.dataset[key] = value;
    return button;
  }

  function writeRow(entry, row, words) {
    const { element, parts } = entry;
    element.dataset.key = row.key;
    element.dataset.kind = row.kind;
    element.dataset.position = row.position ?? '';
    element.dataset.dim = String(row.dim);
    element.id = `${container.id}-row-${row.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    element.setAttribute('aria-level', String(row.level));
    element.setAttribute('aria-setsize', String(row.setSize));
    element.setAttribute('aria-posinset', String(row.posInSet));
    element.setAttribute('aria-label', words.name);
    if (row.expanded === null) element.removeAttribute('aria-expanded');
    else element.setAttribute('aria-expanded', String(row.expanded));
    if (row.position === 'head') element.setAttribute('aria-current', 'step');
    else element.removeAttribute('aria-current');
    StyleManager.setVariable(element, '--hg-indent', row.indent);
    StyleManager.setVariable(element, '--hg-row-column', row.column);
    element.className = `hg-row lane-${row.color}`;

    // The lanes: the line segments through the row, the stub's elbow, the node.
    const rail = [];
    for (const segment of row.segments) {
      rail.push(laneSpan(`hg-seg hg-seg-${segment.part}`, segment.column, segment.color, segment.faded));
    }
    if (row.elbow !== null) {
      const elbow = laneSpan('hg-elbow', row.elbow.from, row.elbow.color, false);
      StyleManager.setVariable(elbow, '--hg-elbow-span', row.column - row.elbow.from);
      rail.push(elbow);
    }
    const node = laneSpan(`hg-node hg-node-${row.kind}`, row.column, row.color, row.dim);
    node.textContent = rowGlyph(row);
    rail.push(node);
    parts.rail.replaceChildren(...rail);

    parts.toggle.textContent = row.expanded === null ? '' : row.expanded ? '▾' : '▸';
    parts.toggle.dataset.toggle = row.expanded === null ? '' : 'true';

    const flags = [];
    if (row.kind === 'step') {
      if (row.step.bookmark) flags.push('★');
      if ((row.step.notes?.length ?? 0) > 0) flags.push('✎');
      if (row.stale !== null || row.flagged) flags.push('⚠');
    } else if (row.kind === 'fork') {
      if (row.branch.id === view.mainBranch) flags.push('★');
      if (row.branch.locked) flags.push('🔒');
    } else if ((row.kind === 'group' && (row.group.notes?.length ?? 0) > 0) || (row.kind === 'turn' && (row.turn?.notes?.length ?? 0) > 0)) {
      flags.push('✎');
    }
    parts.flags.textContent = flags.join('');
    parts.flags.hidden = flags.length === 0;
    parts.label.textContent = words.label;
    parts.meta.textContent = words.meta;
    parts.meta.hidden = words.meta === '';
    parts.badge.textContent = words.badge ?? '';
    parts.badge.hidden = words.badge === null;
    parts.badge.dataset.origin = row.kind === 'step' ? row.step.by?.origin ?? '' : '';
    parts.time.textContent = words.time;
    parts.time.hidden = words.time === '';

    // The row's buttons stay the same elements while the row is rewritten (its words, its
    // time): one under the pointer or with the focus is never replaced by a copy.
    const tools = [];
    if (row.kind === 'turn') {
      if (handlers.canOpenChat(row.turnId)) {
        tools.push(rowTool(parts, 'hg-chat', `Show this turn in the chat`, '↗', 'chat'));
      }
    }
    if (row.kind !== 'paused') {
      const details = rowTool(parts, 'hg-details-btn', `Details of ${detailsNoun(row)}`, DETAILS_ICON, 'details');
      details.setAttribute('aria-expanded', String(detailsKey === row.key));
      tools.push(details);
    }
    if (row.kind === 'fork') tools.push(rowTool(parts, 'hg-more', `Branch “${row.branch.name}”: actions`, MORE_ICON, 'menu'));
    const current = [...parts.tools.children];
    if (current.length !== tools.length || current.some((element, index) => element !== tools[index])) parts.tools.replaceChildren(...tools);
  }

  /** One of a row's buttons (`action`), kept by the row's parts and only relabelled when it is written again. */
  function rowTool(parts, className, label, html, action) {
    parts.buttons ??= new Map();
    let button = parts.buttons.get(action);
    if (button === undefined) {
      button = toolButton(className, label, html, { action });
      parts.buttons.set(action, button);
    } else if (button.getAttribute('aria-label') !== label) {
      button.setAttribute('aria-label', label);
      button.title = label;
    }
    return button;
  }

  function detailsNoun(row) {
    switch (row.kind) {
      case 'step': return row.step.parent === null ? 'the opening' : `step ${idNumber(row.step.id)}`;
      case 'fork': return `branch “${row.branch.name}”`;
      case 'turn': return 'this turn';
      case 'group': return `group “${row.group.name}”`;
      default: return 'these steps';
    }
  }

  /** Draw the rows in view, the row with the focus, and the details' row; measure them. */
  function draw() {
    const rows = layout.rows;
    // While the tree scrolls, its rows end clear of the overlay scrollbar's
    // strip (CSS, `[data-overflows]`): WebKit takes the clicks there once its
    // scrollbar has shown, over the Details buttons at the rows' ends.
    const overflows = offsets[rows.length] > container.clientHeight;
    if (container.hasAttribute('data-overflows') !== overflows) container.toggleAttribute('data-overflows', overflows);
    const width = `${container.clientWidth}${overflows ? ' less the strip' : ''}`;
    if (width !== lastWidth) {
      // Labels wrap again at another width: every height is measured afresh.
      lastWidth = width;
      heights.clear();
      computeOffsets();
    }
    const top = container.scrollTop;
    const bottom = top + Math.max(container.clientHeight, baseHeight * 4);
    let first = rows.length === 0 ? 0 : Math.max(0, rowAt(top) - OVERSCAN);
    let last = rows.length === 0 ? -1 : Math.min(rows.length - 1, rowAt(bottom) + OVERSCAN);
    const wanted = new Set();
    for (let index = first; index <= last; index++) wanted.add(index);
    for (const key of [focusKey, detailsKey]) if (key !== null && indexOf.has(key)) wanted.add(indexOf.get(key));
    for (const [key, entry] of drawn) {
      const index = indexOf.get(key);
      if (index === undefined || !wanted.has(index)) {
        if (entry.element.contains(ownerDocument.activeElement) && index !== undefined) continue;
        entry.element.remove();
        drawn.delete(key);
        if (entry.details === undefined) {
          entry.signature = null;
          entry.top = null;
          spare.push(entry);
        }
      }
    }
    const nowAt = now();
    const changed = [];
    // The drawn rows stay in the document in the tree's order (a screen
    // reader and the browser's own find walk the DOM): each goes after the
    // one before it, moved only when it is not there already.
    const focused = ownerDocument.activeElement;
    let previous = null;
    for (const index of [...wanted].sort((a, b) => a - b)) {
      const row = rows[index];
      let entry = drawn.get(row.key);
      if (entry === undefined) {
        entry = spare.pop() ?? buildRow();
        drawn.set(row.key, entry);
      }
      const next = previous === null ? sizer.firstChild : previous.nextSibling;
      if (entry.element !== next) sizer.insertBefore(entry.element, next);
      previous = entry.element;
      const words = describeRow(row, { view, now: nowAt });
      const signature = signatureOf(row, words);
      if (entry.signature !== signature) {
        writeRow(entry, row, words);
        entry.signature = signature;
        changed.push(row.key);
      }
      entry.row = row;
      writeSelection(entry, row, index);
      placeDetails(entry, row);
    }
    // A row moved while focused loses focus: give it back.
    if (focused instanceof HTMLElement && focused !== ownerDocument.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
    // Measure what changed; place every drawn row. The rows above the first
    // whose height changed keep their places.
    let moved = rows.length;
    const measure = key => {
      const height = drawn.get(key).element.offsetHeight;
      if (height > 0 && heights.get(key) !== height) {
        heights.set(key, height);
        moved = Math.min(moved, indexOf.get(key));
      }
    };
    for (const key of changed) measure(key);
    if (detailsKey !== null && drawn.has(detailsKey)) measure(detailsKey);
    if (moved < rows.length) {
      // Keep the first row in view where it was while the rows above settle.
      const anchorIndex = rowAt(top);
      const within = top - offsets[anchorIndex];
      computeOffsets(moved);
      const target = offsets[anchorIndex] + within;
      if (Math.abs(container.scrollTop - target) >= 1) container.scrollTop = target;
    }
    for (const [key, entry] of drawn) {
      const top = offsets[indexOf.get(key)];
      if (entry.top !== top) {
        entry.top = top;
        StyleManager.setVariable(entry.element, '--hg-top', `${top}px`);
      }
    }
    writeWhere();
  }

  function writeSelection(entry, row, index) {
    const selected = String(isSelected(index));
    if (entry.element.getAttribute('aria-selected') !== selected) entry.element.setAttribute('aria-selected', selected);
    const tab = row.key === (focusKey ?? currentKey()) ? 0 : -1;
    if (entry.element.tabIndex !== tab) entry.element.tabIndex = tab;
  }

  /** The row the tree's one tab stop is on when nothing is focused: the step shown. */
  function currentKey() {
    return layout.headRow === -1 ? layout.rows[0]?.key ?? null : layout.rows[layout.headRow].key;
  }

  function selectionRange() {
    if (focusKey === null || !indexOf.has(focusKey)) return null;
    const focus = indexOf.get(focusKey);
    const anchor = anchorKey !== null && indexOf.has(anchorKey) ? indexOf.get(anchorKey) : focus;
    return { anchor, focus };
  }

  function isSelected(index) {
    const range = selectionRange();
    if (range === null) return false;
    const [from, to] = range.anchor <= range.focus ? [range.anchor, range.focus] : [range.focus, range.anchor];
    if (index < from || index > to) return false;
    return layout.rows[index].chain === layout.rows[range.anchor].chain;
  }

  function selection() {
    const range = selectionRange();
    if (range === null) return { steps: [], problem: 'Choose a step first.' };
    return selectedSteps(layout.rows, range.anchor, range.focus);
  }

  function placeDetails(entry, row) {
    if (row.key !== detailsKey) {
      if (entry.details !== undefined) {
        entry.details.remove();
        entry.details = undefined;
      }
      return;
    }
    // What the details show, without the clock's words (a row's "4 m ago" moves on by itself).
    const words = signatureOf(row, { ...describeRow(row, { view, now: 0 }), time: '', name: '' });
    const editing = detailsElement !== null && ((detailsElement.contains(ownerDocument.activeElement)
      && /^(INPUT|TEXTAREA|SELECT)$/.test(ownerDocument.activeElement.tagName))
      || detailsElement.querySelector('.history-note-editor') !== null);
    if (detailsElement === null || ((detailsSignature !== words || detailsStale) && !editing)) {
      detailsStale = false;
      const next = handlers.details(row, () => closeDetails(true));
      next.classList.add('hg-details');
      next.setAttribute('role', 'group');
      next.setAttribute('aria-label', `Details of ${detailsNoun(row)}`);
      const keepFocus = detailsElement?.contains(ownerDocument.activeElement) ?? false;
      detailsElement?.remove();
      detailsElement = next;
      detailsSignature = words;
      if (keepFocus) entry.element.focus({ preventScroll: true });
    }
    if (detailsElement.parentElement !== entry.element) entry.element.append(detailsElement);
    entry.details = detailsElement;
  }

  function writeWhere() {
    if (layout.headRow === -1 || layout.rows.length === 0) {
      where.hidden = true;
      return;
    }
    const top = offsets[layout.headRow];
    const bottom = offsets[layout.headRow + 1];
    const above = bottom <= container.scrollTop;
    const below = top >= container.scrollTop + container.clientHeight;
    where.hidden = !(above || below) || container.clientHeight === 0;
    if (!where.hidden) {
      const row = layout.rows[layout.headRow];
      const at = row.kind === 'step' ? (row.step.parent === null ? 'the opening' : `step ${idNumber(row.step.id)}`) : `step ${idNumber(view.headId)}`;
      where.textContent = `Shown: ${at} ${above ? '↑' : '↓'}`;
      where.setAttribute('aria-label', `Scroll to the step shown, ${at}`);
    }
  }

  let frame = null;
  function schedule() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!signal.aborted) draw();
    });
  }

  // ---------------------------------------------------------------- moving through rows

  function scrollToIndex(index, block = 'nearest') {
    const top = offsets[index];
    const bottom = offsets[index + 1];
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    if (block === 'center') container.scrollTop = Math.max(0, top - (container.clientHeight - (bottom - top)) / 2);
    else if (top < viewTop) container.scrollTop = top;
    else if (bottom > viewBottom) container.scrollTop = bottom - container.clientHeight;
  }

  function focusIndex(index, { extend = false, scroll = 'nearest' } = {}) {
    const row = layout.rows[index];
    if (row === undefined) return;
    if (!extend) anchorKey = row.key;
    focusKey = row.key;
    scrollToIndex(index, scroll);
    draw();
    drawn.get(row.key)?.element.focus({ preventScroll: true });
    handlers.selectionChanged?.(selection());
  }

  function setExpanded(row, expanded) {
    const sets = { fork: [expandedForks, row.branch?.id], group: [expandedGroups, row.group?.id], run: [expandedRuns, row.key] };
    if (row.kind === 'turn') {
      if (expanded) collapsedTurns.delete(row.key);
      else collapsedTurns.add(row.key);
    } else if (sets[row.kind] !== undefined) {
      const [set, key] = sets[row.kind];
      if (expanded) set.add(key);
      else set.delete(key);
    } else {
      return;
    }
    relayout();
    draw();
  }

  function rowFromEvent(event) {
    const element = event.target instanceof Element ? event.target.closest('.hg-row') : null;
    if (element === null || !container.contains(element)) return null;
    const index = indexOf.get(element.dataset.key);
    return index === undefined ? null : { element, index, row: layout.rows[index] };
  }

  function toggleDetails(row) {
    if (detailsKey === row.key) closeDetails(false);
    else {
      closeDetailsNow();
      detailsKey = row.key;
      focusKey = row.key;
      anchorKey = row.key;
      draw();
      drawn.get(row.key)?.element.scrollIntoView({ block: 'nearest' });
    }
  }

  function closeDetailsNow() {
    detailsElement?.remove();
    detailsElement = null;
    detailsKey = null;
    detailsSignature = null;
  }

  function closeDetails(refocus) {
    const key = detailsKey;
    closeDetailsNow();
    if (key !== null) heights.delete(key);
    computeOffsets();
    draw();
    if (refocus && key !== null) drawn.get(key)?.element.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- events

  // A note's editor closed: details the history changed meanwhile are built now.
  container.addEventListener('history-editor-closed', () => {
    if (detailsStale) schedule();
  }, { signal });

  container.addEventListener('scroll', () => {
    hideHint();
    schedule();
  }, { signal, passive: true });

  container.addEventListener('click', event => {
    const hit = rowFromEvent(event);
    if (hit === null) return;
    const tool = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (tool !== null && hit.element.contains(tool) && !(detailsElement?.contains(tool) ?? false)) {
      event.preventDefault();
      switch (tool.dataset.action) {
        case 'details': toggleDetails(hit.row); return;
        case 'menu': handlers.menu(hit.row, tool, selection()); return;
        case 'chat': handlers.openChat(hit.row.turnId); return;
        default: return;
      }
    }
    if (detailsElement?.contains(event.target)) return;
    if (event.target instanceof Element && event.target.closest('[data-toggle="true"]')) {
      setExpanded(hit.row, !hit.row.expanded);
      return;
    }
    focusIndex(hit.index, { extend: event.shiftKey && anchorKey !== null });
  }, { signal });

  container.addEventListener('dblclick', event => {
    const hit = rowFromEvent(event);
    if (hit === null || detailsElement?.contains(event.target)) return;
    if (event.target instanceof Element && event.target.closest('[data-action], [data-toggle="true"]')) return;
    event.preventDefault();
    if (performance.now() - tapShownAt < DOUBLE_TAP_MS) return;
    handlers.show(hit.row);
  }, { signal });

  // A double tap on a touch screen shows, as a double-click does (browsers do not all send dblclick for taps).
  container.addEventListener('pointerup', event => {
    if (event.pointerType !== 'touch') return;
    const hit = rowFromEvent(event);
    if (hit === null || detailsElement?.contains(event.target)) return;
    if (event.target instanceof Element && event.target.closest('[data-action], [data-toggle="true"]')) return;
    const at = performance.now();
    if (lastTap.key === hit.row.key && at - lastTap.at < DOUBLE_TAP_MS) {
      lastTap = { key: null, at: 0 };
      tapShownAt = at;
      handlers.show(hit.row);
    } else {
      lastTap = { key: hit.row.key, at };
    }
  }, { signal });

  container.addEventListener('contextmenu', event => {
    const hit = rowFromEvent(event);
    if (hit === null || detailsElement?.contains(event.target)) return;
    event.preventDefault();
    if (!isSelected(hit.index)) focusIndex(hit.index);
    // At the pointer; from the keyboard (the Menu key's contextmenu has no point), under the row.
    handlers.menu(hit.row, hit.element, selection(), event.clientX === 0 && event.clientY === 0 ? null : { x: event.clientX, y: event.clientY });
  }, { signal });

  container.addEventListener('keydown', event => {
    if (detailsElement?.contains(event.target)) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDetails(true);
      }
      return;
    }
    const hit = rowFromEvent(event);
    // Keys belong to the row itself; a button inside it keeps its own (Enter, Space press it).
    if (hit === null || event.target !== hit.element) return;
    const { row, index } = hit;
    const rows = layout.rows;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;
    let handled = true;
    if (mod && !event.altKey && key.toLowerCase() === 'g' && !event.shiftKey) handlers.group(selection());
    else if (mod && event.shiftKey && key.toLowerCase() === 'b') handlers.branchHere(row);
    else if (event.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      // The step before or after on the rows, shown without its details.
      const step = stepRowFrom(index, key === 'ArrowUp' ? -1 : 1);
      if (step !== -1) {
        focusIndex(step);
        handlers.show(rows[step]);
      }
    } else if (mod || event.altKey) handled = false;
    else {
      switch (key) {
        case 'ArrowDown': focusIndex(Math.min(rows.length - 1, index + 1), { extend: event.shiftKey }); break;
        case 'ArrowUp': focusIndex(Math.max(0, index - 1), { extend: event.shiftKey }); break;
        case 'Home': focusIndex(0, { extend: event.shiftKey }); break;
        case 'End': focusIndex(rows.length - 1, { extend: event.shiftKey }); break;
        case 'PageDown': focusIndex(Math.min(rows.length - 1, rowAt(offsets[index] + container.clientHeight)), { extend: event.shiftKey }); break;
        case 'PageUp': focusIndex(Math.max(0, rowAt(Math.max(0, offsets[index] - container.clientHeight))), { extend: event.shiftKey }); break;
        case 'ArrowRight':
          if (row.expanded === false) setExpanded(row, true);
          else if (row.expanded === true && rows[index + 1]?.parent === row.key) focusIndex(index + 1);
          break;
        case 'ArrowLeft':
          if (row.expanded === true) setExpanded(row, false);
          else if (row.parent !== null && indexOf.has(row.parent)) focusIndex(indexOf.get(row.parent));
          break;
        case 'Enter': handlers.show(row); break;
        case ' ': if (row.kind !== 'paused') toggleDetails(row); break;
        case 'F2': handlers.rename(row); break;
        case 'Delete': case 'Backspace': handlers.remove(row); break;
        case 'ContextMenu': handlers.menu(row, hit.element, selection()); break;
        case 'F10': if (event.shiftKey) handlers.menu(row, hit.element, selection()); else handled = false; break;
        case '[': case ']': {
          const step = key === '[' ? -1 : 1;
          for (let at = index + step; at >= 0 && at < rows.length; at += step) {
            if (rows[at].kind === 'fork' || rows[at].forks > 0) { focusIndex(at); break; }
          }
          break;
        }
        case '/': handlers.search(); break;
        case 'Escape':
          if (detailsKey !== null) closeDetails(true);
          else if (anchorKey !== focusKey) { anchorKey = focusKey; draw(); handlers.selectionChanged?.(selection()); } else handled = false;
          break;
        default: handled = false;
      }
    }
    if (handled) event.preventDefault();
  }, { signal });

  container.addEventListener('focusin', event => {
    const hit = rowFromEvent(event);
    if (hit === null || hit.element !== event.target) return;
    focusKey = hit.row.key;
    for (const entry of drawn.values()) entry.element.tabIndex = entry.element === hit.element ? 0 : -1;
  }, { signal });

  where.addEventListener('click', () => {
    if (layout.headRow === -1) return;
    focusIndex(layout.headRow, { scroll: 'center' });
  }, { signal });

  function stepRowFrom(index, step) {
    for (let at = index + step; at >= 0 && at < layout.rows.length; at += step) {
      if (layout.rows[at].kind === 'step') return at;
    }
    return -1;
  }

  // The hover hint (a fine pointer only): the exact time, who acted, and how the row works.
  const finePointer = ownerDocument.defaultView?.matchMedia?.('(hover: hover) and (pointer: fine)') ?? null;
  function hideHint() {
    if (hintTimer !== null) clearTimeout(hintTimer);
    hintTimer = null;
    hint.hidden = true;
  }
  container.addEventListener('pointerover', event => {
    if (finePointer?.matches !== true) return;
    const hit = rowFromEvent(event);
    if (hit === null || hit.row.kind === 'paused' || detailsElement?.contains(event.target)) { hideHint(); return; }
    if (hint.dataset.key === hit.row.key && !hint.hidden) return;
    hideHint();
    hintTimer = setTimeout(() => {
      const words = describeRow(hit.row, { view, now: now() });
      hint.textContent = `${words.hint ? `${words.hint} · ` : ''}Double-click to show · › details`;
      hint.dataset.key = hit.row.key;
      const box = hit.element.getBoundingClientRect();
      const host = container.getBoundingClientRect();
      // Under the row's first line, or over the row when that would leave the graph's box.
      const under = box.top - host.top + Math.min(box.height, baseHeight);
      StyleManager.setVariable(hint, '--hg-hint-top', `${container.offsetTop + under}px`);
      hint.hidden = false;
      if (under + hint.offsetHeight > host.height) {
        StyleManager.setVariable(hint, '--hg-hint-top', `${container.offsetTop + Math.max(0, box.top - host.top - hint.offsetHeight)}px`);
      }
    }, HINT_DELAY_MS);
  }, { signal });
  container.addEventListener('pointerleave', hideHint, { signal });
  container.addEventListener('pointerdown', hideHint, { signal });

  // Labels wrap again when the sidebar's width changes.
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;
  resize?.observe(container);

  const timer = setInterval(() => {
    if (view === null || !container.isConnected || !isPanelShown(container)) return;
    for (const entry of drawn.values()) entry.signature = null;
    schedule();
  }, TIME_REFRESH_MS);

  // ---------------------------------------------------------------- API

  return {
    /**
     * Draw `next` (a tracker view, or null). A step not drawn by the person
     * here moves the history: the details of the row left close, and the
     * step shown is scrolled into view.
     * @param {import('./history-source.js').TrackerView|null} next
     * @param {object} options - `layoutGraph` options: filter, offDomains, effectOf, categoryOf
     */
    render(next, options) {
      if ((next?.id ?? null) !== trackerId) {
        trackerId = next?.id ?? null;
        for (const set of [expandedForks, collapsedTurns, expandedGroups, expandedRuns]) set.clear();
        heights.clear();
        focusKey = null;
        anchorKey = null;
        lastHead = null;
        closeDetailsNow();
        for (const entry of drawn.values()) entry.element.remove();
        drawn.clear();
        spare.length = 0;
        container.scrollTop = 0;
        laidOut = null;
      }
      view = next;
      layoutOptions = options;
      if (options?.version !== detailsVersion) {
        detailsVersion = options?.version;
        detailsStale = true;
      }
      const rowHeight = Number.parseFloat(ownerDocument.defaultView?.getComputedStyle(container).getPropertyValue('--hg-row-height')) || baseHeight;
      // Another row height places every row again.
      if (rowHeight !== baseHeight) laidOut = null;
      baseHeight = rowHeight;
      relayout(true);
      container.hidden = view === null;
      const headMoved = view !== null && lastHead !== null && view.headId !== lastHead;
      if (headMoved && detailsKey !== null && !(layout.rows[indexOf.get(detailsKey)]?.stepIds.includes(view.headId) ?? false)) {
        const keep = detailsElement?.contains(ownerDocument.activeElement) ?? false;
        if (!keep) closeDetailsNow();
      }
      draw();
      if (view !== null && (lastHead === null || headMoved) && layout.headRow !== -1) {
        scrollToIndex(layout.headRow);
        draw();
      }
      lastHead = view?.headId ?? null;
      return layout;
    },
    get layout() { return layout; },
    selection,
    /** Open the stubs, groups, turn and run holding `stepId`, select its row and scroll to it. */
    reveal(stepId, { details = false } = {}) {
      if (view === null || view.step(stepId) === undefined) return false;
      const plan = revealPlan(view, stepId);
      for (const fork of plan.forks) expandedForks.add(fork);
      for (const group of plan.groups) expandedGroups.add(group);
      relayout();
      let index = rowOfStep(layout.rows, stepId);
      for (let tries = 0; tries < 2 && index !== -1 && layout.rows[index].kind !== 'step'; tries++) {
        setExpanded(layout.rows[index], true);
        index = rowOfStep(layout.rows, stepId);
      }
      if (index === -1) return false;
      focusIndex(index, { scroll: 'center' });
      if (details && detailsKey !== layout.rows[index].key) toggleDetails(layout.rows[index]);
      return true;
    },
    /** Expand or collapse a turn's rows (the chat's "3 steps ↗"). */
    revealTurn(turnId) {
      const index = layout.rows.findIndex(row => row.kind === 'turn' && row.turnId === turnId);
      if (index === -1) return false;
      if (!layout.rows[index].expanded) setExpanded(layout.rows[index], true);
      focusIndex(indexOf.get(layout.rows[index].key), { scroll: 'center' });
      return true;
    },
    /** Expand or collapse the row `key` (a stub, a turn, a group or a run). */
    toggle(key) {
      const row = layout.rows[indexOf.get(key)];
      if (row !== undefined && row.expanded !== null) setExpanded(row, !row.expanded);
    },
    /** Give the keyboard focus to the row `key`. */
    focusRow(key) {
      if (indexOf.has(key)) focusIndex(indexOf.get(key));
    },
    clearSelection() {
      anchorKey = focusKey;
      draw();
    },
    closeDetails: () => closeDetails(false),
    get detailsKey() { return detailsKey; },
    focus() {
      const key = focusKey ?? currentKey();
      if (key !== null && indexOf.has(key)) focusIndex(indexOf.get(key));
    },
    destroy() {
      controller.abort();
      if (frame !== null) cancelAnimationFrame(frame);
      clearInterval(timer);
      resize?.disconnect();
      hideHint();
      hint.remove();
      closeDetailsNow();
      drawn.clear();
      container.replaceChildren();
    },
  };
}
