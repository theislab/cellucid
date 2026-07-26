/**
 * FigureContainer - Shared Figure/Plot Container Component
 *
 * Provides a reusable plot container with:
 * - Preview area with loading/empty/error states
 * - Expand to modal functionality
 * - Export toolbar (PNG, SVG, CSV)
 * - Automatic plot cleanup on updates
 * - Summary statistics display
 *
 * Used by: DetailedAnalysisUI, and other analysis types
 *
 * @example
 * const figContainer = createFigureContainer({
 *   container: document.getElementById('figure-area'),
 *   onExportPNG: () => handlePNGExport(),
 *   onExportSVG: () => handleSVGExport(),
 *   onExportCSV: () => handleCSVExport(),
 *   expandable: true
 * });
 *
 * // Render a plot
 * await figContainer.renderPlot(plotType, pageData, options);
 *
 * // Show states
 * figContainer.showLoading();
 * figContainer.showError('Something went wrong');
 * figContainer.showEmpty('Select a variable to see results');
 *
 * // Cleanup
 * figContainer.destroy();
 */

import { loadPlotly, purgePlot, downloadImage } from '../../plots/plotly-loader.js';
import { createLayoutEngine } from '../../plots/layout-engine.js';
import { PlotRegistry } from '../../shared/plot-registry-utils.js';
import { pageDataToCSV, downloadCSV } from '../../shared/analysis-utils.js';
import {
  createAnalysisModal,
  openModal,
  closeModal,
  renderSummaryStats,
  renderStatisticalAnnotations,
  renderPlotOptions,
  createExpandButton
} from '../components/index.js';
import { getNotificationCenter } from '../../../notification-center.js';

const FIGURE_OPTION_KEYS = new Set([
  'container',
  'customColors',
  'expandable',
  'onExportCSV',
  'onExportPNG',
  'onExportSVG',
  'onPlotOptionChange',
  'showOptions',
  'showStats'
]);
const LAYOUT_OPTION_KEYS = new Set([
  'colorScheme',
  'syncXAxis',
  'syncYAxis'
]);

function requireError(error, context) {
  if (error instanceof Error) {
    return error;
  }
  return new TypeError(`${context} threw a non-Error value.`, {
    cause: error
  });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, name) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  return value;
}

function clonePlainObject(value, name) {
  requirePlainObject(value, name);
  try {
    const clone = structuredClone(value);
    requirePlainObject(clone, name);
    return clone;
  } catch (error) {
    throw new TypeError(`${name} must be structured-cloneable.`, {
      cause: error
    });
  }
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireElement(value, name) {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.appendChild !== 'function'
  ) {
    throw new TypeError(`${name} must be an appendable element.`);
  }
  return value;
}

function requirePageData(pageData) {
  const pageIds = new Set();
  let variableName = null;
  let variableKind = null;
  for (const [index, page] of pageData.entries()) {
    requirePlainObject(page, `Figure pageData[${index}]`);
    requireNonEmptyString(page.pageId, `Figure pageData[${index}] pageId`);
    requireNonEmptyString(
      page.pageName,
      `Figure pageData[${index}] pageName`
    );
    if (pageIds.has(page.pageId)) {
      throw new TypeError(
        `Figure pageData contains duplicate page id "${page.pageId}".`
      );
    }
    pageIds.add(page.pageId);
    requirePlainObject(
      page.variableInfo,
      `Figure pageData[${index}] variableInfo`
    );
    requireNonEmptyString(
      page.variableInfo.name,
      `Figure pageData[${index}] variable name`
    );
    if (
      page.variableInfo.kind !== 'category' &&
      page.variableInfo.kind !== 'continuous'
    ) {
      throw new TypeError(
        `Figure pageData[${index}] variable kind must be "category" or "continuous".`
      );
    }
    if (index === 0) {
      variableName = page.variableInfo.name;
      variableKind = page.variableInfo.kind;
    } else if (
      page.variableInfo.name !== variableName ||
      page.variableInfo.kind !== variableKind
    ) {
      throw new TypeError(
        'Figure pageData must describe one exact variable name and kind.'
      );
    }
  }
  return { variableKind, variableName };
}

function requireColorMap(colors, knownPageIds = null) {
  if (!(colors instanceof Map)) {
    throw new TypeError('Figure custom colors must be a Map.');
  }
  for (const [pageId, color] of colors) {
    requireNonEmptyString(pageId, 'Figure custom color page id');
    requireNonEmptyString(color, `Figure custom color for "${pageId}"`);
    if (knownPageIds !== null && !knownPageIds.includes(pageId)) {
      throw new RangeError(
        `Figure custom color references unknown page "${pageId}".`
      );
    }
  }
  return colors;
}

/**
 * FigureContainer Class
 *
 * Encapsulates plot container UI logic with preview, modal, and export support.
 */
export class FigureContainer {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.container - Container element to render into
   * @param {Function} [options.onExportPNG] - PNG export handler
   * @param {Function} [options.onExportSVG] - SVG export handler
   * @param {Function} [options.onExportCSV] - CSV export handler
   * @param {Function} [options.onPlotOptionChange] - Plot option change handler
   * @param {boolean} [options.expandable=true] - Show expand button
   * @param {boolean} [options.showStats=true] - Show statistics in modal
   * @param {boolean} [options.showOptions=true] - Show plot options in modal
   * @param {Map} [options.customColors] - Custom page colors map
   */
  constructor(options) {
    requirePlainObject(options, 'FigureContainer options');
    for (const key of Object.keys(options)) {
      if (!FIGURE_OPTION_KEYS.has(key)) {
        throw new TypeError(`Unknown FigureContainer option "${key}".`);
      }
    }
    requireElement(options.container, 'FigureContainer container');
    if (
      typeof document !== 'object' ||
      document === null ||
      typeof document.createElement !== 'function'
    ) {
      throw new TypeError(
        'FigureContainer requires a document with createElement().'
      );
    }
    for (const key of [
      'onExportPNG',
      'onExportSVG',
      'onExportCSV',
      'onPlotOptionChange'
    ]) {
      if (options[key] !== undefined && typeof options[key] !== 'function') {
        throw new TypeError(`FigureContainer ${key} must be a function.`);
      }
    }
    for (const key of ['expandable', 'showStats', 'showOptions']) {
      if (options[key] !== undefined && typeof options[key] !== 'boolean') {
        throw new TypeError(`FigureContainer ${key} must be a boolean.`);
      }
    }
    if (options.customColors !== undefined) {
      requireColorMap(options.customColors);
    }
    this.container = options.container;
    this.onExportPNG = options.onExportPNG;
    this.onExportSVG = options.onExportSVG;
    this.onExportCSV = options.onExportCSV;
    this.onPlotOptionChange = options.onPlotOptionChange;

    // Options with defaults
    this.expandable = options.expandable ?? true;
    this.showStats = options.showStats ?? true;
    this.showOptions = options.showOptions ?? true;
    this.customColors = new Map(options.customColors ?? []);

    // State
    this._currentPlotType = null;
    this._currentPageData = null;
    this._currentOptions = {};
    this._layoutEngine = null;
    this._modal = null;
    this._currentVariableName = null;
    this._currentVariableKind = null;
    this._renderGeneration = 0;
    this._destroyed = false;

    // DOM references
    this._previewContainer = null;
    this._actionsContainer = null;
    this._plotDiv = null;

    // Notifications
    this._notifications = getNotificationCenter();
    for (const method of ['error', 'success']) {
      if (typeof this._notifications[method] !== 'function') {
        throw new TypeError(
          `FigureContainer notification owner must implement ${method}().`
        );
      }
    }

    // Render initial state
    this._render();
  }

  /**
   * Render the figure container structure
   */
  _render() {
    this.container.innerHTML = '';
    this.container.className = 'figure-container-component';

    // Preview container
    this._previewContainer = document.createElement('div');
    this._previewContainer.className = 'analysis-preview-container empty';
    this.container.appendChild(this._previewContainer);

    // Actions container
    this._actionsContainer = document.createElement('div');
    this._actionsContainer.className = 'analysis-actions';
    this._actionsContainer.style.display = 'none';
    this.container.appendChild(this._actionsContainer);
  }

  _assertAlive() {
    if (this._destroyed) {
      throw new Error('FigureContainer has been destroyed.');
    }
  }

  _resetCurrentPlotState() {
    this._currentPlotType = null;
    this._currentPageData = null;
    this._currentOptions = {};
    this._layoutEngine = null;
    this._currentVariableName = null;
    this._currentVariableKind = null;
  }

  // ===========================================================================
  // State Display Methods
  // ===========================================================================

  /**
   * Show loading state
   */
  showLoading() {
    this._assertAlive();
    // Purge any existing plot to prevent WebGL memory leaks
    this._cleanup();
    this._resetCurrentPlotState();
    this._previewContainer.innerHTML = '';
    this._previewContainer.classList.remove('empty');
    this._previewContainer.classList.add('loading');
    this._actionsContainer.style.display = 'none';
  }

  /**
   * Show error state
   * @param {string} message - Error message
   */
  showError(message) {
    this._assertAlive();
    requireNonEmptyString(message, 'Figure error message');
    this._cleanup();
    this._resetCurrentPlotState();
    this._previewContainer.classList.remove('loading');
    this._previewContainer.classList.add('empty');
    this._previewContainer.innerHTML = '';
    const errorEl = document.createElement('div');
    errorEl.className = 'analysis-error';
    errorEl.textContent = message;
    this._previewContainer.appendChild(errorEl);
    this._actionsContainer.style.display = 'none';

    const modalPlot = this._modal?._plotContainer;
    if (modalPlot !== undefined && modalPlot !== null) {
      modalPlot.innerHTML = '';
      const modalError = document.createElement('div');
      modalError.className = 'analysis-error';
      modalError.textContent = message;
      modalPlot.appendChild(modalError);
    }
    this._notifications.error(message, { category: 'data', title: 'Analysis Error' });
  }

  /**
   * Show empty state
   * @param {string} [message] - Optional message
   */
  showEmpty(message) {
    this._assertAlive();
    if (message !== undefined) {
      requireNonEmptyString(message, 'Figure empty-state message');
    }
    this._cleanup();
    this._resetCurrentPlotState();
    this._previewContainer.classList.remove('loading');
    this._previewContainer.classList.add('empty');

    this._previewContainer.innerHTML = '';
    if (message) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'analysis-empty-message';
      emptyEl.textContent = message;
      this._previewContainer.appendChild(emptyEl);
    }

    this._actionsContainer.style.display = 'none';
  }

  // ===========================================================================
  // Plot Rendering
  // ===========================================================================

  /**
   * Render a plot
   * @param {string} plotTypeId - Plot type ID
   * @param {Object[]} pageData - Page data array
   * @param {Object} [options] - Plot options
   * @param {Object} [layoutEngineOptions] - Layout engine options
   * @returns {Promise<boolean>} Whether this request rendered the current plot
   */
  async renderPlot(plotTypeId, pageData, options = {}, layoutEngineOptions = {}) {
    this._assertAlive();
    requireNonEmptyString(plotTypeId, 'Figure plot type');
    if (!Array.isArray(pageData)) {
      throw new TypeError('Figure pageData must be an array.');
    }
    const generation = ++this._renderGeneration;
    if (pageData.length === 0) {
      this._resetCurrentPlotState();
      this.showEmpty('No data to display');
      return false;
    }

    let candidatePlotDiv = null;
    try {
      const plotType = PlotRegistry.get(plotTypeId);
      if (plotType === null) {
        throw new RangeError(`Unknown plot type: ${plotTypeId}`);
      }
      const { variableKind, variableName } = requirePageData(pageData);
      const ownedOptions = clonePlainObject(options, 'Figure plot options');
      requirePlainObject(
        layoutEngineOptions,
        'Figure layout engine options'
      );
      for (const key of Object.keys(layoutEngineOptions)) {
        if (!LAYOUT_OPTION_KEYS.has(key)) {
          throw new TypeError(
            `Unknown Figure layout engine option "${key}".`
          );
        }
      }
      const ownedLayoutOptions = clonePlainObject(
        layoutEngineOptions,
        'Figure layout engine options'
      );
      const ownedPageData = [...pageData];

      this._resetCurrentPlotState();
      this.showLoading();

      // Create layout engine
      const layoutEngine = createLayoutEngine({
        pageCount: ownedPageData.length,
        pageIds: ownedPageData.map(pd => pd.pageId),
        pageNames: ownedPageData.map(pd => pd.pageName),
        syncXAxis: true,
        syncYAxis: true,
        customColors: this.customColors,
        ...ownedLayoutOptions
      });

      await loadPlotly();
      if (
        this._destroyed ||
        generation !== this._renderGeneration
      ) {
        return false;
      }

      // Merge options with defaults
      const mergedOptions = PlotRegistry.mergeOptions(
        plotTypeId,
        ownedOptions
      );

      // Create plot div
      this._previewContainer.classList.remove('loading');
      this._previewContainer.classList.remove('empty');
      this._previewContainer.innerHTML = '';

      candidatePlotDiv = document.createElement('div');
      candidatePlotDiv.className = 'analysis-preview-plot';
      this._plotDiv = candidatePlotDiv;
      this._previewContainer.appendChild(candidatePlotDiv);

      // Render the plot
      await plotType.render(
        ownedPageData,
        mergedOptions,
        candidatePlotDiv,
        layoutEngine
      );
      if (
        this._destroyed ||
        generation !== this._renderGeneration
      ) {
        purgePlot(candidatePlotDiv);
        if (this._plotDiv === candidatePlotDiv) {
          this._plotDiv = null;
        }
        return false;
      }

      this._currentPlotType = plotTypeId;
      this._currentPageData = ownedPageData;
      this._currentOptions = ownedOptions;
      this._layoutEngine = layoutEngine;
      this._currentVariableName = variableName;
      this._currentVariableKind = variableKind;

      // Show actions
      this._renderActions();

      // Update modal if open
      if (this._modal?._plotContainer) {
        await this._updateModal(plotType, mergedOptions, ownedPageData);
      }
      if (
        this._destroyed ||
        generation !== this._renderGeneration
      ) {
        return false;
      }
      return true;
    } catch (error) {
      if (
        this._destroyed ||
        generation !== this._renderGeneration
      ) {
        if (candidatePlotDiv !== null) {
          purgePlot(candidatePlotDiv);
          if (this._plotDiv === candidatePlotDiv) {
            this._plotDiv = null;
          }
        }
        return false;
      }
      const exactError = requireError(error, `Figure plot "${plotTypeId}"`);
      this._resetCurrentPlotState();
      this.showError(`Failed to render plot: ${exactError.message}`);
      throw exactError;
    }
  }

  /**
   * Render action buttons
   */
  _renderActions() {
    this._assertAlive();
    this._actionsContainer.innerHTML = '';
    this._actionsContainer.style.display = 'flex';

    if (this.expandable) {
      const expandBtn = createExpandButton(() => {
        void this._openModal().catch(error => {
          this._showModalError(error);
        });
      });
      this._actionsContainer.appendChild(expandBtn);
    }
  }

  // ===========================================================================
  // Modal Handling
  // ===========================================================================

  /**
   * Open the expanded modal view
   */
  async _openModal() {
    this._assertAlive();
    if (this._currentPlotType === null || this._currentPageData === null) {
      throw new Error('Cannot open a figure modal before rendering a plot.');
    }
    if (this._modal !== null) {
      throw new Error('Figure modal is already open.');
    }

    const modal = createAnalysisModal({
      onClose: () => { this._modal = null; },
      onExportPNG: () => this._handleExportPNG(),
      onExportSVG: () => this._handleExportSVG(),
      onExportCSV: () => this._handleExportCSV()
    });
    for (const key of [
      '_annotationsContent',
      '_optionsContent',
      '_plotContainer',
      '_statsContent',
      '_title'
    ]) {
      requireElement(modal[key], `Figure modal ${key}`);
    }
    this._modal = modal;

    // Set title
    this._modal._title.textContent =
      `Comparing: ${this._currentVariableName}`;

    // Render plot options
    if (this.showOptions) {
      renderPlotOptions(
        this._modal._optionsContent,
        this._currentPlotType,
        this._currentOptions,
        (key, value) => {
          void this._applyPlotOptionChange(key, value);
        }
      );
    }

    openModal(this._modal);

    // Render plot in modal
    const modalRendered = await this._renderModalPlot();
    if (!modalRendered || this._modal !== modal) {
      return false;
    }

    // Render statistics
    if (this.showStats) {
      renderSummaryStats(
        this._modal._statsContent,
        this._currentPageData,
        this._currentVariableName
      );
    }

    // Render statistical annotations
    const dataType = this._currentVariableKind === 'category'
      ? 'categorical_obs'
      : 'continuous_obs';
    renderStatisticalAnnotations(
      this._modal._annotationsContent,
      this._currentPageData,
      dataType
    );
    return true;
  }

  async _applyPlotOptionChange(key, value) {
    let hadPreviousValue = false;
    let previousValue;
    try {
      requireNonEmptyString(key, 'Figure plot option key');
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
        throw new TypeError(
          'Figure plot option key must be an identifier.'
        );
      }
      hadPreviousValue = Object.hasOwn(this._currentOptions, key);
      previousValue = this._currentOptions[key];
      const candidateOptions = {
        ...this._currentOptions,
        [key]: value
      };
      this._currentOptions = clonePlainObject(
        candidateOptions,
        'Figure plot options'
      );
      if (this.onPlotOptionChange !== undefined) {
        await this.onPlotOptionChange(key, value);
      }
      return await this._renderModalPlot();
    } catch (error) {
      if (typeof key === 'string') {
        if (hadPreviousValue) {
          this._currentOptions[key] = previousValue;
        } else {
          delete this._currentOptions[key];
        }
      }
      this._showModalError(error);
      return false;
    }
  }

  /**
   * Render plot in modal
   */
  async _renderModalPlot() {
    this._assertAlive();
    const modal = this._modal;
    if (modal === null || modal._plotContainer === null) {
      throw new Error('Cannot render a figure modal without its plot container.');
    }

    await loadPlotly();
    if (this._modal !== modal) {
      return false;
    }

    purgePlot(modal._plotContainer);

    const plotType = PlotRegistry.get(this._currentPlotType);
    if (plotType === null) {
      throw new RangeError(`Unknown plot type: ${this._currentPlotType}`);
    }
    const mergedOptions = PlotRegistry.mergeOptions(
      this._currentPlotType,
      this._currentOptions
    );

    await plotType.render(
      this._currentPageData,
      mergedOptions,
      modal._plotContainer,
      this._layoutEngine
    );
    return this._modal === modal;
  }

  /**
   * Publish a modal rendering failure in the modal and notification log.
   * @param {*} error
   */
  _showModalError(error) {
    const exactError = requireError(error, 'Figure modal render');
    const plotContainer = this._modal?._plotContainer;
    if (plotContainer !== undefined && plotContainer !== null) {
      plotContainer.innerHTML = '';
      const errorEl = document.createElement('div');
      errorEl.className = 'analysis-error';
      errorEl.textContent = `Failed to render: ${exactError.message}`;
      plotContainer.appendChild(errorEl);
    }
    this._notifications.error(
      `Expanded plot failed: ${exactError.message}`,
      { category: 'data', title: 'Analysis Error' }
    );
  }

  /**
   * Update modal after options change
   */
  async _updateModal(plotType, options, pageData) {
    const modal = this._modal;
    if (modal === null || modal._plotContainer === null) {
      throw new Error('Cannot update a figure modal without its plot container.');
    }
    purgePlot(modal._plotContainer);
    await plotType.render(
      pageData,
      options,
      modal._plotContainer,
      this._layoutEngine
    );
    if (this._modal !== modal) {
      return false;
    }

    if (this.showStats) {
      renderSummaryStats(
        modal._statsContent,
        pageData,
        this._currentVariableName
      );
    }
    return true;
  }

  /**
   * Close modal if open
   */
  closeModal() {
    this._assertAlive();
    if (this._modal) {
      closeModal(this._modal);
      this._modal = null;
    }
  }

  // ===========================================================================
  // Export Handlers
  // ===========================================================================

  /**
   * Handle PNG export
   */
  async _handleExportPNG() {
    this._assertAlive();
    try {
      if (this.onExportPNG) {
        await this.onExportPNG();
        return true;
      }

      const container = this._modal?._plotContainer ?? this._plotDiv;
      if (
        container === null ||
        this._currentPlotType === null ||
        this._currentPageData === null
      ) {
        throw new Error('No rendered plot is available for PNG export.');
      }
      requireElement(container, 'PNG export plot');
      await downloadImage(container, {
        format: 'png',
        width: 1200,
        height: 800,
        filename: 'analysis'
      });
      this._notifications.success('Plot exported as PNG', { category: 'download' });
      return true;
    } catch (error) {
      const exactError = requireError(error, 'PNG export');
      this._notifications.error(
        `PNG export failed: ${exactError.message}`,
        { category: 'download' }
      );
      return false;
    }
  }

  /**
   * Handle SVG export
   */
  async _handleExportSVG() {
    this._assertAlive();
    try {
      if (this.onExportSVG) {
        await this.onExportSVG();
        return true;
      }

      const container = this._modal?._plotContainer ?? this._plotDiv;
      if (
        container === null ||
        this._currentPlotType === null ||
        this._currentPageData === null
      ) {
        throw new Error('No rendered plot is available for SVG export.');
      }
      requireElement(container, 'SVG export plot');
      await downloadImage(container, {
        format: 'svg',
        width: 1200,
        height: 800,
        filename: 'analysis'
      });
      this._notifications.success('Plot exported as SVG', { category: 'download' });
      return true;
    } catch (error) {
      const exactError = requireError(error, 'SVG export');
      this._notifications.error(
        `SVG export failed: ${exactError.message}`,
        { category: 'download' }
      );
      return false;
    }
  }

  /**
   * Handle CSV export
   */
  async _handleExportCSV() {
    this._assertAlive();
    try {
      if (this.onExportCSV) {
        await this.onExportCSV();
        return true;
      }
      if (this._currentPageData === null || this._currentPageData.length === 0) {
        throw new Error('No analysis data is available for CSV export.');
      }
      const variableName = this._currentPageData[0]?.variableInfo?.name;
      requireNonEmptyString(variableName, 'CSV export variable name');
      const csv = pageDataToCSV(this._currentPageData, variableName);
      downloadCSV(csv, 'analysis-data', this._notifications);
      return true;
    } catch (error) {
      const exactError = requireError(error, 'CSV export');
      this._notifications.error(
        `CSV export failed: ${exactError.message}`,
        { category: 'download' }
      );
      return false;
    }
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Get the current plot div element
   * @returns {HTMLElement|null}
   */
  getPlotElement() {
    this._assertAlive();
    return this._plotDiv;
  }

  /**
   * Get the modal plot element (if modal is open)
   * @returns {HTMLElement|null}
   */
  getModalPlotElement() {
    this._assertAlive();
    return this._modal === null ? null : this._modal._plotContainer;
  }

  /**
   * Get the current page data
   * @returns {Object[]|null}
   */
  getPageData() {
    this._assertAlive();
    return this._currentPageData === null
      ? null
      : [...this._currentPageData];
  }

  /**
   * Get the current plot type
   * @returns {string|null}
   */
  getPlotType() {
    this._assertAlive();
    return this._currentPlotType;
  }

  /**
   * Get the current options
   * @returns {Object}
   */
  getOptions() {
    this._assertAlive();
    return clonePlainObject(this._currentOptions, 'Figure plot options');
  }

  /**
   * Update custom colors
   * @param {Map} colors
   */
  setCustomColors(colors) {
    this._assertAlive();
    requireColorMap(
      colors,
      this._layoutEngine === null ? null : this._layoutEngine.pageIds
    );
    this.customColors = new Map(colors);
    if (this._layoutEngine !== null) {
      this._layoutEngine.customColors = new Map(colors);
    }
  }

  /**
   * Check if there's a plot rendered
   * @returns {boolean}
   */
  hasPlot() {
    this._assertAlive();
    return this._plotDiv !== null && this._currentPageData !== null;
  }

  /**
   * Cleanup previous plot
   */
  _cleanup() {
    if (this._plotDiv) {
      purgePlot(this._plotDiv);
      this._plotDiv = null;
    }

    if (this._modal?._plotContainer) {
      purgePlot(this._modal._plotContainer);
    }
  }

  /**
   * Refresh the plot (re-render with current data and options)
   */
  async refresh() {
    this._assertAlive();
    if (this._currentPlotType === null || this._currentPageData === null) {
      throw new Error('Cannot refresh a figure before rendering a plot.');
    }
    await this.renderPlot(
      this._currentPlotType,
      this._currentPageData,
      this._currentOptions
    );
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
    this._assertAlive();
    this._renderGeneration++;
    this._cleanup();
    this.closeModal();

    this._resetCurrentPlotState();

    this.container.innerHTML = '';
    this._destroyed = true;
  }
}

/**
 * Factory function to create FigureContainer
 * @param {Object} options
 * @returns {FigureContainer}
 */
export function createFigureContainer(options) {
  return new FigureContainer(options);
}

export default FigureContainer;
