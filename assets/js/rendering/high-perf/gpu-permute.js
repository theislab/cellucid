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
 * Outputs:
 * - `writeWords`: 1, 2 or 3 32-bit words a point -- RGBA8 colours (1), or
 *   x / xy / xyz Float32 positions (1-3).
 *
 * The pass leaves every binding it touches as it found it.
 */

import {
  createTransformFeedbackProgram,
  deleteProgramReleasingUse,
  deleteTextureTracked,
  drawPointsInSegments,
  restorableTexture,
} from '../gl-utils.js';
import {
  LINEAR_TEXEL_GLSL,
  allocateLinearTexture,
  planLinearTextureFor,
  setLinearLayoutUniform,
  writeLinearTextureRows,
} from '../linear-texture.js';

const VS_HEAD = `#version 300 es
precision highp int;
precision highp float;
uniform highp usampler2DArray u_source;
uniform ivec2 u_sourceLayout;
uniform highp usampler2DArray u_order;
uniform ivec2 u_orderLayout;
uniform bool u_useOrder;
// One per-instance zero word: attribute 0 is active and backed by an array,
// so no engine emulates it (Firefox on desktop OpenGL builds a vertex-count
// array for a disabled attribute 0).
layout(location = 0) in highp uint a_anchor;
${LINEAR_TEXEL_GLSL}
// The source point stored at slot.
int sourcePoint(int slot) {
  if (!u_useOrder) return slot;
  return int(texelFetch(u_order, linearTexel(slot, u_orderLayout), 0).r);
}

// One source word: the source is one R32UI texel a word.
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

const WORD_VS = {
  1: `${VS_HEAD}flat out highp uint v_words;\nvoid main() {\n  v_words = wordAt(sourcePoint(gl_VertexID));${POINT_TAIL}`,
  2: `${VS_HEAD}flat out highp uvec2 v_words;\nvoid main() {\n  int base = sourcePoint(gl_VertexID) * 2;\n  v_words = uvec2(wordAt(base), wordAt(base + 1));${POINT_TAIL}`,
  3: `${VS_HEAD}flat out highp uvec3 v_words;\nvoid main() {\n  int base = sourcePoint(gl_VertexID) * 3;\n  v_words = uvec3(wordAt(base), wordAt(base + 1), wordAt(base + 2));${POINT_TAIL}`,
};

const DISCARD_FS = `#version 300 es
precision lowp float;
out vec4 outColor;
void main() {
  outColor = vec4(0.0);
}
`;

const UNIFORMS = ['u_source', 'u_sourceLayout', 'u_order', 'u_orderLayout', 'u_useOrder'];
const PROGRAM_KINDS = ['w1', 'w2', 'w3'];

/**
 * Lazily compiled transform-feedback programs plus the objects one pass
 * binds. One per renderer and GL context.
 */
export class GpuPermuter {
  /**
   * @param {WebGL2RenderingContext} gl
   */
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {(refusal: string, allocate: () => void) => void} [allocateGpu] -
   *   Runs one allocation and reports a refusal (the renderer's
   *   `_allocateGpu`, which releases memory kept only for speed and retries).
   */
  constructor(gl, allocateGpu = null) {
    this.gl = gl;
    this._allocateGpu = allocateGpu;
    this._programs = {};
    this._uniforms = {};
    this._vao = null;
    this._anchor = null;
    this._feedback = null;
    this._dummyOrder = null;
  }

  /**
   * Write `wordsPerPoint` 32-bit words a point into `target` (sized for
   * them), slot `s` taking the source point `order[s]`.
   *
   * @param {WebGLBuffer} target
   * @param {Uint32Array} source - Source-order words.
   * @param {{texture: WebGLTexture, plan: object}} order - A linear R32UI texture.
   * @param {1|2|3} wordsPerPoint
   */
  writeWords(target, source, order, wordsPerPoint) {
    requireOrder(order);
    if (!WORD_VS[wordsPerPoint]) {
      throw new RangeError(`GPU permute writes 1, 2 or 3 words a point, not ${wordsPerPoint}.`);
    }
    const count = source.length / wordsPerPoint;
    this._run(`w${wordsPerPoint}`, target, source, order, count, count * wordsPerPoint * 4);
  }

  /**
   * Delete every GL object this permuter owns.
   */
  dispose() {
    const gl = this.gl;
    for (const kind of PROGRAM_KINDS) {
      if (this._programs[kind]) deleteProgramReleasingUse(gl, this._programs[kind]);
    }
    if (this._vao) gl.deleteVertexArray(this._vao);
    if (this._anchor) gl.deleteBuffer(this._anchor);
    if (this._feedback) gl.deleteTransformFeedback(this._feedback);
    if (this._dummyOrder) deleteTextureTracked(gl, this._dummyOrder.texture);
    this.abandon();
  }

  /**
   * Forget every handle without deleting it (the context was lost).
   */
  abandon() {
    this._programs = {};
    this._uniforms = {};
    this._vao = null;
    this._anchor = null;
    this._feedback = null;
    this._dummyOrder = null;
  }

  /** @private */
  _ensure(kind) {
    const gl = this.gl;
    if (!this._programs[kind]) {
      const program = createTransformFeedbackProgram(
        gl,
        WORD_VS[Number(kind.slice(1))],
        DISCARD_FS,
        ['v_words']
      );
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
      // Never read (u_useOrder off), but written so no engine initializes
      // it lazily on first use.
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      writeLinearTextureRows(gl, plan, gl.RED_INTEGER, gl.UNSIGNED_INT, new Uint32Array(1), 1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      this._dummyOrder = { texture, plan };
    }
    return { program: this._programs[kind], uniforms: this._uniforms[kind] };
  }

  /** @private */
  _run(kind, target, sourceWords, order, vertexCount, byteLength) {
    const gl = this.gl;
    const saved = {
      program: gl.getParameter(gl.CURRENT_PROGRAM),
      vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
      unpackBuffer: gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING),
      feedback: gl.getParameter(gl.TRANSFORM_FEEDBACK_BINDING),
      activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE),
      textures: [],
    };
    for (const unit of [gl.TEXTURE0, gl.TEXTURE1]) {
      gl.activeTexture(unit);
      saved.textures.push(gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY));
    }
    let source = null;
    let active = false;
    try {
      gl.activeTexture(gl.TEXTURE0);
      const { program, uniforms } = this._ensure(kind);
      source = this._uploadSource(sourceWords);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindVertexArray(this._vao);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, source.texture);
      gl.uniform1i(uniforms.u_source, 0);
      setLinearLayoutUniform(gl, uniforms.u_sourceLayout, source.plan);
      const orderTexture = order === null ? this._dummyOrder : order;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, orderTexture.texture);
      gl.uniform1i(uniforms.u_order, 1);
      setLinearLayoutUniform(gl, uniforms.u_orderLayout, orderTexture.plan);
      gl.uniform1i(uniforms.u_useOrder, order === null ? 0 : 1);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this._feedback);
      gl.bindBufferRange(gl.TRANSFORM_FEEDBACK_BUFFER, 0, target, 0, byteLength);
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(gl.POINTS);
      active = true;
      drawPointsInSegments(gl, 0, vertexCount);
      gl.endTransformFeedback();
      active = false;
    } finally {
      if (active) gl.endTransformFeedback();
      gl.disable(gl.RASTERIZER_DISCARD);
      if (this._feedback !== null) {
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this._feedback);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      }
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, saved.feedback);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, restorableTexture(saved.textures[0]));
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, restorableTexture(saved.textures[1]));
      gl.activeTexture(saved.activeTexture);
      if (source !== null) deleteTextureTracked(gl, source.texture);
      gl.useProgram(saved.program);
      gl.bindVertexArray(saved.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, saved.arrayBuffer);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, saved.unpackBuffer);
    }
  }

  /**
   * Put the source words into an R32UI linear texture, one texel a word. One
   * channel keeps the upload native on every backend (Metal has no
   * three-channel 32-bit format, so RGB32UI would be converted on the CPU:
   * 50 ms against 13 ms for 10M 3D points).
   * @private
   */
  _uploadSource(array) {
    const gl = this.gl;
    const plan = planLinearTextureFor(gl, array.length);
    const texture = gl.createTexture();
    if (!texture) throw new Error('GPU permute could not allocate its source texture.');
    try {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      if (this._allocateGpu === null) {
        allocateLinearTexture(gl, gl.R32UI, plan);
      } else {
        this._allocateGpu('GPU permute could not allocate its source texture', () => {
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
        writeLinearTextureRows(gl, plan, gl.RED_INTEGER, gl.UNSIGNED_INT, array, 1);
      } finally {
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, unpack.alignment);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, unpack.skipRows);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, unpack.skipPixels);
        gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, unpack.skipImages);
      }
    } catch (error) {
      deleteTextureTracked(gl, texture);
      throw error;
    }
    return { texture, plan };
  }
}

function requireOrder(order) {
  if (!order || !order.texture || !order.plan || !Number.isInteger(order.plan.widthShift)) {
    throw new Error('GPU permute needs a live draw-order record (permutation texture and layout).');
  }
}
