/**
 * @fileoverview Categorical legend rendering + interactions.
 *
 * Owns the categorical legend UI: category visibility checkboxes, color picker,
 * rename/delete operations, drag-to-merge behavior, and the count that keeps
 * only some of a category's cells.
 *
 * Every change is an action (`app/actions/`): a control dispatches it, and
 * the rows follow the state whoever changed it (`syncRows`: a step undone,
 * an agent's, a notebook's), checkbox, color and count, in place.
 *
 * @module ui/modules/legend/categorical-legend
 */

import { StyleManager } from '../../../../utils/style-manager.js';
import { hexOfRgb01, rgb01OfHex } from '../../../../utils/hex-color.js';
import { setControlAvailability } from '../../core/control-availability.js';
import { getNotificationCenter } from '../../../notification-center.js';
import { InlineEditor } from '../../components/inline-editor.js';
import { showConfirmDialog } from '../../components/confirm-dialog.js';
import { FieldKind, FieldSource, UNASSIGNED_LABEL } from '../../../utils/field-constants.js';
import { StateValidator } from '../../../utils/state-validator.js';
import { categoryDisplayName, isUnnamedCategory } from '../../../actions/targets/names.js';
import { getCommunityAnnotationSession } from '../../../community-annotations/session.js';
import { syncCommunityAnnotationCacheContext } from '../../../community-annotations/runtime-context.js';
import { annotationCategories, annotationFieldKey, annotationKeyable } from '../../../community-annotations/field-names.js';
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
  createCheckbox,
  createIconButton
} from '../../components/controls.js';
import { MISSING_LABEL } from '../../../state/managers/filter-manager.js';
import { formatCount, formatCountOf, formatOpenCells } from '../../../../utils/format-units.js';
import { requireExactKeys } from '../../../../utils/exact-record.js';
import { categoryRgbAt, categoryShownAt } from '../../../utils/category-state.js';
import { categoryCellLimitAt } from '../../../state/managers/category-cell-sample.js';
import { createLatestDispatch, dispatchFromControl } from '../../../actions/control-dispatch.js';
import { undoKeys } from '../state/shared.js';

const CATEGORY_DRAG_MIME = 'application/x-cellucid-category';
const INIT_KEYS = new Set(['state', 'legendEl', 'dataSourceManager']);
const REQUIRED_STATE_METHODS = [
  'findHighlightGroupByCategory',
  'getActiveField',
  'getActivePage',
  'getDatasetGeneration',
  'getFields',
  'getLegendModel',
  'on',
  'rgbToCss'
];
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

/**
 * A category as the legend shows it and names it to the actions it
 * dispatches: its display name (`categoryDisplayName`: `(empty)`, `(blank)`,
 * `" x "` for one with white space at an end), which every step resolves
 * (`targets/fields.js` `resolveCategory`). An action naming a category by an
 * empty name is refused ("must have at least 1 character"), so a category
 * with no name could not be hidden, colored, merged or renamed.
 */
function formatCategoryLabel(value) {
  StateValidator.validateCategoryLabel(value);
  return categoryDisplayName(value);
}

/** The legend's line under a category: its leading label(s) as the consensus ranks them, and their voters up and down. */
export function computeTopConsensusSummary(session, fieldKey, catIdx) {
  const suggestions = session.getSuggestions(fieldKey, catIdx);
  if (!Array.isArray(suggestions)) {
    throw new TypeError('Community annotation suggestions must be an array');
  }
  if (!suggestions.length) return null;
  let bestNet = null;
  let bestUp = null;
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
    // The consensus's rank (`session.js` `consensusOf`): net votes, then
    // upvotes; equal on both is a tie (by net alone, the legend would name a tie
    // the voting dialog's banner does not).
    if (bestNet === null || net > bestNet || (net === bestNet && up > bestUp)) {
      bestNet = net;
      bestUp = up;
    }
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
    if (net !== bestNet || up !== bestUp) continue;
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

/** A label typed in the rename box: the one rule for a label given now (`validateNewCategoryLabel`). */
function validateCategoryLabel(nextValue) {
  try {
    StateValidator.validateNewCategoryLabel(nextValue);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return `This label cannot be used: ${err.message}.`;
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

/**
 * What a category's count button says it does, and, when the category keeps
 * only some of its cells, how many and the sample's seed.
 */
function describeCountButton(label, limit, availableCount) {
  if (limit === null) return `Keep only some cells of ${label}`;
  return `Keeps a random ${formatCountOf(Math.min(limit.count, availableCount), 'cell')} of ${label} `
    + `(seed ${limit.seed}); click to change, or type all`;
}

/**
 * A count typed in the count button's editor: a whole number of cells, or
 * "all" (null: every cell).
 *
 * @param {string} text
 * @returns {number|null|undefined} undefined when it is neither
 */
function parseCellCount(text) {
  const trimmed = text.trim().replaceAll(',', '').replaceAll(' ', '');
  if (/^all$/i.test(trimmed)) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(trimmed)) return undefined;
  const count = Number(trimmed);
  return Number.isSafeInteger(count) ? count : undefined;
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
 * of every cell of the dataset (`formatOpenCells`); and, for a field whose
 * file stores more categories than there are open cells (`field.storedCategoryCount`,
 * coded by the ones its open cells hold), how many of them those are. ''
 * when every cell is open and the field lists every category it stores.
 *
 * @param {{pointCount?: number, cellIdentity?: {nOriginal?: number}|null}} state
 * @param {{categories?: ReadonlyArray<unknown>|null, _originalCategories?: ReadonlyArray<unknown>, storedCategoryCount?: number}|null} [field]
 * @returns {string}
 */
export function describeCountedCells(state, field = null) {
  const open = state.pointCount ?? 0;
  const total = state.cellIdentity?.nOriginal ?? open;
  const cells = total === open ? '' : `Counted on the ${formatOpenCells(open, total)} open.`;
  // Integers read as their text (identifiers past 2^53): said first, the
  // reason in full on the line's tooltip (`legendNoteTitle`).
  const text = typeof field?.asText === 'string' ? AS_TEXT_LINE : '';
  const stored = field?.storedCategoryCount;
  const found = (field?._originalCategories ?? field?.categories ?? []).length;
  const among = !Number.isSafeInteger(stored) || stored <= found
    ? ''
    : `${formatCount(found)} of its ${formatCountOf(stored, 'category', 'categories')} are among ${cells === '' ? 'the cells' : 'them'}.`;
  return [text, cells, among].filter(part => part !== '').join(' ');
}

/** The legend line's short form of a column read as text (`describeCountedCells`). */
const AS_TEXT_LINE = 'IDs past 2^53, read as text.';

/** The tooltip of the legend's line: why a column is text, in full, or ''. */
export function legendNoteTitle(field = null) {
  return typeof field?.asText === 'string' ? field.asText : '';
}

/** Write text only when it changed, so an unchanged row is not relaid out. */
function setTextIfChanged(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

const NO_CELLS_TITLE = 'No cells available in this category after other filters';
/** Why a category's switch and color are off (`setControlAvailability`). */
const NO_CELLS_REASON = 'no cell of this category is left after the other filters; loosen them to change it';

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

/** Count records checked against the category list they were made for. */
const CHECKED_COUNTS = new WeakMap();

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
    // Colors and visibility as `utils/category-state.js` holds them (checked
    // once per array where they are made).
    || !(model.colors instanceof Uint8Array)
    || model.colors.length !== model.categories.length * 3
    || model.counts === null
    || typeof model.counts !== 'object'
    || Array.isArray(model.counts)
    || Object.getPrototypeOf(model.counts) !== Object.prototype
    || Object.keys(model.counts).sort().join(',') !==
      'available,availableTotal,missing,total,visible,visibleTotal'
    || model.counts.missing === null
    || typeof model.counts.missing !== 'object'
    || !Array.isArray(model.counts.total)
    || !Array.isArray(model.counts.visible)
    || !Array.isArray(model.counts.available)
    || model.counts.total.length !== model.categories.length
    || model.counts.visible.length !== model.categories.length
    || model.counts.available.length !== model.categories.length
    || !(model.visible instanceof Uint8Array)
    || model.visible.length !== model.categories.length
  ) {
    throw new TypeError(
      'Categorical legend requires an exact category field and complete model'
    );
  }
  // A count record is made for one category list and never changed: it is
  // checked against it once, not on every draw (a field of a million
  // categories is drawn again on every filter and count).
  if (CHECKED_COUNTS.get(model.counts) === model.categories) return model;
  let totalCount = 0;
  let availableTotal = 0;
  let visibleTotal = 0;
  for (let index = 0; index < model.categories.length; index++) {
    StateValidator.validateCategoryLabel(model.categories[index]);
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
  // The cells without a category (the Missing row) count in the totals.
  const missing = model.counts.missing;
  requireCategoryCounts(missing.visible, missing.available);
  if (!Number.isSafeInteger(missing.total) || missing.total < missing.available) {
    throw new TypeError('Missing-value total count must contain its available count');
  }
  if (
    model.counts.availableTotal !== availableTotal + missing.available
    || model.counts.visibleTotal !== visibleTotal + missing.visible
    || totalCount > Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError(
      'Categorical legend count totals must match their category arrays'
    );
  }
  CHECKED_COUNTS.set(model.counts, model.categories);
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
    // Each written only when it changes: a count refresh syncs every row's
    // button, and a write of the value held is still a DOM write.
    if (highlightBtn.classList.contains('legend-highlight-btn--active') !== active) {
      highlightBtn.classList.toggle('legend-highlight-btn--active', active);
    }
    if (highlightBtn.getAttribute('aria-pressed') !== String(active)) {
      highlightBtn.setAttribute('aria-pressed', String(active));
    }
    const disabled = !hasCells && !active;
    if (highlightBtn.disabled !== disabled) highlightBtn.disabled = disabled;
    const title = active
      ? 'Remove highlight from this category'
      : hasCells
        ? 'Highlight all cells in this category'
        : 'No visible cells to highlight in this category';
    if (highlightBtn.title !== title) highlightBtn.title = title;
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
  /** @type {((counts: Object) => void)|null} Keeps the Missing row's count current. */
  let renderedMissingRow = null;
  /** @type {((visible: boolean) => void)|null} Keeps the Missing row's checkbox current. */
  let renderedMissingToggle = null;

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
      // recolored) and its legend has not been drawn yet: draw it.
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
        setControlAvailability(entry.checkbox, hasCells ? null : NO_CELLS_REASON);
        setControlAvailability(entry.colorInput, hasCells ? null : NO_CELLS_REASON);
      }
      setTextIfChanged(entry.countSpan, formatCategoryCount(visible, available));
      if (entry.highlightBtn !== null) {
        syncCategoryHighlightButton(entry.highlightBtn, idx, visible > 0);
      }
    }
    syncRows(activeField, model);
    if (renderedCellsNote !== null) setTextIfChanged(renderedCellsNote, describeCountedCells(state, activeField));
    renderedMissingRow?.(counts);
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
      // A redraw of the field shown (a rename, a vote, a count, a choice of
      // the field it is already colored by) keeps the list where the person
      // scrolled it: every redraw builds the list anew, and a new list starts
      // at its top, so a redraw a moment after a scroll would put a long legend
      // back at its first row.
      const sameField = renderedField !== null && renderedField.key === field.key
        && renderedField.categories?.length === field.categories?.length;
      const scrollTop = sameField
        ? legendEl.querySelector('.legend-items-container')?.scrollTop ?? 0
        : 0;
      const { section, rows, annotating, mount, cellsNote, syncMissingRow, syncMissingToggle } = _doRenderCategoricalLegend(field, model);
      legendEl.replaceChildren(section);
      mount(scrollTop);
      renderedCellsNote = cellsNote;
      renderedMissingRow = syncMissingRow;
      renderedMissingToggle = syncMissingToggle;
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
    unnamed = false,
    color,
    isVisible,
    visibleCount,
    availableCount,
    annotating,
    consensus,
    originalLabel,
    limit,
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
    // `label` is the display name (`formatCategoryLabel`); a category with no
    // name is drawn quietly.
    const shown = label;
    checkbox.setAttribute('aria-label', `Show category ${shown}`);
    // Declared for the same reason as the highlight button below.
    checkbox.dataset.analyticsId = 'legend:toggle-category';
    checkbox.checked = isVisible;
    setControlAvailability(checkbox, hasCells ? null : NO_CELLS_REASON);

    const swatch = ownerDocument.createElement('div');
    swatch.className = 'legend-swatch';
    const colorInput = ownerDocument.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'legend-color-input';
    colorInput.setAttribute('aria-label', `Color for category ${shown}`);
    setControlAvailability(colorInput, hasCells ? null : NO_CELLS_REASON);
    paintSwatch(swatch, colorInput, color);
    swatch.appendChild(colorInput);

    const labelSpan = ownerDocument.createElement('div');
    labelSpan.className = 'legend-label';
    const labelMain = ownerDocument.createElement('div');
    labelMain.className = 'legend-label-main';
    labelMain.textContent = shown;
    labelMain.classList.toggle('is-unnamed', unnamed);
    // A name cut to the row shows whole on a click or a tap
    // (`full-text-reveal.js`); while voting, a click votes.
    if (!annotating) labelMain.setAttribute('data-full-text', '');
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
    // Hover names the category whole first: the row may cut it.
    if (originalLabel !== undefined && formatCategoryLabel(originalLabel) !== label) {
      labelSpan.classList.add('is-renamed');
      const original = formatCategoryLabel(originalLabel);
      labelSpan.title = annotating
        ? `${shown}\nOriginal: ${original} • ${votingHint}`
        : `${shown}\nOriginal: ${original}`;
    } else {
      labelSpan.title = annotating
        ? `${shown}\n${votingHint}`
        : `${shown}\nDouble-click to rename • Drag or press Enter to merge into another category`;
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

    // The count is a button: it keeps only some of the category's cells
    // (`filter.category.cell-count`).
    const countSpan = ownerDocument.createElement('button');
    countSpan.type = 'button';
    countSpan.className = 'legend-count';
    countSpan.dataset.analyticsId = 'legend:category-cell-count';
    countSpan.textContent = formatCategoryCount(visibleCount, availableCount);
    syncCountButton(countSpan, label, limit, availableCount);

    row.append(checkbox, swatch, labelSpan, countSpan);
    if (!annotating) {
      row.append(
        prototypes.rename.cloneNode(true),
        prototypes.remove.cloneNode(true)
      );
    }
    return { row, checkbox, colorInput, swatch, countSpan, highlightBtn, label };
  }

  /** A count button's state: whether its category keeps only some cells, and what it says. */
  function syncCountButton(button, label, limit, availableCount) {
    const limited = limit !== null && limit.count < availableCount;
    if (button.classList.contains('is-limited') !== limited) button.classList.toggle('is-limited', limited);
    const words = describeCountButton(label, limit, availableCount);
    if (button.title !== words) button.title = words;
    const name = `${button.textContent}. ${words}`;
    if (button.getAttribute('aria-label') !== name) button.setAttribute('aria-label', name);
  }

  /**
   * The rows drawn show the field's state as it is now: each category's
   * checkbox, color and count limit, and the Missing row's checkbox (a
   * change made by an undo, an agent or a notebook reaches the rows here).
   * A color picker being used is left alone: it shows what is chosen.
   */
  function syncRows(field, model) {
    for (const [idx, entry] of renderedRows) {
      const shown = categoryShownAt(field._categoryVisible, idx);
      if (entry.checkbox.checked !== shown) entry.checkbox.checked = shown;
      if (ownerDocument.activeElement !== entry.colorInput) {
        const color = categoryRgbAt(field._categoryColors, idx);
        if (entry.colorInput.value !== hexOfRgb01(color)) paintSwatch(entry.swatch, entry.colorInput, color);
      }
      syncCountButton(entry.countSpan, entry.label, categoryCellLimitAt(field, idx), model.counts.available[idx]);
    }
    renderedMissingToggle?.(field._missingVisible !== false);
  }

  function paintSwatch(swatch, colorInput, color) {
    const cssColor = state.rgbToCss(color);
    if (typeof cssColor !== 'string' || cssColor.length === 0) {
      throw new TypeError('Category RGB conversion must return CSS text');
    }
    StyleManager.setVariable(swatch, '--legend-swatch-color', cssColor);
    colorInput.value = hexOfRgb01(color);
  }

  function _doRenderCategoricalLegend(field, model) {
    requireCategoricalLegendModel(field, model);

    const catSection = ownerDocument.createElement('div');
    catSection.className = 'legend-section';

    const controlsDiv = ownerDocument.createElement('div');
    controlsDiv.className = 'legend-controls';
    // The field as the actions name it; the rows follow the state (`syncRows`).
    const fieldRef = { source: FieldSource.OBS, key: field.key };
    const setAllVisible = visible => {
      void dispatchFromControl(
        'filter.category.all',
        { field: fieldRef, visible },
        { failure: visible ? 'Could not show every category' : 'Could not hide every category' }
      );
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
    cellsNote.textContent = describeCountedCells(state, field);
    cellsNote.title = legendNoteTitle(field);
    catSection.appendChild(cellsNote);

    const categories = model.categories;
    const labels = categories.map(formatCategoryLabel);
    // The field's own category order, as the file (Scanpy), the Group
    // dialog, the figure legend and the analysis plots show it: a trajectory
    // stays in its order, groups in the order they were typed.
    const rowIndices = categories.map((_category, idx) => idx);

    // Community annotation keys the field and its categories on the
    // dataset's names; a local rename is a display name (`field-names.js`).
    // A field whose categories the repository cannot key (a blank one, one
    // with spaces at its ends) is not open to it, and is shown as any other.
    const fieldKey = annotationFieldKey(field);
    const repositoryCategories = annotationCategories(field);
    const keyable = annotationKeyable(repositoryCategories);
    if (keyable) annotationSession.setFieldCategories(fieldKey, repositoryCategories);
    const fieldAnnotated = keyable && annotationSession.isFieldAnnotated(fieldKey);
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
    if (rowIndices.length > 16) {
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
          : `Delete category (its cells join ${UNASSIGNED_LABEL})`,
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
      // reads the counts the legend drew last; the rows this render builds
      // read the model it draws.
      const current = !isRendering && renderedField === field && renderedModel !== null ? renderedModel : model;
      // A row shows each category's color and visibility as the field
      // holds them now. A model holds the arrays of the moment it was made:
      // every change makes new ones (`utils/category-state.js`), so a model
      // kept from an earlier draw shows a category as it was then (a filter
      // removed in Active filters left its box unticked).
      return buildCategoryRow({
        catIdx,
        label: labels[catIdx],
        unnamed: isUnnamedCategory(categories[catIdx]),
        color: categoryRgbAt(field._categoryColors, catIdx),
        isVisible: categoryShownAt(field._categoryVisible, catIdx),
        visibleCount: current.counts.visible[catIdx],
        availableCount: current.counts.available[catIdx],
        annotating,
        consensus: annotating
          ? computeTopConsensusSummary(annotationSession, fieldKey, catIdx)
          : null,
        originalLabel,
        limit: categoryCellLimitAt(field, catIdx),
        prototypes
      });
    };

    // Run once the list is in the document, with the scroll position the
    // list it replaces had (0 for another field's): a redraw of the same
    // field leaves the person where they were in it.
    let mount = scrollTop => {
      if (scrollTop > 0) itemsContainer.scrollTop = scrollTop;
    };
    if (rowIndices.length <= VIRTUAL_LIST_MIN_ROWS) {
      const fragment = ownerDocument.createDocumentFragment();
      for (const catIdx of rowIndices) {
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
          const catIdx = rowIndices[position];
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
            const catIdx = rowIndices[position];
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
          rowIndices.length,
          Math.ceil((itemsContainer.scrollTop + viewport) / stride) + VIRTUAL_OVERSCAN_ROWS
        );
        if (first === windowStart && last === windowEnd) return;
        fillWindow(first, last);
      };
      const scheduleWindow = coalesceToFrame(renderWindow);
      itemsContainer.addEventListener('scroll', () => scheduleWindow(), { passive: true });
      fillWindow(0, Math.min(rowIndices.length, VIRTUAL_INITIAL_ROWS));
      mount = scrollTop => {
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
          `${rowIndices.length * stride}px`
        );
        // The place the replaced list was scrolled to, taken once the list
        // has its full height, so the rows built first are the ones there.
        if (scrollTop > 0) itemsContainer.scrollTop = scrollTop;
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
    // Cells without a category: counted, and shown or hidden like a
    // category (`setMissingCategoryVisibility`), drawn in the no-value gray.
    const missingToggle = createCheckbox({
      label: MISSING_LABEL,
      checked: field._missingVisible !== false,
      onChange: visible => {
        void dispatchFromControl(
          'filter.category.missing',
          { field: fieldRef, visible },
          { failure: 'Could not change the cells without a category' }
        );
      },
    });
    const syncMissingToggle = visible => {
      if (missingToggle.input.checked !== visible) missingToggle.input.checked = visible;
    };
    const missingCount = ownerDocument.createElement('span');
    missingCount.className = 'legend-count';
    const missingRow = ownerDocument.createElement('div');
    missingRow.className = 'legend-missing-row';
    missingRow.append(missingToggle.root, missingCount);
    catSection.appendChild(missingRow);
    // Written only when it changes, as every count is (`setTextIfChanged`):
    // setting `hidden` to the value it holds is still a DOM write, so a
    // category toggled would rewrite this row too.
    const syncMissingRow = counts => {
      const hidden = counts.missing.total === 0;
      if (missingRow.hidden !== hidden) missingRow.hidden = hidden;
      setTextIfChanged(missingCount, formatCategoryCount(counts.missing.visible, counts.missing.available));
    };
    syncMissingRow(model.counts);
    return { section: catSection, rows, annotating, mount, cellsNote, syncMissingRow, syncMissingToggle };
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
    const fieldRef = { source: FieldSource.OBS, key: fieldKey };
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
            ? `This edits the column in place.`
            : `This makes a new column; this one moves to Deleted fields.`) +
          ` Undo (${undoKeys().undo}) takes it back.`,
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
          void dispatchFromControl(
            'category.merge',
            { field: fieldRef, category: fromLabel, into: toLabel },
            { failure: 'Could not merge the categories' }
          ).then(done => {
            if (done === null) return;
            const result = done.outcome;
            const mergedLabel = ` → \"${result.merged}\"`;
            const suffix = result.in_place ? ' (edited in place)' : '';
            getNotificationCenter().success(
              `Merged \"${fromLabel}\" into \"${toLabel}\"${mergedLabel}${suffix}`,
              { category: 'filter', duration: 2400 }
            );
          });
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
          void dispatchFromControl(
            'category.rename',
            { field: fieldRef, category: currentLabel, name: newLabel },
            { failure: 'Could not rename the category' }
          ).then(done => {
            if (done?.outcome == null) return;
            getNotificationCenter().success(`Category renamed to \"${newLabel}\"`, { category: 'filter', duration: 2000 });
          });
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
      // The action's default: the one spelling of cells without a label.
      const unassignedLabel = UNASSIGNED_LABEL;
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
          `Its cells join \"${unassignedLabel}\"; ` +
          (inPlace
            ? `this edits the column in place.`
            : `this makes a new column, and this one moves to Deleted fields.`) +
          ` Undo (${undoKeys().undo}) takes it back.`,
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
          void dispatchFromControl(
            'category.delete',
            { field: fieldRef, category: currentLabel, unassigned_label: unassignedLabel },
            { failure: 'Could not delete the category' }
          ).then(done => {
            if (done === null) return;
            const msg = done.outcome.in_place
              ? `Merged into \"${unassignedLabel}\" (edited in place)`
              : `Moved into \"${unassignedLabel}\"`;
            getNotificationCenter().success(msg, { category: 'filter', duration: 2400 });
          });
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

    // The legend's highlight button: a highlight action naming the field,
    // the category and the page shown (`highlight/highlight-actions.js`).
    const toggleCategoryHighlight = catIdx => {
      const { fieldIndex: fIdx, currentField } = requireCurrentCategoryField(catIdx);
      const group = state.findHighlightGroupByCategory(fIdx, catIdx, 'obs');
      const page = state.getActivePage()?.name;
      if (page === undefined) return;
      const context = { failure: 'Highlighting the category failed', category: 'highlight' };
      if (group !== null) {
        void dispatchFromControl('highlight.group.remove', { group: group.label, page }, context);
        return;
      }
      void dispatchFromControl('highlight.category', {
        field: { source: 'obs', key: currentField.key },
        // The label as the legend shows it, as every other legend action names a category.
        categories: [formatCategoryLabel(currentField.categories[catIdx])],
        page,
      }, context);
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

    // Dragging a native color picker fires `input` many times per frame, and
    // every recolor rebuilds the whole color buffer: the swatch follows
    // each event, the state takes at most one per frame (the latest value,
    // `createLatestDispatch`), and the release commits the last one. The
    // drag is one step (`color.category` coalesces).
    const colorDispatch = createLatestDispatch('color.category', { failure: 'Could not change the color' });
    const applyColor = coalesceToFrame((catIdx, hex) => {
      if (destroyed) return;
      colorDispatch.push({ field: fieldRef, category: labels[catIdx], color: hex });
    });

    /**
     * Keep only some cells of a category: the count typed in the count
     * button's place, or "all" (`filter.category.cell-count`). The sample's
     * seed stays the one in force, so a larger count adds cells.
     */
    const startCellCount = (catIdx, button) => {
      const limit = categoryCellLimitAt(field, catIdx);
      const available = renderedModel?.counts.available[catIdx] ?? 0;
      let releaseTransient = () => {};
      const editor = InlineEditor.create(button, limit === null ? 'all' : String(limit.count), {
        minWidth: 64,
        validate: text => (parseCellCount(text) === undefined ? 'Type a whole number of cells, or all' : true),
        onSave: text => {
          releaseTransient();
          const typed = parseCellCount(text);
          if (typed === undefined) return;
          const count = typed === null || typed >= available ? null : typed;
          void dispatchFromControl(
            'filter.category.cell-count',
            { field: fieldRef, category: labels[catIdx], count, seed: limit?.seed ?? 0 },
            { failure: 'Could not keep that many cells' }
          );
        },
        onCancel: () => releaseTransient(),
      });
      if (editor === null) return;
      editor.setAttribute('aria-label', `Cells of ${labels[catIdx]} to keep shown: a number, or all`);
      editor.setAttribute('inputmode', 'numeric');
      releaseTransient = ownTransient(() => InlineEditor.cancel(editor));
    };

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
          void dispatchFromControl(
            'filter.category.visibility',
            { field: fieldRef, categories: [labels[hit.catIdx]], visible: target.checked },
            { failure: 'Could not change the category' }
          );
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
      const rgb = rgb01OfHex(target.value);
      if (rgb === null) throw new TypeError('Legend color input must be an exact #RRGGBB value');
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
        } else if (button.classList.contains('legend-count')) {
          event.stopPropagation();
          startCellCount(hit.catIdx, button);
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
    renderedMissingRow = null;
    renderedMissingToggle = null;
  }

  /**
   * The rows follow a change of colors or category state that changed no
   * visibility (a recolor made by an undo, an agent or a notebook).
   */
  function syncCategoryState() {
    if (destroyed || isRendering || renderedField === null) return;
    const field = state.getActiveField();
    if (field !== renderedField || renderedModel === null) return;
    syncRows(field, renderedModel);
  }

  return {
    refreshCategoryCounts,
    renderCategoricalLegend,
    releaseCategoricalLegend,
    syncCategoryState,
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
