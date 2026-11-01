/**
 * GPU gather of vertex stores into a geometry's draw order.
 *
 * A point store's positions and colours are kept in its tree's draw order
 * (see `SpatialIndex#drawOrder`), while they are published in source order.
 * Gathering them on the CPU reads the source at random, which costs hundreds
 * of milliseconds at millions of points. Here the source words go into a
 * transient R32UI linear texture (`../linear-texture.js`), one texel a word,
 * as they are (the same bytes a source-order store uploads), and one
 * transform-feedback pass writes
 * each stored slot's words, fetched through the draw order's R32UI
 * permutation texture, into the target store. Words are copied bit for bit,
 * so float positions come out exact.
 *
 * When the source-order words are already in a GPU buffer (a store that
 * still holds its source order, gathered in place), the source texture is
 * drawn from that buffer instead of uploaded: one point a word, each at its
 * own texel, into the texture as an R32UI colour attachment
 * (`_drawSource`). The copy stays on the GPU and the page uploads nothing
 * (10M 3-D positions are 120 MB). An upload from the buffer bound as
 * `PIXEL_UNPACK_BUFFER` would be the obvious copy, but Firefox on macOS
 * warns on every such upload ("can incur extra overhead") and splits it.
 *
 * Bounded transient memory, at any point count. A gather of more points
 * than one chunk (`GATHER_CHUNK_POINTS`) never holds the whole source on the
 * GPU: the source is uploaded one chunk of points at a time from page
 * memory, and every target range of at most a chunk of slots takes, in each
 * pass, the words of the slots whose source point lies in that chunk; the
 * other slots keep what the earlier chunks wrote (read back as a vertex
 * attribute from the target, written to a chunk-sized scratch store, then
 * copied over the range on the GPU, since a pass cannot read the buffer it
 * writes). The transient memory is then one chunk-sized source texture and
 * one chunk-sized scratch store, whatever the count: at 100M 3-D points,
 * 2 x 192 MiB instead of a 1.2 GB source texture beside the 1.2 GB store
 * (which is what kept a 100M-point 3-D store from adopting its draw order).
 * Up to one chunk the gather is the single pass described above.
 *
 * A target is one buffer holding every slot, or a segmented store
 * (`point-store-segments.js`): a list of buffers, each holding a run of
 * consecutive slots. Each segment is written in place.
 *
 * Outputs:
 * - `writeWords`: 1, 2 or 3 32-bit words a point -- RGBA8 colours (1), or
 *   x / xy / xyz Float32 positions (1-3).
 *
 * The pass leaves every binding it touches as it found it, and releases the
 * attributes it pointed at a store onto its own anchor buffer
 * (`releaseVertexAttribute`), so its vertex arrays never hold a store a
 * later pass writes.
 *
 * Errors are read once a chunk (once a write up to `GATHER_CHUNK_POINTS`
 * points), after its passes and before the next chunk allocates: a pass
 * that fails is never a silent no-op, and its error never reaches the next
 * allocation's check under that allocation's name. A write whose passes
 * raised an error is run once more with every call checked, so the error
 * names the call, the pass and the segment that raised it. A write made
 * often (highlight words, a band of a draw order adopted a frame at a time)
 * passes `onError` instead: its last chunk is checked in a later frame,
 * once the GPU has run it (`deferWebGLErrorCheck`), so the read waits for
 * nothing, and a failure reaches `onError` named the same way.
 */

import {
  MAX_VERTICES_PER_DRAW,
  deleteProgramReleasingUse,
  deleteTextureTracked,
  drawPointsInSegments,
  releaseVertexAttribute,
  restorableTexture,
} from '../gl-utils.js';
import {
  cancelDeferredWebGLErrorChecks,
  claimWebGLErrorForDeferredChecks,
  contextLostError,
  deferWebGLErrorCheck,
  describeWebGLError,
  drainWebGLErrors,
} from '../gl-errors.js';
import { glStateOf } from '../gl-state-shadow.js';
import { formatCountOf } from '../../utils/format-units.js';
import { PointStore, forEachSegmentRange, requireStoreSegments } from './point-store-segments.js';
import {
  LINEAR_TEXEL_GLSL,
  allocateLinearTexture,
  planLinearTextureFor,
  setLinearLayoutUniform,
  writeLinearTextureItems,
  writeLinearTextureRows,
} from '../linear-texture.js';

/**
 * Source points one gather pass reads, and target slots one pass writes: the
 * bound on the gather's transient GPU memory (see the module comment). It is
 * the point draw's own split (`MAX_VERTICES_PER_DRAW`), so one pass is one
 * draw call on every engine.
 */
export const GATHER_CHUNK_POINTS = MAX_VERTICES_PER_DRAW;

const VS_HEAD = `#version 300 es
precision highp int;
precision highp float;
uniform highp usampler2DArray u_source;
uniform ivec2 u_sourceLayout;
uniform highp usampler2DArray u_order;
uniform ivec2 u_orderLayout;
// Slots below it are read through the order's slot map; every later slot
// holds its own source point (rendering/high-perf/store-order.js). 0: no order.
uniform int u_orderedSlots;
// The first slot this pass writes (vertex 0), and the source points the
// source texture holds, [u_sourceBase, u_sourceEnd).
uniform int u_slotBase;
uniform int u_sourceBase;
uniform int u_sourceEnd;
// One per-instance zero word: attribute 0 is active and backed by an array,
// so no engine emulates it (Firefox on desktop OpenGL builds a vertex-count
// array for a disabled attribute 0).
layout(location = 0) in highp uint a_anchor;
${LINEAR_TEXEL_GLSL}
// The source point stored at slot.
int sourcePoint(int slot) {
  if (slot >= u_orderedSlots) return slot;
  return int(texelFetch(u_order, linearTexel(slot, u_orderLayout), 0).r);
}

// One source word: the source is one R32UI texel a word, from the chunk's
// first point.
uint wordAt(int index) {
  return texelFetch(u_source, linearTexel(index, u_sourceLayout), 0).r;
}
`;

const POINT_TAIL = `
  v_words += a_anchor;
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

// A slot whose source point is outside this pass's chunk keeps the words an
// earlier chunk wrote (`a_prev`, the target's words; 0 on the first chunk).
const wordProgram = (type, read) => `${VS_HEAD}layout(location = 1) in highp ${type} a_prev;
flat out highp ${type} v_words;
void main() {
  int point = sourcePoint(u_slotBase + gl_VertexID);
  if (point >= u_sourceBase && point < u_sourceEnd) {
    int base = (point - u_sourceBase) * ${type === 'uint' ? 1 : Number(type.slice(-1))};
    v_words = ${read};
  } else {
    v_words = a_prev;
  }${POINT_TAIL}`;

const WORD_VS = {
  1: wordProgram('uint', 'wordAt(base)'),
  2: wordProgram('uvec2', 'uvec2(wordAt(base), wordAt(base + 1))'),
  3: wordProgram('uvec3', 'uvec3(wordAt(base), wordAt(base + 1), wordAt(base + 2))'),
};

// The highlight colour word of every slot of a point store: the cell at the
// slot is admitted when its highlight byte is at least u_minHighlight and it
// is shown (visibility byte 1); its word is the RGBA8 bytes (255, 255, 255,
// highlight), HighlightRenderer's colour word; any other slot gets 0 (alpha
// 0, which HP_VS_HIGHLIGHT rejects before rasterisation).
WORD_VS.highlight = `${VS_HEAD}uniform highp usampler2DArray u_highlight;
uniform ivec2 u_highlightLayout;
uniform highp usampler2DArray u_visible;
uniform ivec2 u_visibleLayout;
uniform uint u_minHighlight;
flat out highp uint v_words;
void main() {
  int point = sourcePoint(u_slotBase + gl_VertexID);
  uint highlight = texelFetch(u_highlight, linearTexel(point, u_highlightLayout), 0).r;
  uint visible = texelFetch(u_visible, linearTexel(point, u_visibleLayout), 0).r;
  v_words = (highlight >= u_minHighlight && visible >= 1u) ? (0x00ffffffu | (highlight << 24)) : 0u;${POINT_TAIL}`;

// One source word a point, drawn to its texel of a linear texture's layer
// (\`_drawSource\`): the word's index is the segment's first word plus the
// vertex id, its texel the linear texture's, at the texel's centre.
const SOURCE_DRAW_VS = `#version 300 es
precision highp int;
precision highp float;
layout(location = 0) in highp uint a_word;
uniform ivec2 u_shape;
uniform vec2 u_size;
uniform int u_base;
flat out highp uint v_word;
${LINEAR_TEXEL_GLSL}
void main() {
  ivec3 texel = linearTexel(u_base + gl_VertexID, u_shape);
  gl_Position = vec4(
    (float(texel.x) + 0.5) / u_size.x * 2.0 - 1.0,
    (float(texel.y) + 0.5) / u_size.y * 2.0 - 1.0,
    0.0,
    1.0
  );
  gl_PointSize = 1.0;
  v_word = a_word;
}
`;

const SOURCE_DRAW_FS = `#version 300 es
precision highp int;
precision highp float;
flat in highp uint v_word;
layout(location = 0) out highp uvec4 outWord;
void main() {
  outWord = uvec4(v_word, 0u, 0u, 0u);
}
`;

const DISCARD_FS = `#version 300 es
precision lowp float;
out vec4 outColor;
void main() {
  outColor = vec4(0.0);
}
`;

const UNIFORMS = [
  'u_source', 'u_sourceLayout', 'u_order', 'u_orderLayout', 'u_orderedSlots',
  'u_slotBase', 'u_sourceBase', 'u_sourceEnd',
  'u_highlight', 'u_highlightLayout', 'u_visible', 'u_visibleLayout', 'u_minHighlight',
];
const PROGRAM_KINDS = ['w1', 'w2', 'w3', 'highlight'];

/**
 * Lazily compiled transform-feedback programs plus the objects one pass
 * binds. One per renderer and GL context.
 */
export class GpuPermuter {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {(refusal: string, allocate: () => void) => void} [allocateGpu] -
   *   Runs one allocation and reports a refusal (the renderer's
   *   `_allocateGpu`, which releases memory kept only for speed and retries).
   * @param {{chunkPoints?: number}} [options] - `chunkPoints`: points a pass
   *   gathers (`GATHER_CHUNK_POINTS`); tests force a small one to exercise
   *   the chunked gather at sizes that fit.
   */
  constructor(gl, allocateGpu = null, { chunkPoints = GATHER_CHUNK_POINTS } = {}) {
    if (!Number.isSafeInteger(chunkPoints) || chunkPoints <= 0 || chunkPoints > MAX_VERTICES_PER_DRAW) {
      throw new RangeError(`GPU permute chunks hold 1 to ${MAX_VERTICES_PER_DRAW} points, not ${chunkPoints}.`);
    }
    this.gl = gl;
    this._allocateGpu = allocateGpu;
    this._chunkPoints = chunkPoints;
    this._programs = {};
    this._uniforms = {};
    this._vao = null;
    this._anchor = null;
    this._feedback = null;
    this._dummyOrder = null;
    // The source drawn from a buffer (`_drawSource`), made on first use.
    this._sourceDraw = null;
    // Programs `prewarm` started, linked when first used.
    this._started = {};
    // The source texture range writes reuse (`holdRangeSource`), or null.
    this._rangeSource = null;
    // The write being run again call by call to name a failed call
    // (`_checkedWrite`), else null.
    this._callCheck = null;
    // Whether the write running checks its last chunk later (`onError`).
    this._deferRead = false;
  }

  /**
   * Write `wordsPerPoint` 32-bit words a point into `target` (sized for
   * them), slot `s` taking the source point `order[s]`.
   *
   * Up to `GATHER_CHUNK_POINTS` points this is one pass over one source
   * texture. Above it the source is read one chunk at a time from page
   * memory (see the module comment), so the source must be there: a GPU
   * source names its page copy as `page`.
   *
   * @param {PointStore|WebGLBuffer|ReadonlyArray<{buffer: WebGLBuffer, first: number, count: number}>} target -
   *   A segmented store (`point-store-segments.js`), its segments, or one buffer.
   * @param {Uint32Array|{buffer: WebGLBuffer|ReadonlyArray<object>, words: number, page?: Uint32Array}} source -
   *   Source-order words: in page memory, or the first `words` words of a
   *   GPU store (`target` itself for a gather in place), with the same
   *   words in page memory as `page`.
   * @param {{texture: WebGLTexture, plan: object}} order - A linear R32UI texture.
   * @param {1|2|3} wordsPerPoint
   */
  writeWords(target, source, order, wordsPerPoint) {
    requireOrder(order);
    if (!WORD_VS[wordsPerPoint]) {
      throw new RangeError(`GPU permute writes 1, 2 or 3 words a point, not ${wordsPerPoint}.`);
    }
    const words = ArrayBuffer.isView(source) ? source.length : requireBufferSource(source);
    const count = words / wordsPerPoint;
    const ranges = targetRanges(requireStoreSegments(target, count), wordsPerPoint, this._chunkPoints);
    const chunk = this._chunkPoints;
    const what = `GPU permute write of ${formatCountOf(count, 'point')} (${formatCountOf(wordsPerPoint, 'word')} a point)`;
    if (count <= chunk) {
      this._checkedWrite(what, () => this._gatherChunk(wordsPerPoint, ranges, order, source, 0, count, null));
      return;
    }
    const page = ArrayBuffer.isView(source) ? source : source.page;
    if (!(page instanceof Uint32Array) || page.length !== words) {
      throw new TypeError(
        `GPU permute gathers more than ${formatCountOf(chunk, 'point')} from page memory, one chunk at a time; the source words must be given there.`
      );
    }
    this._checkedWrite(what, () => this._withScratch(ranges, scratch => {
      for (let first = 0; first < count; first += chunk) {
        const end = Math.min(count, first + chunk);
        this._gatherChunk(
          wordsPerPoint, ranges, order,
          page.subarray(first * wordsPerPoint, end * wordsPerPoint),
          first, end, first > 0 ? scratch : null
        );
      }
    }));
  }

  /**
   * Write slots `[firstSlot, endSlot)` of `target` (the rest untouched),
   * slot `s` taking the source point `order`'s map gives it, which must lie
   * in `[firstSlot, endSlot)` too: one band of a store taking a draw order
   * band by band (`store-order.js`), whose cells are its own ranks. `source`
   * holds the words of exactly those points, in page memory; it is gathered
   * one chunk of points at a time (`GATHER_CHUNK_POINTS`), so the transient
   * memory is one chunk whatever the band.
   *
   * @param {PointStore|ReadonlyArray<{buffer: WebGLBuffer, first: number, count: number}>} target
   * @param {number} firstSlot
   * @param {number} endSlot
   * @param {Uint32Array} source - `(endSlot - firstSlot) * wordsPerPoint` words.
   * @param {{texture: WebGLTexture, plan: object, orderedSlots?: number}} order
   * @param {1|2|3} wordsPerPoint
   * @param {{onError?: ((error: Error) => void)|null, readAfter?: (() => boolean)|null}} [options] - `onError`:
   *   check the write in a later frame instead of now (see the module
   *   comment), and report a failure there; `readAfter`: not before it
   *   answers true (`deferWebGLErrorCheck`).
   */
  writeWordsRange(target, firstSlot, endSlot, source, order, wordsPerPoint, { onError = null, readAfter = null } = {}) {
    requireOrder(order);
    if (!WORD_VS[wordsPerPoint]) {
      throw new RangeError(`GPU permute writes 1, 2 or 3 words a point, not ${wordsPerPoint}.`);
    }
    const segments = target instanceof PointStore ? target.segments : target;
    const slots = segments.reduce((sum, segment) => sum + segment.count, 0);
    if (!(Number.isSafeInteger(firstSlot) && Number.isSafeInteger(endSlot) && firstSlot >= 0 && endSlot >= firstSlot && endSlot <= slots)) {
      throw new RangeError(`GPU permute writes slots [${firstSlot}, ${endSlot}) of a store of ${formatCountOf(slots, 'slot')}.`);
    }
    const fromStore = !ArrayBuffer.isView(source);
    if (fromStore
      ? !(source?.buffer && endSlot - firstSlot <= this._chunkPoints)
      : !(source instanceof Uint32Array) || source.length !== (endSlot - firstSlot) * wordsPerPoint) {
      throw new TypeError(`GPU permute needs the ${formatCountOf((endSlot - firstSlot) * wordsPerPoint, 'word')} of the points it gathers, in page memory or (up to a chunk) in the store itself.`);
    }
    if (endSlot === firstSlot) return;
    const ranges = targetRanges(requireStoreSegments(target, slots), wordsPerPoint, this._chunkPoints, firstSlot, endSlot);
    const chunk = this._chunkPoints;
    const what = `GPU permute write of slots [${firstSlot}, ${endSlot}) (${formatCountOf(wordsPerPoint, 'word')} a point)`;
    if (fromStore) {
      // The band's own slots, still in rank order, copied on the GPU into the
      // source texture before the pass writes them (one chunk: one pass), so
      // the page uploads nothing.
      // Its source is its own target: run again it would gather words it
      // already gathered, so a deferred check never runs it again.
      this._checkedWrite(what, () => this._gatherChunk(wordsPerPoint, ranges, order, {
        buffer: source.buffer,
        words: (endSlot - firstSlot) * wordsPerPoint,
        firstWord: firstSlot * wordsPerPoint,
        wordsPerPoint,
      }, firstSlot, endSlot, null), { onError, inputs: null, readAfter });
      return;
    }
    const gather = scratch => {
      for (let first = firstSlot; first < endSlot; first += chunk) {
        const end = Math.min(endSlot, first + chunk);
        this._gatherChunk(
          wordsPerPoint, ranges, order,
          source.subarray((first - firstSlot) * wordsPerPoint, (end - firstSlot) * wordsPerPoint),
          first, end, first > firstSlot ? scratch : null
        );
      }
    };
    this._checkedWrite(what, () => (endSlot - firstSlot > chunk ? this._withScratch(ranges, gather) : gather(null)), {
      onError,
      readAfter,
      inputs: [...ranges.map(range => range.buffer), order.texture],
    });
  }

  /**
   * Run `gather(scratch)` with one scratch store sized for the largest
   * target range, made for the whole write (not per chunk) and deleted after.
   * @private
   */
  _withScratch(ranges, gather) {
    const gl = this.gl;
    let scratchBytes = 0;
    for (const range of ranges) scratchBytes = Math.max(scratchBytes, range.byteLength);
    const scratch = gl.createBuffer();
    if (!scratch) throw new Error('GPU permute could not allocate its scratch store.');
    try {
      const arrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
      gl.bindBuffer(gl.ARRAY_BUFFER, scratch);
      try {
        this._allocate('GPU permute could not allocate its scratch store', () => {
          gl.bufferData(gl.ARRAY_BUFFER, scratchBytes, gl.STREAM_COPY);
        });
      } finally {
        gl.bindBuffer(gl.ARRAY_BUFFER, arrayBuffer);
      }
      gather(scratch);
    } finally {
      gl.deleteBuffer(scratch);
    }
  }

  /**
   * Run one write (`write`), whose passes read the error queue once a chunk
   * (`_run`). When they raised an error the write is run once more with
   * every call of every pass checked (`_diagnose`), so the error thrown names
   * the call; the target's words are undefined after a failure either way.
   * An error its own calls did not raise goes to the checks deferred before
   * it (`claimWebGLErrorForDeferredChecks`), when there are any.
   *
   * With `onError`, the last chunk is checked in a later frame
   * (`deferWebGLErrorCheck`), run again call by call only while every buffer
   * and texture of `inputs` is alive (`inputs` null: never, a write whose
   * source is its own target).
   * @private
   */
  _checkedWrite(what, write, { onError = null, inputs = [], readAfter = null } = {}) {
    const gl = this.gl;
    let failure;
    this._deferRead = onError !== null;
    try {
      write();
    } catch (error) {
      if (!(error instanceof PassError)) throw error;
      failure = error;
    } finally {
      this._deferRead = false;
    }
    if (failure === undefined) {
      if (onError !== null) {
        deferWebGLErrorCheck(gl, {
          label: what,
          owner: this,
          onError,
          ...(readAfter === null ? {} : { readAfter }),
          diagnose: () => (inputs !== null && inputs.every(object => isAlive(gl, object))
            ? this._diagnose(what, write)
            : false),
        });
      }
      return;
    }
    if (typeof gl.isContextLost === 'function' && gl.isContextLost()) throw contextLostError(what);
    // Whatever else the failed passes raised.
    drainWebGLErrors(gl);
    this._diagnose(what, write);
    if (claimWebGLErrorForDeferredChecks(gl, failure.code)) return;
    throw new Error(
      `${what}: its passes raised WebGL error ${describeWebGLError(gl, failure.code)}, `
        + 'and run again with every call checked none raised it: an earlier call left it pending.'
    );
  }

  /**
   * Run `write` again with every call of every pass checked: throws an error
   * naming the call that fails, and returns when none does.
   * @private
   */
  _diagnose(what, write) {
    this._callCheck = what;
    try {
      write();
    } catch (error) {
      if (!(error instanceof PassError)) throw error;
    } finally {
      this._callCheck = null;
      // What the failed call's clean-up raised (an end after a refused begin).
      drainWebGLErrors(this.gl);
    }
  }

  /**
   * In a write run again call by call (`_checkedWrite`), read the error
   * queue after `call` and throw an error naming it and the pass.
   * @private
   */
  _checkCall(call, kind, range) {
    if (this._callCheck === null) return;
    const gl = this.gl;
    const code = gl.getError();
    if (code === gl.NO_ERROR) return;
    if (typeof gl.isContextLost === 'function' && gl.isContextLost()) throw contextLostError(this._callCheck);
    const where = range === null
      ? `setting up its ${kind} passes`
      : `the ${kind} pass writing slots [${range.firstSlot}, ${range.firstSlot + range.slots}) `
        + `(segment ${range.segment + 1}, bytes ${range.byteOffset}-${range.byteOffset + range.byteLength})`;
    throw new Error(`${this._callCheck}: ${call} in ${where} raised WebGL error ${describeWebGLError(gl, code)}.`);
  }

  /**
   * One source chunk, points `[first, end)`, gathered into every target
   * range: a slot whose source point lies in the chunk takes its words; any
   * other slot keeps the words already in the target when a `scratch` store
   * is given (they are read back through it), else gets 0 (the first chunk).
   * @private
   */
  _gatherChunk(wordsPerPoint, ranges, order, source, first, end, scratch) {
    const gl = this.gl;
    // A write checked later still reads the chunk before this one now, before
    // this chunk allocates its source (that allocation reads the queue).
    if (this._deferRead && scratch !== null) readPassErrors(gl);
    this._run(`w${wordsPerPoint}`, order, uniforms => {
      const held = this._rangeSource !== null
        && this._rangeSource.plan.itemCount >= (ArrayBuffer.isView(source) ? source.length : source.words)
        ? this._rangeSource
        : null;
      const uploaded = this._uploadSource(source, held);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, uploaded.texture);
      gl.uniform1i(uniforms.u_source, 0);
      setLinearLayoutUniform(gl, uniforms.u_sourceLayout, uploaded.plan);
      gl.uniform1i(uniforms.u_sourceBase, first);
      gl.uniform1i(uniforms.u_sourceEnd, end);
      return held !== null ? null : () => deleteTextureTracked(gl, uploaded.texture);
    }, ranges, scratch !== null ? { scratch, wordsPerPoint } : null);
  }

  /**
   * Write the highlight colour word of slots `[0, slots)` of a point store
   * into `target` (one word a slot), slot `s` holding the source point
   * `order[s]` (or `s` without an order): see `WORD_VS.highlight`.
   *
   * @param {WebGLBuffer|ReadonlyArray<{buffer: WebGLBuffer, first: number, count: number}>} target -
   *   One buffer, or a segmented store.
   * @param {number} slots
   * @param {{texture: WebGLTexture, plan: object}|null} order - The store's draw order.
   * @param {{texture: WebGLTexture, plan: object}} highlight - R8UI, a byte a source point.
   * @param {{texture: WebGLTexture, plan: object}} visible - R8UI, 0 or 1 a source point.
   * @param {number} minHighlight - The least highlight byte that is drawn.
   * @param {{onError?: ((error: Error) => void)|null}} [options] - `onError`:
   *   check the write in a later frame instead of now (see the module
   *   comment), and report a failure there.
   */
  writeHighlightWords(target, slots, order, highlight, visible, minHighlight, { onError = null } = {}) {
    if (order !== null) requireOrder(order);
    if (!Number.isSafeInteger(slots) || slots < 0) {
      throw new RangeError(`GPU highlight words need a slot count, not ${slots}.`);
    }
    if (slots === 0) return;
    const ranges = targetRanges(requireStoreSegments(target, slots), 1, this._chunkPoints);
    this._checkedWrite(`GPU highlight words of ${formatCountOf(slots, 'slot')}`, () => this._run('highlight', order, uniforms => {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, highlight.texture);
      gl.uniform1i(uniforms.u_highlight, 0);
      setLinearLayoutUniform(gl, uniforms.u_highlightLayout, highlight.plan);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, visible.texture);
      gl.uniform1i(uniforms.u_visible, 2);
      setLinearLayoutUniform(gl, uniforms.u_visibleLayout, visible.plan);
      gl.uniform1ui(uniforms.u_minHighlight, minHighlight);
      return null;
    }, ranges, null), {
      onError,
      inputs: [...ranges.map(range => range.buffer), order?.texture, highlight.texture, visible.texture],
    });
  }

  /**
   * One allocation through the renderer's `_allocateGpu` when there is one
   * (it frees memory kept only for speed and retries a refusal), else with
   * the error read here.
   * @private
   */
  _allocate(refusal, allocate, options = undefined) {
    if (this._allocateGpu !== null) {
      this._allocateGpu(refusal, allocate, options);
      return;
    }
    allocate();
  }

  /**
   * Delete every GL object this permuter owns.
   */
  /**
   * Hold one source texture of `words` words for the range writes that
   * follow (`writeWordsRange`): a store taking a draw order band by band
   * gathers every band through it, so the texture is allocated, and its
   * allocation read back, once for the whole adoption instead of once a band.
   * A held texture too small for a write is replaced (and read back) then.
   * `releaseRangeSource` deletes it.
   *
   * @param {number} words - The largest band's words (points × words a point).
   * @param {{onError?: ((error: Error) => void)|null}} [options] - `onError`:
   *   the allocation may be checked in a later frame and its failure reported
   *   there (the owner's `allocateGpu` decides).
   */
  holdRangeSource(words, { onError = null } = {}) {
    if (!Number.isSafeInteger(words) || words <= 0) {
      throw new RangeError(`GPU permute holds a source of a positive number of words, not ${words}.`);
    }
    if (this._rangeSource !== null && this._rangeSource.plan.itemCount >= words) return;
    this.releaseRangeSource();
    const gl = this.gl;
    const plan = planLinearTextureFor(gl, words);
    const texture = gl.createTexture();
    if (!texture) throw new Error('GPU permute could not allocate its source texture.');
    const unit = glStateOf(gl).activeTexture;
    gl.activeTexture(gl.TEXTURE0);
    const bound = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
    try {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      this._allocate('GPU permute could not allocate its source texture', () => {
        allocateLinearTexture(gl, gl.R32UI, plan);
      }, { onError });
    } catch (error) {
      deleteTextureTracked(gl, texture);
      throw error;
    } finally {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, restorableTexture(bound));
      gl.activeTexture(unit);
    }
    this._rangeSource = { texture, plan };
  }

  /** Delete the held range source (`holdRangeSource`), if any. */
  releaseRangeSource() {
    if (this._rangeSource === null) return;
    deleteTextureTracked(this.gl, this._rangeSource.texture);
    this._rangeSource = null;
  }

  dispose() {
    const gl = this.gl;
    this.releaseRangeSource();
    for (const kind of PROGRAM_KINDS) {
      if (this._programs[kind]) deleteProgramReleasingUse(gl, this._programs[kind]);
    }
    if (this._vao) gl.deleteVertexArray(this._vao);
    if (this._anchor) gl.deleteBuffer(this._anchor);
    if (this._feedback) gl.deleteTransformFeedback(this._feedback);
    if (this._dummyOrder) deleteTextureTracked(gl, this._dummyOrder.texture);
    if (this._sourceDraw) {
      deleteProgramReleasingUse(gl, this._sourceDraw.program);
      gl.deleteVertexArray(this._sourceDraw.vao);
      gl.deleteFramebuffer(this._sourceDraw.framebuffer);
    }
    for (const { program, vs, fs } of Object.values(this._started)) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      deleteProgramReleasingUse(gl, program);
    }
    this.abandon();
  }

  /**
   * Forget every handle without deleting it (the context was lost).
   */
  abandon() {
    // Its deferred checks would run its passes again.
    cancelDeferredWebGLErrorChecks(this.gl, this);
    this._programs = {};
    this._uniforms = {};
    this._vao = null;
    this._anchor = null;
    this._feedback = null;
    this._dummyOrder = null;
    this._sourceDraw = null;
    this._started = {};
  }

  /** @private */
  /**
   * Start compiling the programs of `kinds` ('w1', 'w2', 'w3', 'highlight',
   * 'source') without waiting for them: the GPU process compiles while the
   * page goes on, and the first pass that needs one only reads its status.
   * A program compiled on first use instead holds that pass's task for the
   * whole compile (a 10M tree's adoption, or a highlight of millions of
   * cells: 90-190 ms the first time a machine compiles them).
   *
   * @param {string[]} kinds
   */
  prewarm(kinds) {
    for (const kind of kinds) {
      if (this._programs[kind] || this._started[kind]) continue;
      if (kind === 'source' && this._sourceDraw !== null) continue;
      this._started[kind] = this._startProgram(kind);
    }
  }

  /**
   * Compile and link one program, reading no status.
   * @private
   */
  _startProgram(kind) {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!vs || !fs || !program) throw new Error('GPU permute could not allocate a program.');
    const source = kind === 'source';
    gl.shaderSource(vs, source ? SOURCE_DRAW_VS : kind === 'highlight' ? WORD_VS.highlight : WORD_VS[Number(kind.slice(1))]);
    gl.shaderSource(fs, source ? SOURCE_DRAW_FS : DISCARD_FS);
    gl.compileShader(vs);
    gl.compileShader(fs);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    if (!source) gl.transformFeedbackVaryings(program, ['v_words'], gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(program);
    return { program, vs, fs };
  }

  /**
   * The linked program of `kind`, started now unless `prewarm` started it.
   * @private
   */
  _linkedProgram(kind) {
    const gl = this.gl;
    const started = this._started[kind] ?? this._startProgram(kind);
    delete this._started[kind];
    const { program, vs, fs } = started;
    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
      const log = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)]
        .filter(Boolean).join('\n');
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      deleteProgramReleasingUse(gl, program);
      throw new Error(`GPU permute could not link its ${kind} program:\n${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return program;
  }

  _ensure(kind) {
    const gl = this.gl;
    if (!this._programs[kind]) {
      const program = this._linkedProgram(kind);
      const uniforms = {};
      for (const name of UNIFORMS) uniforms[name] = gl.getUniformLocation(program, name);
      this._programs[kind] = program;
      this._uniforms[kind] = uniforms;
    }
    if (this._vao === null) {
      const vao = gl.createVertexArray();
      const anchor = gl.createBuffer();
      if (!vao || !anchor) throw new Error('GPU permute could not allocate its vertex array.');
      // Attribute 0 (`a_anchor`): one zero word for the one instance.
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, anchor);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint32Array(1), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 4, 0);
      gl.vertexAttribDivisor(0, 1);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      this._vao = vao;
      this._anchor = anchor;
    }
    if (this._feedback === null) {
      this._feedback = gl.createTransformFeedback();
      if (!this._feedback) throw new Error('GPU permute could not allocate its transform feedback.');
    }
    if (this._dummyOrder === null) {
      const texture = gl.createTexture();
      if (!texture) throw new Error('GPU permute could not allocate its order texture.');
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      const plan = planLinearTextureFor(gl, 1);
      allocateLinearTexture(gl, gl.R32UI, plan);
      // Never read (u_orderedSlots 0), but written so no engine initializes
      // it lazily on first use.
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      writeLinearTextureRows(gl, plan, gl.RED_INTEGER, gl.UNSIGNED_INT, new Uint32Array(1), 1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      this._dummyOrder = { texture, plan };
    }
    return { program: this._programs[kind], uniforms: this._uniforms[kind] };
  }

  /**
   * The transform-feedback passes of `kind`, one per target range (slots
   * `[range.firstSlot, range.firstSlot + range.slots)`, written at
   * `range.byteOffset` of `range.buffer`). `bindSources(uniforms)` binds the
   * passes' source textures (units 0 and 2; the order is unit 1) and returns
   * what releases them, or null. With `keep`, each pass also reads the
   * range's current words (`a_prev`), writes into `keep.scratch` and copies
   * that over the range. The error queue is read once, after the passes
   * (`PassError`); in a write run again call by call every call is checked
   * (`_checkCall`).
   * @private
   */
  _run(kind, order, bindSources, ranges, keep) {
    const gl = this.gl;
    const saved = {
      program: gl.getParameter(gl.CURRENT_PROGRAM),
      vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
      unpackBuffer: gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING),
      copyRead: gl.getParameter(gl.COPY_READ_BUFFER_BINDING),
      copyWrite: gl.getParameter(gl.COPY_WRITE_BUFFER_BINDING),
      feedback: gl.getParameter(gl.TRANSFORM_FEEDBACK_BINDING),
      // The generic value of attribute 1, read by `a_prev` while its array
      // is off: it must be an unsigned integer there. From the state shadow:
      // Chromium waits for the GPU to answer the context (`gl-state-shadow.js`).
      generic: glStateOf(gl).genericAttribute(1),
      // From the state shadow: asking the context waits for the GPU in
      // Firefox and WebKit, and a pass runs on every draw-order change.
      activeTexture: glStateOf(gl).activeTexture,
      textures: [],
    };
    const units = [gl.TEXTURE0, gl.TEXTURE1, gl.TEXTURE2];
    for (const unit of units) {
      gl.activeTexture(unit);
      saved.textures.push(gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY));
    }
    let release = null;
    let active = false;
    try {
      gl.activeTexture(gl.TEXTURE0);
      const { program, uniforms } = this._ensure(kind);
      gl.useProgram(program);
      release = bindSources(uniforms);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindVertexArray(this._vao);
      gl.vertexAttribI4ui(1, 0, 0, 0, 0);
      const orderTexture = order === null ? this._dummyOrder : order;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, orderTexture.texture);
      gl.uniform1i(uniforms.u_order, 1);
      setLinearLayoutUniform(gl, uniforms.u_orderLayout, orderTexture.plan);
      gl.uniform1i(uniforms.u_orderedSlots, orderedSlotsOf(order));
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this._feedback);
      gl.enable(gl.RASTERIZER_DISCARD);
      this._checkCall('binding its program, sources and vertex array', kind, null);
      for (const range of ranges) {
        gl.uniform1i(uniforms.u_slotBase, range.firstSlot);
        if (keep !== null) {
          gl.bindBuffer(gl.ARRAY_BUFFER, range.buffer);
          gl.enableVertexAttribArray(1);
          gl.vertexAttribIPointer(1, keep.wordsPerPoint, gl.UNSIGNED_INT, keep.wordsPerPoint * 4, range.byteOffset);
          gl.bindBuffer(gl.ARRAY_BUFFER, null);
          this._checkCall('vertexAttribIPointer (the words it keeps)', kind, range);
          gl.bindBufferRange(gl.TRANSFORM_FEEDBACK_BUFFER, 0, keep.scratch, 0, range.byteLength);
        } else {
          gl.bindBufferRange(gl.TRANSFORM_FEEDBACK_BUFFER, 0, range.buffer, range.byteOffset, range.byteLength);
        }
        this._checkCall('bindBufferRange', kind, range);
        gl.beginTransformFeedback(gl.POINTS);
        active = true;
        this._checkCall('beginTransformFeedback', kind, range);
        drawPointsInSegments(gl, 0, range.slots);
        this._checkCall('drawArrays', kind, range);
        gl.endTransformFeedback();
        active = false;
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
        this._checkCall('endTransformFeedback', kind, range);
        if (keep !== null) {
          gl.disableVertexAttribArray(1);
          gl.bindBuffer(gl.COPY_READ_BUFFER, keep.scratch);
          gl.bindBuffer(gl.COPY_WRITE_BUFFER, range.buffer);
          gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, range.byteOffset, range.byteLength);
          // A buffer bound for transform feedback may be bound nowhere else
          // when a pass draws (WebGL 2): the next pass writes the scratch.
          gl.bindBuffer(gl.COPY_READ_BUFFER, null);
          gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
          this._checkCall('copyBufferSubData (scratch to the range)', kind, range);
        }
      }
    } finally {
      if (active) gl.endTransformFeedback();
      gl.disable(gl.RASTERIZER_DISCARD);
      if (this._feedback !== null) {
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this._feedback);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      }
      if (this._vao !== null) {
        // `a_prev` lets go of the target it read (onto the anchor, never
        // onto no buffer: `releaseVertexAttribute`), so no later pass
        // writing that store with this vertex array bound finds it bound.
        gl.bindVertexArray(this._vao);
        releaseVertexAttribute(gl, 1, this._anchor);
      }
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, saved.feedback);
      for (let index = 0; index < units.length; index++) {
        gl.activeTexture(units[index]);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, restorableTexture(saved.textures[index]));
      }
      gl.activeTexture(saved.activeTexture);
      if (release !== null) release();
      restoreGenericAttribute(gl, 1, saved.generic);
      gl.useProgram(saved.program);
      gl.bindVertexArray(saved.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, saved.arrayBuffer);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, saved.unpackBuffer);
      gl.bindBuffer(gl.COPY_READ_BUFFER, saved.copyRead);
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, saved.copyWrite);
    }
    // Once a chunk: before the next chunk allocates (`_allocateGpu` is
    // entered with an empty queue), and never a silent no-op; a write checked
    // later reads its last chunk in a later frame (`_checkedWrite`).
    if (!this._deferRead) readPassErrors(gl);
  }

  /**
   * Put the source words into an R32UI linear texture, one texel a word. One
   * channel keeps the upload native on every backend (Metal has no
   * three-channel 32-bit format, so RGB32UI would be converted on the CPU:
   * 50 ms against 13 ms for 10M 3D points). Words in a GPU buffer are copied
   * from it on the GPU.
   * @private
   */
  _uploadSource(source, held = null) {
    const gl = this.gl;
    const inPage = ArrayBuffer.isView(source);
    // A held texture (`holdRangeSource`) is written in its own layout; its
    // allocation was read back when it was made.
    const plan = held !== null ? held.plan : planLinearTextureFor(gl, inPage ? source.length : source.words);
    const texture = held !== null ? held.texture : gl.createTexture();
    if (!texture) throw new Error('GPU permute could not allocate its source texture.');
    try {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      if (held === null) {
        this._allocate('GPU permute could not allocate its source texture', () => {
          allocateLinearTexture(gl, gl.R32UI, plan);
        });
      }
      // UNPACK_ROW_LENGTH and UNPACK_IMAGE_HEIGHT are never set in this app
      // (they stay 0), and reading them is a synchronous round trip to the
      // GPU process in Chrome; the other unpack state is read client-side.
      const unpack = {
        alignment: gl.getParameter(gl.UNPACK_ALIGNMENT),
        skipRows: gl.getParameter(gl.UNPACK_SKIP_ROWS),
        skipPixels: gl.getParameter(gl.UNPACK_SKIP_PIXELS),
        skipImages: gl.getParameter(gl.UNPACK_SKIP_IMAGES),
      };
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
      try {
        if (inPage && held !== null) {
          writeLinearTextureItems(gl, plan, gl.RED_INTEGER, gl.UNSIGNED_INT, source, 1, 0, source.length);
        } else if (inPage) {
          writeLinearTextureRows(gl, plan, gl.RED_INTEGER, gl.UNSIGNED_INT, source, 1);
        } else {
          this._drawSource(texture, plan, source);
        }
      } finally {
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, unpack.alignment);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, unpack.skipRows);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, unpack.skipPixels);
        gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, unpack.skipImages);
      }
    } catch (error) {
      if (held === null) deleteTextureTracked(gl, texture);
      throw error;
    }
    return { texture, plan };
  }
}

/**
 * Draw the words of a GPU buffer into the R32UI linear texture `texture`
 * (`plan`), layer by layer, as `SOURCE_DRAW_VS` describes; every state it
 * changes is put back.
 *
 * @this {GpuPermuter}
 */
GpuPermuter.prototype._drawSource = function drawSource(texture, plan, { buffer, words, firstWord = 0, wordsPerPoint: pointWords = null }) {
  const gl = this.gl;
  // The source's segments in words: one buffer, or a segmented store whose
  // segments count points.
  const pointSegments = buffer instanceof PointStore ? buffer.segments : Array.isArray(buffer) ? buffer : null;
  // `firstWord`: texel 0 takes the buffer's word `firstWord` (a band of a
  // store, `writeWordsRange`, which names its words a point); the whole
  // store from its first word otherwise.
  const wordsPerPoint = pointSegments === null
    ? 1
    : pointWords ?? words / pointSegments.reduce((sum, segment) => sum + segment.count, 0);
  const segments = pointSegments === null
    ? [{ buffer, first: 0, count: words }]
    : pointSegments.map(segment => ({
      buffer: segment.buffer,
      first: segment.first * wordsPerPoint,
      count: segment.count * wordsPerPoint,
    }));
  const glState = glStateOf(gl);
  if (this._sourceDraw === null) {
    const program = this._linkedProgram('source');
    const vao = gl.createVertexArray();
    const framebuffer = gl.createFramebuffer();
    if (!vao || !framebuffer) throw new Error('GPU permute could not allocate its source draw.');
    this._sourceDraw = {
      program,
      vao,
      framebuffer,
      shape: gl.getUniformLocation(program, 'u_shape'),
      size: gl.getUniformLocation(program, 'u_size'),
      base: gl.getUniformLocation(program, 'u_base'),
    };
  }
  const draw = this._sourceDraw;
  const saved = {
    framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING),
    program: gl.getParameter(gl.CURRENT_PROGRAM),
    vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
    viewport: glState.viewport,
    colorMask: glState.colorMask,
    capabilities: [gl.BLEND, gl.DEPTH_TEST, gl.SCISSOR_TEST, gl.STENCIL_TEST, gl.RASTERIZER_DISCARD]
      .map(capability => [capability, glState.isEnabled(capability)]),
  };
  try {
    for (const [capability] of saved.capabilities) gl.disable(capability);
    gl.colorMask(true, true, true, true);
    gl.useProgram(draw.program);
    gl.uniform2i(draw.shape, plan.widthShift, plan.rowsPerLayer);
    gl.uniform2f(draw.size, plan.width, plan.rowsPerLayer);
    gl.bindVertexArray(draw.vao);
    gl.enableVertexAttribArray(0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, draw.framebuffer);
    gl.viewport(0, 0, plan.width, plan.rowsPerLayer);
    const perLayer = plan.width * plan.rowsPerLayer;
    for (let layer = 0; layer < plan.layers; layer++) {
      const first = layer * perLayer;
      if (first >= words) break;
      const end = Math.min(words, first + perLayer);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture, 0, layer);
      // The whole layer is written first: an image only drawn in part is
      // cleared again by Firefox before the draw ("lazy initialization").
      gl.clearBufferuiv(gl.COLOR, 0, ZERO_WORDS);
      // Each segment's words in this layer, its vertex 0 being its first word.
      forEachSegmentRange(segments, firstWord + first, end - first, (index, localFirst, localCount) => {
        const segment = segments[index];
        gl.bindBuffer(gl.ARRAY_BUFFER, segment.buffer);
        gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 4, 0);
        gl.uniform1i(draw.base, segment.first - firstWord);
        drawPointsInSegments(gl, localFirst, localCount);
      });
    }
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, null, 0, 0);
  } finally {
    // The draw's vertex array lets go of the last source segment it read
    // (onto the anchor: `releaseVertexAttribute`), so it keeps no store alive.
    gl.bindVertexArray(draw.vao);
    releaseVertexAttribute(gl, 0, this._anchor);
    gl.bindFramebuffer(gl.FRAMEBUFFER, saved.framebuffer);
    gl.viewport(saved.viewport[0], saved.viewport[1], saved.viewport[2], saved.viewport[3]);
    gl.colorMask(saved.colorMask[0], saved.colorMask[1], saved.colorMask[2], saved.colorMask[3]);
    for (const [capability, enabled] of saved.capabilities) {
      (enabled ? gl.enable : gl.disable).call(gl, capability);
    }
    gl.useProgram(saved.program);
    gl.bindVertexArray(saved.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, saved.arrayBuffer);
  }
};

const ZERO_WORDS = new Uint32Array(4);

/**
 * A segmented target's ranges for the passes: each segment split into runs
 * of at most `chunkPoints` slots, with the byte offset and length of the
 * run's words in the segment's buffer; only slots `[firstSlot, endSlot)`.
 */
function targetRanges(segments, wordsPerPoint, chunkPoints, firstSlot = 0, endSlot = Infinity) {
  const ranges = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const from = Math.max(0, firstSlot - segment.first);
    const to = Math.min(segment.count, endSlot - segment.first);
    for (let local = from; local < to; local += chunkPoints) {
      const slots = Math.min(chunkPoints, to - local);
      ranges.push({
        buffer: segment.buffer,
        segment: index,
        firstSlot: segment.first + local,
        slots,
        byteOffset: local * wordsPerPoint * 4,
        byteLength: slots * wordsPerPoint * 4,
      });
    }
  }
  return ranges;
}

/** A WebGL error a write's passes raised (`_run`), named by `_checkedWrite`. */
class PassError extends Error {
  constructor(code) {
    super(`GPU permute passes raised WebGL error 0x${code.toString(16)}.`);
    this.code = code;
  }
}

/** Read the error queue once after a chunk's passes. */
function readPassErrors(gl) {
  const code = gl.getError();
  if (code !== gl.NO_ERROR) throw new PassError(code);
}

/** Whether a buffer or texture a write used is still alive (asked only after a failure). */
function isAlive(gl, object) {
  if (object === null || object === undefined) return true;
  return typeof WebGLTexture === 'function' && object instanceof WebGLTexture ? gl.isTexture(object) : gl.isBuffer(object);
}

/** Put back the generic value of a vertex attribute as `getVertexAttrib` read it. */
function restoreGenericAttribute(gl, location, value) {
  if (value instanceof Uint32Array) gl.vertexAttribI4ui(location, value[0], value[1], value[2], value[3]);
  else if (value instanceof Int32Array) gl.vertexAttribI4i(location, value[0], value[1], value[2], value[3]);
  else if (value instanceof Float32Array) gl.vertexAttrib4f(location, value[0], value[1], value[2], value[3]);
}

function requireBufferSource(source) {
  if (!source || !source.buffer || !Number.isSafeInteger(source.words) || source.words < 0) {
    throw new TypeError('GPU permute needs source words in page memory or a {buffer, words, page} GPU source.');
  }
  return source.words;
}

/** Slots read through `order`'s map (`u_orderedSlots`): every slot of a whole order. */
function orderedSlotsOf(order) {
  if (order === null) return 0;
  return Number.isSafeInteger(order.orderedSlots) ? order.orderedSlots : 2 ** 31 - 1;
}

function requireOrder(order) {
  if (!order || !order.texture || !order.plan || !Number.isInteger(order.plan.widthShift)) {
    throw new Error('GPU permute needs a live draw-order record (permutation texture and layout).');
  }
}
