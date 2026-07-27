// ============================================================================
// GPU-Accelerated Density Volume Splatting (WebGL2)
// ============================================================================

import {
  NORMALIZE_FS,
  NORMALIZE_VS,
  REDUCE_MAX_FS,
  SPLAT_FS,
  SPLAT_VS,
} from '../shaders/density-shaders.js';
import { MAX_SMOKE_GRID_SIZE } from './smoke-density-contract.js';

const gpuSplatResourcesByContext = new WeakMap();
export const MAX_SPLAT_POINTS_PER_BATCH = 262_144;
const MIN_NORMAL_FLOAT32 = 2 ** -126;

function deleteCachedGPUSplatResources(gl, resources) {
  const failures = [];
  for (const buffer of [resources.cornerBuffer, resources.quadBuffer]) {
    try {
      gl.deleteBuffer(buffer);
    } catch (error) {
      failures.push(asError(
        error,
        'Smoke density cached-buffer cleanup failed with a non-Error value.'
      ));
    }
  }
  for (const program of [
    resources.splatProgram,
    resources.reduceMaxProgram,
    resources.normalizeProgram,
  ]) {
    try {
      gl.deleteProgram(program);
    } catch (error) {
      failures.push(asError(
        error,
        'Smoke density cached-program cleanup failed with a non-Error value.'
      ));
    }
  }
  gpuSplatResourcesByContext.delete(gl);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'Smoke density cached-resource cleanup was incomplete.'
    );
  }
}

function cachedGPUSplatResourcesAreCurrent(gl, resources) {
  return (
    gl.isProgram(resources.splatProgram)
    && gl.isProgram(resources.reduceMaxProgram)
    && gl.isProgram(resources.normalizeProgram)
    && gl.isBuffer(resources.cornerBuffer)
    && gl.isBuffer(resources.quadBuffer)
  );
}

export function disposeDensityPipelineResources(gl) {
  if (!gl || typeof gl !== 'object') {
    throw new TypeError(
      'Smoke density resource disposal requires a WebGL2 rendering context.'
    );
  }
  const resources = gpuSplatResourcesByContext.get(gl);
  if (!resources) return false;
  deleteCachedGPUSplatResources(gl, resources);
  return true;
}

export function invalidateDensityPipelineResources(gl) {
  if (!gl || typeof gl !== 'object') {
    throw new TypeError(
      'Smoke density resource invalidation requires a WebGL2 rendering context.'
    );
  }
  return gpuSplatResourcesByContext.delete(gl);
}

function getOrCreateGPUSplatResources(gl) {
  const cached = gpuSplatResourcesByContext.get(gl);
  if (cached) {
    if (cachedGPUSplatResourcesAreCurrent(gl, cached)) return cached;
    // A restored WebGL context invalidates every pre-loss object. Those handles
    // no longer belong to the current object namespace and must not be deleted
    // through it; dropping the cache lets the browser reclaim them with the
    // lost context and forces exact resource recreation below.
    gpuSplatResourcesByContext.delete(gl);
  }
  const createdPrograms = [];
  const createdBuffers = [];

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
    let vertexShader = null;
    let fragmentShader = null;
    let program = null;
    try {
      vertexShader = compileShader(gl.VERTEX_SHADER, vsSource);
      fragmentShader = compileShader(gl.FRAGMENT_SHADER, fsSource);
      program = gl.createProgram();
      if (!program) {
        throw new Error('Smoke density program allocation failed.');
      }
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program);
        throw new Error(`Smoke density program linking failed: ${log}`);
      }
      createdPrograms.push(program);
      return program;
    } catch (error) {
      if (program !== null) gl.deleteProgram(program);
      throw error;
    } finally {
      if (vertexShader !== null) gl.deleteShader(vertexShader);
      if (fragmentShader !== null) gl.deleteShader(fragmentShader);
    }
  }

  function requireAttribute(program, name) {
    const location = gl.getAttribLocation(program, name);
    if (!Number.isInteger(location) || location < 0) {
      throw new Error(`Smoke density attribute ${name} is unavailable.`);
    }
    return location;
  }

  function requireUniform(program, name) {
    const location = gl.getUniformLocation(program, name);
    if (location === null) {
      throw new Error(`Smoke density uniform ${name} is unavailable.`);
    }
    return location;
  }

  function requireCurrentBufferStore(expectedBytes, label) {
    const uploadErrors = collectWebGLErrors(gl);
    if (uploadErrors.length > 0) {
      throw new Error(
        `Smoke density ${label} upload produced WebGL error(s) ${formatWebGLErrors(uploadErrors)}.`
      );
    }
    const actualBytes = gl.getBufferParameter(
      gl.ARRAY_BUFFER,
      gl.BUFFER_SIZE
    );
    const queryErrors = collectWebGLErrors(gl);
    if (queryErrors.length > 0) {
      throw new Error(
        `Smoke density ${label} validation produced WebGL error(s) ${formatWebGLErrors(queryErrors)}.`
      );
    }
    if (actualBytes !== expectedBytes) {
      throw new Error(
        `Smoke density ${label} store is ${actualBytes} bytes; expected exactly ${expectedBytes}.`
      );
    }
  }

  try {
    const splatProgram = createProgramFromSources(SPLAT_VS, SPLAT_FS);
    const reduceMaxProgram = createProgramFromSources(
      NORMALIZE_VS,
      REDUCE_MAX_FS
    );
    const normalizeProgram = createProgramFromSources(
      NORMALIZE_VS,
      NORMALIZE_FS
    );
    const splatLocs = {
      a_position: requireAttribute(splatProgram, 'a_position'),
      a_cornerIndex: requireAttribute(splatProgram, 'a_cornerIndex'),
      u_gridSize: requireUniform(splatProgram, 'u_gridSize'),
      u_atlasWidth: requireUniform(splatProgram, 'u_atlasWidth'),
      u_atlasHeight: requireUniform(splatProgram, 'u_atlasHeight'),
      u_slicesPerRow: requireUniform(splatProgram, 'u_slicesPerRow'),
    };
    const reduceMaxLocs = {
      a_position: requireAttribute(reduceMaxProgram, 'a_position'),
      u_input: requireUniform(reduceMaxProgram, 'u_input'),
      u_inputSize: requireUniform(reduceMaxProgram, 'u_inputSize'),
    };
    const normalizeLocs = {
      a_position: requireAttribute(normalizeProgram, 'a_position'),
      u_atlas: requireUniform(normalizeProgram, 'u_atlas'),
      u_maxAtlas: requireUniform(normalizeProgram, 'u_maxAtlas'),
      u_gamma: requireUniform(normalizeProgram, 'u_gamma'),
    };

    const cornerBuffer = gl.createBuffer();
    if (!cornerBuffer) {
      throw new Error('Smoke density corner-buffer allocation failed.');
    }
    createdBuffers.push(cornerBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]),
      gl.STATIC_DRAW
    );
    requireCurrentBufferStore(
      8 * Float32Array.BYTES_PER_ELEMENT,
      'corner buffer'
    );

    const quadBuffer = gl.createBuffer();
    if (!quadBuffer) {
      throw new Error('Smoke density quad-buffer allocation failed.');
    }
    createdBuffers.push(quadBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    requireCurrentBufferStore(
      8 * Float32Array.BYTES_PER_ELEMENT,
      'quad buffer'
    );

    const initializationErrors = collectWebGLErrors(gl);
    if (initializationErrors.length > 0) {
      throw new Error(
        `Smoke density pipeline initialization produced WebGL error(s) ${formatWebGLErrors(initializationErrors)}.`
      );
    }

    const resources = {
      gl,
      splatProgram,
      reduceMaxProgram,
      normalizeProgram,
      splatLocs,
      reduceMaxLocs,
      normalizeLocs,
      cornerBuffer,
      quadBuffer,
    };
    gpuSplatResourcesByContext.set(gl, resources);
    return resources;
  } catch (error) {
    const failures = [asError(
      error,
      'Smoke density pipeline initialization failed with a non-Error value.'
    )];
    deleteResources(
      gl,
      createdBuffers,
      'deleteBuffer',
      failures,
      'cached buffer'
    );
    deleteResources(
      gl,
      createdPrograms,
      'deleteProgram',
      failures,
      'cached program'
    );
    const cleanupErrors = collectWebGLErrors(gl);
    if (cleanupErrors.length > 0) {
      failures.push(new Error(
        `Smoke density pipeline cleanup produced WebGL error(s) ${formatWebGLErrors(cleanupErrors)}.`
      ));
    }
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(
      failures,
      'Smoke density pipeline initialization and cleanup failed.'
    );
  }
}

function captureTextureBindings(gl) {
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
  const units = [gl.TEXTURE0, gl.TEXTURE1];
  if (!units.includes(activeTexture)) units.push(activeTexture);
  const bindings = [];
  for (const unit of units) {
    gl.activeTexture(unit);
    bindings.push({
      unit,
      sampler: gl.getParameter(gl.SAMPLER_BINDING),
      texture2D: gl.getParameter(gl.TEXTURE_BINDING_2D),
      texture3D: gl.getParameter(gl.TEXTURE_BINDING_3D),
    });
  }
  gl.activeTexture(activeTexture);
  return { activeTexture, bindings };
}

function capturePipelineState(gl) {
  const textures = captureTextureBindings(gl);
  return {
    activeTexture: textures.activeTexture,
    arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
    blend: gl.isEnabled(gl.BLEND),
    blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
    blendDstRgb: gl.getParameter(gl.BLEND_DST_RGB),
    blendEquationAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA),
    blendEquationRgb: gl.getParameter(gl.BLEND_EQUATION_RGB),
    blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA),
    blendSrcRgb: gl.getParameter(gl.BLEND_SRC_RGB),
    clearColor: Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE)),
    colorMask: Array.from(gl.getParameter(gl.COLOR_WRITEMASK)),
    cullFace: gl.isEnabled(gl.CULL_FACE),
    depthTest: gl.isEnabled(gl.DEPTH_TEST),
    dither: gl.isEnabled(gl.DITHER),
    drawFramebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
    program: gl.getParameter(gl.CURRENT_PROGRAM),
    rasterizerDiscard: gl.isEnabled(gl.RASTERIZER_DISCARD),
    readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
    scissorTest: gl.isEnabled(gl.SCISSOR_TEST),
    stencilTest: gl.isEnabled(gl.STENCIL_TEST),
    textureBindings: textures.bindings,
    vertexArray: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
  };
}

function restoreCapability(gl, capability, enabled) {
  if (enabled) gl.enable(capability);
  else gl.disable(capability);
}

function restorePipelineState(gl, state) {
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.drawFramebuffer);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.readFramebuffer);
  gl.viewport(...state.viewport);
  gl.clearColor(...state.clearColor);
  gl.colorMask(...state.colorMask);
  gl.blendFuncSeparate(
    state.blendSrcRgb,
    state.blendDstRgb,
    state.blendSrcAlpha,
    state.blendDstAlpha
  );
  gl.blendEquationSeparate(
    state.blendEquationRgb,
    state.blendEquationAlpha
  );
  restoreCapability(gl, gl.BLEND, state.blend);
  restoreCapability(gl, gl.CULL_FACE, state.cullFace);
  restoreCapability(gl, gl.DEPTH_TEST, state.depthTest);
  restoreCapability(gl, gl.DITHER, state.dither);
  restoreCapability(gl, gl.RASTERIZER_DISCARD, state.rasterizerDiscard);
  restoreCapability(gl, gl.SCISSOR_TEST, state.scissorTest);
  restoreCapability(gl, gl.STENCIL_TEST, state.stencilTest);
  gl.useProgram(state.program);
  gl.bindVertexArray(state.vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.arrayBuffer);
  for (const binding of state.textureBindings) {
    gl.activeTexture(binding.unit);
    gl.bindTexture(gl.TEXTURE_2D, binding.texture2D);
    gl.bindTexture(gl.TEXTURE_3D, binding.texture3D);
    gl.bindSampler(binding.unit - gl.TEXTURE0, binding.sampler);
  }
  gl.activeTexture(state.activeTexture);
}

function createAtlasTexture(gl, internalFormat, width, height, type) {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error('GPU smoke density atlas texture allocation failed.');
  }
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      internalFormat,
      width,
      height,
      0,
      gl.RED,
      type,
      null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  } catch (error) {
    gl.deleteTexture(texture);
    throw error;
  }
}

function attachColorTarget(gl, framebuffer, texture, label) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0
  );
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`GPU smoke density ${label} framebuffer is incomplete.`);
  }
}

function createQuadVertexArray(gl, buffer, attributeLocation, label) {
  if (!Number.isInteger(attributeLocation) || attributeLocation < 0) {
    throw new Error(`GPU smoke density ${label} position attribute is unavailable.`);
  }
  const vertexArray = gl.createVertexArray();
  if (!vertexArray) {
    throw new Error(`GPU smoke density ${label} VAO allocation failed.`);
  }
  try {
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(attributeLocation);
    gl.vertexAttribPointer(attributeLocation, 2, gl.FLOAT, false, 0, 0);
    return vertexArray;
  } catch (error) {
    gl.deleteVertexArray(vertexArray);
    throw error;
  }
}

function requireExactPositionArray(positions) {
  if (
    !(positions instanceof Float32Array)
    || positions.length === 0
    || positions.length % 3 !== 0
  ) {
    throw new TypeError(
      'GPU smoke density positions must be a non-empty Float32Array with exactly three values per point.'
    );
  }
}

function requireExactVisibility(visibility, pointCount) {
  if (visibility === null) return null;
  if (
    typeof visibility !== 'object'
    || Array.isArray(visibility)
    || Object.getPrototypeOf(visibility) !== Object.prototype
    || Object.keys(visibility).sort().join(',') !==
      'alpha,outlierQuantiles,outlierThreshold'
  ) {
    throw new TypeError(
      'GPU smoke density visibility must be null or contain exactly alpha, outlierQuantiles, and outlierThreshold.'
    );
  }
  if (
    !(visibility.alpha instanceof Float32Array)
    || visibility.alpha.length !== pointCount
  ) {
    throw new TypeError(
      'GPU smoke density visibility alpha must be an exact point-count Float32Array.'
    );
  }
  const hasOutliers = visibility.outlierQuantiles !== null;
  if (
    hasOutliers
    && (
      !(visibility.outlierQuantiles instanceof Float32Array)
      || visibility.outlierQuantiles.length !== pointCount
    )
  ) {
    throw new TypeError(
      'GPU smoke density outlier quantiles must be null or an exact point-count Float32Array.'
    );
  }
  if (
    hasOutliers
    && (
      typeof visibility.outlierThreshold !== 'number'
      || !Number.isFinite(visibility.outlierThreshold)
      || visibility.outlierThreshold < 0
      || visibility.outlierThreshold > 1
    )
  ) {
    throw new RangeError(
      'GPU smoke density outlier threshold must be between 0 and 1 when quantiles are active.'
    );
  }
  if (!hasOutliers && visibility.outlierThreshold !== null) {
    throw new TypeError(
      'GPU smoke density outlier threshold must be null when quantiles are inactive.'
    );
  }
  return visibility;
}

function inspectDensitySource(positions, visibility) {
  const pointCount = positions.length / 3;
  const alpha = visibility?.alpha ?? null;
  const outlierQuantiles = visibility?.outlierQuantiles ?? null;
  const outlierThreshold = visibility?.outlierThreshold ?? null;
  let containsVisibleInBoundsPoint = false;
  let visiblePointCount = 0;

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    const positionIndex = pointIndex * 3;
    const x = positions[positionIndex];
    const y = positions[positionIndex + 1];
    const z = positions[positionIndex + 2];
    if (!Number.isFinite(x)) {
      throw new RangeError(
        `GPU smoke density position component ${positionIndex} must be finite.`
      );
    }
    if (!Number.isFinite(y)) {
      throw new RangeError(
        `GPU smoke density position component ${positionIndex + 1} must be finite.`
      );
    }
    if (!Number.isFinite(z)) {
      throw new RangeError(
        `GPU smoke density position component ${positionIndex + 2} must be finite.`
      );
    }

    let visible = true;
    if (alpha !== null) {
      const alphaValue = alpha[pointIndex];
      if (
        !Number.isFinite(alphaValue)
        || alphaValue < 0
        || alphaValue > 1
      ) {
        throw new RangeError(
          `GPU smoke density visibility alpha ${pointIndex} must be finite and between 0 and 1.`
        );
      }
      visible = alphaValue > 0.001;
    }
    if (outlierQuantiles !== null) {
      const quantile = outlierQuantiles[pointIndex];
      if (
        !Number.isFinite(quantile)
        || quantile < -1
        || quantile > 1
      ) {
        throw new RangeError(
          `GPU smoke density outlier quantile ${pointIndex} must be finite and between -1 and 1.`
        );
      }
      if (visible && quantile >= 0 && quantile > outlierThreshold) {
        visible = false;
      }
    }
    if (!visible) continue;

    visiblePointCount++;
    if (
      x >= -1
      && x <= 1
      && y >= -1
      && y <= 1
      && z >= -1
      && z <= 1
    ) {
      containsVisibleInBoundsPoint = true;
    }
  }

  if (visiblePointCount > 0 && !containsVisibleInBoundsPoint) {
    throw new RangeError(
      'GPU smoke density requires at least one visible point inside the exact [-1, 1] volume.'
    );
  }
  return visiblePointCount;
}

function collectWebGLErrors(gl) {
  const errors = [];
  let errorCode = gl.getError();
  while (errorCode !== gl.NO_ERROR) {
    errors.push(errorCode);
    errorCode = gl.getError();
  }
  return errors;
}

function formatWebGLErrors(errorCodes) {
  return errorCodes
    .map(errorCode => `0x${errorCode.toString(16)}`)
    .join(', ');
}

function asError(value, message) {
  return value instanceof Error ? value : new Error(message);
}

function deleteResources(gl, resources, deleteMethod, failures, label) {
  for (const resource of resources) {
    if (resource === null) continue;
    try {
      gl[deleteMethod](resource);
    } catch (error) {
      failures.push(asError(
        error,
        `GPU smoke density ${label} cleanup failed with a non-Error value.`
      ));
    }
  }
}

function releaseTrackedResource(gl, resources, resource, deleteMethod, label) {
  const index = resources.indexOf(resource);
  if (index < 0) {
    throw new Error(
      `GPU smoke density ${label} is not owned by the active build transaction.`
    );
  }
  gl[deleteMethod](resource);
  resources.splice(index, 1);
}

/**
 * Builds one native R8 density texture without synchronizing pixels through
 * JavaScript. All intermediate work stays on the GPU:
 * R32F splat atlas -> max reduction -> normalized R8 atlas -> 3D slice copies.
 *
 * The caller must provide a clean WebGL error state. Every mutable binding and
 * capability touched by this transaction is restored on success and failure;
 * WebGL's consumable error queue is validated and reported, not restorable.
 *
 * Ownership of a returned candidate texture transfers to the caller. The
 * caller must either publish it into one renderer owner or delete it. A null
 * result exactly represents a valid source with no visible points.
 */
export function buildDensityTextureGPU(gl, positions, options = {}) {
  if (!gl || typeof gl !== 'object') {
    throw new TypeError('GPU smoke density requires a WebGL2 rendering context.');
  }
  requireExactPositionArray(positions);
  if (
    !options
    || typeof options !== 'object'
    || Array.isArray(options)
    || Object.getPrototypeOf(options) !== Object.prototype
  ) {
    throw new TypeError('GPU smoke density options must be one exact plain object.');
  }
  const optionKeys = Object.keys(options);
  const unexpectedOption = optionKeys.find(
    key => key !== 'gamma' && key !== 'gridSize' && key !== 'visibility'
  );
  if (unexpectedOption !== undefined) {
    throw new RangeError(
      `GPU smoke density option "${unexpectedOption}" is unknown.`
    );
  }
  const gridSize = Object.hasOwn(options, 'gridSize') ? options.gridSize : 128;
  if (
    !Number.isInteger(gridSize)
    || gridSize < 8
    || gridSize > MAX_SMOKE_GRID_SIZE
  ) {
    throw new RangeError(
      `GPU smoke density gridSize must be an integer from 8 through ${MAX_SMOKE_GRID_SIZE}.`
    );
  }
  const gamma = Object.hasOwn(options, 'gamma') ? options.gamma : 0.75;
  if (typeof gamma !== 'number' || !Number.isFinite(gamma)) {
    throw new RangeError(
      'GPU smoke density gamma must remain a finite positive normal Float32 value.'
    );
  }
  const gammaFloat32 = Math.fround(gamma);
  if (!Number.isFinite(gammaFloat32) || gammaFloat32 < MIN_NORMAL_FLOAT32) {
    throw new RangeError(
      'GPU smoke density gamma must remain a finite positive normal Float32 value.'
    );
  }
  const pointCount = positions.length / 3;
  const visibility = requireExactVisibility(
    Object.hasOwn(options, 'visibility') ? options.visibility : null,
    pointCount
  );
  const visiblePointCount = inspectDensitySource(positions, visibility);
  if (visiblePointCount === 0) return null;
  if (typeof gl.isContextLost !== 'function') {
    throw new TypeError(
      'GPU smoke density requires the exact WebGL2 context-loss contract.'
    );
  }
  if (gl.isContextLost()) {
    throw new Error(
      'GPU smoke density cannot build while the WebGL2 context is lost.'
    );
  }
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error(
      'GPU smoke density requires EXT_color_buffer_float for exact R32F accumulation.'
    );
  }
  if (!gl.getExtension('EXT_float_blend')) {
    throw new Error(
      'GPU smoke density requires EXT_float_blend for exact R32F accumulation.'
    );
  }
  const priorErrors = collectWebGLErrors(gl);
  if (priorErrors.length > 0) {
    throw new Error(
      `GPU smoke density requires a clean WebGL error state; clear pending error(s) ${formatWebGLErrors(priorErrors)} before building.`
    );
  }

  const slicesPerRow = Math.ceil(Math.sqrt(gridSize));
  const numRows = Math.ceil(gridSize / slicesPerRow);
  const atlasWidth = gridSize * slicesPerRow;
  const atlasHeight = gridSize * numRows;
  const maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const maximumTexture3DSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
  if (
    !Number.isInteger(maximumTextureSize)
    || maximumTextureSize < 1
    || !Number.isInteger(maximumTexture3DSize)
    || maximumTexture3DSize < 1
  ) {
    throw new Error('GPU smoke density received invalid WebGL texture limits.');
  }
  if (gridSize > maximumTexture3DSize) {
    throw new RangeError(
      `GPU smoke density gridSize ${gridSize} exceeds MAX_3D_TEXTURE_SIZE ${maximumTexture3DSize}.`
    );
  }
  if (
    atlasWidth > maximumTextureSize
    || atlasHeight > maximumTextureSize
  ) {
    throw new RangeError(
      `GPU smoke density ${atlasWidth}×${atlasHeight} atlas exceeds MAX_TEXTURE_SIZE ${maximumTextureSize}.`
    );
  }
  const previousState = capturePipelineState(gl);
  const startTime = performance.now();
  const transientTextures = [];
  const transientBuffers = [];
  const transientVertexArrays = [];
  const transientFramebuffers = [];
  let candidateTexture = null;
  let result = null;
  let primaryFailure = null;

  try {
    const resources = getOrCreateGPUSplatResources(gl);
    for (const capability of [
      gl.CULL_FACE,
      gl.DEPTH_TEST,
      gl.DITHER,
      gl.RASTERIZER_DISCARD,
      gl.SCISSOR_TEST,
      gl.STENCIL_TEST,
    ]) {
      gl.disable(capability);
    }
    gl.bindSampler(0, null);
    gl.bindSampler(1, null);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0);

    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) {
      throw new Error('GPU smoke density framebuffer allocation failed.');
    }
    transientFramebuffers.push(framebuffer);

    gl.activeTexture(gl.TEXTURE0);
    const accumulationAtlas = createAtlasTexture(
      gl,
      gl.R32F,
      atlasWidth,
      atlasHeight,
      gl.FLOAT
    );
    transientTextures.push(accumulationAtlas);
    attachColorTarget(
      gl,
      framebuffer,
      accumulationAtlas,
      'accumulation'
    );
    gl.viewport(0, 0, atlasWidth, atlasHeight);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const positionBuffer = gl.createBuffer();
    if (!positionBuffer) {
      throw new Error('GPU smoke density position-buffer allocation failed.');
    }
    transientBuffers.push(positionBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    const splatBatchCapacity = Math.min(
      visiblePointCount,
      MAX_SPLAT_POINTS_PER_BATCH
    );
    gl.bufferData(
      gl.ARRAY_BUFFER,
      splatBatchCapacity * 3 * Float32Array.BYTES_PER_ELEMENT,
      gl.STREAM_DRAW
    );

    const splatVertexArray = gl.createVertexArray();
    if (!splatVertexArray) {
      throw new Error('GPU smoke density splat VAO allocation failed.');
    }
    transientVertexArrays.push(splatVertexArray);
    gl.bindVertexArray(splatVertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(resources.splatLocs.a_position);
    gl.vertexAttribPointer(
      resources.splatLocs.a_position,
      3,
      gl.FLOAT,
      false,
      0,
      0
    );
    gl.vertexAttribDivisor(resources.splatLocs.a_position, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.cornerBuffer);
    gl.enableVertexAttribArray(resources.splatLocs.a_cornerIndex);
    gl.vertexAttribPointer(
      resources.splatLocs.a_cornerIndex,
      1,
      gl.FLOAT,
      false,
      0,
      0
    );
    gl.vertexAttribDivisor(resources.splatLocs.a_cornerIndex, 0);

    gl.useProgram(resources.splatProgram);
    gl.uniform1f(resources.splatLocs.u_gridSize, gridSize);
    gl.uniform1f(resources.splatLocs.u_atlasWidth, atlasWidth);
    gl.uniform1f(resources.splatLocs.u_atlasHeight, atlasHeight);
    gl.uniform1f(resources.splatLocs.u_slicesPerRow, slicesPerRow);
    gl.enable(gl.BLEND);
    gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);
    if (visiblePointCount === pointCount) {
      for (
        let pointOffset = 0;
        pointOffset < pointCount;
        pointOffset += MAX_SPLAT_POINTS_PER_BATCH
      ) {
        const batchPointCount = Math.min(
          MAX_SPLAT_POINTS_PER_BATCH,
          pointCount - pointOffset
        );
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          0,
          positions,
          pointOffset * 3,
          batchPointCount * 3
        );
        gl.drawArraysInstanced(
          gl.POINTS,
          0,
          8,
          batchPointCount
        );
      }
    } else {
      const batchPositions = new Float32Array(splatBatchCapacity * 3);
      const alpha = visibility.alpha;
      const outlierQuantiles = visibility.outlierQuantiles;
      const outlierThreshold = visibility.outlierThreshold;
      let batchPointCount = 0;
      let submittedPointCount = 0;
      for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
        if (alpha[pointIndex] <= 0.001) continue;
        if (outlierQuantiles !== null) {
          const quantile = outlierQuantiles[pointIndex];
          if (quantile >= 0 && quantile > outlierThreshold) continue;
        }
        const sourceOffset = pointIndex * 3;
        const batchOffset = batchPointCount * 3;
        batchPositions[batchOffset] = positions[sourceOffset];
        batchPositions[batchOffset + 1] = positions[sourceOffset + 1];
        batchPositions[batchOffset + 2] = positions[sourceOffset + 2];
        batchPointCount++;
        if (batchPointCount !== splatBatchCapacity) continue;

        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          0,
          batchPositions,
          0,
          batchPointCount * 3
        );
        gl.drawArraysInstanced(
          gl.POINTS,
          0,
          8,
          batchPointCount
        );
        submittedPointCount += batchPointCount;
        batchPointCount = 0;
      }
      if (batchPointCount > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          0,
          batchPositions,
          0,
          batchPointCount * 3
        );
        gl.drawArraysInstanced(
          gl.POINTS,
          0,
          8,
          batchPointCount
        );
        submittedPointCount += batchPointCount;
      }
      if (submittedPointCount !== visiblePointCount) {
        throw new Error(
          'GPU smoke density visibility changed during the build transaction.'
        );
      }
    }
    gl.disable(gl.BLEND);

    const reductionVertexArray = createQuadVertexArray(
      gl,
      resources.quadBuffer,
      resources.reduceMaxLocs.a_position,
      'max-reduction'
    );
    transientVertexArrays.push(reductionVertexArray);
    let reductionInput = accumulationAtlas;
    let reductionWidth = atlasWidth;
    let reductionHeight = atlasHeight;
    while (reductionWidth > 1 || reductionHeight > 1) {
      const previousReductionInput = reductionInput;
      const nextWidth = Math.ceil(reductionWidth / 2);
      const nextHeight = Math.ceil(reductionHeight / 2);
      gl.activeTexture(gl.TEXTURE0);
      const nextTexture = createAtlasTexture(
        gl,
        gl.R32F,
        nextWidth,
        nextHeight,
        gl.FLOAT
      );
      transientTextures.push(nextTexture);
      attachColorTarget(
        gl,
        framebuffer,
        nextTexture,
        'max-reduction'
      );
      gl.viewport(0, 0, nextWidth, nextHeight);
      gl.useProgram(resources.reduceMaxProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, reductionInput);
      gl.uniform1i(resources.reduceMaxLocs.u_input, 0);
      gl.uniform2i(
        resources.reduceMaxLocs.u_inputSize,
        reductionWidth,
        reductionHeight
      );
      gl.bindVertexArray(reductionVertexArray);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      reductionInput = nextTexture;
      reductionWidth = nextWidth;
      reductionHeight = nextHeight;
      if (previousReductionInput !== accumulationAtlas) {
        releaseTrackedResource(
          gl,
          transientTextures,
          previousReductionInput,
          'deleteTexture',
          'completed max-reduction texture'
        );
      }
    }
    const maximumTexture = reductionInput;

    gl.activeTexture(gl.TEXTURE0);
    const normalizedAtlas = createAtlasTexture(
      gl,
      gl.R8,
      atlasWidth,
      atlasHeight,
      gl.UNSIGNED_BYTE
    );
    transientTextures.push(normalizedAtlas);
    attachColorTarget(
      gl,
      framebuffer,
      normalizedAtlas,
      'normalized-atlas'
    );
    gl.viewport(0, 0, atlasWidth, atlasHeight);
    const normalizationVertexArray = createQuadVertexArray(
      gl,
      resources.quadBuffer,
      resources.normalizeLocs.a_position,
      'normalization'
    );
    transientVertexArrays.push(normalizationVertexArray);
    gl.useProgram(resources.normalizeProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, accumulationAtlas);
    gl.uniform1i(resources.normalizeLocs.u_atlas, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, maximumTexture);
    gl.uniform1i(resources.normalizeLocs.u_maxAtlas, 1);
    gl.uniform1f(resources.normalizeLocs.u_gamma, gammaFloat32);
    gl.bindVertexArray(normalizationVertexArray);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    releaseTrackedResource(
      gl,
      transientTextures,
      accumulationAtlas,
      'deleteTexture',
      'completed accumulation atlas'
    );
    releaseTrackedResource(
      gl,
      transientTextures,
      maximumTexture,
      'deleteTexture',
      'completed maximum texture'
    );

    candidateTexture = gl.createTexture();
    if (!candidateTexture) {
      throw new Error('GPU smoke density 3D texture allocation failed.');
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, candidateTexture);
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.R8,
      gridSize,
      gridSize,
      gridSize,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      null
    );
    gl.texParameteri(
      gl.TEXTURE_3D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR
    );
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
    for (let z = 0; z < gridSize; z++) {
      const sliceRow = Math.floor(z / slicesPerRow);
      const sliceColumn = z % slicesPerRow;
      gl.copyTexSubImage3D(
        gl.TEXTURE_3D,
        0,
        0,
        0,
        z,
        sliceColumn * gridSize,
        sliceRow * gridSize,
        gridSize,
        gridSize
      );
    }
    gl.generateMipmap(gl.TEXTURE_3D);

    const pipelineErrors = collectWebGLErrors(gl);
    if (pipelineErrors.length > 0) {
      throw new Error(
        `GPU smoke density publication failed with WebGL error(s) ${formatWebGLErrors(pipelineErrors)}.`
      );
    }
    result = Object.freeze({
      boundsMax: Object.freeze([1, 1, 1]),
      boundsMin: Object.freeze([-1, -1, -1]),
      gridSize,
      is3D: true,
      texture: candidateTexture,
    });
  } catch (error) {
    primaryFailure = asError(
      error,
      'GPU smoke density failed with a non-Error value.'
    );
  }

  const settlementFailures = [];
  deleteResources(
    gl,
    transientVertexArrays,
    'deleteVertexArray',
    settlementFailures,
    'vertex-array'
  );
  deleteResources(
    gl,
    transientBuffers,
    'deleteBuffer',
    settlementFailures,
    'buffer'
  );
  deleteResources(
    gl,
    transientTextures,
    'deleteTexture',
    settlementFailures,
    'texture'
  );
  deleteResources(
    gl,
    transientFramebuffers,
    'deleteFramebuffer',
    settlementFailures,
    'framebuffer'
  );
  try {
    restorePipelineState(gl, previousState);
  } catch (error) {
    settlementFailures.push(asError(
      error,
      'GPU smoke density state restoration failed with a non-Error value.'
    ));
  }
  try {
    const settlementErrorCodes = collectWebGLErrors(gl);
    if (settlementErrorCodes.length > 0) {
      settlementFailures.push(new Error(
        `GPU smoke density settlement produced WebGL error(s) ${formatWebGLErrors(settlementErrorCodes)}.`
      ));
    }
  } catch (error) {
    settlementFailures.push(asError(
      error,
      'GPU smoke density settlement error inspection failed with a non-Error value.'
    ));
  }

  if (primaryFailure !== null || settlementFailures.length > 0) {
    const failures = [];
    if (primaryFailure !== null) failures.push(primaryFailure);
    failures.push(...settlementFailures);
    if (candidateTexture !== null) {
      try {
        gl.deleteTexture(candidateTexture);
      } catch (error) {
        failures.push(asError(
          error,
          'GPU smoke density candidate cleanup failed with a non-Error value.'
        ));
      }
    }
    try {
      const candidateCleanupErrorCodes = collectWebGLErrors(gl);
      if (candidateCleanupErrorCodes.length > 0) {
        failures.push(new Error(
          `GPU smoke density candidate cleanup produced WebGL error(s) ${formatWebGLErrors(candidateCleanupErrorCodes)}.`
        ));
      }
    } catch (error) {
      failures.push(asError(
        error,
        'GPU smoke density candidate-cleanup inspection failed with a non-Error value.'
      ));
    }
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(
      failures,
      'GPU smoke density publication and settlement failed.'
    );
  }

  const elapsed = performance.now() - startTime;
  console.log(
    `[GPU Splat] ${visiblePointCount}/${pointCount} visible points -> ` +
    `${gridSize}³ native texture (${elapsed.toFixed(1)} ms submission)`
  );
  return result;
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
  if (
    !Number.isInteger(gridSize)
    || gridSize < 8
    || gridSize > MAX_SMOKE_GRID_SIZE
  ) {
    throw new RangeError(
      `Smoke density texture gridSize must be an integer from 8 through ${MAX_SMOKE_GRID_SIZE}.`
    );
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
