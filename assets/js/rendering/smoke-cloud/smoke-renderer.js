// SmokeRenderer - Volumetric Cloud Rendering Module
// =================================================
// Encapsulates all smoke/cloud rendering logic extracted from viewer.js
// Provides a clean API for volumetric cloud visualization

import {
  MAX_SMOKE_LIGHT_SAMPLES,
  SMOKE_COMPOSITE_FS,
  SMOKE_COMPOSITE_VS,
  SMOKE_FS_SOURCE,
  SMOKE_VS_SOURCE,
} from '../shaders/smoke-shaders.js';
import {
  buildDensityTextureGPU,
  createDensityTexture3D,
  disposeDensityPipelineResources,
  invalidateDensityPipelineResources,
} from './smoke-density.js';
import {
  MAX_SMOKE_GRID_SIZE,
  SmokeDensityBuildError,
} from './smoke-density-contract.js';
import {
  getResolutionScaleFactor,
  startCloudNoiseTextureGeneration,
} from './noise-textures.js';
import {
  disposePendingCloudNoiseGeneratorResources,
  invalidatePendingCloudNoiseGeneratorResources,
} from './gpu-noise-generator.js';
import { getNotificationCenter } from '../../app/notification-center.js';

const TRANSPARENT_BLACK = new Float32Array([0, 0, 0, 0]);
const NO_RESOURCE_FAILURES = Object.freeze([]);
const DEFAULT_SMOKE_NOISE_RESOLUTION = 128;

function asError(value, message) {
  return value instanceof Error ? value : new Error(message);
}

function attempt(failures, operation, message) {
  try {
    operation();
  } catch (error) {
    failures.push(asError(error, message));
  }
}

function throwFailures(failures, message) {
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
}

function releaseNoiseTextures(
  gl,
  textures,
  owner,
  pendingTextureDeletes = null
) {
  const failures = [];
  const owned = new Set([
    textures?.shape,
    textures?.detail,
    textures?.blueNoise,
  ]);
  owned.delete(null);
  owned.delete(undefined);
  for (const texture of owned) {
    try {
      gl.deleteTexture(texture);
    } catch (error) {
      pendingTextureDeletes?.add(texture);
      failures.push(asError(
        error,
        `${owner} texture cleanup failed with a non-Error value.`
      ));
    }
  }
  if (failures.length > 0) {
    throwFailures(failures, `${owner} texture cleanup failed.`);
  }
}

function requireFiniteNumber(value, owner, minimum = -Infinity, maximum = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${owner} must be an exact finite number.`);
  }
  if (value < minimum || value > maximum) {
    throw new RangeError(
      `${owner} must be between ${minimum} and ${maximum}; received ${value}.`
    );
  }
  return value;
}

function requireVector3(value, owner) {
  if (
    !(Array.isArray(value) || value instanceof Float32Array) ||
    value.length !== 3 ||
    Array.from(value).some((entry) => !Number.isFinite(entry))
  ) {
    throw new TypeError(`${owner} must contain exactly three finite numbers.`);
  }
  return value;
}

function requireCleanWebGLState(gl, owner) {
  const errors = [];
  for (let index = 0; index < 32; index++) {
    const errorCode = gl.getError();
    if (errorCode === gl.NO_ERROR) break;
    errors.push(errorCode);
    if (errorCode === gl.CONTEXT_LOST_WEBGL) break;
  }
  if (errors.length > 0) {
    throw new Error(
      `${owner} encountered WebGL error${errors.length === 1 ? '' : 's'} `
      + errors.map(code => `0x${code.toString(16)}`).join(', ')
      + '.'
    );
  }
}

export class SmokeRenderer {
  constructor(gl, createProgram) {
    if (!gl || typeof gl !== 'object') {
      throw new TypeError('SmokeRenderer requires a WebGL2 rendering context.');
    }
    if (typeof createProgram !== 'function') {
      throw new TypeError('SmokeRenderer requires the exact shader-program factory.');
    }
    requireCleanWebGLState(gl, 'SmokeRenderer construction preflight');
    this.gl = gl;
    const previousVertexArray = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    const previousArrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    let smokeProgram = null;
    let compositeProgram = null;
    let quadBuffer = null;
    let smokeVertexArray = null;
    let compositeVertexArray = null;
    let smokeAttribLocations = null;
    let compositeAttribLocations = null;
    let smokeUniformLocations = null;
    let compositeUniformLocations = null;
    const failures = [];
    try {
      smokeProgram = createProgram(
        gl,
        SMOKE_VS_SOURCE,
        SMOKE_FS_SOURCE
      );
      if (!smokeProgram) {
        throw new Error('SmokeRenderer smoke-program creation failed.');
      }
      compositeProgram = createProgram(
        gl,
        SMOKE_COMPOSITE_VS,
        SMOKE_COMPOSITE_FS
      );
      if (!compositeProgram) {
        throw new Error('SmokeRenderer composite-program creation failed.');
      }

      smokeAttribLocations = {
        position: gl.getAttribLocation(smokeProgram, 'a_position'),
      };
      compositeAttribLocations = {
        position: gl.getAttribLocation(compositeProgram, 'a_position'),
      };
      for (const [owner, location] of [
        ['smoke', smokeAttribLocations.position],
        ['composite', compositeAttribLocations.position],
      ]) {
        if (!Number.isInteger(location) || location < 0) {
          throw new Error(
            `SmokeRenderer ${owner} shader is missing required a_position input.`
          );
        }
      }

      smokeUniformLocations = {
        invViewProj:       gl.getUniformLocation(smokeProgram, 'u_invViewProj'),
        cameraPos:         gl.getUniformLocation(smokeProgram, 'u_cameraPos'),
        volumeMin:         gl.getUniformLocation(smokeProgram, 'u_volumeMin'),
        volumeMax:         gl.getUniformLocation(smokeProgram, 'u_volumeMax'),
        densityTex3D:      gl.getUniformLocation(smokeProgram, 'u_densityTex3D'),
        gridSize:          gl.getUniformLocation(smokeProgram, 'u_gridSize'),
        shapeNoise:        gl.getUniformLocation(smokeProgram, 'u_shapeNoise'),
        detailNoise:       gl.getUniformLocation(smokeProgram, 'u_detailNoise'),
        blueNoise:         gl.getUniformLocation(smokeProgram, 'u_blueNoise'),
        blueNoiseOffset:   gl.getUniformLocation(smokeProgram, 'u_blueNoiseOffset'),
        smokeColor:        gl.getUniformLocation(smokeProgram, 'u_smokeColor'),
        lightDir:          gl.getUniformLocation(smokeProgram, 'u_lightDir'),
        time:              gl.getUniformLocation(smokeProgram, 'u_time'),
        animationSpeed:    gl.getUniformLocation(smokeProgram, 'u_animationSpeed'),
        densityMultiplier: gl.getUniformLocation(smokeProgram, 'u_densityMultiplier'),
        stepMultiplier:    gl.getUniformLocation(smokeProgram, 'u_stepMultiplier'),
        noiseScale:        gl.getUniformLocation(smokeProgram, 'u_noiseScale'),
        warpStrength:      gl.getUniformLocation(smokeProgram, 'u_warpStrength'),
        detailLevel:       gl.getUniformLocation(smokeProgram, 'u_detailLevel'),
        lightAbsorption:   gl.getUniformLocation(smokeProgram, 'u_lightAbsorption'),
        scatterStrength:   gl.getUniformLocation(smokeProgram, 'u_scatterStrength'),
        edgeSoftness:      gl.getUniformLocation(smokeProgram, 'u_edgeSoftness'),
        directLight:       gl.getUniformLocation(smokeProgram, 'u_directLightIntensity'),
        lightSamples:      gl.getUniformLocation(smokeProgram, 'u_lightSamples'),
      };
      compositeUniformLocations = {
        smokeTex:          gl.getUniformLocation(compositeProgram, 'u_smokeTex'),
        inverseResolution: gl.getUniformLocation(compositeProgram, 'u_inverseResolution'),
        intensity:         gl.getUniformLocation(compositeProgram, 'u_intensity'),
      };
      for (const [owner, locations] of [
        ['smoke', smokeUniformLocations],
        ['composite', compositeUniformLocations],
      ]) {
        for (const [name, location] of Object.entries(locations)) {
          if (location === null) {
            throw new Error(
              `SmokeRenderer ${owner} shader is missing required ${name} uniform.`
            );
          }
        }
      }

      quadBuffer = gl.createBuffer();
      if (!quadBuffer) {
        throw new Error('SmokeRenderer fullscreen-buffer allocation failed.');
      }
      smokeVertexArray = gl.createVertexArray();
      compositeVertexArray = gl.createVertexArray();
      if (!smokeVertexArray || !compositeVertexArray) {
        throw new Error('SmokeRenderer fullscreen vertex-array allocation failed.');
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]),
        gl.STATIC_DRAW
      );
      for (const [vertexArray, location] of [
        [smokeVertexArray, smokeAttribLocations.position],
        [compositeVertexArray, compositeAttribLocations.position],
      ]) {
        gl.bindVertexArray(vertexArray);
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      }
      requireCleanWebGLState(
        gl,
        'SmokeRenderer candidate construction'
      );
    } catch (error) {
      failures.push(asError(
        error,
        'SmokeRenderer construction failed with a non-Error value.'
      ));
    }
    attempt(
      failures,
      () => gl.bindVertexArray(previousVertexArray),
      'SmokeRenderer vertex-array restoration failed with a non-Error value.'
    );
    attempt(
      failures,
      () => gl.bindBuffer(gl.ARRAY_BUFFER, previousArrayBuffer),
      'SmokeRenderer array-buffer restoration failed with a non-Error value.'
    );
    attempt(
      failures,
      () => requireCleanWebGLState(
        gl,
        'SmokeRenderer construction settlement'
      ),
      'SmokeRenderer construction settlement inspection failed with a non-Error value.'
    );
    if (failures.length > 0) {
      for (const vertexArray of [
        smokeVertexArray,
        compositeVertexArray,
      ]) {
        if (!vertexArray) continue;
        attempt(
          failures,
          () => gl.deleteVertexArray(vertexArray),
          'SmokeRenderer vertex-array rollback failed with a non-Error value.'
        );
      }
      if (quadBuffer) {
        attempt(
          failures,
          () => gl.deleteBuffer(quadBuffer),
          'SmokeRenderer fullscreen-buffer rollback failed with a non-Error value.'
        );
      }
      for (const program of [smokeProgram, compositeProgram]) {
        if (!program) continue;
        attempt(
          failures,
          () => gl.deleteProgram(program),
          'SmokeRenderer program rollback failed with a non-Error value.'
        );
      }
      attempt(
        failures,
        () => requireCleanWebGLState(
          gl,
          'SmokeRenderer construction rollback'
        ),
        'SmokeRenderer construction rollback inspection failed with a non-Error value.'
      );
      throwFailures(
        failures,
        'SmokeRenderer construction and rollback failed.'
      );
    }
    this.smokeProgram = smokeProgram;
    this.compositeProgram = compositeProgram;
    this.smokeAttribLocations = smokeAttribLocations;
    this.compositeAttribLocations = compositeAttribLocations;
    this.smokeUniformLocations = smokeUniformLocations;
    this.compositeUniformLocations = compositeUniformLocations;
    this.quadBuffer = quadBuffer;
    this.smokeVertexArray = smokeVertexArray;
    this.compositeVertexArray = compositeVertexArray;

    // === STATE ===
    this.textureInfo = null;
    this.volumeMin = new Float32Array([-1, -1, -1]);
    this.volumeMax = new Float32Array([1, 1, 1]);

    // Tuned default values for visible, realistic volumetric clouds
    this.noiseResolution = DEFAULT_SMOKE_NOISE_RESOLUTION;
    this.density = 8.0;
    this.noiseScale = getResolutionScaleFactor(this.noiseResolution);
    this.warpStrength = 0.2;
    this.stepMultiplier = 2.8;
    this.animationSpeed = 1.0;
    this.detailLevel = 3.8;
    this.lightAbsorption = 1.5;
    this.scatterStrength = 0.0;
    this.edgeSoftness = 0.3;
    this.lightSamples = 6;
    this.directLight = 0.06;
    this.color = new Float32Array([0.98, 0.98, 1.0]);

    // Resolution scaling
    this.resolutionScale = 0.5;
    this.framebuffer = null;
    this.colorTex = null;
    this.targetWidth = 0;
    this.targetHeight = 0;

    // Noise textures
    this.noiseTextures = null;
    this.noiseGenerationInProgress = false;
    this.noiseGenerationError = null;
    this.noiseGenerationToken = 0;
    this._noiseGenerationTransaction = null;
    this.contextLost = false;
    this._pendingTextureDeletes = new Set();
    this._pendingFramebufferDeletes = new Set();
    this._pendingBufferDeletes = new Set();
    this._pendingVertexArrayDeletes = new Set();
    this._pendingProgramDeletes = new Set();
    this._pendingDensityPipelineDisposal = false;
    this._pendingNoiseGeneratorDisposal = false;
    this._disposeStarted = false;
    this.disposed = false;

    // Animation
    this.startTime = performance.now();
    this.frameIndex = 0;
  }

  // === VOLUME MANAGEMENT ===

  _assertMutableLifecycle(operation) {
    if (this._disposeStarted || this.disposed) {
      throw new Error(
        `SmokeRenderer cannot ${operation} after disposal has started.`
      );
    }
    if (this.contextLost) {
      throw new Error(
        `SmokeRenderer cannot ${operation} after WebGL context loss.`
      );
    }
  }

  _retirePendingResourceSet(
    pending,
    deleteMethod,
    inspectionMethod,
    owner
  ) {
    const failures = [];
    for (const resource of pending) {
      try {
        this.gl[deleteMethod](resource);
        pending.delete(resource);
      } catch (error) {
        if (typeof this.gl[inspectionMethod] === 'function') {
          try {
            if (this.gl[inspectionMethod](resource) === false) {
              pending.delete(resource);
              continue;
            }
          } catch (inspectionError) {
            failures.push(new AggregateError(
              [
                asError(error, `${owner} cleanup failed.`),
                asError(
                  inspectionError,
                  `${owner} ownership inspection failed.`
                ),
              ],
              `${owner} cleanup state could not be determined.`
            ));
            continue;
          }
        }
        failures.push(asError(
          error,
          `${owner} cleanup failed with a non-Error value.`
        ));
      }
    }
    return failures;
  }

  _flushPendingDirectResources() {
    if (
      this._pendingTextureDeletes.size === 0 &&
      this._pendingFramebufferDeletes.size === 0 &&
      this._pendingBufferDeletes.size === 0 &&
      this._pendingVertexArrayDeletes.size === 0 &&
      this._pendingProgramDeletes.size === 0
    ) {
      return NO_RESOURCE_FAILURES;
    }
    const failures = [];
    for (const [
      pending,
      deleteMethod,
      inspectionMethod,
      owner,
    ] of [
      [
        this._pendingTextureDeletes,
        'deleteTexture',
        'isTexture',
        'Smoke texture',
      ],
      [
        this._pendingFramebufferDeletes,
        'deleteFramebuffer',
        'isFramebuffer',
        'Smoke framebuffer',
      ],
      [
        this._pendingBufferDeletes,
        'deleteBuffer',
        'isBuffer',
        'Smoke buffer',
      ],
      [
        this._pendingVertexArrayDeletes,
        'deleteVertexArray',
        'isVertexArray',
        'Smoke vertex array',
      ],
      [
        this._pendingProgramDeletes,
        'deleteProgram',
        'isProgram',
        'Smoke program',
      ],
    ]) {
      failures.push(
        ...this._retirePendingResourceSet(
          pending,
          deleteMethod,
          inspectionMethod,
          owner
        )
      );
    }
    return failures;
  }

  _convergePendingDirectResources(owner) {
    this._initializePendingDisposalState();
    const failures = this._flushPendingDirectResources();
    if (failures.length > 0) {
      throwFailures(
        failures,
        `${owner} could not retire pending GPU resources.`
      );
    }
  }

  _convergeNoiseGenerationTransaction(owner) {
    const transaction = this._noiseGenerationTransaction ?? null;
    if (
      transaction === null
      || transaction.running
      || transaction.completed
    ) {
      return false;
    }
    try {
      transaction.dispose();
    } catch (error) {
      throw asError(
        error,
        `${owner} could not retire the GPU noise transaction.`
      );
    } finally {
      this.noiseGenerationInProgress = false;
      if (transaction.cleanupComplete) {
        this._noiseGenerationTransaction = null;
      }
    }
    return true;
  }

  _cancelNoiseGeneration(owner) {
    const transaction = this._noiseGenerationTransaction ?? null;
    this.noiseGenerationInProgress = false;
    if (transaction === null) return false;
    try {
      transaction.cancel(`${owner} cancelled GPU cloud-noise generation.`);
    } catch (error) {
      throw asError(
        error,
        `${owner} GPU cloud-noise cancellation failed.`
      );
    } finally {
      if (transaction.cleanupComplete) {
        this._noiseGenerationTransaction = null;
      }
    }
    return true;
  }

  setVolume(volumeDesc) {
    this._assertMutableLifecycle('publish a volume');
    this._convergePendingDirectResources('Smoke volume publication');
    const gl = this.gl;
    if (
      volumeDesc === null ||
      typeof volumeDesc !== 'object' ||
      Array.isArray(volumeDesc) ||
      Object.getPrototypeOf(volumeDesc) !== Object.prototype ||
      Object.keys(volumeDesc).sort().join(',') !==
        'boundsMax,boundsMin,data,gridSize'
    ) {
      throw new TypeError(
        'SmokeRenderer volume descriptor must contain exactly boundsMax, boundsMin, data, and gridSize.'
      );
    }
    if (!(volumeDesc.data instanceof Float32Array)) {
      throw new TypeError('SmokeRenderer volume data must be a Float32Array.');
    }
    if (!Number.isInteger(volumeDesc.gridSize) || volumeDesc.gridSize < 8) {
      throw new RangeError(
        'SmokeRenderer volume gridSize must be an integer of at least 8.'
      );
    }
    const boundsMin = requireVector3(
      volumeDesc.boundsMin,
      'SmokeRenderer boundsMin'
    );
    const boundsMax = requireVector3(
      volumeDesc.boundsMax,
      'SmokeRenderer boundsMax'
    );
    for (let axis = 0; axis < 3; axis++) {
      if (boundsMin[axis] >= boundsMax[axis]) {
        throw new RangeError(
          `SmokeRenderer boundsMin[${axis}] must be smaller than boundsMax[${axis}].`
        );
      }
    }

    const nextTextureInfo = createDensityTexture3D(gl, volumeDesc);
    const previousTexture = this.textureInfo?.texture ?? null;
    this.textureInfo = nextTextureInfo;
    this.volumeMin.set(boundsMin);
    this.volumeMax.set(boundsMax);
    if (previousTexture) {
      this._pendingTextureDeletes.add(previousTexture);
      this._convergePendingDirectResources(
        'Smoke prior-volume retirement'
      );
    }
    console.log(`[SmokeRenderer] Created 3D density texture (${volumeDesc.gridSize}³)`);
  }

  clearVolume() {
    this._assertMutableLifecycle('clear its volume');
    this._convergePendingDirectResources('Smoke volume clearing');
    const previousTexture = this.textureInfo?.texture ?? null;
    this.textureInfo = null;
    if (previousTexture) {
      this._pendingTextureDeletes.add(previousTexture);
      this._convergePendingDirectResources(
        'Smoke cleared-volume retirement'
      );
    }
  }

  buildVolumeGPU(positions, options = {}) {
    this._assertMutableLifecycle('build a density volume');
    this._convergePendingDirectResources(
      'GPU smoke density publication'
    );
    const gl = this.gl;
    const notifications = getNotificationCenter();
    const notificationId = notifications.startCalculation(
      'Building smoke density volume',
      'render'
    );
    const startTime = performance.now();
    const previousTextureInfo = this.textureInfo;
    const previousBoundsMin = new Float32Array(this.volumeMin);
    const previousBoundsMax = new Float32Array(this.volumeMax);
    let candidate = null;
    let published = false;
    let summary = null;

    try {
      candidate = buildDensityTextureGPU(gl, positions, options);
      if (candidate === null) {
        const gridSize = Object.hasOwn(options, 'gridSize')
          ? options.gridSize
          : 128;
        this.textureInfo = null;
        this.volumeMin.set([-1, -1, -1]);
        this.volumeMax.set([1, 1, 1]);
        published = true;
        summary = Object.freeze({
          empty: true,
          gridSize,
        });
        const elapsed = performance.now() - startTime;
        notifications.completeCalculation(
          notificationId,
          'Smoke density cleared (no visible cells)',
          elapsed
        );
      } else {
        if (
          typeof candidate !== 'object'
          || Array.isArray(candidate)
          || Object.keys(candidate).sort().join(',') !==
            'boundsMax,boundsMin,gridSize,is3D,texture'
          || !candidate.texture
          || !Number.isInteger(candidate.gridSize)
          || candidate.gridSize < 8
          || candidate.gridSize > MAX_SMOKE_GRID_SIZE
          || candidate.is3D !== true
        ) {
          throw new TypeError(
            'GPU smoke density builder must return null or one complete native 3D texture.'
          );
        }
        const boundsMin = requireVector3(
          candidate.boundsMin,
          'SmokeRenderer GPU boundsMin'
        );
        const boundsMax = requireVector3(
          candidate.boundsMax,
          'SmokeRenderer GPU boundsMax'
        );
        for (let axis = 0; axis < 3; axis++) {
          if (boundsMin[axis] >= boundsMax[axis]) {
            throw new RangeError(
              `SmokeRenderer GPU boundsMin[${axis}] must be smaller than boundsMax[${axis}].`
            );
          }
        }
        this.textureInfo = {
          texture: candidate.texture,
          gridSize: candidate.gridSize,
          is3D: true,
        };
        this.volumeMin.set(boundsMin);
        this.volumeMax.set(boundsMax);
        published = true;
        summary = Object.freeze({
          boundsMax: Object.freeze(Array.from(boundsMax)),
          boundsMin: Object.freeze(Array.from(boundsMin)),
          gridSize: candidate.gridSize,
        });
        const elapsed = performance.now() - startTime;
        notifications.completeCalculation(
          notificationId,
          `Smoke density ready (${candidate.gridSize}³)`,
          elapsed
        );
      }
    } catch (error) {
      const failures = [asError(
        error,
        'GPU smoke density publication failed with a non-Error value.'
      )];
      if (published) {
        this.textureInfo = previousTextureInfo;
        this.volumeMin.set(previousBoundsMin);
        this.volumeMax.set(previousBoundsMax);
      }
      if (
        candidate?.texture
        && candidate.texture !== previousTextureInfo?.texture
      ) {
        this._pendingTextureDeletes.add(candidate.texture);
        try {
          this._convergePendingDirectResources(
            'GPU smoke density rollback'
          );
        } catch (cleanupError) {
          failures.push(asError(
            cleanupError,
            'GPU smoke density candidate rollback failed with a non-Error value.'
          ));
        }
      }
      try {
        notifications.failCalculation(
          notificationId,
          `Smoke density unavailable: ${failures[0].message}`
        );
      } catch (notificationError) {
        failures.push(asError(
          notificationError,
          'Smoke density failure notification rejected a non-Error value.'
        ));
      }
      const cause = failures.length === 1
        ? failures[0]
        : new AggregateError(
          failures,
          'GPU smoke density publication and rollback failed.'
        );
      throw new SmokeDensityBuildError(failures[0].message, cause);
    }

    const previousTexture = previousTextureInfo?.texture ?? null;
    if (
      previousTexture !== null
      && previousTexture !== candidate?.texture
    ) {
      this._pendingTextureDeletes.add(previousTexture);
      this._convergePendingDirectResources(
        'GPU smoke prior-density retirement'
      );
    }
    if (candidate === null) {
      console.log('[SmokeRenderer] Cleared density texture (no visible cells)');
    } else {
      console.log(
        `[SmokeRenderer] Created 3D density texture (${candidate.gridSize}³)`
      );
    }
    return summary;
  }

  hasVolume() {
    return this.textureInfo !== null;
  }

  handleContextLost() {
    this.contextLost = true;
    this.noiseGenerationToken++;
    this.noiseGenerationInProgress = false;
    this.noiseGenerationError = null;
    const noiseTransaction = this._noiseGenerationTransaction ?? null;
    this._noiseGenerationTransaction = null;
    const transactionInvalidated = noiseTransaction?.invalidate() ?? false;
    this.textureInfo = null;
    this.noiseTextures = null;
    this.framebuffer = null;
    this.colorTex = null;
    this.targetWidth = 0;
    this.targetHeight = 0;
    this._pendingTextureDeletes?.clear();
    this._pendingFramebufferDeletes?.clear();
    this._pendingBufferDeletes?.clear();
    this._pendingVertexArrayDeletes?.clear();
    this._pendingProgramDeletes?.clear();
    this._pendingDensityPipelineDisposal = false;
    this._pendingNoiseGeneratorDisposal = false;
    const densityInvalidated = invalidateDensityPipelineResources(this.gl);
    const noiseInvalidated =
      invalidatePendingCloudNoiseGeneratorResources(this.gl);
    return (
      transactionInvalidated
      || densityInvalidated
      || noiseInvalidated
    );
  }

  // === PARAMETER SETTERS ===

  setParams(params) {
    this._assertMutableLifecycle('change parameters');
    if (
      params === null ||
      typeof params !== 'object' ||
      Array.isArray(params) ||
      Object.getPrototypeOf(params) !== Object.prototype
    ) {
      throw new TypeError(
        'SmokeRenderer parameters must be one exact plain object.'
      );
    }
    const validators = {
      density: (value) => ['density', requireFiniteNumber(value, 'SmokeRenderer density', 0)],
      noiseScale: (value) => ['noiseScale', requireFiniteNumber(value, 'SmokeRenderer noiseScale', Number.MIN_VALUE)],
      warpStrength: (value) => ['warpStrength', requireFiniteNumber(value, 'SmokeRenderer warpStrength', 0)],
      stepMultiplier: (value) => ['stepMultiplier', requireFiniteNumber(value, 'SmokeRenderer stepMultiplier', Number.MIN_VALUE)],
      animationSpeed: (value) => ['animationSpeed', requireFiniteNumber(value, 'SmokeRenderer animationSpeed', 0)],
      detailLevel: (value) => ['detailLevel', requireFiniteNumber(value, 'SmokeRenderer detailLevel', 0)],
      lightAbsorption: (value) => ['lightAbsorption', requireFiniteNumber(value, 'SmokeRenderer lightAbsorption', 0)],
      scatterStrength: (value) => ['scatterStrength', requireFiniteNumber(value, 'SmokeRenderer scatterStrength', 0)],
      edgeSoftness: (value) => ['edgeSoftness', requireFiniteNumber(value, 'SmokeRenderer edgeSoftness', 0)],
      directLightIntensity: (value) => [
        'directLight',
        requireFiniteNumber(
          value,
          'SmokeRenderer directLightIntensity',
          0,
          2
        )
      ],
      lightSamples: (value) => {
        requireFiniteNumber(
          value,
          'SmokeRenderer lightSamples',
          1,
          MAX_SMOKE_LIGHT_SAMPLES
        );
        if (!Number.isInteger(value)) {
          throw new TypeError(
            'SmokeRenderer lightSamples must be an integer.'
          );
        }
        return ['lightSamples', value];
      },
    };
    const staged = {};
    for (const [key, value] of Object.entries(params)) {
      const validate = validators[key];
      if (!validate) {
        throw new RangeError(`SmokeRenderer parameter "${key}" is unknown.`);
      }
      const [ownedKey, exactValue] = validate(value);
      staged[ownedKey] = exactValue;
    }
    Object.assign(this, staged);
  }

  setResolutionScale(scale) {
    this._assertMutableLifecycle('change resolution scale');
    this._convergePendingDirectResources(
      'Smoke resolution-scale publication'
    );
    const exactScale = requireFiniteNumber(
      scale,
      'SmokeRenderer resolutionScale',
      0.25,
      2
    );
    if (exactScale === this.resolutionScale) return;
    this.resolutionScale = exactScale;
    this.targetWidth = 0;
    this.targetHeight = 0;
    if (exactScale !== 1) return;

    const previousFramebuffer = this.framebuffer;
    const previousTexture = this.colorTex;
    this.framebuffer = null;
    this.colorTex = null;
    if (previousFramebuffer) {
      this._pendingFramebufferDeletes.add(previousFramebuffer);
    }
    if (previousTexture) {
      this._pendingTextureDeletes.add(previousTexture);
    }
    this._convergePendingDirectResources(
      'Native-resolution smoke target cleanup'
    );
  }

  getResolutionScale() {
    return this.resolutionScale;
  }

  setNoiseTextureResolution(size) {
    this._assertMutableLifecycle('change noise resolution');
    this._convergePendingDirectResources(
      'Smoke noise-resolution publication'
    );
    requireFiniteNumber(size, 'SmokeRenderer noise resolution', 32, 256);
    if (!Number.isInteger(size)) {
      throw new TypeError('SmokeRenderer noise resolution must be an integer.');
    }
    const newSize = size;
    if (newSize !== this.noiseResolution) {
      const previousSize = this.noiseResolution;
      const previousScale = getResolutionScaleFactor(previousSize);
      const newScale = getResolutionScaleFactor(newSize);
      const previousNoiseTextures = this.noiseTextures;
      this.noiseGenerationToken++;
      this.noiseGenerationError = null;
      this._cancelNoiseGeneration('Smoke noise-resolution change');
      this.noiseTextures = null;
      this.noiseResolution = newSize;
      this.noiseScale *= newScale / previousScale;
      if (previousNoiseTextures) {
        releaseNoiseTextures(
          this.gl,
          previousNoiseTextures,
          'Replaced smoke noise',
          this._pendingTextureDeletes
        );
      }
      console.log(`[SmokeRenderer] Noise resolution changed to ${newSize}³, will regenerate`);
    }
  }

  getNoiseTextureResolution() {
    return this.noiseResolution;
  }

  getAdaptiveScaleFactor() {
    return getResolutionScaleFactor(this.noiseResolution);
  }

  hasPendingNoiseGeneration() {
    return (this._noiseGenerationTransaction ?? null)?.running === true;
  }

  hasNoiseTextures() {
    return this.noiseTextures !== null;
  }

  cancelNoiseGeneration() {
    this._assertMutableLifecycle('cancel noise generation');
    this._convergePendingDirectResources(
      'Smoke noise-generation cancellation'
    );
    const transaction = this._noiseGenerationTransaction ?? null;
    if (transaction === null) return false;
    this.noiseGenerationToken++;
    this.noiseGenerationError = null;
    return this._cancelNoiseGeneration('Smoke render-mode switch');
  }

  setQualityPreset(preset) {
    this._assertMutableLifecycle('change quality preset');
    switch (preset) {
      case 'performance':
        this.stepMultiplier = 0.6;
        this.detailLevel = 1.0;
        this.lightSamples = 3;
        this.setResolutionScale(0.5);
        break;
      case 'balanced':
        this.stepMultiplier = 1.0;
        this.detailLevel = 2.0;
        this.lightSamples = 6;
        this.setResolutionScale(0.5);
        break;
      case 'quality':
        this.stepMultiplier = 1.5;
        this.detailLevel = 3.0;
        this.lightSamples = 8;
        this.setResolutionScale(1.0);
        break;
      case 'ultra':
        this.stepMultiplier = 2.0;
        this.detailLevel = 4.0;
        this.lightSamples = MAX_SMOKE_LIGHT_SAMPLES;
        this.setResolutionScale(1.0);
        break;
      default:
        throw new RangeError(
          'SmokeRenderer quality preset must be performance, balanced, quality, or ultra.'
        );
    }
  }

  // === FRAMEBUFFER MANAGEMENT ===

  ensureRenderTarget(w, h) {
    this._assertMutableLifecycle('publish a render target');
    this._convergePendingDirectResources(
      'Smoke render-target publication'
    );
    const gl = this.gl;
    requireFiniteNumber(w, 'SmokeRenderer target width', Number.MIN_VALUE);
    requireFiniteNumber(h, 'SmokeRenderer target height', Number.MIN_VALUE);
    const scale = this.resolutionScale;
    const targetW = Math.max(1, Math.floor(w * scale));
    const targetH = Math.max(1, Math.floor(h * scale));

    if (this.framebuffer && targetW === this.targetWidth && targetH === this.targetHeight) {
      return;
    }

    requireCleanWebGLState(gl, 'SmokeRenderer render-target publication');
    const previousDrawFramebufferBinding =
      gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    const previousReadFramebufferBinding =
      gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const previousPixelUnpackBufferBinding =
      gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING);
    const previousTextureBinding =
      gl.getParameter(gl.TEXTURE_BINDING_2D);
    const previousFramebuffer = this.framebuffer;
    const previousTexture = this.colorTex;
    let candidateTexture = null;
    let candidateFramebuffer = null;
    const failures = [];
    try {
      candidateTexture = gl.createTexture();
      if (!candidateTexture) {
        throw new Error(
          'SmokeRenderer target texture allocation failed.'
        );
      }
      gl.bindTexture(gl.TEXTURE_2D, candidateTexture);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        targetW,
        targetH,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        gl.LINEAR
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MAG_FILTER,
        gl.LINEAR
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_S,
        gl.CLAMP_TO_EDGE
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_T,
        gl.CLAMP_TO_EDGE
      );

      candidateFramebuffer = gl.createFramebuffer();
      if (!candidateFramebuffer) {
        throw new Error(
          'SmokeRenderer framebuffer allocation failed.'
        );
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, candidateFramebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        candidateTexture,
        0
      );

      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      requireCleanWebGLState(
        gl,
        'SmokeRenderer candidate render-target publication'
      );
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        const statusNames = {
          [gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT]:
            'INCOMPLETE_ATTACHMENT',
          [gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT]:
            'INCOMPLETE_MISSING_ATTACHMENT',
          [gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS]:
            'INCOMPLETE_DIMENSIONS',
          [gl.FRAMEBUFFER_UNSUPPORTED]: 'UNSUPPORTED',
        };
        const statusName = Object.hasOwn(statusNames, status)
          ? statusNames[status]
          : `0x${status.toString(16)}`;
        throw new Error(
          `SmokeRenderer framebuffer is incomplete: ${statusName} (${targetW}x${targetH}).`
        );
      }
    } catch (error) {
      failures.push(asError(
        error,
        'Smoke render-target creation failed with a non-Error value.'
      ));
    }

    const publishCandidate = failures.length === 0;
    const targetDrawBinding = (
      publishCandidate
      && previousFramebuffer !== null
      && previousDrawFramebufferBinding === previousFramebuffer
    )
      ? candidateFramebuffer
      : previousDrawFramebufferBinding;
    const targetReadBinding = (
      publishCandidate
      && previousFramebuffer !== null
      && previousReadFramebufferBinding === previousFramebuffer
    )
      ? candidateFramebuffer
      : previousReadFramebufferBinding;
    const targetTextureBinding = (
      publishCandidate
      && previousTexture !== null
      && previousTextureBinding === previousTexture
    )
      ? candidateTexture
      : previousTextureBinding;
    attempt(
      failures,
      () => gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, targetDrawBinding),
      'Smoke draw-framebuffer restoration failed with a non-Error value.'
    );
    attempt(
      failures,
      () => gl.bindFramebuffer(gl.READ_FRAMEBUFFER, targetReadBinding),
      'Smoke read-framebuffer restoration failed with a non-Error value.'
    );
    attempt(
      failures,
      () => gl.bindBuffer(
        gl.PIXEL_UNPACK_BUFFER,
        previousPixelUnpackBufferBinding
      ),
      'Smoke pixel-unpack-buffer restoration failed with a non-Error value.'
    );
    attempt(
      failures,
      () => gl.bindTexture(gl.TEXTURE_2D, targetTextureBinding),
      'Smoke target-texture restoration failed with a non-Error value.'
    );
    attempt(
      failures,
      () => requireCleanWebGLState(
        gl,
        'Smoke render-target restoration'
      ),
      'Smoke render-target restoration inspection failed with a non-Error value.'
    );

    if (failures.length > 0) {
      attempt(
        failures,
        () => gl.bindFramebuffer(
          gl.DRAW_FRAMEBUFFER,
          previousDrawFramebufferBinding
        ),
        'Smoke draw-framebuffer rollback failed with a non-Error value.'
      );
      attempt(
        failures,
        () => gl.bindFramebuffer(
          gl.READ_FRAMEBUFFER,
          previousReadFramebufferBinding
        ),
        'Smoke read-framebuffer rollback failed with a non-Error value.'
      );
      attempt(
        failures,
        () => gl.bindBuffer(
          gl.PIXEL_UNPACK_BUFFER,
          previousPixelUnpackBufferBinding
        ),
        'Smoke pixel-unpack-buffer rollback failed with a non-Error value.'
      );
      attempt(
        failures,
        () => gl.bindTexture(gl.TEXTURE_2D, previousTextureBinding),
        'Smoke target-texture rollback failed with a non-Error value.'
      );
      if (candidateFramebuffer) {
        this._pendingFramebufferDeletes.add(candidateFramebuffer);
      }
      if (candidateTexture) {
        this._pendingTextureDeletes.add(candidateTexture);
      }
      failures.push(...this._flushPendingDirectResources());
      attempt(
        failures,
        () => requireCleanWebGLState(
          gl,
          'Smoke render-target rollback'
        ),
        'Smoke render-target rollback inspection failed with a non-Error value.'
      );
      throwFailures(
        failures,
        'Smoke render-target creation or restoration failed.'
      );
    }

    this.framebuffer = candidateFramebuffer;
    this.colorTex = candidateTexture;
    this.targetWidth = targetW;
    this.targetHeight = targetH;

    if (previousFramebuffer) {
      this._pendingFramebufferDeletes.add(previousFramebuffer);
    }
    if (previousTexture) {
      this._pendingTextureDeletes.add(previousTexture);
    }
    const cleanupFailures = this._flushPendingDirectResources();
    if (cleanupFailures.length > 0) {
      throwFailures(
        cleanupFailures,
        'Smoke render target published but previous target disposal failed.'
      );
    }
  }

  // === MAIN RENDER METHOD ===

  render({ invViewProjMatrix, eye, lightDir, width, height }) {
    const gl = this.gl;

    if (this.disposed) {
      throw new Error('SmokeRenderer cannot render after disposal.');
    }
    if (this._disposeStarted) {
      throw new Error(
        'SmokeRenderer cannot render after disposal has started.'
      );
    }
    if (this.contextLost) {
      throw new Error('SmokeRenderer cannot render after WebGL context loss.');
    }
    this._convergePendingDirectResources('Smoke rendering');
    this._convergeNoiseGenerationTransaction('Smoke rendering');
    if (!this.textureInfo) return;

    if (this.noiseGenerationError) {
      const error = this.noiseGenerationError;
      this.noiseGenerationError = null;
      throw error;
    }

    // Generate noise textures on first use.
    if (
      !this.noiseTextures
      && (this._noiseGenerationTransaction ?? null) === null
    ) {
      const generationToken = ++this.noiseGenerationToken;
      const generationResolution = this.noiseResolution;
      console.log('[SmokeRenderer] Generating cloud noise textures...');

      let transaction;
      try {
        transaction = startCloudNoiseTextureGeneration(
          gl,
          generationResolution,
          generationResolution
        );
      } catch (error) {
        this.noiseGenerationInProgress = false;
        throw asError(
          error,
          'Smoke noise generation failed with a non-Error value.'
        );
      }
      this._noiseGenerationTransaction = transaction;
      this.noiseGenerationInProgress = transaction.running;
      transaction.completion.then((completedTransaction) => {
        if (
          generationToken !== this.noiseGenerationToken
          || completedTransaction !== this._noiseGenerationTransaction
          || this.disposed
          || this.contextLost
        ) {
          return;
        }
        let textures = null;
        try {
          textures = completedTransaction.takeTextures();
          if (
            !textures?.shape
            || !textures.detail
            || !textures.blueNoise
            || textures.shapeSize !== generationResolution
            || textures.detailSize !== generationResolution
            || textures.blueNoiseSize !== 128
          ) {
            throw new Error(
              'Smoke noise generation did not publish the complete exact-resolution GPU texture set.'
            );
          }
        } catch (error) {
          const failures = [asError(
            error,
            'Smoke noise publication failed with a non-Error value.'
          )];
          try {
            if (textures !== null) {
              releaseNoiseTextures(
                gl,
                textures,
                'Incomplete smoke noise generation',
                this._pendingTextureDeletes
              );
            } else {
              completedTransaction.dispose();
            }
          } catch (cleanupError) {
            failures.push(asError(
              cleanupError,
              'Incomplete smoke noise cleanup failed with a non-Error value.'
            ));
          }
          throwFailures(
            failures,
            'Smoke noise publication and cleanup failed.'
          );
        }
        this.noiseTextures = textures;
        this._noiseGenerationTransaction = null;
        this.noiseGenerationInProgress = false;
        console.log('[SmokeRenderer] Cloud noise textures ready');
      }).catch((error) => {
        if (
          generationToken !== this.noiseGenerationToken
          || transaction !== this._noiseGenerationTransaction
          || this.disposed
          || this.contextLost
        ) {
          return;
        }
        this.noiseGenerationInProgress = false;
        if (transaction.cleanupComplete) {
          this._noiseGenerationTransaction = null;
        }
        if (transaction.cancelled) return;
        this.noiseGenerationError = asError(
          error,
          'Smoke noise generation failed with a non-Error value.'
        );
      });
      return;
    }

    // The existing scene remains visible while exact GPU noise generation finishes.
    if (!this.noiseTextures) {
      return;
    }

    const needsOffscreen = this.resolutionScale !== 1.0;
    let targetW = width, targetH = height;
    const nextFrameIndex = this.frameIndex + 1;
    const failures = [];
    try {
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      gl.disable(gl.SAMPLE_COVERAGE);
      gl.enable(gl.DITHER);
      gl.colorMask(true, true, true, true);
      gl.blendEquation(gl.FUNC_ADD);

      if (needsOffscreen) {
        this.ensureRenderTarget(width, height);
        targetW = this.targetWidth;
        targetH = this.targetHeight;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
        gl.viewport(0, 0, targetW, targetH);
        gl.disable(gl.BLEND);
        gl.clearBufferfv(gl.COLOR, 0, TRANSPARENT_BLACK);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }

      gl.useProgram(this.smokeProgram);
      gl.bindVertexArray(this.smokeVertexArray);

      gl.uniformMatrix4fv(
        this.smokeUniformLocations.invViewProj,
        false,
        invViewProjMatrix
      );
      gl.uniform3fv(this.smokeUniformLocations.cameraPos, eye);
      gl.uniform3fv(this.smokeUniformLocations.volumeMin, this.volumeMin);
      gl.uniform3fv(this.smokeUniformLocations.volumeMax, this.volumeMax);
      gl.uniform1f(
        this.smokeUniformLocations.gridSize,
        this.textureInfo.gridSize
      );
      gl.uniform3fv(this.smokeUniformLocations.smokeColor, this.color);
      gl.uniform3fv(this.smokeUniformLocations.lightDir, lightDir);

      const timeSeconds = (performance.now() - this.startTime) * 0.001;
      gl.uniform1f(this.smokeUniformLocations.time, timeSeconds);
      gl.uniform1f(
        this.smokeUniformLocations.animationSpeed,
        this.animationSpeed
      );
      gl.uniform1f(
        this.smokeUniformLocations.densityMultiplier,
        this.density
      );
      gl.uniform1f(
        this.smokeUniformLocations.stepMultiplier,
        this.stepMultiplier
      );
      gl.uniform1f(this.smokeUniformLocations.noiseScale, this.noiseScale);
      gl.uniform1f(
        this.smokeUniformLocations.warpStrength,
        this.warpStrength
      );
      gl.uniform1f(
        this.smokeUniformLocations.detailLevel,
        this.detailLevel
      );
      gl.uniform1f(
        this.smokeUniformLocations.lightAbsorption,
        this.lightAbsorption
      );
      gl.uniform1f(
        this.smokeUniformLocations.scatterStrength,
        this.scatterStrength
      );
      gl.uniform1f(
        this.smokeUniformLocations.edgeSoftness,
        this.edgeSoftness
      );
      gl.uniform1f(
        this.smokeUniformLocations.directLight,
        this.directLight
      );
      gl.uniform1i(
        this.smokeUniformLocations.lightSamples,
        this.lightSamples
      );

      const phi = 1.618033988749895;
      const blueNoiseOffsetX = (
        (nextFrameIndex * phi) % 1.0
      ) * 128.0;
      const blueNoiseOffsetY = (
        (nextFrameIndex * phi * phi) % 1.0
      ) * 128.0;
      gl.uniform2f(
        this.smokeUniformLocations.blueNoiseOffset,
        blueNoiseOffsetX,
        blueNoiseOffsetY
      );

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, this.textureInfo.texture);
      gl.uniform1i(this.smokeUniformLocations.densityTex3D, 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, this.noiseTextures.shape);
      gl.uniform1i(this.smokeUniformLocations.shapeNoise, 1);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_3D, this.noiseTextures.detail);
      gl.uniform1i(this.smokeUniformLocations.detailNoise, 2);

      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.noiseTextures.blueNoise);
      gl.uniform1i(this.smokeUniformLocations.blueNoise, 3);

      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (needsOffscreen) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        gl.useProgram(this.compositeProgram);
        gl.bindVertexArray(this.compositeVertexArray);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
        gl.uniform1i(this.compositeUniformLocations.smokeTex, 0);
        gl.uniform2f(
          this.compositeUniformLocations.inverseResolution,
          1 / targetW,
          1 / targetH
        );
        gl.uniform1f(this.compositeUniformLocations.intensity, 1.0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    } catch (error) {
      failures.push(asError(
        error,
        'Smoke rendering failed with a non-Error value.'
      ));
    }

    attempt(
      failures,
      () => gl.bindFramebuffer(gl.FRAMEBUFFER, null),
      'Smoke framebuffer settlement failed with a non-Error value.'
    );
    attempt(
      failures,
      () => gl.viewport(0, 0, width, height),
      'Smoke viewport settlement failed with a non-Error value.'
    );
    attempt(
      failures,
      () => gl.bindVertexArray(null),
      'Smoke vertex-array settlement failed with a non-Error value.'
    );
    attempt(
      failures,
      () => gl.bindBuffer(gl.ARRAY_BUFFER, null),
      'Smoke array-buffer settlement failed with a non-Error value.'
    );
    attempt(
      failures,
      () => gl.useProgram(null),
      'Smoke program settlement failed with a non-Error value.'
    );
    attempt(
      failures,
      () => gl.activeTexture(gl.TEXTURE0),
      'Smoke active-texture settlement failed with a non-Error value.'
    );
    for (const capability of [
      gl.CULL_FACE,
      gl.RASTERIZER_DISCARD,
      gl.SAMPLE_ALPHA_TO_COVERAGE,
      gl.SAMPLE_COVERAGE,
      gl.SCISSOR_TEST,
      gl.STENCIL_TEST,
    ]) {
      attempt(
        failures,
        () => gl.disable(capability),
        'Smoke capability settlement failed with a non-Error value.'
      );
    }
    attempt(
      failures,
      () => gl.enable(gl.DITHER),
      'Smoke dither settlement failed with a non-Error value.'
    );
    attempt(
      failures,
      () => gl.colorMask(true, true, true, true),
      'Smoke color-mask settlement failed with a non-Error value.'
    );
    attempt(
      failures,
      () => gl.depthMask(true),
      'Smoke depth-mask settlement failed with a non-Error value.'
    );
    attempt(
      failures,
      () => gl.enable(gl.DEPTH_TEST),
      'Smoke depth-test settlement failed with a non-Error value.'
    );
    attempt(
      failures,
      () => gl.enable(gl.BLEND),
      'Smoke blend settlement failed with a non-Error value.'
    );
    attempt(
      failures,
      () => gl.blendEquation(gl.FUNC_ADD),
      'Smoke blend-equation settlement failed with a non-Error value.'
    );
    attempt(
      failures,
      () => gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA),
      'Smoke blend-function settlement failed with a non-Error value.'
    );
    if (failures.length > 0) {
      throwFailures(failures, 'Smoke rendering or state settlement failed.');
    }
    this.frameIndex = nextFrameIndex;
  }

  // === CLEANUP ===

  _initializePendingDisposalState() {
    this._pendingTextureDeletes ??= new Set();
    this._pendingFramebufferDeletes ??= new Set();
    this._pendingBufferDeletes ??= new Set();
    this._pendingVertexArrayDeletes ??= new Set();
    this._pendingProgramDeletes ??= new Set();
    this._pendingDensityPipelineDisposal ??= false;
    this._pendingNoiseGeneratorDisposal ??= false;
    this._noiseGenerationTransaction ??= null;
    this._disposeStarted ??= false;
  }

  _stageTerminalResourcesForDisposal() {
    const textures = new Set([
      this.textureInfo?.texture,
      this.noiseTextures?.shape,
      this.noiseTextures?.detail,
      this.noiseTextures?.blueNoise,
      this.colorTex,
    ]);
    textures.delete(null);
    textures.delete(undefined);
    for (const texture of textures) {
      this._pendingTextureDeletes.add(texture);
    }
    if (this.framebuffer) {
      this._pendingFramebufferDeletes.add(this.framebuffer);
    }
    if (this.quadBuffer) {
      this._pendingBufferDeletes.add(this.quadBuffer);
    }
    for (const vertexArray of [
      this.smokeVertexArray,
      this.compositeVertexArray,
    ]) {
      if (vertexArray) {
        this._pendingVertexArrayDeletes.add(vertexArray);
      }
    }
    for (const program of [
      this.smokeProgram,
      this.compositeProgram,
    ]) {
      if (program) {
        this._pendingProgramDeletes.add(program);
      }
    }
    this._pendingDensityPipelineDisposal = true;
    this._pendingNoiseGeneratorDisposal = true;

    // Detach the complete live publication before the first fallible GL
    // operation. The pending sets remain the authoritative exact owners.
    this.textureInfo = null;
    this.noiseTextures = null;
    this.framebuffer = null;
    this.colorTex = null;
    this.targetWidth = 0;
    this.targetHeight = 0;
    this.quadBuffer = null;
    this.smokeVertexArray = null;
    this.compositeVertexArray = null;
    this.smokeProgram = null;
    this.compositeProgram = null;
  }

  _flushPendingTerminalResources() {
    const gl = this.gl;
    const failures = this._flushPendingDirectResources();
    if (this._pendingDensityPipelineDisposal) {
      try {
        disposeDensityPipelineResources(gl);
        this._pendingDensityPipelineDisposal = false;
      } catch (error) {
        failures.push(asError(
          error,
          'Smoke density-pipeline disposal failed with a non-Error value.'
        ));
      }
    }
    if (this._pendingNoiseGeneratorDisposal) {
      try {
        disposePendingCloudNoiseGeneratorResources(gl);
        this._pendingNoiseGeneratorDisposal = false;
      } catch (error) {
        failures.push(asError(
          error,
          'Smoke noise-generator disposal failed with a non-Error value.'
        ));
      }
    }
    return failures;
  }

  dispose() {
    if (this.disposed) return false;
    this._initializePendingDisposalState();
    const failures = [];
    let transactionAttempted = false;
    if (!this._disposeStarted) {
      this._disposeStarted = true;
      this.noiseGenerationToken++;
      this.noiseGenerationInProgress = false;
      this.noiseGenerationError = null;
      const transaction = this._noiseGenerationTransaction;
      if (transaction !== null) {
        transactionAttempted = true;
        try {
          transaction.cancel(
            'SmokeRenderer disposal cancelled GPU cloud-noise generation.'
          );
        } catch (error) {
          failures.push(asError(
            error,
            'SmokeRenderer GPU noise cancellation failed with a non-Error value.'
          ));
        }
        if (transaction.cleanupComplete) {
          this._noiseGenerationTransaction = null;
        }
      }
      this._stageTerminalResourcesForDisposal();
    }

    if (this.contextLost) {
      this._noiseGenerationTransaction?.invalidate();
      this._noiseGenerationTransaction = null;
      this._pendingTextureDeletes.clear();
      this._pendingFramebufferDeletes.clear();
      this._pendingBufferDeletes.clear();
      this._pendingVertexArrayDeletes.clear();
      this._pendingProgramDeletes.clear();
      this._pendingDensityPipelineDisposal = false;
      this._pendingNoiseGeneratorDisposal = false;
      invalidateDensityPipelineResources(this.gl);
      invalidatePendingCloudNoiseGeneratorResources(this.gl);
      this.disposed = true;
      return true;
    }

    if (
      !transactionAttempted
      && this._noiseGenerationTransaction !== null
    ) {
      const transaction = this._noiseGenerationTransaction;
      try {
        transaction.dispose();
      } catch (error) {
        failures.push(asError(
          error,
          'SmokeRenderer GPU noise transaction disposal failed with a non-Error value.'
        ));
      }
      if (transaction.cleanupComplete) {
        this._noiseGenerationTransaction = null;
      }
    }
    failures.push(...this._flushPendingTerminalResources());
    if (failures.length > 0) {
      throwFailures(failures, 'SmokeRenderer disposal failed.');
    }
    this.disposed = true;
    return true;
  }
}
