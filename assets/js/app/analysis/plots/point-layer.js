/**
 * Box and violin points drawn as one image per box instead of one SVG path
 * per point.
 *
 * Plotly draws every point of a box or violin as its own SVG path: a page of
 * half a million cells with all points shown was half a million DOM nodes and
 * 5 s of main-thread work (one 2.5 s task), and each hover move 0.7 s. The
 * vendored Plotly (see the header of assets/external/plotly.min.js) hands the
 * trace's `_cellucidPointLayer` -- this module -- everything its point loop
 * reads instead. A worker (point-raster-worker.js) lays the points out exactly
 * as that loop does (point-layout.js: the same pseudo-random jitter, the same
 * density-scaled spread), maps them to plot pixels as the axes do, and draws
 * every point as the marker's disc at the marker's opacity into one PNG. The
 * image goes into the trace's `g.points` group, where the paths were: the same
 * place in the drawing order, clipped to the plot like them, and part of the
 * SVG an image export serializes. Plotly waits for it (`gd._promises`) before a
 * plot, a relayout or an export resolves. The positions come back to the
 * calcdata (`_cellucidPos`, or each point record's `x`/`y`), from which hover
 * finds the nearest point as before.
 *
 * @module plots/point-layer
 */

import { analysisWorkerCount } from '../shared/performance-config.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** @type {Array<{worker: Worker, pending: number}>} */
const rasterWorkers = [];
let nextRequestId = 1;
/** @type {Map<number, {resolve: (answer: {blob: Blob, positions: Float64Array}) => void, reject: (error: Error) => void, slot: {worker: Worker, pending: number}}>} */
const pendingRasters = new Map();

function retireWorker(slot, error) {
  const index = rasterWorkers.indexOf(slot);
  if (index >= 0) rasterWorkers.splice(index, 1);
  slot.worker.terminate();
  for (const [id, pending] of pendingRasters) {
    if (pending.slot !== slot) continue;
    pendingRasters.delete(id);
    pending.reject(error);
  }
}

/**
 * The least busy raster worker, started on demand up to one per analysis
 * worker (cores − 2): the boxes of one plot are laid out and drawn at once.
 */
function rasterWorker() {
  let slot = rasterWorkers.reduce((best, s) => (best === null || s.pending < best.pending ? s : best), null);
  if (slot === null || (slot.pending > 0 && rasterWorkers.length < analysisWorkerCount())) {
    const worker = new Worker(new URL('./point-raster-worker.js', import.meta.url), { type: 'module' });
    const created = { worker, pending: 0 };
    worker.onmessage = ({ data }) => {
      const pending = pendingRasters.get(data.id);
      if (pending === undefined) return;
      pendingRasters.delete(data.id);
      created.pending--;
      if (typeof data.error === 'string') pending.reject(new Error(`Point raster failed: ${data.error}`));
      else pending.resolve({ blob: data.blob, positions: data.positions });
    };
    worker.onerror = event => {
      event.preventDefault?.();
      retireWorker(created, new Error(`The point raster worker failed: ${event.message || 'unknown error'}`));
    };
    rasterWorkers.push(created);
    slot = created;
  }
  return slot;
}

/**
 * @param {Object} request - point-raster-worker.js request, without its id
 * @returns {Promise<{blob: Blob, positions: Float64Array}>}
 */
function layOutAndRasterize(request) {
  const id = nextRequestId++;
  const slot = rasterWorker();
  slot.pending++;
  return new Promise((resolve, reject) => {
    pendingRasters.set(id, { resolve, reject, slot });
    // The values are Plotly's calcdata (and the plot's cached statistics):
    // copied, never moved.
    slot.worker.postMessage({ ...request, id });
  });
}

/** @param {Blob} blob @returns {Promise<string>} */
function dataUrlOf(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(/** @type {string} */ (reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Reading the point image failed'));
    reader.readAsDataURL(blob);
  });
}

/** @type {OffscreenCanvasRenderingContext2D|null} */
let colorContext = null;

/**
 * A CSS colour as its 8-bit channels and alpha, as the browser resolves it.
 * @param {string} color
 * @returns {{rgb: number[], alpha: number}}
 */
function parseColor(color) {
  colorContext ??= new OffscreenCanvas(1, 1).getContext('2d');
  colorContext.fillStyle = '#000000';
  colorContext.fillStyle = String(color);
  const resolved = colorContext.fillStyle;
  if (resolved.startsWith('#')) {
    return {
      rgb: [1, 3, 5].map(at => Number.parseInt(resolved.slice(at, at + 2), 16)),
      alpha: 1
    };
  }
  const channels = resolved.slice(resolved.indexOf('(') + 1, resolved.indexOf(')')).split(',').map(Number);
  return { rgb: channels.slice(0, 3), alpha: channels.length > 3 ? channels[3] : 1 };
}

/**
 * The marker as Plotly draws a box point: a circle of radius `size / 2`
 * rounded to two decimals, filled with the marker colour at the marker
 * opacity, without an outline.
 * @param {Object} trace - Plotly's full trace
 */
function markerStyle(trace) {
  const marker = trace.marker ?? {};
  const radius = Math.round(((marker.size || 6) / 2) * 100) / 100;
  const { rgb, alpha } = parseColor(marker.color);
  const opacity = marker.opacity === undefined ? 1 : marker.opacity;
  return { radius, rgb, alpha: alpha * opacity, key: `${radius}|${rgb.join(',')}|${alpha * opacity}` };
}

/** An axis as point-layout.js maps it: its type and linear transform. */
function axisTransform(axis) {
  if (Array.isArray(axis.rangebreaks) && axis.rangebreaks.length > 0) {
    throw new RangeError('Box and violin points cannot be laid out on an axis with range breaks');
  }
  return { type: axis.type, m: axis._m, b: axis._b };
}

/**
 * Per `g.points` group: what the image was last drawn from.
 * @type {WeakMap<Element, {request: Object, styleKey: string, generation: number, image: SVGImageElement, cd: Object, records: Object[]|null, mrc: number}>}
 */
const layers = new WeakMap();

function plotDivOf(node) {
  return node.closest?.('.js-plotly-plot') ?? null;
}

/**
 * Lay out and draw one group's points; the positions go back to the calcdata.
 * @param {Element} node - The `g.points` group
 * @param {ReturnType<typeof markerStyle>} style
 */
function renderLayer(node, style) {
  const layer = layers.get(node);
  const generation = ++layer.generation;
  layer.styleKey = style.key;
  const task = layOutAndRasterize({
    ...layer.request,
    scale: Math.max(2, globalThis.devicePixelRatio || 1),
    radius: style.radius,
    rgb: style.rgb,
    alpha: style.alpha
  }).then(async ({ blob, positions }) => {
    if (layers.get(node) !== layer || layer.generation !== generation) return;
    const { cd, records, request } = layer;
    if (records === null) {
      cd._cellucidPos = positions;
    } else {
      // Plotly's point records, as its own loop leaves them for hover.
      const { horizontal } = request;
      const { mode, lo, uo } = request.layout;
      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (horizontal) {
          record.y = positions[i];
          record.x = record.v;
        } else {
          record.x = positions[i];
          record.y = record.v;
        }
        record.mrc = layer.mrc;
        if (mode === 'suspectedoutliers' && record.v < uo && record.v > lo) record.so = true;
      }
    }
    const url = await dataUrlOf(blob);
    if (layers.get(node) !== layer || layer.generation !== generation) return;
    const { image } = layer;
    image.setAttribute('x', '0');
    image.setAttribute('y', '0');
    image.setAttribute('width', String(request.width));
    image.setAttribute('height', String(request.height));
    image.setAttribute('preserveAspectRatio', 'none');
    image.setAttributeNS(XLINK_NS, 'xlink:href', url);
  });
  const gd = plotDivOf(node);
  if (gd !== null && Array.isArray(gd._promises)) gd._promises.push(task);
  return task;
}

/**
 * Per scatter `g.points` group: the markers last laid out.
 * @type {WeakMap<Element, {xs: Float32Array, ys: Float32Array, points: Object[], radius: number, width: number, height: number, generation: number, image: SVGImageElement, fresh: boolean}>}
 */
const scatterLayers = new WeakMap();

/**
 * Each marker's palette entry, as Plotly's `singlePointStyle` fills a circle:
 * the colour of its value on the marker colour scale (or the marker colour),
 * at its own or the marker opacity.
 *
 * @param {Object[]} points - Plotly's calcdata entries
 * @param {Object} trace
 * @param {Object} fns - `Drawing.makePointStyleFns(trace)`
 */
function scatterColors(points, trace, fns) {
  const marker = trace.marker ?? {};
  const palette = [];
  const indexOf = new Map();
  const colorIndex = points.length > 65535 ? new Uint32Array(points.length) : new Uint16Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    // As Plotly's point style does, a scaled colour is kept on the point.
    const color = 'mc' in point ? (point.mcc = fns.markerScale(point.mc)) : (marker.color || marker.colors || 'rgba(0,0,0,0)');
    const opacity = point.mo === undefined ? marker.opacity : point.mo;
    const key = `${color}|${opacity}`;
    let index = indexOf.get(key);
    if (index === undefined) {
      const { rgb, alpha } = parseColor(color);
      index = palette.length;
      palette.push([...rgb, alpha * (opacity === undefined ? 1 : opacity)]);
      indexOf.set(key, index);
    }
    colorIndex[i] = index;
  }
  return { palette, colorIndex };
}

function renderScatter(node, colors) {
  const layer = scatterLayers.get(node);
  const generation = ++layer.generation;
  const task = layOutAndRasterize({
    kind: 'scatter',
    xs: layer.xs,
    ys: layer.ys,
    colorIndex: colors.colorIndex,
    palette: colors.palette,
    width: layer.width,
    height: layer.height,
    radius: layer.radius,
    scale: Math.max(2, globalThis.devicePixelRatio || 1)
  }).then(async ({ blob }) => {
    if (scatterLayers.get(node) !== layer || layer.generation !== generation) return;
    const url = await dataUrlOf(blob);
    if (scatterLayers.get(node) !== layer || layer.generation !== generation) return;
    const { image } = layer;
    image.setAttribute('x', '0');
    image.setAttribute('y', '0');
    image.setAttribute('width', String(layer.width));
    image.setAttribute('height', String(layer.height));
    image.setAttribute('preserveAspectRatio', 'none');
    image.setAttributeNS(XLINK_NS, 'xlink:href', url);
  });
  const gd = plotDivOf(node);
  if (gd !== null && Array.isArray(gd._promises)) gd._promises.push(task);
  return task;
}

/**
 * The trace's point layer, read by the vendored Plotly as
 * `trace._cellucidPointLayer`.
 */
export const POINT_LAYER = Object.freeze({
  /**
   * Draw a group's points (Plotly calls this from plotPoints with what its
   * point loop would read).
   *
   * @param {Element} node - The `g.points` group of one box or violin
   * @param {{cd: Object, trace: Object, xa: Object, ya: Object, records: Object[]|null, vals: ArrayLike<number>, layout: Object}} points
   */
  draw(node, { cd, trace, xa, ya, records, vals, layout }) {
    for (const path of node.querySelectorAll('path.point')) path.remove();
    let layer = layers.get(node);
    if (layer === undefined) {
      const image = document.createElementNS(SVG_NS, 'image');
      image.setAttribute('class', 'cellucid-points');
      node.appendChild(image);
      layer = { request: null, styleKey: '', generation: 0, image, cd, records, mrc: 0 };
      layers.set(node, layer);
    } else if (layer.image.parentNode !== node) {
      node.appendChild(layer.image);
    }
    delete cd._cellucidPos;
    layer.cd = cd;
    layer.records = records;
    layer.mrc = (trace.marker?.size || 6) / 2;
    layer.request = {
      vals,
      layout,
      xAxis: axisTransform(xa),
      yAxis: axisTransform(ya),
      horizontal: trace.orientation === 'h',
      width: xa._length,
      height: ya._length
    };
    renderLayer(node, markerStyle(trace));
  },

  /**
   * Redraw a trace's point images when its marker style changed (Plotly's
   * style step, which runs after every plot and on style-only updates).
   *
   * @param {Element} traceNode - The trace group
   * @param {Object} trace - Plotly's full trace
   */
  restyle(traceNode, trace) {
    const style = markerStyle(trace);
    for (const node of traceNode.querySelectorAll('g.points')) {
      const layer = layers.get(node);
      if (layer !== undefined && layer.request !== null && layer.styleKey !== style.key) renderLayer(node, style);
    }
  },

  /**
   * Draw a scatter trace's markers (Plotly calls this from its scatter plot
   * with the points it would draw): circles without an outline, at the axes'
   * own pixels, in the colours Plotly's point style gives them, one over
   * another in order. Each point keeps its marker radius (`mrc`) for hover.
   *
   * @param {Element} node - The trace's `g.points` group
   * @param {{points: Object[], trace: Object, xa: Object, ya: Object, fns: Object}} markers
   */
  drawScatter(node, { points, trace, xa, ya, fns }) {
    for (const path of node.querySelectorAll('path.point')) path.remove();
    const marker = trace.marker ?? {};
    if (Array.isArray(marker.size) || Array.isArray(marker.symbol) || (marker.line?.width ?? 0) !== 0 ||
      !['circle', 0, '0', undefined].includes(marker.symbol)) {
      throw new TypeError('The point layer draws circles of one size without an outline');
    }
    const radius = typeof fns.ms2mrc === 'function' ? fns.ms2mrc() : 3;
    const xs = new Float32Array(points.length);
    const ys = new Float32Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      const x = xa.c2p(point.x);
      const y = ya.c2p(point.y);
      // Plotly draws no marker where either pixel is not a number.
      xs[i] = Number.isFinite(x) ? x : NaN;
      ys[i] = Number.isFinite(y) ? y : NaN;
      point.mrc = radius;
    }
    let layer = scatterLayers.get(node);
    if (layer === undefined) {
      const image = document.createElementNS(SVG_NS, 'image');
      image.setAttribute('class', 'cellucid-points');
      node.appendChild(image);
      layer = { generation: 0, image };
      scatterLayers.set(node, layer);
    } else if (layer.image.parentNode !== node) {
      node.appendChild(layer.image);
    }
    Object.assign(layer, {
      xs, ys, points, width: xa._length, height: ya._length,
      radius: Math.round(radius * 100) / 100,
      // Plotly's style step follows every plot: it needs no second image.
      fresh: true
    });
    renderScatter(node, scatterColors(points, trace, fns));
  },

  /**
   * Redraw a scatter trace's markers after a style-only change (the colours of
   * a volcano's genes when its thresholds move).
   *
   * @param {Element} node - The trace's `g.points` group
   * @param {Object} trace
   * @param {Object} fns - `Drawing.makePointStyleFns(trace)`
   */
  restyleScatter(node, trace, fns) {
    const layer = scatterLayers.get(node);
    if (layer === undefined) return;
    if (layer.fresh) {
      layer.fresh = false;
      return;
    }
    renderScatter(node, scatterColors(layer.points, trace, fns));
  }
});
