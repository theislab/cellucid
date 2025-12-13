// ============================================================================
// GPU-Accelerated Density Volume Splatting (WebGL2)
// ============================================================================

import { SPLAT_VS, SPLAT_FS, NORMALIZE_VS, NORMALIZE_FS } from '../shaders/density-shaders.js';
import { getNotificationCenter } from '../../app/notification-center.js';

// Cache for GPU splatting resources
let gpuSplatCache = null;

function getOrCreateGPUSplatResources(gl) {
  if (gpuSplatCache && gpuSplatCache.gl === gl) {
    return gpuSplatCache;
  }

  // Compile shaders
  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function createProgramFromSources(vsSource, fsSource) {
    const vs = compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return null;

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }

    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return program;
  }

  const splatProgram = createProgramFromSources(SPLAT_VS, SPLAT_FS);
  const normalizeProgram = createProgramFromSources(NORMALIZE_VS, NORMALIZE_FS);

  if (!splatProgram || !normalizeProgram) {
    console.error('Failed to create GPU splat programs');
    return null;
  }

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
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]), gl.STATIC_DRAW);

  // Fullscreen quad for normalize pass
  const quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

  gpuSplatCache = {
    gl,
    splatProgram,
    normalizeProgram,
    splatLocs,
    normalizeLocs,
    cornerBuffer,
    quadBuffer,
  };

  return gpuSplatCache;
}

/**
 * GPU-accelerated density volume building.
 * ~10-100x faster than CPU for large point counts.
 */
export function buildDensityVolumeGPU(gl, positions, options = {}) {
  const gridSize = Math.max(8, options.gridSize || 128);
  const gamma = options.gamma != null ? options.gamma : 0.75;
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
  if (!res) {
    console.warn('GPU splat failed, falling back to CPU');
    console.timeEnd('GPU density splat');
    const result = buildDensityVolume(positions, options);
    const elapsed = performance.now() - startTime;
    notifications.completeCalculation(notifId, 'Smoke density ready (CPU fallback)', elapsed);
    return result;
  }

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
  gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, atlasWidth, atlasHeight, 0, gl.RED, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Create framebuffer
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, atlasTexture, 0);

  // Check FBO completeness
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    console.error('Framebuffer incomplete for GPU splat');
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFBO);
    gl.deleteTexture(atlasTexture);
    gl.deleteFramebuffer(fbo);
    console.timeEnd('GPU density splat');
    const result = buildDensityVolume(positions, options);
    const elapsed = performance.now() - startTime;
    notifications.completeCalculation(notifId, 'Smoke density ready (CPU fallback)', elapsed);
    return result;
  }

  // Clear to zero
  gl.viewport(0, 0, atlasWidth, atlasHeight);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // Upload positions to GPU
  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions instanceof Float32Array ? positions : new Float32Array(positions), gl.STATIC_DRAW);

  // Create VAO for splatting
  const vao = gl.createVertexArray();
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

  // Create normalized texture for final output
  const normalizedTexture = gl.createTexture();
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
// CPU Density Volume (fallback)
// ============================================================================

// Build a 3D density volume (gridSize^3) from normalized positions in [-1, 1]^3.
// This runs once on the CPU and decouples rendering cost from number of points.
export function buildDensityVolume(positions, options = {}) {
  const gridSize = Math.max(8, options.gridSize || 128); // 128^3 default for sharper density
  const gamma = options.gamma != null ? options.gamma : 0.75; // contrast curve

  const pointCount = positions.length / 3;
  const volume = new Float32Array(gridSize * gridSize * gridSize);

  const halfExtent = 1.0;
  const minCoord = -halfExtent;
  const maxCoord = halfExtent;

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  // Map [-1, 1] -> [0, gridSize-1] and splat with trilinear weights
  for (let i = 0; i < pointCount; i++) {
    const x = positions[3 * i];
    const y = positions[3 * i + 1];
    const z = positions[3 * i + 2];

    // Skip extreme outliers just in case
    if (x < minCoord || x > maxCoord ||
        y < minCoord || y > maxCoord ||
        z < minCoord || z > maxCoord) {
      continue;
    }

    const fx = (x - minCoord) / (maxCoord - minCoord) * (gridSize - 1);
    const fy = (y - minCoord) / (maxCoord - minCoord) * (gridSize - 1);
    const fz = (z - minCoord) / (maxCoord - minCoord) * (gridSize - 1);

    const ix0 = clamp(Math.floor(fx), 0, gridSize - 1);
    const iy0 = clamp(Math.floor(fy), 0, gridSize - 1);
    const iz0 = clamp(Math.floor(fz), 0, gridSize - 1);

    const tx = fx - ix0;
    const ty = fy - iy0;
    const tz = fz - iz0;

    const ix1 = ix0 < gridSize - 1 ? ix0 + 1 : ix0;
    const iy1 = iy0 < gridSize - 1 ? iy0 + 1 : iy0;
    const iz1 = iz0 < gridSize - 1 ? iz0 + 1 : iz0;

    const wx0 = 1.0 - tx, wx1 = tx;
    const wy0 = 1.0 - ty, wy1 = ty;
    const wz0 = 1.0 - tz, wz1 = tz;

    function add(ix, iy, iz, w) {
      const idx = ix + gridSize * (iy + gridSize * iz);
      volume[idx] += w;
    }

    add(ix0, iy0, iz0, wx0 * wy0 * wz0);
    add(ix1, iy0, iz0, wx1 * wy0 * wz0);
    add(ix0, iy1, iz0, wx0 * wy1 * wz0);
    add(ix1, iy1, iz0, wx1 * wy1 * wz0);
    add(ix0, iy0, iz1, wx0 * wy0 * wz1);
    add(ix1, iy0, iz1, wx1 * wy0 * wz1);
    add(ix0, iy1, iz1, wx0 * wy1 * wz1);
    add(ix1, iy1, iz1, wx1 * wy1 * wz1);
  }

  // Normalize to [0,1] and apply gamma to emphasize wispy low densities
  let maxVal = 0.0;
  for (let i = 0; i < volume.length; i++) {
    if (volume[i] > maxVal) maxVal = volume[i];
  }
  if (maxVal > 0) {
    const invMax = 1.0 / maxVal;
    for (let i = 0; i < volume.length; i++) {
      const d = volume[i] * invMax;
      volume[i] = Math.pow(d, gamma);
    }
  }

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
  const { data: volume, gridSize } = volumeDesc;

  // Convert float [0,1] to uint8 [0,255]
  const texData = new Uint8Array(gridSize * gridSize * gridSize);
  for (let i = 0; i < volume.length; i++) {
    texData[i] = Math.max(0, Math.min(255, Math.floor(volume[i] * 255 + 0.5)));
  }

  const texture = gl.createTexture();
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

  // Generate mipmaps for hierarchical sampling (used in empty space skipping)
  gl.generateMipmap(gl.TEXTURE_3D);

  // Trilinear filtering
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

  return {
    texture,
    gridSize,
    is3D: true
  };
}

