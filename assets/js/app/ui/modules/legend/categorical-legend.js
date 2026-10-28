/**
 * @fileoverview Categorical legend rendering + interactions.
 *
 * Owns the categorical legend UI: category visibility checkboxes, color picker,
 * rename/delete operations, and drag-to-merge behavior.
 *
 * @module ui/modules/legend/categorical-legend
 */

import { StyleManager } from '../../../../utils/style-manager.js';
import { getNotificationCenter } from '../../../notification-center.js';
import { InlineEditor } from '../../components/inline-editor.js';
import { showConfirmDialog } from '../../components/confirm-dialog.js';
import { FieldKind, FieldSource } from '../../../utils/field-constants.js';
import { StateValidator } from '../../../utils/state-validator.js';
import { getCommunityAnnotationSession } from '../../../community-annotations/session.js';
import { syncCommunityAnnotationCacheContext } from '../../../community-annotations/runtime-context.js';
import {
  getCommunityAnnotationAccessStore,
  isAnnotationRepoConnected
} from '../../../community-annotations/access-store.js';
import { ANNOTATION_CONNECTION_CHANGED_EVENT } from '../../../community-annotations/connection-events.js';
import { openCommunityAnnotationVotingModal } from '../community-annotation-voting-modal.js';
import {
  createKeyboardMove,
  getKeyboardMoveInstructionsId
} from '../../keyboard-move.js';
import {
  ICONS,
  coalesceToFrame,
  createButton,
  createIconButton
} from '../../components/controls.js';
import { formatCount, formatCountOf, formatOpenCells } from '../../../../utils/format-units.js';
import { requireExactKeys, requirePlainRecord } from '../../../../utils/exact-record.js';

const CATEGORY_DRAG_MIME = 'application/x-cellucid-category';
const INIT_KEYS = new Set(['state', 'legendEl', 'dataSourceManager']);
const REQUIRED_STATE_METHODS = [
  'addHighlightFromCategory',
  'deleteCategoryToUnassigned',
  'findHighlightGroupByCategory',
  'getActiveField',
  'getDatasetGeneration',
  'getFields',
  'getLegendModel',
  'hideAllCategories',
  'mergeCategoriesToNewField',
  'on',
  'removeHighlightGroup',
  'renameCategory',
  'rgbToCss',
  'setColorForCategory',
  'setVisibilityForCategory',
  'showAllCategories'
];
const CATEGORY_TYPE_ORDER = new Map([
  ['boolean', 0],
  ['number', 1],
  ['string', 2]
]);

function requireMethod(owner, methodName, label) {
  if (
    owner === null
    || typeof owner !== 'object'
    || typeof owner[methodName] !== 'function'
  ) {
    throw new TypeError(`${label} must implement ${methodName}()`);
  }
}

function requireExactIndex(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function parseExactIndex(value, label) {
  if (
    typeof value !== 'string'
    || !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    throw new TypeError(`${label} must be a canonical non-negative integer`);
  }
  return requireExactIndex(Number(value), label);
}

function requireTrimmedString(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
  ) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function formatCategoryLabel(value) {
  StateValidator.validateCategoryLabel(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();
  return value ? 'true' : 'false';
}

/**
 * Order two category labels. Both have already passed
 * `requireCategoricalLegendModel`, which validates every label once, so the
 * comparison does not validate them again on each of the n log n calls.
 */
function compareValidatedCategoryLabels(left, right) {
  const leftType = typeof left;
  const rightType = typeof right;
  const typeDifference = (
    CATEGORY_TYPE_ORDER.get(leftType) - CATEGORY_TYPE_ORDER.get(rightType)
  );
  if (typeDifference !== 0) return typeDifference;
  if (leftType === 'boolean') {
    return left === right ? 0 : left ? 1 : -1;
  }
  if (leftType === 'number') return left - right;
  return left < right ? -1 : left > right ? 1 : 0;
}

function computeTopConsensusSummary(session, fieldKey, catIdx) {
  const suggestions = session.getSuggestions(fieldKey, catIdx);
  if (!Array.isArray(suggestions)) {
    throw new TypeError('Community annotation suggestions must be an array');
  }
  if (!suggestions.length) return null;
  let bestNet = null;
  for (const s of suggestions) {
    if (
      s === null
      || typeof s !== 'object'
      || Array.isArray(s)
      || !Array.isArray(s.upvotes)
      || !Array.isArray(s.downvotes)
    ) {
      throw new TypeError(
        'Community annotation suggestion requires exact vote arrays'
      );
    }
    const up = s.upvotes.length;
    const down = s.downvotes.length;
    requireTrimmedString(s.label, 'Annotation suggestion label');
    for (const user of s.upvotes) {
      requireTrimmedString(user, 'Annotation upvote identity');
    }
    for (const user of s.downvotes) {
      requireTrimmedString(user, 'Annotation downvote identity');
    }
    const net = up - down;
    if (bestNet === null || net > bestNet) bestNet = net;
  }
  if (bestNet === null) {
    throw new Error('Annotation consensus lost its suggestion score');
  }
  const labels = [];
  const seen = new Set();
  const upSet = new Set();
  const downSet = new Set();
  for (const s of suggestions) {
    const up = s.upvotes.length;
    const down = s.downvotes.length;
    const net = up - down;
    if (net !== bestNet) continue;
    for (const user of s.upvotes) {
      upSet.add(requireTrimmedString(user, 'Annotation upvote identity'));
    }
    for (const user of s.downvotes) {
      downSet.add(requireTrimmedString(user, 'Annotation downvote identity'));
    }
    const label = requireTrimmedString(s.label, 'Annotation suggestion label');
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  if (labels.length === 0) {
    throw new Error('Annotation consensus requires a top-scoring label');
  }
  const names = labels.join(', ');
  return { names, up: upSet.size, down: downSet.size };
}

function rgbToHex(color) {
  if (
    !Array.isArray(color)
    || color.length !== 3
    || color.some(channel => (
      !Number.isFinite(channel) || channel < 0 || channel > 1
    ))
  ) {
    throw new TypeError('Legend color must be an exact RGB triplet from 0 through 1');
  }
  const toChannel = value => Math.round(value * 255);
  const r = toChannel(color[0]);
  const g = toChannel(color[1]);
  const b = toChannel(color[2]);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function hexToRgb01(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new TypeError('Legend color input must be an exact #RRGGBB value');
  }
  const normalized = hex.slice(1);
  const r = parseInt(normalized.slice(0, 2), 16) / 255;
  const g = parseInt(normalized.slice(2, 4), 16) / 255;
  const b = parseInt(normalized.slice(4, 6), 16) / 255;
  return [r, g, b];
}

function validateCategoryLabel(nextValue) {
  if (typeof nextValue !== 'string') return 'Label must be a string';
  const value = nextValue;
  if (!value) return 'Label cannot be empty';
  try {
    StateValidator.validateCategoryLabel(value);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return err.message;
  }
  return true;
}

function requireCategoryCounts(visibleCount, availableCount) {
  if (
    !Number.isSafeInteger(visibleCount)
    || visibleCount < 0
    || !Number.isSafeInteger(availableCount)
    || availableCount < 0
    || visibleCount > availableCount
  ) {
    throw new TypeError(
      'Legend counts must be non-negative safe integers with visible at most available'
    );
  }
}

function formatCategoryCount(visibleCount, availableCount) {
  requireCategoryCounts(visibleCount, availableCount);
  if (availableCount > 0 && availableCount !== visibleCount) {
    return `${formatCount(visibleCount)} / ${formatCountOf(availableCount, 'cell')}`;
  }
  return `${formatCountOf(visibleCount, 'cell')}`;
}

/**
 * What the legend's counts are of, said only on a subsample: the open cells
 * of every cell of the dataset (`formatOpenCells`); '' when every cell is
 * open.
 *
 * @param {{pointCount?: number, cellIdentity?: {nOriginal?: number}|null}} state
 * @returns {string}
 */
export function describeCountedCells(state) {
  const open = state.pointCount ?? 0;
  const total = state.cellIdentity?.nOriginal ?? open;
  return total === open ? '' : `Counted on the ${formatOpenCells(open, total)} open.`;
}

/** Write text only when it changed, so an unchanged row is not relaid out. */
function setTextIfChanged(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

const NO_CELLS_TITLE = 'No cells available in this category after other filters';

/**
 * A legend with more categories than this builds only the rows in view (plus
 * `VIRTUAL_OVERSCAN_ROWS` on each side) and rebuilds them as the list
 * scrolls, so a field with a million categories (barcodes, uint32 codes)
 * costs the same DOM as one with a hundred. Rows are one line high.
 */
const VIRTUAL_LIST_MIN_ROWS = 400;
const VIRTUAL_OVERSCAN_ROWS = 24;
const VIRTUAL_INITIAL_ROWS = 64;

function parseCategoryDragPayload(dataTransfer) {
  if (
    dataTransfer === null
    || typeof dataTransfer !== 'object'
    || typeof dataTransfer.getData !== 'function'
  ) {
    throw new TypeError('Category merge requires DataTransfer');
  }
  const payload = JSON.parse(dataTransfer.getData(CATEGORY_DRAG_MIME));
  if (
    payload === null
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || Object.keys(payload).length !== 1
    || !Object.hasOwn(payload, 'catIdx')
    || !Number.isSafeInteger(payload.catIdx)
    || payload.catIdx < 0
  ) {
    throw new TypeError(
      'Category merge payload requires one non-negative integer catIdx'
    );
  }
  return payload;
}

function requireCategoricalLegendModel(field, model) {
  if (
    field === null
    || typeof field !== 'object'
    || field.kind !== FieldKind.CATEGORY
    || typeof field.key !== 'string'
    || field.key.length === 0
    || field.key !== field.key.trim()
    || !Array.isArray(field.categories)
    || model === null
    || typeof model !== 'object'
    || model.kind !== FieldKind.CATEGORY
    || model.categories !== field.categories
    || model.categories.length === 0
    || !Array.isArray(model.colors)
    || model.colors.length !== model.categories.length
    || model.counts === null
    || typeof model.counts !== 'object'
    || Array.isArray(model.counts)
    || Object.getPrototypeOf(model.counts) !== Object.prototype
    || Object.keys(model.counts).sort().join(',') !==
      'available,availableTotal,total,visible,visibleTotal'
    || !Array.isArray(model.counts.total)
    || !Array.isArray(model.counts.visible)
    || !Array.isArray(model.counts.available)
    || model.counts.total.length !== model.categories.length
    || model.counts.visible.length !== model.categories.length
    || model.counts.available.length !== model.categories.length
    || model.visible === null
    || typeof model.visible !== 'object'
    || Array.isArray(model.visible)
    || Object.getPrototypeOf(model.visible) !== Object.prototype
    || Object.keys(model.visible).length !== model.categories.length
  ) {
    throw new TypeError(
      'Categorical legend requires an exact category field and complete model'
    );
  }
  let totalCount = 0;
  let availableTotal = 0;
  let visibleTotal = 0;
  for (let index = 0; index < model.categories.length; index++) {
    StateValidator.validateCategoryLabel(model.categories[index]);
    rgbToHex(model.colors[index]);
    if (!Object.hasOwn(model.visible, index)) {
      throw new TypeError(
        `Category visibility ${index} must be present exactly once`
      );
    }
    if (model.visible[index] !== true && model.visible[index] !== false) {
      throw new TypeError(`Category visibility ${index} must be exactly boolean`);
    }
    requireCategoryCounts(
      model.counts.visible[index],
      model.counts.available[index]
    );
    const total = model.counts.total[index];
    if (
      !Number.isSafeInteger(total)
      || total < model.counts.available[index]
    ) {
      throw new TypeError(
        `Category total count ${index} must contain its available count`
      );
    }
    totalCount += total;
    availableTotal += model.counts.available[index];
    visibleTotal += model.counts.visible[index];
  }
  if (
    model.counts.availableTotal !== availableTotal
    || model.counts.visibleTotal !== visibleTotal
    || totalCount > Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError(
      'Categorical legend count totals must match their category arrays'
    );
  }
  return model;
}

export function initCategoricalLegend(options) {
  requireExactKeys(options, INIT_KEYS, 'Categorical legend options');
  const { state, legendEl, dataSourceManager } = options;
  for (const methodName of REQUIRED_STATE_METHODS) {
    requireMethod(state, methodName, 'Categorical legend state');
  }
  requireMethod(
    dataSourceManager,
    'getCurrentIdentityId',
    'Categorical legend dataSourceManager'
  );
  const ownerDocument = (
    legendEl !== null
    && typeof legendEl === 'object'
  )
    ? legendEl.ownerDocument
    : null;
  const view = ownerDocument === null
    ? null
    : ownerDocument.defaultView;
  if (
    view === null
    || view === undefined
    || !(legendEl instanceof view.HTMLElement)
  ) {
    throw new TypeError(
      'Categorical legend legendEl must be an attached-document HTMLElement'
    );
  }

  const annotationSession = getCommunityAnnotationSession();
  const access = getCommunityAnnotationAccessStore();
  for (const methodName of [
    'getSuggestions',
    'isFieldAnnotated',
    'on',
    'setFieldCategories'
  ]) {
    requireMethod(
      annotationSession,
      methodName,
      'Community annotation session'
    );
  }
  requireMethod(access, 'on', 'Community annotation access store');
  const lifecycle = new AbortController();
  const transientClosers = new Set();
  let destroyed = false;

  function readDatasetGeneration() {
    const generation = state.getDatasetGeneration();
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new TypeError(
        'Categorical legend dataset generation must be a non-negative safe integer'
      );
    }
    return generation;
  }

  function ownTransient(close) {
    if (typeof close !== 'function') {
      throw new TypeError(
        'Categorical legend transient closer must be a function'
      );
    }
    transientClosers.add(close);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      transientClosers.delete(close);
    };
  }

  function closeTransientInteractions() {
    const closers = [...transientClosers];
    transientClosers.clear();
    const failures = [];
    for (const close of closers) {
      try {
        close();
      } catch (error) {
        failures.push(
          error instanceof Error
            ? error
            : new TypeError(
                'Categorical legend transient cleanup failed with a non-Error value'
              )
        );
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'Categorical legend transient cleanup failed'
      );
    }
  }

  function isCapturedCategoryCurrent({
    categories,
    datasetGeneration,
    field,
    fieldIndex
  }) {
    if (
      destroyed
      || readDatasetGeneration() !== datasetGeneration
      || state.activeFieldSource !== FieldSource.OBS
      || state.activeFieldIndex !== fieldIndex
    ) {
      return false;
    }
    const fields = state.getFields();
    if (!Array.isArray(fields) || fields[fieldIndex] !== field) {
      return false;
    }
    return categories.every(({ index, value }) => (
      field.categories[index] === value
    ));
  }

  const isCommunityAnnotationUiEnabled = () => {
    const ctx = syncCommunityAnnotationCacheContext({ dataSourceManager });
    const connected = isAnnotationRepoConnected(ctx.datasetId, ctx.userKey);
    if (typeof connected !== 'boolean') {
      throw new TypeError(
        'Annotation repository connection state must be boolean'
      );
    }
    return connected;
  };
  syncCommunityAnnotationCacheContext({ dataSourceManager });

  // Guard to prevent re-entry during render
  let isRendering = false;

  // A category highlight collects the category's currently drawn cells, so
  // its button is available exactly when the category has a visible cell.
  // Gating it on "available" (which ignores the category's own checkbox)
  // enabled ◉ on a hidden category, and the click then threw.
  const syncCategoryHighlightButton = (
    highlightBtn,
    catIdx,
    hasCells
  ) => {
    if (!(highlightBtn instanceof view.HTMLButtonElement)) {
      throw new TypeError(
        'Category highlight state requires its exact button'
      );
    }
    requireExactIndex(catIdx, 'Category highlight index');
    if (typeof hasCells !== 'boolean') {
      throw new TypeError('Category highlight availability must be boolean');
    }
    const fieldIndex = state.activeFieldSource === FieldSource.OBS
      ? state.activeFieldIndex
      : -1;
    requireExactIndex(fieldIndex, 'Active observation field index');
    const group = state.findHighlightGroupByCategory(
      fieldIndex,
      catIdx,
      'obs'
    );
    if (
      group !== null
      && (
        typeof group !== 'object'
        || typeof group.id !== 'string'
        || group.id.length === 0
      )
    ) {
      throw new TypeError(
        'Category highlight lookup returned an invalid group'
      );
    }
    const active = group !== null;
    highlightBtn.classList.toggle(
      'legend-highlight-btn--active',
      active
    );
    highlightBtn.setAttribute('aria-pressed', String(active));
    highlightBtn.disabled = !hasCells && !active;
    highlightBtn.title = active
      ? 'Remove highlight from this category'
      : hasCells
        ? 'Highlight all cells in this category'
        : 'No visible cells to highlight in this category';
  };

  // The rows of the current render, by category index, so a count refresh
  // or a highlight change updates rows without querying the document for
  // each of thousands of categories.
  /** @type {Map<number, {row: HTMLElement, checkbox: HTMLInputElement, colorInput: HTMLInputElement, swatch: HTMLElement, countSpan: HTMLElement, highlightBtn: HTMLButtonElement|null}>} */
  let renderedRows = new Map();
  // The field the rendered rows belong to: a counts refresh updates them only
  // while they are that field's rows.
  let renderedField = null;
  // The model the rendered rows show, so a virtual window built while
  // scrolling shows the same counts as the rows already drawn.
  let renderedModel = null;
  let renderedAnnotating = false;
  // The line saying what the counts are of (a subsample's open cells).
  let renderedCellsNote = null;

  const syncCategoryHighlightButtons = () => {
    if (isRendering) return;
    if (destroyed) {
      throw new Error(
        'Categorical legend received a highlight event after destruction'
      );
    }
    // Highlight buttons exist only while annotating.
    if (!renderedAnnotating) return;
    const field = state.getActiveField();
    if (field === null || field.kind !== FieldKind.CATEGORY) return;
    const model = requireCategoricalLegendModel(
      field,
      state.getLegendModel(field)
    );
    for (const [catIdx, entry] of renderedRows) {
      if (entry.highlightBtn === null) continue;
      syncCategoryHighlightButton(
        entry.highlightBtn,
        catIdx,
        model.counts.visible[catIdx] > 0
      );
    }
  };

  const rerenderIfActiveCategory = () => {
    if (isRendering) return;
    if (destroyed) {
      throw new Error('Categorical legend received an event after destruction');
    }
    const field = state.getActiveField();
    if (field === null || field.kind !== FieldKind.CATEGORY) return;
    const model = state.getLegendModel(field);
    renderCategoricalLegend(field, model);
  };

  let unsubscribeAnnotation = null;
  let unsubscribeAccess = null;
  let unsubscribeHighlight = null;
  try {
    // Keep legend UI in sync when voting mode is toggled or votes change.
    unsubscribeAnnotation = annotationSession.on('changed', () => {
      if (isRendering) return;
      if (destroyed) {
        throw new Error(
          'Categorical legend received an event after destruction'
        );
      }
      const field = state.getActiveField();
      if (field === null || field.kind !== FieldKind.CATEGORY) return;
      const model = state.getLegendModel(field);
      renderCategoricalLegend(field, model);
    });
    if (typeof unsubscribeAnnotation !== 'function') {
      throw new TypeError(
        'Annotation subscription must return an unsubscribe function'
      );
    }

    unsubscribeHighlight = state.on(
      'highlight:changed',
      syncCategoryHighlightButtons
    );
    if (typeof unsubscribeHighlight !== 'function') {
      throw new TypeError(
        'Highlight subscription must return an unsubscribe function'
      );
    }

    // Re-render when repo connect/disconnect or access changes.
    unsubscribeAccess = access.on('changed', rerenderIfActiveCategory);
    if (typeof unsubscribeAccess !== 'function') {
      throw new TypeError(
        'Annotation access subscription must return an unsubscribe function'
      );
    }
    view.addEventListener(
      ANNOTATION_CONNECTION_CHANGED_EVENT,
      rerenderIfActiveCategory,
      { signal: lifecycle.signal }
    );
  } catch (error) {
    lifecycle.abort();
    const failures = [
      error instanceof Error
        ? error
        : new TypeError(
            'Categorical legend initialization failed with a non-Error value'
          )
    ];
    for (const unsubscribe of [
      unsubscribeAccess,
      unsubscribeHighlight,
      unsubscribeAnnotation
    ]) {
      if (typeof unsubscribe !== 'function') continue;
      try {
        unsubscribe();
      } catch (cleanupError) {
        failures.push(
          cleanupError instanceof Error
            ? cleanupError
            : new TypeError(
                'Categorical legend unsubscribe failed with a non-Error value'
              )
        );
      }
    }
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(
      failures,
      'Categorical legend initialization and cleanup both failed'
    );
  }

  function refreshCategoryCounts() {
    if (destroyed) {
      throw new Error('Categorical legend is destroyed');
    }
    syncCommunityAnnotationCacheContext({ dataSourceManager });

    const activeField = state.getActiveField();
    if (activeField === null || activeField.kind !== FieldKind.CATEGORY) return;
    const model = requireCategoricalLegendModel(
      activeField,
      state.getLegendModel(activeField)
    );
    if (renderedField !== activeField) {
      // The active field changed (another view was selected, or the view was
      // recoloured) and its legend has not been drawn yet: draw it.
      renderCategoricalLegend(activeField, model);
      return;
    }
    renderedModel = model;
    const counts = model.counts;
    const visibleList = counts.visible;
    const availableList = counts.available;
    let annotationAvailabilityChanged = false;
    for (const [idx, entry] of renderedRows) {
      if (idx >= model.categories.length) {
        throw new RangeError(
          `Legend row category index ${idx} is outside the model`
        );
      }
      const visible = visibleList[idx];
      const available = availableList[idx];
      const hasCells = available > 0;
      const { row } = entry;
      const wasDisabled = row.classList.contains('legend-item-disabled');
      if (wasDisabled === hasCells) {
        if (renderedAnnotating) annotationAvailabilityChanged = true;
        row.classList.toggle('legend-item-disabled', !hasCells);
        row.title = hasCells ? '' : NO_CELLS_TITLE;
        entry.checkbox.disabled = !hasCells;
        entry.colorInput.disabled = !hasCells;
      }
      setTextIfChanged(entry.countSpan, formatCategoryCount(visible, available));
      if (entry.highlightBtn !== null) {
        syncCategoryHighlightButton(entry.highlightBtn, idx, visible > 0);
      }
    }
    if (renderedCellsNote !== null) setTextIfChanged(renderedCellsNote, describeCountedCells(state));
    if (annotationAvailabilityChanged) {
      renderCategoricalLegend(activeField, model);
      return;
    }
  }

  function renderCategoricalLegend(field, model) {
    if (destroyed) {
      throw new Error('Categorical legend is destroyed');
    }

    closeTransientInteractions();
    isRendering = true;
    try {
      const { section, rows, annotating, mount, cellsNote } = _doRenderCategoricalLegend(field, model);
      legendEl.replaceChildren(section);
      mount();
      renderedCellsNote = cellsNote;
      renderedRows = rows;
      renderedField = field;
      renderedModel = model;
      renderedAnnotating = annotating;
    } finally {
      isRendering = false;
    }
  }

  /**
   * Build one category row. Rows carry no listeners of their own: every
   * interaction is delegated to the list container (see
   * `bindLegendListEvents`), so a 5,000-category legend attaches a handful of
   * listeners instead of sixty thousand. The icon buttons are cloned from one
   * prototype built by the shared control kit.
   */
  function buildCategoryRow({
    catIdx,
    label,
    color,
    isVisible,
    visibleCount,
    availableCount,
    annotating,
    consensus,
    originalLabel,
    prototypes
  }) {
    const hasCells = availableCount > 0;
    const row = ownerDocument.createElement('div');
    row.className = 'legend-item';
    if (annotating) row.classList.add('legend-item-annotating');
    if (!hasCells) row.classList.add('legend-item-disabled');
    row.dataset.catIndex = String(catIdx);
    if (!hasCells) row.title = NO_CELLS_TITLE;

    const checkbox = ownerDocument.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'legend-checkbox';
    checkbox.setAttribute('aria-label', `Show category ${label}`);
    // Declared for the same reason as the highlight button below.
    checkbox.dataset.analyticsId = 'legend:toggle-category';
    checkbox.checked = isVisible;
    checkbox.disabled = !hasCells;

    const swatch = ownerDocument.createElement('div');
    swatch.className = 'legend-swatch';
    const colorInput = ownerDocument.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'legend-color-input';
    colorInput.setAttribute('aria-label', `Color for category ${label}`);
    colorInput.disabled = !hasCells;
    paintSwatch(swatch, colorInput, color);
    swatch.appendChild(colorInput);

    const labelSpan = ownerDocument.createElement('div');
    labelSpan.className = 'legend-label';
    const labelMain = ownerDocument.createElement('div');
    labelMain.className = 'legend-label-main';
    labelMain.textContent = label;
    labelSpan.appendChild(labelMain);

    let highlightBtn = null;
    if (annotating) {
      labelSpan.classList.add('legend-label-multiline');
      const sub = ownerDocument.createElement('div');
      sub.className = 'legend-label-sub';
      const left = ownerDocument.createElement('span');
      left.className = 'legend-consensus-names';
      left.textContent = consensus === null ? '—' : consensus.names;
      highlightBtn = ownerDocument.createElement('button');
      highlightBtn.type = 'button';
      highlightBtn.className = 'legend-highlight-btn';
      highlightBtn.textContent = '◉';
      highlightBtn.setAttribute('aria-label', `Highlight category ${label}`);
      // The accessible name carries the category, which is dataset content.
      // Declaring the analytics id keeps the click countable without the
      // tracker having to read the name to identify the control.
      highlightBtn.dataset.analyticsId = 'legend:highlight-category';
      syncCategoryHighlightButton(highlightBtn, catIdx, visibleCount > 0);
      const right = ownerDocument.createElement('span');
      right.className = 'legend-consensus-counts';
      right.textContent = consensus === null
        ? '▲0 ▼0'
        : `▲${consensus.up} ▼${consensus.down}`;
      sub.append(left, right, highlightBtn);
      labelSpan.appendChild(sub);
    }

    const votingHint = hasCells
      ? 'Voting mode enabled: click to vote (labels are locked).'
      : 'Voting unavailable because no cells are currently available.';
    if (originalLabel !== undefined && formatCategoryLabel(originalLabel) !== label) {
      labelSpan.classList.add('is-renamed');
      labelSpan.title = annotating
        ? `Original: ${originalLabel} • ${votingHint}`
        : `Original: ${originalLabel}`;
    } else {
      labelSpan.title = annotating
        ? votingHint
        : 'Double-click to rename • Drag or press Enter to merge into another category';
    }

    labelSpan.draggable = !annotating;
    if (!annotating) {
      // The label is the pick-up handle for the shared keyboard move grammar,
      // so merging is not a pointer-only operation.
      labelSpan.classList.add('legend-label-draggable');
      labelSpan.setAttribute('role', 'button');
      labelSpan.setAttribute('tabindex', '0');
      labelSpan.setAttribute('aria-roledescription', 'movable category');
      labelSpan.setAttribute('aria-describedby', prototypes.moveInstructionsId);
      labelSpan.setAttribute('aria-keyshortcuts', 'Enter Space');
    } else if (hasCells) {
      labelSpan.classList.add('legend-label-voting');
      labelMain.classList.add('legend-vote-trigger');
      labelMain.setAttribute('role', 'button');
      labelMain.setAttribute('tabindex', '0');
      labelMain.setAttribute('aria-label', `Vote on category ${label}`);
    }

    const countSpan = ownerDocument.createElement('span');
    countSpan.className = 'legend-count';
    countSpan.textContent = formatCategoryCount(visibleCount, availableCount);

    row.append(checkbox, swatch, labelSpan, countSpan);
    if (!annotating) {
      row.append(
        prototypes.rename.cloneNode(true),
        prototypes.remove.cloneNode(true)
      );
    }
    return { row, checkbox, colorInput, swatch, countSpan, highlightBtn };
  }

  function paintSwatch(swatch, colorInput, color) {
    const cssColor = state.rgbToCss(color);
    if (typeof cssColor !== 'string' || cssColor.length === 0) {
      throw new TypeError('Category RGB conversion must return CSS text');
    }
    StyleManager.setVariable(swatch, '--legend-swatch-color', cssColor);
    colorInput.value = rgbToHex(color);
  }

  function _doRenderCategoricalLegend(field, model) {
    requireCategoricalLegendModel(field, model);

    const catSection = ownerDocument.createElement('div');
    catSection.className = 'legend-section';

    const controlsDiv = ownerDocument.createElement('div');
    controlsDiv.className = 'legend-controls';
    const setAllVisible = visible => {
      if (visible) {
        state.showAllCategories(field, { onlyAvailable: true });
      } else {
        state.hideAllCategories(field, { onlyAvailable: true });
      }
      for (const entry of renderedRows.values()) {
        if (!entry.checkbox.disabled) entry.checkbox.checked = visible;
      }
    };
    controlsDiv.append(
      createButton({
        label: 'Show all',
        className: 'btn-compact',
        onClick: () => setAllVisible(true)
      }),
      createButton({
        label: 'Hide all',
        className: 'btn-compact',
        onClick: () => setAllVisible(false)
      })
    );
    catSection.appendChild(controlsDiv);
    // On a subsample the counts are of the open cells, and the legend says so.
    const cellsNote = ownerDocument.createElement('p');
    cellsNote.className = 'status-line legend-cells-note';
    cellsNote.textContent = describeCountedCells(state);
    catSection.appendChild(cellsNote);

    const categories = model.categories;
    const labels = categories.map(formatCategoryLabel);
    const visibleCounts = model.counts.visible;
    const availableCounts = model.counts.available;
    const sortedIndices = categories
      .map((_category, idx) => idx)
      .sort((left, right) => (
        compareValidatedCategoryLabels(categories[left], categories[right])
      ));

    const fieldKey = field.key;
    annotationSession.setFieldCategories(fieldKey, categories);
    const fieldAnnotated = annotationSession.isFieldAnnotated(fieldKey);
    if (typeof fieldAnnotated !== 'boolean') {
      throw new TypeError('Annotation field state must be boolean');
    }
    const annotating = (
      isCommunityAnnotationUiEnabled()
      && fieldAnnotated
    );
    if (field._originalCategories !== undefined && (
      !Array.isArray(field._originalCategories)
      || field._originalCategories.length !== categories.length
    )) {
      throw new TypeError(
        'Original categories must exactly match the current category inventory'
      );
    }

    const itemsContainer = ownerDocument.createElement('div');
    itemsContainer.className = 'legend-items-container';
    if (sortedIndices.length > 16) {
      itemsContainer.classList.add('legend-items-scrollable');
      // The fade at the bottom edge says there is more; it lifts once the
      // list is scrolled to its end. Read once per frame, written only when
      // it changes.
      const syncScrollEnd = coalesceToFrame(() => {
        const atEnd = itemsContainer.scrollHeight - itemsContainer.scrollTop
          - itemsContainer.clientHeight < 8;
        if (itemsContainer.classList.contains('scrolled-to-bottom') !== atEnd) {
          itemsContainer.classList.toggle('scrolled-to-bottom', atEnd);
        }
      });
      itemsContainer.addEventListener('scroll', () => syncScrollEnd(), { passive: true });
    }

    const prototypes = {
      moveInstructionsId: getKeyboardMoveInstructionsId(ownerDocument),
      rename: createIconButton({
        label: 'Rename category',
        icon: ICONS.rename,
        className: 'legend-rename-btn'
      }),
      remove: createIconButton({
        label: annotating
          ? 'Disabled while voting is enabled'
          : 'Delete category (merge into unassigned)',
        icon: ICONS.delete,
        tone: 'danger',
        className: 'legend-delete-btn'
      })
    };

    /** @type {Map<number, ReturnType<typeof buildCategoryRow>>} */
    const rows = new Map();
    const buildEntry = catIdx => {
      let originalLabel;
      if (field._originalCategories !== undefined) {
        originalLabel = field._originalCategories[catIdx];
        StateValidator.validateCategoryLabel(originalLabel);
      }
      // A virtual window is rebuilt after the counts were refreshed, so it
      // reads the model the legend drew last.
      const current = renderedField === field && renderedModel !== null ? renderedModel : model;
      return buildCategoryRow({
        catIdx,
        label: labels[catIdx],
        color: current.colors[catIdx],
        isVisible: current.visible[catIdx],
        visibleCount: current.counts.visible[catIdx],
        availableCount: current.counts.available[catIdx],
        annotating,
        consensus: annotating
          ? computeTopConsensusSummary(annotationSession, fieldKey, catIdx)
          : null,
        originalLabel,
        prototypes
      });
    };

    let mount = () => {};
    if (sortedIndices.length <= VIRTUAL_LIST_MIN_ROWS) {
      const fragment = ownerDocument.createDocumentFragment();
      for (const catIdx of sortedIndices) {
        const entry = buildEntry(catIdx);
        rows.set(catIdx, entry);
        fragment.appendChild(entry.row);
      }
      itemsContainer.appendChild(fragment);
    } else {
      // Only the rows in view exist; the spacer keeps the scroll height of
      // every row, and the window sits at the first row it holds.
      itemsContainer.classList.add('legend-items-virtual');
      const spacer = ownerDocument.createElement('div');
      spacer.className = 'legend-virtual-spacer';
      const windowEl = ownerDocument.createElement('div');
      windowEl.className = 'legend-virtual-window';
      spacer.appendChild(windowEl);
      itemsContainer.appendChild(spacer);
      let stride = 0;
      let windowStart = -1;
      let windowEnd = -1;
      // The rows of positions [from, to), built, as one fragment.
      const buildRows = (from, to) => {
        const fragment = ownerDocument.createDocumentFragment();
        for (let position = from; position < to; position++) {
          const catIdx = sortedIndices[position];
          const entry = buildEntry(catIdx);
          rows.set(catIdx, entry);
          fragment.appendChild(entry.row);
        }
        return fragment;
      };
      // The window moves by whole rows: the rows it keeps stay the same
      // nodes, never detached, so a focused control, an open rename and a
      // hovered row survive a scroll; only the rows entering it are built
      // and only the rows leaving it removed.
      const fillWindow = (first, last) => {
        const overlaps = windowStart >= 0 && first < windowEnd && last > windowStart;
        if (!overlaps) {
          rows.clear();
          windowEl.replaceChildren(buildRows(first, last));
        } else {
          for (let position = windowStart; position < windowEnd; position++) {
            if (position >= first && position < last) continue;
            const catIdx = sortedIndices[position];
            rows.get(catIdx)?.row.remove();
            rows.delete(catIdx);
          }
          if (first < windowStart) windowEl.prepend(buildRows(first, windowStart));
          if (last > windowEnd) windowEl.append(buildRows(windowEnd, last));
        }
        windowStart = first;
        windowEnd = last;
        StyleManager.setVariable(windowEl, '--legend-virtual-offset', `${first * stride}px`);
      };
      const renderWindow = () => {
        if (destroyed || !itemsContainer.isConnected || stride <= 0) return;
        const viewport = itemsContainer.clientHeight || stride * 16;
        const first = Math.max(
          0,
          Math.floor(itemsContainer.scrollTop / stride) - VIRTUAL_OVERSCAN_ROWS
        );
        const last = Math.min(
          sortedIndices.length,
          Math.ceil((itemsContainer.scrollTop + viewport) / stride) + VIRTUAL_OVERSCAN_ROWS
        );
        if (first === windowStart && last === windowEnd) return;
        fillWindow(first, last);
      };
      const scheduleWindow = coalesceToFrame(renderWindow);
      itemsContainer.addEventListener('scroll', () => scheduleWindow(), { passive: true });
      fillWindow(0, Math.min(sortedIndices.length, VIRTUAL_INITIAL_ROWS));
      mount = () => {
        // The row pitch is measured once the list is in the document: two
        // consecutive rows' offsets, so margins are included.
        const [firstRow, secondRow] = windowEl.children;
        stride = secondRow instanceof view.HTMLElement && firstRow instanceof view.HTMLElement
          ? secondRow.offsetTop - firstRow.offsetTop
          : 0;
        if (!(stride > 0)) stride = 20;
        StyleManager.setVariable(
          spacer,
          '--legend-virtual-height',
          `${sortedIndices.length * stride}px`
        );
        windowStart = -1;
        renderWindow();
      };
    }

    bindLegendListEvents({
      itemsContainer,
      field,
      categories,
      labels,
      rows,
      annotating,
      datasetGeneration: readDatasetGeneration()
    });

    catSection.appendChild(itemsContainer);
    return { section: catSection, rows, annotating, mount, cellsNote };
  }

  /**
   * Every row interaction, delegated to the list container. A handler finds
   * its row by `data-cat-index` and its state in `rows`; nothing is captured
   * per row, so building a row costs DOM nodes only.
   */
  function bindLegendListEvents({
    itemsContainer,
    field,
    categories,
    labels,
    rows,
    annotating,
    datasetGeneration
  }) {
    const fieldKey = field.key;
    const rowOf = target => {
      const row = target instanceof view.Element
        ? target.closest('.legend-item')
        : null;
      if (row === null || !itemsContainer.contains(row)) return null;
      const catIdx = parseExactIndex(row.dataset.catIndex, 'Legend row category index');
      const entry = rows.get(catIdx);
      if (entry === undefined || entry.row !== row) {
        throw new Error('Legend row is not part of the current render');
      }
      return { catIdx, entry, row };
    };

    const requireCurrentCategoryField = categoryIndex => {
      if (state.activeFieldSource !== FieldSource.OBS) {
        throw new Error(
          'Categorical legend actions require an active observation field'
        );
      }
      const fieldIndex = requireExactIndex(
        state.activeFieldIndex,
        'Active observation field index'
      );
      const fields = state.getFields();
      if (!Array.isArray(fields)) {
        throw new TypeError('Categorical legend state fields must be an array');
      }
      const currentField = fields[fieldIndex];
      if (currentField !== field) {
        throw new Error(
          'Categorical legend action belongs to a stale field render'
        );
      }
      StateValidator.validateCategoryIndex(categoryIndex, currentField);
      return { fieldIndex, currentField };
    };

    /**
     * Confirm and perform one category merge.
     *
     * Dropping a label onto a row and dropping it there with the keyboard are
     * the same operation, so they run the same code: one confirmation, one
     * staleness check, one notification.
     */
    const beginCategoryMerge = (fromIdx, toIdx) => {
      if (annotating) return;
      if (fromIdx === toIdx) return;

      const { fieldIndex, currentField } = requireCurrentCategoryField(toIdx);

      StateValidator.validateCategoryIndex(fromIdx, currentField);
      const fromLabel = formatCategoryLabel(currentField.categories[fromIdx]);
      const toLabel = formatCategoryLabel(currentField.categories[toIdx]);
      const inPlace = currentField._isUserDefined === true;
      const generation = readDatasetGeneration();
      const capturedCategories = [
        { index: fromIdx, value: currentField.categories[fromIdx] },
        { index: toIdx, value: currentField.categories[toIdx] }
      ];

      let releaseTransient = () => {};
      let retired = false;
      const closeDialog = showConfirmDialog({
        title: 'Merge categories',
        tone: 'primary',
        message:
          `Merge category \"${fromLabel}\" into \"${toLabel}\"?\n\n` +
          (inPlace
            ? `This edits the current derived column in place.\n` +
              `To undo, restore the original column from Deleted fields.`
            : `This creates a new categorical column and moves the previous column to Deleted fields for restore.`),
        confirmText: 'Merge',
        onConfirm: () => {
          const ownsInteraction = retired === false;
          retired = true;
          releaseTransient();
          if (!ownsInteraction || !isCapturedCategoryCurrent({
            categories: capturedCategories,
            datasetGeneration: generation,
            field: currentField,
            fieldIndex
          })) {
            return;
          }
          try {
            const result = state.mergeCategoriesToNewField(
              fieldIndex,
              fromIdx,
              toIdx,
              { editInPlace: inPlace }
            );
            requirePlainRecord(result, 'Category merge result');
            if (
              typeof result.updatedInPlace !== 'boolean'
              || typeof result.mergedCategoryLabel !== 'string'
              || result.mergedCategoryLabel.length === 0
            ) {
              throw new TypeError(
                'Category merge result requires updatedInPlace and mergedCategoryLabel'
              );
            }
            const mergedLabel = ` → \"${result.mergedCategoryLabel}\"`;
            const suffix = result.updatedInPlace ? ' (edited in place)' : '';
            getNotificationCenter().success(
              `Merged \"${fromLabel}\" into \"${toLabel}\"${mergedLabel}${suffix}`,
              { category: 'filter', duration: 2400 }
            );
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            getNotificationCenter().error(error.message, { category: 'filter' });
          }
        },
        onCancel: () => {
          retired = true;
          releaseTransient();
        }
      });
      releaseTransient = ownTransient(() => {
        retired = true;
        closeDialog();
      });
    };

    const startRename = (catIdx, labelSpan) => {
      if (annotating) return;
      const { fieldIndex, currentField } = requireCurrentCategoryField(catIdx);
      const currentLabel = formatCategoryLabel(currentField.categories[catIdx]);
      const generation = readDatasetGeneration();
      const capturedCategories = [{
        index: catIdx,
        value: currentField.categories[catIdx]
      }];

      let releaseTransient = () => {};
      const editor = InlineEditor.create(labelSpan, currentLabel, {
        onSave: (newLabel) => {
          releaseTransient();
          if (!isCapturedCategoryCurrent({
            categories: capturedCategories,
            datasetGeneration: generation,
            field: currentField,
            fieldIndex
          })) {
            return;
          }
          const renamed = state.renameCategory(
            FieldSource.OBS,
            fieldIndex,
            catIdx,
            newLabel
          );
          if (typeof renamed !== 'boolean') {
            throw new TypeError(
              'Category rename must return an exact boolean result'
            );
          }
          if (!renamed) {
            getNotificationCenter().error('Failed to rename category', { category: 'filter' });
            return;
          }
          getNotificationCenter().success(`Category renamed to \"${newLabel}\"`, { category: 'filter', duration: 2000 });
        },
        onCancel: () => {
          releaseTransient();
        },
        validate: validateCategoryLabel
      });
      if (!(editor instanceof view.HTMLInputElement)) {
        throw new TypeError(
          'Category rename must create one document-owned input'
        );
      }
      releaseTransient = ownTransient(() => {
        InlineEditor.cancel(editor);
      });
    };

    const deleteCategory = catIdx => {
      if (annotating) return;
      const { fieldIndex, currentField } = requireCurrentCategoryField(catIdx);
      const currentLabel = formatCategoryLabel(currentField.categories[catIdx]);
      const unassignedLabel = 'unassigned';
      const inPlace = currentField._isUserDefined === true;
      const generation = readDatasetGeneration();
      const capturedCategories = [{
        index: catIdx,
        value: currentField.categories[catIdx]
      }];

      let releaseTransient = () => {};
      let retired = false;
      const closeDialog = showConfirmDialog({
        title: 'Delete category label',
        message:
          `Delete category \"${currentLabel}\"?\n\n` +
          (inPlace
            ? `This edits the current derived column in place, merging \"${currentLabel}\" into \"${unassignedLabel}\".\n` +
              `To undo, restore the original column from Deleted fields.`
            : `This creates a new categorical column where \"${currentLabel}\" is merged into \"${unassignedLabel}\".\n` +
              `The previous column is moved to Deleted fields for restore.`),
        confirmText: 'Delete category',
        onConfirm: () => {
          const ownsInteraction = retired === false;
          retired = true;
          releaseTransient();
          if (!ownsInteraction || !isCapturedCategoryCurrent({
            categories: capturedCategories,
            datasetGeneration: generation,
            field: currentField,
            fieldIndex
          })) {
            return;
          }
          try {
            const result = state.deleteCategoryToUnassigned(
              fieldIndex,
              catIdx,
              { unassignedLabel, editInPlace: inPlace }
            );
            requirePlainRecord(result, 'Category deletion result');
            if (typeof result.updatedInPlace !== 'boolean') {
              throw new TypeError(
                'Category deletion result updatedInPlace must be boolean'
              );
            }
            const msg = result.updatedInPlace
              ? `Merged into \"${unassignedLabel}\" (edited in place)`
              : `Moved into \"${unassignedLabel}\"`;
            getNotificationCenter().success(msg, { category: 'filter', duration: 2400 });
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            getNotificationCenter().error(error.message, { category: 'filter' });
          }
        },
        onCancel: () => {
          retired = true;
          releaseTransient();
        }
      });
      releaseTransient = ownTransient(() => {
        retired = true;
        closeDialog();
      });
    };

    const toggleCategoryHighlight = catIdx => {
      const fIdx = state.activeFieldSource === FieldSource.OBS ? state.activeFieldIndex : -1;
      requireExactIndex(fIdx, 'Active observation field index');
      const group = state.findHighlightGroupByCategory(fIdx, catIdx, 'obs');
      if (group !== null) {
        if (
          typeof group !== 'object'
          || typeof group.id !== 'string'
          || group.id.length === 0
        ) {
          throw new TypeError(
            'Category highlight lookup returned an invalid group'
          );
        }
        const removed = state.removeHighlightGroup(group.id);
        if (removed !== true) {
          throw new Error(
            `Category highlight "${group.id}" was not removed`
          );
        }
        return;
      }
      const added = state.addHighlightFromCategory(fIdx, catIdx, 'obs');
      if (
        added === null
        || typeof added !== 'object'
        || typeof added.id !== 'string'
        || added.id.length === 0
      ) {
        throw new Error('Category highlight was not created');
      }
    };

    const resolveVoteTrigger = catIdx => {
      const categoryValue = categories[catIdx];
      if (
        destroyed
        || readDatasetGeneration() !== datasetGeneration
        || state.activeFieldSource !== FieldSource.OBS
        || !Number.isSafeInteger(state.activeFieldIndex)
        || state.activeFieldIndex < 0
      ) {
        return null;
      }
      const fields = state.getFields();
      if (!Array.isArray(fields)) {
        throw new TypeError(
          'Categorical legend state fields must be an array'
        );
      }
      const currentField = fields[state.activeFieldIndex];
      if (
        currentField !== field
        || !Array.isArray(currentField.categories)
        || !Object.is(currentField.categories[catIdx], categoryValue)
      ) {
        return null;
      }
      const trigger = renderedRows.get(catIdx)?.row.querySelector('.legend-vote-trigger');
      return trigger instanceof view.HTMLElement && trigger.isConnected
        ? trigger
        : null;
    };

    const openVoting = (catIdx, labelMain) => {
      if (!isCommunityAnnotationUiEnabled()) return;
      openCommunityAnnotationVotingModal({
        state,
        defaultFieldKey: fieldKey,
        defaultCatIdx: catIdx,
        returnFocusTo: labelMain,
        returnFocusResolver: () => resolveVoteTrigger(catIdx)
      });
    };

    // Dragging a native colour picker fires `input` many times per frame, and
    // every recolour rebuilds the whole colour buffer: the swatch follows
    // each event, the state takes at most one per frame, and the release
    // commits the last one.
    const applyColor = coalesceToFrame((catIdx, hex) => {
      if (destroyed) return;
      state.setColorForCategory(field, catIdx, hexToRgb01(hex));
    });

    // One keyboard-move controller per label, made on first use.
    const moves = new WeakMap();
    const moveFor = (labelSpan, catIdx) => {
      let move = moves.get(labelSpan);
      if (move !== undefined) return move;
      move = createKeyboardMove({
        ownerDocument,
        describeSource: () => labels[catIdx],
        listTargets: () => [...rows].flatMap(([index, entry]) => (
          index === catIdx || !entry.row.isConnected
            ? []
            : [{ element: entry.row, index, label: labels[index] }]
        )),
        onAim: (aimed, previous) => {
          previous?.element.classList.remove('legend-item-drag-over');
          aimed?.element.classList.add('legend-item-drag-over');
        },
        onCommit: (aimed) => beginCategoryMerge(catIdx, aimed.index),
        onPickStateChange: (picked) => {
          rows.get(catIdx)?.row.classList.toggle('legend-item-dragging', picked);
        },
        emptyMessage: `${labels[catIdx]} has no other category to merge into.`
      });
      moves.set(labelSpan, move);
      return move;
    };

    itemsContainer.addEventListener('change', event => {
      const target = event.target;
      if (target instanceof view.HTMLInputElement && target.classList.contains('legend-checkbox')) {
        const hit = rowOf(target);
        if (hit !== null) {
          state.setVisibilityForCategory(field, hit.catIdx, target.checked);
        }
        return;
      }
      if (target instanceof view.HTMLInputElement && target.classList.contains('legend-color-input')) {
        applyColor.flush();
      }
    });

    itemsContainer.addEventListener('input', event => {
      const target = event.target;
      if (!(target instanceof view.HTMLInputElement) || !target.classList.contains('legend-color-input')) return;
      const hit = rowOf(target);
      if (hit === null) return;
      const rgb = hexToRgb01(target.value);
      StyleManager.setVariable(hit.entry.swatch, '--legend-swatch-color', state.rgbToCss(rgb));
      applyColor(hit.catIdx, target.value);
    });

    itemsContainer.addEventListener('click', event => {
      const target = event.target;
      if (!(target instanceof view.Element)) return;
      const button = target.closest('button');
      const hit = rowOf(target);
      if (hit === null) return;
      if (button !== null && hit.row.contains(button)) {
        if (button.classList.contains('legend-rename-btn')) {
          event.stopPropagation();
          startRename(hit.catIdx, hit.row.querySelector('.legend-label'));
        } else if (button.classList.contains('legend-delete-btn')) {
          event.stopPropagation();
          deleteCategory(hit.catIdx);
        } else if (button.classList.contains('legend-highlight-btn')) {
          event.stopPropagation();
          toggleCategoryHighlight(hit.catIdx);
        }
        return;
      }
      const voting = target.closest('.legend-label-voting');
      if (voting !== null && hit.row.contains(voting)) {
        event.stopPropagation();
        openVoting(hit.catIdx, voting.querySelector('.legend-vote-trigger'));
      }
    });

    itemsContainer.addEventListener('dblclick', event => {
      if (annotating) return;
      const target = event.target;
      if (!(target instanceof view.Element)) return;
      const labelSpan = target.closest('.legend-label');
      const hit = rowOf(target);
      if (labelSpan === null || hit === null || !hit.row.contains(labelSpan)) return;
      event.stopPropagation();
      startRename(hit.catIdx, labelSpan);
    });

    itemsContainer.addEventListener('keydown', event => {
      const target = event.target;
      if (!(target instanceof view.HTMLElement)) return;
      if (target.classList.contains('legend-label-draggable')) {
        // The inline rename editor replaces the label's contents; its keys
        // belong to it, not to the move.
        const hit = rowOf(target);
        if (hit !== null) moveFor(target, hit.catIdx).handleKeydown(event);
        return;
      }
      if (target.classList.contains('legend-vote-trigger')) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const hit = rowOf(target);
        if (hit === null) return;
        event.preventDefault();
        event.stopPropagation();
        openVoting(hit.catIdx, target);
      }
    });

    itemsContainer.addEventListener('focusout', event => {
      const target = event.target;
      if (target instanceof view.HTMLElement && target.classList.contains('legend-label-draggable')) {
        moves.get(target)?.cancel();
      }
    });

    if (annotating) return;

    itemsContainer.addEventListener('dragstart', event => {
      const target = event.target;
      if (!(target instanceof view.HTMLElement) || !target.classList.contains('legend-label-draggable')) return;
      const hit = rowOf(target);
      if (hit === null) return;
      hit.row.classList.add('legend-item-dragging');
      if (event.dataTransfer === null) {
        throw new TypeError('Category drag requires DataTransfer');
      }
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(CATEGORY_DRAG_MIME, JSON.stringify({ catIdx: hit.catIdx }));
    });

    itemsContainer.addEventListener('dragend', event => {
      const hit = rowOf(event.target);
      hit?.row.classList.remove('legend-item-dragging');
      for (const over of itemsContainer.querySelectorAll('.legend-item-drag-over')) {
        over.classList.remove('legend-item-drag-over');
      }
    });

    itemsContainer.addEventListener('dragover', event => {
      const hit = rowOf(event.target);
      if (hit === null) return;
      if (event.dataTransfer === null) {
        throw new TypeError('Category drag-over requires DataTransfer');
      }
      if (!Array.from(event.dataTransfer.types).includes(CATEGORY_DRAG_MIME)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      hit.row.classList.add('legend-item-drag-over');
    });

    itemsContainer.addEventListener('dragleave', event => {
      const hit = rowOf(event.target);
      if (hit === null) return;
      // Leaving a child of the row for the row itself is not leaving the row.
      if (event.relatedTarget instanceof view.Node && hit.row.contains(event.relatedTarget)) return;
      hit.row.classList.remove('legend-item-drag-over');
    });

    itemsContainer.addEventListener('drop', event => {
      const hit = rowOf(event.target);
      if (hit === null) return;
      event.preventDefault();
      hit.row.classList.remove('legend-item-drag-over');
      const payload = parseCategoryDragPayload(event.dataTransfer);
      beginCategoryMerge(payload.catIdx, hit.catIdx);
    });
  }

  /**
   * The legend shows something else (a continuous field, or nothing): its
   * rows, field and model are let go, so a field of a dataset no longer shown
   * is not kept alive with its codes and quantiles.
   */
  function releaseCategoricalLegend() {
    closeTransientInteractions();
    renderedRows = new Map();
    renderedField = null;
    renderedModel = null;
    renderedAnnotating = false;
    renderedCellsNote = null;
  }

  return {
    refreshCategoryCounts,
    renderCategoricalLegend,
    releaseCategoricalLegend,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      const failures = [];
      for (const cleanup of [
        closeTransientInteractions,
        () => lifecycle.abort(),
        unsubscribeAccess,
        unsubscribeHighlight,
        unsubscribeAnnotation
      ]) {
        try {
          cleanup();
        } catch (error) {
          failures.push(
            error instanceof Error
              ? error
              : new TypeError(
                  'Categorical legend cleanup failed with a non-Error value'
                )
          );
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          'Categorical legend cleanup encountered multiple failures'
        );
      }
    }
  };
}
