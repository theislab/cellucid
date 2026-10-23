/**
 * @fileoverview The page's side of the figure-export worker
 * (`figure-export-worker.js`).
 *
 * One module worker serves every export of the page; it is created by the
 * first export and kept, with its WebGL2 contexts, for the page's lifetime.
 * Each rendered file opens a session: the typed arrays a request names are
 * copied to the worker once per session (a view's positions cross once
 * however many passes read them), and closing the session releases them.
 *
 * A request that outlives its export's abort is abandoned: it rejects with
 * the abort at once, and whatever the worker answers later is discarded (an
 * ImageBitmap closed) instead of delivered.
 *
 * @module ui/modules/figure-export/utils/figure-export-worker-client
 */

import { throwIfFigureExportAborted } from '../figure-export-contract.js';

function createDefaultWorker() {
  return new Worker(
    new URL('./figure-export-worker.js', import.meta.url),
    { type: 'module' }
  );
}

let workerFactory = createDefaultWorker;
/** @type {Worker|null} */
let worker = null;
let nextRequestId = 1;
let nextSessionId = 1;
/** @type {Map<number, {resolve: Function, reject: Function}>} */
const pending = new Map();

/**
 * Replace how the worker is created (Node contract tests run the same
 * handler in-process); `null` restores the module worker.
 *
 * @param {(() => Worker)|null} factory
 */
export function setFigureExportWorkerFactory(factory) {
  if (factory !== null && typeof factory !== 'function') {
    throw new TypeError('A figure-export worker factory must be a function or null.');
  }
  retireWorker(new Error('The figure-export worker was replaced.'));
  workerFactory = factory ?? createDefaultWorker;
}

const ERROR_TYPES = { RangeError, TypeError, SyntaxError };

/**
 * Rebuild an error the worker serialized, with its original class.
 *
 * @param {object} record
 * @returns {Error}
 */
function rebuildWorkerError(record) {
  const cause = record.cause === undefined ? undefined : rebuildWorkerError(record.cause);
  const options = cause === undefined ? undefined : { cause };
  if (record.name === 'AggregateError') {
    return new AggregateError(
      (record.errors ?? []).map(rebuildWorkerError),
      record.message,
      options
    );
  }
  const ErrorType = ERROR_TYPES[record.name] ?? Error;
  const error = new ErrorType(record.message, options);
  if (!(record.name in ERROR_TYPES) && record.name !== 'Error') error.name = record.name;
  return error;
}

/** Close whatever an abandoned answer still owns. */
function discardResult(result) {
  if (typeof ImageBitmap === 'function' && result instanceof ImageBitmap) result.close();
}

function retireWorker(reason) {
  const retired = worker;
  worker = null;
  const waiting = [...pending.values()];
  pending.clear();
  for (const entry of waiting) entry.reject(reason);
  retired?.terminate();
}

function ensureWorker() {
  if (worker !== null) return worker;
  const created = workerFactory();
  created.onmessage = ({ data }) => {
    const entry = pending.get(data.id);
    if (entry === undefined) {
      if (data.error === undefined) discardResult(data.result);
      return;
    }
    pending.delete(data.id);
    if (data.error !== undefined) entry.reject(rebuildWorkerError(data.error));
    else entry.resolve(data.result);
  };
  created.onerror = (event) => {
    event.preventDefault?.();
    retireWorker(new Error(
      `Figure-export worker failed: ${event.message || 'the worker could not run'}`
    ));
  };
  created.onmessageerror = () => {
    retireWorker(new Error('Figure-export worker sent a message that could not be read.'));
  };
  worker = created;
  return created;
}

/**
 * Open one file's worker session.
 *
 * @param {object} [options]
 * @param {AbortSignal|null} [options.signal] - the export's signal; an abort
 *   rejects every request at once
 */
export function openFigureExportWorkerSession({ signal = null } = {}) {
  const session = nextSessionId++;
  /** @type {Map<ArrayBufferView, number>} */
  const sent = new Map();
  /** @type {Array<[number, ArrayBufferView]>} */
  let uploads = [];
  let nextArrayId = 1;
  let closed = false;

  /**
   * Refer to `array` in a request; its bytes travel with the next request
   * unless this session has sent them already.
   *
   * @param {ArrayBufferView|null} array
   */
  function share(array) {
    if (array === null) return null;
    let arrayId = sent.get(array);
    if (arrayId === undefined) {
      arrayId = nextArrayId++;
      sent.set(array, arrayId);
      uploads.push([arrayId, array]);
    }
    return { $array: arrayId };
  }

  /**
   * @param {string} op
   * @param {object} args
   * @param {Transferable[]} [transfer] - objects handed over, never copied
   * @returns {Promise<any>}
   */
  function request(op, args, transfer = []) {
    if (closed) throw new Error('Figure-export worker session is closed.');
    throwIfFigureExportAborted(signal);
    const target = ensureWorker();
    const id = nextRequestId++;
    const message = { id, op, session, uploads, args };
    uploads = [];
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!pending.has(id)) return;
        pending.delete(id);
        try {
          throwIfFigureExportAborted(signal);
        } catch (error) {
          reject(error);
        }
      };
      pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        target.postMessage(message, transfer);
      } catch (error) {
        pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      }
    });
  }

  return {
    share,
    request,
    /** Release the session's arrays in the worker. */
    close() {
      if (closed) return;
      closed = true;
      sent.clear();
      uploads = [];
      worker?.postMessage({ op: 'close', session });
    },
  };
}

/**
 * The render-state fields a point pass, a bounds pass or vector shading
 * reads; the rest (the backdrop and its baked look) stays on the page.
 *
 * @param {object} renderState
 * @returns {object}
 */
export function pointPassRenderState(renderState) {
  return {
    antialias: renderState.antialias,
    bgColor: renderState.bgColor,
    cameraPosition: renderState.cameraPosition,
    fogColor: renderState.fogColor,
    fogDensity: renderState.fogDensity,
    fogFar: renderState.fogFar,
    fogNear: renderState.fogNear,
    fov: renderState.fov,
    lightDir: renderState.lightDir,
    lightingStrength: renderState.lightingStrength,
    modelMatrix: renderState.modelMatrix,
    mvpMatrix: renderState.mvpMatrix,
    pointSize: renderState.pointSize,
    projectionMatrix: renderState.projectionMatrix,
    shaderQuality: renderState.shaderQuality,
    sizeAttenuation: renderState.sizeAttenuation,
    viewMatrix: renderState.viewMatrix,
    viewportHeight: renderState.viewportHeight,
    viewportWidth: renderState.viewportWidth,
  };
}

/**
 * A LOD descriptor as a session request carries it.
 *
 * @param {ReturnType<typeof openFigureExportWorkerSession>} session
 * @param {import('./lod-membership.js').LodMembership|null} membership
 */
function shareLodMembership(session, membership) {
  if (membership === null) return null;
  return {
    dimensionLevel: membership.dimensionLevel,
    indices: session.share(membership.indices),
    lodLevel: membership.lodLevel,
    pointCount: membership.pointCount,
  };
}

/**
 * The axis bounds of one panel's drawn points (`coordinate-mapper.js`):
 * camera-space for a 3-D orbit view, embedding coordinates otherwise.
 *
 * @param {ReturnType<typeof openFigureExportWorkerSession>} session
 * @param {object} options
 * @returns {Promise<{minX: number, maxX: number, minY: number, maxY: number}|null>}
 */
export function requestVisibleBounds(session, {
  camera,
  positions,
  dimension,
  transparency,
  lodMembership,
  renderState,
  crop,
  normTransform,
}) {
  return session.request('visibleBounds', {
    camera,
    positions: session.share(positions),
    dimension,
    transparency: session.share(transparency),
    lodMembership: shareLodMembership(session, lodMembership),
    mvpMatrix: renderState.mvpMatrix,
    viewMatrix: renderState.viewMatrix,
    viewportWidth: renderState.viewportWidth,
    viewportHeight: renderState.viewportHeight,
    crop,
    ...(camera ? {} : { normTransform }),
  });
}

/**
 * `rasterizePointsWebgl` options as a session request carries them.
 *
 * @param {ReturnType<typeof openFigureExportWorkerSession>} session
 * @param {object} options - the rasterizer's options
 */
export function pointRasterArgs(session, {
  positions,
  dimension,
  colors,
  transparency,
  lodMembership,
  drawOrder,
  renderState,
  outputWidthPx,
  outputHeightPx,
  viewRect01,
  pointSizePx,
  overlayPoints,
  highlightArray,
  emphasizeSelection,
  selectionMutedOpacity,
}) {
  return {
    positions: session.share(positions),
    dimension,
    colors: session.share(colors),
    transparency: session.share(transparency),
    lodMembership: shareLodMembership(session, lodMembership),
    drawOrder: session.share(drawOrder),
    renderState: pointPassRenderState(renderState),
    outputWidthPx,
    outputHeightPx,
    viewRect01,
    pointSizePx,
    overlayPoints,
    highlightArray: session.share(highlightArray),
    emphasizeSelection,
    selectionMutedOpacity,
  };
}

/**
 * Encode a composed frame as PNG in the worker, with its `iTXt` metadata.
 * The frame is handed over, not copied.
 *
 * @param {ReturnType<typeof openFigureExportWorkerSession>} session
 * @param {ImageBitmap} bitmap
 * @param {Record<string, string>} textMap
 * @returns {Promise<Blob>}
 */
export function requestPngEncoding(session, bitmap, textMap) {
  return session.request('encodePng', { bitmap, textMap }, [bitmap]);
}

/**
 * Encode a raster as a PNG data URL in the worker. The frame is handed over.
 *
 * @param {ReturnType<typeof openFigureExportWorkerSession>} session
 * @param {ImageBitmap} bitmap
 * @returns {Promise<string>}
 */
export function requestPngDataUrl(session, bitmap) {
  return session.request('encodePngDataUrl', { bitmap }, [bitmap]);
}
