// ============================================================================
// GPU-Accelerated Density Volume Splatting (WebGL2)
// ============================================================================

import { SPLAT_VS, SPLAT_FS, NORMALIZE_VS, NORMALIZE_FS } from '../shaders/density-shaders.js';
import { getNotificationCenter } from '../../app/notification-center.js';

const gpuSplatResourcesByContext = new WeakMap();

function getOrCreateGPUSplatResources(gl) {
  const cached = gpuSplatResourcesByContext.get(gl);
  if (cached) return cached;

  // Compile shaders
  function compileShader(type, source) {
    const shader = gl.createShader(type);
    if (!shader) {
      throw new Error('Smoke density shader allocation failed.');
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Smoke density shader compilation failed: ${log}`);
    }
    return shader;
  }

  function createProgramFromSources(vsSource, fsSource) {
    const vs = compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error('Smoke density program allocation failed.');
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error(`Smoke density program linking failed: ${log}`);
    }

    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return program;
  }

  const splatProgram = createProgramFromSources(SPLAT_VS, SPLAT_FS);
  const normalizeProgram = createProgramFromSources(NORMALIZE_VS, NORMALIZE_FS);

  // Get uniform/attrib locations
  const splatLocs = {
    a_position: gl.getAttribLocation(splatProgram, 'a_position'),
    a_cornerIndex: gl.getAttribLocation(splatProgram, 'a_cornerIndex'),
    u_gridSize: gl.getUniformLocation(splatProgram, 'u_gridSize'),
    u_atlasWidth: gl.getUniformLocation(splatProgram, 'u_atlasWidth'),
    u_atlasHeight: gl.getUniformLocation(splatProgram, 'u_atlasHeight'),
    u_slicesPerRow: gl.getUniformLocation(splatProgram, 'u_slicesPerRow'),
  };

  const normalizeLocs = {
    a_position: gl.getAttribLocation(normalizeProgram, 'a_position'),
    u_atlas: gl.getUniformLocation(normalizeProgram, 'u_atlas'),
    u_maxValue: gl.getUniformLocation(normalizeProgram, 'u_maxValue'),
    u_gamma: gl.getUniformLocation(normalizeProgram, 'u_gamma'),
  };

  // Corner index buffer (0-7 for each instance)
  const cornerBuffer = gl.createBuffer();
  if (!cornerBuffer) {
    throw new Error('Smoke density corner-buffer allocation failed.');
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]), gl.STATIC_DRAW);

  // Fullscreen quad for normalize pass
  const quadBuffer = gl.createBuffer();
  if (!quadBuffer) {
    gl.deleteBuffer(cornerBuffer);
    throw new Error('Smoke density quad-buffer allocation failed.');
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

  const resources = {
    gl,
    splatProgram,
    normalizeProgram,
    splatLocs,
    normalizeLocs,
    cornerBuffer,
    quadBuffer,
  };
  gpuSplatResourcesByContext.set(gl, resources);
  return resources;
}

/**
 * GPU-accelerated density volume building.
 * ~10-100x faster than CPU for large point counts.
 */
export function buildDensityVolumeGPU(gl, positions, options = {}) {
  if (!gl || typeof gl !== 'object') {
    throw new TypeError('GPU smoke density requires a WebGL2 rendering context.');
  }
  if (
    !(positions instanceof Float32Array) ||
    positions.length === 0 ||
    positions.length % 3 !== 0
  ) {
    throw new TypeError(
      'GPU smoke density positions must be a non-empty Float32Array with exactly three values per point.'
    );
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('GPU smoke density options must be an object.');
  }
  const gridSize = Object.hasOwn(options, 'gridSize') ? options.gridSize : 128;
  if (!Number.isInteger(gridSize) || gridSize < 8) {
    throw new RangeError('GPU smoke density gridSize must be an integer of at least 8.');
  }
  const gamma = Object.hasOwn(options, 'gamma') ? options.gamma : 0.75;
  if (typeof gamma !== 'number' || !Number.isFinite(gamma) || gamma <= 0) {
    throw new RangeError('GPU smoke density gamma must be a finite positive number.');
  }
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error(
      'GPU smoke density requires EXT_color_buffer_float for exact R32F accumulation.'
    );
  }
  const pointCount = positions.length / 3;
  const halfExtent = 1.0;

  // Show notification for smoke density computation
  const notifications = getNotificationCenter();
  const notifId = notifications.startCalculation(
    `Building ${gridSize}³ smoke density volume`,
    'render'
  );
  const startTime = performance.now();

  console.time('GPU density splat');

  const res = getOrCreateGPUSplatResources(gl);

  // Calculate atlas dimensions (Z slices in a grid)
  const slicesPerRow = Math.ceil(Math.sqrt(gridSize));
  const numRows = Math.ceil(gridSize / slicesPerRow);
  const atlasWidth = gridSize * slicesPerRow;
  const atlasHeight = gridSize * numRows;

  // Save GL state
  const prevFBO = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const prevViewport = gl.getParameter(gl.VIEWPORT);
  const prevBlend = gl.isEnabled(gl.BLEND);
  const prevBlendSrc = gl.getParameter(gl.BLEND_SRC_RGB);
  const prevBlendDst = gl.getParameter(gl.BLEND_DST_RGB);

  // Create atlas texture for accumulation (float32 for precision)
  const atlasTexture = gl.createTexture();
  if (!atlasTexture) {
    notifications.failCalculation(notifId, 'Smoke density texture allocation failed');
    throw new Error('GPU smoke density atlas texture allocation failed.');
  }
  gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, atlasWidth, atlasHeight, 0, gl.RED, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Create framebuffer
  const fbo = gl.createFramebuffer();
  if (!fbo) {
    gl.deleteTexture(atlasTexture);
    notifications.failCalculation(notifId, 'Smoke density framebuffer allocation failed');
    throw new Error('GPU smoke density framebuffer allocation failed.');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, atlasTexture, 0);

  // Check FBO completeness
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFBO);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    gl.deleteTexture(atlasTexture);
    gl.deleteFramebuffer(fbo);
    console.timeEnd('GPU density splat');
    notifications.failCalculation(notifId, 'Smoke density framebuffer is incomplete');
    throw new Error('GPU smoke density R32F framebuffer is incomplete.');
  }

  // Clear to zero
  gl.viewport(0, 0, atlasWidth, atlasHeight);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // Upload positions to GPU
  const positionBuffer = gl.createBuffer();
  if (!positionBuffer) {
    throw new Error('GPU smoke density position-buffer allocation failed.');
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

  // Create VAO for splatting
  const vao = gl.createVertexArray();
  if (!vao) {
    gl.deleteBuffer(positionBuffer);
    throw new Error('GPU smoke density VAO allocation failed.');
  }
  gl.bindVertexArray(vao);

  // Position attribute (per-vertex, advances every instance)
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.enableVertexAttribArray(res.splatLocs.a_position);
  gl.vertexAttribPointer(res.splatLocs.a_position, 3, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(res.splatLocs.a_position, 1); // one position per 8 instances

  // Corner index attribute (cycles 0-7)
  gl.bindBuffer(gl.ARRAY_BUFFER, res.cornerBuffer);
  gl.enableVertexAttribArray(res.splatLocs.a_cornerIndex);
  gl.vertexAttribPointer(res.splatLocs.a_cornerIndex, 1, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(res.splatLocs.a_cornerIndex, 0); // per-vertex (cycles through 8)

  // Splatting pass with additive blending
  gl.useProgram(res.splatProgram);
  gl.uniform1f(res.splatLocs.u_gridSize, gridSize);
  gl.uniform1f(res.splatLocs.u_atlasWidth, atlasWidth);
  gl.uniform1f(res.splatLocs.u_atlasHeight, atlasHeight);
  gl.uniform1f(res.splatLocs.u_slicesPerRow, slicesPerRow);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE); // Additive blending

  // Draw: 8 vertices per point (one per corner), instanced by point count
  gl.drawArraysInstanced(gl.POINTS, 0, 8, pointCount);

  gl.bindVertexArray(null);
  gl.deleteVertexArray(vao);
  gl.deleteBuffer(positionBuffer);

  // Read back atlas to find max value (needed for normalization)
  const atlasData = new Float32Array(atlasWidth * atlasHeight);
  gl.readPixels(0, 0, atlasWidth, atlasHeight, gl.RED, gl.FLOAT, atlasData);

  let maxVal = 0;
  for (let i = 0; i < atlasData.length; i++) {
    if (atlasData[i] > maxVal) maxVal = atlasData[i];
  }
  if (!(maxVal > 0)) {
    throw new Error('GPU smoke density produced an empty accumulation volume.');
  }

  // Create normalized texture for final output
  const normalizedTexture = gl.createTexture();
  if (!normalizedTexture) {
    throw new Error('GPU smoke density normalized-texture allocation failed.');
  }
  gl.bindTexture(gl.TEXTURE_2D, normalizedTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, atlasWidth, atlasHeight, 0, gl.RED, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  // Normalization pass
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, normalizedTexture, 0);
  gl.viewport(0, 0, atlasWidth, atlasHeight);

  gl.useProgram(res.normalizeProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
  gl.uniform1i(res.normalizeLocs.u_atlas, 0);
  gl.uniform1f(res.normalizeLocs.u_maxValue, maxVal);
  gl.uniform1f(res.normalizeLocs.u_gamma, gamma);

  gl.disable(gl.BLEND);

  // Draw fullscreen quad
  const quadVao = gl.createVertexArray();
  if (!quadVao) {
    throw new Error('GPU smoke density normalization VAO allocation failed.');
  }
  gl.bindVertexArray(quadVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, res.quadBuffer);
  gl.enableVertexAttribArray(res.normalizeLocs.a_position);
  gl.vertexAttribPointer(res.normalizeLocs.a_position, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  gl.deleteVertexArray(quadVao);

  // Read back normalized data
  const normalizedData = new Float32Array(atlasWidth * atlasHeight);
  gl.readPixels(0, 0, atlasWidth, atlasHeight, gl.RED, gl.FLOAT, normalizedData);

  // Extract 3D volume from atlas
  const volume = new Float32Array(gridSize * gridSize * gridSize);
  for (let z = 0; z < gridSize; z++) {
    const sliceRow = Math.floor(z / slicesPerRow);
    const sliceCol = z % slicesPerRow;
    const baseX = sliceCol * gridSize;
    const baseY = sliceRow * gridSize;

    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const atlasIdx = (baseY + y) * atlasWidth + (baseX + x);
        const volIdx = x + gridSize * (y + gridSize * z);
        volume[volIdx] = normalizedData[atlasIdx];
      }
    }
  }

  // Cleanup
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFBO);
  gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
  if (prevBlend) {
    gl.enable(gl.BLEND);
    gl.blendFunc(prevBlendSrc, prevBlendDst);
  } else {
    gl.disable(gl.BLEND);
  }

  gl.deleteTexture(atlasTexture);
  gl.deleteTexture(normalizedTexture);
  gl.deleteFramebuffer(fbo);

  console.timeEnd('GPU density splat');
  console.log(`[GPU Splat] ${pointCount} points -> ${gridSize}³ volume, max=${maxVal.toFixed(2)}`);

  // Complete notification
  const elapsed = performance.now() - startTime;
  notifications.completeCalculation(notifId, `Smoke density ready (${gridSize}³)`, elapsed);

  return {
    data: volume,
    gridSize,
    boundsMin: [-halfExtent, -halfExtent, -halfExtent],
    boundsMax: [ halfExtent,  halfExtent,  halfExtent]
  };
}

// ============================================================================
// Native 3D Texture (WebGL2) - Primary, high-performance path
// ============================================================================

export function createDensityTexture3D(gl, volumeDesc) {
  if (!gl || typeof gl !== 'object') {
    throw new TypeError('Smoke density texture creation requires WebGL2.');
  }
  if (
    volumeDesc === null ||
    typeof volumeDesc !== 'object' ||
    Array.isArray(volumeDesc) ||
    Object.getPrototypeOf(volumeDesc) !== Object.prototype ||
    Object.keys(volumeDesc).sort().join(',') !==
      'boundsMax,boundsMin,data,gridSize'
  ) {
    throw new TypeError(
      'Smoke density volume descriptor must contain exactly boundsMax, boundsMin, data, and gridSize.'
    );
  }
  const { data: volume, gridSize } = volumeDesc;
  if (!Number.isInteger(gridSize) || gridSize < 8) {
    throw new RangeError('Smoke density texture gridSize must be an integer of at least 8.');
  }
  if (
    !(volume instanceof Float32Array) ||
    volume.length !== gridSize * gridSize * gridSize
  ) {
    throw new TypeError(
      'Smoke density texture data must be an exact gridSize³ Float32Array.'
    );
  }

  // Convert float [0,1] to uint8 [0,255]
  const texData = new Uint8Array(gridSize * gridSize * gridSize);
  for (let i = 0; i < volume.length; i++) {
    const value = volume[i];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(
        `Smoke density texture value ${i} must be finite and between 0 and 1.`
      );
    }
    texData[i] = Math.floor(value * 255 + 0.5);
  }

  const priorError = gl.getError();
  if (priorError !== gl.NO_ERROR) {
    throw new Error(
      `Smoke density texture cannot start while WebGL error 0x${priorError.toString(16)} is pending.`
    );
  }
  const previousBinding = gl.getParameter(gl.TEXTURE_BINDING_3D);
  const previousAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error('Smoke density 3D texture allocation failed.');
  }
  try {
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.R8,
      gridSize, gridSize, gridSize,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      texData
    );

    gl.generateMipmap(gl.TEXTURE_3D);
    gl.texParameteri(
      gl.TEXTURE_3D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR
    );
    gl.texParameteri(
      gl.TEXTURE_3D,
      gl.TEXTURE_MAG_FILTER,
      gl.LINEAR
    );
    gl.texParameteri(
      gl.TEXTURE_3D,
      gl.TEXTURE_WRAP_S,
      gl.CLAMP_TO_EDGE
    );
    gl.texParameteri(
      gl.TEXTURE_3D,
      gl.TEXTURE_WRAP_T,
      gl.CLAMP_TO_EDGE
    );
    gl.texParameteri(
      gl.TEXTURE_3D,
      gl.TEXTURE_WRAP_R,
      gl.CLAMP_TO_EDGE
    );
    const uploadError = gl.getError();
    if (uploadError !== gl.NO_ERROR) {
      throw new Error(
        `Smoke density texture upload failed with WebGL error 0x${uploadError.toString(16)}.`
      );
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment);
    gl.bindTexture(gl.TEXTURE_3D, previousBinding);
  } catch (error) {
    const cleanupErrors = [];
    for (const cleanup of [
      () => gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment),
      () => gl.bindTexture(gl.TEXTURE_3D, previousBinding),
      () => gl.deleteTexture(texture),
    ]) {
      try {
        cleanup();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Smoke density texture upload failed and cleanup was incomplete.'
      );
    }
    throw error;
  }

  return {
    texture,
    gridSize,
    is3D: true
  };
}
