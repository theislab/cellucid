/**
 * The cells read of a view drawn at every level of detail.
 *
 * While some cells of a field are not read (`UNREAD_ALPHA_BYTE`, a gene read
 * for a sample of the open cells), the cells read are what the view is for:
 * a reduced level of detail, a uniform sample of every cell, would draw only
 * its share of them (a sample of 2,000 cells at a level of 1/8 would show
 * about 250). So the read cells are drawn from their own list of slots: an
 * element buffer, one 32-bit slot a read cell (local to its store segment),
 * in slot order, drawn with `drawElements` over the store's own vertex
 * arrays. Nothing is copied; `gl_VertexID` of an indexed draw is the slot,
 * so the shader finds a cell's transparency through the store's slot map as
 * in any other draw.
 *
 * The list follows the store's order (`StoreOrder`, a new one at every step
 * of an adoption), its segments and the colours (which cells are read); it
 * is made again when any of them changes.
 *
 * @module rendering/high-perf/read-cell-index
 */

import { UNREAD_ALPHA_BYTE } from '../alpha-visibility.js';
import { MAX_VERTICES_PER_DRAW } from '../gl-utils.js';

/**
 * The slots of the read cells of a store, local to their segments, in slot
 * order, and where each segment's begin.
 *
 * @param {Uint8Array} colors - RGBA8 in source order, the alpha byte the layer.
 * @param {Uint32Array|null} sources - The cell of each slot (`StoreOrder#slotSources`), or null (slot = cell).
 * @param {ReadonlyArray<{first: number, count: number}>} segments
 * @param {number} readCount - Cells not `UNREAD_ALPHA_BYTE`.
 * @returns {{slots: Uint32Array, starts: Uint32Array}} `starts[k]` is segment
 *   `k`'s first entry, `starts[segments.length]` the entry count.
 */
export function readCellSlots(colors, sources, segments, readCount) {
  const slots = new Uint32Array(readCount);
  const starts = new Uint32Array(segments.length + 1);
  let at = 0;
  for (let segment = 0; segment < segments.length; segment++) {
    starts[segment] = at;
    const { first, count } = segments[segment];
    for (let local = 0; local < count; local++) {
      const cell = sources === null ? first + local : sources[first + local];
      if (colors[cell * 4 + 3] !== UNREAD_ALPHA_BYTE) {
        if (at === readCount) throw new RangeError(`A store holds more than the ${readCount} read cells its colours name.`);
        slots[at++] = local;
      }
    }
  }
  if (at !== readCount) throw new RangeError(`A store holds ${at} of the ${readCount} read cells its colours name.`);
  starts[segments.length] = at;
  return { slots, starts };
}

export class ReadCellIndex {
  /** @param {WebGL2RenderingContext} gl */
  constructor(gl) {
    this.gl = gl;
    /** @type {WebGLBuffer|null} */
    this.buffer = null;
    this.byteLength = 0;
    /** @type {Uint32Array|null} */
    this.starts = null;
    // What the list was made for: the colours' layer record, the order, the segments.
    this._layers = null;
    this._order = undefined;
    this._segments = null;
  }

  /** The number of read cells listed. */
  get count() {
    return this.starts === null ? 0 : this.starts[this.starts.length - 1];
  }

  /**
   * Make the list current for a store, when what it was made for changed.
   *
   * @param {Object} store
   * @param {Uint8Array} store.colors
   * @param {Readonly<{layered: boolean, unread: number}>} store.layers - `colorLayersOf(colors)`, one record per colours generation.
   * @param {import('./store-order.js').StoreOrder|null} store.order
   * @param {ReadonlyArray<{first: number, count: number}>} store.segments
   * @param {(bytes: number, write: () => void) => void} store.allocate - Runs a GPU allocation (the renderer's `_allocateGpu`).
   * @returns {boolean} Whether it was made again.
   */
  update({ colors, layers, order, segments, allocate }) {
    if (this._layers === layers && this._order === order && this._segments === segments) return false;
    const gl = this.gl;
    const pointCount = colors.length >>> 2;
    const { slots, starts } = readCellSlots(colors, order === null ? null : order.slotSources(), segments, pointCount - layers.unread);
    if (this.buffer === null) {
      this.buffer = gl.createBuffer();
      if (!this.buffer) throw new Error('The read cells\' slot list could not create its buffer.');
    }
    // The default vertex array holds the binding, so no store's array changes.
    gl.bindVertexArray(null);
    try {
      if (slots.byteLength > this.byteLength) {
        // Storage for more slots: allocated (and its error read back) only
        // when the list outgrows it; a list that fits is written in place.
        allocate(slots.byteLength, () => {
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffer);
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, Math.max(4, slots.byteLength), gl.STATIC_DRAW);
        });
        this.byteLength = Math.max(4, slots.byteLength);
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffer);
      if (slots.length > 0) gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, slots);
    } finally {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    }
    this.starts = starts;
    this._layers = layers;
    this._order = order;
    this._segments = segments;
    return true;
  }

  /**
   * Draw every listed cell over `vertexArrays` (a `SegmentedVertexArray` of
   * the store the list was made for): one indexed draw a segment, after
   * `beforeSegment(segmentFirstSlot)`. Leaves no vertex array bound and no
   * element buffer in any.
   *
   * @param {import('./point-store-segments.js').SegmentedVertexArray} vertexArrays
   * @param {(segmentFirst: number) => void} beforeSegment
   * @returns {number} Draw calls issued.
   */
  draw(vertexArrays, beforeSegment) {
    const gl = this.gl;
    if (this.starts === null || vertexArrays.vaos.length !== this.starts.length - 1) {
      throw new Error('The read cells\' slot list was not made for the store drawn.');
    }
    let calls = 0;
    try {
      for (let segment = 0; segment < vertexArrays.vaos.length; segment++) {
        const begin = this.starts[segment];
        const end = this.starts[segment + 1];
        if (end === begin) continue;
        gl.bindVertexArray(vertexArrays.vaos[segment]);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffer);
        beforeSegment(vertexArrays.segments[segment].first);
        for (let offset = begin; offset < end; offset += MAX_VERTICES_PER_DRAW) {
          gl.drawElements(gl.POINTS, Math.min(MAX_VERTICES_PER_DRAW, end - offset), gl.UNSIGNED_INT, offset * 4);
          calls++;
        }
        // The vertex array keeps no element buffer: drawn arrays never read one.
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
      }
    } finally {
      gl.bindVertexArray(null);
    }
    return calls;
  }

  /** Release the buffer (the list is made again when next drawn). */
  delete() {
    if (this.buffer !== null) this.gl.deleteBuffer(this.buffer);
    this.buffer = null;
    this.byteLength = 0;
    this.starts = null;
    this._layers = null;
    this._order = undefined;
    this._segments = null;
  }
}
