/**
 * @fileoverview Cell info: a card that describes the cell under the pointer.
 *
 * On by default; the "Show cell info" checkbox in Coloring & filtering turns
 * it off. Hovering a cell in any pane shows its value of the field that pane
 * is coloured by and, for a categorical field, how many cells of that category
 * are visible in the pane: exactly the cells selecting the category would pick.
 *
 * The cost is what decides every rule here, because a million-cell view is the
 * case the card must not slow down:
 *
 * - Picking reuses the viewer's exact per-view pick, which walks the view's
 *   spatial index on panes of 250,000 cells or more
 *   (`INTERACTIVE_SPATIAL_INDEX_POINT_THRESHOLD` in `rendering/viewer.js`).
 *   Those indices are built in a worker in idle time, at any size; smaller
 *   panes are scanned directly.
 * - The per-category counts are one pass over the pane's codes and visibility,
 *   made once and reused until that pane's colouring or visibility changes.
 * - A pointer move only records the position; a lookup runs once the pointer
 *   has rested for REST_MS, never while it sweeps, and none while the camera is
 *   moving or a drag or touch gesture is in progress. A pointer that moved less
 *   than two pixels since the last lookup reuses it.
 * - The card is an absolutely positioned DOM element moved with a transform. It
 *   never asks the scene to redraw.
 * - It reads only data that is already in memory: the pane's colours and the
 *   loaded fields. A hover never loads a field.
 *
 * On a touch screen the card appears on a press held still for a moment, and
 * goes away with the next touch.
 *
 * @module ui/modules/cell-info
 */

import { formatCount, formatCountOf } from '../../../utils/format-units.js';
import { POINT_VISIBILITY_THRESHOLD } from '../../../rendering/alpha-visibility.js';

const PICK_MOVE_THRESHOLD_PX = 2;
// A lookup runs only once the pointer has rested this long, like a tooltip:
// sweeping across the plot does no work at all, so frame time while moving is
// exactly what it is with the card off.
const REST_MS = 60;
// One column of the card. More loaded fields than fit the window's height
// flow into further columns of this width.
const CARD_COLUMN_PX = 240;
const CARD_OFFSET_PX = 16;
const EDGE_MARGIN_PX = 8;
const TOUCH_HOLD_MS = 450;
const TOUCH_HOLD_SLOP_PX = 8;
const MOTION_RECHECK_MS = 120;

function requireElement(value, label) {
  if (!(value instanceof Element)) {
    throw new TypeError(`${label} must be an element.`);
  }
  return value;
}

function requireMethods(owner, label, names) {
  if (owner === null || typeof owner !== 'object') {
    throw new TypeError(`${label} must be an object.`);
  }
  for (const name of names) {
    if (typeof owner[name] !== 'function') {
      throw new TypeError(`${label}.${name} must be a function.`);
    }
  }
  return owner;
}

/** Four significant figures, scientific notation outside 0.001 to 100,000. */
export function formatCellValue(value) {
  if (!Number.isFinite(value)) return 'NaN';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 100000 || abs < 0.001) {
    return value.toExponential(2).replace(/\.?0+e/, 'e').replace('e+', 'e');
  }
  return String(Number(value.toPrecision(4)));
}

function categoryLabel(field, cellIndex) {
  const code = field.codes[cellIndex];
  const categories = field.categories;
  if (!(code >= 0 && code < categories.length)) return null;
  const label = categories[code];
  return typeof label === 'string' ? label : String(label);
}

function cssColor(colors, cellIndex) {
  if (!(colors instanceof Uint8Array) || colors.length < (cellIndex + 1) * 4) {
    return null;
  }
  const j = cellIndex * 4;
  return `rgb(${colors[j]}, ${colors[j + 1]}, ${colors[j + 2]})`;
}

function categoryColor(field, code) {
  const rgb = Array.isArray(field._categoryColors) ? field._categoryColors[code] : null;
  if (!Array.isArray(rgb) || rgb.length < 3) return null;
  const channel = (value) => Math.round(Math.min(1, Math.max(0, value)) * 255);
  return `rgb(${channel(rgb[0])}, ${channel(rgb[1])}, ${channel(rgb[2])})`;
}

function createCard(ownerDocument) {
  const el = (tag, className) => {
    const node = ownerDocument.createElement(tag);
    if (className) node.className = className;
    return node;
  };
  const card = el('div', 'cell-info-card');
  card.id = 'cell-info-card';
  // The card repeats what the pointer already shows; a screen reader user
  // reaches the same values through the legend and the field selectors.
  card.setAttribute('aria-hidden', 'true');
  card.hidden = true;

  const head = el('div', 'cell-info-head');
  const swatch = el('span', 'cell-info-swatch');
  const value = el('span', 'cell-info-value');
  const count = el('span', 'cell-info-count');
  head.append(swatch, value, count);
  const field = el('div', 'cell-info-field');

  const scale = el('div', 'cell-info-scale');
  const scaleBar = el('div', 'cell-info-scale-bar');
  const scaleMarker = el('span', 'cell-info-scale-marker');
  scaleBar.append(scaleMarker);
  const scaleEnds = el('div', 'cell-info-scale-ends');
  const scaleMin = el('span');
  const scaleMax = el('span');
  scaleEnds.append(scaleMin, scaleMax);
  scale.append(scaleBar, scaleEnds);

  const rows = el('dl', 'cell-info-rows');
  rows.hidden = true;
  // Shown only when the window cannot fit every loaded field, naming how
  // many are left out.
  const more = el('p', 'cell-info-more');
  more.hidden = true;

  card.append(head, field, scale, rows, more);
  return {
    card, swatch, value, field, scale, scaleBar, scaleMarker, scaleMin, scaleMax,
    rows, more, count
  };
}

/**
 * @param {object} options
 * @param {object} options.viewer - Needs pickReadyCellRecordAtScreen,
 *   isCameraInMotion and prepareCellPicking.
 * @param {object} options.state - The data state.
 * @param {HTMLInputElement} options.toggle - The Show cell info checkbox.
 * @param {HTMLInputElement} options.categoriesToggle - Also list the cell's
 *   other loaded categories.
 * @param {HTMLCanvasElement} options.canvas - The plot canvas.
 */
export function initCellInfo({ viewer, state, toggle, categoriesToggle, canvas }) {
  requireMethods(viewer, 'Cell info viewer', [
    'pickReadyCellRecordAtScreen',
    'isCameraInMotion',
    'onPresentedViewStateChanged',
    'prepareCellPicking'
  ]);
  if (state === null || typeof state !== 'object') {
    throw new TypeError('Cell info requires the data state.');
  }
  requireElement(toggle, 'Cell info checkbox');
  requireElement(categoriesToggle, 'Cell info categories checkbox');
  requireElement(canvas, 'Cell info canvas');
  if (toggle.type !== 'checkbox') {
    throw new TypeError('The Cell info control must be a checkbox.');
  }

  const ownerDocument = canvas.ownerDocument;
  const view = ownerDocument.defaultView;
  const parts = createCard(ownerDocument);
  ownerDocument.body.appendChild(parts.card);

  let enabled = false;
  let destroyed = false;
  let frameHandle = 0;
  let idleHandle = 0;
  let motionTimer = 0;
  let holdTimer = 0;
  let pointer = null; // { x, y, type }
  let lastPick = null; // { x, y, viewId, cellIndex }
  // A spot that held no cell, and the scene it was looked up in. The scene
  // can change under a still pointer (inertia, a key, Reset camera, a new
  // layout), so a miss is only remembered for the scene it was made in: the
  // viewer announces every such change, and each one moves the generation.
  let lastMiss = null; // { x, y, sceneGeneration }
  let sceneGeneration = 0;
  let shownKey = '';
  let cardSize = { width: 0, height: 0 };
  let suppressedByPress = false;
  let touchHold = null; // { x, y, pointerId }
  // A finger held still owns the card: the viewer counts a resting finger as
  // a camera drag, but nothing moves until the finger does, and a move past
  // the slop takes the card away.
  let touchCard = false;

  function hide() {
    touchCard = false;
    if (!parts.card.hidden) {
      parts.card.classList.remove('is-visible');
      parts.card.hidden = true;
    }
    shownKey = '';
    lastPick = null;
  }

  function cancelFrame() {
    if (frameHandle !== 0) {
      view.cancelAnimationFrame(frameHandle);
      frameHandle = 0;
    }
  }

  function scheduleFrame() {
    if (frameHandle === 0 && enabled && !destroyed) {
      frameHandle = view.requestAnimationFrame(onFrame);
    }
  }

  function scheduleMotionRecheck() {
    if (motionTimer !== 0) return;
    motionTimer = view.setTimeout(() => {
      motionTimer = 0;
      scheduleFrame();
    }, MOTION_RECHECK_MS);
  }

  // The card is on by default, so large panes get their lookup index from a
  // worker (viewer.prepareCellPicking): nothing is built on the main thread,
  // at any size. Until a pane's index arrives, its lookups answer null and the
  // card simply does not show there.
  function prepare() {
    if (idleHandle !== 0) return;
    const run = () => {
      idleHandle = 0;
      if (!enabled || destroyed) return;
      viewer.prepareCellPicking();
    };
    idleHandle = typeof view.requestIdleCallback === 'function'
      ? view.requestIdleCallback(run, { timeout: 1000 })
      : view.setTimeout(run, 0);
  }

  function cancelIdle() {
    if (idleHandle === 0) return;
    if (typeof view.cancelIdleCallback === 'function') view.cancelIdleCallback(idleHandle);
    else view.clearTimeout(idleHandle);
    idleHandle = 0;
  }

  function viewColors(viewId) {
    if (String(viewId) === String(state.activeViewId)) return state.colorsArray ?? null;
    return state.viewContexts?.get?.(String(viewId))?.colorsArray ?? null;
  }

  function fillScale(field, cellIndex) {
    if (field.kind !== 'continuous' || typeof state.getContinuousColorDomain !== 'function') {
      parts.scale.hidden = true;
      return;
    }
    const value = field.values[cellIndex];
    const domain = state.getContinuousColorDomain(field);
    const colormaps = typeof state.getContinuousColormaps === 'function'
      ? state.getContinuousColormaps()
      : [];
    const colormap = colormaps.find((entry) => entry.id === field._colormapId) ?? colormaps[0];
    if (!colormap || !Number.isFinite(domain?.min) || !Number.isFinite(domain?.max)) {
      parts.scale.hidden = true;
      return;
    }
    const useLog = domain.scale === 'log';
    let t = 0.5;
    if (Number.isFinite(value) && !(useLog && value <= 0)) {
      const lo = useLog ? Math.log10(domain.min) : domain.min;
      const hi = useLog ? Math.log10(domain.max) : domain.max;
      const v = useLog ? Math.log10(value) : value;
      t = hi === lo ? 0.5 : Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
    }
    parts.scaleBar.style.setProperty('--cell-info-stops', colormap.cssStops.join(', '));
    parts.scaleMarker.style.setProperty('--cell-info-t', String(t));
    parts.scaleMin.textContent = formatCellValue(domain.min);
    parts.scaleMax.textContent = formatCellValue(domain.max);
    parts.scale.hidden = false;
  }

  // Visible cells per category in one pane, for the field it is coloured by.
  // A count is one pass over every cell (tens of milliseconds at ten million),
  // so it never runs on the hover path: a hover reads a finished count or asks
  // for one in idle time, and the card fills the number in when it is ready.
  // A count is kept until the field, its codes or the pane's visibility array
  // changes; a field or visibility change also clears it through refresh().
  let countsMemo = null;
  let countIdleHandle = 0;

  function countsMatch(memo, viewId, field, transparency) {
    return memo !== null && memo.viewId === viewId && memo.field === field
      && memo.codes === field.codes && memo.transparency === transparency;
  }

  function visibleCategoryCounts(viewId, field) {
    const transparency = typeof viewer.getViewTransparency === 'function'
      ? viewer.getViewTransparency(viewId)
      : null;
    if (!transparency || !field.codes) return null;
    if (countsMatch(countsMemo, viewId, field, transparency)) return countsMemo.counts;
    if (countIdleHandle !== 0) return null;
    const run = () => {
      countIdleHandle = 0;
      if (!enabled || destroyed) return;
      const codes = field.codes;
      const current = viewer.getViewTransparency(viewId);
      if (!codes || current !== transparency) return;
      const counts = new Uint32Array(field.categories.length);
      const n = Math.min(codes.length, current.length);
      for (let i = 0; i < n; i++) {
        const code = codes[i];
        if (code < counts.length && current[i] >= POINT_VISIBILITY_THRESHOLD) counts[code]++;
      }
      countsMemo = { viewId, field, codes, transparency: current, counts };
      // Fill the number into the card still showing this pane. A resting
      // pointer runs no new lookup, so the card is refilled here directly.
      if (!parts.card.hidden && lastPick !== null && lastPick.viewId === viewId) {
        shownKey = '';
        show({ viewId, cellIndex: lastPick.cellIndex }, lastPick.x, lastPick.y);
      }
    };
    countIdleHandle = typeof view.requestIdleCallback === 'function'
      ? view.requestIdleCallback(run, { timeout: 500 })
      : view.setTimeout(run, 0);
    return null;
  }

  function cancelCountIdle() {
    if (countIdleHandle === 0) return;
    if (typeof view.cancelIdleCallback === 'function') view.cancelIdleCallback(countIdleHandle);
    else view.clearTimeout(countIdleHandle);
    countIdleHandle = 0;
  }

  // Optional: the cell's label in every other categorical field already in
  // memory (never fetched).
  function fillRows(primary, cellIndex) {
    parts.more.hidden = true;
    if (!categoriesToggle.checked) {
      parts.rows.replaceChildren();
      parts.rows.hidden = true;
      return;
    }
    const fields = state.obsData?.fields ?? [];
    const rows = [];
    for (const field of fields) {
      if (
        !field || field === primary || field._isDeleted === true
        || field.kind !== 'category' || !Array.isArray(field.categories)
        // Codes exist only once a field is loaded; an unloaded field is
        // skipped, never fetched.
        || !field.codes || field.codes.length <= cellIndex
      ) {
        continue;
      }
      const label = categoryLabel(field, cellIndex);
      rows.push({ key: field.key, label, color: label === null ? null : categoryColor(field, field.codes[cellIndex]) });
    }
    const fragment = ownerDocument.createDocumentFragment();
    for (const row of rows) {
      // A dt/dd pair is wrapped so a column break never separates the two.
      const pair = ownerDocument.createElement('div');
      pair.className = 'cell-info-row';
      const dt = ownerDocument.createElement('dt');
      dt.textContent = row.key;
      const dd = ownerDocument.createElement('dd');
      if (row.color) {
        const dot = ownerDocument.createElement('span');
        dot.className = 'cell-info-dot';
        dot.style.background = row.color;
        dd.append(dot);
      }
      dd.append(row.label ?? 'missing');
      if (row.label === null) dd.classList.add('is-missing');
      pair.append(dt, dd);
      fragment.append(pair);
    }
    parts.rows.replaceChildren(fragment);
    parts.rows.hidden = rows.length === 0;
  }

  function fill(record) {
    const { viewId, cellIndex } = record;
    const field = typeof state.getFieldForView === 'function'
      ? state.getFieldForView(viewId)
      : null;
    const color = cssColor(viewColors(viewId), cellIndex);
    parts.swatch.style.background = color ?? '';
    parts.swatch.hidden = color === null;

    if (field && field.kind === 'category' && field.codes && field.codes.length > cellIndex) {
      const label = categoryLabel(field, cellIndex);
      parts.value.textContent = label ?? 'missing';
      parts.value.classList.toggle('is-missing', label === null);
      parts.field.textContent = field.key;
      parts.scale.hidden = true;
      const code = field.codes[cellIndex];
      const counts = label === null ? null : visibleCategoryCounts(viewId, field);
      parts.count.textContent = counts ? `${formatCountOf(counts[code], 'cell')}` : '';
    } else if (field && field.kind === 'continuous' && field.values && field.values.length > cellIndex) {
      const value = field.values[cellIndex];
      parts.value.textContent = formatCellValue(value);
      parts.value.classList.toggle('is-missing', !Number.isFinite(value));
      parts.field.textContent = field.key;
      fillScale(field, cellIndex);
      parts.count.textContent = '';
    } else {
      parts.value.textContent = 'Cell';
      parts.value.classList.remove('is-missing');
      parts.field.textContent = 'No field selected';
      parts.scale.hidden = true;
      parts.count.textContent = '';
    }
    fillRows(field, cellIndex);
    parts.count.hidden = parts.count.textContent === '';
  }

  function fitCard() {
    const { card, rows, more } = parts;
    card.style.setProperty('--cell-info-columns', '1');
    let size = { width: card.offsetWidth, height: card.offsetHeight };
    const available = view.innerHeight - 2 * EDGE_MARGIN_PX;
    if (size.height <= available || rows.hidden) return size;

    const pairs = Array.from(rows.children);
    const rowsHeight = rows.offsetHeight;
    const fixedHeight = size.height - rowsHeight;
    const rowHeight = rowsHeight / pairs.length;
    const maxColumns = Math.max(
      1,
      Math.floor((view.innerWidth - 2 * EDGE_MARGIN_PX) / CARD_COLUMN_PX)
    );
    const perColumn = Math.max(1, Math.floor((available - fixedHeight) / rowHeight));
    const columns = Math.min(maxColumns, Math.ceil(pairs.length / perColumn));
    // The window is the only limit: rows beyond what every column can hold
    // are named, never dropped silently.
    const capacity = columns * perColumn;
    if (pairs.length > capacity) {
      const kept = Math.max(0, capacity - 1);
      for (const pair of pairs.slice(kept)) pair.remove();
      more.textContent = `+${formatCount(pairs.length - kept)} more loaded fields (no room in the window)`;
      more.hidden = false;
    }
    card.style.setProperty('--cell-info-columns', String(columns));
    size = { width: card.offsetWidth, height: card.offsetHeight };
    return size;
  }

  function place(x, y) {
    const vw = view.innerWidth;
    const vh = view.innerHeight;
    let left = x + CARD_OFFSET_PX;
    let top = y + CARD_OFFSET_PX;
    if (left + cardSize.width + EDGE_MARGIN_PX > vw) left = x - CARD_OFFSET_PX - cardSize.width;
    if (top + cardSize.height + EDGE_MARGIN_PX > vh) top = y - CARD_OFFSET_PX - cardSize.height;
    left = Math.max(EDGE_MARGIN_PX, left);
    top = Math.max(EDGE_MARGIN_PX, top);
    parts.card.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  function show(record, x, y) {
    const key = `${record.viewId}:${record.cellIndex}`;
    if (key !== shownKey) {
      fill(record);
      const wasHidden = parts.card.hidden;
      parts.card.hidden = false;
      // One layout read per changed cell: the size decides which side of the
      // pointer the card goes on. A card taller than the window takes more
      // columns (a second read, only then).
      cardSize = fitCard();
      shownKey = key;
      if (wasHidden) {
        place(x, y);
        // Start the fade from the placed position, not from the corner.
        view.requestAnimationFrame(() => {
          if (shownKey === key) parts.card.classList.add('is-visible');
        });
        return;
      }
    }
    place(x, y);
  }

  function onFrame() {
    frameHandle = 0;
    if (!enabled || destroyed) return;
    if (pointer === null || suppressedByPress) {
      hide();
      return;
    }
    if (!touchCard && viewer.isCameraInMotion()) {
      hide();
      scheduleMotionRecheck();
      return;
    }
    const { x, y } = pointer;
    if (
      lastMiss !== null
      && lastMiss.sceneGeneration === sceneGeneration
      && Math.abs(x - lastMiss.x) < PICK_MOVE_THRESHOLD_PX
      && Math.abs(y - lastMiss.y) < PICK_MOVE_THRESHOLD_PX
    ) {
      // The same empty spot of the same scene: looking again finds nothing.
      return;
    }
    if (
      lastPick !== null
      && Math.abs(x - lastPick.x) < PICK_MOVE_THRESHOLD_PX
      && Math.abs(y - lastPick.y) < PICK_MOVE_THRESHOLD_PX
    ) {
      if (!parts.card.hidden && !touchCard) {
        // Still on the same spot: keep watching the camera so a key press or
        // inertia started under a resting pointer takes the card away.
        scheduleMotionRecheck();
      }
      return;
    }
    // Never builds a large pane's index on the hover path: without one the
    // lookup answers null and the card waits.
    const record = viewer.pickReadyCellRecordAtScreen(x, y);
    if (record === null) {
      lastMiss = { x, y, sceneGeneration };
      hide();
      return;
    }
    lastMiss = null;
    lastPick = { x, y, viewId: record.viewId, cellIndex: record.cellIndex };
    show(record, x, y);
    if (!touchCard) scheduleMotionRecheck();
  }

  let restTimer = 0;
  function cancelRest() {
    if (restTimer === 0) return;
    view.clearTimeout(restTimer);
    restTimer = 0;
  }

  function onPointerMove(event) {
    if (!enabled || event.pointerType === 'touch') return;
    // A move with no button held means the press is over, even if its release
    // never reached us; the card must not stay suppressed for good.
    if (suppressedByPress && event.buttons === 0) suppressedByPress = false;
    pointer = { x: event.clientX, y: event.clientY };
    // Moving off the cell the card describes takes it away until the next rest.
    if (
      !parts.card.hidden && lastPick !== null
      && (Math.abs(pointer.x - lastPick.x) >= PICK_MOVE_THRESHOLD_PX
        || Math.abs(pointer.y - lastPick.y) >= PICK_MOVE_THRESHOLD_PX)
    ) {
      hide();
    }
    cancelRest();
    restTimer = view.setTimeout(() => {
      restTimer = 0;
      scheduleFrame();
    }, REST_MS);
  }

  function onPointerLeave(event) {
    if (event.pointerType === 'touch') return;
    pointer = null;
    hide();
  }

  function clearHold() {
    if (holdTimer !== 0) {
      view.clearTimeout(holdTimer);
      holdTimer = 0;
    }
    touchHold = null;
  }

  function onPointerDown(event) {
    if (!enabled) return;
    hide();
    if (event.pointerType === 'touch') {
      pointer = null;
      clearHold();
      touchHold = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
      holdTimer = view.setTimeout(() => {
        holdTimer = 0;
        if (touchHold === null || !enabled) return;
        pointer = { x: touchHold.x, y: touchHold.y };
        lastPick = null;
        lastMiss = null;
        touchCard = true;
        scheduleFrame();
      }, TOUCH_HOLD_MS);
      return;
    }
    suppressedByPress = true;
  }

  function onPointerMoveTouch(event) {
    if (touchHold === null || event.pointerId !== touchHold.pointerId) return;
    if (
      Math.abs(event.clientX - touchHold.x) > TOUCH_HOLD_SLOP_PX
      || Math.abs(event.clientY - touchHold.y) > TOUCH_HOLD_SLOP_PX
    ) {
      clearHold();
      pointer = null;
      hide();
    }
  }

  function onPointerUp(event) {
    if (event.pointerType === 'touch') {
      // A held press keeps its card until the next touch; a short tap had
      // its timer cleared here and never shows one.
      if (holdTimer !== 0) clearHold();
      else touchHold = null;
      return;
    }
    suppressedByPress = false;
    lastPick = null;
    if (pointer !== null) scheduleFrame();
  }

  function onScrollOrWheel() {
    hide();
    if (pointer !== null) scheduleMotionRecheck();
  }

  function setEnabled(next) {
    // The option only means something while the card is on.
    categoriesToggle.disabled = !next;
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      prepare();
    } else {
      cancelIdle();
      cancelCountIdle();
      cancelRest();
      cancelFrame();
      clearHold();
      pointer = null;
      hide();
    }
  }

  const listeners = [];
  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  }

  listen(toggle, 'change', () => setEnabled(toggle.checked === true));
  listen(categoriesToggle, 'change', () => refresh());
  listen(canvas, 'pointermove', onPointerMove, { passive: true });
  listen(canvas, 'pointermove', onPointerMoveTouch, { passive: true });
  listen(canvas, 'pointerleave', onPointerLeave, { passive: true });
  listen(canvas, 'pointerdown', onPointerDown, { passive: true });
  // Capture phase: a selection tool that captures the pointer and stops the
  // release from bubbling would otherwise leave the card suppressed for good.
  listen(view, 'pointerup', onPointerUp, { passive: true, capture: true });
  listen(view, 'pointercancel', onPointerUp, { passive: true, capture: true });
  listen(canvas, 'wheel', onScrollOrWheel, { passive: true });
  listen(view, 'blur', () => { pointer = null; hide(); });

  // Views are added, removed and re-dimensioned while the card is on; each
  // of those can present a pane whose index is not built yet.
  const prepareAgain = () => {
    if (!enabled) return;
    prepare();
    refresh();
  };
  // A recoloured or refiltered pane changes what the resting card says.
  function refresh() {
    countsMemo = null;
    cancelCountIdle();
    if (!enabled) return;
    shownKey = '';
    lastPick = null;
    lastMiss = null;
    if (pointer !== null) scheduleFrame();
  }
  listeners.push(viewer.onPresentedViewStateChanged(() => {
    sceneGeneration += 1;
  }));
  const stateEvents = [
    ['view:representation-changed', prepareAgain],
    ['visibility:changed', prepareAgain],
    ['field:changed', refresh]
  ];
  if (typeof state.on === 'function') {
    for (const [name, handler] of stateEvents) state.on(name, handler);
    listeners.push(() => {
      for (const [name, handler] of stateEvents) state.off(name, handler);
    });
  }

  setEnabled(toggle.checked === true);

  return {
    isEnabled: () => enabled,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      setEnabled(false);
      if (motionTimer !== 0) view.clearTimeout(motionTimer);
      for (const remove of listeners.splice(0)) remove();
      parts.card.remove();
    }
  };
}
