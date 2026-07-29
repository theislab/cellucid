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

const CATEGORY_DRAG_MIME = 'application/x-cellucid-category';
const INIT_KEYS = new Set(['state', 'legendEl', 'dataSourceManager']);
const REQUIRED_STATE_METHODS = [
  'addHighlightFromCategory',
  'deleteCategoryToUnassigned',
  'findHighlightGroupByCategory',
  'getActiveField',
  'getColorForCategory',
  'getDatasetGeneration',
  'getFields',
  'getLegendModel',
  'hideAllCategories',
  'mergeCategoriesToNewField',
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

function requirePlainRecord(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

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

function compareCategoryLabels(left, right) {
  StateValidator.validateCategoryLabel(left);
  StateValidator.validateCategoryLabel(right);
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

function formatCategoryCount(visibleCount, availableCount) {
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
  const visible = visibleCount;
  const available = availableCount;
  const visibleText = visible.toLocaleString('en-US');
  const availableText = available.toLocaleString('en-US');
  if (available > 0 && available !== visible) {
    return `${visibleText} / ${availableText} cells`;
  }
  return `${visibleText} cells`;
}

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
    formatCategoryCount(
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
  requirePlainRecord(options, 'Categorical legend options');
  for (const key of Object.keys(options)) {
    if (!INIT_KEYS.has(key)) {
      throw new TypeError(`Categorical legend contains unknown option "${key}"`);
    }
  }
  for (const key of INIT_KEYS) {
    if (!Object.hasOwn(options, key)) {
      throw new TypeError(`Categorical legend requires option "${key}"`);
    }
  }
  const { state, legendEl, dataSourceManager } = options;
  for (const methodName of REQUIRED_STATE_METHODS) {
    requireMethod(state, methodName, 'Categorical legend state');
  }
  requireMethod(
    dataSourceManager,
    'getCurrentDatasetId',
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
    for (const unsubscribe of [unsubscribeAccess, unsubscribeAnnotation]) {
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
    const counts = model.counts;
    const visibleList = counts.visible;
    const availableList = counts.available;
    const rows = legendEl.querySelectorAll('.legend-item[data-cat-index]');
    rows.forEach((row) => {
      const idx = parseExactIndex(
        row.dataset.catIndex,
        'Legend row category index'
      );
      if (idx >= model.categories.length) {
        throw new RangeError(
          `Legend row category index ${idx} is outside the model`
        );
      }
      const visible = visibleList[idx];
      const available = availableList[idx];
      formatCategoryCount(visible, available);
      const hasCells = available > 0;
      row.classList.toggle('legend-item-disabled', !hasCells);
      row.title = hasCells ? '' : 'No cells available in this category after other filters';
      const checkbox = row.querySelector('.legend-checkbox');
      if (!(checkbox instanceof view.HTMLInputElement)) {
        throw new TypeError('Legend row requires its category checkbox');
      }
      checkbox.disabled = !hasCells;
      const colorInput = row.querySelector('.legend-color-input');
      if (!(colorInput instanceof view.HTMLInputElement)) {
        throw new TypeError('Legend row requires its color input');
      }
      colorInput.disabled = !hasCells;
      const countSpan = row.querySelector('.legend-count');
      if (!(countSpan instanceof view.HTMLElement)) {
        throw new TypeError('Legend row requires its count label');
      }
      countSpan.textContent = formatCategoryCount(visible, available);
    });
  }

  function renderCategoricalLegend(field, model) {
    if (destroyed) {
      throw new Error('Categorical legend is destroyed');
    }

    closeTransientInteractions();
    isRendering = true;
    try {
      const nextLegend = _doRenderCategoricalLegend(field, model);
      legendEl.replaceChildren(nextLegend);
    } finally {
      isRendering = false;
    }
  }

  function _doRenderCategoricalLegend(field, model) {
    requireCategoricalLegendModel(field, model);

    const catSection = ownerDocument.createElement('div');
    catSection.className = 'legend-section';
    const title = ownerDocument.createElement('div');
    title.textContent = 'Click a swatch to pick a color';
    title.style.fontSize = '10px';
    title.style.opacity = '0.8';
    title.style.marginBottom = '4px';
    catSection.appendChild(title);

    const controlsDiv = ownerDocument.createElement('div');
    controlsDiv.className = 'legend-controls';
    const showAllBtn = ownerDocument.createElement('button');
    showAllBtn.type = 'button';
    showAllBtn.textContent = 'Show All';
    showAllBtn.addEventListener('click', () => {
      state.showAllCategories(field, { onlyAvailable: true });
      legendEl.querySelectorAll('.legend-checkbox:not(:disabled)').forEach((cb) => {
        cb.checked = true;
      });
    });
    const hideAllBtn = ownerDocument.createElement('button');
    hideAllBtn.type = 'button';
    hideAllBtn.textContent = 'Hide All';
    hideAllBtn.addEventListener('click', () => {
      state.hideAllCategories(field, { onlyAvailable: true });
      legendEl.querySelectorAll('.legend-checkbox:not(:disabled)').forEach((cb) => {
        cb.checked = false;
      });
    });
    controlsDiv.appendChild(showAllBtn);
    controlsDiv.appendChild(hideAllBtn);
    catSection.appendChild(controlsDiv);

    const categories = model.categories;
    const counts = model.counts;
    const visibleCounts = counts.visible;
    const availableCounts = counts.available;
    const sortedIndices = categories
      .map((category, idx) => ({ category, idx }))
      .sort((left, right) => (
        compareCategoryLabels(left.category, right.category)
      ))
      .map((item) => item.idx);

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

    const itemsContainer = ownerDocument.createElement('div');
    itemsContainer.className = 'legend-items-container';
    const needsScroll = sortedIndices.length > 16;
    if (needsScroll) {
      itemsContainer.classList.add('legend-items-scrollable');
      itemsContainer.addEventListener('scroll', () => {
        const isAtBottom =
          itemsContainer.scrollHeight - itemsContainer.scrollTop - itemsContainer.clientHeight < 8;
        itemsContainer.classList.toggle('scrolled-to-bottom', isAtBottom);
      });
    }

    sortedIndices.forEach((catIdx) => {
      const cat = formatCategoryLabel(categories[catIdx]);
      const isVisible = model.visible[catIdx];
      const visibleCount = visibleCounts[catIdx];
      const availableCount = availableCounts[catIdx];
      const hasCells = availableCount > 0;
      let originalLabel;
      if (field._originalCategories !== undefined) {
        if (
          !Array.isArray(field._originalCategories)
          || field._originalCategories.length !== categories.length
        ) {
          throw new TypeError(
            'Original categories must exactly match the current category inventory'
          );
        }
        originalLabel = field._originalCategories[catIdx];
        StateValidator.validateCategoryLabel(originalLabel);
      }
      const isRenamed = originalLabel !== undefined
        && formatCategoryLabel(originalLabel) !== cat;

      const row = ownerDocument.createElement('div');
      row.className = 'legend-item';
      if (annotating) row.classList.add('legend-item-annotating');
      row.dataset.catIndex = catIdx.toString();
      if (!hasCells) row.classList.add('legend-item-disabled');
      row.title = hasCells ? '' : 'No cells available in this category after other filters';

      const checkbox = ownerDocument.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'legend-checkbox';
      checkbox.checked = isVisible;
      checkbox.disabled = !hasCells;
      checkbox.addEventListener('change', (e) => {
        if (!(e.currentTarget instanceof view.HTMLInputElement)) {
          throw new TypeError('Legend visibility event requires its checkbox');
        }
        state.setVisibilityForCategory(
          field,
          catIdx,
          e.currentTarget.checked
        );
      });

      const swatch = ownerDocument.createElement('div');
      swatch.className = 'legend-swatch';

      const colorInput = ownerDocument.createElement('input');
      colorInput.type = 'color';
      colorInput.className = 'legend-color-input';
      colorInput.disabled = !hasCells;

      const updateColorUI = () => {
        const nextColor = state.getColorForCategory(field, catIdx);
        const hexColor = rgbToHex(nextColor);
        const cssColor = state.rgbToCss(nextColor);
        if (typeof cssColor !== 'string' || cssColor.length === 0) {
          throw new TypeError('Category RGB conversion must return CSS text');
        }
        StyleManager.setVariable(
          swatch,
          '--legend-swatch-color',
          cssColor
        );
        colorInput.value = hexColor;
      };
      updateColorUI();

      colorInput.addEventListener('input', (e) => {
        if (!(e.currentTarget instanceof view.HTMLInputElement)) {
          throw new TypeError('Legend color event requires its color input');
        }
        const rgb = hexToRgb01(e.currentTarget.value);
        state.setColorForCategory(field, catIdx, rgb);
        updateColorUI();
      });

      swatch.appendChild(colorInput);

      const labelSpan = ownerDocument.createElement('div');
      labelSpan.className = 'legend-label';
      const labelMain = ownerDocument.createElement('div');
      labelMain.className = 'legend-label-main';
      labelMain.textContent = cat;
      labelSpan.appendChild(labelMain);
      if (annotating) {
        labelSpan.classList.add('legend-label-multiline');
        const consensus = computeTopConsensusSummary(annotationSession, fieldKey, catIdx);
        const sub = ownerDocument.createElement('div');
        sub.className = 'legend-label-sub';
        const consensusNames = consensus === null ? null : consensus.names;
        const consensusUp = consensus === null ? 0 : consensus.up;
        const consensusDown = consensus === null ? 0 : consensus.down;

        const left = ownerDocument.createElement('span');
        left.className = 'legend-consensus-names';
        left.textContent = consensusNames === null ? '—' : consensusNames;

        const highlightBtn = ownerDocument.createElement('button');
        highlightBtn.type = 'button';
        highlightBtn.className = 'legend-highlight-btn';
        highlightBtn.textContent = '◉';

        const syncHighlightBtn = () => {
          const fIdx = state.activeFieldSource === FieldSource.OBS ? state.activeFieldIndex : -1;
          requireExactIndex(fIdx, 'Active observation field index');
          const group = state.findHighlightGroupByCategory(fIdx, catIdx, 'obs');
          if (
            group !== null
            && (
              typeof group !== 'object'
              || typeof group.id !== 'string'
              || group.id.length === 0
            )
          ) {
            throw new TypeError('Category highlight lookup returned an invalid group');
          }
          const active = group !== null;
          highlightBtn.classList.toggle('legend-highlight-btn--active', active);
          highlightBtn.title = active ? 'Remove highlight from this category' : 'Highlight all cells in this category';
        };
        syncHighlightBtn();

        highlightBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const fIdx = state.activeFieldSource === FieldSource.OBS ? state.activeFieldIndex : -1;
          requireExactIndex(fIdx, 'Active observation field index');

          const group = state.findHighlightGroupByCategory(fIdx, catIdx, 'obs');
          if (group !== null) {
            // Already highlighted - remove it
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
          } else {
            // Not highlighted - add it
            const added = state.addHighlightFromCategory(fIdx, catIdx, 'obs');
            if (
              added === null
              || typeof added !== 'object'
              || typeof added.id !== 'string'
              || added.id.length === 0
            ) {
              throw new Error('Category highlight was not created');
            }
          }
          syncHighlightBtn();
        });

        const right = ownerDocument.createElement('span');
        right.className = 'legend-consensus-counts';
        right.textContent = `▲${consensusUp} ▼${consensusDown}`;
        sub.appendChild(left);
        sub.appendChild(right);
        sub.appendChild(highlightBtn);
        labelSpan.appendChild(sub);
      }
      if (isRenamed) {
        labelSpan.classList.add('is-renamed');
        labelSpan.title = `Original: ${originalLabel}`;
      } else {
        labelSpan.title = annotating
          ? 'Voting mode enabled: click to vote (labels are locked).'
          : 'Double-click to rename • Drag onto another category to merge';
      }

      labelSpan.draggable = !annotating;
      labelSpan.classList.add('legend-label-draggable');
      if (!annotating) {
        labelSpan.addEventListener('dragstart', (e) => {
          row.classList.add('legend-item-dragging');
          if (e.dataTransfer === null) {
            throw new TypeError('Category drag requires DataTransfer');
          }
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(CATEGORY_DRAG_MIME, JSON.stringify({ catIdx }));
        });
        labelSpan.addEventListener('dragend', () => {
          row.classList.remove('legend-item-dragging');
          itemsContainer
            .querySelectorAll('.legend-item-drag-over')
            .forEach((el) => el.classList.remove('legend-item-drag-over'));
        });
      } else if (hasCells) {
        labelSpan.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!isCommunityAnnotationUiEnabled()) return;
          openCommunityAnnotationVotingModal({ state, defaultFieldKey: fieldKey, defaultCatIdx: catIdx });
        });
      }

      const renameBtn = ownerDocument.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'legend-rename-btn';
      renameBtn.title = 'Rename category';
      renameBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      `;

      const startRename = () => {
        if (annotating) return;
        const { fieldIndex, currentField } =
          requireCurrentCategoryField(catIdx);
        const currentLabel = formatCategoryLabel(
          currentField.categories[catIdx]
        );
        const datasetGeneration = readDatasetGeneration();
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
              datasetGeneration,
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

      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (annotating) return;
        startRename();
      });
      labelSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (annotating) return;
        startRename();
      });

      const deleteBtn = ownerDocument.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'legend-delete-btn';
      deleteBtn.title = annotating ? 'Disabled while voting is enabled' : 'Delete category (merge into unassigned)';
      deleteBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      `;
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (annotating) return;

        const { fieldIndex, currentField } =
          requireCurrentCategoryField(catIdx);

        const currentLabel = formatCategoryLabel(currentField.categories[catIdx]);
        const unassignedLabel = 'unassigned';
        const inPlace = currentField._isUserDefined === true;
        const datasetGeneration = readDatasetGeneration();
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
                `To undo, restore the original column from Deleted Fields.`
              : `This creates a new categorical column where \"${currentLabel}\" is merged into \"${unassignedLabel}\".\n` +
                `The previous column is moved to Deleted Fields for restore.`),
          confirmText: 'Delete category',
          onConfirm: () => {
            const ownsInteraction = retired === false;
            retired = true;
            releaseTransient();
            if (!ownsInteraction || !isCapturedCategoryCurrent({
              categories: capturedCategories,
              datasetGeneration,
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
      });

      row.addEventListener('dragover', (e) => {
        if (annotating) return;
        if (e.dataTransfer === null) {
          throw new TypeError('Category drag-over requires DataTransfer');
        }
        if (!Array.from(e.dataTransfer.types).includes(CATEGORY_DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('legend-item-drag-over');
      });
      row.addEventListener('dragleave', () => {
        row.classList.remove('legend-item-drag-over');
      });
      row.addEventListener('drop', (e) => {
        if (annotating) return;
        e.preventDefault();
        row.classList.remove('legend-item-drag-over');

        const payload = parseCategoryDragPayload(e.dataTransfer);
        const fromIdx = payload.catIdx;
        if (fromIdx === catIdx) return;

        const { fieldIndex, currentField } =
          requireCurrentCategoryField(catIdx);

        StateValidator.validateCategoryIndex(fromIdx, currentField);
        const fromLabel = formatCategoryLabel(currentField.categories[fromIdx]);
        const toLabel = formatCategoryLabel(currentField.categories[catIdx]);
        const inPlace = currentField._isUserDefined === true;
        const datasetGeneration = readDatasetGeneration();
        const capturedCategories = [
          { index: fromIdx, value: currentField.categories[fromIdx] },
          { index: catIdx, value: currentField.categories[catIdx] }
        ];

        let releaseTransient = () => {};
        let retired = false;
        const closeDialog = showConfirmDialog({
          title: 'Merge categories',
          message:
            `Merge category \"${fromLabel}\" into \"${toLabel}\"?\n\n` +
            (inPlace
              ? `This edits the current derived column in place.\n` +
                `To undo, restore the original column from Deleted Fields.`
              : `This creates a new categorical column and moves the previous column to Deleted Fields for restore.`),
          confirmText: 'Merge',
          onConfirm: () => {
            const ownsInteraction = retired === false;
            retired = true;
            releaseTransient();
            if (!ownsInteraction || !isCapturedCategoryCurrent({
              categories: capturedCategories,
              datasetGeneration,
              field: currentField,
              fieldIndex
            })) {
              return;
            }
            try {
              const result = state.mergeCategoriesToNewField(
                fieldIndex,
                fromIdx,
                catIdx,
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
      });

      const countSpan = ownerDocument.createElement('span');
      countSpan.className = 'legend-count';
      countSpan.textContent = formatCategoryCount(visibleCount, availableCount);

      row.appendChild(checkbox);
      row.appendChild(swatch);
      row.appendChild(labelSpan);
      row.appendChild(countSpan);
      if (!annotating) {
        row.appendChild(renameBtn);
        row.appendChild(deleteBtn);
      }
      itemsContainer.appendChild(row);
    });

    catSection.appendChild(itemsContainer);
    return catSection;
  }

  return {
    refreshCategoryCounts,
    renderCategoricalLegend,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      const failures = [];
      for (const cleanup of [
        closeTransientInteractions,
        () => lifecycle.abort(),
        unsubscribeAccess,
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
