// GPU-based 3D Noise Texture Generator
// =====================================
// Professional-quality noise generation for volumetric clouds
// Based on techniques from:
// - Horizon Zero Dawn (Guerrilla Games)
// - Frostbite Engine (EA DICE)
// - GPU Gems 3
//
// Generates Perlin-Worley and detail noise textures entirely on the GPU
// Orders of magnitude faster than CPU/Web Worker generation

import {
  NOISE_VS,
  SHAPE_NOISE_FS,
  DETAIL_NOISE_FS,
  BLUE_NOISE_FS
} from '../shaders/noise-shaders.js';

/**
 * GPU Noise Generator Class
 * Generates 3D noise textures using WebGL2 fragment shaders
 */
export class GPUNoiseGenerator {
  constructor(gl) {
    if (!gl || typeof gl !== 'object') {
      throw new TypeError('GPUNoiseGenerator requires a WebGL2 rendering context.');
    }
    this.gl = gl;
    this.programs = {};
    this.quadVAO = null;
    this.quadVBO = null;

    this._initShaders();
    this._initQuad();
  }

  _compileShader(source, type) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) {
      throw new Error('GPU noise shader allocation failed.');
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`GPU noise shader compilation failed: ${log}`);
    }
    return shader;
  }

  _createProgram(vsSource, fsSource) {
    const gl = this.gl;
    const vs = this._compileShader(vsSource, gl.VERTEX_SHADER);
    const fs = this._compileShader(fsSource, gl.FRAGMENT_SHADER);

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error('GPU noise program allocation failed.');
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error(`GPU noise program linking failed: ${log}`);
    }

    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return program;
  }

  _initShaders() {
    this.programs.shape = this._createProgram(NOISE_VS, SHAPE_NOISE_FS);
    this.programs.detail = this._createProgram(NOISE_VS, DETAIL_NOISE_FS);
    this.programs.blueNoise = this._createProgram(NOISE_VS, BLUE_NOISE_FS);

    // Cache uniform locations
    const gl = this.gl;

    this.uniforms = {};

    this.uniforms.shape = {
      slice: gl.getUniformLocation(this.programs.shape, 'u_slice')
    };
    this.uniforms.detail = {
      slice: gl.getUniformLocation(this.programs.detail, 'u_slice')
    };
    for (const [name, uniforms] of Object.entries(this.uniforms)) {
      for (const [uniformName, location] of Object.entries(uniforms)) {
        if (location === null) {
          throw new Error(
            `GPU noise ${name} shader is missing required uniform ${uniformName}.`
          );
        }
      }
    }
  }

  _initQuad() {
    const gl = this.gl;

    // Fullscreen quad vertices
    const vertices = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
       1,  1
    ]);

    this.quadVAO = gl.createVertexArray();
    this.quadVBO = gl.createBuffer();
    if (!this.quadVAO || !this.quadVBO) {
      throw new Error('GPU noise quad allocation failed.');
    }

    gl.bindVertexArray(this.quadVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    // Setup attribute for all programs
    for (const prog of Object.values(this.programs)) {
      const loc = gl.getAttribLocation(prog, 'a_position');
      if (loc < 0) {
        throw new Error('GPU noise shader is missing required a_position input.');
      }
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }

    gl.bindVertexArray(null);
  }

  /**
   * Generate a 3D noise texture by rendering each Z-slice
   */
  _generate3DTexture(program, uniforms, size) {
    const gl = this.gl;
    const startTime = performance.now();

    // Create 3D texture
    const texture = gl.createTexture();
    if (!texture) {
      throw new Error('GPU noise 3D texture allocation failed.');
    }
    gl.bindTexture(gl.TEXTURE_3D, texture);

    // Allocate 3D texture storage
    gl.texImage3D(
      gl.TEXTURE_3D, 0, gl.RGBA8,
      size, size, size, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null
    );

    // Create framebuffer for rendering
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) {
      gl.deleteTexture(texture);
      throw new Error('GPU noise framebuffer allocation failed.');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);

    // Save current state
    const prevViewport = gl.getParameter(gl.VIEWPORT);
    const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM);

    // Setup for rendering
    gl.viewport(0, 0, size, size);
    gl.useProgram(program);
    gl.bindVertexArray(this.quadVAO);

    // Render each Z-slice
    for (let z = 0; z < size; z++) {
      // Attach current slice to framebuffer
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture, 0, z);

      // Check framebuffer status
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(framebuffer);
        gl.deleteTexture(texture);
        gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
        gl.useProgram(prevProgram);
        gl.bindVertexArray(null);
        throw new Error(`GPU noise framebuffer is incomplete for slice ${z}.`);
      }

      // Set slice uniform (normalized 0-1)
      gl.uniform1f(uniforms.slice, (z + 0.5) / size);

      // Render quad
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // Generate mipmaps
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.generateMipmap(gl.TEXTURE_3D);

    // Set texture parameters
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);

    // Restore state
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    gl.useProgram(prevProgram);
    gl.bindVertexArray(null);

    const elapsed = performance.now() - startTime;
    console.log(`  Generated ${size}³ texture in ${elapsed.toFixed(1)}ms`);

    return texture;
  }

  /**
   * Generate 2D blue noise texture
   */
  _generateBlueNoise() {
    const gl = this.gl;
    const size = 128;
    const startTime = performance.now();

    // Create 2D texture
    const texture = gl.createTexture();
    if (!texture) {
      throw new Error('GPU blue-noise texture allocation failed.');
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, size, size, 0, gl.RG, gl.UNSIGNED_BYTE, null);

    // Create framebuffer
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) {
      gl.deleteTexture(texture);
      throw new Error('GPU blue-noise framebuffer allocation failed.');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    // Save state
    const prevViewport = gl.getParameter(gl.VIEWPORT);
    const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      throw new Error('GPU blue-noise framebuffer is incomplete.');
    }

    // Render
    gl.viewport(0, 0, size, size);
    gl.useProgram(this.programs.blueNoise);
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Set texture parameters
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    // Restore state
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    gl.useProgram(prevProgram);
    gl.bindVertexArray(null);

    const elapsed = performance.now() - startTime;
    console.log(`  Generated blue noise in ${elapsed.toFixed(1)}ms`);

    return { texture, size };
  }

  /**
   * Generate all cloud noise textures on GPU
   * Returns immediately with textures (synchronous, very fast)
   */
  generate(shapeSize = 128, detailSize = 32) {
    for (const [name, value] of [
      ['shapeSize', shapeSize],
      ['detailSize', detailSize]
    ]) {
      if (!Number.isInteger(value) || value < 32 || value > 256) {
        throw new RangeError(
          `GPU noise ${name} must be an integer between 32 and 256.`
        );
      }
    }
    console.log('=== Generating Cloud Noise Textures (GPU) ===');
    const totalStart = performance.now();

    const gl = this.gl;

    // Save current GL state
    const prevDepthTest = gl.isEnabled(gl.DEPTH_TEST);
    const prevBlend = gl.isEnabled(gl.BLEND);
    const prevCullFace = gl.isEnabled(gl.CULL_FACE);

    // Ensure WebGL state is clean for generation
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    // Generate shape noise (128³)
    console.log(`Generating shape noise (${shapeSize}³)...`);
    const shape = this._generate3DTexture(
      this.programs.shape,
      this.uniforms.shape,
      shapeSize
    );

    // Generate detail noise (32³)
    console.log(`Generating detail noise (${detailSize}³)...`);
    const detail = this._generate3DTexture(
      this.programs.detail,
      this.uniforms.detail,
      detailSize
    );

    // Generate blue noise (128²)
    console.log('Generating blue noise (128²)...');
    const blueNoiseResult = this._generateBlueNoise();

    // Restore GL state
    if (prevDepthTest) gl.enable(gl.DEPTH_TEST);
    if (prevBlend) gl.enable(gl.BLEND);
    if (prevCullFace) gl.enable(gl.CULL_FACE);

    const totalElapsed = performance.now() - totalStart;
    console.log(`=== GPU noise generation complete in ${totalElapsed.toFixed(1)}ms ===`);
    console.log(`  Shape: ${shapeSize}³ RGBA (${(shapeSize ** 3 * 4 / 1024 / 1024).toFixed(1)}MB)`);
    console.log(`  Detail: ${detailSize}³ RGBA (${(detailSize ** 3 * 4 / 1024 / 1024).toFixed(2)}MB)`);
    console.log(`  Blue noise: ${blueNoiseResult.size}² RG`);

    return {
      shape,
      detail,
      blueNoise: blueNoiseResult.texture,
      shapeSize,
      detailSize,
      blueNoiseSize: blueNoiseResult.size
    };
  }

  /**
   * Clean up resources
   */
  dispose() {
    const gl = this.gl;

    for (const prog of Object.values(this.programs)) {
      if (prog) gl.deleteProgram(prog);
    }

    if (this.quadVAO) gl.deleteVertexArray(this.quadVAO);
    if (this.quadVBO) gl.deleteBuffer(this.quadVBO);
  }
}

/**
 * Convenience function to generate cloud noise textures on GPU
 */
export function generateCloudNoiseTexturesGPU(gl, shapeSize = 128, detailSize = 32) {
  const generator = new GPUNoiseGenerator(gl);
  const textures = generator.generate(shapeSize, detailSize);
  generator.dispose();
  return textures;
}
