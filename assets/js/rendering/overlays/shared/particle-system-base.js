/**
 * @fileoverview Reusable GPU particle system base (WebGL2 transform feedback).
 *
 * Supports both point-based and line-segment rendering:
 * - draw(): Standard GL_POINTS rendering (one point per particle)
 * - drawInstanced(): Instanced rendering (multiple vertices per particle)
 *   Used for line segment quads where each particle draws a quad from
 *   its previous position to current position.
 *
 * @module rendering/overlays/shared/particle-system-base
 */

/**
 * @typedef {object} ParticleAttribute
 * @property {string} name
 * @property {number} size
 * @property {number} type - gl.FLOAT / gl.UNSIGNED_INT / ...
 * @property {boolean} [integer=false] - Use vertexAttribIPointer for integer attributes
 */

export class ParticleSystemBase {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {object} options
   * @param {number} options.capacity
   * @param {ParticleAttribute[]} options.attributes
   */
  constructor(gl, options) {
    this.gl = gl;
    this.capacity = Math.max(1, Math.floor(options?.capacity || 1));
    this.attributes = Array.isArray(options?.attributes) ? options.attributes : [];

    if (this.attributes.length === 0) {
      throw new Error('ParticleSystemBase: at least one attribute is required');
    }

    this._strideBytes = 0;
    this._attributeLayout = [];
    for (const attr of this.attributes) {
      const size = Math.max(1, Math.floor(attr.size || 1));
      const type = attr.type;
      const integer = attr.integer === true;
      const bytesPerComponent = 4; // float32 + uint32 only (by design)
      const byteSize = size * bytesPerComponent;
      this._attributeLayout.push({ size, type, integer, offsetBytes: this._strideBytes });
      this._strideBytes += byteSize;
    }

    this.activeCount = Math.min(this.capacity, this.capacity);

    /** @type {[WebGLBuffer, WebGLBuffer]} */
    this._buffers = [null, null];
    /** @type {[WebGLVertexArrayObject, WebGLVertexArrayObject]} */
    this._vaos = [null, null];
    /** @type {[WebGLVertexArrayObject, WebGLVertexArrayObject]} */
    this._instancedVaos = [null, null];
    this._currentIndex = 0;

    this._initBuffers();
  }

  setActiveCount(count) {
    const n = Math.max(0, Math.floor(count || 0));
    this.activeCount = Math.min(this.capacity, n);
  }

  /**
   * Get the current particle buffer for reading.
   * @returns {WebGLBuffer}
   */
  getCurrentBuffer() {
    return this._buffers[this._currentIndex];
  }

  /**
   * Get the stride in bytes for the particle data.
   * @returns {number}
   */
  getStrideBytes() {
    return this._strideBytes;
  }

  /**
   * Initialize the particle buffers from an ArrayBuffer with the exact packed layout.
   * Writes the same initial data into both ping-pong buffers.
   *
   * @param {ArrayBuffer} initialData
   */
  initFromArrayBuffer(initialData) {
    const gl = this.gl;
    if (!(initialData instanceof ArrayBuffer)) {
      throw new Error('ParticleSystemBase.initFromArrayBuffer: initialData must be an ArrayBuffer');
    }
    const expectedBytes = this.capacity * this._strideBytes;
    if (initialData.byteLength !== expectedBytes) {
      throw new Error(`ParticleSystemBase.initFromArrayBuffer: expected ${expectedBytes} bytes, got ${initialData.byteLength}`);
    }

    for (let i = 0; i < 2; i++) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this._buffers[i]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(initialData));
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /**
   * Run a transform-feedback update pass.
   *
   * @param {WebGLProgram} program
   * @param {() => void} setUniformsAndTextures - Called after `useProgram()`
   */
  update(program, setUniformsAndTextures) {
    const gl = this.gl;
    if (!program || this.activeCount <= 0) return;

    const src = this._currentIndex;
    const dst = 1 - src;

    gl.useProgram(program);
    setUniformsAndTextures?.();

    gl.bindVertexArray(this._vaos[src]);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this._buffers[dst]);
    gl.enable(gl.RASTERIZER_DISCARD);

    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, this.activeCount);
    gl.endTransformFeedback();

    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindVertexArray(null);

    this._currentIndex = dst;
  }

  /**
   * Draw particles as GL_POINTS.
   */
  draw() {
    const gl = this.gl;
    if (this.activeCount <= 0) return;
    gl.bindVertexArray(this._vaos[this._currentIndex]);
    gl.drawArrays(gl.POINTS, 0, this.activeCount);
    gl.bindVertexArray(null);
  }

  /**
   * Draw particles using instancing.
   * Each particle instance draws multiple vertices (e.g., 4 vertices for a line quad).
   * Particle attributes become instance attributes (one value per instance).
   * gl_VertexID in shader provides the vertex index within each instance.
   *
   * @param {number} verticesPerInstance - Number of vertices per particle instance
   * @param {number} [mode=gl.TRIANGLE_STRIP] - WebGL draw mode
   */
  drawInstanced(verticesPerInstance, mode) {
    const gl = this.gl;
    if (this.activeCount <= 0) return;

    const drawMode = mode !== undefined ? mode : gl.TRIANGLE_STRIP;

    gl.bindVertexArray(this._instancedVaos[this._currentIndex]);
    gl.drawArraysInstanced(drawMode, 0, verticesPerInstance, this.activeCount);
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    for (const buf of this._buffers) {
      if (buf) gl.deleteBuffer(buf);
    }
    for (const vao of this._vaos) {
      if (vao) gl.deleteVertexArray(vao);
    }
    for (const vao of this._instancedVaos) {
      if (vao) gl.deleteVertexArray(vao);
    }
    this._buffers = [null, null];
    this._vaos = [null, null];
    this._instancedVaos = [null, null];
  }

  _initBuffers() {
    const gl = this.gl;
    const byteSize = this.capacity * this._strideBytes;

    for (let i = 0; i < 2; i++) {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, byteSize, gl.DYNAMIC_COPY);
      this._buffers[i] = buffer;

      // Standard VAO for points and transform feedback (no divisor)
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

      this._attributeLayout.forEach((layout, index) => {
        gl.enableVertexAttribArray(index);
        if (layout.integer) {
          gl.vertexAttribIPointer(index, layout.size, layout.type, this._strideBytes, layout.offsetBytes);
        } else {
          gl.vertexAttribPointer(index, layout.size, layout.type, false, this._strideBytes, layout.offsetBytes);
        }
      });

      this._vaos[i] = vao;

      // Instanced VAO for line segment rendering (divisor = 1)
      const instancedVao = gl.createVertexArray();
      gl.bindVertexArray(instancedVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

      this._attributeLayout.forEach((layout, index) => {
        gl.enableVertexAttribArray(index);
        if (layout.integer) {
          gl.vertexAttribIPointer(index, layout.size, layout.type, this._strideBytes, layout.offsetBytes);
        } else {
          gl.vertexAttribPointer(index, layout.size, layout.type, false, this._strideBytes, layout.offsetBytes);
        }
        // Instance divisor: advance attribute once per instance, not per vertex
        gl.vertexAttribDivisor(index, 1);
      });

      this._instancedVaos[i] = instancedVao;
    }

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }
}
