/**
 * CategoryBuilder - Create a user-defined categorical field from highlight pages.
 *
 * This is a development-phase UI tool that:
 * - Lets users drag highlight pages into a "builder" list
 * - Resolves overlaps with a selectable strategy (first/last/new label/intersections)
 * - Optionally assigns an "uncovered" label for cells not present in any page
 * - Calls `state.createCategoricalFromPages(...)` to materialize the field
 *
 * The builder UI is intentionally excluded from state serialization via
 * `data-state-serializer-skip` on the container element.
 */

import { getNotificationCenter } from '../notification-center.js';
import { bindDropZone } from './components/drop-zone.js';
import { StyleManager } from '../../utils/style-manager.js';
import { getCategoryColor, rgbToCss } from '../../data/palettes.js';
import { formatCellCount } from '../../data/data-source.js';
import { Limits, OverlapStrategy } from '../utils/field-constants.js';
import { renderCategoryBuilderDom } from './category-builder/dom.js';
import { formatIntersectionLabel, renderIntersectionLabelInputs } from './category-builder/intersections.js';
import {
  announceKeyboardMove,
  createKeyboardMove,
  getKeyboardMoveInstructionsId
} from './keyboard-move.js';

const DROP_MIME = 'application/x-highlight-page';
const STRATEGIES = new Set([
  OverlapStrategy.FIRST,
  OverlapStrategy.LAST,
  OverlapStrategy.OVERLAP_LABEL,
  OverlapStrategy.INTERSECTIONS
]);

function requireRecord(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireMethod(owner, methodName, label) {
  requireRecord(owner, label);
  if (typeof owner[methodName] !== 'function') {
    throw new TypeError(`${label} must implement ${methodName}()`);
  }
}

function requireIdentifier(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
  ) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requireCanonicalIndex(value, length, label) {
  if (
    typeof value !== 'string'
    || !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    throw new TypeError(
      `${label} must be a canonical non-negative integer`
    );
  }
  const index = Number(value);
  if (
    !Number.isSafeInteger(index)
    || index < 0
    || index >= length
  ) {
    throw new RangeError(`${label} is outside its exact inventory`);
  }
  return index;
}

function requireCount(value, maximum, label) {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > maximum
  ) {
    throw new RangeError(
      `${label} must be an integer between 0 and ${maximum}`
    );
  }
  return value;
}

function requireCountDifference(total, used, label) {
  requireCount(used, total, `${label} used count`);
  return total - used;
}

function requireHexColor(value, label) {
  if (
    typeof value !== 'string'
    || !/^#[0-9a-fA-F]{6}$/.test(value)
  ) {
    throw new TypeError(`${label} must be an exact six-digit hex color`);
  }
  return value;
}

function requireError(value, label) {
  if (!(value instanceof Error)) {
    throw new TypeError(`${label} must fail with an Error`);
  }
  if (typeof value.message !== 'string' || value.message.length === 0) {
    throw new TypeError(`${label} Error must own a non-empty message`);
  }
  return value;
}

function cleanupAll(cleanups, message) {
  const errors = [];
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

export class CategoryBuilder {
  constructor(state, containerEl) {
    this._state = state;
    this._container = containerEl;
    this._initialized = false;
    this._unsubscribePageChanged = null;
    this._lifecycle = null;
    this._droppedItemsLifecycle = null;
    this._intersectionInputsLifecycle = null;
    this._document = null;
    this._view = null;

    this._isOpen = false;
    this._droppedPages = []; // [{ pageId, label, originalName }]
    this._preview = null; // { overlapCount, uncoveredCount, pageCounts }
    this._previewKey = null;
    this._intersectionLabels = {}; // mask string -> label

    this._els = {};
  }

  init() {
    if (this._initialized) {
      throw new Error('Category builder is already initialized');
    }
    if (this._container === null || typeof this._container !== 'object') {
      throw new TypeError(
        'Category builder requires one document-owned HTMLElement'
      );
    }
    const ownerDocument = this._container.ownerDocument;
    if (ownerDocument === null || ownerDocument === undefined) {
      throw new TypeError(
        'Category builder requires one document-owned HTMLElement'
      );
    }
    const view = ownerDocument.defaultView;
    if (
      view === null
      || view === undefined
      || !(this._container instanceof view.HTMLElement)
    ) {
      throw new TypeError(
        'Category builder requires one document-owned HTMLElement'
      );
    }
    for (const methodName of [
      'createCategoricalFromPages',
      'getFields',
      'getHighlightedCellCountForPage',
      'getHighlightPageColor',
      'on',
      'setHighlightPageColor'
    ]) {
      requireMethod(this._state, methodName, 'Category builder state');
    }
    if (
      !Number.isSafeInteger(this._state.pointCount)
      || this._state.pointCount < 0
    ) {
      throw new TypeError(
        'Category builder state requires a non-negative pointCount'
      );
    }
    this._requirePageInventory();

    this._document = ownerDocument;
    this._view = view;
    this._lifecycle = new view.AbortController();
    this._initialized = true;
    let unsubscribe = null;
    try {
      this._render();
      this._bind();
      this._syncDatasetAvailability();
      // The drop zone renders its own contents, including the list of pages
      // still available to add; nothing else pulls that list on startup.
      this._renderDroppedItems();

      // Keep colors, names, and counts synchronized with page ownership.
      unsubscribe = this._state.on('page:changed', () => {
        this._assertInitialized();
        this._syncDatasetAvailability();
        this._reconcileDroppedPages();
        this._previewKey = null;
        this._renderDroppedItems();
        this._updatePreview(true);
        this._updateConfirmState();
      });
      if (typeof unsubscribe !== 'function') {
        throw new TypeError(
          'Category builder page subscription must return an unsubscribe function'
        );
      }
      this._unsubscribePageChanged = unsubscribe;
    } catch (error) {
      const setupError = requireError(
        error,
        'Category builder initialization'
      );
      const cleanups = [];
      if (typeof unsubscribe === 'function') {
        cleanups.push(() => unsubscribe());
      }
      cleanups.push(
        () => this._abortRenderLifecycles(),
        () => this._lifecycle.abort(),
        () => this._container.replaceChildren()
      );
      try {
        cleanupAll(
          cleanups,
          'Category builder initialization cleanup failed'
        );
      } catch (cleanupError) {
        this._resetLifecycleState();
        throw new AggregateError(
          [setupError, cleanupError],
          'Category builder initialization and cleanup failed'
        );
      }
      this._resetLifecycleState();
      throw setupError;
    }
  }

  _assertInitialized() {
    if (
      !this._initialized
      || this._document === null
      || this._view === null
      || this._lifecycle === null
    ) {
      throw new Error('Category builder is not initialized');
    }
  }

  _resetLifecycleState() {
    this._initialized = false;
    this._unsubscribePageChanged = null;
    this._lifecycle = null;
    this._droppedItemsLifecycle = null;
    this._intersectionInputsLifecycle = null;
    this._document = null;
    this._view = null;
    this._els = {};
  }

  _requirePageInventory() {
    if (!Array.isArray(this._state.highlightPages)) {
      throw new TypeError(
        'Category builder state highlightPages must be an array'
      );
    }
    const ids = new Set();
    for (
      let pageIndex = 0;
      pageIndex < this._state.highlightPages.length;
      pageIndex++
    ) {
      const page = requireRecord(
        this._state.highlightPages[pageIndex],
        `Highlight page ${pageIndex}`
      );
      const pageId = requireIdentifier(
        page.id,
        `Highlight page ${pageIndex} id`
      );
      requireIdentifier(
        page.name,
        `Highlight page ${pageIndex} name`
      );
      if (ids.has(pageId)) {
        throw new Error(`Highlight page id "${pageId}" is duplicated`);
      }
      ids.add(pageId);
      if (!Array.isArray(page.highlightedGroups)) {
        throw new TypeError(
          `Highlight page "${pageId}" highlightedGroups must be an array`
        );
      }
    }
    return this._state.highlightPages;
  }

  _getPage(pageId) {
    requireIdentifier(pageId, 'Highlight page id');
    const matches = this._requirePageInventory().filter(
      page => page.id === pageId
    );
    if (matches.length !== 1) {
      throw new Error(
        `Highlight page "${pageId}" is not present exactly once`
      );
    }
    return matches[0];
  }

  _reconcileDroppedPages() {
    const pagesById = new Map(
      this._requirePageInventory().map(page => [page.id, page])
    );
    this._droppedPages = this._droppedPages.flatMap(
      (droppedPage, droppedIndex) => {
        requireRecord(droppedPage, `Dropped page ${droppedIndex}`);
        requireIdentifier(
          droppedPage.pageId,
          `Dropped page ${droppedIndex} id`
        );
        const page = pagesById.get(droppedPage.pageId);
        if (page === undefined) return [];
        if (typeof droppedPage.label !== 'string') {
          throw new TypeError(
            `Dropped page ${droppedIndex} label must be a string`
          );
        }
        return [{
          pageId: droppedPage.pageId,
          label: droppedPage.label,
          originalName: page.name
        }];
      }
    );
  }

  _abortRenderLifecycles() {
    if (this._droppedItemsLifecycle !== null) {
      this._droppedItemsLifecycle.abort();
      this._droppedItemsLifecycle = null;
    }
    if (this._intersectionInputsLifecycle !== null) {
      this._intersectionInputsLifecycle.abort();
      this._intersectionInputsLifecycle = null;
    }
  }

  _clearIntersectionInputs() {
    if (this._intersectionInputsLifecycle !== null) {
      this._intersectionInputsLifecycle.abort();
      this._intersectionInputsLifecycle = null;
    }
    this._els.intersectionList.replaceChildren();
  }

  _syncDatasetAvailability() {
    this._assertInitialized();
    if (
      !Number.isSafeInteger(this._state.pointCount)
      || this._state.pointCount < 0
    ) {
      throw new TypeError(
        'Category builder state requires a non-negative pointCount'
      );
    }
    const available = this._state.pointCount > 0;
    this._els.toggle.disabled = !available;
    this._els.toggle.setAttribute(
      'aria-disabled',
      available ? 'false' : 'true'
    );
    this._els.dropzone.setAttribute(
      'aria-disabled',
      available ? 'false' : 'true'
    );
    this._els.dropzone.classList.toggle('disabled', !available);
    if (!available) {
      this._droppedPages = [];
      this._isOpen = false;
      this._els.toggle.setAttribute('aria-expanded', 'false');
      this._els.item.classList.remove('open');
      this._renderDroppedItems();
      this._updatePreview(true);
    }
  }

  _render() {
    this._assertInitialized();
    this._els = renderCategoryBuilderDom(this._container);
  }

  _bind() {
    this._assertInitialized();
    const {
      toggle,
      panel,
      item,
      dropzone,
      pageSelect,
      addPageBtn,
      uncoveredLabel,
      overlapLabel,
      fieldName,
      confirmBtn,
      cancelBtn
    } = this._els;
    const signal = this._lifecycle.signal;

    toggle.addEventListener('click', () => {
      this._isOpen = !this._isOpen;
      toggle.setAttribute('aria-expanded', this._isOpen ? 'true' : 'false');
      item.classList.toggle('open', this._isOpen);
    }, { signal });

    bindDropZone(dropzone, {
      onDrop: dataTransfer => {
        const pageId = dataTransfer.getData(DROP_MIME);
        if (pageId.length === 0) return;
        this._addPage(pageId);
      },
      dragClass: 'dragover',
      signal
    });

    // Dragging a highlight page tab in was the only way to fill this zone, and
    // a tab is not focusable, so the Create button could never leave its
    // disabled state without a mouse. Choosing a page and pressing Add is the
    // same operation, spelled as controls both inputs can reach.
    addPageBtn.addEventListener('click', () => {
      const pageId = pageSelect.value;
      if (pageId.length === 0) return;
      this._addPage(pageId);
    }, { signal });

    uncoveredLabel.addEventListener('input', () => {
      this._updatePreview(true);
      this._updateConfirmState();
    }, { signal });
    overlapLabel.addEventListener('input', () => {
      this._updatePreview(true);
      this._updateConfirmState();
    }, { signal });
    fieldName.addEventListener(
      'input',
      () => this._updateConfirmState(),
      { signal }
    );
    const radios = panel.querySelectorAll(
      'input[name="overlap-strategy"]'
    );
    if (radios.length !== STRATEGIES.size) {
      throw new Error(
        'Category builder must render every overlap strategy exactly once'
      );
    }
    radios.forEach(radio => {
      if (!(radio instanceof this._view.HTMLInputElement)) {
        throw new TypeError(
          'Category builder overlap strategy controls must be inputs'
        );
      }
      radio.addEventListener('change', () => {
        this._updatePreview(true);
        this._updateConfirmState();
      }, { signal });
    });

    confirmBtn.addEventListener(
      'click',
      () => this._handleConfirm(),
      { signal }
    );
    cancelBtn.addEventListener(
      'click',
      () => this._handleCancel(),
      { signal }
    );
  }

  _addPage(pageId) {
    this._assertInitialized();
    if (this._state.pointCount === 0) {
      throw new Error(
        'Category builder is disabled until a dataset is loaded'
      );
    }
    requireIdentifier(pageId, 'Dropped highlight page id');
    if (this._droppedPages.some((p) => p.pageId === pageId)) return;
    const page = this._getPage(pageId);

    this._droppedPages.push({
      pageId,
      label: page.name,
      originalName: page.name
    });

    this._renderDroppedItems();
    this._updatePreview(true);
    this._updateConfirmState();
    this._announce(
      `${page.name} added. The new column now has `
      + `${this._droppedPages.length} category labels.`
    );
  }

  /**
   * Move one dropped page to another page's position.
   *
   * The pointer reorder and the keyboard reorder both land here, so neither
   * input can drift into a different notion of what a reorder does.
   */
  _movePage(fromIndex, toIndex) {
    this._assertInitialized();
    if (
      !Number.isSafeInteger(fromIndex)
      || !Number.isSafeInteger(toIndex)
      || fromIndex < 0
      || toIndex < 0
      || fromIndex >= this._droppedPages.length
      || toIndex >= this._droppedPages.length
    ) {
      throw new RangeError(
        'Category builder page move is outside its exact inventory'
      );
    }
    if (fromIndex === toIndex) return;
    const [moved] = this._droppedPages.splice(fromIndex, 1);
    requireRecord(moved, 'Dragged page');
    this._droppedPages.splice(toIndex, 0, moved);
    this._renderDroppedItems();
    this._updatePreview(true);
    this._updateConfirmState();
    return moved;
  }

  _announce(message) {
    announceKeyboardMove(this._document, message);
  }

  /**
   * Offer every highlight page that is not already a category label.
   *
   * The drop zone's only source used to be a `draggable` page tab, which is not
   * focusable and publishes nothing a keyboard can act on.
   */
  _renderPageSources() {
    this._assertInitialized();
    const { pageSelect, addPageBtn } = this._els;
    const added = new Set(this._droppedPages.map((p) => p.pageId));
    const available = this._requirePageInventory().filter(
      page => !added.has(page.id)
    );
    const usable = available.length > 0 && this._state.pointCount > 0;
    const previous = pageSelect.value;

    const options = available.map(page => {
      const option = this._document.createElement('option');
      option.value = page.id;
      option.textContent = page.name;
      return option;
    });
    if (!usable) {
      const option = this._document.createElement('option');
      option.value = '';
      option.textContent = available.length === 0
        ? 'Every page is already added'
        : 'No highlight pages available';
      options.push(option);
    }
    pageSelect.replaceChildren(...options);
    if (usable && available.some(page => page.id === previous)) {
      pageSelect.value = previous;
    }
    pageSelect.disabled = !usable;
    addPageBtn.disabled = !usable;
  }

  _renderDroppedItems() {
    this._assertInitialized();
    const { items, placeholder } = this._els;
    if (this._droppedItemsLifecycle !== null) {
      this._droppedItemsLifecycle.abort();
    }
    this._droppedItemsLifecycle = new this._view.AbortController();
    const signal = this._droppedItemsLifecycle.signal;
    this._renderPageSources();

    if (this._droppedPages.length === 0) {
      placeholder.hidden = false;
      items.replaceChildren();
      return;
    }

    placeholder.hidden = true;
    const fragment = this._document.createDocumentFragment();

    this._droppedPages.forEach((p, idx) => {
      requireRecord(p, `Dropped page ${idx}`);
      const page = this._getPage(p.pageId);
      if (typeof p.label !== 'string') {
        throw new TypeError(
          `Dropped page ${idx} label must be a string`
        );
      }
      requireIdentifier(
        p.originalName,
        `Dropped page ${idx} original name`
      );
      const pageColor = requireHexColor(
        this._state.getHighlightPageColor(p.pageId),
        `Highlight page "${p.pageId}" color`
      );
      const pageCount = requireCount(
        this._state.getHighlightedCellCountForPage(p.pageId),
        this._state.pointCount,
        `Highlight page "${p.pageId}" count`
      );

      const row = this._document.createElement('div');
      row.className = 'dropzone-item';
      row.draggable = true;
      row.dataset.idx = String(idx);
      row.setAttribute('role', 'listitem');

      const colorIndicator = this._document.createElement('span');
      colorIndicator.className = 'dropzone-item-color';
      StyleManager.setVariable(colorIndicator, '--dropzone-item-color', pageColor);
      colorIndicator.title = 'Click to change page color';

      const colorInput = this._document.createElement('input');
      colorInput.type = 'color';
      colorInput.className = 'dropzone-item-color-input';
      colorInput.value = pageColor;
      colorInput.title = 'Click to change page color';
      colorInput.addEventListener('input', () => {
        const newColor = requireHexColor(
          colorInput.value,
          'Highlight page color input'
        );
        StyleManager.setVariable(colorIndicator, '--dropzone-item-color', newColor);
        this._state.setHighlightPageColor(p.pageId, newColor);
      }, { signal });
      colorInput.addEventListener(
        'click',
        event => event.stopPropagation(),
        { signal }
      );
      colorIndicator.appendChild(colorInput);

      // The handle carried a `Drag to reorder` tooltip and nothing else: no
      // role, no tab stop, no keys. It is the pick-up handle for the shared
      // keyboard move grammar now, and still the pointer drag grip.
      const handle = this._document.createElement('span');
      handle.className = 'dropzone-item-handle';
      handle.title = 'Drag to reorder';
      handle.textContent = '⋮⋮';
      handle.setAttribute('role', 'button');
      handle.setAttribute('tabindex', '0');
      handle.setAttribute('aria-roledescription', 'movable category label');
      handle.setAttribute(
        'aria-label',
        `Move ${p.label.trim().length > 0 ? p.label : p.originalName}`
      );
      handle.setAttribute(
        'aria-describedby',
        getKeyboardMoveInstructionsId(this._document)
      );
      handle.setAttribute('aria-keyshortcuts', 'Enter Space');

      const input = this._document.createElement('input');
      input.type = 'text';
      input.className = 'dropzone-item-label';
      input.value = p.label;
      input.dataset.idx = String(idx);
      input.addEventListener('input', () => {
        const i = requireCanonicalIndex(
          input.dataset.idx,
          this._droppedPages.length,
          'Dropped page label index'
        );
        this._droppedPages[i].label = input.value;
        this._updatePreview(true);
        this._updateConfirmState();
      }, { signal });

      const source = this._document.createElement('span');
      source.className = 'dropzone-item-source';
      source.textContent = `(${p.originalName})`;

      const count = this._document.createElement('span');
      count.className = 'dropzone-item-count';
      count.textContent = `(${formatCellCount(pageCount)})`;

      const remove = this._document.createElement('button');
      remove.type = 'button';
      remove.className = 'dropzone-item-remove';
      remove.title = 'Remove';
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        const removedLabel = this._droppedPages[idx].label;
        this._droppedPages.splice(idx, 1);
        this._renderDroppedItems();
        this._updatePreview(true);
        this._updateConfirmState();
        this._announce(
          `${removedLabel} removed. The new column now has `
          + `${this._droppedPages.length} category labels.`
        );
      }, { signal });

      row.appendChild(colorIndicator);
      row.appendChild(handle);
      row.appendChild(input);
      row.appendChild(source);
      row.appendChild(count);
      row.appendChild(remove);
      fragment.appendChild(row);
    });

    items.replaceChildren(fragment);
    this._setupReordering(items);
  }

  _setupReordering(container) {
    this._assertInitialized();
    if (this._droppedItemsLifecycle === null) {
      throw new Error(
        'Category builder dropped-item lifecycle is unavailable'
      );
    }
    const signal = this._droppedItemsLifecycle.signal;
    let draggedIdx = null;

    container.querySelectorAll('.dropzone-item').forEach((item) => {
      this._bindHandleKeyboardMove(container, item, signal);

      item.addEventListener('dragstart', (e) => {
        draggedIdx = requireCanonicalIndex(
          item.dataset.idx,
          this._droppedPages.length,
          'Dragged page index'
        );
        item.classList.add('dragging');
        if (e.dataTransfer === null) {
          throw new TypeError('Page dragstart requires DataTransfer');
        }
        e.dataTransfer.effectAllowed = 'move';
      }, { signal });

      item.addEventListener('dragend', () => {
        draggedIdx = null;
        item.classList.remove('dragging');
        container.querySelectorAll('.dropzone-item').forEach((el) => el.classList.remove('drag-over'));
      }, { signal });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer === null) {
          throw new TypeError('Page dragover requires DataTransfer');
        }
        e.dataTransfer.dropEffect = 'move';
      }, { signal });

      item.addEventListener('dragenter', () => {
        const targetIdx = requireCanonicalIndex(
          item.dataset.idx,
          this._droppedPages.length,
          'Page drag target index'
        );
        if (draggedIdx !== null && draggedIdx !== targetIdx) {
          item.classList.add('drag-over');
        }
      }, { signal });

      item.addEventListener(
        'dragleave',
        () => item.classList.remove('drag-over'),
        { signal }
      );

      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        const targetIdx = requireCanonicalIndex(
          item.dataset.idx,
          this._droppedPages.length,
          'Page drop target index'
        );
        if (draggedIdx === null || draggedIdx === targetIdx) return;

        const fromIdx = draggedIdx;
        draggedIdx = null;
        this._movePage(fromIdx, targetIdx);
      }, { signal });
    });
  }

  /**
   * Give one row's grip the shared pick-up / aim / drop / cancel grammar.
   *
   * The aimed row is painted with `drag-over`, the same class the pointer path
   * applies on `dragenter`, so both inputs show the identical destination.
   */
  _bindHandleKeyboardMove(container, item, signal) {
    const handle = item.querySelector('.dropzone-item-handle');
    if (!(handle instanceof this._view.HTMLElement)) {
      throw new TypeError('Category builder row requires one move handle');
    }
    const sourceIndex = requireCanonicalIndex(
      item.dataset.idx,
      this._droppedPages.length,
      'Movable page index'
    );

    const move = createKeyboardMove({
      ownerDocument: this._document,
      describeSource: () => this._droppedPages[sourceIndex].label,
      listTargets: () => Array.from(
        container.querySelectorAll('.dropzone-item')
      ).flatMap((candidate) => {
        const index = requireCanonicalIndex(
          candidate.dataset.idx,
          this._droppedPages.length,
          'Page move destination index'
        );
        if (index === sourceIndex) return [];
        return [{
          element: candidate,
          index,
          label: `position ${index + 1}, ${this._droppedPages[index].label}`
        }];
      }),
      onAim: (aimed, previous) => {
        previous?.element.classList.remove('drag-over');
        aimed?.element.classList.add('drag-over');
      },
      onCommit: (aimed) => {
        const moved = this._movePage(sourceIndex, aimed.index);
        this._announce(
          `${moved.label} moved to position ${aimed.index + 1} `
          + `of ${this._droppedPages.length}.`
        );
        const nextHandle = container.querySelector(
          `.dropzone-item[data-idx="${aimed.index}"] .dropzone-item-handle`
        );
        nextHandle?.focus();
      },
      onPickStateChange: (picked) => {
        item.classList.toggle('dragging', picked);
      },
      emptyMessage: 'There is no other category label to move this one past.'
    });

    handle.addEventListener(
      'keydown',
      (event) => { move.handleKeydown(event); },
      { signal }
    );
    handle.addEventListener('blur', () => move.cancel(), { signal });
  }

  _getOverlapStrategy() {
    this._assertInitialized();
    const radio = this._els.panel.querySelector(
      'input[name="overlap-strategy"]:checked'
    );
    if (!(radio instanceof this._view.HTMLInputElement)) {
      throw new Error(
        'Category builder requires one selected overlap strategy'
      );
    }
    if (!STRATEGIES.has(radio.value)) {
      throw new TypeError(
        `Category builder overlap strategy "${radio.value}" is unsupported`
      );
    }
    return radio.value;
  }

  _computePreview(overlapStrategy) {
    this._assertInitialized();
    if (!STRATEGIES.has(overlapStrategy)) {
      throw new TypeError(
        `Category preview strategy "${overlapStrategy}" is unsupported`
      );
    }
    const pointCount = this._state.pointCount;
    if (!Number.isSafeInteger(pointCount) || pointCount < 1) {
      throw new TypeError(
        'Category preview requires a positive loaded pointCount'
      );
    }
    const strategy = overlapStrategy;
    const pageCounts = new Array(this._droppedPages.length).fill(0);

    const buildCellSet = (pageId) => {
      const page = this._getPage(pageId);
      const cellSet = new Set();
      for (
        let groupIndex = 0;
        groupIndex < page.highlightedGroups.length;
        groupIndex++
      ) {
        const group = requireRecord(
          page.highlightedGroups[groupIndex],
          `Highlight page "${pageId}" group ${groupIndex}`
        );
        if (typeof group.enabled !== 'boolean') {
          throw new TypeError(
            `Highlight page "${pageId}" group ${groupIndex} requires exact enabled state`
          );
        }
        if (
          !Array.isArray(group.cellIndices)
          && !(group.cellIndices instanceof Uint32Array)
        ) {
          throw new TypeError(
            `Highlight page "${pageId}" group ${groupIndex} requires cell indices`
          );
        }
        if (!group.enabled) continue;
        for (const idx of group.cellIndices) {
          if (
            !Number.isSafeInteger(idx)
            || idx < 0
            || idx >= pointCount
          ) {
            throw new RangeError(
              `Highlight page "${pageId}" group ${groupIndex} has an out-of-range cell index`
            );
          }
          cellSet.add(idx);
        }
      }
      return cellSet;
    };

    const isPowerOfTwo = v => v > 0 && (v & (v - 1)) === 0;
    const bitCount32 = (v) => {
      let x = v >>> 0;
      let c = 0;
      while (x) { x &= (x - 1); c++; }
      return c;
    };

    // ────────────────────────────────────────────────────────────────────
    // Intersections: every overlap combination becomes a category
    // ────────────────────────────────────────────────────────────────────
    if (strategy === OverlapStrategy.INTERSECTIONS) {
      if (this._droppedPages.length > Limits.MAX_INTERSECTION_PAGES) {
        throw new RangeError(
          `Each intersection supports at most ${Limits.MAX_INTERSECTION_PAGES} pages`
        );
      }
      const membershipByCell = new Map(); // cellIdx -> bitmask
      this._droppedPages.forEach((pageInfo, pageIndex) => {
        const cellSet = buildCellSet(pageInfo.pageId);
        const bit = 1 << pageIndex;
        for (const idx of cellSet) {
          const previous = membershipByCell.has(idx)
            ? membershipByCell.get(idx)
            : 0;
          membershipByCell.set(idx, previous | bit);
        }
      });

      let overlapCount = 0;
      const intersectionCounts = new Map(); // mask -> count

      for (const mask of membershipByCell.values()) {
        if (isPowerOfTwo(mask)) {
          pageCounts[Math.log2(mask)] += 1;
        } else {
          overlapCount += 1;
          const count = intersectionCounts.has(mask)
            ? intersectionCounts.get(mask)
            : 0;
          intersectionCounts.set(mask, count + 1);
        }
      }

      const intersectionRows = [...intersectionCounts.entries()]
        .map(([mask, count]) => ({ mask, count }))
        .sort((a, b) => {
          const cardinality =
            bitCount32(a.mask) - bitCount32(b.mask);
          return cardinality === 0
            ? a.mask - b.mask
            : cardinality;
        });

      const uncoveredCount = requireCountDifference(
        pointCount,
        membershipByCell.size,
        'Intersection preview'
      );
      return { overlapCount, uncoveredCount, pageCounts, intersectionRows };
    }

    // ────────────────────────────────────────────────────────────────────
    // Overlap bucket: all overlapping cells go to a new category
    // ────────────────────────────────────────────────────────────────────
    if (strategy === OverlapStrategy.OVERLAP_LABEL) {
      const assigned = new Map(); // cellIdx -> catIndex, or -1 for overlap
      let overlapCount = 0;

      this._droppedPages.forEach((pageInfo, catIndex) => {
        const cellSet = buildCellSet(pageInfo.pageId);

        for (const idx of cellSet) {
          const prev = assigned.get(idx);
          if (prev === undefined) {
            assigned.set(idx, catIndex);
            pageCounts[catIndex] += 1;
            continue;
          }
          if (prev === -1 || prev === catIndex) continue;
          assigned.set(idx, -1);
          pageCounts[prev] -= 1;
          overlapCount += 1;
        }
      });

      const uncoveredCount = requireCountDifference(
        pointCount,
        assigned.size,
        'Overlap preview'
      );
      return { overlapCount, uncoveredCount, pageCounts, overlapBucketCount: overlapCount, intersectionRows: [] };
    }

    // ────────────────────────────────────────────────────────────────────
    // First/last: overlaps assigned to first/last page in order
    // ────────────────────────────────────────────────────────────────────
    if (
      strategy !== OverlapStrategy.FIRST
      && strategy !== OverlapStrategy.LAST
    ) {
      throw new TypeError(
        `Category preview strategy "${strategy}" has no implementation`
      );
    }
    const assigned = new Map(); // cellIdx -> category index
    const overlapping = new Set();

    const addCell = (cellIdx, catIndex) => {
      const prev = assigned.get(cellIdx);
      if (prev === undefined) {
        assigned.set(cellIdx, catIndex);
        pageCounts[catIndex] += 1;
        return;
      }

      if (prev !== catIndex) overlapping.add(cellIdx);
      if (strategy === OverlapStrategy.LAST && prev !== catIndex) {
        pageCounts[prev] -= 1;
        assigned.set(cellIdx, catIndex);
        pageCounts[catIndex] += 1;
      }
    };

    this._droppedPages.forEach((pageInfo, catIndex) => {
      const cellSet = buildCellSet(pageInfo.pageId);
      for (const idx of cellSet) addCell(idx, catIndex);
    });

    const uncoveredCount = requireCountDifference(
      pointCount,
      assigned.size,
      'Ordered-overlap preview'
    );
    return { overlapCount: overlapping.size, uncoveredCount, pageCounts, intersectionRows: [] };
  }

  _updatePreview(refreshIntersectionInputs) {
    this._assertInitialized();
    if (typeof refreshIntersectionInputs !== 'boolean') {
      throw new TypeError(
        'Category preview refreshIntersectionInputs must be exactly boolean'
      );
    }
    const {
      preview,
      conflictSection,
      conflictText,
      overlapLabelSection,
      overlapLabel,
      intersectionSection,
      uncoveredSection,
      uncoveredCount,
      uncoveredLabel
    } = this._els;

    if (this._droppedPages.length === 0) {
      preview.replaceChildren();
      conflictSection.hidden = true;
      uncoveredSection.hidden = true;
      overlapLabelSection.hidden = true;
      intersectionSection.hidden = true;
      this._clearIntersectionInputs();
      this._preview = null;
      this._previewKey = null;
      this._updateConfirmState();
      return;
    }

    const strategy = this._getOverlapStrategy();
    if (
      strategy === OverlapStrategy.INTERSECTIONS
      && this._droppedPages.length > Limits.MAX_INTERSECTION_PAGES
    ) {
      const errorElement = this._document.createElement('div');
      errorElement.className = 'analysis-error';
      errorElement.textContent =
        `Each intersection supports at most ${Limits.MAX_INTERSECTION_PAGES} pages.`;
      preview.replaceChildren(errorElement);
      conflictSection.hidden = true;
      uncoveredSection.hidden = true;
      overlapLabelSection.hidden = true;
      intersectionSection.hidden = true;
      this._clearIntersectionInputs();
      this._preview = null;
      this._previewKey = null;
      this._updateConfirmState();
      return;
    }

    const nextKey = `${strategy}:${this._droppedPages.map((p) => p.pageId).join('|')}`;
    const shouldRecompute = nextKey !== this._previewKey;
    if (shouldRecompute) {
      this._preview = this._computePreview(strategy);
      this._previewKey = nextKey;
    }

    conflictSection.hidden = this._preview.overlapCount === 0;
    if (!conflictSection.hidden) {
      conflictText.textContent = `${this._preview.overlapCount.toLocaleString()} cells appear in multiple pages`;
    }

    uncoveredSection.hidden = this._preview.uncoveredCount === 0;
    if (!uncoveredSection.hidden) {
      uncoveredCount.textContent = this._preview.uncoveredCount.toLocaleString();
    }

    overlapLabelSection.hidden =
      conflictSection.hidden
      || strategy !== OverlapStrategy.OVERLAP_LABEL;
    const pageLabelError = this._getPageLabelValidationError();
    intersectionSection.hidden =
      conflictSection.hidden
      || strategy !== OverlapStrategy.INTERSECTIONS
      || pageLabelError !== null;
    if (
      strategy === OverlapStrategy.INTERSECTIONS
      && !conflictSection.hidden
      && pageLabelError === null
    ) {
      if (refreshIntersectionInputs) {
        this._renderIntersectionLabelInputs(
          this._preview.intersectionRows
        );
      }
    } else {
      this._clearIntersectionInputs();
    }

    const categoriesWrap = this._document.createElement('div');
    categoriesWrap.className = 'preview-categories';

    const addPreviewRow = ({ labelText, countValue, colorIndex = null, uncovered = false }) => {
      if (typeof labelText !== 'string') {
        throw new TypeError('Preview category label must be a string');
      }
      requireCount(
        countValue,
        this._state.pointCount,
        'Preview category count'
      );
      if (
        colorIndex !== null
        && (!Number.isSafeInteger(colorIndex) || colorIndex < 0)
      ) {
        throw new TypeError(
          'Preview category color index must be null or non-negative'
        );
      }
      if (typeof uncovered !== 'boolean') {
        throw new TypeError(
          'Preview uncovered state must be exactly boolean'
        );
      }
      const item = this._document.createElement('div');
      item.className = uncovered ? 'preview-category uncovered' : 'preview-category';

      const swatch = this._document.createElement('span');
      swatch.className = 'preview-swatch';
      if (uncovered) {
        StyleManager.setVariable(swatch, '--preview-swatch-color', 'var(--color-text-secondary)');
      } else {
        const cssColor = rgbToCss(getCategoryColor(colorIndex));
        StyleManager.setVariable(swatch, '--preview-swatch-color', cssColor);
      }

      const label = this._document.createElement('span');
      label.className = 'preview-label';
      label.textContent = labelText;

      const count = this._document.createElement('span');
      count.className = 'preview-count';
      count.textContent = countValue.toLocaleString();

      item.appendChild(swatch);
      item.appendChild(label);
      item.appendChild(count);
      categoriesWrap.appendChild(item);
    };

    const pageLabels = this._droppedPages.map((page, pageIndex) => {
      if (typeof page.label !== 'string') {
        throw new TypeError(
          `Dropped page ${pageIndex} label must be a string`
        );
      }
      return page.label.trim();
    });
    this._droppedPages.forEach((_page, i) => {
      const labelText = pageLabels[i];
      addPreviewRow({
        labelText,
        countValue: this._preview.pageCounts[i],
        colorIndex: i
      });
    });

    if (strategy === OverlapStrategy.OVERLAP_LABEL) {
      if (typeof overlapLabel.value !== 'string') {
        throw new TypeError(
          'Category builder overlap label input must be a string'
        );
      }
      addPreviewRow({
        labelText: overlapLabel.value.trim(),
        countValue: this._preview.overlapCount,
        colorIndex: this._droppedPages.length
      });
    }

    if (
      strategy === OverlapStrategy.INTERSECTIONS
      && pageLabelError === null
    ) {
      const rows = this._preview.intersectionRows;
      rows.forEach((row, idx) => {
        const maskKey = String(row.mask);
        if (
          !Object.hasOwn(this._intersectionLabels, maskKey)
          || typeof this._intersectionLabels[maskKey] !== 'string'
        ) {
          throw new Error(
            `Intersection label ${maskKey} is not initialized`
          );
        }
        addPreviewRow({
          labelText: this._intersectionLabels[maskKey].trim(),
          countValue: row.count,
          colorIndex: this._droppedPages.length + idx
        });
      });
    }

    if (typeof uncoveredLabel.value !== 'string') {
      throw new TypeError(
        'Category builder uncovered label input must be a string'
      );
    }
    const uncoveredText = uncoveredLabel.value.trim();
    if (
      this._preview.uncoveredCount > 0
      && uncoveredText.length > 0
    ) {
      addPreviewRow({
        labelText: uncoveredText,
        countValue: this._preview.uncoveredCount,
        uncovered: true
      });
    }

    const stats = this._document.createElement('div');
    stats.className = 'preview-stats';
    stats.textContent = `Total: ${this._state.pointCount.toLocaleString()} cells | ${categoriesWrap.childElementCount} categories`;

    preview.replaceChildren(categoriesWrap, stats);
    this._updateConfirmState();
  }

  _formatIntersectionLabel(mask, pageLabels) {
    if (!Array.isArray(pageLabels)) {
      throw new TypeError(
        'Intersection page labels must be an array'
      );
    }
    return formatIntersectionLabel(mask, pageLabels);
  }

  _renderIntersectionLabelInputs(rows) {
    if (!Array.isArray(rows)) {
      throw new TypeError('Intersection rows must be an array');
    }
    const pageLabels = this._droppedPages.map((page, pageIndex) => {
      const label = requireIdentifier(
        page.label.trim(),
        `Dropped page ${pageIndex} label`
      );
      return label;
    });
    this._clearIntersectionInputs();
    this._intersectionInputsLifecycle =
      new this._view.AbortController();
    try {
      renderIntersectionLabelInputs({
        listEl: this._els.intersectionList,
        rows,
        pageLabels,
        labelsByMask: this._intersectionLabels,
        onLabelsChanged: () => this._updatePreview(false),
        signal: this._intersectionInputsLifecycle.signal
      });
    } catch (error) {
      this._intersectionInputsLifecycle.abort();
      this._intersectionInputsLifecycle = null;
      throw error;
    }
  }

  _getPageLabelValidationError() {
    for (
      let pageIndex = 0;
      pageIndex < this._droppedPages.length;
      pageIndex++
    ) {
      const label = this._droppedPages[pageIndex].label;
      if (
        typeof label !== 'string'
        || label.length === 0
        || label !== label.trim()
        || label.length > Limits.MAX_CATEGORY_LABEL_LENGTH
      ) {
        return `Page ${pageIndex + 1} requires a valid non-empty trimmed label`;
      }
    }
    return null;
  }

  _getDraftValidationError() {
    this._assertInitialized();
    if (
      !Number.isSafeInteger(this._state.pointCount)
      || this._state.pointCount < 0
    ) {
      throw new TypeError(
        'Category builder state requires a non-negative pointCount'
      );
    }
    if (this._state.pointCount === 0) {
      return 'Load a dataset before creating a categorical field';
    }
    if (this._droppedPages.length === 0) {
      return 'Add at least one highlight page';
    }
    if (this._preview === null) {
      return 'Category preview is unavailable';
    }
    const fieldName = this._els.fieldName.value;
    if (
      typeof fieldName !== 'string'
      || fieldName.length === 0
      || fieldName !== fieldName.trim()
      || fieldName.length > Limits.MAX_FIELD_KEY_LENGTH
      || fieldName.includes(':')
    ) {
      return 'Column name must be a valid non-empty trimmed field name';
    }
    const fields = this._state.getFields();
    if (!Array.isArray(fields)) {
      throw new TypeError(
        'Category builder state.getFields() must return an array'
      );
    }
    for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
      const field = requireRecord(
        fields[fieldIndex],
        `Observation field ${fieldIndex}`
      );
      if (
        typeof field.key !== 'string'
        || field.key.length === 0
      ) {
        throw new TypeError(
          `Observation field ${fieldIndex} requires a field key`
        );
      }
      if (field._isDeleted !== true && field.key === fieldName) {
        return `A visible observation field named "${fieldName}" already exists`;
      }
    }

    const pageLabelError = this._getPageLabelValidationError();
    if (pageLabelError !== null) return pageLabelError;
    const labels = this._droppedPages.map(page => page.label);

    const strategy = this._getOverlapStrategy();
    if (
      strategy === OverlapStrategy.INTERSECTIONS
      && this._droppedPages.length > Limits.MAX_INTERSECTION_PAGES
    ) {
      return `Each intersection supports at most ${Limits.MAX_INTERSECTION_PAGES} pages`;
    }
    const overlapLabel = this._els.overlapLabel.value;
    if (
      typeof overlapLabel !== 'string'
      || overlapLabel !== overlapLabel.trim()
    ) {
      return 'Overlap label must be a trimmed string';
    }
    if (strategy === OverlapStrategy.OVERLAP_LABEL) {
      if (
        overlapLabel.length === 0
        || overlapLabel.length > Limits.MAX_CATEGORY_LABEL_LENGTH
      ) {
        return 'Overlap strategy requires a valid non-empty label';
      }
      labels.push(overlapLabel);
    }
    if (strategy === OverlapStrategy.INTERSECTIONS) {
      for (const row of this._preview.intersectionRows) {
        const maskKey = String(row.mask);
        const label = this._intersectionLabels[maskKey];
        if (
          typeof label !== 'string'
          || label.length === 0
          || label !== label.trim()
          || label.length > Limits.MAX_CATEGORY_LABEL_LENGTH
        ) {
          return `Intersection ${maskKey} requires a valid non-empty trimmed label`;
        }
        labels.push(label);
      }
    }

    const uncoveredLabel = this._els.uncoveredLabel.value;
    if (
      typeof uncoveredLabel !== 'string'
      || uncoveredLabel !== uncoveredLabel.trim()
      || uncoveredLabel.length > Limits.MAX_CATEGORY_LABEL_LENGTH
    ) {
      return 'Uncovered label must be a valid trimmed string';
    }
    if (
      this._preview.uncoveredCount > 0
      && uncoveredLabel.length > 0
    ) {
      labels.push(uncoveredLabel);
    }
    if (new Set(labels).size !== labels.length) {
      return 'Every category label must be unique';
    }
    if (labels.length > Limits.MAX_CATEGORIES_PER_FIELD) {
      return `A field supports at most ${Limits.MAX_CATEGORIES_PER_FIELD} categories`;
    }
    return null;
  }

  _buildDraft() {
    const validationError = this._getDraftValidationError();
    if (validationError !== null) {
      throw new Error(validationError);
    }
    const overlapStrategy = this._getOverlapStrategy();
    const intersectionLabels = {};
    if (overlapStrategy === OverlapStrategy.INTERSECTIONS) {
      for (const row of this._preview.intersectionRows) {
        const maskKey = String(row.mask);
        intersectionLabels[maskKey] =
          this._intersectionLabels[maskKey];
      }
    }
    return {
      key: this._els.fieldName.value,
      pages: this._droppedPages.map(page => ({
        pageId: page.pageId,
        label: page.label
      })),
      uncoveredLabel: this._els.uncoveredLabel.value,
      overlapStrategy,
      overlapLabel: this._els.overlapLabel.value,
      intersectionLabels
    };
  }

  _updateConfirmState() {
    this._assertInitialized();
    const validationError = this._getDraftValidationError();
    this._els.confirmBtn.disabled = validationError !== null;
    this._els.validation.hidden = validationError === null;
    this._els.validation.textContent =
      validationError === null ? '' : validationError;
  }

  _handleConfirm() {
    this._assertInitialized();
    const notifyId = getNotificationCenter().loading('Creating categorical...', { category: 'data' });

    try {
      const draft = this._buildDraft();
      const result = requireRecord(
        this._state.createCategoricalFromPages(draft),
        'Create categorical result'
      );
      if (
        typeof result.id !== 'string'
        || result.id.length === 0
        || result.field === null
        || typeof result.field !== 'object'
        || !Array.isArray(result.field.categories)
        || result.field.categories.length === 0
        || !Number.isSafeInteger(result.conflicts)
        || result.conflicts < 0
        || !Number.isSafeInteger(result.uncoveredCount)
        || result.uncoveredCount < 0
      ) {
        throw new TypeError(
          'Create categorical result does not match the exact current schema'
        );
      }
      getNotificationCenter().complete(
        notifyId,
        `Created "${draft.key}" (${result.field.categories.length} categories)`
      );
      this._handleCancel();
    } catch (error) {
      const exactError = requireError(
        error,
        'Create categorical action'
      );
      console.error(exactError);
      getNotificationCenter().fail(notifyId, exactError.message);
    }
  }

  _handleCancel() {
    this._assertInitialized();
    this._droppedPages = [];
    this._preview = null;
    this._previewKey = null;
    this._intersectionLabels = {};

    this._els.fieldName.value = '';
    this._els.uncoveredLabel.value = 'Unassigned';
    this._els.overlapLabel.value = 'Overlap';
    this._clearIntersectionInputs();
    const first = this._els.panel.querySelector(
      'input[name="overlap-strategy"][value="first"]'
    );
    if (!(first instanceof this._view.HTMLInputElement)) {
      throw new Error(
        'Category builder first-page strategy control is missing'
      );
    }
    first.checked = true;

    this._renderDroppedItems();
    this._updatePreview(true);
    this._updateConfirmState();

    // Collapse panel
    this._isOpen = false;
    this._els.toggle.setAttribute('aria-expanded', 'false');
    this._els.item.classList.remove('open');
  }

  destroy() {
    if (!this._initialized) return;
    const unsubscribe = this._unsubscribePageChanged;
    if (typeof unsubscribe !== 'function') {
      throw new Error(
        'Category builder lost its page subscription before destruction'
      );
    }
    const lifecycle = this._lifecycle;
    const droppedItemsLifecycle = this._droppedItemsLifecycle;
    const intersectionInputsLifecycle =
      this._intersectionInputsLifecycle;
    this._resetLifecycleState();
    cleanupAll(
      [
        () => lifecycle.abort(),
        () => {
          if (droppedItemsLifecycle !== null) {
            droppedItemsLifecycle.abort();
          }
        },
        () => {
          if (intersectionInputsLifecycle !== null) {
            intersectionInputsLifecycle.abort();
          }
        },
        () => unsubscribe(),
        () => this._container.replaceChildren()
      ],
      'Category builder cleanup failed'
    );
    this._droppedPages = [];
    this._preview = null;
    this._previewKey = null;
    this._intersectionLabels = {};
  }
}
