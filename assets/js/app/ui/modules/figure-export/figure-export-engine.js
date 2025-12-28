/**
 * @fileoverview Figure export engine.
 *
 * Orchestrates:
 * - Snapshotting the current view data (positions, colors, visibility)
 * - Choosing large-dataset strategies
 * - Delegating rendering to SVG/PNG renderers
 * - Download + notification lifecycle
 *
 * The engine has no DOM dependencies and is safe to invoke from worker-friendly
 * contexts later (except download, which must run on the main thread).
 *
 * @module ui/modules/figure-export/figure-export-engine
 */

import { getNotificationCenter } from '../../../notification-center.js';
import { clamp, parseNumberOr } from '../../../utils/number-utils.js';
import { buildExportFilename, downloadBlob, formatTimestampForFilename } from './utils/export-helpers.js';
import { computeGridDims } from './utils/layout.js';

const LIVE_VIEW_ID = 'live';

/**
 * @typedef {'svg'|'png'} FigureExportFormat
 */

/**
 * @typedef {object} FigureExportJob
 * @property {FigureExportFormat} format
 * @property {number} [dpi]
 */

/**
 * @typedef {object} FigureExportOptions
 * @property {FigureExportFormat} format
 * @property {number} width
 * @property {number} height
 * @property {number} [dpi]
 * @property {boolean} [exportAllViews]
 * @property {string} [title]
 * @property {boolean} [includeAxes]
 * @property {boolean} [includeLegend]
 * @property {'right'|'bottom'} [legendPosition]
 * @property {string} [xLabel]
 * @property {string} [yLabel]
 * @property {'white'|'transparent'|'custom'} [background]
 * @property {string} [backgroundColor]
 * @property {string} [fontFamily]
 * @property {number} [fontSizePx]
 * @property {number} [legendFontSizePx]
 * @property {number} [tickFontSizePx]
 * @property {number} [axisLabelFontSizePx]
 * @property {number} [titleFontSizePx]
 * @property {number} [centroidLabelFontSizePx]
 * @property {boolean} [showOrientation]
 * @property {boolean} [depthSort3d]
 * @property {boolean} [includeCentroidPoints]
 * @property {boolean} [includeCentroidLabels]
 * @property {boolean} [emphasizeSelection]
 * @property {number} [selectionMutedOpacity]
 * @property {{ enabled?: boolean; x?: number; y?: number; width?: number; height?: number } | null} [crop]
 * @property {'ask'|'full-vector'|'optimized-vector'|'hybrid'|'raster'} [strategy]
 * @property {number} [optimizedTargetCount]
 * @property {FigureExportJob[]} [jobs]
 */

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {import('../../../../data/data-source-manager.js').DataSourceManager | null} [options.dataSourceManager]
 */
export function createFigureExportEngine({ state, viewer, dataSourceManager = null }) {
  /**
   * @returns {{
   *   datasetName: string|null,
   *   datasetId: string|null,
   *   sourceType: string|null,
   *   datasetBaseUrl: string|null,
   *   datasetSourceName: string|null,
   *   datasetSourceUrl: string|null,
   *   datasetSourceCitation: string|null,
   *   datasetUserPath: string|null
   * }}
   */
  function getDatasetIdentity() {
    const meta = dataSourceManager?.getCurrentMetadata?.() || null;
    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || meta?.id || null;
    const datasetName = meta?.name || meta?.id || null;
    const sourceType = dataSourceManager?.getCurrentSourceType?.() || null;
    const datasetBaseUrl = dataSourceManager?.getCurrentBaseUrl?.() || null;
    const datasetSourceName = meta?.source?.name || null;
    const datasetSourceUrl = meta?.source?.url || null;
    const datasetSourceCitation = meta?.source?.citation || null;
    const datasetUserPath = dataSourceManager?.getStateSnapshot?.()?.userPath || null;

    // If the viewer/state point counts disagree (e.g., benchmark synthetic mode),
    // avoid reusing stale DataSourceManager labels.
    const viewerCount = typeof viewer.getPointCount === 'function' ? viewer.getPointCount() : null;
    const stateCount = state?.pointCount ?? null;
    if (viewerCount != null && stateCount != null && viewerCount !== stateCount) {
      return {
        datasetName: 'Synthetic',
        datasetId: 'synthetic',
        sourceType: 'benchmark',
        datasetBaseUrl: null,
        datasetSourceName: null,
        datasetSourceUrl: null,
        datasetSourceCitation: null,
        datasetUserPath: null,
      };
    }

    return {
      datasetName,
      datasetId,
      sourceType,
      datasetBaseUrl,
      datasetSourceName,
      datasetSourceUrl,
      datasetSourceCitation,
      datasetUserPath,
    };
  }

  /**
   * Snapshot view data needed for export.
   *
   * @param {string} viewId
   */
  function getViewData(viewId) {
    const vid = String(viewId || LIVE_VIEW_ID);
    const ctx = state?.viewContexts?.get?.(vid) || null;

    if (
      typeof viewer.getViewPositions !== 'function' ||
      typeof viewer.getViewColors !== 'function' ||
      typeof viewer.getViewTransparency !== 'function' ||
      typeof viewer.getPointCount !== 'function'
    ) {
      throw new Error('Figure export requires viewer.getViewPositions/getViewColors/getViewTransparency/getPointCount');
    }

    const positions = viewer.getViewPositions(vid);
    const colors = viewer.getViewColors(vid);
    const transparency = viewer.getViewTransparency(vid);
    const pointCount = viewer.getPointCount();

    const centroidPositions = ctx?.centroidPositions
      || (vid === LIVE_VIEW_ID ? (state.centroidPositions || null) : null);
    const centroidColors = ctx?.centroidColors
      || (vid === LIVE_VIEW_ID ? (state.centroidColors || null) : null);
    const centroidLabelTexts = Array.isArray(ctx?.centroidLabels)
      ? ctx.centroidLabels.map((entry) => {
        const elText = entry?.el?.textContent;
        const rawText = entry?.text;
        return String(elText ?? rawText ?? '');
      })
      : (Array.isArray(state?.centroidLabels) && vid === LIVE_VIEW_ID
        ? state.centroidLabels.map((entry) => String(entry?.el?.textContent ?? entry?.text ?? ''))
        : []);
    const centroidFlags = viewer.getCentroidFlags?.(vid) || null;

    return {
      positions,
      colors,
      transparency,
      pointCount,
      centroidPositions,
      centroidColors,
      centroidLabelTexts,
      centroidFlags,
    };
  }

  /**
   * Export the current figure.
   *
   * @param {FigureExportOptions} options
   */
  async function exportFigure(options) {
    const results = await exportFigures({
      ...options,
      jobs: [{ format: options?.format === 'png' ? 'png' : 'svg', dpi: options?.dpi }],
    });
    return results[0];
  }

  /**
   * Export multiple figures sequentially (batch export).
   *
   * @param {FigureExportOptions} options
   * @returns {Promise<Array<{ format: FigureExportFormat; filename: string; metadata: any }>>}
   */
  async function exportFigures(options) {
    const width = Math.max(10, Math.round(options?.width || 1200));
    const height = Math.max(10, Math.round(options?.height || 900));
    const exportAllViews = options?.exportAllViews === true;
    const strategy = options?.strategy || 'ask';

    const rawJobs = Array.isArray(options?.jobs) && options.jobs.length
      ? options.jobs
      : [{ format: options?.format === 'png' ? 'png' : 'svg', dpi: options?.dpi }];

    /** @type {Array<{ requested: FigureExportFormat; format: FigureExportFormat; dpi: number }>} */
    const jobs = [];
    const seen = new Set();
    for (const job of rawJobs) {
      const requested = job?.format === 'png' ? 'png' : 'svg';
      const format = requested === 'svg' && strategy === 'raster' ? 'png' : requested;
      const dpi = Math.max(72, Math.round(job?.dpi ?? options?.dpi ?? 300));
      const key = format === 'png' ? `png:${dpi}` : 'svg';
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push({ requested, format, dpi });
    }

    const {
      datasetName,
      datasetId,
      sourceType,
      datasetBaseUrl,
      datasetSourceName,
      datasetSourceUrl,
      datasetSourceCitation,
      datasetUserPath,
    } = getDatasetIdentity();
    const activeViewId = typeof state.getActiveViewId === 'function'
      ? state.getActiveViewId()
      : (typeof viewer.getFocusedViewId === 'function' ? viewer.getFocusedViewId() : LIVE_VIEW_ID);
    const viewId = String(activeViewId || LIVE_VIEW_ID);
    const viewLabel = viewId === LIVE_VIEW_ID
      ? (viewer.getLiveViewLabel?.() || 'View 1')
      : viewId;

    const field = typeof state.getFieldForView === 'function'
      ? state.getFieldForView(viewId)
      : (typeof state.getActiveField === 'function' ? state.getActiveField() : null);
    const fieldKey = field?.key || null;
    const fieldKind = field?.kind || null;
    const filters = typeof state.getFilterSummaryForView === 'function'
      ? state.getFilterSummaryForView(viewId)
      : (typeof state.getFilterSummaryLines === 'function' ? state.getFilterSummaryLines() : []);

    const viewLayout = typeof viewer.getViewLayout === 'function' ? viewer.getViewLayout() : null;
    const wantsGrid = exportAllViews && viewLayout?.mode === 'grid' && typeof viewer.getSnapshotViews === 'function';

    const views = wantsGrid
      ? [{ id: LIVE_VIEW_ID, label: viewer.getLiveViewLabel?.() || 'View 1' }, ...viewer.getSnapshotViews()]
      : [{ id: viewId, label: viewId === LIVE_VIEW_ID ? (viewer.getLiveViewLabel?.() || 'View 1') : viewId }];

    // Snapshot per-view render state so exports match the exact on-screen projection,
    // especially in split-view grid mode where each pane has its own viewport aspect.
    if (typeof viewer.getViewRenderState !== 'function') {
      throw new Error('Figure export requires viewer.getViewRenderState');
    }
    if (typeof viewer.getViewCameraState !== 'function') {
      throw new Error('Figure export requires viewer.getViewCameraState');
    }
    const baseRenderState = viewer.getViewRenderState(viewId);

    const gridViewport = wantsGrid && baseRenderState?.viewportWidth && baseRenderState?.viewportHeight
      ? (() => {
        const { cols, rows } = computeGridDims(views.length || 1);
        const viewportWidth = Math.max(1, Math.floor(baseRenderState.viewportWidth / cols));
        const viewportHeight = Math.max(1, Math.floor(baseRenderState.viewportHeight / rows));
        return { viewportWidth, viewportHeight };
      })()
      : null;

    function getViewRenderStateSnapshot(vid) {
      const key = String(vid || LIVE_VIEW_ID);
      return gridViewport ? viewer.getViewRenderState(key, gridViewport) : viewer.getViewRenderState(key);
    }

    function getViewCameraStateSnapshot(vid) {
      return viewer.getViewCameraState(String(vid || LIVE_VIEW_ID));
    }

    const payloadBase = {
      width,
      height,
      title: options?.title || '',
      options: {
        includeAxes: options?.includeAxes !== false,
        includeLegend: options?.includeLegend !== false,
        legendPosition: options?.legendPosition === 'bottom' ? 'bottom' : 'right',
        xLabel: options?.xLabel || 'X',
        yLabel: options?.yLabel || 'Y',
        background: options?.background || 'white',
        backgroundColor: options?.backgroundColor || '#ffffff',
        fontFamily: options?.fontFamily || 'Arial, Helvetica, sans-serif',
        fontSizePx: Number.isFinite(options?.fontSizePx) ? options.fontSizePx : 12,
        legendFontSizePx: Number.isFinite(options?.legendFontSizePx) ? options.legendFontSizePx : (Number.isFinite(options?.fontSizePx) ? options.fontSizePx : 12),
        tickFontSizePx: Number.isFinite(options?.tickFontSizePx) ? options.tickFontSizePx : (Number.isFinite(options?.fontSizePx) ? options.fontSizePx : 12),
        axisLabelFontSizePx: Number.isFinite(options?.axisLabelFontSizePx) ? options.axisLabelFontSizePx : null,
        titleFontSizePx: Number.isFinite(options?.titleFontSizePx) ? options.titleFontSizePx : null,
        centroidLabelFontSizePx: Number.isFinite(options?.centroidLabelFontSizePx) ? options.centroidLabelFontSizePx : null,
        includeCentroidPoints: options?.includeCentroidPoints,
        includeCentroidLabels: options?.includeCentroidLabels,
        crop: options?.crop || null,
        showOrientation: options?.showOrientation !== false,
        depthSort3d: options?.depthSort3d !== false,
        emphasizeSelection: options?.emphasizeSelection === true,
        selectionMutedOpacity: clamp(parseNumberOr(options?.selectionMutedOpacity, 0.15), 0, 1),
        strategy,
        optimizedTargetCount: Number.isFinite(options?.optimizedTargetCount) ? options.optimizedTargetCount : 100000
      },
      meta: {
        exportedAt: new Date().toISOString(),
        exporter: {
          name: 'Cellucid',
          website: 'https://cellucid.com'
        },
        datasetName,
        datasetId,
        sourceType,
        datasetBaseUrl,
        datasetSourceName,
        datasetSourceUrl,
        datasetSourceCitation,
        datasetUserPath,
        fieldKey,
        fieldKind,
        viewId,
        viewLabel,
        filters
      },
      views: views.map((v) => ({
        ...v,
        data: getViewData(v.id),
        renderState: getViewRenderStateSnapshot(v.id),
        cameraState: getViewCameraStateSnapshot(v.id)
      })),
    };

    const notifications = getNotificationCenter();
    const countLabel = jobs.length === 1
      ? jobs[0]?.format?.toUpperCase?.() || 'EXPORT'
      : `${jobs.length} exports`;
    const notifId = notifications.startCalculation(`Preparing ${countLabel}…`, 'render');
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const ts = formatTimestampForFilename();

    const results = [];
    try {
      const needsMultiplePng = jobs.filter((j) => j.format === 'png').length > 1;

      /** @type {{ renderFigureToSvgBlob?: Function } | null} */
      let svgRenderer = null;
      /** @type {{ renderFigureToPngBlob?: Function } | null} */
      let pngRenderer = null;

      for (let idx = 0; idx < jobs.length; idx++) {
        const job = jobs[idx];
        const format = job.format;
        const dpi = job.dpi;

        notifications.show({
          id: notifId,
          message: `Rendering ${idx + 1}/${jobs.length}: ${format.toUpperCase()}…`
        });

        const payload = { ...payloadBase, dpi };

        if (format === 'svg') {
          if (!svgRenderer) svgRenderer = await import('./renderers/svg-renderer.js');
          const { blob, suggestedExt } = await svgRenderer.renderFigureToSvgBlob({ state, viewer, payload });
          const filename = buildExportFilename({
            datasetName,
            fieldKey,
            viewLabel: wantsGrid ? 'multiview' : views[0]?.label || null,
            variant: null,
            ext: suggestedExt || 'svg',
            timestamp: ts
          });
          downloadBlob(blob, filename);
          results.push({ format: 'svg', filename, metadata: payloadBase.meta });
        } else {
          if (!pngRenderer) pngRenderer = await import('./renderers/png-renderer.js');
          const blob = await pngRenderer.renderFigureToPngBlob({ state, viewer, payload });
          const variant = needsMultiplePng ? `dpi${dpi}` : null;
          const filename = buildExportFilename({
            datasetName,
            fieldKey,
            viewLabel: wantsGrid ? 'multiview' : views[0]?.label || null,
            variant,
            ext: 'png',
            timestamp: ts
          });
          downloadBlob(blob, filename);
          results.push({ format: 'png', filename, metadata: payloadBase.meta });
        }
      }

      const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      notifications.completeCalculation(notifId, 'Export complete', t1 - t0);
      notifications.success(
        `Exported ${results.length} file${results.length === 1 ? '' : 's'}`,
        { category: 'download', duration: 2500 }
      );
      return results;
    } catch (err) {
      console.error('[FigureExport] Export failed:', err);
      notifications.failCalculation(notifId, err?.message || 'Export failed');
      notifications.error(`Export failed: ${err?.message || err}`, { category: 'render', duration: 6000 });
      throw err;
    }
  }

  return { exportFigure, exportFigures };
}
