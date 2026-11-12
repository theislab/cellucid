/**
 * @fileoverview The figure-export worker: every per-cell pass and every
 * encode of an export, off the page's main thread.
 *
 * The page composes a figure (title, legends, axes, reference layer) on a 2D
 * canvas and writes the SVG's annotations; this worker does the rest:
 *
 * - `drawnCells`: whether a figure of the pane draws any cell (one pass over
 *   N, stopping at the first; `sourceHasDrawnCells`);
 * - `webgl2`: whether this thread can draw a point pass (an OffscreenCanvas
 *   WebGL2 context);
 * - `rasterizePoints`: the shader-accurate point pass, on an OffscreenCanvas
 *   WebGL2 context this thread owns, returned as an ImageBitmap the page
 *   composites (`webgl-point-rasterizer.js`); `rasterContext` describes that
 *   context (renderer, granted attributes, samples);
 * - `encodeRasterPngDataUrl`: the Hybrid SVG's point pass, placed and
 *   encoded as a PNG data URL;
 * - `svgPointMarkup`: the circles of a Full or Optimized Vector SVG, as one
 *   Blob (`svg-point-markup.js`);
 * - `encodePng` / `encodePngDataUrl`: a composed frame encoded with
 *   `OffscreenCanvas.convertToBlob`, the PNG's `iTXt` metadata added here.
 *
 * The encoders take the pixels the page read (an ImageData, handed over),
 * never an ImageBitmap of a page canvas (`pagePixels` in
 * `figure-export-worker-client.js` says why).
 *
 * Requests belong to a session, one per rendered file. A session's typed
 * arrays are sent once (`uploads`) and referred to by id afterwards
 * (`{ $array: id }`), so a view's positions cross once per file however many
 * passes read them; `close` drops them.
 *
 * Messages: `{ id, op, session, uploads, args }` is answered with
 * `{ id, result }` or `{ id, error }`; `{ op: 'close', session }` has no reply.
 * An upload larger than one ArrayBuffer (a WebAssembly memory's on the
 * page, `utils/large-arrays.js`) arrives first in pieces, `{ session, piece }`
 * (no reply), and `uploads` holds its placeholder.
 *
 * Where a worker cannot create a WebGL2 context (WebKitGTK, WPE; `webgl2`
 * answers false), the page runs this same handler for the point passes
 * (`spriteZoomLimit`, `rasterizePoints`, `rasterContext`):
 * `figure-export-worker-client.js`.
 *
 * @module ui/modules/figure-export/utils/figure-export-worker
 */

import { sourceHasDrawnCells } from './coordinate-mapper.js';
import {
  describeRasterContext,
  exportSpriteZoomLimit,
  rasterizePointsWebgl,
  webgl2RasterAvailable,
} from './webgl-point-rasterizer.js';
import { embedPngMetadata } from './png-metadata.js';
import { PieceReceiver } from '../../../../../utils/large-arrays.js';
import { writeSvgPointMarkup } from '../renderers/svg-point-markup.js';
import { toWire } from '../../../../../utils/error-wire.js';
import { cancelled } from '../../../../../utils/abort.js';

/** Replace every `{ $array: id }` in `value` with the session's array. */
function resolveArrays(value, arrays) {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) {
    return value;
  }
  if (Array.isArray(value)) return value.map(item => resolveArrays(item, arrays));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  if (Object.hasOwn(value, '$array')) {
    const array = arrays.get(value.$array);
    if (array === undefined) {
      throw new Error(`Figure-export worker has no array ${value.$array} in this session.`);
    }
    return array;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = resolveArrays(item, arrays);
  return out;
}

/**
 * A figure's LOD record again (`shareLodMembership`): structured cloning
 * drops the freeze the record's contract requires (`LodMembership`).
 */
function reviveLodMembership(membership) {
  if (membership === null) return null;
  return Object.freeze({
    admissionLevels: membership.admissionLevels,
    count: membership.count,
    dimensionLevel: membership.dimensionLevel,
    generationToken: Object.freeze({}),
    indices: membership.indices,
    lodLevel: membership.lodLevel,
    pointCount: membership.pointCount,
  });
}

function reviveRasterOptions(options) {
  return {
    ...options,
    lodMembership: reviveLodMembership(options.lodMembership),
  };
}

/**
 * A canvas holding `pixels` (an ImageData the page read, `pagePixels` in
 * `figure-export-worker-client.js`) exactly as they are, for encoding.
 */
function pixelCanvas(pixels) {
  const canvas = new OffscreenCanvas(pixels.width, pixels.height);
  const context = canvas.getContext('2d', { alpha: true });
  if (context === null) {
    throw new Error('Figure-export PNG encoding requires a Canvas 2D context.');
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

async function encodeCanvasPng(canvas, failureMessage) {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  if (!(blob instanceof Blob) || blob.type !== 'image/png') {
    throw new Error(failureMessage);
  }
  return blob;
}

function blobToDataUrl(blob) {
  return new FileReaderSync().readAsDataURL(blob);
}

/**
 * Scale a Hybrid point raster zoomed past the GPU's sprite range
 * (`planPlotRaster`) up to the plot raster it covers.
 */
function placeRaster(pixels, placement) {
  const canvas = new OffscreenCanvas(placement.width, placement.height);
  const context = canvas.getContext('2d', { alpha: true });
  if (context === null) {
    throw new Error('SVG Hybrid raster scaling requires a Canvas 2D context');
  }
  context.drawImage(pixelCanvas(pixels), 0, 0, placement.width, placement.height);
  return canvas;
}

const operations = {
  webgl2: () => ({ result: webgl2RasterAvailable() }),

  spriteZoomLimit: () => ({ result: exportSpriteZoomLimit() }),

  rasterContext: ({ antialias }) => ({ result: describeRasterContext(antialias) }),

  drawnCells: (args) => ({
    result: sourceHasDrawnCells({ ...args, lodMembership: reviveLodMembership(args.lodMembership) }),
  }),

  rasterizePoints: (args) => {
    const frame = rasterizePointsWebgl(reviveRasterOptions(args));
    return { result: frame, transfer: [frame] };
  },

  encodeRasterPngDataUrl: async ({ pixels, placement }) => {
    const canvas = placement === null ? pixelCanvas(pixels) : placeRaster(pixels, placement);
    const blob = await encodeCanvasPng(
      canvas,
      placement === null
        ? 'SVG Hybrid point-pass PNG encoding failed'
        : 'SVG Hybrid scaled point-pass PNG encoding failed'
    );
    return { result: blobToDataUrl(blob) };
  },

  svgPointMarkup: (args) => ({
    result: writeSvgPointMarkup({
      ...args,
      lodMembership: reviveLodMembership(args.lodMembership),
    }),
  }),

  encodePng: async ({ pixels, text, dpi }) => {
    const blob = await encodeCanvasPng(pixelCanvas(pixels), 'PNG encoding failed.');
    return { result: await embedPngMetadata(blob, { text, dpi }) };
  },

  encodePngDataUrl: async ({ pixels }) => {
    const blob = await encodeCanvasPng(pixelCanvas(pixels), 'Figure-export PNG encoding failed.');
    return { result: blobToDataUrl(blob) };
  },
};

/**
 * The worker's message handler, also run on the page for the point passes
 * where a worker cannot draw, and in-process by the Node contract tests. It
 * answers `{ reply, transfer }`, or null for a message without a
 * reply.
 *
 * @returns {(message: object) => Promise<{reply: object, transfer: Transferable[]}|null>}
 */
export function createFigureExportWorkerHandler() {
  /** @type {Map<number, Map<number, ArrayBufferView>>} */
  const sessions = new Map();
  /**
   * The pieces of arrays too large to clone, by session, for the request
   * that follows them (`utils/large-arrays.js`).
   * @type {Map<number, PieceReceiver>}
   */
  const pieces = new Map();
  /** Sessions whose export was stopped: their requests still queued are skipped. */
  const cancelledSessions = new Set();

  return async function handle(message) {
    const { id, op, session } = message;
    if (op === 'cancel') {
      cancelledSessions.add(session);
      return null;
    }
    if (message.piece !== undefined) {
      let receiver = pieces.get(session);
      if (receiver === undefined) {
        receiver = new PieceReceiver();
        pieces.set(session, receiver);
      }
      receiver.receive(message.piece);
      return null;
    }
    if (op === 'close') {
      sessions.delete(session);
      pieces.delete(session);
      cancelledSessions.delete(session);
      return null;
    }
    if (cancelledSessions.has(session)) {
      return { reply: { id, error: toWire(cancelled('user', 'The figure export was canceled.')) }, transfer: [] };
    }
    try {
      let arrays = sessions.get(session);
      if (arrays === undefined) {
        arrays = new Map();
        sessions.set(session, arrays);
      }
      const receiver = pieces.get(session);
      pieces.delete(session);
      const uploads = receiver === undefined ? message.uploads : receiver.resolve(message.uploads);
      for (const [arrayId, array] of uploads) arrays.set(arrayId, array);
      const operation = Object.hasOwn(operations, op) ? operations[op] : undefined;
      if (operation === undefined) {
        throw new TypeError(`Figure-export worker has no operation "${op}".`);
      }
      const { result, transfer = [] } = await operation(resolveArrays(message.args, arrays));
      return { reply: { id, result }, transfer };
    } catch (error) {
      return { reply: { id, error: toWire(error) }, transfer: [] };
    }
  };
}

if (
  typeof self !== 'undefined' &&
  typeof self.postMessage === 'function' &&
  typeof window === 'undefined'
) {
  const handle = createFigureExportWorkerHandler();
  // One request at a time: every operation but the encoders' awaits is
  // synchronous, and a GL context is never shared by two passes.
  let queue = Promise.resolve();
  self.onmessage = (event) => {
    // A cancel is heard at once, ahead of the queue it stops.
    if (event.data?.op === 'cancel') {
      void handle(event.data);
      return;
    }
    queue = queue.then(async () => {
      const answer = await handle(event.data);
      if (answer !== null) self.postMessage(answer.reply, answer.transfer);
    });
  };
}
