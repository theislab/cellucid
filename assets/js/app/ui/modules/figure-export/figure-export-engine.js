/**
 * @fileoverview Figure export engine.
 *
 * Orchestrates:
 * - Snapshotting the current view data (positions, colors, visibility)
 * - Preserving the explicitly requested SVG strategy
 * - Delegating rendering to SVG/PNG renderers
 * - Download + notification lifecycle
 *
 * The engine has no DOM dependencies and is safe to invoke from worker-friendly
 * contexts later (except download, which must run on the main thread).
 *
 * @module ui/modules/figure-export/figure-export-engine
 */

import { getNotificationCenter } from '../../../notification-center.js';
import { buildExportFilename, downloadBlob, formatTimestampForFilename } from './utils/export-helpers.js';
import { createFigureExportZip } from './utils/zip-archive.js';
import { computeGridDims } from './utils/layout.js';
import { assertCameraState } from '../../../../rendering/camera-state-contract.js';
import {
  assertFigureExportBatchRequest,
  assertFigureExportPayload,
  assertFigureExportSingleRequest,
  assertFigureExportViewId,
  createFigureExportPayloadOptions,
} from './figure-export-contract.js';

const LIVE_VIEW_ID = 'live';

/**
 * @typedef {'svg'|'png'} FigureExportFormat
 */

/**
 * @typedef {object} FigureExportJob
 * @property {FigureExportFormat} format
 * @property {number|null} dpi
 */

/**
 * @typedef {object} FigureExportOptions
 * @property {FigureExportFormat} format
 * @property {number} width
 * @property {number} height
 * @property {number|null} dpi
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
 * @property {'full-vector'|'optimized-vector'|'hybrid'|null} strategy
 * @property {number|null} optimizedTargetCount
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
    const viewerCount = viewer.getPointCount();
    const stateCount = state.pointCount;
    if (
      !Number.isSafeInteger(viewerCount) ||
      viewerCount < 0 ||
      !Number.isSafeInteger(stateCount) ||
      stateCount < 0
    ) {
      throw new TypeError(
        'Figure export requires exact non-negative viewer and state point counts.'
      );
    }
    if (viewerCount !== stateCount) {
      throw new Error(
        `Figure export point-count mismatch: viewer has ${viewerCount} points while state has ${stateCount}`
      );
    }
    if (dataSourceManager === null) {
      return {
        datasetName: null,
        datasetId: null,
        sourceType: null,
        datasetBaseUrl: null,
        datasetSourceName: null,
        datasetSourceUrl: null,
        datasetSourceCitation: null,
        datasetUserPath: null,
      };
    }
    for (const methodName of [
      'getCurrentMetadata',
      'getCurrentDatasetId',
      'getCurrentSourceType',
      'getCurrentBaseUrl',
      'getStateSnapshot',
    ]) {
      if (typeof dataSourceManager[methodName] !== 'function') {
        throw new TypeError(
          `Figure export data source manager is missing ${methodName}().`
        );
      }
    }
    const meta = dataSourceManager.getCurrentMetadata();
    if (meta !== null && (typeof meta !== 'object' || Array.isArray(meta))) {
      throw new TypeError('Figure export dataset metadata must be an object or null.');
    }
    const dataSourceSnapshot = dataSourceManager.getStateSnapshot();
    if (
      dataSourceSnapshot === null ||
      typeof dataSourceSnapshot !== 'object' ||
      Array.isArray(dataSourceSnapshot)
    ) {
      throw new TypeError('Figure export data source snapshot must be an object.');
    }
    const datasetId = dataSourceManager.getCurrentDatasetId();
    const datasetName = meta === null ? null : (meta.name ?? null);
    const sourceType = dataSourceManager.getCurrentSourceType();
    const datasetBaseUrl = dataSourceManager.getCurrentBaseUrl();
    const datasetSourceName = meta?.source?.name ?? null;
    const datasetSourceUrl = meta?.source?.url ?? null;
    const datasetSourceCitation = meta?.source?.citation ?? null;
    const datasetUserPath = dataSourceSnapshot.userPath ?? null;

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
    const vid = assertFigureExportViewId(viewId);
    const ctx = vid === LIVE_VIEW_ID
      ? null
      : state.viewContexts.get(vid);
    if (vid !== LIVE_VIEW_ID && !ctx) {
      throw new Error(`Figure export has no state context for view "${vid}".`);
    }

    const positions = viewer.getViewPositions(vid);
    const colors = viewer.getViewColors(vid);
    const transparency = viewer.getViewTransparency(vid);
    const pointCount = viewer.getPointCount();

    const centroidPositions = vid === LIVE_VIEW_ID
      ? state.centroidPositions
      : ctx.centroidPositions;
    const centroidColors = vid === LIVE_VIEW_ID
      ? state.centroidColors
      : ctx.centroidColors;
    const centroidLabels = vid === LIVE_VIEW_ID
      ? state.centroidLabels
      : ctx.centroidLabels;
    if (!Array.isArray(centroidLabels)) {
      throw new TypeError(
        `Figure export centroid labels for view "${vid}" must be an array.`
      );
    }
    const centroidLabelTexts = centroidLabels.map((entry, index) => {
        if (entry === null || typeof entry !== 'object') {
          throw new TypeError(
            `Figure export centroid label ${index} for view "${vid}" must be an object.`
          );
        }
        const elText = entry?.el?.textContent;
        const rawText = entry?.text;
        const text = elText ?? rawText;
        if (typeof text !== 'string') {
          throw new TypeError(
            `Figure export centroid label ${index} for view "${vid}" must publish text.`
          );
        }
        return text;
      });
    const centroidFlags = viewer.getCentroidFlags(vid);

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
    const exactOptions = assertFigureExportSingleRequest(options);
    const results = await runExport(
      exactOptions,
      [{ format: exactOptions.format, dpi: exactOptions.dpi }]
    );
    return results[0];
  }

  /**
   * Export multiple figures sequentially (batch export).
   *
   * @param {FigureExportOptions} options
   * @returns {Promise<Array<{ format: FigureExportFormat; filename: string; metadata: any }>>}
   */
  async function exportFigures(options) {
    const exactOptions = assertFigureExportBatchRequest(options);
    return runExport(exactOptions, exactOptions.jobs);
  }

  async function runExport(options, jobs) {
    const width = options.width;
    const height = options.height;
    const exportAllViews = options.exportAllViews;

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
    const viewId = assertFigureExportViewId(state.getActiveViewId());
    const liveViewLabel = viewer.getLiveViewLabel();
    assertFigureExportViewId(liveViewLabel, 'Figure export live view label');
    const snapshotViews = viewer.getSnapshotViews().map((view, index) => {
      if (
        view === null ||
        typeof view !== 'object' ||
        typeof view.id !== 'string' ||
        view.id.length === 0 ||
        typeof view.label !== 'string' ||
        view.label.length === 0
      ) {
        throw new TypeError(
          `Figure export snapshot descriptor ${index} must publish exact id and label strings.`
        );
      }
      return { id: view.id, label: view.label };
    });
    const activeSnapshot = viewId === LIVE_VIEW_ID
      ? null
      : snapshotViews.find((view) => view.id === viewId);
    if (viewId !== LIVE_VIEW_ID && !activeSnapshot) {
      throw new Error(`Active figure export view "${viewId}" does not exist.`);
    }
    const viewLabel = viewId === LIVE_VIEW_ID
      ? liveViewLabel
      : activeSnapshot.label;

    if (
      typeof state.getFieldForView !== 'function' ||
      typeof state.getFilterSummaryForView !== 'function'
    ) {
      throw new TypeError(
        'Figure export state must publish getFieldForView() and getFilterSummaryForView().'
      );
    }
    const field = state.getFieldForView(viewId);
    if (
      field !== null &&
      (typeof field !== 'object' || Array.isArray(field))
    ) {
      throw new TypeError(
        `Figure export field for view "${viewId}" must be an object or null.`
      );
    }
    const fieldKey = field === null ? null : field.key;
    const fieldKind = field === null ? null : field.kind;
    const filters = state.getFilterSummaryForView(viewId);
    if (!Array.isArray(filters) || filters.some((line) => typeof line !== 'string')) {
      throw new TypeError('Figure export filters must be an array of strings.');
    }

    const viewLayout = viewer.getViewLayout();
    const wantsGrid = exportAllViews && viewLayout.mode === 'grid';

    const views = wantsGrid
      ? [
          ...(viewLayout.liveViewHidden
            ? []
            : [{ id: LIVE_VIEW_ID, label: liveViewLabel }]),
          ...snapshotViews,
        ]
      : [{ id: viewId, label: viewLabel }];
    if (views.length === 0) {
      throw new Error('Figure export grid contains no published views.');
    }

    // Snapshot per-view render state so exports match the exact on-screen projection,
    // especially in split-view grid mode where each pane has its own viewport aspect.
    const baseRenderState = viewer.getViewRenderState(viewId, null);

    const gridViewport = wantsGrid
      ? (() => {
        if (
          !Number.isSafeInteger(baseRenderState.viewportWidth) ||
          baseRenderState.viewportWidth <= 0 ||
          !Number.isSafeInteger(baseRenderState.viewportHeight) ||
          baseRenderState.viewportHeight <= 0
        ) {
          throw new TypeError(
            'Figure export grid requires exact positive render-state viewport dimensions.'
          );
        }
        const { cols, rows } = computeGridDims(views.length);
        const viewportWidth = Math.floor(baseRenderState.viewportWidth / cols);
        const viewportHeight = Math.floor(baseRenderState.viewportHeight / rows);
        if (viewportWidth < 1 || viewportHeight < 1) {
          throw new RangeError('Figure export grid viewport is too small for its view count.');
        }
        return { viewportWidth, viewportHeight };
      })()
      : null;

    function getViewRenderStateSnapshot(vid) {
      const key = assertFigureExportViewId(vid);
      return viewer.getViewRenderState(key, gridViewport);
    }

    function getViewCameraStateSnapshot(vid) {
      const key = assertFigureExportViewId(vid);
      return assertCameraState(
        viewer.getViewCameraState(key),
        `Figure-export camera state for "${key}"`
      );
    }

    const payloadBase = {
      width,
      height,
      title: options.title,
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
        id: v.id,
        label: v.label,
        data: getViewData(v.id),
        renderState: getViewRenderStateSnapshot(v.id),
        cameraState: getViewCameraStateSnapshot(v.id)
      })),
    };

    const notifications = getNotificationCenter();
    const countLabel = jobs.length === 1
      ? jobs[0].format.toUpperCase()
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
      /** @type {{ blob: Blob; filename: string; result: { format: FigureExportFormat; filename: string; metadata: any } }[]} */
      const stagedDownloads = [];

      for (let idx = 0; idx < jobs.length; idx++) {
        const job = jobs[idx];
        const format = job.format;
        const dpi = job.dpi;

        notifications.show({
          id: notifId,
          message: `Rendering ${idx + 1}/${jobs.length}: ${format.toUpperCase()}…`
        });

        const payload = {
          ...payloadBase,
          format,
          dpi,
          options: createFigureExportPayloadOptions(options, format),
        };
        assertFigureExportPayload(payload);

        if (format === 'svg') {
          if (!svgRenderer) svgRenderer = await import('./renderers/svg-renderer.js');
          const blob = await svgRenderer.renderFigureToSvgBlob({ state, viewer, payload });
          if (!(blob instanceof Blob) || blob.type !== 'image/svg+xml') {
            throw new TypeError(
              'SVG renderer must publish exactly one image/svg+xml Blob.'
            );
          }
          const filename = buildExportFilename({
            datasetName,
            fieldKey,
            viewLabel: wantsGrid ? 'multiview' : views[0].label,
            variant: null,
            ext: 'svg',
            timestamp: ts
          });
          stagedDownloads.push({
            blob,
            filename,
            result: { format: 'svg', filename, metadata: payloadBase.meta },
          });
        } else {
          if (!pngRenderer) pngRenderer = await import('./renderers/png-renderer.js');
          const blob = await pngRenderer.renderFigureToPngBlob({ state, viewer, payload });
          if (!(blob instanceof Blob) || blob.type !== 'image/png') {
            throw new TypeError(
              'PNG renderer must publish exactly one image/png Blob.'
            );
          }
          const variant = needsMultiplePng ? `dpi${dpi}` : null;
          const filename = buildExportFilename({
            datasetName,
            fieldKey,
            viewLabel: wantsGrid ? 'multiview' : views[0].label,
            variant,
            ext: 'png',
            timestamp: ts
          });
          stagedDownloads.push({
            blob,
            filename,
            result: { format: 'png', filename, metadata: payloadBase.meta },
          });
        }
      }

      let deliveryBlob;
      let deliveryFilename;
      if (stagedDownloads.length === 1) {
        deliveryBlob = stagedDownloads[0].blob;
        deliveryFilename = stagedDownloads[0].filename;
      } else {
        deliveryBlob = await createFigureExportZip(
          stagedDownloads.map(staged => ({
            filename: staged.filename,
            blob: staged.blob,
          }))
        );
        if (deliveryBlob.type !== 'application/zip') {
          throw new TypeError(
            'Figure export batch archive must be exactly application/zip.'
          );
        }
        deliveryFilename = buildExportFilename({
          datasetName,
          fieldKey,
          viewLabel: wantsGrid ? 'multiview' : views[0].label,
          variant: 'batch',
          ext: 'zip',
          timestamp: ts
        });
      }
      downloadBlob(deliveryBlob, deliveryFilename);
      results.push(...stagedDownloads.map(staged => staged.result));

      const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      notifications.completeCalculation(notifId, 'Export complete', t1 - t0);
      notifications.success(
        results.length === 1
          ? 'Exported 1 file'
          : `Exported ${results.length} files in one ZIP archive`,
        { category: 'download', duration: 2500 }
      );
      return results;
    } catch (err) {
      console.error('[FigureExport] Export failed:', err);
      const message = err instanceof Error ? err.message : String(err);
      notifications.failCalculation(notifId, message);
      notifications.error(`Export failed: ${message}`, { category: 'render', duration: 6000 });
      throw err;
    }
  }

  return { exportFigure, exportFigures };
}
