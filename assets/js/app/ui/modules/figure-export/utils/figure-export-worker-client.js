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
 * The point passes (`spriteZoomLimit`, `rasterizePoints`) draw with WebGL2 on
 * an OffscreenCanvas. Before the first of them the worker is asked once
 * whether it can create such a context (`webgl2`), and the answer holds for
 * the page's lifetime. Where it cannot -- WebKitGTK and WPE have no WebGL in
 * workers (https://bugs.webkit.org/show_bug.cgi?id=209809), nor did Safari
 * 16.4-16.6, or 17.0-17.1 on macOS Ventura
 * (https://bugs.webkit.org/show_bug.cgi?id=183720) -- the same
 * handler draws them on the page (`rasterizeOnPage`); every other operation
 * (bounds, vector markup, every encode) stays in the worker.
 *
 * A request that outlives its export's abort is abandoned: it rejects with
 * the abort at once, and whatever its thread answers later is discarded (an
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

/** The operations that draw with WebGL2, run where a WebGL2 context exists. */
const POINT_PASS_OPERATIONS = new Set(['spriteZoomLimit', 'rasterizePoints']);

let workerFactory = createDefaultWorker;
/** @type {Worker|null} */
let worker = null;
/**
 * Whether the worker can draw the point passes: null until it is asked,
 * then its answer for the page's lifetime.
 * @type {boolean|null}
 */
let workerWebgl2 = null;
/** @type {Promise<boolean>|null} */
let workerWebgl2Answer = null;
/**
 * The same handler on the page, created once a worker cannot draw.
 * @type {{postMessage: Function, onmessage: Function|null}|null}
 */
let pageHost = null;
let nextRequestId = 1;
let nextSessionId = 1;
/** @type {Map<number, {resolve: Function, reject: Function}>} */
const pending = new Map();

/**
 * Replace how the worker is created (Node contract tests run the same
 * handler in-process); `null` restores the module worker. A new worker is
 * asked again whether it can draw.
 *
 * @param {(() => Worker)|null} factory
 */
export function setFigureExportWorkerFactory(factory) {
  if (factory !== null && typeof factory !== 'function') {
    throw new TypeError('A figure-export worker factory must be a function or null.');
  }
  retireWorker(new Error('The figure-export worker was replaced.'));
  workerFactory = factory ?? createDefaultWorker;
  workerWebgl2 = null;
  workerWebgl2Answer = null;
}

/**
 * State whether the worker can draw the point passes instead of asking it
 * (tests: `false` draws them on the page, as on WebKitGTK); `null` asks the
 * worker again at the next point pass.
 *
 * @param {boolean|null} value
 */
export function setFigureExportWorkerWebgl2(value) {
  if (value !== null && typeof value !== 'boolean') {
    throw new TypeError('Whether the figure-export worker has WebGL2 is a boolean or null.');
  }
  workerWebgl2 = value;
  workerWebgl2Answer = value === null ? null : Promise.resolve(value);
}

/**
 * Whether point passes are drawn on the page: null until the worker has
 * answered (or a test stated it).
 *
 * @returns {boolean|null}
 */
export function figureExportRasterizesOnPage() {
  return workerWebgl2 === null ? null : !workerWebgl2;
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

/** Deliver one answer, from the worker or the page host, to its request. */
function receive(data) {
  const entry = pending.get(data.id);
  if (entry === undefined) {
    if (data.error === undefined) discardResult(data.result);
    return;
  }
  pending.delete(data.id);
  if (data.error !== undefined) entry.reject(rebuildWorkerError(data.error));
  else entry.resolve(data.result);
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
  created.onmessage = ({ data }) => receive(data);
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
 * The worker's handler on the page, addressed as a worker is: one request at
 * a time (a GL context is never shared by two passes), each answered once it
 * settles. Nothing is copied: the arrays are the page's own.
 */
async function createPageHost() {
  const { createFigureExportWorkerHandler } = await import('./figure-export-worker.js');
  const handle = createFigureExportWorkerHandler();
  let queue = Promise.resolve();
  const host = {
    onmessage: null,
    postMessage(message) {
      queue = queue.then(async () => {
        const answer = await handle(message);
        if (answer !== null) host.onmessage?.({ data: answer.reply });
      });
    },
  };
  host.onmessage = ({ data }) => receive(data);
  return host;
}

let pageHostCreation = null;

function ensurePageHost() {
  pageHostCreation ??= createPageHost().then(
    (host) => {
      pageHost = host;
      return host;
    },
    (error) => {
      pageHostCreation = null;
      throw error;
    }
  );
  return pageHostCreation;
}

/**
 * Ask the worker, once for the page, whether it can draw the point passes.
 * The question belongs to no export, so no export's abort cancels it; a
 * failed question is asked again at the next point pass.
 *
 * @returns {Promise<boolean>}
 */
function askWorkerWebgl2() {
  workerWebgl2Answer ??= new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    try {
      ensureWorker().postMessage({ id, op: 'webgl2', session: 0, uploads: [], args: {} });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  }).then(
    (answer) => {
      workerWebgl2 = answer === true;
      return workerWebgl2;
    },
    (error) => {
      workerWebgl2Answer = null;
      throw error;
    }
  );
  return workerWebgl2Answer;
}

/** `promise`, or the export's abort if that comes first. */
function untilAborted(promise, signal) {
  if (signal === null) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      try {
        throwIfFigureExportAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
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
  /** Every array this session has named, by id. @type {Map<ArrayBufferView, number>} */
  const ids = new Map();
  /** @type {Map<number, ArrayBufferView>} */
  const arrays = new Map();
  /** The ids each thread already holds. @type {WeakMap<object, Set<number>>} */
  const held = new WeakMap();
  let nextArrayId = 1;
  let closed = false;

  /**
   * Refer to `array` in a request; its bytes travel with the first request
   * to each thread that reads it.
   *
   * @param {ArrayBufferView|null} array
   */
  function share(array) {
    if (array === null) return null;
    let arrayId = ids.get(array);
    if (arrayId === undefined) {
      arrayId = nextArrayId++;
      ids.set(array, arrayId);
      arrays.set(arrayId, array);
    }
    return { $array: arrayId };
  }

  /** The `[id, array]` pairs `args` names that `host` does not hold yet. */
  function uploadsFor(host, args) {
    let holds = held.get(host);
    if (holds === undefined) {
      holds = new Set();
      held.set(host, holds);
    }
    const uploads = [];
    const visit = (value) => {
      if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) return;
      if (Object.hasOwn(value, '$array')) {
        if (!holds.has(value.$array)) {
          holds.add(value.$array);
          uploads.push([value.$array, arrays.get(value.$array)]);
        }
        return;
      }
      Object.values(value).forEach(visit);
    };
    visit(args);
    return uploads;
  }

  function send(target, op, args, transfer) {
    const id = nextRequestId++;
    const message = { id, op, session, uploads: uploadsFor(target, args), args };
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

  /**
   * @param {string} op
   * @param {object} args
   * @param {Transferable[]} [transfer] - objects handed over, never copied
   * @returns {Promise<any>}
   */
  function request(op, args, transfer = []) {
    if (closed) throw new Error('Figure-export worker session is closed.');
    throwIfFigureExportAborted(signal);
    if (!POINT_PASS_OPERATIONS.has(op) || workerWebgl2 === true) {
      return send(ensureWorker(), op, args, transfer);
    }
    return (async () => {
      const rasterizeOnPage = !(await untilAborted(askWorkerWebgl2(), signal));
      if (closed) throw new Error('Figure-export worker session is closed.');
      throwIfFigureExportAborted(signal);
      const target = rasterizeOnPage ? await ensurePageHost() : ensureWorker();
      throwIfFigureExportAborted(signal);
      return send(target, op, args, transfer);
    })();
  }

  return {
    share,
    request,
    /** Release the session's arrays in the worker (and on the page). */
    close() {
      if (closed) return;
      closed = true;
      ids.clear();
      arrays.clear();
      worker?.postMessage({ op: 'close', session });
      pageHost?.postMessage({ op: 'close', session });
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
