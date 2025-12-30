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

import { getNotificationCenter } from '../../notification-center.js';
import { getDockableAccordions } from '../../dockable-accordions-registry.js';
import { SIDEBAR_MAX_WIDTH_PX, SIDEBAR_MIN_WIDTH_PX } from '../../sidebar-metrics.js';
import { isFiniteNumber } from '../shared/number-utils.js';
import { StyleManager } from '../../../utils/style-manager.js';

const MAX_ANALYSIS_WINDOWS = 20;

function ensureFloatingRoot() {
  const existing = document.getElementById('floating-panels-root');
  if (existing) return existing;

  const root = document.createElement('div');
  root.id = 'floating-panels-root';
  document.body.appendChild(root);
  return root;
}

function createWindowId(counter) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `analysiswin-${counter}-${rand}`;
}

function getHeaderTitleForMode(typeInfo, modeId) {
  return typeInfo?.name || typeInfo?.tooltip || modeId || 'Analysis';
}

function isDomRectLike(rect) {
  return rect && typeof rect.left === 'number' && typeof rect.top === 'number';
}

export class AnalysisWindowManager {
  /**
   * @param {Object} options
   * @param {import('../../analysis/comparison-module.js').ComparisonModule} options.comparisonModule
   * @param {import('./analysis-ui-manager.js').AnalysisUIManager} options.uiManager
   * @param {HTMLElement} [options.sidebar] - Sidebar element (for initial positioning)
   */
  constructor(options) {
    this._comparisonModule = options.comparisonModule;
    this._uiManager = options.uiManager;
    this._sidebar = options.sidebar || document.getElementById('sidebar');
    this._notifications = getNotificationCenter();

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
      if (!entry?.details) continue;

      // Prefer the persisted StyleManager geometry; fall back to DOMRect.
      const leftVar = StyleManager.getVariable(entry.details, '--pos-x');
      const topVar = StyleManager.getVariable(entry.details, '--pos-y');
      const widthVar = StyleManager.getVariable(entry.details, '--pos-width');
      const heightVar = StyleManager.getVariable(entry.details, '--pos-height');

      const rectFallback = entry.details.getBoundingClientRect();
      const left = isFiniteNumber(parseFloat(leftVar)) ? parseFloat(leftVar) : rectFallback.left;
      const top = isFiniteNumber(parseFloat(topVar)) ? parseFloat(topVar) : rectFallback.top;
      const width = isFiniteNumber(parseFloat(widthVar)) ? parseFloat(widthVar) : rectFallback.width;
      const height = isFiniteNumber(parseFloat(heightVar)) ? parseFloat(heightVar) : rectFallback.height;

      const settings = typeof entry.ui?.exportSettings === 'function'
        ? entry.ui.exportSettings()
        : {
          selectedPages: entry.ui?.getSelectedPages?.() ?? [],
          config: entry.ui?.getConfig?.() ?? {}
        };

      out.push({
        modeId: entry.modeId,
        rect: { left, top, width, height },
        settings,
        headerTitle: entry.headerTitle || '',
        headerDesc: entry.headerDesc || '',
        constraints: entry.floatConstraints || null
      });
    }

    return out;
  }

  /**
   * Create a floating analysis window from a session restore descriptor.
   *
   * @param {{ modeId?: string, rect?: any, settings?: any, headerTitle?: string, headerDesc?: string, constraints?: any }} descriptor
   * @returns {string|null} windowId
   */
  createFromSessionDescriptor(descriptor) {
    const modeId = String(descriptor?.modeId || '').trim();
    if (!modeId) return null;

    const rect = descriptor?.rect || {};
    const left = isFiniteNumber(rect.left) ? rect.left : undefined;
    const top = isFiniteNumber(rect.top) ? rect.top : undefined;
    const preferredSize = {
      width: isFiniteNumber(rect.width) ? rect.width : undefined,
      height: isFiniteNumber(rect.height) ? rect.height : undefined
    };

    // Use a tiny origin shim so we can reuse the existing creation path.
    const originUi = {
      exportSettings: () => descriptor?.settings || null
    };

    return this._createWindowFromOrigin(modeId, originUi, {
      left,
      top,
      preferredSize,
      constraints: descriptor?.constraints || null,
      headerTitle: descriptor?.headerTitle || '',
      headerDesc: descriptor?.headerDesc || ''
    });
  }

  /**
   * Create a floating copy from the embedded (sidebar) analysis mode instance.
   * @param {string} modeId
   * @param {{ sourceRect?: DOMRect, preferredSize?: { width?: number, height?: number }, constraints?: any, headerTitle?: string, headerDesc?: string }} [options]
   * @returns {string|null} windowId
   */
  copyFromEmbedded(modeId, options = {}) {
    const originUi = this._uiManager?.getUI?.(modeId);
    if (!originUi) {
      this._notifications.error(`Unable to initialize analysis UI: ${modeId}`);
      return null;
    }
    return this._createWindowFromOrigin(modeId, originUi, options);
  }

  /**
   * Create a floating copy from an existing floating window.
   * @param {string} windowId
   * @returns {string|null}
   */
  copyFromWindow(windowId) {
    const entry = this._windows.get(windowId);
    if (!entry?.ui) return null;
    const rect = entry.details.getBoundingClientRect();
    return this._createWindowFromOrigin(entry.modeId, entry.ui, {
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
    const entry = this._windows.get(windowId);
    if (!entry) return;

    try { entry.ui?.destroy?.(); } catch (err) {
      console.warn('[AnalysisWindowManager] UI destroy failed:', err);
    }

    try { getDockableAccordions()?.unregister?.(entry.details); } catch {}

    try { entry.details.remove(); } catch {}

    this._windows.delete(windowId);
  }

  closeAll() {
    Array.from(this._windows.keys()).forEach((id) => this.closeWindow(id));
  }

  /**
   * Propagate page add/remove/rename events to all floating windows.
   * Mirrors ComparisonModule "select all" preservation semantics per window.
   */
  onPagesChanged() {
    const pages = this._comparisonModule?.dataLayer?.getPages?.() || [];
    const currentPageIds = pages.map(p => p.id);
    const currentPageIdSet = new Set(currentPageIds);

    for (const entry of this._windows.values()) {
      const ui = entry.ui;
      if (!ui?.onPageSelectionChange) continue;

      const previousPageIds = Array.isArray(entry.lastKnownPageIds) ? entry.lastKnownPageIds : [];
      const previousPageIdSet = new Set(previousPageIds);

      const addedPageIds = currentPageIds.filter(id => !previousPageIdSet.has(id));
      const previousSelection = ui?.getSelectedPages?.() ?? [];
      const previousSelectionSet = new Set(previousSelection);

      const hadAllPreviously =
        previousPageIds.length > 0 &&
        previousPageIds.every(id => previousSelectionSet.has(id));

      const nextSelectionSet = new Set(
        (previousSelection || []).filter(id => currentPageIdSet.has(id))
      );

      if (hadAllPreviously) {
        for (const id of addedPageIds) nextSelectionSet.add(id);
      }

      if (nextSelectionSet.size === 0) {
        for (const id of currentPageIds) nextSelectionSet.add(id);
      }

      const nextSelection = currentPageIds.filter(id => nextSelectionSet.has(id));
      ui.onPageSelectionChange(nextSelection);

      entry.lastKnownPageIds = currentPageIds;
    }
  }

  /**
   * Propagate highlight changes (cell counts) to all floating windows.
   */
  onHighlightChanged() {
    for (const entry of this._windows.values()) {
      try { entry.ui?.onHighlightChanged?.(); } catch {}
    }
  }

  // ===========================================================================
  // Internal helpers
  // ===========================================================================

  _createWindowFromOrigin(modeId, originUi, options = {}) {
    if (this._windows.size >= MAX_ANALYSIS_WINDOWS) {
      this._notifications.error(`Maximum of ${MAX_ANALYSIS_WINDOWS} analysis windows reached.`);
      return null;
    }

    const typeInfo = this._uiManager?.getTypeInfo?.(modeId);
    if (!typeInfo?.factory) {
      this._notifications.error(`Unknown analysis mode: ${modeId}`);
      return null;
    }

    const settings = typeof originUi.exportSettings === 'function'
      ? originUi.exportSettings()
      : {
        selectedPages: originUi?.getSelectedPages?.() ?? [],
        config: originUi?.getConfig?.() ?? {}
      };

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
    const headerTitle = options.headerTitle?.trim?.() || getHeaderTitleForMode(typeInfo, modeId);
    const headerDesc = options.headerDesc?.trim?.() || '';

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

    const floatingRoot = getDockableAccordions()?.floatingRoot || ensureFloatingRoot();
    floatingRoot.appendChild(details);

    const currentPages = this._comparisonModule?.dataLayer?.getPages?.() || [];
    const currentPageIds = currentPages.map(p => p.id);

    const windowEntry = {
      id: windowId,
      modeId,
      details,
      content,
      ui: null,
      lastKnownPageIds: currentPageIds,
      headerTitle,
      headerDesc,
      floatConstraints: this._resolveFloatConstraints(options)
    };

    this._windows.set(windowId, windowEntry);

    try {
      const factoryOptions = { ...(typeInfo.factoryOptions || {}) };
      delete factoryOptions.onConfigChange;

      const ui = typeInfo.factory({
        comparisonModule: this._comparisonModule,
        dataLayer: this._comparisonModule.dataLayer,
        multiVariableAnalysis: this._comparisonModule.multiVariableAnalysis,
        container: content,
        instanceId: windowId,
        ...factoryOptions
      });

      if (ui?.init && !ui?._container) {
        ui.init(content);
      }

      if (ui && settings) {
        if (typeof ui.importSettings === 'function') ui.importSettings(settings);
        else {
          if (Array.isArray(settings.selectedPages) && ui.onPageSelectionChange) {
            ui.onPageSelectionChange(settings.selectedPages);
          }
          if (settings.config && ui.setConfig) ui.setConfig(settings.config);
        }
      }

      windowEntry.ui = ui;
    } catch (err) {
      console.warn('[AnalysisWindowManager] Failed to create analysis window:', err);
      this._notifications.error('Failed to create analysis window.');
      this.closeWindow(windowId);
      return null;
    }

    const computed = this._computeInitialPosition(options.sourceRect);
    const left = isFiniteNumber(options.left) ? options.left : computed.left;
    const top = isFiniteNumber(options.top) ? options.top : computed.top;
    const preferredSize = this._resolvePreferredSize(options);
    const floatConstraints = this._windows.get(windowId)?.floatConstraints;

    // Enable floating interactions (drag/resize) using dockable-accordions.
    const dockable = getDockableAccordions();
    if (dockable?.register) {
      try {
        dockable.register(details, { dockable: false });
        dockable.float(details, { left, top, preferredSize, constraints: floatConstraints });
      } catch (err) {
        console.warn('[AnalysisWindowManager] Dockable integration failed:', err);
        try { dockable.unregister(details); } catch {}
        details.classList.add('accordion-floating');
        StyleManager.setPosition(details, {
          x: left,
          y: top,
          width: preferredSize?.width,
          height: preferredSize?.height,
        });
        StyleManager.setLayer(details, 'floating');
      }
    } else {
      // Fallback: make the panel visible/interactive even if dockable accordions were not initialized.
      details.classList.add('accordion-floating');
      StyleManager.setPosition(details, {
        x: left,
        y: top,
        width: preferredSize?.width,
        height: preferredSize?.height,
      });
      StyleManager.setLayer(details, 'floating');
    }

    return windowId;
  }

  _resolvePreferredSize(options = {}) {
    if (isFiniteNumber(options?.preferredSize?.width) || isFiniteNumber(options?.preferredSize?.height)) {
      return {
        width: isFiniteNumber(options.preferredSize.width) ? options.preferredSize.width : undefined,
        height: isFiniteNumber(options.preferredSize.height) ? options.preferredSize.height : undefined
      };
    }

    const rect = options?.sourceRect;
    if (rect && isFiniteNumber(rect.width) && isFiniteNumber(rect.height)) {
      return { width: rect.width, height: rect.height };
    }

    return null;
  }

  _resolveFloatConstraints(options = {}) {
    if (options?.constraints) return options.constraints;

    const sidebarWidth = this._sidebar?.getBoundingClientRect?.().width;
    const referenceWidth = isFiniteNumber(options?.preferredSize?.width)
      ? options.preferredSize.width
      : this._sidebar?.querySelector?.('details.accordion-section')?.getBoundingClientRect?.().width;

    const gutter = isFiniteNumber(sidebarWidth) && isFiniteNumber(referenceWidth)
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

    const sidebarRect = this._sidebar?.getBoundingClientRect?.();
    const baseLeft = sidebarRect ? sidebarRect.right + 24 : 24;
    const baseTop = 80;

    const anchorLeft = isDomRectLike(sourceRect) ? sourceRect.right + 24 : baseLeft;
    const anchorTop = isDomRectLike(sourceRect) ? sourceRect.top : baseTop;

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
