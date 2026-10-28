/**
 * Point stores (`assets/js/rendering/high-perf/point-store-segments.js`) over
 * a fake WebGL context's buffers, for renderer tests that build a renderer
 * by hand: a store of one segment wrapping a buffer the test already made,
 * and the segmented vertex array drawn through it.
 */
import { PointStore, SegmentedVertexArray } from '../../assets/js/rendering/high-perf/point-store-segments.js';

/**
 * A one-segment store over `buffer`, holding `pointCount` points of
 * `bytesPerPoint` bytes (as a publication would have allocated it).
 */
export function pointStoreOver(gl, buffer, pointCount, bytesPerPoint) {
  const store = new PointStore(gl);
  store.segments = pointCount > 0 ? [{ buffer, first: 0, count: pointCount }] : [];
  store.pointCount = pointCount;
  store.bytesPerPoint = bytesPerPoint;
  bufferOf(store);
  return store;
}

/** The vertex arrays drawing `positions` (and `colors`) as a renderer binds them. */
export function vertexArrayOver(gl, positions, colors, dimension) {
  const vertexArray = new SegmentedVertexArray(gl);
  vertexArray.setStores(positions, colors, dimension);
  return vertexArray;
}

/** The buffers of a store (or the buffer itself, for a raw handle). */
export function buffersOf(store) {
  return store instanceof PointStore ? store.segments.map(segment => segment.buffer) : [store];
}

// The one buffer or VAO each one-segment store or vertex array held, so a
// test can still name it after it was deleted: recorded when a test first
// looks, and by deletion itself (the prototypes' `delete` is wrapped here,
// for the tests that import this helper).
const known = new WeakMap();
for (const [Type, handles] of [[PointStore, store => store.segments.map(segment => segment.buffer)], [SegmentedVertexArray, array => array.vaos]]) {
  const remove = Type.prototype.delete;
  Type.prototype.delete = function deleteRemembering() {
    const held = handles(this);
    if (held.length === 1 && !known.has(this)) known.set(this, held[0]);
    return remove.call(this);
  };
}

/** The one buffer of a one-segment store (also once it was deleted). */
export function bufferOf(store) {
  if (!(store instanceof PointStore)) return store;
  if (store.segments.length === 1) known.set(store, store.segments[0].buffer);
  if (known.has(store)) return known.get(store);
  throw new Error(`expected one segment, found ${store.segments.length}`);
}

/** The one VAO of a one-segment vertex array (or the VAO itself, for a raw handle). */
export function vaoOf(vertexArray) {
  if (!(vertexArray instanceof SegmentedVertexArray)) return vertexArray;
  if (vertexArray.vaos.length === 1) known.set(vertexArray, vertexArray.vaos[0]);
  if (known.has(vertexArray)) return known.get(vertexArray);
  throw new Error(`expected one segment VAO, found ${vertexArray.vaos.length}`);
}
