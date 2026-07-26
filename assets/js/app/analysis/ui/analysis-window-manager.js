/**
 * AnalysisWindowManager
 *
 * Creates floating copies of Page Analysis sub-accordion items (modes) so users can
 * run multiple analyses in parallel perspectives.
 *
 * Key properties:
 * - Copies are floating panels (details.accordion-section) rendered in #floating-panels-root
 * - Copies are "floating-only" (not dockable back into the sidebar)
 * - Each window owns its own Analysis UI instance and must be cleaned up on close
 * - Settings are copied via UI exportSettings/importSettings (results intentionally excluded)
 */

import { getDockableAccordions } from '../../dockable-accordions-registry.js';
import { SIDEBAR_MAX_WIDTH_PX, SIDEBAR_MIN_WIDTH_PX } from '../../sidebar-metrics.js';
import { isFiniteNumber } from '../shared/number-utils.js';
import { expandPagesWithDerived } from '../shared/page-derivation-utils.js';

const MAX_ANALYSIS_WINDOWS = 20;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(
      `${label} must contain exactly: ${sortedExpected.join(', ')}`
    );
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function requireDockableAccordions() {
  const dockable = getDockableAccordions();
  if (
    dockable === null ||
    typeof dockable !== 'object' ||
    dockable.floatingRoot === null ||
    typeof dockable.floatingRoot !== 'object' ||
    typeof dockable.floatingRoot.appendChild !== 'function' ||
    typeof dockable.register !== 'function' ||
    typeof dockable.float !== 'function' ||
    typeof dockable.unregister !== 'function'
  ) {
    throw new Error(
      'Analysis windows require an initialized dockable-accordions registry'
    );
  }
  return dockable;
}

function createWindowId(counter) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `analysiswin-${counter}-${rand}`;
}

function getHeaderTitleForMode(typeInfo, modeId) {
  requireNonEmptyString(typeInfo.name, `Analysis mode "${modeId}" name`);
  return typeInfo.name;
}

function isDomRectLike(rect) {
  return (
    rect !== null &&
    typeof rect === 'object' &&
    isFiniteNumber(rect.left) &&
    isFiniteNumber(rect.top) &&
    isFiniteNumber(rect.right) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height)
  );
}

function requireSessionRect(rect) {
  requireExactKeys(
    rect,
    ['height', 'left', 'top', 'width'],
    'Analysis window rect'
  );
  if (
    !isFiniteNumber(rect.left) ||
    !isFiniteNumber(rect.top) ||
    !isFiniteNumber(rect.width) ||
    !isFiniteNumber(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    throw new TypeError(
      'Analysis window rect requires finite left/top and positive finite width/height'
    );
  }
}

function requireSettings(settings) {
  if (!isPlainObject(settings)) {
    throw new TypeError('Analysis window settings must be an object');
  }
  return structuredClone(settings);
}

export class AnalysisWindowManager {
  /**
   * @param {Object} options
   * @param {import('../../analysis/comparison-module.js').ComparisonModule} options.comparisonModule
   * @param {import('./analysis-ui-manager.js').AnalysisUIManager} options.uiManager
   * @param {HTMLElement} [options.sidebar] - Sidebar element (for initial positioning)
   */
  constructor(options) {
    if (
      options === null ||
      typeof options !== 'object' ||
      options.comparisonModule === null ||
      typeof options.comparisonModule !== 'object' ||
      options.uiManager === null ||
      typeof options.uiManager !== 'object' ||
      options.sidebar === null ||
      typeof options.sidebar !== 'object'
    ) {
      throw new TypeError(
        'AnalysisWindowManager requires comparisonModule, uiManager, and sidebar'
      );
    }
    this._comparisonModule = options.comparisonModule;
    this._uiManager = options.uiManager;
    this._sidebar = options.sidebar;

    /** @type {Map<string, { id: string, modeId: string, details: HTMLDetailsElement, content: HTMLDivElement, ui: any, lastKnownPageIds: string[], headerTitle: string, headerDesc: string, floatConstraints: any }>} */
    this._windows = new Map();

    this._counter = 0;
  }

  getWindowCount() {
    return this._windows.size;
  }

  /**
   * Export all floating analysis windows as session restore descriptors.
   *
   * The session bundle stores analysis windows as eager JSON so the UI can be
   * reconstructed quickly. Results are intentionally excluded; only settings
   * and geometry are persisted.
   *
   * @returns {Array<{ modeId: string, rect: { left: number, top: number, width: number, height: number }, settings: any, headerTitle: string, headerDesc: string, constraints: any }>}
   */
  exportSessionWindows() {
    /** @type {Array<{ modeId: string, rect: { left: number, top: number, width: number, height: number }, settings: any, headerTitle: string, headerDesc: string, constraints: any }>} */
    const out = [];

    for (const entry of this._windows.values()) {
      if (
        entry === null ||
        typeof entry !== 'object' ||
        typeof entry.details?.getBoundingClientRect !== 'function'
      ) {
        throw new TypeError('Analysis window registry contains an invalid entry');
      }
      if (typeof entry.ui?.exportSettings !== 'function') {
        throw new TypeError(
          `Analysis window "${entry.id}" UI must implement exportSettings()`
        );
      }
      requireNonEmptyString(entry.modeId, 'Analysis window modeId');
      requireNonEmptyString(entry.headerTitle, 'Analysis window headerTitle');
      if (typeof entry.headerDesc !== 'string') {
        throw new TypeError('Analysis window headerDesc must be a string');
      }

      const measuredRect = entry.details.getBoundingClientRect();
      const rect = {
        left: measuredRect.left,
        top: measuredRect.top,
        width: measuredRect.width,
        height: measuredRect.height
      };
      requireSessionRect(rect);
      const settings = requireSettings(entry.ui.exportSettings());

      out.push({
        modeId: entry.modeId,
        rect,
        settings,
        headerTitle: entry.headerTitle,
        headerDesc: entry.headerDesc
      });
    }

    return out;
  }

  /**
   * Create a floating analysis window from a session restore descriptor.
   *
   * @param {{ modeId: string, rect: { left: number, top: number, width: number, height: number }, settings: Object, headerTitle: string, headerDesc: string }} descriptor
   * @returns {string} windowId
   */
  createFromSessionDescriptor(descriptor) {
    requireExactKeys(
      descriptor,
      ['headerDesc', 'headerTitle', 'modeId', 'rect', 'settings'],
      'Analysis window descriptor'
    );
    requireNonEmptyString(descriptor.modeId, 'Analysis window descriptor modeId');
    requireSessionRect(descriptor.rect);
    const settings = requireSettings(descriptor.settings);
    requireNonEmptyString(
      descriptor.headerTitle,
      'Analysis window descriptor headerTitle'
    );
    if (typeof descriptor.headerDesc !== 'string') {
      throw new TypeError('Analysis window descriptor headerDesc must be a string');
    }

    return this._createWindow(descriptor.modeId, settings, {
      left: descriptor.rect.left,
      top: descriptor.rect.top,
      preferredSize: {
        width: descriptor.rect.width,
        height: descriptor.rect.height
      },
      headerTitle: descriptor.headerTitle,
      headerDesc: descriptor.headerDesc
    });
  }

  /**
   * Create a floating copy from the embedded (sidebar) analysis mode instance.
   * @param {string} modeId
   * @param {{ sourceRect?: DOMRect, preferredSize?: { width?: number, height?: number }, constraints?: any, headerTitle?: string, headerDesc?: string }} [options]
   * @returns {string} windowId
   */
  copyFromEmbedded(modeId, options = {}) {
    requireNonEmptyString(modeId, 'Analysis mode ID');
    if (typeof this._uiManager.getUI !== 'function') {
      throw new TypeError('Analysis UI manager must implement getUI()');
    }
    const originUi = this._uiManager.getUI(modeId);
    if (originUi === null || typeof originUi !== 'object') {
      throw new Error(`Analysis UI is not registered: ${modeId}`);
    }
    if (typeof originUi.exportSettings !== 'function') {
      throw new TypeError(
        `Analysis UI "${modeId}" must implement exportSettings()`
      );
    }
    const settings = requireSettings(originUi.exportSettings());
    return this._createWindow(modeId, settings, options);
  }

  /**
   * Create a floating copy from an existing floating window.
   * @param {string} windowId
   * @returns {string}
   */
  copyFromWindow(windowId) {
    requireNonEmptyString(windowId, 'Analysis window ID');
    const entry = this._windows.get(windowId);
    if (!entry) {
      throw new Error(`Analysis window not found: ${windowId}`);
    }
    if (typeof entry.ui?.exportSettings !== 'function') {
      throw new TypeError(
        `Analysis window "${windowId}" UI must implement exportSettings()`
      );
    }
    const rect = entry.details.getBoundingClientRect();
    const settings = requireSettings(entry.ui.exportSettings());
    return this._createWindow(entry.modeId, settings, {
      sourceRect: rect,
      preferredSize: { width: rect.width, height: rect.height },
      constraints: entry.floatConstraints,
      headerTitle: entry.headerTitle,
      headerDesc: entry.headerDesc
    });
  }

  /**
   * Close a floating analysis window and cleanup resources.
   * @param {string} windowId
   */
  closeWindow(windowId) {
    requireNonEmptyString(windowId, 'Analysis window ID');
    const entry = this._windows.get(windowId);
    if (!entry) {
      throw new Error(`Analysis window not found: ${windowId}`);
    }
    const dockable = requireDockableAccordions();
    const errors = [];
    try {
      dockable.unregister(entry.details);
    } catch (error) {
      errors.push(error);
    }
    try {
      entry.ui.destroy();
    } catch (error) {
      errors.push(error);
    }
    try {
      entry.details.remove();
    } catch (error) {
      errors.push(error);
    }
    this._windows.delete(windowId);
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Failed to close analysis window "${windowId}"`
      );
    }
  }

  closeAll() {
    const errors = [];
    for (const id of Array.from(this._windows.keys())) {
      try {
        this.closeWindow(id);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to close all analysis windows');
    }
  }

  /**
   * Propagate page add/remove/rename events to all floating windows.
   * Mirrors ComparisonModule "select all" preservation semantics per window.
   */
  onPagesChanged() {
    const pages = this._comparisonModule.dataLayer.getPages();
    if (!Array.isArray(pages)) {
      throw new TypeError('Analysis data layer must return an array of pages');
    }
    const currentPageIds = pages.map(p => p.id);
    const selectablePageIds = this._getSelectablePageIds(pages);
    const selectablePageIdSet = new Set(selectablePageIds);
    const selectableBasePageIds = currentPageIds.filter(
      pageId => selectablePageIdSet.has(pageId)
    );

    for (const entry of this._windows.values()) {
      const ui = entry.ui;
      if (
        typeof ui.onPageSelectionChange !== 'function' ||
        typeof ui.getSelectedPages !== 'function'
      ) {
        throw new TypeError(
          `Analysis window "${entry.id}" UI is missing its page selection API`
        );
      }

      if (!Array.isArray(entry.lastKnownPageIds)) {
        throw new TypeError(
          `Analysis window "${entry.id}" has invalid page history`
        );
      }
      const previousPageIds = entry.lastKnownPageIds;
      const previousPageIdSet = new Set(previousPageIds);
      if (!Array.isArray(entry.lastKnownSelectableBasePageIds)) {
        throw new TypeError(
          `Analysis window "${entry.id}" has invalid selectable-page history`
        );
      }
      const previousSelectableBasePageIds =
        entry.lastKnownSelectableBasePageIds;
      const previousSelectableBasePageIdSet =
        new Set(previousSelectableBasePageIds);
      const addedSelectableBasePageIds = selectableBasePageIds.filter(
        id => !previousPageIdSet.has(id) ||
          !previousSelectableBasePageIdSet.has(id)
      );
      const previousSelection = ui.getSelectedPages();
      if (!Array.isArray(previousSelection)) {
        throw new TypeError(
          `Analysis window "${entry.id}" selected pages must be an array`
        );
      }
      const previousSelectionSet = new Set(previousSelection);

      const hadAllPreviously =
        previousSelectableBasePageIds.length > 0 &&
        previousSelectableBasePageIds.every(
          id => previousSelectionSet.has(id)
        );

      const nextSelection = previousSelection.filter(
        id => selectablePageIdSet.has(id)
      );
      const nextSelectionSet = new Set(nextSelection);

      if (hadAllPreviously) {
        for (const id of addedSelectableBasePageIds) {
          if (!nextSelectionSet.has(id)) {
            nextSelectionSet.add(id);
            nextSelection.push(id);
          }
        }
      }

      ui.onPageSelectionChange(nextSelection);

      entry.lastKnownPageIds = currentPageIds;
      entry.lastKnownSelectableBasePageIds = selectableBasePageIds;
    }
  }

  /**
   * Propagate highlight changes (cell counts) to all floating windows.
   */
  onHighlightChanged() {
    const pages = this._comparisonModule.dataLayer.getPages();
    if (!Array.isArray(pages)) {
      throw new TypeError('Analysis data layer must return an array of pages');
    }
    const selectablePageIds = this._getSelectablePageIds(pages);
    const selectablePageIdSet = new Set(selectablePageIds);
    const basePageIdSet = new Set(pages.map(page => page.id));
    const selectableBasePageIds = selectablePageIds.filter(
      pageId => basePageIdSet.has(pageId)
    );

    for (const entry of this._windows.values()) {
      if (
        typeof entry.ui?.getSelectedPages !== 'function' ||
        typeof entry.ui?.onPageSelectionChange !== 'function' ||
        typeof entry.ui?.onHighlightChanged !== 'function'
      ) {
        throw new TypeError(
          `Analysis window "${entry.id}" UI is missing its highlight page API`
        );
      }
      const previousSelection = entry.ui.getSelectedPages();
      if (!Array.isArray(previousSelection)) {
        throw new TypeError(
          `Analysis window "${entry.id}" selected pages must be an array`
        );
      }
      const nextSelection = previousSelection.filter(
        pageId => selectablePageIdSet.has(pageId)
      );
      if (
        nextSelection.length !== previousSelection.length ||
        nextSelection.some(
          (pageId, index) => pageId !== previousSelection[index]
        )
      ) {
        entry.ui.onPageSelectionChange(nextSelection);
      }
      entry.lastKnownSelectableBasePageIds = selectableBasePageIds;
      entry.ui.onHighlightChanged();
    }
  }

  // ===========================================================================
  // Internal helpers
  // ===========================================================================

  _getSelectablePageIds(basePages) {
    const pages = expandPagesWithDerived(
      basePages,
      { includeRestOf: true }
    );
    const selectablePageIds = [];
    const seenPageIds = new Set();
    for (const page of pages) {
      if (
        page === null ||
        typeof page !== 'object' ||
        Array.isArray(page) ||
        typeof page.id !== 'string' ||
        page.id.length === 0
      ) {
        throw new TypeError(
          'Analysis window pages require a non-empty string id'
        );
      }
      if (seenPageIds.has(page.id)) {
        throw new TypeError(
          `Analysis window page ID "${page.id}" is duplicated`
        );
      }
      seenPageIds.add(page.id);
      const cellCount =
        this._comparisonModule.dataLayer.getCellCountForPageId(page.id);
      if (!Number.isSafeInteger(cellCount) || cellCount < 0) {
        throw new TypeError(
          `Analysis window page "${page.id}" cell count must be a non-negative safe integer`
        );
      }
      if (cellCount > 0) {
        selectablePageIds.push(page.id);
      }
    }
    return selectablePageIds;
  }

  _createWindow(modeId, settings, options = {}) {
    if (this._windows.size >= MAX_ANALYSIS_WINDOWS) {
      throw new RangeError(
        `Maximum of ${MAX_ANALYSIS_WINDOWS} analysis windows reached`
      );
    }
    requireNonEmptyString(modeId, 'Analysis mode ID');
    const exactSettings = requireSettings(settings);
    if (typeof this._uiManager.getTypeInfo !== 'function') {
      throw new TypeError('Analysis UI manager must implement getTypeInfo()');
    }
    const typeInfo = this._uiManager.getTypeInfo(modeId);
    if (typeInfo === null || typeof typeInfo !== 'object') {
      throw new Error(`Unknown analysis mode: ${modeId}`);
    }
    if (typeof typeInfo.factory !== 'function') {
      throw new TypeError(`Analysis mode "${modeId}" must define a factory`);
    }
    if (!isPlainObject(typeInfo.factoryOptions)) {
      throw new TypeError(
        `Analysis mode "${modeId}" factoryOptions must be an object`
      );
    }

    const dockable = requireDockableAccordions();
    const headerTitle = options.headerTitle === undefined
      ? getHeaderTitleForMode(typeInfo, modeId)
      : options.headerTitle;
    requireNonEmptyString(headerTitle, 'Analysis window headerTitle');
    const headerDesc = options.headerDesc === undefined ? '' : options.headerDesc;
    if (typeof headerDesc !== 'string') {
      throw new TypeError('Analysis window headerDesc must be a string');
    }
    const preferredSize = this._resolvePreferredSize(options);
    const floatConstraints = this._resolveFloatConstraints(options);
    const hasLeft = options.left !== undefined;
    const hasTop = options.top !== undefined;
    if (hasLeft !== hasTop) {
      throw new TypeError(
        'Analysis window position requires both left and top'
      );
    }
    if (
      hasLeft &&
      (!isFiniteNumber(options.left) || !isFiniteNumber(options.top))
    ) {
      throw new TypeError('Analysis window left and top must be finite numbers');
    }
    const computed = hasLeft
      ? { left: options.left, top: options.top }
      : this._computeInitialPosition(options.sourceRect);

    this._counter += 1;
    const windowId = createWindowId(this._counter);

    const details = document.createElement('details');
    details.className = 'accordion-section analysis-window-panel';
    details.open = true;
    details.dataset.analysisWindowId = windowId;
    details.dataset.analysisMode = modeId;
    // Floating analysis windows are reconstructed from session bundles; exclude them from
    // generic UI control capture/restore.
    details.setAttribute('data-state-serializer-skip', 'true');

    const summary = document.createElement('summary');

    const titleEl = document.createElement('span');
    titleEl.className = 'analysis-accordion-title';
    titleEl.textContent = headerTitle;

    const descEl = document.createElement('span');
    descEl.className = 'analysis-accordion-desc';
    descEl.textContent = headerDesc;

    summary.appendChild(titleEl);
    summary.appendChild(descEl);
    details.appendChild(summary);

    // Header actions (icons via CSS pseudo-elements)
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'accordion-copy-btn';
    copyBtn.title = 'Copy analysis window';
    copyBtn.setAttribute('aria-label', 'Copy analysis window');
    copyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.copyFromWindow(windowId);
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'accordion-close-btn';
    closeBtn.title = 'Close analysis window';
    closeBtn.setAttribute('aria-label', 'Close analysis window');
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.closeWindow(windowId);
    });

    summary.appendChild(copyBtn);
    summary.appendChild(closeBtn);

    const chevron = document.createElement('span');
    chevron.className = 'analysis-accordion-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    summary.appendChild(chevron);

    const content = document.createElement('div');
    content.className = 'accordion-content';
    details.appendChild(content);

    const currentPages = this._comparisonModule.dataLayer.getPages();
    if (!Array.isArray(currentPages)) {
      throw new TypeError('Analysis data layer must return an array of pages');
    }
    const currentPageIds = [];
    const seenPageIds = new Set();
    for (const page of currentPages) {
      if (
        page === null ||
        typeof page !== 'object' ||
        typeof page.id !== 'string' ||
        page.id.length === 0
      ) {
        throw new TypeError('Analysis pages require non-empty string IDs');
      }
      if (seenPageIds.has(page.id)) {
        throw new TypeError(`Analysis page ID "${page.id}" is duplicated`);
      }
      seenPageIds.add(page.id);
      currentPageIds.push(page.id);
    }
    const currentPageIdSet = new Set(currentPageIds);
    const currentSelectableBasePageIds = this._getSelectablePageIds(
      currentPages
    ).filter(pageId => currentPageIdSet.has(pageId));

    const windowEntry = {
      id: windowId,
      modeId,
      details,
      content,
      ui: null,
      lastKnownPageIds: currentPageIds,
      lastKnownSelectableBasePageIds: currentSelectableBasePageIds,
      headerTitle,
      headerDesc,
      floatConstraints
    };

    dockable.floatingRoot.appendChild(details);
    let ui = null;
    let registrationAttempted = false;
    try {
      const {
        onConfigChange: _embeddedConfigCallback,
        ...factoryOptions
      } = typeInfo.factoryOptions;

      ui = typeInfo.factory({
        ...factoryOptions,
        comparisonModule: this._comparisonModule,
        dataLayer: this._comparisonModule.dataLayer,
        multiVariableAnalysis: this._comparisonModule.multiVariableAnalysis,
        container: content,
        instanceId: windowId
      });

      if (
        ui === null ||
        typeof ui !== 'object' ||
        ui._container !== content
      ) {
        throw new TypeError(
          `Analysis factory "${modeId}" must return a fully initialized UI in the supplied container`
        );
      }
      for (const method of [
        'destroy',
        'exportSettings',
        'getSelectedPages',
        'importSettings',
        'onHighlightChanged',
        'onPageSelectionChange'
      ]) {
        if (typeof ui[method] !== 'function') {
          throw new TypeError(
            `Analysis factory "${modeId}" UI must implement ${method}()`
          );
        }
      }
      ui.importSettings(exactSettings);
      windowEntry.ui = ui;
      registrationAttempted = true;
      dockable.register(details, { dockable: false });
      dockable.float(details, {
        left: computed.left,
        top: computed.top,
        preferredSize,
        constraints: floatConstraints
      });
      this._windows.set(windowId, windowEntry);
      return windowId;
    } catch (error) {
      const cleanupErrors = [];
      if (registrationAttempted) {
        try {
          dockable.unregister(details);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (ui && typeof ui.destroy === 'function') {
        try {
          ui.destroy();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        details.remove();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      this._windows.delete(windowId);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `Analysis window "${windowId}" creation and rollback failed`
        );
      }
      throw error;
    }
  }

  _resolvePreferredSize(options = {}) {
    if (options.preferredSize !== undefined) {
      if (!isPlainObject(options.preferredSize)) {
        throw new TypeError('Analysis window preferredSize must be an object');
      }
      const keys = Object.keys(options.preferredSize);
      if (
        keys.some(key => key !== 'width' && key !== 'height') ||
        (!keys.includes('width') && !keys.includes('height'))
      ) {
        throw new TypeError(
          'Analysis window preferredSize supports only width and height'
        );
      }
      const { width, height } = options.preferredSize;
      if (
        width !== undefined &&
        (!isFiniteNumber(width) || width <= 0)
      ) {
        throw new TypeError(
          'Analysis window preferred width must be a positive finite number'
        );
      }
      if (
        height !== undefined &&
        (!isFiniteNumber(height) || height <= 0)
      ) {
        throw new TypeError(
          'Analysis window preferred height must be a positive finite number'
        );
      }
      if (width === undefined && height === undefined) {
        throw new TypeError(
          'Analysis window preferredSize requires width or height'
        );
      }
      return {
        width,
        height
      };
    }

    if (options.sourceRect !== undefined) {
      if (
        !isDomRectLike(options.sourceRect) ||
        options.sourceRect.width <= 0 ||
        options.sourceRect.height <= 0
      ) {
        throw new TypeError(
          'Analysis window sourceRect requires a positive finite DOM rectangle'
        );
      }
      return {
        width: options.sourceRect.width,
        height: options.sourceRect.height
      };
    }

    return null;
  }

  _resolveFloatConstraints(options = {}) {
    if (options.constraints !== undefined) {
      requireExactKeys(
        options.constraints,
        ['maxHeight', 'maxWidth', 'minHeight', 'minWidth'],
        'Analysis window constraints'
      );
      const { minWidth, maxWidth, minHeight, maxHeight } = options.constraints;
      if (
        !isFiniteNumber(minWidth) ||
        !isFiniteNumber(maxWidth) ||
        !isFiniteNumber(minHeight) ||
        !(isFiniteNumber(maxHeight) || maxHeight === Infinity) ||
        minWidth <= 0 ||
        maxWidth < minWidth ||
        minHeight < 0 ||
        maxHeight < minHeight
      ) {
        throw new TypeError('Analysis window constraints are invalid');
      }
      return structuredClone(options.constraints);
    }

    if (typeof this._sidebar.getBoundingClientRect !== 'function') {
      throw new TypeError('Analysis window sidebar must expose its geometry');
    }
    const sidebarWidth = this._sidebar.getBoundingClientRect().width;
    if (!isFiniteNumber(sidebarWidth) || sidebarWidth <= 0) {
      throw new TypeError('Analysis window sidebar width must be positive and finite');
    }
    const preferredWidth = options.preferredSize?.width;
    let referenceWidth;
    if (preferredWidth !== undefined) {
      referenceWidth = preferredWidth;
    } else {
      const referenceDetails = typeof this._sidebar.querySelector === 'function'
        ? this._sidebar.querySelector('details.accordion-section')
        : null;
      referenceWidth = referenceDetails?.getBoundingClientRect().width;
    }
    const gutter = isFiniteNumber(referenceWidth)
      ? Math.max(0, sidebarWidth - referenceWidth)
      : 0;

    const minWidth = Math.max(180, SIDEBAR_MIN_WIDTH_PX - gutter);
    const maxWidth = Math.max(minWidth, SIDEBAR_MAX_WIDTH_PX - gutter);

    return {
      minWidth,
      maxWidth,
      minHeight: 0,
      maxHeight: Infinity
    };
  }

  _computeInitialPosition(sourceRect) {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    if (
      !isFiniteNumber(viewportWidth) ||
      !isFiniteNumber(viewportHeight) ||
      viewportWidth <= 0 ||
      viewportHeight <= 0
    ) {
      throw new TypeError('Analysis window requires a positive finite viewport');
    }

    if (typeof this._sidebar.getBoundingClientRect !== 'function') {
      throw new TypeError('Analysis window sidebar must expose its geometry');
    }
    const sidebarRect = this._sidebar.getBoundingClientRect();
    if (!isDomRectLike(sidebarRect)) {
      throw new TypeError('Analysis window sidebar geometry is invalid');
    }
    if (sourceRect !== undefined && !isDomRectLike(sourceRect)) {
      throw new TypeError('Analysis window source geometry is invalid');
    }
    const baseLeft = sidebarRect.right + 24;
    const baseTop = 80;

    const anchorLeft = sourceRect === undefined ? baseLeft : sourceRect.right + 24;
    const anchorTop = sourceRect === undefined ? baseTop : sourceRect.top;

    // Light cascade so repeated copies don't fully overlap.
    const cascade = (this._windows.size % 8) * 18;

    const left = Math.min(Math.max(8, anchorLeft + cascade), Math.max(8, viewportWidth - 260));
    const top = Math.min(Math.max(8, anchorTop + cascade), Math.max(8, viewportHeight - 140));

    return { left, top };
  }
}

export function createAnalysisWindowManager(options) {
  return new AnalysisWindowManager(options);
}
