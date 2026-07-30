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
import { cloneCameraState } from '../../../../rendering/camera-state-contract.js';
import {
  assertLodMembership,
  matchesLodMembershipPresentation,
} from './utils/lod-membership.js';
import {
  assertFigureExportBatchRequest,
  assertFigureExportPayload,
  assertFigureExportSingleRequest,
  assertFigureExportViewId,
  awaitFigureExportAbortable,
  createFigureExportPayloadOptions,
  isFigureExportSignalAborted,
  throwIfFigureExportAborted,
} from './figure-export-contract.js';

const LIVE_VIEW_ID = 'live';
const userNotifiedFailures = new WeakSet();

export function reportFigureExportFailure(
  rawError,
  {
    notifications = null,
    calculationId = null,
  } = {}
) {
  const error = rawError instanceof Error
    ? rawError
    : new Error(String(rawError));
  if (userNotifiedFailures.has(error)) return error;
  userNotifiedFailures.add(error);

  console.error('[FigureExport] Export failed:', error);
  const center = notifications ?? getNotificationCenter();
  if (calculationId !== null) {
    center.failCalculation(calculationId, error.message);
  }
  center.error(
    `Export failed: ${error.message}`,
    { category: 'render', duration: 6000 }
  );
  return error;
}

function cloneOwnedLegendValue(value, context, seen = new Map()) {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${context} contains a non-finite number.`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${context} contains unsupported mutable state.`);
  }
  if (seen.has(value)) {
    throw new TypeError(`${context} must not contain cyclic state.`);
  }
  seen.set(value, true);
  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== value.length + 1 ||
      !ownKeys.includes('length')
    ) {
      throw new TypeError(
        `${context} must be one dense array without custom properties.`
      );
    }
    const clone = new Array(value.length);
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`${context} must not contain sparse entries.`);
      }
      clone[index] = cloneOwnedLegendValue(
        value[index],
        `${context}[${index}]`,
        seen
      );
    }
    seen.delete(value);
    return clone;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${context} must contain only plain owned data.`);
  }
  const clone = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError(
        `${context} must contain only enumerable string data properties.`
      );
    }
    clone[key] = cloneOwnedLegendValue(
      descriptor.value,
      `${context}.${key}`,
      seen
    );
  }
  seen.delete(value);
  return clone;
}

function cloneRenderState(renderState, context) {
  if (renderState === null || typeof renderState !== 'object') {
    throw new TypeError(`${context} must be an object.`);
  }
  return {
    bgColor: new Float32Array(renderState.bgColor),
    cameraDistance: renderState.cameraDistance,
    cameraPosition: Array.from(renderState.cameraPosition),
    far: renderState.far,
    fogColor: new Float32Array(renderState.fogColor),
    fogDensity: renderState.fogDensity,
    fogFar: renderState.fogFar,
    fogNear: renderState.fogNear,
    fov: renderState.fov,
    lightDir: new Float32Array(renderState.lightDir),
    lightingStrength: renderState.lightingStrength,
    modelMatrix: new Float32Array(renderState.modelMatrix),
    mvpMatrix: new Float32Array(renderState.mvpMatrix),
    near: renderState.near,
    pointSize: renderState.pointSize,
    projectionMatrix: new Float32Array(renderState.projectionMatrix),
    shaderQuality: renderState.shaderQuality,
    sizeAttenuation: renderState.sizeAttenuation,
    viewMatrix: new Float32Array(renderState.viewMatrix),
    viewportHeight: renderState.viewportHeight,
    viewportWidth: renderState.viewportWidth,
  };
}

function cloneLodMembership(membership, pointCount, dimensionLevel, context) {
  const exact = assertLodMembership(membership, {
    pointCount,
    dimensionLevel,
    label: context,
  });
  if (exact === null) return null;
  return Object.freeze({
    dimensionLevel: exact.dimensionLevel,
    generationToken: Object.freeze({}),
    indices: new Uint32Array(exact.indices),
    lodLevel: exact.lodLevel,
    pointCount: exact.pointCount,
  });
}

function cloneTypedOwner(owner, cache, Type) {
  const existing = cache.get(owner);
  if (existing !== undefined) return existing;
  const clone = new Type(owner);
  cache.set(owner, clone);
  return clone;
}

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
 * @property {AbortSignal} signal
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
   * Snapshot every renderer input for one exact presented view. The borrowed
   * viewer owners may be read only inside the synchronous callback; every
   * value that crosses the export's first await is copied here.
   *
   * @param {string} viewId
   * @param {number} datasetGeneration
   * @param {boolean} captureLegend
   * @param {object} ownedCopies
   * @param {AbortSignal} signal
   */
  function getViewSnapshot(
    viewId,
    datasetGeneration,
    captureLegend,
    ownedCopies,
    signal
  ) {
    throwIfFigureExportAborted(signal);
    const vid = assertFigureExportViewId(viewId);
    const ctx = vid === LIVE_VIEW_ID
      ? null
      : state.viewContexts.get(vid);
    throwIfFigureExportAborted(signal);
    if (vid !== LIVE_VIEW_ID && !ctx) {
      throw new Error(`Figure export has no state context for view "${vid}".`);
    }

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
    throwIfFigureExportAborted(signal);
    const centroidFlags = viewer.getCentroidFlags(vid);
    throwIfFigureExportAborted(signal);
    if (
      centroidFlags === null ||
      typeof centroidFlags !== 'object' ||
      typeof centroidFlags.points !== 'boolean' ||
      typeof centroidFlags.labels !== 'boolean'
    ) {
      throw new TypeError(
        `Figure export centroid flags for view "${vid}" are incomplete.`
      );
    }

    if (
      typeof viewer.withBorrowedViewData !== 'function' ||
      typeof viewer.getPresentedViewState !== 'function'
    ) {
      throw new TypeError(
        'Figure export requires exact borrowed data and presented-view state APIs.'
      );
    }
    if (
      typeof state.getViewDimensionLevel !== 'function' ||
      typeof state.getFieldForView !== 'function' ||
      typeof state.getLegendModel !== 'function' ||
      typeof state.dimensionManager?.getNormTransform !== 'function'
    ) {
      throw new TypeError(
        'Figure export state is missing exact scientific snapshot methods.'
      );
    }

    const stateDimensionLevel = state.getViewDimensionLevel(vid);
    throwIfFigureExportAborted(signal);
    const field = state.getFieldForView(vid);
    throwIfFigureExportAborted(signal);
    if (
      field !== null &&
      (typeof field !== 'object' || Array.isArray(field))
    ) {
      throw new TypeError(
        `Figure export field for view "${vid}" must be an object or null.`
      );
    }
    const fieldKey = field === null ? null : field.key;
    if (fieldKey !== null && typeof fieldKey !== 'string') {
      throw new TypeError(
        `Figure export field key for view "${vid}" must be a string or null.`
      );
    }
    let legendModel = null;
    if (captureLegend && field !== null) {
      const borrowedLegendModel = state.getLegendModel(field);
      throwIfFigureExportAborted(signal);
      legendModel = cloneOwnedLegendValue(
        borrowedLegendModel,
        `Figure export legend for view "${vid}"`
      );
    }
    const normTransform = state.dimensionManager.getNormTransform(
      stateDimensionLevel
    );
    throwIfFigureExportAborted(signal);
    if (
      normTransform === null ||
      typeof normTransform !== 'object' ||
      !Array.isArray(normTransform.center) ||
      normTransform.center.length !== 3 ||
      normTransform.center.some((entry) => !Number.isFinite(entry)) ||
      !Number.isFinite(normTransform.scale) ||
      normTransform.scale <= 0
    ) {
      throw new TypeError(
        `Figure export normalization for view "${vid}" is incomplete.`
      );
    }

    const presented = viewer.getPresentedViewState(vid);
    throwIfFigureExportAborted(signal);
    if (
      presented === null ||
      typeof presented !== 'object' ||
      presented.dimensionLevel !== stateDimensionLevel
    ) {
      throw new Error(
        `Figure export presented dimension for view "${vid}" changed during snapshot.`
      );
    }

    return viewer.withBorrowedViewData(vid, (borrowed) => {
      throwIfFigureExportAborted(signal);
      if (
        borrowed === null ||
        typeof borrowed !== 'object' ||
        !Number.isSafeInteger(borrowed.pointCount) ||
        borrowed.pointCount < 0 ||
        borrowed.dimensionLevel !== stateDimensionLevel ||
        borrowed.geometryGeneration !== presented.geometryGeneration ||
        !matchesLodMembershipPresentation(
          presented.lodMembership,
          borrowed.lodMembership
        )
      ) {
        throw new Error(
          `Figure export view "${vid}" changed while its atomic snapshot was built.`
        );
      }
      if (
        !(borrowed.positions instanceof Float32Array) ||
        !(borrowed.colors instanceof Uint8Array) ||
        !(borrowed.transparency instanceof Float32Array) ||
        borrowed.positions.length !== borrowed.pointCount * 3 ||
        borrowed.colors.length !== borrowed.pointCount * 4 ||
        borrowed.transparency.length !== borrowed.pointCount
      ) {
        throw new TypeError(
          `Figure export view "${vid}" published incomplete borrowed arrays.`
        );
      }

      const pointCount = borrowed.pointCount;
      const positions = cloneTypedOwner(
        borrowed.positions,
        ownedCopies.positions,
        Float32Array
      );
      const colors = cloneTypedOwner(
        borrowed.colors,
        ownedCopies.colors,
        Uint8Array
      );
      const transparency = cloneTypedOwner(
        borrowed.transparency,
        ownedCopies.transparency,
        Float32Array
      );
      let lodMembership = null;
      if (borrowed.lodMembership !== null) {
        lodMembership = ownedCopies.lodMembership.get(
          borrowed.lodMembership
        );
        if (lodMembership === undefined) {
          lodMembership = cloneLodMembership(
            borrowed.lodMembership,
            pointCount,
            stateDimensionLevel,
            `Figure export LOD membership for "${vid}"`
          );
          ownedCopies.lodMembership.set(
            borrowed.lodMembership,
            lodMembership
          );
        }
      }
      return {
        data: {
          positions,
          colors,
          transparency,
          pointCount,
          centroidPositions: centroidPositions === null
            ? null
            : new Float32Array(centroidPositions),
          centroidColors: centroidColors === null
            ? null
            : new Uint8Array(centroidColors),
          centroidLabelTexts,
          centroidFlags: {
            points: centroidFlags.points,
            labels: centroidFlags.labels,
          },
        },
        renderState: cloneRenderState(
          presented.renderState,
          `Figure export render state for "${vid}"`
        ),
        cameraState: cloneCameraState(
          presented.cameraState,
          `Figure export camera state for "${vid}"`
        ),
        scientificState: {
          datasetGeneration,
          dimensionLevel: stateDimensionLevel,
          fieldKey,
          geometryGeneration: borrowed.geometryGeneration,
          legendModel,
          lodMembership,
          lodSizeMultiplier: presented.lodSizeMultiplier,
          normTransform: {
            center: [...normTransform.center],
            scale: normTransform.scale,
          },
        },
      };
    });
  }

  /**
   * Export the current figure.
   *
   * @param {FigureExportOptions} options
   */
  async function exportFigure(options) {
    let exactOptions = null;
    try {
      exactOptions = assertFigureExportSingleRequest(options);
      const results = await runExport(
        exactOptions,
        [{ format: exactOptions.format, dpi: exactOptions.dpi }]
      );
      return results[0];
    } catch (error) {
      if (
        exactOptions !== null &&
        isFigureExportSignalAborted(exactOptions.signal)
      ) {
        throw error;
      }
      throw reportFigureExportFailure(error);
    }
  }

  /**
   * Export multiple figures sequentially (batch export).
   *
   * @param {FigureExportOptions} options
   * @returns {Promise<Array<{ format: FigureExportFormat; filename: string; metadata: any }>>}
   */
  async function exportFigures(options) {
    let exactOptions = null;
    try {
      exactOptions = assertFigureExportBatchRequest(options);
      return await runExport(exactOptions, exactOptions.jobs);
    } catch (error) {
      if (
        exactOptions !== null &&
        isFigureExportSignalAborted(exactOptions.signal)
      ) {
        throw error;
      }
      throw reportFigureExportFailure(error);
    }
  }

  async function runExport(options, jobs) {
    const signal = options.signal;
    throwIfFigureExportAborted(signal);
    const width = options.width;
    const height = options.height;
    const exportAllViews = options.exportAllViews;
    if (typeof state.getDatasetGeneration !== 'function') {
      throw new TypeError(
        'Figure export requires DataState.getDatasetGeneration().'
      );
    }
    const datasetGeneration = state.getDatasetGeneration();
    throwIfFigureExportAborted(signal);
    if (!Number.isSafeInteger(datasetGeneration) || datasetGeneration < 0) {
      throw new TypeError(
        'Figure export requires an exact non-negative dataset generation.'
      );
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
    throwIfFigureExportAborted(signal);
    const activeViewId = state.getActiveViewId();
    throwIfFigureExportAborted(signal);
    const viewId = assertFigureExportViewId(activeViewId);
    const liveViewLabel = viewer.getLiveViewLabel();
    throwIfFigureExportAborted(signal);
    assertFigureExportViewId(liveViewLabel, 'Figure export live view label');
    const borrowedSnapshotViews = viewer.getSnapshotViews();
    throwIfFigureExportAborted(signal);
    const snapshotViews = borrowedSnapshotViews.map((view, index) => {
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
    throwIfFigureExportAborted(signal);
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
    throwIfFigureExportAborted(signal);
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
    throwIfFigureExportAborted(signal);
    if (!Array.isArray(filters) || filters.some((line) => typeof line !== 'string')) {
      throw new TypeError('Figure export filters must be an array of strings.');
    }

    const viewLayout = viewer.getViewLayout();
    throwIfFigureExportAborted(signal);
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

    if (
      typeof state.getTotalHighlightedCellCount !== 'function' ||
      typeof state.getHighlightedCellCount !== 'function'
    ) {
      throw new TypeError(
        'Figure export state is missing exact highlight snapshot methods.'
      );
    }
    const totalHighlighted = state.getTotalHighlightedCellCount();
    const visibleHighlighted =
      totalHighlighted === 0 ? 0 : state.getHighlightedCellCount();
    throwIfFigureExportAborted(signal);
    if (
      !Number.isSafeInteger(totalHighlighted) ||
      totalHighlighted < 0 ||
      !Number.isSafeInteger(visibleHighlighted) ||
      visibleHighlighted < 0 ||
      visibleHighlighted > totalHighlighted
    ) {
      throw new TypeError(
        'Figure export highlight counts must be exact non-negative integers.'
      );
    }
    let highlightArray = null;
    if (totalHighlighted > 0) {
      const highlightOwner = state.highlightArray;
      const highlightPointCount = state.pointCount;
      throwIfFigureExportAborted(signal);
      if (
        !(highlightOwner instanceof Uint8Array) ||
        highlightOwner.length !== highlightPointCount
      ) {
        throw new TypeError(
          'Figure export highlights must own one Uint8 value per point.'
        );
      }
      highlightArray = new Uint8Array(highlightOwner);
    }

    const ownedCopies = {
      colors: new WeakMap(),
      lodMembership: new WeakMap(),
      positions: new WeakMap(),
      transparency: new WeakMap(),
    };
    const payloadViews = [];
    for (const view of views) {
      throwIfFigureExportAborted(signal);
      payloadViews.push({
        id: view.id,
        label: view.label,
        ...getViewSnapshot(
          view.id,
          datasetGeneration,
          options.includeLegend,
          ownedCopies,
          signal
        ),
      });
      throwIfFigureExportAborted(signal);
    }

    const finalDatasetGeneration = state.getDatasetGeneration();
    throwIfFigureExportAborted(signal);
    const finalViewId = state.getActiveViewId();
    throwIfFigureExportAborted(signal);
    const finalStatePointCount = state.pointCount;
    const finalViewerPointCount = viewer.getPointCount();
    throwIfFigureExportAborted(signal);
    if (
      finalDatasetGeneration !== datasetGeneration ||
      finalViewId !== viewId ||
      finalStatePointCount !== finalViewerPointCount
    ) {
      throw new Error(
        'Figure export dataset or active view changed while its atomic snapshot was built.'
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
      selection: {
        highlightArray,
        totalCount: totalHighlighted,
        visibleCount: visibleHighlighted,
      },
      views: payloadViews,
    };

    throwIfFigureExportAborted(signal);
    const notifications = getNotificationCenter();
    const countLabel = jobs.length === 1
      ? jobs[0].format.toUpperCase()
      : `${jobs.length} exports`;
    const notifId = notifications.startCalculation(`Preparing ${countLabel}…`, 'render');
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const ts = formatTimestampForFilename();

    const results = [];
    try {
      throwIfFigureExportAborted(signal);
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
        throwIfFigureExportAborted(signal);

        if (format === 'svg') {
          if (!svgRenderer) {
            svgRenderer = await awaitFigureExportAbortable(
              signal,
              import('./renderers/svg-renderer.js')
            );
            throwIfFigureExportAborted(signal);
          }
          const blob = await awaitFigureExportAbortable(
            signal,
            svgRenderer.renderFigureToSvgBlob({ payload, signal })
          );
          throwIfFigureExportAborted(signal);
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
          if (!pngRenderer) {
            pngRenderer = await awaitFigureExportAbortable(
              signal,
              import('./renderers/png-renderer.js')
            );
            throwIfFigureExportAborted(signal);
          }
          const blob = await awaitFigureExportAbortable(
            signal,
            pngRenderer.renderFigureToPngBlob({ payload, signal })
          );
          throwIfFigureExportAborted(signal);
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
          })),
          { signal }
        );
        throwIfFigureExportAborted(signal);
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
      throwIfFigureExportAborted(signal);
      downloadBlob(deliveryBlob, deliveryFilename, { signal });
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
      if (isFigureExportSignalAborted(signal)) {
        notifications.dismiss(notifId);
        throw err;
      }
      throw reportFigureExportFailure(err, {
        notifications,
        calculationId: notifId,
      });
    }
  }

  return { exportFigure, exportFigures };
}
