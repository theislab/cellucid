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

import { contextLostError, requireCleanWebGLState } from '../gl-errors.js';
import { deleteGlObject, deleteProgramReleasingUse, restorableTexture } from '../gl-utils.js';
import {
  MAX_SMOKE_NOISE_RESOLUTION,
  MIN_SMOKE_NOISE_RESOLUTION,
} from './smoke-density-contract.js';
import {
  NOISE_VS,
  SHAPE_NOISE_FS,
  DETAIL_NOISE_FS,
  BLUE_NOISE_FS
} from '../shaders/noise-shaders.js';

function asError(value, defaultMessage) {
  return value instanceof Error ? value : new Error(defaultMessage);
}

function attempt(failures, operation, defaultMessage) {
  try {
    operation();
  } catch (error) {
    failures.push(asError(error, defaultMessage));
  }
}

function throwFailures(failures, message) {
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
}

function noiseCapabilities(gl) {
  return [
    gl.BLEND,
    gl.CULL_FACE,
    gl.DEPTH_TEST,
    gl.DITHER,
    gl.RASTERIZER_DISCARD,
    gl.SAMPLE_ALPHA_TO_COVERAGE,
    gl.SAMPLE_COVERAGE,
    gl.SCISSOR_TEST,
    gl.STENCIL_TEST,
  ];
}

function assertContextAvailable(gl, owner) {
  if (typeof gl.isContextLost === 'function' && gl.isContextLost()) {
    throw contextLostError(owner);
  }
}


function captureGenerationState(gl) {
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
  return {
    activeTexture,
    arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
    capabilities: noiseCapabilities(gl).map(capability => [
      capability,
      gl.isEnabled(capability),
    ]),
    colorMask: Array.from(gl.getParameter(gl.COLOR_WRITEMASK)),
    drawFramebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
    pixelUnpackBuffer: gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING),
    program: gl.getParameter(gl.CURRENT_PROGRAM),
    readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
    texture2D: gl.getParameter(gl.TEXTURE_BINDING_2D),
    texture3D: gl.getParameter(gl.TEXTURE_BINDING_3D),
    vertexArray: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
  };
}

function applyGenerationState(gl) {
  for (const capability of noiseCapabilities(gl)) {
    gl.disable(capability);
  }
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  gl.colorMask(true, true, true, true);
}

function restoreGenerationState(gl, state, failures) {
  attempt(
    failures,
    () => gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.drawFramebuffer),
    'GPU noise draw-framebuffer restoration failed with a non-Error value.'
  );
  attempt(
    failures,
    () => gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.readFramebuffer),
    'GPU noise read-framebuffer restoration failed with a non-Error value.'
  );
  attempt(
    failures,
    () => gl.viewport(...state.viewport),
    'GPU noise viewport restoration failed with a non-Error value.'
  );
  attempt(
    failures,
    () => gl.useProgram(state.program),
    'GPU noise program restoration failed with a non-Error value.'
  );
  attempt(
    failures,
    () => gl.bindVertexArray(state.vertexArray),
    'GPU noise vertex-array restoration failed with a non-Error value.'
  );
  attempt(
    failures,
    () => gl.bindBuffer(gl.ARRAY_BUFFER, state.arrayBuffer),
    'GPU noise array-buffer restoration failed with a non-Error value.'
  );
  attempt(
    failures,
    () => gl.bindBuffer(
      gl.PIXEL_UNPACK_BUFFER,
      state.pixelUnpackBuffer
    ),
    'GPU noise pixel-unpack-buffer restoration failed with a non-Error value.'
  );
  attempt(
    failures,
    () => gl.activeTexture(state.activeTexture),
    'GPU noise active-texture restoration failed with a non-Error value.'
  );
  attempt(
    failures,
    () => gl.bindTexture(gl.TEXTURE_2D, restorableTexture(state.texture2D)),
    'GPU noise 2D-texture restoration failed with a non-Error value.'
  );
  attempt(
    failures,
    () => gl.bindTexture(gl.TEXTURE_3D, restorableTexture(state.texture3D)),
    'GPU noise 3D-texture restoration failed with a non-Error value.'
  );
  attempt(
    failures,
    () => gl.colorMask(...state.colorMask),
    'GPU noise color-mask restoration failed with a non-Error value.'
  );
  for (const [capability, enabled] of state.capabilities) {
    attempt(
      failures,
      () => enabled ? gl.enable(capability) : gl.disable(capability),
      'GPU noise capability restoration failed with a non-Error value.'
    );
  }
}

/**
 * GPU noise generator resources: the linked noise programs, their uniform
 * locations, and the full-screen quad that a cloud-noise generation
 * transaction renders each slice with.
 */
export class GPUNoiseGenerator {
  constructor(gl, programs, uniforms) {
    this.gl = gl;
    this.programs = programs;
    this.uniforms = uniforms;
    this.quadVAO = null;
    this.quadVBO = null;
    this._pendingProgramDeletes = new Set();
    this._pendingVertexArrayDeletes = new Set();
    this._pendingBufferDeletes = new Set();
    this._disposeStarted = false;
    this._disposed = false;
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

    const previousVertexArray = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    const previousArrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    let vertexArray = null;
    let vertexBuffer = null;
    const failures = [];
    try {
      vertexArray = gl.createVertexArray();
      vertexBuffer = gl.createBuffer();
      if (!vertexArray || !vertexBuffer) {
        throw new Error('GPU noise quad allocation failed.');
      }

      gl.bindVertexArray(vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

      // Setup attribute for all programs.
      for (const prog of Object.values(this.programs)) {
        const loc = gl.getAttribLocation(prog, 'a_position');
        if (loc < 0) {
          throw new Error('GPU noise shader is missing required a_position input.');
        }
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      }
    } catch (error) {
      failures.push(asError(
        error,
        'GPU noise quad initialization failed with a non-Error value.'
      ));
    }
    attempt(
      failures,
      () => gl.bindVertexArray(previousVertexArray),
      'GPU noise vertex-array restoration failed with a non-Error value.'
    );
    attempt(
      failures,
      () => gl.bindBuffer(gl.ARRAY_BUFFER, previousArrayBuffer),
      'GPU noise array-buffer restoration failed with a non-Error value.'
    );
    if (failures.length > 0) {
      if (vertexArray) {
        attempt(
          failures,
          () => gl.deleteVertexArray(vertexArray),
          'GPU noise quad vertex-array rollback failed with a non-Error value.'
        );
      }
      if (vertexBuffer) {
        attempt(
          failures,
          () => gl.deleteBuffer(vertexBuffer),
          'GPU noise quad buffer rollback failed with a non-Error value.'
        );
      }
      throwFailures(
        failures,
        'GPU noise quad initialization and rollback failed.'
      );
    }
    this.quadVAO = vertexArray;
    this.quadVBO = vertexBuffer;
  }

  /**
   * Clean up resources
   */
  dispose() {
    if (this._disposed) return false;
    const gl = this.gl;
    this._pendingProgramDeletes ??= new Set();
    this._pendingVertexArrayDeletes ??= new Set();
    this._pendingBufferDeletes ??= new Set();

    if (!this._disposeStarted) {
      this._disposeStarted = true;
      for (const program of Object.values(this.programs)) {
        if (program) this._pendingProgramDeletes.add(program);
      }
      if (this.quadVAO) {
        this._pendingVertexArrayDeletes.add(this.quadVAO);
      }
      if (this.quadVBO) {
        this._pendingBufferDeletes.add(this.quadVBO);
      }
      this.programs = {};
      this.uniforms = {};
      this.quadVAO = null;
      this.quadVBO = null;
    }

    const failures = [];

    for (const program of this._pendingProgramDeletes) {
      try {
        deleteProgramReleasingUse(gl, program);
        this._pendingProgramDeletes.delete(program);
      } catch (error) {
        failures.push(asError(
          error,
          'GPU noise program disposal failed with a non-Error value.'
        ));
      }
    }
    for (const vertexArray of this._pendingVertexArrayDeletes) {
      try {
        gl.deleteVertexArray(vertexArray);
        this._pendingVertexArrayDeletes.delete(vertexArray);
      } catch (error) {
        failures.push(asError(
          error,
          'GPU noise vertex-array disposal failed with a non-Error value.'
        ));
      }
    }
    for (const buffer of this._pendingBufferDeletes) {
      try {
        gl.deleteBuffer(buffer);
        this._pendingBufferDeletes.delete(buffer);
      } catch (error) {
        failures.push(asError(
          error,
          'GPU noise buffer disposal failed with a non-Error value.'
        ));
      }
    }
    if (failures.length > 0) {
      throwFailures(failures, 'GPU noise disposal failed.');
    }
    this._disposed = true;
    return true;
  }
}

const DEFAULT_NOISE_BATCH_BUDGET_MS = 4;
const DEFAULT_NOISE_SLICES_PER_BATCH = 16;
const DEFAULT_NOISE_BATCH_PIXEL_BUDGET =
  DEFAULT_NOISE_SLICES_PER_BATCH * 128 * 128;

class NoiseGenerationCancellationError extends Error {
  constructor(message = 'GPU cloud-noise generation was cancelled.') {
    super(message);
    this.name = 'AbortError';
  }
}

class NoiseGenerationRetirementError extends Error {
  constructor(error, skippedCleanupOwner) {
    const exactError = asError(
      error,
      'GPU cloud-noise resource retirement failed with a non-Error value.'
    );
    super(exactError.message, { cause: exactError });
    this.name = exactError.name;
    this.skippedCleanupOwner = skippedCleanupOwner;
  }
}

function defaultNoiseBatchScheduler(callback) {
  const requestFrame = globalThis.requestAnimationFrame;
  const cancelFrame = globalThis.cancelAnimationFrame;
  const documentRef = typeof document === 'object' ? document : null;
  let frameId = null;
  let timeoutId = null;
  let settled = false;

  const removeVisibilityListener = () => {
    documentRef?.removeEventListener?.(
      'visibilitychange',
      handleVisibilityChange
    );
  };
  const run = () => {
    if (settled) return;
    settled = true;
    frameId = null;
    timeoutId = null;
    removeVisibilityListener();
    callback();
  };
  const scheduleTimeout = () => {
    if (timeoutId === null && !settled) {
      timeoutId = setTimeout(run, 0);
    }
  };
  const handleVisibilityChange = () => {
    if (!documentRef?.hidden || settled) return;
    if (frameId !== null) {
      try {
        cancelFrame(frameId);
      } catch {
        // A still-live frame is inert after the timeout wins because run()
        // shares the exact settled guard with both scheduling routes.
      }
      frameId = null;
    }
    scheduleTimeout();
  };

  if (
    typeof requestFrame === 'function'
    && typeof cancelFrame === 'function'
    && !documentRef?.hidden
  ) {
    try {
      frameId = requestFrame(run);
      documentRef?.addEventListener?.(
        'visibilitychange',
        handleVisibilityChange
      );
    } catch {
      if (frameId !== null) {
        try {
          cancelFrame(frameId);
        } catch {
          // The scheduled timeout remains cancellable even if the host frame
          // implementation rejects its own identifier.
        }
        frameId = null;
      }
      scheduleTimeout();
    }
  } else {
    scheduleTimeout();
  }
  return () => {
    if (settled) return;
    settled = true;
    removeVisibilityListener();
    if (frameId !== null) {
      cancelFrame(frameId);
      frameId = null;
    }
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
}

function requireGenerationOptions(options) {
  if (
    options === undefined
    || options === null
    || typeof options !== 'object'
    || Array.isArray(options)
    || Object.getPrototypeOf(options) !== Object.prototype
  ) {
    if (options === undefined) return {};
    throw new TypeError(
      'GPU cloud-noise generation options must be one exact plain object.'
    );
  }
  const supported = new Set([
    'batchBudgetMs',
    'maxSlicesPerBatch',
    'now',
    'schedule',
  ]);
  for (const key of Object.keys(options)) {
    if (!supported.has(key)) {
      throw new RangeError(
        `GPU cloud-noise generation option "${key}" is unknown.`
      );
    }
  }
  return options;
}

function requirePositiveFiniteNumber(value, owner) {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value <= 0
  ) {
    throw new RangeError(`${owner} must be a finite positive number.`);
  }
  return value;
}

function requirePositiveInteger(value, owner) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${owner} must be a positive integer.`);
  }
  return value;
}

function requireNoiseSize(value, owner) {
  if (
    !Number.isInteger(value)
    || value < MIN_SMOKE_NOISE_RESOLUTION
    || value > MAX_SMOKE_NOISE_RESOLUTION
  ) {
    throw new RangeError(
      `${owner} must be an integer between ${MIN_SMOKE_NOISE_RESOLUTION} and ${MAX_SMOKE_NOISE_RESOLUTION}.`
    );
  }
  return value;
}

function retireNoiseResource(
  gl,
  resource,
  deleteMethod,
  inspectionMethod,
  owner
) {
  try {
    deleteGlObject(gl, deleteMethod, resource);
    return;
  } catch (error) {
    if (typeof gl[inspectionMethod] === 'function') {
      try {
        if (gl[inspectionMethod](resource) === false) {
          return;
        }
      } catch (inspectionError) {
        throw new AggregateError(
          [
            asError(error, `${owner} cleanup failed.`),
            asError(
              inspectionError,
              `${owner} liveness inspection failed.`
            ),
          ],
          `${owner} cleanup state could not be determined.`
        );
      }
    }
    throw asError(
      error,
      `${owner} cleanup failed with a non-Error value.`
    );
  }
}

const ASYNC_NOISE_PROGRAM_SOURCES = Object.freeze({
  blueNoise: BLUE_NOISE_FS,
  detail: DETAIL_NOISE_FS,
  shape: SHAPE_NOISE_FS,
});

class AsyncNoiseGeneratorBuilder {
  constructor(gl) {
    this.gl = gl;
    this.parallelCompile = typeof gl.getExtension === 'function'
      ? gl.getExtension('KHR_parallel_shader_compile')
      : null;
    this.programs = {};
    this.pendingProgram = null;
    this.generator = null;
    this._pendingShaderDeletes = new Set();
    this._pendingProgramDeletes = new Set();
    this._disposeStarted = false;
    this._disposed = false;
  }

  get cleanupComplete() {
    return (
      this.generator === null
      && this.pendingProgram === null
      && Object.keys(this.programs).length === 0
      && this._pendingShaderDeletes.size === 0
      && this._pendingProgramDeletes.size === 0
    );
  }

  beginProgram(kind) {
    if (
      !Object.hasOwn(ASYNC_NOISE_PROGRAM_SOURCES, kind)
      || this.pendingProgram !== null
      || this.programs[kind]
      || this.generator !== null
      || this._disposeStarted
    ) {
      throw new Error(
        `GPU cloud-noise ${kind} program construction is out of order.`
      );
    }
    const gl = this.gl;
    const candidate = {
      fragmentShader: null,
      kind,
      program: null,
      vertexShader: null,
    };
    this.pendingProgram = candidate;

    candidate.vertexShader = gl.createShader(gl.VERTEX_SHADER);
    if (!candidate.vertexShader) {
      throw new Error(
        `GPU cloud-noise ${kind} vertex-shader allocation failed.`
      );
    }
    gl.shaderSource(candidate.vertexShader, NOISE_VS);
    gl.compileShader(candidate.vertexShader);

    candidate.fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    if (!candidate.fragmentShader) {
      throw new Error(
        `GPU cloud-noise ${kind} fragment-shader allocation failed.`
      );
    }
    gl.shaderSource(
      candidate.fragmentShader,
      ASYNC_NOISE_PROGRAM_SOURCES[kind]
    );
    gl.compileShader(candidate.fragmentShader);

    candidate.program = gl.createProgram();
    if (!candidate.program) {
      throw new Error(
        `GPU cloud-noise ${kind} program allocation failed.`
      );
    }
    gl.attachShader(candidate.program, candidate.vertexShader);
    gl.attachShader(candidate.program, candidate.fragmentShader);
    gl.linkProgram(candidate.program);
  }

  pollProgram(kind) {
    const candidate = this.pendingProgram;
    if (
      candidate === null
      || candidate.kind !== kind
      || !candidate.program
      || this._disposeStarted
    ) {
      throw new Error(
        `GPU cloud-noise ${kind} program polling is out of order.`
      );
    }
    if (
      this.parallelCompile !== null
      && !this.gl.getProgramParameter(
        candidate.program,
        this.parallelCompile.COMPLETION_STATUS_KHR
      )
    ) {
      return false;
    }
    if (
      !this.gl.getProgramParameter(
        candidate.program,
        this.gl.LINK_STATUS
      )
    ) {
      const programLog = this.gl.getProgramInfoLog(candidate.program);
      const vertexLog = candidate.vertexShader
        ? this.gl.getShaderInfoLog(candidate.vertexShader)
        : '';
      const fragmentLog = candidate.fragmentShader
        ? this.gl.getShaderInfoLog(candidate.fragmentShader)
        : '';
      throw new Error(
        `GPU cloud-noise ${kind} program linking failed: `
        + [programLog, vertexLog, fragmentLog].filter(Boolean).join(' | ')
      );
    }

    const failures = [];
    for (const [field, owner] of [
      ['vertexShader', `${kind} vertex shader`],
      ['fragmentShader', `${kind} fragment shader`],
    ]) {
      const shader = candidate[field];
      if (!shader) continue;
      try {
        retireNoiseResource(
          this.gl,
          shader,
          'deleteShader',
          'isShader',
          `GPU cloud-noise ${owner}`
        );
        candidate[field] = null;
      } catch (error) {
        failures.push(asError(
          error,
          `GPU cloud-noise ${owner} cleanup failed.`
        ));
      }
    }
    if (failures.length > 0) {
      throwFailures(
        failures,
        `GPU cloud-noise ${kind} linked-shader cleanup failed.`
      );
    }
    this.programs[kind] = candidate.program;
    candidate.program = null;
    this.pendingProgram = null;
    return true;
  }

  initializeGeneratorShell() {
    if (
      this.pendingProgram !== null
      || this.generator !== null
      || this._disposeStarted
      || !this.programs.shape
      || !this.programs.detail
      || !this.programs.blueNoise
    ) {
      throw new Error(
        'GPU cloud-noise generator shell initialization is out of order.'
      );
    }
    const uniforms = {
      shape: {
        slice: this.gl.getUniformLocation(
          this.programs.shape,
          'u_slice'
        ),
      },
      detail: {
        slice: this.gl.getUniformLocation(
          this.programs.detail,
          'u_slice'
        ),
      },
    };
    for (const [kind, ownedUniforms] of Object.entries(uniforms)) {
      for (const [name, location] of Object.entries(ownedUniforms)) {
        if (location === null) {
          throw new Error(
            `GPU cloud-noise ${kind} shader is missing required `
            + `${name} uniform.`
          );
        }
      }
    }

    const generator = new GPUNoiseGenerator(this.gl, this.programs, uniforms);
    this.programs = {};
    this.generator = generator;
  }

  initializeQuad() {
    if (this.generator === null || this._disposeStarted) {
      throw new Error(
        'GPU cloud-noise quad initialization is out of order.'
      );
    }
    this.generator._initQuad();
  }

  takeGenerator() {
    if (
      this.generator === null
      || !this.generator.quadVAO
      || !this.generator.quadVBO
      || this._disposeStarted
    ) {
      throw new Error(
        'GPU cloud-noise generator is not complete for ownership transfer.'
      );
    }
    const generator = this.generator;
    this.generator = null;
    this._disposed = true;
    return generator;
  }

  dispose() {
    if (this._disposed && this.cleanupComplete) return false;
    if (!this._disposeStarted) {
      this._disposeStarted = true;
      if (this.pendingProgram !== null) {
        for (const shader of [
          this.pendingProgram.vertexShader,
          this.pendingProgram.fragmentShader,
        ]) {
          if (shader) this._pendingShaderDeletes.add(shader);
        }
        if (this.pendingProgram.program) {
          this._pendingProgramDeletes.add(
            this.pendingProgram.program
          );
        }
        this.pendingProgram = null;
      }
      for (const program of Object.values(this.programs)) {
        if (program) this._pendingProgramDeletes.add(program);
      }
      this.programs = {};
    }

    const failures = [];
    for (const shader of this._pendingShaderDeletes) {
      try {
        retireNoiseResource(
          this.gl,
          shader,
          'deleteShader',
          'isShader',
          'GPU cloud-noise builder shader'
        );
        this._pendingShaderDeletes.delete(shader);
      } catch (error) {
        failures.push(asError(
          error,
          'GPU cloud-noise builder shader cleanup failed.'
        ));
      }
    }
    for (const program of this._pendingProgramDeletes) {
      try {
        retireNoiseResource(
          this.gl,
          program,
          'deleteProgram',
          'isProgram',
          'GPU cloud-noise builder program'
        );
        this._pendingProgramDeletes.delete(program);
      } catch (error) {
        failures.push(asError(
          error,
          'GPU cloud-noise builder program cleanup failed.'
        ));
      }
    }
    if (this.generator !== null) {
      try {
        this.generator.dispose();
        this.generator = null;
      } catch (error) {
        failures.push(asError(
          error,
          'GPU cloud-noise partial generator cleanup failed.'
        ));
      }
    }
    if (failures.length > 0) {
      throwFailures(
        failures,
        'GPU cloud-noise builder cleanup failed.'
      );
    }
    this._disposed = true;
    return true;
  }
}

/**
 * Cancellable, frame-batched owner for one cloud-noise texture generation.
 *
 * No WebGL work occurs during construction. Each scheduled batch captures and
 * restores the exact caller state before yielding. Until takeTextures() is
 * called, every candidate handle remains owned by this transaction and can be
 * synchronously cancelled.
 */
class GPUCloudNoiseGenerationTransaction {
  constructor(gl, shapeSize, detailSize, options = undefined) {
    if (!gl || typeof gl !== 'object') {
      throw new TypeError(
        'GPU cloud-noise generation requires a WebGL2 rendering context.'
      );
    }
    const exactOptions = requireGenerationOptions(options);
    this.gl = gl;
    this.shapeSize = requireNoiseSize(
      shapeSize,
      'GPU cloud-noise shapeSize'
    );
    this.detailSize = requireNoiseSize(
      detailSize,
      'GPU cloud-noise detailSize'
    );
    this.batchBudgetMs = requirePositiveFiniteNumber(
      exactOptions.batchBudgetMs ?? DEFAULT_NOISE_BATCH_BUDGET_MS,
      'GPU cloud-noise batchBudgetMs'
    );
    this.maxSlicesPerBatch = requirePositiveInteger(
      exactOptions.maxSlicesPerBatch
        ?? DEFAULT_NOISE_SLICES_PER_BATCH,
      'GPU cloud-noise maxSlicesPerBatch'
    );
    this._now = exactOptions.now ?? (() => performance.now());
    this._schedule = exactOptions.schedule ?? defaultNoiseBatchScheduler;
    if (typeof this._now !== 'function') {
      throw new TypeError('GPU cloud-noise now must be an exact function.');
    }
    if (typeof this._schedule !== 'function') {
      throw new TypeError(
        'GPU cloud-noise schedule must be an exact function.'
      );
    }

    this.generator = null;
    this.builder = null;
    this.shape = null;
    this.detail = null;
    this.blueNoise = null;
    this.framebuffer = null;
    this._phase = 'initialize';
    this._slice = 0;
    this._uncheckedSliceBatches = false;
    // GPU pacing. A slice batch is bounded on the CPU by `batchBudgetMs`, but
    // the noise shaders' cost lands on the GPU, after the batch returns. A
    // software renderer can take seconds per batch; submitting the next one
    // regardless queues them up, and every synchronous call behind them (a
    // frame, `getError`, a screenshot) waits for the whole queue. Each batch
    // therefore ends with a fence, the next waits for it, and the batch size
    // adapts: doubled again (up to the caps) when the GPU finished a batch by
    // the next scheduling turn, kept when it needed one turn more, and halved
    // only when it outlasted two. A fence one turn late is the renderer's
    // latency, not the batch's cost: where frames take seconds a batch of any
    // size signals a turn late, and halving on that drove every batch to a
    // single slice at two turns each.
    this._gpuFence = null;
    this._gpuFencePolls = 0;
    this._adaptiveSliceCap = this.maxSlicesPerBatch;
    this._scheduledCancellation = null;
    this._state = 'pending';
    this._settled = false;
    this._taskDurations = [];
    this._taskTimings = [];
    this._resolveCompletion = null;
    this._rejectCompletion = null;
    this.completion = new Promise((resolve, reject) => {
      this._resolveCompletion = resolve;
      this._rejectCompletion = reject;
    });
  }

  get cancelled() {
    return this._state === 'cancelled';
  }

  get completed() {
    return this._state === 'completed';
  }

  get cleanupComplete() {
    return (
      this.generator === null
      && this.builder === null
      && this.shape === null
      && this.detail === null
      && this.blueNoise === null
      && this.framebuffer === null
      && this._scheduledCancellation === null
      && this._gpuFence === null
    );
  }

  get running() {
    return this._state === 'pending' || this._state === 'running';
  }

  get settled() {
    return this._settled;
  }

  getTaskDurations() {
    return this._taskDurations.slice();
  }

  getTaskTimings() {
    return this._taskTimings.map(timing => ({ ...timing }));
  }

  start() {
    if (this._state !== 'pending') {
      throw new Error(
        'GPU cloud-noise generation can only be started once.'
      );
    }
    this._state = 'running';
    try {
      this._scheduleNextBatch();
    } catch (error) {
      this._fail(error);
    }
    return this;
  }

  _scheduleNextBatch() {
    if (this._state !== 'running') return;
    if (this._scheduledCancellation !== null) {
      throw new Error(
        'GPU cloud-noise generation already owns a scheduled batch.'
      );
    }
    let callbackRan = false;
    const cancellation = this._schedule(() => {
      callbackRan = true;
      this._scheduledCancellation = null;
      this._runScheduledBatch();
    });
    if (callbackRan) {
      throw new TypeError(
        'GPU cloud-noise schedule must defer its callback.'
      );
    }
    if (typeof cancellation !== 'function') {
      throw new TypeError(
        'GPU cloud-noise schedule must return a cancellation function.'
      );
    }
    this._scheduledCancellation = cancellation;
  }

  _runScheduledBatch() {
    if (this._state !== 'running') return;
    const phase = this._phase;
    const sliceStart = this._slice;
    const startedAt = this._now();
    let failed = false;
    let waitedForGpu = false;
    const phases = [];
    try {
      // Nothing new is submitted while the GPU is still behind: the turn
      // only asks again on the next one.
      waitedForGpu = !this._lastBatchDrained();
      if (!waitedForGpu) this._advanceWithinBudget(phases);
      if (this._state === 'running') {
        this._scheduleNextBatch();
      }
    } catch (error) {
      failed = true;
      const skippedCleanupOwner = (
        error instanceof NoiseGenerationRetirementError
      )
        ? error.skippedCleanupOwner
        : null;
      this._fail(error, skippedCleanupOwner);
    } finally {
      const endedAt = this._now();
      if (
        typeof startedAt === 'number'
        && Number.isFinite(startedAt)
        && typeof endedAt === 'number'
        && Number.isFinite(endedAt)
        && endedAt >= startedAt
      ) {
        const duration = endedAt - startedAt;
        this._taskDurations.push(duration);
        this._taskTimings.push(Object.freeze({
          duration,
          failed,
          phase,
          // Every phase this turn ran, `phase` first; empty while waiting.
          phases: Object.freeze(phases),
          sliceEnd: this._slice,
          sliceStart,
          waitedForGpu,
        }));
      }
    }
  }

  /**
   * Advance as many phases as one turn allows.
   *
   * Most phases are a few GL calls: a uniform setup, a framebuffer deletion,
   * a program handed to the compiler. Giving each a turn of its own made a
   * generation some twenty-five animation frames long, and where a frame
   * takes seconds (a software renderer) that alone was well over a minute
   * for a 32-cubed volume. A turn now runs its first phase and then keeps
   * going while the phases after it fit in `batchBudgetMs`. The first phase
   * is not counted against that budget: its error check waits for the GPU to
   * finish the frame queued ahead of it, which is the renderer's time, not
   * this generation's, and on a slow renderer that wait alone exceeds any
   * budget. A turn still ends at a program that is compiling, before a slice
   * batch (each batch is a turn of its own, closed by its fence), and at
   * completion.
   */
  _advanceWithinBudget(phases) {
    let phase = this._phase;
    phases.push(phase);
    this._advance();
    const budgetStartedAt = this._now();
    while (
      this._state === 'running'
      // A program still compiling stays in its phase until a later turn.
      && this._phase !== phase
      && this._gpuFence === null
      && !this._phase.endsWith('-slices')
      && (this._now() - budgetStartedAt) < this.batchBudgetMs
    ) {
      phase = this._phase;
      phases.push(phase);
      this._advance();
    }
  }

  /**
   * Whether the GPU has finished the last slice batch, adapting the next
   * batch's size to how long it took. True when no batch is outstanding.
   */
  _lastBatchDrained() {
    const fence = this._gpuFence;
    if (fence === null) return true;
    const gl = this.gl;
    assertContextAvailable(gl, 'GPU cloud-noise batch fence');
    if (gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED) {
      this._gpuFencePolls += 1;
      if (this._gpuFencePolls === 2) {
        this._adaptiveSliceCap = Math.max(1, Math.floor(this._adaptiveSliceCap / 2));
      }
      return false;
    }
    if (this._gpuFencePolls === 0) {
      this._adaptiveSliceCap = Math.min(this.maxSlicesPerBatch, this._adaptiveSliceCap * 2);
    }
    this._gpuFence = null;
    gl.deleteSync(fence);
    return true;
  }

  /**
   * Run one step under the generator's own GL state and restore the caller's.
   *
   * `verifyWebGLErrors` brackets the step with `getError()`. Each call drains
   * the command stream to the GPU process and waits for the answer, which is
   * the cost `batchBudgetMs` exists to bound, so slice batches pass false and
   * their errors are read once, by the finalization that follows them.
   */
  _withExactCallerState(owner, operation, verifyWebGLErrors = true) {
    assertContextAvailable(this.gl, `${owner} preflight`);
    if (verifyWebGLErrors) {
      requireCleanWebGLState(this.gl, `${owner} preflight`);
    }
    const previousState = captureGenerationState(this.gl);
    const failures = [];
    let result;
    try {
      applyGenerationState(this.gl);
      result = operation();
      assertContextAvailable(this.gl, owner);
      if (verifyWebGLErrors) requireCleanWebGLState(this.gl, owner);
    } catch (error) {
      failures.push(asError(
        error,
        `${owner} failed with a non-Error value.`
      ));
    }
    restoreGenerationState(this.gl, previousState, failures);
    if (verifyWebGLErrors) {
      try {
        requireCleanWebGLState(this.gl, `${owner} state restoration`);
      } catch (error) {
        failures.push(asError(
          error,
          `${owner} state restoration failed with a non-Error value.`
        ));
      }
    }
    if (failures.length > 0) {
      throwFailures(failures, `${owner} or state restoration failed.`);
    }
    return result;
  }

  _advance() {
    switch (this._phase) {
      case 'initialize':
        this._withExactCallerState(
          'GPU cloud-noise generator initialization',
          () => {
            this.builder = new AsyncNoiseGeneratorBuilder(this.gl);
          }
        );
        this._phase = 'shape-program-create';
        return;
      case 'shape-program-create':
        this._beginGeneratorProgram('shape');
        return;
      case 'shape-program-await':
        this._pollGeneratorProgram('shape', 'detail-program-create');
        return;
      case 'detail-program-create':
        this._beginGeneratorProgram('detail');
        return;
      case 'detail-program-await':
        this._pollGeneratorProgram('detail', 'blue-program-create');
        return;
      case 'blue-program-create':
        this._beginGeneratorProgram('blueNoise');
        return;
      case 'blueNoise-program-await':
        this._pollGeneratorProgram('blueNoise', 'uniforms-initialize');
        return;
      case 'uniforms-initialize':
        this._withExactCallerState(
          'GPU cloud-noise uniform initialization',
          () => {
            this.builder.initializeGeneratorShell();
          }
        );
        this._phase = 'quad-initialize';
        return;
      case 'quad-initialize':
        this._withExactCallerState(
          'GPU cloud-noise quad initialization',
          () => {
            this.builder.initializeQuad();
            this.generator = this.builder.takeGenerator();
            this.builder = null;
          }
        );
        this._phase = 'shape-allocate';
        return;
      case 'shape-allocate':
        this._allocate3DTexture('shape', this.shapeSize);
        this._phase = 'shape-slices';
        return;
      case 'shape-slices':
        this._draw3DSliceBatch('shape', this.shapeSize);
        if (this._slice === this.shapeSize) {
          this._phase = 'shape-finalize';
        }
        return;
      case 'shape-finalize':
        this._finalize3DTexture('shape');
        this._phase = 'shape-framebuffer-retire';
        return;
      case 'shape-framebuffer-retire':
        this._retireFramebuffer();
        this._phase = 'detail-allocate';
        return;
      case 'detail-allocate':
        this._allocate3DTexture('detail', this.detailSize);
        this._phase = 'detail-slices';
        return;
      case 'detail-slices':
        this._draw3DSliceBatch('detail', this.detailSize);
        if (this._slice === this.detailSize) {
          this._phase = 'detail-finalize';
        }
        return;
      case 'detail-finalize':
        this._finalize3DTexture('detail');
        this._phase = 'detail-framebuffer-retire';
        return;
      case 'detail-framebuffer-retire':
        this._retireFramebuffer();
        this._phase = 'blue-allocate-draw';
        return;
      case 'blue-allocate-draw':
        this._allocateAndDrawBlueNoise();
        this._phase = 'blue-framebuffer-retire';
        return;
      case 'blue-framebuffer-retire':
        this._retireFramebuffer();
        this._phase = 'generator-retire';
        return;
      case 'generator-retire':
        this._retireGenerator();
        this._complete();
        return;
      default:
        throw new Error(
          `GPU cloud-noise generation has invalid phase "${this._phase}".`
        );
    }
  }

  _beginGeneratorProgram(kind) {
    this._withExactCallerState(
      `GPU cloud-noise ${kind} program construction`,
      () => {
        this.builder.beginProgram(kind);
      }
    );
    this._phase = `${kind}-program-await`;
  }

  _pollGeneratorProgram(kind, nextPhase) {
    const complete = this._withExactCallerState(
      `GPU cloud-noise ${kind} program polling`,
      () => this.builder.pollProgram(kind)
    );
    if (complete) this._phase = nextPhase;
  }

  _allocate3DTexture(kind, size) {
    const gl = this.gl;
    this._withExactCallerState(
      `GPU cloud-noise ${kind} allocation`,
      () => {
        const texture = gl.createTexture();
        if (!texture) {
          throw new Error(
            `GPU cloud-noise ${kind} texture allocation failed.`
          );
        }
        this[kind] = texture;
        gl.bindTexture(gl.TEXTURE_3D, texture);
        gl.texImage3D(
          gl.TEXTURE_3D,
          0,
          gl.RGBA8,
          size,
          size,
          size,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null
        );

        const framebuffer = gl.createFramebuffer();
        if (!framebuffer) {
          throw new Error(
            `GPU cloud-noise ${kind} framebuffer allocation failed.`
          );
        }
        this.framebuffer = framebuffer;
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTextureLayer(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          texture,
          0,
          0
        );
        if (
          gl.checkFramebufferStatus(gl.FRAMEBUFFER)
          !== gl.FRAMEBUFFER_COMPLETE
        ) {
          throw new Error(
            `GPU cloud-noise ${kind} framebuffer is incomplete.`
          );
        }
      }
    );
    this._slice = 0;
  }

  _draw3DSliceBatch(kind, size) {
    const gl = this.gl;
    const program = this.generator?.programs[kind];
    const uniforms = this.generator?.uniforms[kind];
    const texture = this[kind];
    const framebuffer = this.framebuffer;
    if (!program || !uniforms || !texture || !framebuffer) {
      throw new Error(
        `GPU cloud-noise ${kind} slice batch has incomplete ownership.`
      );
    }
    this._withExactCallerState(
      `GPU cloud-noise ${kind} slice batch`,
      () => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.viewport(0, 0, size, size);
        gl.useProgram(program);
        gl.bindVertexArray(this.generator.quadVAO);
        const batchStartedAt = this._now();
        let batchSlices = 0;
        const resolutionSliceCap = Math.max(
          1,
          Math.floor(DEFAULT_NOISE_BATCH_PIXEL_BUDGET / (size * size))
        );
        const exactSliceCap = Math.min(
          this.maxSlicesPerBatch,
          resolutionSliceCap,
          this._adaptiveSliceCap
        );
        do {
          const z = this._slice;
          gl.framebufferTextureLayer(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            texture,
            0,
            z
          );
          gl.uniform1f(uniforms.slice, (z + 0.5) / size);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          this._slice++;
          batchSlices++;
        } while (
          this._slice < size
          && batchSlices < exactSliceCap
          && (this._now() - batchStartedAt) < this.batchBudgetMs
        );
      },
      false
    );
    this._uncheckedSliceBatches = true;
    this._gpuFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    this._gpuFencePolls = 0;
    // Start the batch now, so the fence can signal by the next turn.
    gl.flush();
  }

  _finalize3DTexture(kind) {
    const gl = this.gl;
    const texture = this[kind];
    if (!texture) {
      throw new Error(
        `GPU cloud-noise ${kind} finalization has no owned texture.`
      );
    }
    // The single error check every unverified slice batch of this texture
    // defers to: any batch failure surfaces here, before the texture is
    // finalized or published.
    assertContextAvailable(gl, `GPU cloud-noise ${kind} slice batches`);
    this._uncheckedSliceBatches = false;
    requireCleanWebGLState(gl, `GPU cloud-noise ${kind} slice batches`);
    this._withExactCallerState(
      `GPU cloud-noise ${kind} finalization`,
      () => {
        gl.bindTexture(gl.TEXTURE_3D, texture);
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
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
      }
    );
  }

  _allocateAndDrawBlueNoise() {
    const gl = this.gl;
    const size = 128;
    this._withExactCallerState(
      'GPU cloud-noise blue-noise generation',
      () => {
        const texture = gl.createTexture();
        if (!texture) {
          throw new Error(
            'GPU cloud-noise blue-noise texture allocation failed.'
          );
        }
        this.blueNoise = texture;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RG8,
          size,
          size,
          0,
          gl.RG,
          gl.UNSIGNED_BYTE,
          null
        );

        const framebuffer = gl.createFramebuffer();
        if (!framebuffer) {
          throw new Error(
            'GPU cloud-noise blue-noise framebuffer allocation failed.'
          );
        }
        this.framebuffer = framebuffer;
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          texture,
          0
        );
        if (
          gl.checkFramebufferStatus(gl.FRAMEBUFFER)
          !== gl.FRAMEBUFFER_COMPLETE
        ) {
          throw new Error(
            'GPU cloud-noise blue-noise framebuffer is incomplete.'
          );
        }

        gl.viewport(0, 0, size, size);
        gl.useProgram(this.generator.programs.blueNoise);
        gl.bindVertexArray(this.generator.quadVAO);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MIN_FILTER,
          gl.NEAREST
        );
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MAG_FILTER,
          gl.NEAREST
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      }
    );
  }

  _retireFramebuffer() {
    const framebuffer = this.framebuffer;
    if (!framebuffer) {
      throw new Error(
        'GPU cloud-noise framebuffer retirement has no owned framebuffer.'
      );
    }
    try {
      this._withExactCallerState(
        'GPU cloud-noise framebuffer retirement',
        () => {
          retireNoiseResource(
            this.gl,
            framebuffer,
            'deleteFramebuffer',
            'isFramebuffer',
            'GPU cloud-noise framebuffer'
          );
        }
      );
      this.framebuffer = null;
    } catch (error) {
      throw new NoiseGenerationRetirementError(error, 'framebuffer');
    }
  }

  _retireGenerator() {
    const generator = this.generator;
    if (!generator) {
      throw new Error(
        'GPU cloud-noise generator retirement has no owned generator.'
      );
    }
    try {
      generator.dispose();
      this.generator = null;
    } catch (error) {
      throw new NoiseGenerationRetirementError(error, 'generator');
    }
  }

  _complete() {
    this._state = 'completed';
    this._settled = true;
    this._resolveCompletion(this);
  }

  _cancelScheduledBatch(failures) {
    if (this._scheduledCancellation === null) return;
    const cancellation = this._scheduledCancellation;
    try {
      cancellation();
      this._scheduledCancellation = null;
    } catch (error) {
      failures.push(asError(
        error,
        'GPU cloud-noise scheduled-batch cancellation failed.'
      ));
    }
  }

  _cleanup(skippedCleanupOwner = null, invalidate = false) {
    const failures = [];
    this._cancelScheduledBatch(failures);
    if (invalidate) {
      this.generator = null;
      this.builder = null;
      this.shape = null;
      this.detail = null;
      this.blueNoise = null;
      this.framebuffer = null;
      this._scheduledCancellation = null;
      this._gpuFence = null;
      return failures;
    }

    if (this._gpuFence !== null) {
      try {
        this.gl.deleteSync(this._gpuFence);
        this._gpuFence = null;
      } catch (error) {
        failures.push(asError(
          error,
          'GPU cloud-noise batch fence cleanup failed.'
        ));
      }
    }

    if (this._uncheckedSliceBatches) {
      // A transaction that ends between its slice batches and their
      // finalization consumes the error flags those batches may have raised,
      // so no later owner reads them as its own.
      this._uncheckedSliceBatches = false;
      for (
        let flag = 0;
        flag < 8 && this.gl.getError() !== this.gl.NO_ERROR;
        flag++
      );
    }

    if (
      this.framebuffer !== null
      && skippedCleanupOwner !== 'framebuffer'
    ) {
      try {
        retireNoiseResource(
          this.gl,
          this.framebuffer,
          'deleteFramebuffer',
          'isFramebuffer',
          'GPU cloud-noise framebuffer'
        );
        this.framebuffer = null;
      } catch (error) {
        failures.push(asError(
          error,
          'GPU cloud-noise framebuffer cleanup failed.'
        ));
      }
    }

    const seenTextures = new Set();
    for (const field of ['shape', 'detail', 'blueNoise']) {
      const texture = this[field];
      if (texture === null) continue;
      if (seenTextures.has(texture)) {
        this[field] = null;
        continue;
      }
      seenTextures.add(texture);
      try {
        retireNoiseResource(
          this.gl,
          texture,
          'deleteTexture',
          'isTexture',
          `GPU cloud-noise ${field} texture`
        );
        this[field] = null;
      } catch (error) {
        failures.push(asError(
          error,
          `GPU cloud-noise ${field} texture cleanup failed.`
        ));
      }
    }

    if (
      this.builder !== null
      && skippedCleanupOwner !== 'builder'
    ) {
      try {
        this.builder.dispose();
        this.builder = null;
      } catch (error) {
        failures.push(asError(
          error,
          'GPU cloud-noise builder cleanup failed.'
        ));
      }
    }

    if (
      this.generator !== null
      && skippedCleanupOwner !== 'generator'
    ) {
      try {
        this.generator.dispose();
        this.generator = null;
      } catch (error) {
        failures.push(asError(
          error,
          'GPU cloud-noise generator cleanup failed.'
        ));
      }
    }
    return failures;
  }

  _fail(error, skippedCleanupOwner = null) {
    if (this._settled) return;
    const exactError = error instanceof NoiseGenerationRetirementError
      ? (error.cause ?? error)
      : asError(
        error,
        'GPU cloud-noise generation failed with a non-Error value.'
      );
    let contextLost = false;
    if (typeof this.gl.isContextLost === 'function') {
      try {
        contextLost = this.gl.isContextLost() === true;
      } catch {
        contextLost = false;
      }
    }
    const cleanupFailures = this._cleanup(
      contextLost ? null : skippedCleanupOwner,
      contextLost
    );
    this._state = 'failed';
    this._settled = true;
    if (cleanupFailures.length === 0) {
      this._rejectCompletion(exactError);
      return;
    }
    this._rejectCompletion(new AggregateError(
      [exactError, ...cleanupFailures],
      'GPU cloud-noise generation and cleanup failed.'
    ));
  }

  cancel(message = undefined) {
    if (this._state === 'consumed') return false;
    if (!this._settled) {
      this._state = 'cancelled';
      this._settled = true;
      this._rejectCompletion(new NoiseGenerationCancellationError(message));
    } else if (this._state === 'completed') {
      this._state = 'cancelled';
    }
    const failures = this._cleanup();
    if (failures.length > 0) {
      throwFailures(
        failures,
        'GPU cloud-noise cancellation cleanup failed.'
      );
    }
    return true;
  }

  dispose() {
    if (this._state === 'consumed' && this.cleanupComplete) return false;
    if (this.running) {
      return this.cancel();
    }
    const failures = this._cleanup();
    if (failures.length > 0) {
      throwFailures(
        failures,
        'GPU cloud-noise transaction disposal failed.'
      );
    }
    return true;
  }

  invalidate() {
    if (!this._settled) {
      this._state = 'cancelled';
      this._settled = true;
      this._rejectCompletion(new NoiseGenerationCancellationError(
        'GPU cloud-noise generation was invalidated after context loss.'
      ));
    } else if (this._state === 'completed') {
      this._state = 'cancelled';
    }
    this._cleanup(null, true);
    return true;
  }

  takeTextures() {
    if (this._state !== 'completed') {
      throw new Error(
        'GPU cloud-noise textures are available only after exact completion.'
      );
    }
    if (!this.shape || !this.detail || !this.blueNoise) {
      throw new Error(
        'GPU cloud-noise completion has incomplete texture ownership.'
      );
    }
    const textures = {
      shape: this.shape,
      detail: this.detail,
      blueNoise: this.blueNoise,
      shapeSize: this.shapeSize,
      detailSize: this.detailSize,
      blueNoiseSize: 128,
    };
    this.shape = null;
    this.detail = null;
    this.blueNoise = null;
    this._state = 'consumed';
    return textures;
  }
}

export function startCloudNoiseGenerationGPU(
  gl,
  shapeSize,
  detailSize,
  options = undefined
) {
  return new GPUCloudNoiseGenerationTransaction(
    gl,
    shapeSize,
    detailSize,
    options
  ).start();
}
