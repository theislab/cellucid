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
 * Outputs:
 * - `writeWords`: 1, 2 or 3 32-bit words a point -- RGBA8 colours (1), or
 *   x / xy / xyz Float32 positions (1-3).
 *
 * The pass leaves every binding it touches as it found it.
 */

import {
  deleteProgramReleasingUse,
  deleteTextureTracked,
  drawPointsInSegments,
  restorableTexture,
} from '../gl-utils.js';
import { glStateOf } from '../gl-state-shadow.js';
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
  int point = sourcePoint(gl_VertexID);
  uint highlight = texelFetch(u_highlight, linearTexel(point, u_highlightLayout), 0).r;
  uint visible = texelFetch(u_visible, linearTexel(point, u_visibleLayout), 0).r;
  v_words = (highlight >= u_minHighlight && visible >= 1u) ? (0x00ffffffu | (highlight << 24)) : 0u;${POINT_TAIL}`;

// One source word a point, drawn to its texel of a linear texture's layer
// (\`_drawSource\`): the word's index is the vertex id (the draw starts at the
// layer's first word), its texel the linear texture's, at the texel's centre.
const SOURCE_DRAW_VS = `#version 300 es
precision highp int;
precision highp float;
layout(location = 0) in highp uint a_word;
uniform ivec2 u_shape;
uniform vec2 u_size;
flat out highp uint v_word;
${LINEAR_TEXEL_GLSL}
void main() {
  ivec3 texel = linearTexel(gl_VertexID, u_shape);
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
  'u_source', 'u_sourceLayout', 'u_order', 'u_orderLayout', 'u_useOrder',
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
    // The source drawn from a buffer (`_drawSource`), made on first use.
    this._sourceDraw = null;
    // Programs `prewarm` started, linked when first used.
    this._started = {};
  }

  /**
   * Write `wordsPerPoint` 32-bit words a point into `target` (sized for
   * them), slot `s` taking the source point `order[s]`.
   *
   * @param {WebGLBuffer} target
   * @param {Uint32Array|{buffer: WebGLBuffer, words: number}} source -
   *   Source-order words: in page memory, or the first `words` words of a
   *   GPU buffer (`target` itself for a gather in place).
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
    this._run(`w${wordsPerPoint}`, target, order, count, count * wordsPerPoint * 4, uniforms => {
      const gl = this.gl;
      const uploaded = this._uploadSource(source);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, uploaded.texture);
      gl.uniform1i(uniforms.u_source, 0);
      setLinearLayoutUniform(gl, uniforms.u_sourceLayout, uploaded.plan);
      return () => deleteTextureTracked(gl, uploaded.texture);
    });
  }

  /**
   * Write the highlight colour word of slots `[0, slots)` of a point store
   * into `target` (one word a slot), slot `s` holding the source point
   * `order[s]` (or `s` without an order): see `WORD_VS.highlight`.
   *
   * @param {WebGLBuffer} target
   * @param {number} slots
   * @param {{texture: WebGLTexture, plan: object}|null} order - The store's draw order.
   * @param {{texture: WebGLTexture, plan: object}} highlight - R8UI, a byte a source point.
   * @param {{texture: WebGLTexture, plan: object}} visible - R8UI, 0 or 1 a source point.
   * @param {number} minHighlight - The least highlight byte that is drawn.
   */
  writeHighlightWords(target, slots, order, highlight, visible, minHighlight) {
    if (order !== null) requireOrder(order);
    if (!Number.isSafeInteger(slots) || slots < 0) {
      throw new RangeError(`GPU highlight words need a slot count, not ${slots}.`);
    }
    this._run('highlight', target, order, slots, slots * 4, uniforms => {
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
    });
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
      // Never read (u_useOrder off), but written so no engine initializes
      // it lazily on first use.
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      writeLinearTextureRows(gl, plan, gl.RED_INTEGER, gl.UNSIGNED_INT, new Uint32Array(1), 1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      this._dummyOrder = { texture, plan };
    }
    return { program: this._programs[kind], uniforms: this._uniforms[kind] };
  }

  /**
   * One transform-feedback pass of `kind` writing `vertexCount` slots into
   * `target`. `bindSources(uniforms)` binds the pass's source textures
   * (units 0 and 2; the order is unit 1) and returns what releases them, or
   * null.
   * @private
   */
  _run(kind, target, order, vertexCount, byteLength, bindSources) {
    const gl = this.gl;
    const saved = {
      program: gl.getParameter(gl.CURRENT_PROGRAM),
      vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
      unpackBuffer: gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING),
      feedback: gl.getParameter(gl.TRANSFORM_FEEDBACK_BINDING),
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
      for (let index = 0; index < units.length; index++) {
        gl.activeTexture(units[index]);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, restorableTexture(saved.textures[index]));
      }
      gl.activeTexture(saved.activeTexture);
      if (release !== null) release();
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
   * 50 ms against 13 ms for 10M 3D points). Words in a GPU buffer are copied
   * from it on the GPU.
   * @private
   */
  _uploadSource(source) {
    const gl = this.gl;
    const inPage = ArrayBuffer.isView(source);
    const plan = planLinearTextureFor(gl, inPage ? source.length : source.words);
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
        if (inPage) {
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
      deleteTextureTracked(gl, texture);
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
GpuPermuter.prototype._drawSource = function drawSource(texture, plan, { buffer, words }) {
  const gl = this.gl;
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
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 4, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, draw.framebuffer);
    gl.viewport(0, 0, plan.width, plan.rowsPerLayer);
    const perLayer = plan.width * plan.rowsPerLayer;
    for (let layer = 0; layer < plan.layers; layer++) {
      const first = layer * perLayer;
      if (first >= words) break;
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture, 0, layer);
      // The whole layer is written first: an image only drawn in part is
      // cleared again by Firefox before the draw ("lazy initialization").
      gl.clearBufferuiv(gl.COLOR, 0, ZERO_WORDS);
      drawPointsInSegments(gl, first, Math.min(perLayer, words - first));
    }
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, null, 0, 0);
  } finally {
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

function requireBufferSource(source) {
  if (!source || !source.buffer || !Number.isSafeInteger(source.words) || source.words < 0) {
    throw new TypeError('GPU permute needs source words in page memory or a {buffer, words} GPU source.');
  }
  return source.words;
}

function requireOrder(order) {
  if (!order || !order.texture || !order.plan || !Number.isInteger(order.plan.widthShift)) {
    throw new Error('GPU permute needs a live draw-order record (permutation texture and layout).');
  }
}
