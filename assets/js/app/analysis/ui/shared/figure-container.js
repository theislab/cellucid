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
import { PlotRenderSlot } from '../../shared/plot-render-slot.js';
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

function combineErrors(errors, message) {
  const present = [...new Set(errors.filter(Boolean))];
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  return new AggregateError(present, message);
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
    this._requestedOptions = {};
    this._currentLayoutOptions = {};
    this._layoutEngine = null;
    this._modal = null;
    this._modalSlot = null;
    this._modalPlotDiv = null;
    this._currentVariableName = null;
    this._currentVariableKind = null;
    this._renderGeneration = 0;
    this._optionGeneration = 0;
    this._destroyed = false;
    this._destroyPromise = null;
    this._modalTeardowns = new WeakMap();
    this._modalTeardownTasks = new Set();
    this._modalCloseTasks = new Set();
    this._interactiveTasks = new Set();
    this._interactiveFailures = [];
    this._lastModalClosePromise = null;
    this._resizeOwners = new Map();
    this._slotRenders = new Map();
    this._candidateMeasurements = new WeakMap();

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
    this._previewSlot = this._createPlotSlot(
      this._previewContainer,
      'analysis-preview-plot'
    );
    this._installResponsiveResize(
      this._previewSlot,
      this._previewContainer,
      () => this._plotDiv
    );
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
    this._requestedOptions = {};
    this._currentLayoutOptions = {};
    this._layoutEngine = null;
    this._currentVariableName = null;
    this._currentVariableKind = null;
    this._optionGeneration++;
  }

  _createPlotSlot(host, candidateClassName) {
    requireElement(host, 'Figure plot slot host');
    requireNonEmptyString(candidateClassName, 'Figure plot candidate class');
    if (host.style && !host.style.position) {
      host.style.position = 'relative';
    }

    const slot = new PlotRenderSlot({
      host,
      createCandidate: ({ host: candidateHost }) => {
        const ownerDocument = candidateHost.ownerDocument ?? document;
        if (typeof ownerDocument?.createElement !== 'function') {
          throw new TypeError(
            'Figure plot slot host must provide an owner document.'
          );
        }
        const candidate = ownerDocument.createElement('div');
        candidate.className = candidateClassName;
        candidate.style.position = 'absolute';
        candidate.style.inset = '0';
        candidate.style.boxSizing = 'border-box';
        return candidate;
      },
      render: args => this._renderPlotCandidate(args),
      purge: ({ candidate }) => purgePlot(candidate)
    });
    this._slotRenders.set(slot, new Set());
    return slot;
  }

  async _renderPlotCandidate({ candidate, payload, measurement }) {
    await loadPlotly();
    const plotResult = await payload.plotType.render(
      payload.pageData,
      payload.mergedOptions,
      candidate,
      payload.layoutEngine
    );
    this._candidateMeasurements.set(candidate, measurement);
    return { measurement, payload, plotResult };
  }

  _trackSlotRender(slot, renderPromise) {
    const renders = this._slotRenders.get(slot);
    if (renders === undefined) {
      throw new Error('Figure plot slot is not owned by this container.');
    }
    renders.add(renderPromise);
    renderPromise.then(
      () => renders.delete(renderPromise),
      () => renders.delete(renderPromise)
    );
    return renderPromise;
  }

  _trackInteractiveTask(task, context) {
    if (task === null || task === undefined || typeof task.then !== 'function') {
      throw new TypeError(`${context} must return a Promise.`);
    }
    this._interactiveTasks.add(task);
    const releaseTask = () => {
      this._interactiveTasks.delete(task);
    };
    const observer = task.then(
      releaseTask,
      error => {
        // Destruction owns every rejection that was already queued when the
        // terminal generation began. Keep that task registered until destroy()
        // snapshots it instead of silently dropping a same-turn failure.
        if (this._destroyed) return;
        releaseTask();
        const exactError = requireError(error, context);
        try {
          this._showModalError(exactError);
        } catch (reportingError) {
          this._interactiveFailures.push(
            combineErrors(
              [
                exactError,
                requireError(
                  reportingError,
                  `${context} failure reporting`
                )
              ],
              `${context} and failure reporting failed`
            )
          );
        }
      }
    );
    void Promise.resolve(observer).catch(() => {});
    return task;
  }

  _installResponsiveResize(slot, host, getCommittedCandidate) {
    if (typeof globalThis.ResizeObserver !== 'function') {
      throw new TypeError(
        'FigureContainer requires ResizeObserver for responsive plots.'
      );
    }
    if (
      typeof globalThis.requestAnimationFrame !== 'function' ||
      typeof globalThis.cancelAnimationFrame !== 'function'
    ) {
      throw new TypeError(
        'FigureContainer requires animation-frame scheduling for responsive plots.'
      );
    }

    const owner = {
      activeLease: null,
      destroyed: false,
      destroyPromise: null,
      failures: [],
      frameId: null,
      lastCandidate: null,
      lastHeight: null,
      lastWidth: null,
      observer: null,
      rerun: false
    };
    const schedule = () => {
      if (owner.destroyed || getCommittedCandidate() === null) return;
      if (owner.frameId !== null || owner.activeLease !== null) {
        owner.rerun = true;
        return;
      }
      const pendingFrame = {};
      owner.frameId = pendingFrame;
      const frameId = globalThis.requestAnimationFrame(() => {
        owner.frameId = null;
        if (owner.destroyed || getCommittedCandidate() === null) return;

        const lease = slot.withCommittedPlot(async candidate => {
          if (
            owner.destroyed ||
            candidate !== getCommittedCandidate()
          ) {
            return false;
          }
          const bounds = host.getBoundingClientRect();
          const width = Number(bounds.width);
          const height = Number(bounds.height);
          if (
            !Number.isFinite(width) ||
            width < 0 ||
            !Number.isFinite(height) ||
            height < 0
          ) {
            throw new TypeError(
              'Figure resize requires finite, non-negative host dimensions.'
            );
          }
          if (width === 0 || height === 0) return false;
          if (
            candidate === owner.lastCandidate &&
            width === owner.lastWidth &&
            height === owner.lastHeight
          ) {
            return false;
          }

          candidate.style.width = `${width}px`;
          candidate.style.height = `${height}px`;
          const Plotly = await loadPlotly();
          if (typeof Plotly?.Plots?.resize !== 'function') {
            throw new TypeError(
              'Responsive figure rendering requires Plotly.Plots.resize().'
            );
          }
          await Plotly.Plots.resize(candidate);
          owner.lastCandidate = candidate;
          owner.lastWidth = width;
          owner.lastHeight = height;
          return true;
        });
        owner.activeLease = lease;
        void lease.catch(error => {
          if (owner.destroyed) return;
          const exactError = requireError(error, 'Figure responsive resize');
          owner.failures.push(exactError);
          try {
            this._notifications.error(
              `Plot resize failed: ${exactError.message}`,
              { category: 'data', title: 'Analysis Error' }
            );
          } catch (notificationError) {
            owner.failures.push(
              requireError(
                notificationError,
                'Figure resize failure notification'
              )
            );
          }
        });
        lease.then(
          () => {
            owner.activeLease = null;
            if (owner.rerun) {
              owner.rerun = false;
              schedule();
            }
          },
          () => {
            owner.activeLease = null;
            if (owner.rerun) {
              owner.rerun = false;
              schedule();
            }
          }
        );
      });
      if (owner.frameId === pendingFrame) owner.frameId = frameId;
    };
    owner.schedule = schedule;
    owner.noteCommit = (candidate, measurement) => {
      if (owner.destroyed) return;
      const width = Number(measurement?.width);
      const height = Number(measurement?.height);
      if (
        !Number.isFinite(width) ||
        width < 0 ||
        !Number.isFinite(height) ||
        height < 0
      ) {
        throw new TypeError(
          'Figure commit requires finite, non-negative render dimensions.'
        );
      }
      owner.lastCandidate = candidate;
      owner.lastWidth = width;
      owner.lastHeight = height;
      schedule();
    };

    owner.observer = new globalThis.ResizeObserver(schedule);
    if (
      typeof owner.observer.observe !== 'function' ||
      typeof owner.observer.disconnect !== 'function'
    ) {
      throw new TypeError(
        'Figure ResizeObserver must implement observe() and disconnect().'
      );
    }
    owner.observer.observe(host);
    owner.destroy = () => {
      if (owner.destroyPromise !== null) return owner.destroyPromise;
      owner.destroyed = true;
      const activeLease = owner.activeLease;
      owner.destroyPromise = (async () => {
        const errors = [];
        try {
          owner.observer.disconnect();
        } catch (error) {
          errors.push(error);
        }
        if (owner.frameId !== null) {
          try {
            globalThis.cancelAnimationFrame(owner.frameId);
          } catch (error) {
            errors.push(error);
          }
          owner.frameId = null;
        }
        if (activeLease !== null) {
          try {
            await activeLease;
          } catch (error) {
            errors.push(error);
          }
        }
        errors.push(...owner.failures);
        const failure = combineErrors(
          errors,
          'Figure responsive resize teardown failed'
        );
        if (failure) throw failure;
      })();
      return owner.destroyPromise;
    };
    this._resizeOwners.set(slot, owner);
    return owner;
  }

  async _destroyResizeOwner(slot) {
    const owner = this._resizeOwners.get(slot);
    if (owner === undefined) return;
    this._resizeOwners.delete(slot);
    await owner.destroy();
  }

  _noteResponsiveCommit(slot, candidate) {
    const owner = this._resizeOwners.get(slot);
    if (owner === undefined) {
      throw new Error('Figure responsive owner was not found for its plot slot.');
    }
    const measurement = this._candidateMeasurements.get(candidate);
    if (measurement === undefined) {
      throw new Error(
        'Figure committed candidate is missing its render measurement.'
      );
    }
    owner.noteCommit(candidate, measurement);
  }

  async _invalidateSlot(slot) {
    if (slot === null || slot === undefined) return;
    const renders = [...(this._slotRenders.get(slot) ?? [])];
    const outcomes = await Promise.allSettled([
      slot.invalidate(),
      ...renders
    ]);
    const failure = combineErrors(
      outcomes
        .filter(outcome => outcome.status === 'rejected')
        .map(outcome => outcome.reason),
      'Figure plot invalidation failed'
    );
    if (failure) throw failure;
  }

  _removePlotMessages(host) {
    if (!host?.children) return;
    for (const child of [...host.children]) {
      if (
        child?.classList?.contains('analysis-error') ||
        child?.classList?.contains('analysis-empty-message')
      ) {
        child.remove();
      }
    }
  }

  _setPreviewVisualState({ empty, loading }) {
    if (empty) this._previewContainer.classList.add('empty');
    else this._previewContainer.classList.remove('empty');
    if (loading) this._previewContainer.classList.add('loading');
    else this._previewContainer.classList.remove('loading');
    this._actionsContainer.style.display = 'none';
  }

  _appendPlotMessage(host, className, message) {
    this._removePlotMessages(host);
    if (message === null) return null;
    const messageElement = document.createElement('div');
    messageElement.className = className;
    messageElement.textContent = message;
    host.appendChild(messageElement);
    return messageElement;
  }

  async _invalidatePlots() {
    const previewSlot = this._previewSlot;
    const modalSlot = this._modalSlot;
    this._plotDiv = null;
    this._modalPlotDiv = null;
    const outcomes = await Promise.allSettled([
      this._invalidateSlot(previewSlot),
      this._invalidateSlot(modalSlot)
    ]);
    const failure = combineErrors(
      outcomes
        .filter(outcome => outcome.status === 'rejected')
        .map(outcome => outcome.reason),
      'Figure plot cleanup failed'
    );
    if (failure) throw failure;
  }

  async _showState(kind, message, generation) {
    if (generation !== this._renderGeneration || this._destroyed) return false;
    this._resetCurrentPlotState();
    if (kind === 'loading') {
      this._setPreviewVisualState({ empty: false, loading: true });
      this._appendPlotMessage(this._previewContainer, '', null);
    } else if (kind === 'error') {
      this._setPreviewVisualState({ empty: false, loading: false });
      this._appendPlotMessage(
        this._previewContainer,
        'analysis-error',
        message
      );
    } else {
      this._setPreviewVisualState({
        empty: message === null,
        loading: false
      });
      this._appendPlotMessage(
        this._previewContainer,
        'analysis-empty-message',
        message
      );
    }

    const modal = this._modal;
    if (kind === 'error' && modal?._plotContainer) {
      this._appendPlotMessage(
        modal._plotContainer,
        'analysis-error',
        message
      );
    }

    await this._invalidatePlots();
    return generation === this._renderGeneration && !this._destroyed;
  }

  // ===========================================================================
  // State Display Methods
  // ===========================================================================

  /**
   * Show loading state
   * @returns {Promise<boolean>}
   */
  async showLoading() {
    this._assertAlive();
    const generation = ++this._renderGeneration;
    return this._showState('loading', null, generation);
  }

  /**
   * Show error state
   * @param {string} message - Error message
   * @returns {Promise<boolean>}
   */
  async showError(message) {
    this._assertAlive();
    requireNonEmptyString(message, 'Figure error message');
    const generation = ++this._renderGeneration;
    const cleanup = this._showState('error', message, generation);
    this._notifications.error(message, { category: 'data', title: 'Analysis Error' });
    return cleanup;
  }

  /**
   * Show empty state
   * @param {string} [message] - Optional message
   * @returns {Promise<boolean>}
   */
  async showEmpty(message) {
    this._assertAlive();
    if (message !== undefined) {
      requireNonEmptyString(message, 'Figure empty-state message');
    }
    const generation = ++this._renderGeneration;
    return this._showState('empty', message ?? null, generation);
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
    if (pageData.length === 0) {
      await this.showEmpty('No data to display');
      return false;
    }

    const generation = ++this._renderGeneration;
    let previewCommitted = false;
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

      // Create layout engine
      const layoutEngine = createLayoutEngine({
        pageCount: ownedPageData.length,
        pageIds: ownedPageData.map(pd => pd.pageId),
        pageNames: ownedPageData.map(pd => pd.pageName),
        syncXAxis: true,
        syncYAxis: true,
        customColors: new Map(this.customColors),
        ...ownedLayoutOptions
      });

      // Merge options with defaults
      const mergedOptions = PlotRegistry.mergeOptions(
        plotTypeId,
        ownedOptions
      );
      const payload = {
        figureGeneration: generation,
        layoutEngine,
        layoutOptions: ownedLayoutOptions,
        mergedOptions,
        options: ownedOptions,
        pageData: ownedPageData,
        plotType,
        plotTypeId,
        variableKind,
        variableName
      };

      // Keep the previous committed child visible until the candidate commits.
      this._removePlotMessages(this._previewContainer);
      this._previewContainer.classList.remove('empty');
      this._previewContainer.classList.add('loading');
      this._actionsContainer.style.display = 'none';

      const candidatePlotDiv = await this._trackSlotRender(
        this._previewSlot,
        this._previewSlot.render(payload, {
          isCurrent: () =>
            !this._destroyed &&
            generation === this._renderGeneration
        })
      );
      if (candidatePlotDiv === null) {
        return false;
      }

      // Publish exact scientific state only after the preview child committed.
      this._currentPlotType = plotTypeId;
      this._currentPageData = ownedPageData;
      this._currentOptions = ownedOptions;
      this._requestedOptions = clonePlainObject(
        ownedOptions,
        'Figure plot options'
      );
      this._currentLayoutOptions = ownedLayoutOptions;
      this._layoutEngine = layoutEngine;
      this._currentVariableName = variableName;
      this._currentVariableKind = variableKind;
      this._plotDiv = candidatePlotDiv;
      this._noteResponsiveCommit(this._previewSlot, candidatePlotDiv);
      const optionGeneration = ++this._optionGeneration;
      previewCommitted = true;

      // Show actions
      this._previewContainer.classList.remove('loading');
      this._previewContainer.classList.remove('empty');
      this._renderActions();

      // Update modal if open
      if (this._modal?._plotContainer) {
        const modal = this._modal;
        const modalRendered = await this._renderModalPayload(payload, {
          figureGeneration: generation,
          modal,
          optionGeneration
        });
        if (modalRendered) this._publishModalMetadata(payload, modal);
      }
      return true;
    } catch (error) {
      const exactError = requireError(error, `Figure plot "${plotTypeId}"`);
      if (
        this._destroyed ||
        generation !== this._renderGeneration
      ) {
        throw exactError;
      }
      if (previewCommitted) {
        this._showModalError(exactError);
        throw exactError;
      }

      let stateError = null;
      try {
        await this.showError(`Failed to render plot: ${exactError.message}`);
      } catch (cleanupError) {
        stateError = cleanupError;
      }
      throw combineErrors(
        [exactError, stateError],
        `Figure plot "${plotTypeId}" render and cleanup failed`
      );
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
        this._trackInteractiveTask(
          this._openModal(),
          'Expanded figure open'
        );
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

    let modal = null;
    modal = createAnalysisModal({
      beforeClose: () => this._teardownModalOwnership(modal),
      onClose: () => this._finalizeModalOwnership(modal),
      onCloseError: error => {
        const exactError = requireError(error, 'Figure modal close');
        this._notifications.error(
          `Modal close failed: ${exactError.message}`,
          { category: 'data', title: 'Analysis Error' }
        );
      },
      onExportPNG: () => this._trackInteractiveTask(
        this._handleExportPNG(),
        'PNG export'
      ),
      onExportSVG: () => this._trackInteractiveTask(
        this._handleExportSVG(),
        'SVG export'
      ),
      onExportCSV: () => this._trackInteractiveTask(
        this._handleExportCSV(),
        'CSV export'
      )
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
    this._modalSlot = this._createPlotSlot(
      modal._plotContainer,
      'analysis-modal-plot-candidate'
    );
    modal._figurePlotSlot = this._modalSlot;
    modal._figureResizeOwner = this._installResponsiveResize(
      this._modalSlot,
      modal._plotContainer,
      () => this._modal === modal ? this._modalPlotDiv : null
    );

    // Set title
    modal._title.textContent =
      `Comparing: ${this._currentVariableName}`;

    // Render plot options
    if (this.showOptions) {
      renderPlotOptions(
        modal._optionsContent,
        this._currentPlotType,
        this._currentOptions,
        (key, value) => {
          this._trackInteractiveTask(
            this._applyPlotOptionChange(key, value),
            'Figure plot option update'
          );
        }
      );
    }

    openModal(modal);

    // Render plot in modal
    const modalRendered = await this._renderModalPlot();
    if (!modalRendered || this._modal !== modal) {
      return false;
    }

    this._publishModalMetadata(this._currentModalPayload(), modal);
    return true;
  }

  async _applyPlotOptionChange(key, value) {
    const figureGeneration = this._renderGeneration;
    const optionGeneration = ++this._optionGeneration;
    try {
      requireNonEmptyString(key, 'Figure plot option key');
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
        throw new TypeError(
          'Figure plot option key must be an identifier.'
        );
      }
      const candidateOptions = {
        ...this._requestedOptions,
        [key]: value
      };
      const ownedCandidateOptions = clonePlainObject(
        candidateOptions,
        'Figure plot options'
      );
      this._requestedOptions = clonePlainObject(
        ownedCandidateOptions,
        'Figure plot options'
      );
      if (this.onPlotOptionChange !== undefined) {
        await this.onPlotOptionChange(key, value);
      }
      if (
        this._destroyed ||
        figureGeneration !== this._renderGeneration ||
        optionGeneration !== this._optionGeneration
      ) {
        return false;
      }

      const plotType = PlotRegistry.get(this._currentPlotType);
      if (plotType === null) {
        throw new RangeError(`Unknown plot type: ${this._currentPlotType}`);
      }
      const payload = this._currentModalPayload({
        mergedOptions: PlotRegistry.mergeOptions(
          this._currentPlotType,
          ownedCandidateOptions
        ),
        options: ownedCandidateOptions,
        plotType
      });
      const modal = this._modal;
      const modalRendered = await this._renderModalPayload(payload, {
        figureGeneration,
        modal,
        optionGeneration
      });
      if (!modalRendered) return false;

      // Option state belongs to the candidate only after that child commits.
      this._currentOptions = ownedCandidateOptions;
      this._requestedOptions = clonePlainObject(
        ownedCandidateOptions,
        'Figure plot options'
      );
      this._publishModalMetadata(payload, modal);
      return true;
    } catch (error) {
      if (
        this._destroyed ||
        figureGeneration !== this._renderGeneration ||
        optionGeneration !== this._optionGeneration
      ) {
        return false;
      }
      this._requestedOptions = clonePlainObject(
        this._currentOptions,
        'Figure plot options'
      );
      this._renderModalOptions();
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

    return this._renderModalPayload(this._currentModalPayload(), {
      figureGeneration: this._renderGeneration,
      modal,
      optionGeneration: this._optionGeneration
    });
  }

  _currentModalPayload(overrides = {}) {
    if (
      this._currentPlotType === null ||
      this._currentPageData === null ||
      this._layoutEngine === null
    ) {
      throw new Error('Cannot render a modal without committed figure data.');
    }
    const plotType = overrides.plotType ??
      PlotRegistry.get(this._currentPlotType);
    if (plotType === null) {
      throw new RangeError(`Unknown plot type: ${this._currentPlotType}`);
    }
    return {
      figureGeneration: this._renderGeneration,
      layoutEngine: this._layoutEngine,
      layoutOptions: this._currentLayoutOptions,
      mergedOptions: overrides.mergedOptions ??
        PlotRegistry.mergeOptions(
          this._currentPlotType,
          this._currentOptions
        ),
      options: overrides.options ?? this._currentOptions,
      pageData: this._currentPageData,
      plotType,
      plotTypeId: this._currentPlotType,
      variableKind: this._currentVariableKind,
      variableName: this._currentVariableName
    };
  }

  async _renderModalPayload(
    payload,
    {
      figureGeneration,
      modal,
      optionGeneration
    }
  ) {
    if (
      modal === null ||
      this._modal !== modal ||
      this._modalSlot === null
    ) {
      return false;
    }
    const slot = this._modalSlot;
    this._removePlotMessages(modal._plotContainer);
    const candidate = await this._trackSlotRender(
      slot,
      slot.render(payload, {
        isCurrent: () =>
          !this._destroyed &&
          this._modal === modal &&
          this._modalSlot === slot &&
          figureGeneration === this._renderGeneration &&
          optionGeneration === this._optionGeneration
      })
    );
    if (candidate === null) return false;
    this._modalPlotDiv = candidate;
    this._noteResponsiveCommit(slot, candidate);
    return true;
  }

  _publishModalMetadata(payload, modal) {
    if (modal === null || this._modal !== modal) return false;
    modal._title.textContent = `Comparing: ${payload.variableName}`;
    this._renderModalOptions();
    if (this.showStats) {
      renderSummaryStats(
        modal._statsContent,
        payload.pageData,
        payload.variableName
      );
    }
    const dataType = this._currentVariableKind === 'category'
      ? 'categorical_obs'
      : 'continuous_obs';
    renderStatisticalAnnotations(
      modal._annotationsContent,
      payload.pageData,
      dataType
    );
    return true;
  }

  _renderModalOptions() {
    const modal = this._modal;
    if (!this.showOptions || modal === null) return;
    renderPlotOptions(
      modal._optionsContent,
      this._currentPlotType,
      this._requestedOptions,
      (key, value) => {
        this._trackInteractiveTask(
          this._applyPlotOptionChange(key, value),
          'Figure plot option update'
        );
      }
    );
  }

  /**
   * Publish a modal rendering failure in the modal and notification log.
   * @param {*} error
   */
  _showModalError(error) {
    const exactError = requireError(error, 'Figure modal render');
    const plotContainer = this._modal?._plotContainer;
    if (plotContainer !== undefined && plotContainer !== null) {
      this._appendPlotMessage(
        plotContainer,
        'analysis-error',
        `Failed to render: ${exactError.message}`
      );
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
    const payload = {
      ...this._currentModalPayload({ mergedOptions: options, plotType }),
      pageData
    };
    const rendered = await this._renderModalPayload(payload, {
      figureGeneration: this._renderGeneration,
      modal,
      optionGeneration: this._optionGeneration
    });
    if (rendered) this._publishModalMetadata(payload, modal);
    return rendered;
  }

  _teardownModalOwnership(modal) {
    const existing = this._modalTeardowns.get(modal);
    if (existing !== undefined) return existing;

    const slot = modal._figurePlotSlot ?? (
      this._modal === modal ? this._modalSlot : null
    );
    if (this._modal === modal) {
      this._modal = null;
      this._modalSlot = null;
      this._modalPlotDiv = null;
      this._optionGeneration++;
    }

    const teardownPromise = Promise.resolve().then(async () => {
      const tasks = [
        Promise.resolve().then(() => this._destroyResizeOwner(slot))
      ];
      if (slot !== null && slot !== undefined) {
        if (typeof slot.destroy !== 'function') {
          tasks.push(
            Promise.reject(
              new TypeError(
                'Figure modal plot owner must implement destroy().'
              )
            )
          );
        } else {
          tasks.push(Promise.resolve().then(() => slot.destroy()));
        }
      }
      const teardownOutcomes = await Promise.allSettled(tasks);
      const errors = teardownOutcomes
        .filter(outcome => outcome.status === 'rejected')
        .map(outcome => outcome.reason);

      if (slot !== null && slot !== undefined) {
        this._slotRenders.delete(slot);
        this._resizeOwners.delete(slot);
      }
      modal._figurePlotSlot = null;
      modal._figureResizeOwner = null;

      const failure = combineErrors(
        errors,
        'Figure modal plot ownership teardown failed'
      );
      if (failure) throw failure;
    });
    this._modalTeardowns.set(modal, teardownPromise);
    this._modalTeardownTasks.add(teardownPromise);
    const releaseTeardown = () => {
      this._modalTeardownTasks.delete(teardownPromise);
    };
    void teardownPromise.then(releaseTeardown, releaseTeardown);
    void teardownPromise.catch(() => {});
    return teardownPromise;
  }

  _finalizeModalOwnership(modal) {
    if (this._modal === modal) {
      this._modal = null;
      this._modalSlot = null;
      this._modalPlotDiv = null;
      this._optionGeneration++;
    }
  }

  _closeModalInstance(modal) {
    let closePromise;
    try {
      closePromise = closeModal(modal);
    } catch (error) {
      closePromise = modal?._closePromise;
      if (
        closePromise === null ||
        closePromise === undefined ||
        typeof closePromise.then !== 'function'
      ) {
        closePromise = Promise.reject(
          requireError(error, 'Figure modal close')
        );
      }
    }
    if (
      closePromise === null ||
      closePromise === undefined ||
      typeof closePromise.then !== 'function'
    ) {
      closePromise = Promise.reject(
        new TypeError('Figure modal close must return a Promise.')
      );
    }
    this._lastModalClosePromise = closePromise;
    this._modalCloseTasks.add(closePromise);
    const releaseClose = () => {
      this._modalCloseTasks.delete(closePromise);
    };
    void closePromise.then(releaseClose, releaseClose);
    void closePromise.catch(() => {});
    return closePromise;
  }

  /**
   * Close modal if open
   * @returns {Promise<void>}
   */
  closeModal() {
    if (this._destroyed) {
      return this._destroyPromise ?? Promise.resolve();
    }
    if (this._modal === null) {
      return this._lastModalClosePromise ?? Promise.resolve();
    }
    return this._closeModalInstance(this._modal);
  }

  // ===========================================================================
  // Export Handlers
  // ===========================================================================

  _withActiveCommittedPlot(operation) {
    const slot = this._modal !== null
      ? this._modalSlot
      : this._previewSlot;
    if (slot === null || slot === undefined) {
      return Promise.reject(
        new Error('No rendered plot is available for export.')
      );
    }
    return slot.withCommittedPlot(operation);
  }

  /**
   * Handle PNG export
   */
  async _handleExportPNG() {
    this._assertAlive();
    try {
      const usesCustomExporter = this.onExportPNG !== undefined;
      await this._withActiveCommittedPlot(async (
        candidate,
        renderResult
      ) => {
        const payload = renderResult?.payload;
        if (!payload) {
          throw new Error(
            'PNG export requires exact committed plot ownership.'
          );
        }
        if (this.onExportPNG) {
          await this.onExportPNG(candidate, payload);
          return;
        }
        requireElement(candidate, 'PNG export plot');
        await downloadImage(candidate, {
          format: 'png',
          width: 1200,
          height: 800,
          filename: 'analysis'
        });
      });
      if (!usesCustomExporter) {
        this._notifications.success(
          'Plot exported as PNG',
          { category: 'download' }
        );
      }
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
      const usesCustomExporter = this.onExportSVG !== undefined;
      await this._withActiveCommittedPlot(async (
        candidate,
        renderResult
      ) => {
        const payload = renderResult?.payload;
        if (!payload) {
          throw new Error(
            'SVG export requires exact committed plot ownership.'
          );
        }
        if (this.onExportSVG) {
          await this.onExportSVG(candidate, payload);
          return;
        }
        requireElement(candidate, 'SVG export plot');
        await downloadImage(candidate, {
          format: 'svg',
          width: 1200,
          height: 800,
          filename: 'analysis'
        });
      });
      if (!usesCustomExporter) {
        this._notifications.success(
          'Plot exported as SVG',
          { category: 'download' }
        );
      }
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
      await this._withActiveCommittedPlot(async (
        candidate,
        renderResult
      ) => {
        const payload = renderResult?.payload;
        if (
          !payload ||
          !Array.isArray(payload.pageData) ||
          payload.pageData.length === 0
        ) {
          throw new Error(
            'No committed analysis data is available for CSV export.'
          );
        }
        if (this.onExportCSV) {
          await this.onExportCSV(candidate, payload);
          return;
        }
        requireNonEmptyString(
          payload.variableName,
          'CSV export variable name'
        );
        const csv = pageDataToCSV(
          payload.pageData,
          payload.variableName
        );
        downloadCSV(csv, 'analysis-data', this._notifications);
      });
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
    return this._modal === null ? null : this._modalPlotDiv;
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
    return this._invalidatePlots();
  }

  /**
   * Refresh the plot (re-render with current data and options)
   */
  async refresh() {
    this._assertAlive();
    if (this._currentPlotType === null || this._currentPageData === null) {
      throw new Error('Cannot refresh a figure before rendering a plot.');
    }
    return this.renderPlot(
      this._currentPlotType,
      this._currentPageData,
      this._currentOptions,
      this._currentLayoutOptions
    );
  }

  /**
   * Destroy and cleanup
   * @returns {Promise<void>}
   */
  destroy() {
    if (this._destroyPromise !== null) return this._destroyPromise;

    this._destroyed = true;
    this._renderGeneration++;
    this._optionGeneration++;
    const modal = this._modal;
    const previewSlot = this._previewSlot;
    this._plotDiv = null;
    this._modalPlotDiv = null;

    this._destroyPromise = Promise.resolve().then(async () => {
      const tasks = new Set([
        Promise.resolve().then(() => this._destroyResizeOwner(previewSlot)),
        Promise.resolve().then(() => previewSlot.destroy()),
        ...this._modalCloseTasks,
        ...this._modalTeardownTasks,
        ...this._interactiveTasks
      ]);
      if (modal !== null) {
        tasks.add(this._closeModalInstance(modal));
      }
      const outcomes = await Promise.allSettled(tasks);
      const errors = outcomes
        .filter(outcome => outcome.status === 'rejected')
        .map(outcome =>
          requireError(outcome.reason, 'FigureContainer destruction')
        );
      errors.push(...this._interactiveFailures);
      this._interactiveTasks.clear();
      this._interactiveFailures = [];

      this._slotRenders.delete(previewSlot);
      this._resizeOwners.delete(previewSlot);
      this._resetCurrentPlotState();
      try {
        this.container.innerHTML = '';
      } catch (error) {
        errors.push(error);
      }

      const failure = combineErrors(errors, 'FigureContainer destruction failed');
      if (failure) throw failure;
    });
    return this._destroyPromise;
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
