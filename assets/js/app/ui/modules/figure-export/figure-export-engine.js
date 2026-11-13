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
import { loadAppCode } from '../../../app-code.js';
import { buildExportFilename } from './utils/export-helpers.js';
import { downloadBlob, fileTimestamp } from '../../../utils/download.js';
import { createFigureExportZip } from './utils/zip-archive.js';
import { cloneCameraState } from '../../../../rendering/camera-state-contract.js';
import {
  matchesLodMembershipPresentation,
  ownedLodMembership,
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
import { formatCountOf } from '../../../../utils/format-units.js';
import { describeSubsampleMethod } from '../../../../data/subsample.js';
import { citationText } from '../../../../data/anndata-cellucid-metadata.js';
import { allocateLargeArray } from '../../../../utils/large-arrays.js';
import { setOwnDataProperty } from '../../../../utils/exact-record.js';
import { failureDetails, sayFailure } from '../../../../utils/errors.js';
import { isCancellation } from '../../../../utils/abort.js';
import { computeFigureLayout } from './utils/layout.js';
import { cellsFrameRect01, unionCellsFrames } from './utils/cells-frame.js';
import { readShownVectorFieldOverlay } from './utils/overlay-fidelity.js';

const LIVE_VIEW_ID = 'live';
const userNotifiedFailures = new WeakSet();

/**
 * Say an export's failure once, on its progress card when it has one. A
 * cancellation is never a failure (`utils/abort.js`): a renderer whose load
 * the page's leaving cut off (`app-code.js` `loadAppCode`) withdraws the
 * card and says nothing. Returns the error, for the caller to throw.
 */
export function reportFigureExportFailure(
  rawError,
  {
    notifications = null,
    calculationId = null,
  } = {}
) {
  if (isCancellation(rawError)) {
    if (calculationId !== null) (notifications ?? getNotificationCenter()).dismiss(calculationId);
    return rawError;
  }
  const error = rawError instanceof Error
    ? rawError
    : new Error(String(rawError));
  if (userNotifiedFailures.has(error)) return error;
  userNotifiedFailures.add(error);

  console.error('[FigureExport] Export failed:', error);
  const center = notifications ?? getNotificationCenter();
  // One card says it: the export's own progress card when it has one, else a new one.
  const said = `Export failed: ${sayFailure(error)}`;
  if (calculationId !== null) center.failCalculation(calculationId, said, failureDetails(error));
  else center.error(said, { category: 'render', duration: 6000, ...failureDetails(error) });
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
  // A categorical's colors and visibility are bytes (`utils/category-state.js`).
  if (value instanceof Uint8Array) return value.slice();
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
    // A key can be a category's name (`__proto__` too): an own property, never the prototype.
    setOwnDataProperty(clone, key, cloneOwnedLegendValue(
      descriptor.value,
      `${context}.${key}`,
      seen
    ));
  }
  seen.delete(value);
  return clone;
}

/**
 * @param {object} renderState - the presented per-view render state
 * @param {boolean} antialias - `viewer.getAntialiasing()`
 * @param {string} context
 */
function cloneRenderState(renderState, antialias, context) {
  if (renderState === null || typeof renderState !== 'object') {
    throw new TypeError(`${context} must be an object.`);
  }
  if (typeof antialias !== 'boolean') {
    throw new TypeError(
      `${context} requires the exact antialiasing the viewer was granted.`
    );
  }
  return {
    // The granted value, not the requested one: a browser may refuse
    // multisampling, and the screen the figure claims to reproduce is the one
    // that was actually drawn.
    antialias,
    backdrop: {
      centerY: renderState.backdrop.centerY,
      extentX: renderState.backdrop.extentX,
      extentY: renderState.backdrop.extentY,
      extentZ: renderState.backdrop.extentZ,
      flat: renderState.backdrop.flat,
      floorY: renderState.backdrop.floorY,
      glowCenterX: renderState.backdrop.glowCenterX,
      pixelRatio: renderState.backdrop.pixelRatio,
      planarity: renderState.backdrop.planarity,
      stageX: renderState.backdrop.stageX,
      stageZ: renderState.backdrop.stageZ,
      // Frozen and never mutated by the viewer (a new bake publishes new
      // arrays), so the export may hold it as is.
      look: renderState.backdrop.look ?? null,
    },
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
    pointSizeMax: renderState.pointSizeMax,
    projectionMatrix: new Float32Array(renderState.projectionMatrix),
    shaderQuality: renderState.shaderQuality,
    sizeAttenuation: renderState.sizeAttenuation,
    viewMatrix: new Float32Array(renderState.viewMatrix),
    viewportHeight: renderState.viewportHeight,
    viewportWidth: renderState.viewportWidth,
  };
}

function cloneTypedOwner(owner, cache, Type) {
  const existing = cache.get(owner);
  if (existing !== undefined) return existing;
  const clone = allocateLargeArray(Type, owner.length);
  clone.set(owner);
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
   *   datasetCitation: string|null,
   *   datasetUserPath: string|null,
   *   datasetCells: {open: number, of: number, method: string, digest: string}|null
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
        `Figure export point-count mismatch: viewer has ${formatCountOf(viewerCount, 'point')} while state has ${stateCount}`
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
        datasetCitation: null,
        datasetUserPath: null,
        datasetCells: openCellsOf(null, null),
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
    const datasetCitation = citationText(meta?.citation);
    const datasetUserPath = dataSourceSnapshot.userPath ?? null;
    const datasetCells = openCellsOf(sourceType, datasetId);

    return {
      datasetName,
      datasetId,
      sourceType,
      datasetBaseUrl,
      datasetSourceName,
      datasetSourceUrl,
      datasetCitation,
      datasetUserPath,
      datasetCells,
    };
  }

  /**
   * The open cells when they are a subsample (`readProvenanceCells`): their
   * count, the dataset's, how they were chosen and their cell-set digest;
   * null when every cell is open.
   */
  function openCellsOf(sourceType, datasetId) {
    const identity = state.cellIdentity;
    if (!identity?.isSubset) return null;
    const annData = sourceType === null ? null : dataSourceManager?.getSource?.(sourceType)?.getAnnDataSource?.(datasetId) ?? null;
    const spec = typeof annData?.getCellSubset === 'function' ? annData.getCellSubset()?.spec ?? null : null;
    return {
      open: identity.n,
      of: identity.nOriginal,
      method: spec === null ? 'subsample' : describeSubsampleMethod(spec),
      digest: identity.digest,
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
   * @param {boolean} grantedAntialiasing
   * @param {object|null} vectorField - the vector field the view shows
   *   (`readFigureVectorFields`), drawn as arrows on a grid
   * @param {AbortSignal} signal
   */
  function getViewSnapshot(
    viewId,
    datasetGeneration,
    captureLegend,
    ownedCopies,
    grantedAntialiasing,
    vectorField,
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
      typeof state.getViewLayoutKey !== 'function' ||
      typeof state.getFieldForView !== 'function' ||
      typeof state.getFilterSummaryForView !== 'function' ||
      typeof state.getLegendModel !== 'function' ||
      typeof state.dimensionManager?.getNormTransform !== 'function'
    ) {
      throw new TypeError(
        'Figure export state is missing exact scientific snapshot methods.'
      );
    }

    const stateDimensionLevel = state.getViewDimensionLevel(vid);
    const stateLayoutKey = state.getViewLayoutKey(vid);
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
    const fieldKind = field === null ? null : field.kind;
    if (fieldKind !== null && typeof fieldKind !== 'string') {
      throw new TypeError(
        `Figure export field kind for view "${vid}" must be a string or null.`
      );
    }
    // Each view owns its filters: a grid export must be able to say which
    // panel a restriction applies to, and only this per-view read can.
    const filters = state.getFilterSummaryForView(vid);
    throwIfFigureExportAborted(signal);
    if (
      !Array.isArray(filters) ||
      filters.some((line) => typeof line !== 'string')
    ) {
      throw new TypeError(
        `Figure export filters for view "${vid}" must be an array of strings.`
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
      stateLayoutKey
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
        !(borrowed.transparency instanceof Uint8Array) ||
        borrowed.positions.length !==
          borrowed.pointCount * stateDimensionLevel ||
        borrowed.colors.length !== borrowed.pointCount * 4 ||
        borrowed.transparency.length !== borrowed.pointCount
      ) {
        throw new TypeError(
          `Figure export view "${vid}" published incomplete borrowed arrays.`
        );
      }

      const pointCount = borrowed.pointCount;
      if (vectorField !== null && vectorField.vectors.length !== pointCount * stateDimensionLevel) {
        throw new Error(
          `Figure export view "${vid}" changed while its vector field was read.`
        );
      }
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
        Uint8Array
      );
      // The pane's full-detail draw order, so the figure overlaps
      // translucent points exactly as the pane does.
      const drawOrder = borrowed.drawOrder === null
        ? null
        : cloneTypedOwner(borrowed.drawOrder, ownedCopies.drawOrder, Uint32Array);
      // The level's cells in the pane's draw order, copied once per level
      // and draw order (views sharing both share the copy).
      let lodMembership = null;
      if (borrowed.lodMembership !== null) {
        const kept = ownedCopies.lodMembership.get(borrowed.lodMembership);
        if (kept !== undefined && kept.drawOrder === borrowed.drawOrder) {
          lodMembership = kept.owned;
        } else {
          lodMembership = ownedLodMembership(
            borrowed.lodMembership,
            borrowed.drawOrder,
            {
              pointCount,
              dimensionLevel: stateDimensionLevel,
              label: `Figure export LOD membership for "${vid}"`,
            }
          );
          ownedCopies.lodMembership.set(borrowed.lodMembership, {
            drawOrder: borrowed.drawOrder,
            owned: lodMembership,
          });
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
          vectorField,
        },
        renderState: cloneRenderState(
          presented.renderState,
          grantedAntialiasing,
          `Figure export render state for "${vid}"`
        ),
        cameraState: cloneCameraState(
          presented.cameraState,
          `Figure export camera state for "${vid}"`
        ),
        scientificState: {
          datasetGeneration,
          dimensionLevel: stateDimensionLevel,
          drawOrder,
          fieldKey,
          fieldKind,
          filters: [...filters],
          geometryGeneration: borrowed.geometryGeneration,
          legendModel,
          lodMembership,
          lodSizeMultiplier: presented.lodSizeMultiplier,
          normTransform: {
            center: [...normTransform.center],
            scale: normTransform.scale,
          },
          // The cells read: their size over the others' and whether the
          // pane drew them at every level (`rendering/read-cell-layer.js`).
          pointLayers: {
            // Never below the others' size (both are of the last frame drawn).
            readScale: Math.max(1, presented.pointLayers.readSizeMultiplier / presented.lodSizeMultiplier),
            readEveryLevel: presented.pointLayers.readEveryLevel,
          },
        },
      };
    });
  }

  /**
   * The vector field each view shows, as a figure draws it
   * (`components/vector-field-figure.js`): the field the overlay shows, for
   * every view whose embedding it is bound to, with the overlay's color
   * scheme. A view of another embedding draws none, as on screen.
   *
   * @param {string[]} viewIds
   * @param {AbortSignal} signal
   * @returns {Promise<Map<string, object>>}
   */
  async function readFigureVectorFields(viewIds, signal) {
    const fields = new Map();
    const shown = readShownVectorFieldOverlay(typeof document === 'undefined' ? null : document);
    if (shown === null) return fields;
    const field = state.getAvailableVectorFields().find(each => each.id === shown.fieldId);
    if (field === undefined) {
      throw new Error(`Figure export cannot find the vector field "${shown.fieldId}" the overlay shows.`);
    }
    const manager = state.getVectorFieldManager();
    for (const vid of viewIds) {
      const layoutKey = state.getViewLayoutKey(vid);
      if (!field.layoutKeys.includes(layoutKey)) continue;
      const data = await awaitFigureExportAbortable(signal, manager.loadField(field.id, layoutKey));
      throwIfFigureExportAborted(signal);
      const transform = state.dimensionManager.getNormTransform(layoutKey);
      fields.set(vid, Object.freeze({
        label: field.label,
        colormapId: shown.colormapId,
        vectors: data.vectors,
        maxMagnitude: data.maxMagnitude,
        // The embedding's own units: render space over its scale.
        unitsPerRender: 1 / transform.scale,
      }));
    }
    return fields;
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

  /**
   * Snapshot the views and render one file per job: the one renderer behind
   * a download (`runExport`) and a picture returned to its caller
   * (`renderFigure`). `viewId` draws that view instead of the active one
   * (never a grid); `progress` hears the rendering start, after the
   * snapshot, and each job.
   *
   * @param {object} options An exact request (`assertFigureExportSingleRequest` / `…BatchRequest`)
   * @param {Array<{format: FigureExportFormat, dpi: number|null}>} jobs
   * @param {{viewId?: string|null, progress?: {start: () => void, job: (index: number, format: string) => void}|null}} [how]
   */
  async function renderStaged(options, jobs, { viewId: requestedViewId = null, progress = null } = {}) {
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
      datasetCitation,
      datasetUserPath,
      datasetCells,
    } = getDatasetIdentity();
    throwIfFigureExportAborted(signal);
    const activeViewId = state.getActiveViewId();
    throwIfFigureExportAborted(signal);
    const viewId = assertFigureExportViewId(requestedViewId ?? activeViewId);
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
      // The name it was given (`view.rename`): its panel's title.
      return { id: view.id, label: view.label, name: viewer.getViewName(view.id) };
    });
    const liveViewName = viewer.getViewName(LIVE_VIEW_ID);
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
    const viewName = viewId === LIVE_VIEW_ID
      ? liveViewName
      : activeSnapshot.name;

    const viewLayout = viewer.getViewLayout();
    throwIfFigureExportAborted(signal);
    const wantsGrid = requestedViewId === null && exportAllViews && viewLayout.mode === 'grid';

    const views = wantsGrid
      ? [
          ...(viewLayout.liveViewHidden
            ? []
            : [{ id: LIVE_VIEW_ID, label: liveViewLabel, name: liveViewName }]),
          ...snapshotViews,
        ]
      : [{ id: viewId, label: viewLabel, name: viewName }];
    if (views.length === 0) {
      throw new Error('Figure export grid contains no published views.');
    }

    if (
      typeof state.getTotalHighlightedCellCount !== 'function' ||
      typeof state.getHighlightedCellCount !== 'function' ||
      typeof state.getActivePage !== 'function'
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
    // The page whose cells are drawn highlighted: the figure's legend names
    // it (`utils/highlight-legend.js`).
    const highlightPageName = totalHighlighted > 0
      ? String(state.getActivePage()?.name ?? '')
      : null;

    // Multisampling is fixed when the browser creates the viewer's drawing
    // buffer, and the user can turn it off. The figure must be rasterized with
    // the value the viewer was *granted*, so it travels with the snapshot like
    // every other renderer input.
    if (typeof viewer.getAntialiasing !== 'function') {
      throw new TypeError(
        'Figure export requires viewer.getAntialiasing().'
      );
    }
    const grantedAntialiasing = viewer.getAntialiasing();
    throwIfFigureExportAborted(signal);
    if (typeof grantedAntialiasing !== 'boolean') {
      throw new TypeError(
        'Figure export requires an exact granted-antialiasing boolean.'
      );
    }

    const ownedCopies = {
      colors: new WeakMap(),
      drawOrder: new WeakMap(),
      lodMembership: new WeakMap(),
      positions: new WeakMap(),
      transparency: new WeakMap(),
    };
    // The vector field each panel shows, read before the synchronous
    // snapshot (the reader's arrays are shared and fixed for these cells).
    const vectorFields = await readFigureVectorFields(views.map(view => view.id), signal);
    throwIfFigureExportAborted(signal);
    const payloadViews = [];
    for (const view of views) {
      throwIfFigureExportAborted(signal);
      payloadViews.push({
        id: view.id,
        label: view.label,
        name: view.name,
        ...getViewSnapshot(
          view.id,
          datasetGeneration,
          options.includeLegend,
          ownedCopies,
          grantedAntialiasing,
          vectorFields.get(view.id) ?? null,
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
      finalViewId !== activeViewId ||
      finalStatePointCount !== finalViewerPointCount
    ) {
      throw new Error(
        'Figure export dataset or active view changed while its atomic snapshot was built.'
      );
    }

    // Provenance describes every exported panel, not the active one. A grid
    // stamped with one view's field and filters attributes that panel's
    // scientific state to the whole figure, which is a false claim in a
    // published figure. Each record is read out of the panel's own atomic
    // snapshot, so the metadata cannot describe a view the figure does not
    // draw.
    const provenanceViews = payloadViews.map((view) => ({
      id: view.id,
      label: view.label,
      name: view.name,
      fieldKey: view.scientificState.fieldKey,
      fieldKind: view.scientificState.fieldKind,
      filters: [...view.scientificState.filters],
      vectorField: view.data.vectorField === null ? null : view.data.vectorField.label,
    }));
    // The filename may name a color field only when every panel carries it.
    const exportedFieldKeys = new Set(
      provenanceViews.map((view) => view.fieldKey)
    );
    const filenameFieldKey = exportedFieldKeys.size === 1
      ? provenanceViews[0].fieldKey
      : null;

    // A grid figure keeps the arrangement the person sees (the viewer's
    // rule for the area its panes are shown in, `getPresentedGridColumns`).
    const gridColumns = views.length > 1 ? presentedGridColumns() : 1;
    const payloadBase = {
      width,
      height,
      gridColumns,
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
        datasetCitation,
        datasetUserPath,
        datasetCells,
        views: provenanceViews,
      },
      selection: {
        highlightArray,
        pageName: highlightPageName,
        totalCount: totalHighlighted,
        visibleCount: visibleHighlighted,
      },
      views: payloadViews,
    };

    throwIfFigureExportAborted(signal);
    progress?.start();
    const ts = fileTimestamp();
    const needsMultiplePng = jobs.filter((j) => j.format === 'png').length > 1;
    // A named view's file is named by its name.
    const fileViewLabel = wantsGrid ? 'multiview' : (views[0].name ?? views[0].label);

    /** @type {{ renderFigureToSvgBlob?: Function } | null} */
    let svgRenderer = null;
    /** @type {{ renderFigureToPngBlob?: Function } | null} */
    let pngRenderer = null;
    /** @type {{ blob: Blob; filename: string; result: { format: FigureExportFormat; filename: string; metadata: any } }[]} */
    const staged = [];
    let lastPayload = null;

    for (let idx = 0; idx < jobs.length; idx++) {
      const job = jobs[idx];
      const format = job.format;
      const dpi = job.dpi;
      progress?.job(idx, format);

      const payload = {
        ...payloadBase,
        format,
        dpi,
        options: createFigureExportPayloadOptions(options, format),
      };
      assertFigureExportPayload(payload);
      lastPayload = payload;
      throwIfFigureExportAborted(signal);

      if (format === 'svg') {
        if (!svgRenderer) {
          svgRenderer = await awaitFigureExportAbortable(
            signal,
            loadAppCode(() => import('./renderers/svg-renderer.js'))
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
          fieldKey: filenameFieldKey,
          viewLabel: fileViewLabel,
          variant: null,
          ext: 'svg',
          timestamp: ts
        });
        staged.push({
          blob,
          filename,
          result: { format: 'svg', filename, metadata: payloadBase.meta },
        });
      } else {
        if (!pngRenderer) {
          pngRenderer = await awaitFigureExportAbortable(
            signal,
            loadAppCode(() => import('./renderers/png-renderer.js'))
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
          fieldKey: filenameFieldKey,
          viewLabel: fileViewLabel,
          variant,
          ext: 'png',
          timestamp: ts
        });
        staged.push({
          blob,
          filename,
          result: { format: 'png', filename, metadata: payloadBase.meta },
        });
      }
    }
    // A single view's plot as its layout lays it out (`utils/layout.js`, the
    // one both renderers draw): within a box, or filling a width.
    const laid = computeFigureLayout(lastPayload);
    const plot = laid.single === null ? null : { width: laid.single.plotRect.width, height: laid.single.plotRect.height };
    // A legend asked beside the plot that stands below it to keep the figure to its width.
    const legendMovedBelow = laid.single !== null && laid.single.legendMovedBelow === true;
    return { staged, plot, legendMovedBelow, datasetName, filenameFieldKey, viewLabel: fileViewLabel, timestamp: ts };
  }

  /**
   * The columns of the grid on screen: what a grid figure is arranged in.
   * @returns {number}
   */
  function presentedGridColumns() {
    if (typeof viewer.getPresentedLayout !== 'function') {
      throw new TypeError('A grid figure requires viewer.getPresentedLayout().');
    }
    const layout = viewer.getPresentedLayout();
    if (layout === null || !layout.gridMultiview) {
      throw new Error('A grid figure is drawn while the views are shown in a grid; the grid is not laid out.');
    }
    return layout.cols;
  }

  /** Render the jobs and download them: one file, or several in one ZIP archive. */
  async function runExport(options, jobs) {
    const signal = options.signal;
    const notifications = getNotificationCenter();
    const countLabel = jobs.length === 1
      ? jobs[0].format.toUpperCase()
      : `${formatCountOf(jobs.length, 'export')}`;
    // Set once the snapshot is taken and rendering starts: a failure before
    // that is reported by the caller (`exportFigure`), as one of the request.
    let notifId = null;
    let t0 = 0;
    const progress = {
      start: () => {
        notifId = notifications.startCalculation(`Preparing ${countLabel}…`, 'render');
        t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      },
      job: (idx, format) => {
        notifications.show({
          id: notifId,
          message: `Rendering ${idx + 1}/${jobs.length}: ${format.toUpperCase()}…`
        });
      },
    };

    try {
      const { staged: stagedDownloads, datasetName, filenameFieldKey, viewLabel, timestamp } = await renderStaged(options, jobs, { progress });
      const results = [];
      let deliveryBlob;
      let deliveryFilename;
      if (stagedDownloads.length === 1) {
        deliveryBlob = stagedDownloads[0].blob;
        deliveryFilename = stagedDownloads[0].filename;
      } else {
        deliveryBlob = await createFigureExportZip(
          stagedDownloads.map(entry => ({
            filename: entry.filename,
            blob: entry.blob,
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
          fieldKey: filenameFieldKey,
          viewLabel,
          variant: 'batch',
          ext: 'zip',
          timestamp
        });
      }
      throwIfFigureExportAborted(signal);
      downloadBlob(deliveryBlob, deliveryFilename, { signal });
      results.push(...stagedDownloads.map(entry => entry.result));

      const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      notifications.completeCalculation(notifId, 'Export complete', t1 - t0);
      notifications.success(
        results.length === 1
          ? 'Exported 1 file'
          : `Exported ${formatCountOf(results.length, 'file')} in one ZIP archive`,
        { category: 'download', duration: 2500 }
      );
      return results;
    } catch (err) {
      if (notifId === null) throw err;
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

  /**
   * Render one figure and return it, without downloading it or telling the
   * person: a picture an agent reads, a step's picture in a report. The
   * same snapshot and renderer as a download.
   *
   * @param {FigureExportOptions} options An exact single request
   * @param {{viewId?: string|null}} [how] The view to draw (default: the active one)
   * @returns {Promise<{ blob: Blob; filename: string; metadata: any; plot: { width: number; height: number }|null, legendMovedBelow: boolean }>}
   *   `plot`: a single view's plot size in the figure, in figure pixels
   *   (1/96 inch); null for a grid. `legendMovedBelow`: the legend asked
   *   beside the plot stands below it, to keep the figure to its width
   */
  async function renderFigure(options, { viewId = null } = {}) {
    const exactOptions = assertFigureExportSingleRequest(options);
    const { staged, plot, legendMovedBelow } = await renderStaged(
      exactOptions,
      [{ format: exactOptions.format, dpi: exactOptions.dpi }],
      { viewId }
    );
    return { blob: staged[0].blob, filename: staged[0].filename, metadata: staged[0].result.metadata, plot, legendMovedBelow };
  }

  /**
   * The views a figure draws, as `renderStaged` takes them: the active one,
   * or with `exportAllViews` in a grid every panel (the live view unless it
   * is hidden, then the kept views).
   *
   * @param {{exportAllViews: boolean}} options
   * @returns {string[]}
   */
  function figureViewIds({ exportAllViews }) {
    const viewLayout = viewer.getViewLayout();
    if (!(exportAllViews && viewLayout.mode === 'grid')) return [assertFigureExportViewId(state.getActiveViewId())];
    return [
      ...(viewLayout.liveViewHidden ? [] : [LIVE_VIEW_ID]),
      ...viewer.getSnapshotViews().map(view => view.id),
    ];
  }

  /**
   * The frame that holds every cell the figure's views draw ("Fit the
   * cells", `utils/cells-frame.js`): the active view's, or with
   * `exportAllViews` in a grid every panel's, united. Null when no view
   * draws a cell.
   *
   * @param {{exportAllViews: boolean}} options
   * @returns {{x: number, y: number, width: number, height: number}|null}
   */
  function cellsFrame({ exportAllViews }) {
    return unionCellsFrames(figureViewIds({ exportAllViews }).map((vid) => {
      const presented = viewer.getPresentedViewState(vid);
      const renderState = presented.renderState;
      return viewer.withBorrowedViewData(vid, borrowed => cellsFrameRect01({
        positions: borrowed.positions,
        dimension: borrowed.dimensionLevel,
        transparency: borrowed.transparency,
        mvpMatrix: renderState.mvpMatrix,
        viewportWidth: renderState.viewportWidth,
        viewportHeight: renderState.viewportHeight,
        pointRadius: (renderState.pointSize * presented.lodSizeMultiplier) / 2,
      }));
    }));
  }

  /**
   * The vector field one view draws in a figure (its arrays, as
   * `readFigureVectorFields` reads them), or null: what the preview draws.
   *
   * @param {string} viewId
   * @returns {Promise<object|null>}
   */
  async function figureVectorField(viewId) {
    const fields = await readFigureVectorFields([assertFigureExportViewId(viewId)], null);
    return fields.get(viewId) ?? null;
  }

  return { exportFigure, exportFigures, renderFigure, cellsFrame, figureViewIds, figureVectorField };
}
