// ============================================================================
// GPU-Accelerated Density Volume Splatting (WebGL2)
// ============================================================================

import {
  LIGHT_VOLUME_FS,
  NORMALIZE_FS,
  OCCUPANCY_BLOCK,
  OCCUPANCY_FS,
  NORMALIZE_VS,
  REDUCE_MAX_FS,
  SPLAT_COLOR_FS,
  SPLAT_COLOR_VS,
  SPLAT_FS,
  SPLAT_VS,
} from '../shaders/density-shaders.js';
import { POINT_VISIBILITY_THRESHOLD } from '../alpha-visibility.js';
import { requireCleanWebGLState, requireLiveContext } from '../gl-errors.js';
import {
  createProgram,
  deleteGlObject,
  deleteProgramReleasingUse,
  deleteTextureTracked,
  restorableTexture,
} from '../gl-utils.js';
import {
  MAX_SMOKE_GRID_SIZE,
  SmokeUnsupportedError,
} from './smoke-density-contract.js';
import { detectSmokeSupport } from './smoke-capabilities.js';

const gpuSplatResourcesByContext = new WeakMap();
export const MAX_SPLAT_POINTS_PER_BATCH = 262_144;
const MIN_NORMAL_FLOAT32 = 2 ** -126;
// World half-thickness of the soft slab a flat cloud -- a 1D or 2D embedding,
// or a planar 3D one -- is spread over along its flat axes (see SPLAT_VS);
// about four voxels of the finest grid.
export const SMOKE_SLAB_HALF_THICKNESS = 0.06;

function deleteCachedGPUSplatResources(gl, resources) {
  const failures = [];
  resources.retiring = true;
  for (const key of ['cornerBuffer', 'quadBuffer']) {
    const buffer = resources[key];
    if (!buffer) continue;
    try {
      gl.deleteBuffer(buffer);
      resources[key] = null;
    } catch (error) {
      failures.push(asError(
        error,
        'Smoke density cached-buffer cleanup failed with a non-Error value.'
      ));
    }
  }
  for (const key of [
    'splatProgram',
    'colorSplatProgram',
    'reduceMaxProgram',
    'normalizeProgram',
    'lightProgram',
    'occupancyProgram',
  ]) {
    const program = resources[key];
    if (!program) continue;
    try {
      deleteProgramReleasingUse(gl, program);
      resources[key] = null;
    } catch (error) {
      failures.push(asError(
        error,
        'Smoke density cached-program cleanup failed with a non-Error value.'
      ));
    }
  }
  if (failures.length === 0) {
    gpuSplatResourcesByContext.delete(gl);
  }
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
    resources.retiring !== true
    && gl.isProgram(resources.splatProgram)
    && gl.isProgram(resources.colorSplatProgram)
    && gl.isProgram(resources.reduceMaxProgram)
    && gl.isProgram(resources.normalizeProgram)
    && gl.isProgram(resources.lightProgram)
    && gl.isProgram(resources.occupancyProgram)
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
    if (cached.retiring === true) {
      deleteCachedGPUSplatResources(gl, cached);
    } else if (cachedGPUSplatResourcesAreCurrent(gl, cached)) {
      return cached;
    }
    // A restored WebGL context invalidates every pre-loss object. Those handles
    // no longer belong to the current object namespace and must not be deleted
    // through it; dropping the cache lets the browser reclaim them with the
    // lost context and forces exact resource recreation below.
    gpuSplatResourcesByContext.delete(gl);
  }
  const createdPrograms = [];
  const createdBuffers = [];

  function createProgramFromSources(vsSource, fsSource) {
    const program = createProgram(gl, vsSource, fsSource);
    createdPrograms.push(program);
    return program;
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
    requireCleanWebGLState(gl, `Smoke density ${label} upload`);
    const actualBytes = gl.getBufferParameter(
      gl.ARRAY_BUFFER,
      gl.BUFFER_SIZE
    );
    requireCleanWebGLState(gl, `Smoke density ${label} validation`);
    if (actualBytes !== expectedBytes) {
      throw new Error(
        `Smoke density ${label} store is ${actualBytes} bytes; expected exactly ${expectedBytes}.`
      );
    }
  }

  try {
    const splatProgram = createProgramFromSources(SPLAT_VS, SPLAT_FS);
    const colorSplatProgram = createProgramFromSources(
      SPLAT_COLOR_VS,
      SPLAT_COLOR_FS
    );
    const colorSplatLocs = {
      a_position: requireAttribute(colorSplatProgram, 'a_position'),
      a_color: requireAttribute(colorSplatProgram, 'a_color'),
      u_gridSize: requireUniform(colorSplatProgram, 'u_gridSize'),
      u_flatAxes: requireUniform(colorSplatProgram, 'u_flatAxes'),
      u_slabHalfThickness: requireUniform(colorSplatProgram, 'u_slabHalfThickness'),
      u_atlasWidth: requireUniform(colorSplatProgram, 'u_atlasWidth'),
      u_atlasHeight: requireUniform(colorSplatProgram, 'u_atlasHeight'),
      u_slicesPerRow: requireUniform(colorSplatProgram, 'u_slicesPerRow'),
    };
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
      u_flatAxes: requireUniform(splatProgram, 'u_flatAxes'),
      u_slabHalfThickness: requireUniform(splatProgram, 'u_slabHalfThickness'),
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
      u_colorAtlas: requireUniform(normalizeProgram, 'u_colorAtlas'),
      u_gridSize: requireUniform(normalizeProgram, 'u_gridSize'),
      u_slicesPerRow: requireUniform(normalizeProgram, 'u_slicesPerRow'),
    };
    const lightProgram = createProgramFromSources(
      NORMALIZE_VS,
      LIGHT_VOLUME_FS
    );
    const lightLocs = {
      a_position: requireAttribute(lightProgram, 'a_position'),
      u_density: requireUniform(lightProgram, 'u_density'),
      u_gridSize: requireUniform(lightProgram, 'u_gridSize'),
      u_lightGridSize: requireUniform(lightProgram, 'u_lightGridSize'),
      u_layer: requireUniform(lightProgram, 'u_layer'),
      u_lightDir: requireUniform(lightProgram, 'u_lightDir'),
    };
    const occupancyProgram = createProgramFromSources(
      NORMALIZE_VS,
      OCCUPANCY_FS
    );
    const occupancyLocs = {
      a_position: requireAttribute(occupancyProgram, 'a_position'),
      u_density: requireUniform(occupancyProgram, 'u_density'),
      u_gridSize: requireUniform(occupancyProgram, 'u_gridSize'),
      u_layer: requireUniform(occupancyProgram, 'u_layer'),
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

    requireCleanWebGLState(gl, 'Smoke density pipeline initialization');

    const resources = {
      gl,
      splatProgram,
      colorSplatProgram,
      reduceMaxProgram,
      normalizeProgram,
      lightProgram,
      occupancyProgram,
      splatLocs,
      colorSplatLocs,
      reduceMaxLocs,
      normalizeLocs,
      lightLocs,
      occupancyLocs,
      cornerBuffer,
      quadBuffer,
      retiring: false,
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
    try {
      requireCleanWebGLState(gl, 'Smoke density pipeline cleanup');
    } catch (error) {
      failures.push(error);
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
  const units = [gl.TEXTURE0, gl.TEXTURE1, gl.TEXTURE2];
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
    // A binding saved before the build may name a texture deleted since:
    // it is not restored (gl-utils.js `restorableTexture`).
    gl.bindTexture(gl.TEXTURE_2D, restorableTexture(binding.texture2D));
    gl.bindTexture(gl.TEXTURE_3D, restorableTexture(binding.texture3D));
    gl.bindSampler(binding.unit - gl.TEXTURE0, binding.sampler);
  }
  gl.activeTexture(state.activeTexture);
}

function createAtlasTexture(gl, internalFormat, width, height, format, type) {
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
      format,
      type,
      null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  } catch (error) {
    deleteTextureTracked(gl, texture);
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

function requireExactPositionArray(positions, dimension) {
  if (dimension !== 1 && dimension !== 2 && dimension !== 3) {
    throw new RangeError(
      'GPU smoke density dimension must be exactly 1, 2, or 3.'
    );
  }
  if (
    !(positions instanceof Float32Array)
    || positions.length === 0
    || positions.length % dimension !== 0
  ) {
    throw new TypeError(
      'GPU smoke density positions must be a non-empty Float32Array with exactly dimension values per point.'
    );
  }
}

function requireExactColors(colors, pointCount) {
  if (!(colors instanceof Uint8Array) || colors.length !== pointCount * 4) {
    throw new TypeError(
      'GPU smoke density colors must be an exact point-count RGBA Uint8Array.'
    );
  }
  return colors;
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
    !(visibility.alpha instanceof Uint8Array)
    || visibility.alpha.length !== pointCount
  ) {
    throw new TypeError(
      'GPU smoke density visibility alpha must be an exact point-count Uint8Array.'
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

function inspectDensitySource(positions, dimension, visibility) {
  const pointCount = positions.length / dimension;
  const alpha = visibility?.alpha ?? null;
  const outlierQuantiles = visibility?.outlierQuantiles ?? null;
  const outlierThreshold = visibility?.outlierThreshold ?? null;
  let containsVisibleInBoundsPoint = false;
  let visiblePointCount = 0;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    const positionIndex = pointIndex * dimension;
    const x = positions[positionIndex];
    // Axes the embedding does not have are exactly zero.
    const y = dimension > 1 ? positions[positionIndex + 1] : 0;
    const z = dimension > 2 ? positions[positionIndex + 2] : 0;
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
      visible = alphaValue >= POINT_VISIBILITY_THRESHOLD;
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
    if (x < minimum[0]) minimum[0] = x;
    if (x > maximum[0]) maximum[0] = x;
    if (y < minimum[1]) minimum[1] = y;
    if (y > maximum[1]) maximum[1] = y;
    if (z < minimum[2]) minimum[2] = z;
    if (z > maximum[2]) maximum[2] = z;
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
  return {
    visiblePointCount,
    extent: [0, 1, 2].map(axis => maximum[axis] - minimum[axis]),
  };
}

/**
 * Axes along which the visible cloud is thinner than two voxels of `gridSize`
 * (1) or not (0). The splat spreads those into a soft slab (SPLAT_VS): a 2D
 * embedding becomes a slab, a 1D one a soft tube. A cloud thin along every
 * axis is a single blob of cells, not a sheet, and is splatted as it is.
 */
export function smokeFlatAxes(extent, gridSize) {
  const twoVoxels = 4 / (gridSize - 1);
  const flat = extent.map(size => (size < twoVoxels ? 1 : 0));
  return flat.every(axis => axis === 1) ? [0, 0, 0] : flat;
}

function asError(value, message) {
  return value instanceof Error ? value : new Error(message);
}

function deleteResources(gl, resources, deleteMethod, failures, label) {
  for (const resource of resources) {
    if (resource === null) continue;
    try {
      deleteGlObject(gl, deleteMethod, resource);
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
  deleteGlObject(gl, deleteMethod, resource);
  resources.splice(index, 1);
}

/**
 * Builds one native RGBA8 density volume without synchronizing pixels through
 * JavaScript. All intermediate work stays on the GPU:
 * R32F density atlas + RGBA32F colour atlas -> max reduction -> normalized
 * RGBA8 atlas -> 3D slice copies. Red is the normalized density; green, blue
 * and alpha are the mean display colour of the cells there, premultiplied by
 * that density (see density-shaders.js), so the cloud carries the active
 * field's colours.
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
    key =>
      key !== 'colors' &&
      key !== 'dimension' &&
      key !== 'gamma' &&
      key !== 'gridSize' &&
      key !== 'visibility'
  );
  if (unexpectedOption !== undefined) {
    throw new RangeError(
      `GPU smoke density option "${unexpectedOption}" is unknown.`
    );
  }
  // Positions hold exactly as many components per cell as the embedding has
  // (rendering/position-layout.js); the splat attribute reads that many and
  // the shader's vec3 input receives zero for the rest.
  if (!Object.hasOwn(options, 'dimension')) {
    throw new TypeError(
      'GPU smoke density requires the positions dimension.'
    );
  }
  const dimension = options.dimension;
  requireExactPositionArray(positions, dimension);
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
  const pointCount = positions.length / dimension;
  if (!Object.hasOwn(options, 'colors')) {
    throw new TypeError(
      'GPU smoke density requires the per-point display colors.'
    );
  }
  const colors = requireExactColors(options.colors, pointCount);
  const visibility = requireExactVisibility(
    Object.hasOwn(options, 'visibility') ? options.visibility : null,
    pointCount
  );
  const { visiblePointCount, extent } = inspectDensitySource(
    positions,
    dimension,
    visibility
  );
  if (visiblePointCount === 0) return null;
  const flatAxes = smokeFlatAxes(extent, gridSize);
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
  const support = detectSmokeSupport(gl);
  if (!support.supported) throw new SmokeUnsupportedError(support);
  // One error read per build, after its allocations (`publication` below):
  // each read is a synchronous round trip that waits for every queued
  // command, the previous frame's included (rendering/gl-errors.js).

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
    gl.bindSampler(2, null);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0);

    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) {
      throw new Error('GPU smoke density framebuffer allocation failed.');
    }
    transientFramebuffers.push(framebuffer);
    const colorFramebuffer = gl.createFramebuffer();
    if (!colorFramebuffer) {
      throw new Error('GPU smoke density colour framebuffer allocation failed.');
    }
    transientFramebuffers.push(colorFramebuffer);

    gl.activeTexture(gl.TEXTURE0);
    const accumulationAtlas = createAtlasTexture(
      gl,
      gl.R32F,
      atlasWidth,
      atlasHeight,
      gl.RED,
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
    const colorAtlas = createAtlasTexture(
      gl,
      gl.RGBA32F,
      atlasWidth,
      atlasHeight,
      gl.RGBA,
      gl.FLOAT
    );
    transientTextures.push(colorAtlas);
    attachColorTarget(gl, colorFramebuffer, colorAtlas, 'colour accumulation');
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
      splatBatchCapacity * dimension * Float32Array.BYTES_PER_ELEMENT,
      gl.STREAM_DRAW
    );
    const colorBuffer = gl.createBuffer();
    if (!colorBuffer) {
      throw new Error('GPU smoke density color-buffer allocation failed.');
    }
    transientBuffers.push(colorBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, splatBatchCapacity * 4, gl.STREAM_DRAW);

    // Density pass: one instance per cell, eight corner vertices each.
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
      dimension,
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

    // Colour pass: one point vertex per cell.
    const colorVertexArray = gl.createVertexArray();
    if (!colorVertexArray) {
      throw new Error('GPU smoke density colour VAO allocation failed.');
    }
    transientVertexArrays.push(colorVertexArray);
    gl.bindVertexArray(colorVertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(resources.colorSplatLocs.a_position);
    gl.vertexAttribPointer(
      resources.colorSplatLocs.a_position,
      dimension,
      gl.FLOAT,
      false,
      0,
      0
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.enableVertexAttribArray(resources.colorSplatLocs.a_color);
    gl.vertexAttribPointer(
      resources.colorSplatLocs.a_color,
      4,
      gl.UNSIGNED_BYTE,
      true,
      0,
      0
    );

    for (const [program, locations] of [
      [resources.splatProgram, resources.splatLocs],
      [resources.colorSplatProgram, resources.colorSplatLocs],
    ]) {
      gl.useProgram(program);
      gl.uniform1f(locations.u_gridSize, gridSize);
      gl.uniform1f(locations.u_atlasWidth, atlasWidth);
      gl.uniform1f(locations.u_atlasHeight, atlasHeight);
      gl.uniform1f(locations.u_slicesPerRow, slicesPerRow);
      gl.uniform3f(locations.u_flatAxes, ...flatAxes);
      gl.uniform1f(
        locations.u_slabHalfThickness,
        SMOKE_SLAB_HALF_THICKNESS
      );
    }
    gl.enable(gl.BLEND);
    gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);

    const submitBatch = (
      positionSource,
      positionOffset,
      colorSource,
      colorOffset,
      batchPointCount
    ) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        positionSource,
        positionOffset,
        batchPointCount * dimension
      );
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        colorSource,
        colorOffset,
        batchPointCount * 4
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.useProgram(resources.splatProgram);
      gl.bindVertexArray(splatVertexArray);
      gl.drawArraysInstanced(gl.POINTS, 0, 8, batchPointCount);
      gl.bindFramebuffer(gl.FRAMEBUFFER, colorFramebuffer);
      gl.useProgram(resources.colorSplatProgram);
      gl.bindVertexArray(colorVertexArray);
      gl.drawArrays(gl.POINTS, 0, batchPointCount);
    };

    if (visiblePointCount === pointCount) {
      for (
        let pointOffset = 0;
        pointOffset < pointCount;
        pointOffset += MAX_SPLAT_POINTS_PER_BATCH
      ) {
        submitBatch(
          positions,
          pointOffset * dimension,
          colors,
          pointOffset * 4,
          Math.min(MAX_SPLAT_POINTS_PER_BATCH, pointCount - pointOffset)
        );
      }
    } else {
      const batchPositions = new Float32Array(splatBatchCapacity * dimension);
      const batchColors = new Uint8Array(splatBatchCapacity * 4);
      const alpha = visibility.alpha;
      const outlierQuantiles = visibility.outlierQuantiles;
      const outlierThreshold = visibility.outlierThreshold;
      let batchPointCount = 0;
      let submittedPointCount = 0;
      for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
        if (alpha[pointIndex] < POINT_VISIBILITY_THRESHOLD) continue;
        if (outlierQuantiles !== null) {
          const quantile = outlierQuantiles[pointIndex];
          if (quantile >= 0 && quantile > outlierThreshold) continue;
        }
        const sourceOffset = pointIndex * dimension;
        const batchOffset = batchPointCount * dimension;
        for (let axis = 0; axis < dimension; axis++) {
          batchPositions[batchOffset + axis] = positions[sourceOffset + axis];
        }
        const colorSource = pointIndex * 4;
        const colorOffset = batchPointCount * 4;
        batchColors[colorOffset] = colors[colorSource];
        batchColors[colorOffset + 1] = colors[colorSource + 1];
        batchColors[colorOffset + 2] = colors[colorSource + 2];
        batchPointCount++;
        if (batchPointCount !== splatBatchCapacity) continue;

        submitBatch(batchPositions, 0, batchColors, 0, batchPointCount);
        submittedPointCount += batchPointCount;
        batchPointCount = 0;
      }
      if (batchPointCount > 0) {
        submitBatch(batchPositions, 0, batchColors, 0, batchPointCount);
        submittedPointCount += batchPointCount;
      }
      if (submittedPointCount !== visiblePointCount) {
        throw new Error(
          'GPU smoke density visibility changed during the build transaction.'
        );
      }
    }
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);

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
        gl.RED,
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
      gl.RGBA8,
      atlasWidth,
      atlasHeight,
      gl.RGBA,
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
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, colorAtlas);
    gl.uniform1i(resources.normalizeLocs.u_colorAtlas, 2);
    gl.uniform1f(resources.normalizeLocs.u_gamma, gammaFloat32);
    gl.uniform1i(resources.normalizeLocs.u_gridSize, gridSize);
    gl.uniform1i(resources.normalizeLocs.u_slicesPerRow, slicesPerRow);
    gl.bindVertexArray(normalizationVertexArray);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindTexture(gl.TEXTURE_2D, null);
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
      colorAtlas,
      'deleteTexture',
      'completed colour atlas'
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
      gl.RGBA8,
      gridSize,
      gridSize,
      gridSize,
      0,
      gl.RGBA,
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

    requireCleanWebGLState(gl, 'GPU smoke density publication');
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
    // Deleting objects and restoring bindings allocate nothing: only a lost
    // context can refuse them, so no error is read back here.
    requireLiveContext(gl, 'GPU smoke density settlement');
  } catch (error) {
    settlementFailures.push(asError(
      error,
      'GPU smoke density settlement inspection failed with a non-Error value.'
    ));
  }

  if (primaryFailure !== null || settlementFailures.length > 0) {
    const failures = [];
    if (primaryFailure !== null) failures.push(primaryFailure);
    failures.push(...settlementFailures);
    if (candidateTexture !== null) {
      try {
        deleteTextureTracked(gl, candidateTexture);
      } catch (error) {
        failures.push(asError(
          error,
          'GPU smoke density candidate cleanup failed with a non-Error value.'
        ));
      }
    }
    try {
      requireCleanWebGLState(gl, 'GPU smoke density candidate cleanup');
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

  // Convert float [0,1] to the GPU build's RGBA8 layout: density in red and
  // white, density-premultiplied, in the colour channels.
  const texData = new Uint8Array(gridSize * gridSize * gridSize * 4);
  for (let i = 0; i < volume.length; i++) {
    const value = volume[i];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(
        `Smoke density texture value ${i} must be finite and between 0 and 1.`
      );
    }
    const byte = Math.floor(value * 255 + 0.5);
    texData.fill(byte, i * 4, i * 4 + 4);
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
      gl.RGBA8,
      gridSize, gridSize, gridSize,
      0,
      gl.RGBA,
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
    gl.bindTexture(gl.TEXTURE_3D, restorableTexture(previousBinding));
  } catch (error) {
    const cleanupErrors = [];
    for (const cleanup of [
      () => gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment),
      () => gl.bindTexture(gl.TEXTURE_3D, restorableTexture(previousBinding)),
      () => deleteTextureTracked(gl, texture),
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

// ============================================================================
// Derived volumes: lighting (key-light shadow + sky occlusion) and occupancy
// ============================================================================

function allocateVolumeTexture(gl, internalFormat, format, type, size, filter) {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error('Smoke derived-volume texture allocation failed.');
  }
  gl.bindTexture(gl.TEXTURE_3D, texture);
  gl.texImage3D(
    gl.TEXTURE_3D, 0, internalFormat, size, size, size, 0, format, type, null
  );
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_3D, null);
  return texture;
}

function drawVolumeLayers(gl, framebuffer, texture, size, drawLayer, label) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.viewport(0, 0, size, size);
  for (let layer = 0; layer < size; layer++) {
    gl.framebufferTextureLayer(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      texture,
      0,
      layer
    );
    if (
      layer === 0
      && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE
    ) {
      throw new Error(`Smoke ${label} framebuffer is incomplete.`);
    }
    drawLayer(layer);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, null, 0, 0);
}

/** Edge length of the lighting volume for a density grid of `gridSize`. */
export function smokeLightGridSize(gridSize) {
  return Math.max(8, Math.ceil(gridSize / 2));
}

/** Edge length of the occupancy volume for a density grid of `gridSize`. */
export function smokeOccupancyGridSize(gridSize) {
  return Math.ceil(gridSize / OCCUPANCY_BLOCK);
}

/**
 * Derives the two volumes the ray march reads beside the density, once per
 * published density volume and light direction:
 *
 * - lighting (RG16F, half the grid): the density integrated towards the key
 *   light and over the sky (LIGHT_VOLUME_FS). It replaces the shadow ray the
 *   march used to cast from every sample of every frame: one filtered fetch
 *   instead of a loop, and the shadow now crosses the whole cloud rather than
 *   the first few voxels;
 * - occupancy (R8, one texel per 4³ block): the largest density a sample in
 *   each block can read (OCCUPANCY_FS), so the march crosses empty blocks in
 *   one step.
 *
 * Every binding and capability it touches is restored, exactly as for the
 * density build. Ownership of both returned textures transfers to the caller.
 */
export function buildDerivedVolumesGPU(gl, densityTexture, options) {
  if (!gl || typeof gl !== 'object') {
    throw new TypeError('Smoke derived volumes require a WebGL2 rendering context.');
  }
  if (!densityTexture) {
    throw new TypeError('Smoke derived volumes require a density texture.');
  }
  if (
    !options
    || typeof options !== 'object'
    || Object.keys(options).sort().join(',') !== 'gridSize,lightDir'
  ) {
    throw new TypeError(
      'Smoke derived-volume options must contain exactly gridSize and lightDir.'
    );
  }
  const { gridSize, lightDir } = options;
  if (
    !Number.isInteger(gridSize)
    || gridSize < 8
    || gridSize > MAX_SMOKE_GRID_SIZE
  ) {
    throw new RangeError(
      `Smoke derived-volume gridSize must be an integer from 8 through ${MAX_SMOKE_GRID_SIZE}.`
    );
  }
  if (
    !(Array.isArray(lightDir) || lightDir instanceof Float32Array)
    || lightDir.length !== 3
    || Array.from(lightDir).some(value => !Number.isFinite(value))
    || Math.hypot(...lightDir) < 1e-6
  ) {
    throw new TypeError(
      'Smoke derived-volume lightDir must be three finite numbers of non-zero length.'
    );
  }
  const support = detectSmokeSupport(gl);
  if (!support.supported) throw new SmokeUnsupportedError(support);
  requireCleanWebGLState(gl, 'Smoke derived-volume preflight');
  const lightGridSize = smokeLightGridSize(gridSize);
  const occupancyGridSize = smokeOccupancyGridSize(gridSize);
  const previousState = capturePipelineState(gl);
  const transientVertexArrays = [];
  const transientFramebuffers = [];
  const candidates = [];
  let lightTexture = null;
  let occupancyTexture = null;
  let primaryFailure = null;
  try {
    const resources = getOrCreateGPUSplatResources(gl);
    for (const capability of [
      gl.BLEND,
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

    gl.activeTexture(gl.TEXTURE1);
    lightTexture = allocateVolumeTexture(
      gl, gl.RG16F, gl.RG, gl.HALF_FLOAT, lightGridSize, gl.LINEAR
    );
    candidates.push(lightTexture);
    occupancyTexture = allocateVolumeTexture(
      gl, gl.R8, gl.RED, gl.UNSIGNED_BYTE, occupancyGridSize, gl.NEAREST
    );
    candidates.push(occupancyTexture);

    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) {
      throw new Error('Smoke derived-volume framebuffer allocation failed.');
    }
    transientFramebuffers.push(framebuffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, densityTexture);

    const lightVertexArray = createQuadVertexArray(
      gl,
      resources.quadBuffer,
      resources.lightLocs.a_position,
      'light-volume'
    );
    transientVertexArrays.push(lightVertexArray);
    gl.useProgram(resources.lightProgram);
    gl.uniform1i(resources.lightLocs.u_density, 0);
    gl.uniform1f(resources.lightLocs.u_gridSize, gridSize);
    gl.uniform1f(resources.lightLocs.u_lightGridSize, lightGridSize);
    const length = Math.hypot(...lightDir);
    gl.uniform3f(
      resources.lightLocs.u_lightDir,
      lightDir[0] / length,
      lightDir[1] / length,
      lightDir[2] / length
    );
    gl.bindVertexArray(lightVertexArray);
    drawVolumeLayers(gl, framebuffer, lightTexture, lightGridSize, layer => {
      gl.uniform1f(resources.lightLocs.u_layer, (layer + 0.5) / lightGridSize);
    }, 'light-volume');

    const occupancyVertexArray = createQuadVertexArray(
      gl,
      resources.quadBuffer,
      resources.occupancyLocs.a_position,
      'occupancy'
    );
    transientVertexArrays.push(occupancyVertexArray);
    gl.useProgram(resources.occupancyProgram);
    gl.uniform1i(resources.occupancyLocs.u_density, 0);
    gl.uniform1i(resources.occupancyLocs.u_gridSize, gridSize);
    gl.bindVertexArray(occupancyVertexArray);
    drawVolumeLayers(gl, framebuffer, occupancyTexture, occupancyGridSize, layer => {
      gl.uniform1i(resources.occupancyLocs.u_layer, layer);
    }, 'occupancy');
    requireCleanWebGLState(gl, 'Smoke derived-volume publication');
  } catch (error) {
    primaryFailure = asError(
      error,
      'Smoke derived volumes failed with a non-Error value.'
    );
  }

  const failures = primaryFailure === null ? [] : [primaryFailure];
  deleteResources(
    gl,
    transientVertexArrays,
    'deleteVertexArray',
    failures,
    'derived-volume vertex-array'
  );
  deleteResources(
    gl,
    transientFramebuffers,
    'deleteFramebuffer',
    failures,
    'derived-volume framebuffer'
  );
  try {
    restorePipelineState(gl, previousState);
  } catch (error) {
    failures.push(asError(
      error,
      'Smoke derived-volume state restoration failed with a non-Error value.'
    ));
  }
  try {
    requireCleanWebGLState(gl, 'Smoke derived-volume settlement');
  } catch (error) {
    failures.push(asError(
      error,
      'Smoke derived-volume settlement inspection failed with a non-Error value.'
    ));
  }
  if (failures.length > 0) {
    deleteResources(gl, candidates, 'deleteTexture', failures, 'derived-volume candidate');
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(
      failures,
      'Smoke derived-volume publication and settlement failed.'
    );
  }
  return Object.freeze({
    lightTexture,
    lightGridSize,
    occupancyTexture,
    occupancyGridSize,
  });
}
