/**
 * Segmented per-point GPU stores.
 *
 * One WebGL buffer cannot hold every point of a large dataset: engines cap a
 * buffer by bytes (Chromium 2^31 - 2^21, Firefox 2^31 - 1, WebKit 2^32 - 1;
 * see `high-perf-renderer.js`, "Point streams"), so a 3-D position stream
 * (12 bytes a point) stops at 178.8M points on Chromium, and the D3D11
 * backend limits one resource further. A per-point store is therefore a list
 * of **segments**: consecutive runs of slots, each in its own buffer, every
 * segment but the last holding exactly `segmentPoints` slots. Slot `s` lives
 * in segment `floor(s / segmentPoints)` at local slot
 * `s - segment.first`. Whatever the point count, no buffer is larger than
 * one segment (192 MiB for 3-D positions at the default 2^24 points), so no
 * per-buffer cap binds and a refused allocation is one segment, not the
 * whole store.
 *
 * Drawing is unchanged by segmentation: draws execute in submission order,
 * so a slot range split at segment boundaries into consecutive draws
 * rasterizes the same points in the same order (`forEachSegmentRange`). A
 * shader that addresses per-slot data by `gl_VertexID` adds the segment's
 * first slot (`u_slotBase`), so it sees global slots.
 *
 * The default segment is the point draw's own split
 * (`MAX_VERTICES_PER_DRAW`), so one segment is one draw call on every
 * engine and a store of up to 16,777,216 points is one buffer, as before.
 * Tests force a small segment size to exercise the segmented path at sizes
 * that fit (`segmentPoints`).
 *
 * ## Growing a store (append)
 *
 * Segments make appending natural: a store grows by filling its last
 * segment and adding new ones; existing segments never move. To append
 * `m` points to a store of `n`:
 *
 *   1. `planStoreSegments(n + m, segmentPoints)` gives the new layout; every
 *      segment that ends at or before `n` is unchanged (`unchangedSegments`).
 *   2. The last old segment, when partial, is reallocated to its new size
 *      and its first slots copied over on the GPU (`copyBufferSubData`), or
 *      allocated at the full segment size up front when growth is expected,
 *      so an append only writes.
 *   3. New segments are allocated and the appended points written with
 *      `bufferSubData` (source order) or gathered (`GpuPermuter#writeWords`,
 *      which writes any segment list).
 *
 * A store kept in a draw order is appended to in source order only after
 * its order is rebuilt; a store in source order appends without touching
 * the slots it already holds.
 *
 * @module rendering/high-perf/point-store-segments
 */

import { MAX_VERTICES_PER_DRAW, releaseVertexAttribute } from '../gl-utils.js';
import { formatCount, formatCountOf } from '../../utils/format-units.js';

/** Slots one segment holds (every segment but the last). */
export const POINT_STORE_SEGMENT_POINTS = MAX_VERTICES_PER_DRAW;

/**
 * The segments of a store of `pointCount` slots: `{first, count}` runs,
 * consecutive, the last possibly partial. An empty store has no segments.
 *
 * @param {number} pointCount
 * @param {number} [segmentPoints=POINT_STORE_SEGMENT_POINTS]
 * @returns {ReadonlyArray<Readonly<{first: number, count: number}>>}
 */
export function planStoreSegments(pointCount, segmentPoints = POINT_STORE_SEGMENT_POINTS) {
  requireSegmentPoints(segmentPoints);
  if (!Number.isSafeInteger(pointCount) || pointCount < 0) {
    throw new RangeError(`A point store needs a non-negative slot count, not ${pointCount}.`);
  }
  const segments = [];
  for (let first = 0; first < pointCount; first += segmentPoints) {
    segments.push(Object.freeze({ first, count: Math.min(segmentPoints, pointCount - first) }));
  }
  return Object.freeze(segments);
}

/**
 * How many leading segments of a store of `oldCount` slots keep their size
 * when it grows to `newCount` (append, step 1): the full ones.
 *
 * @param {number} oldCount
 * @param {number} newCount
 * @param {number} [segmentPoints=POINT_STORE_SEGMENT_POINTS]
 * @returns {number}
 */
export function unchangedSegments(oldCount, newCount, segmentPoints = POINT_STORE_SEGMENT_POINTS) {
  requireSegmentPoints(segmentPoints);
  if (!(Number.isSafeInteger(oldCount) && Number.isSafeInteger(newCount) && oldCount >= 0 && newCount >= oldCount)) {
    throw new RangeError(`A point store grows from ${oldCount} to at least as many slots, not ${newCount}.`);
  }
  return Math.floor(oldCount / segmentPoints);
}

/**
 * Split the slot range `[first, first + count)` at segment boundaries and
 * visit each piece in slot order: `visit(segmentIndex, localFirst,
 * localCount)`. Segments are `planStoreSegments` runs (or any objects with
 * `first` and `count`).
 *
 * @param {ReadonlyArray<{first: number, count: number}>} segments
 * @param {number} first
 * @param {number} count
 * @param {(segmentIndex: number, localFirst: number, localCount: number) => void} visit
 * @returns {number} Pieces visited.
 */
export function forEachSegmentRange(segments, first, count, visit) {
  if (count <= 0) return 0;
  const end = first + count;
  // Every segment but the last holds the same count, so the first segment
  // of the range is found by division.
  const size = segments[0].count;
  let index = Math.min(segments.length - 1, Math.floor(first / size));
  let pieces = 0;
  for (; index < segments.length; index++) {
    const segment = segments[index];
    const segmentEnd = segment.first + segment.count;
    if (segmentEnd <= first) continue;
    if (segment.first >= end) break;
    const from = Math.max(first, segment.first);
    const to = Math.min(end, segmentEnd);
    visit(index, from - segment.first, to - from);
    pieces++;
  }
  return pieces;
}

/**
 * A store target as segments with their buffers: a `PointStore`, a list of
 * `{buffer, first, count}` (checked to be consecutive and to cover
 * `count` slots), or one buffer holding every slot.
 *
 * @param {PointStore|WebGLBuffer|ReadonlyArray<{buffer: WebGLBuffer, first: number, count: number}>} target
 * @param {number} count - The slots the store holds.
 * @returns {ReadonlyArray<{buffer: WebGLBuffer, first: number, count: number}>}
 */
export function requireStoreSegments(target, count) {
  if (target instanceof PointStore) return requireStoreSegments(target.segments, count);
  if (!Array.isArray(target)) {
    if (!target) throw new TypeError('A point store needs a buffer or a list of segments.');
    return [{ buffer: target, first: 0, count }];
  }
  let next = 0;
  for (const segment of target) {
    if (!segment?.buffer || segment.first !== next || !Number.isSafeInteger(segment.count) || segment.count <= 0) {
      throw new TypeError('A segmented point store needs consecutive {buffer, first, count} segments.');
    }
    next += segment.count;
  }
  if (next !== count) {
    throw new RangeError(`A segmented point store holds ${next} slots, not ${count}.`);
  }
  return target;
}

function requireSegmentPoints(segmentPoints) {
  if (!Number.isSafeInteger(segmentPoints) || segmentPoints <= 0) {
    throw new RangeError(`A point store segment holds a positive number of slots, not ${segmentPoints}.`);
  }
}

/**
 * A per-point vertex store: one GL buffer a segment. Its methods leave no
 * `ARRAY_BUFFER` bound, as the renderer's own uploads do. It stands where a
 * single `WebGLBuffer` stood for the renderer's point streams (positions,
 * colours, highlight words), so the ownership code that moves, lends and
 * retires stores handles it as one object (`deleteGlObject` deletes every
 * segment's buffer).
 */
export class PointStore {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {number} [segmentPoints=POINT_STORE_SEGMENT_POINTS]
   */
  constructor(gl, segmentPoints = POINT_STORE_SEGMENT_POINTS) {
    requireSegmentPoints(segmentPoints);
    this.gl = gl;
    this.segmentPoints = segmentPoints;
    /** @type {Array<{buffer: WebGLBuffer, first: number, count: number}>} */
    this.segments = [];
    this.pointCount = 0;
    this.bytesPerPoint = 0;
    this.deleted = false;
  }

  /** Bytes of every segment together. */
  get byteLength() {
    return this.pointCount * this.bytesPerPoint;
  }

  /**
   * (Re)allocate the store for `pointCount` points of `bytesPerPoint` bytes,
   * every segment's storage made by `allocate(refusal, run)` (the renderer's
   * `_allocateGpu`, which reads the error back and retries a refusal for
   * memory). With `data` (a typed array of exactly those bytes) each segment
   * is made holding its share. Segments of the previous layout that do not
   * fit the new one are deleted. A refusal leaves the buffers made so far in
   * the store (its point count 0), for its owner to retire with it.
   *
   * @param {number} pointCount
   * @param {number} bytesPerPoint
   * @param {number} usage
   * @param {(refusal: string, run: () => void) => void} allocate
   * @param {string} refusal - Names the store in a refused allocation.
   * @param {ArrayBufferView|null} [data]
   * @returns {number} The store's byte length.
   */
  allocate(pointCount, bytesPerPoint, usage, allocate, refusal, data = null) {
    const gl = this.gl;
    if (data !== null && data.byteLength !== pointCount * bytesPerPoint) {
      throw new RangeError(`${refusal}: the data holds ${formatCountOf(data.byteLength, 'byte')}, not ${formatCount(pointCount * bytesPerPoint)}.`);
    }
    const plan = planStoreSegments(pointCount, this.segmentPoints);
    const kept = this.segments;
    this.segments = [];
    this.pointCount = 0;
    this.bytesPerPoint = bytesPerPoint;
    try {
      for (let index = 0; index < plan.length; index++) {
        const { first, count } = plan[index];
        const buffer = index < kept.length ? kept[index].buffer : gl.createBuffer();
        if (index < kept.length) kept[index] = null;
        if (!buffer) throw new Error(`${refusal}: no buffer could be created.`);
        this.segments.push({ buffer, first, count });
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        const bytes = count * bytesPerPoint;
        allocate(`${refusal} (segment ${index + 1} of ${plan.length}, ${formatCountOf(bytes, 'byte')})`, () => {
          if (data === null) {
            gl.bufferData(gl.ARRAY_BUFFER, bytes, usage);
          } else {
            const elements = bytesPerPoint / data.BYTES_PER_ELEMENT;
            gl.bufferData(gl.ARRAY_BUFFER, data, usage, first * elements, count * elements);
          }
        });
      }
      this.pointCount = pointCount;
    } finally {
      for (const segment of kept) if (segment !== null) gl.deleteBuffer(segment.buffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    return this.byteLength;
  }

  /**
   * Give the store `pointCount` slots, keeping the bytes of every slot it
   * holds below both counts (cells added or removed in place, see the module
   * comment, "Growing a store"). Segments whose size does not change are
   * kept as they are; the one segment that changes size (the old last one,
   * when partial, or the new last one) is made anew and its kept slots copied
   * over on the GPU (`copyBufferSubData`); segments past the new count are
   * deleted, new ones allocated (empty: the caller writes the new slots). A
   * refusal deletes what this call made and leaves the store as it was.
   *
   * @param {number} pointCount
   * @param {number} usage
   * @param {(refusal: string, run: () => void) => void} allocate - As for `allocate`.
   * @param {string} refusal
   * @returns {number} The store's byte length.
   */
  resize(pointCount, usage, allocate, refusal) {
    const gl = this.gl;
    const bytesPerPoint = this.bytesPerPoint;
    if (!(bytesPerPoint > 0)) throw new Error(`${refusal}: a store is allocated before it is resized.`);
    const plan = planStoreSegments(pointCount, this.segmentPoints);
    const old = this.segments;
    const next = [];
    const made = [];
    try {
      for (let index = 0; index < plan.length; index++) {
        const { first, count } = plan[index];
        const previous = old[index] ?? null;
        if (previous !== null && previous.count === count) {
          next.push(previous);
          continue;
        }
        const buffer = gl.createBuffer();
        if (!buffer) throw new Error(`${refusal}: no buffer could be created.`);
        made.push(buffer);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        const bytes = count * bytesPerPoint;
        allocate(`${refusal} (segment ${index + 1} of ${plan.length}, ${formatCountOf(bytes, 'byte')})`, () => {
          gl.bufferData(gl.ARRAY_BUFFER, bytes, usage);
        });
        if (previous !== null) {
          gl.bindBuffer(gl.COPY_READ_BUFFER, previous.buffer);
          gl.bindBuffer(gl.COPY_WRITE_BUFFER, buffer);
          gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, Math.min(previous.count, count) * bytesPerPoint);
          gl.bindBuffer(gl.COPY_READ_BUFFER, null);
          gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
        }
        next.push({ buffer, first, count });
      }
    } catch (error) {
      for (const buffer of made) gl.deleteBuffer(buffer);
      throw error;
    } finally {
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    const kept = new Set(next.map(segment => segment.buffer));
    for (const segment of old) if (!kept.has(segment.buffer)) gl.deleteBuffer(segment.buffer);
    this.segments = next;
    this.pointCount = pointCount;
    return this.byteLength;
  }

  /**
   * Write `data` (a typed array of whole points) into the store from point
   * `firstPoint`, one `bufferSubData` a segment it covers.
   *
   * @param {ArrayBufferView} data
   * @param {number} [firstPoint=0]
   */
  write(data, firstPoint = 0) {
    const gl = this.gl;
    const elements = this.bytesPerPoint / data.BYTES_PER_ELEMENT;
    const points = data.length / elements;
    if (!Number.isInteger(points) || firstPoint < 0 || firstPoint + points > this.pointCount) {
      throw new RangeError(`A point store of ${formatCountOf(this.pointCount, 'point')} cannot take ${formatCountOf(data.length, 'element')} at point ${firstPoint}.`);
    }
    try {
      forEachSegmentRange(this.segments, firstPoint, points, (index, localFirst, localCount) => {
        const segment = this.segments[index];
        gl.bindBuffer(gl.ARRAY_BUFFER, segment.buffer);
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          localFirst * this.bytesPerPoint,
          data,
          (segment.first + localFirst - firstPoint) * elements,
          localCount * elements
        );
      });
    } finally {
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  }

  /**
   * Read the store back into `out` (a typed array of whole points, from
   * point 0): tests and diagnostics only (`getBufferSubData` waits for the
   * GPU).
   *
   * @param {ArrayBufferView} out
   * @returns {ArrayBufferView} `out`
   */
  read(out) {
    const gl = this.gl;
    const elements = this.bytesPerPoint / out.BYTES_PER_ELEMENT;
    try {
      for (const segment of this.segments) {
        const count = Math.min(segment.count, out.length / elements - segment.first);
        if (count <= 0) break;
        gl.bindBuffer(gl.ARRAY_BUFFER, segment.buffer);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, out, segment.first * elements, count * elements);
      }
    } finally {
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    return out;
  }

  /**
   * Delete every segment's buffer. A deletion that throws leaves the
   * segments not yet deleted in place, so a retry deletes exactly those.
   */
  delete() {
    while (this.segments.length > 0) {
      this.gl.deleteBuffer(this.segments[this.segments.length - 1].buffer);
      this.segments.pop();
    }
    this.pointCount = 0;
    this.deleted = true;
  }
}

/**
 * The vertex arrays a segmented point store is drawn through (binding them
 * leaves no VAO and no `ARRAY_BUFFER` bound): one VAO a
 * segment, each binding that segment's position stream at attribute 0
 * (`dimension` Float32 components, read as a `vec3`), its colour stream at
 * attribute 1 (RGBA8, normalized) when there is one, and any further
 * per-point streams the caller binds (`bindStream`). It stands where one
 * `WebGLVertexArrayObject` stood (`deleteGlObject` deletes every VAO).
 */
export class SegmentedVertexArray {
  /** @param {WebGL2RenderingContext} gl */
  constructor(gl) {
    this.gl = gl;
    /** @type {WebGLVertexArrayObject[]} */
    this.vaos = [];
    /** @type {ReadonlyArray<{first: number, count: number}>} */
    this.segments = [];
    // Each VAO's position buffer: its colour attribute is released onto it
    // (`releaseVertexAttribute`), a buffer the VAO holds already.
    /** @type {WebGLBuffer[]} */
    this.positionBuffers = [];
    this.deleted = false;
  }

  /**
   * Bind `positions` (and `colors`, a store with the same segments, or
   * null) into one VAO a segment, making or deleting VAOs to match.
   *
   * @param {PointStore} positions
   * @param {PointStore|null} colors
   * @param {number} dimension - Float32 components a position (1, 2 or 3).
   */
  setStores(positions, colors, dimension) {
    const gl = this.gl;
    requireMatchingSegments(positions, colors);
    while (this.vaos.length > positions.segments.length) gl.deleteVertexArray(this.vaos.pop());
    while (this.vaos.length < positions.segments.length) {
      const vao = gl.createVertexArray();
      if (!vao) throw new Error('A point store could not create its vertex array.');
      this.vaos.push(vao);
    }
    this.segments = positions.segments.map(({ first, count }) => ({ first, count }));
    this.positionBuffers = positions.segments.map(segment => segment.buffer);
    try {
      for (let index = 0; index < this.vaos.length; index++) {
        gl.bindVertexArray(this.vaos[index]);
        gl.bindBuffer(gl.ARRAY_BUFFER, positions.segments[index].buffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, dimension, gl.FLOAT, false, dimension * 4, 0);
        bindColorAttribute(gl, colors === null ? null : colors.segments[index].buffer, this.positionBuffers[index]);
      }
    } finally {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  }

  /**
   * Re-point attribute 1 of every segment's VAO at `colors` (null: off).
   *
   * @param {PointStore|null} colors
   */
  setColors(colors) {
    const gl = this.gl;
    if (colors !== null && colors.segments.length !== this.vaos.length) {
      throw new RangeError('A colour store must have the segments of the positions it is drawn with.');
    }
    try {
      for (let index = 0; index < this.vaos.length; index++) {
        gl.bindVertexArray(this.vaos[index]);
        bindColorAttribute(gl, colors === null ? null : colors.segments[index].buffer, this.positionBuffers[index]);
      }
    } finally {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  }

  /**
   * Draw slots `[first, first + count)`: one draw a segment the range
   * covers, in slot order, after `beforeSegment(segmentFirstSlot)` (which
   * sets the shader's slot base). Leaves no VAO bound.
   *
   * @param {number} first
   * @param {number} count
   * @param {(segmentFirst: number) => void} beforeSegment
   * @param {(gl: WebGL2RenderingContext, first: number, count: number) => number} drawRange
   * @returns {number} Draw calls issued.
   */
  drawRange(first, count, beforeSegment, drawRange) {
    const gl = this.gl;
    let calls = 0;
    try {
      forEachSegmentRange(this.segments, first, count, (index, localFirst, localCount) => {
        gl.bindVertexArray(this.vaos[index]);
        beforeSegment(this.segments[index].first);
        calls += drawRange(gl, localFirst, localCount);
      });
    } finally {
      // No segment's VAO stays bound: a store it references must be free to
      // be written by transform feedback (WebGL refuses a buffer bound for
      // it that is also bound elsewhere).
      gl.bindVertexArray(null);
    }
    return calls;
  }

  /** Delete every VAO (a deletion that throws leaves the rest for a retry). */
  delete() {
    while (this.vaos.length > 0) {
      this.gl.deleteVertexArray(this.vaos[this.vaos.length - 1]);
      this.vaos.pop();
    }
    this.segments = [];
    this.positionBuffers = [];
    this.deleted = true;
  }
}

/**
 * Ranges `starts`/`counts` (global slots, ascending and disjoint) split at
 * segment boundaries into each segment's local ranges, written into
 * `out.starts`/`out.counts` per segment: `visit(segmentIndex, starts,
 * counts, rangeCount)` once for every segment with at least one range, in
 * slot order. The scratch arrays are grown as needed and reused.
 *
 * @param {ReadonlyArray<{first: number, count: number}>} segments
 * @param {Int32Array} starts
 * @param {Int32Array} counts
 * @param {number} rangeCount
 * @param {{starts?: Int32Array, counts?: Int32Array}} out - Scratch.
 * @param {(segmentIndex: number, starts: Int32Array, counts: Int32Array, rangeCount: number) => void} visit
 */
export function splitRangesBySegment(segments, starts, counts, rangeCount, out, visit) {
  const capacity = rangeCount + segments.length;
  if (!(out.starts instanceof Int32Array) || out.starts.length < capacity) {
    out.starts = new Int32Array(capacity);
    out.counts = new Int32Array(capacity);
  }
  let current = -1;
  let written = 0;
  const flush = () => {
    if (current >= 0 && written > 0) visit(current, out.starts, out.counts, written);
    written = 0;
  };
  for (let range = 0; range < rangeCount; range++) {
    forEachSegmentRange(segments, starts[range], counts[range], (index, localFirst, localCount) => {
      if (index !== current) {
        flush();
        current = index;
      }
      out.starts[written] = localFirst;
      out.counts[written] = localCount;
      written++;
    });
  }
  flush();
}

function bindColorAttribute(gl, buffer, positionBuffer) {
  if (buffer === null) {
    // A vertex array keeps a deleted buffer alive while it references it:
    // the colour attribute lets go of the old store by reading the VAO's own
    // position buffer, disabled.
    releaseVertexAttribute(gl, 1, positionBuffer);
    return;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 4, 0);
}

function requireMatchingSegments(positions, colors) {
  if (!(positions instanceof PointStore)) {
    throw new TypeError('A segmented vertex array needs a position store.');
  }
  if (colors === null) return;
  if (!(colors instanceof PointStore) || colors.segments.length !== positions.segments.length
    || colors.segments.some((segment, index) => segment.count !== positions.segments[index].count)) {
    throw new RangeError('A colour store must have the segments of the positions it is drawn with.');
  }
}
