/**
 * @fileoverview Per-pass draw counts and GPU time, without editing the viewer.
 *
 * A frame is a sequence of passes: backdrop, grid, points, overlays,
 * highlights, edges, centroids, the orbit anchor, the MSAA resolve. Which pass
 * a draw belongs to is decided by the program it runs under, and every
 * program's active uniforms name its pass unambiguously (`u_highlightScale`
 * only exists in the highlight shader, `u_lineWidth` only in the edge shader,
 * and so on). So the profiler shadows `useProgram`, `blitFramebuffer` and
 * `clear` on the live context, the same way the upload counter shadows its
 * methods, and splits the frame at every change of pass label:
 *
 * - draw calls, ranges, vertices and instances are attributed to the pass that
 *   was current when they were issued, read as deltas of the upload counter;
 * - with `timing` on, one `TIME_ELAPSED` query brackets each run of one pass
 *   label. Queries cannot nest, so this cannot be combined with a harness that
 *   times the whole frame with its own query. Timing perturbs the frame it
 *   measures (a query per pass), so frame-time numbers from a timed window are
 *   not comparable with untimed ones.
 *
 * Programs are classified once, at their first `useProgram`, from
 * `getActiveUniform`. Shader sources are no use for this: the application
 * deletes its shaders after linking.
 *
 * The caller closes each frame with `endFrame()`, once per animation frame
 * after the viewer has drawn. The frame-cause sampler does this.
 *
 * @module app/ui/modules/benchmark/pass-profiler
 */

/**
 * Pass labels, each with the uniform names that identify its programs. The
 * first matching entry wins, so more specific families come first: the
 * highlight shader also carries `u_pointScale`, and the velocity particle
 * shader also carries the centroid shader's camera uniforms.
 */
export const PASS_SIGNATURES = Object.freeze([
  Object.freeze(['highlight', Object.freeze(['u_highlightScale', 'u_ringWidth'])]),
  Object.freeze(['points', Object.freeze(['u_lodIndexTex', 'u_pointScale'])]),
  Object.freeze(['edges', Object.freeze(['u_lineWidth', 'u_viewportSize'])]),
  Object.freeze(['grid', Object.freeze(['u_gridSpacing', 'u_gridLineWidth'])]),
  Object.freeze(['studio', Object.freeze(['u_floorWeight', 'u_backdropWeight'])]),
  Object.freeze(['orbit-anchor', Object.freeze(['u_partMatrix'])]),
  Object.freeze(['velocity-sim', Object.freeze(['u_spawnTableTex', 'u_dropChanceFast'])]),
  Object.freeze(['velocity-particles', Object.freeze(['u_particleSize'])]),
  Object.freeze([
    'velocity-post',
    Object.freeze([
      'u_previousFrame',
      'u_trailTex',
      'u_threshold',
      'u_anamorphicRatio',
      'u_direction'
    ])
  ]),
  Object.freeze(['smoke-march', Object.freeze(['u_densityTex3D'])]),
  Object.freeze(['smoke-composite', Object.freeze(['u_smokeTex'])]),
  Object.freeze([
    'smoke-build',
    Object.freeze([
      'u_slicesPerRow',
      'u_lightGridSize',
      'u_inputSize',
      'u_atlas',
      'u_layer'
    ])
  ]),
  Object.freeze(['smoke-noise', Object.freeze(['u_slice'])]),
  Object.freeze(['centroids', Object.freeze(['u_pointSize'])])
]);

/** Label of a program no signature matches. */
export const OTHER_PASS = 'other';
/** Label of `blitFramebuffer` (the MSAA resolve and any other blit). */
export const RESOLVE_PASS = 'resolve';
/** Label of `clear`. */
export const CLEAR_PASS = 'clear';
/** Label of work issued before the first pass boundary of a frame. */
export const UNATTRIBUTED_PASS = 'unattributed';

/** Shadowed context methods. */
export const PROFILED_METHOD_NAMES = Object.freeze([
  'useProgram',
  'blitFramebuffer',
  'clear'
]);

/** Upload-counter fields attributed to passes. */
const ATTRIBUTED_FIELDS = Object.freeze([
  'drawCalls',
  'multiDrawRanges',
  'verticesSubmitted',
  'instancesSubmitted'
]);

/** Frames polled before an unresolved query is abandoned by `flush()`. */
const MAX_FLUSH_FRAMES = 120;

/**
 * Label a program from its active uniform names.
 *
 * @param {Iterable<string>} uniformNames - Active uniform names; array
 *   uniforms may carry a `[0]` suffix.
 * @returns {string} Pass label, or `OTHER_PASS`.
 */
export function classifyProgramUniforms(uniformNames) {
  const names = new Set();
  for (const name of uniformNames) {
    if (typeof name !== 'string') continue;
    const bracket = name.indexOf('[');
    names.add(bracket < 0 ? name : name.slice(0, bracket));
  }
  for (const [label, signature] of PASS_SIGNATURES) {
    for (const uniform of signature) {
      if (names.has(uniform)) return label;
    }
  }
  return OTHER_PASS;
}

function readActiveUniformNames(gl, program) {
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  const names = [];
  if (!Number.isInteger(count)) return names;
  for (let index = 0; index < count; index++) {
    const info = gl.getActiveUniform(program, index);
    if (info && typeof info.name === 'string') names.push(info.name);
  }
  return names;
}

function createPassRecord() {
  return {
    entries: 0,
    drawCalls: 0,
    multiDrawRanges: 0,
    verticesSubmitted: 0,
    instancesSubmitted: 0,
    gpuMs: 0,
    gpuQueries: 0
  };
}

function requireUploadCounters(uploadCounters) {
  if (
    uploadCounters === null ||
    typeof uploadCounters !== 'object' ||
    uploadCounters.frame === null ||
    typeof uploadCounters.frame !== 'object' ||
    uploadCounters.total === null ||
    typeof uploadCounters.total !== 'object'
  ) {
    throw new TypeError(
      'The pass profiler requires the handle returned by instrumentGlUploads().'
    );
  }
  return uploadCounters;
}

/**
 * Install the pass profiler on a live context.
 *
 * @param {WebGL2RenderingContext} gl - The viewer's context.
 * @param {Object} options - Profiler options.
 * @param {Object} options.uploadCounters - Handle from `instrumentGlUploads`,
 *   installed on the same context.
 * @param {boolean} [options.timing=false] - Bracket passes with GPU timer
 *   queries (needs `EXT_disjoint_timer_query_webgl2`).
 * @param {(callback: FrameRequestCallback) => number} [options.requestFrame]
 * @returns {Object} Profiler handle.
 */
export function createPassProfiler(gl, options = {}) {
  if (gl === null || typeof gl !== 'object' || typeof gl.useProgram !== 'function') {
    throw new TypeError('The pass profiler requires one WebGL2 context.');
  }
  const uploadCounters = requireUploadCounters(options.uploadCounters);
  const requestFrame =
    options.requestFrame ?? globalThis.requestAnimationFrame?.bind(globalThis);
  const timerExtension =
    options.timing === true && typeof gl.getExtension === 'function'
      ? gl.getExtension('EXT_disjoint_timer_query_webgl2')
      : null;
  const timing = timerExtension !== null && timerExtension !== undefined;

  const programLabels = new WeakMap();
  /** Label → `performance.now()` of the last time the pass began. */
  const lastEntered = new Map();
  const now = options.now ?? (() => performance.now());
  const originals = {};
  const previousDescriptors = new Map();
  for (const name of PROFILED_METHOD_NAMES) {
    if (typeof gl[name] !== 'function') {
      throw new TypeError(`The pass profiler requires context method ${name}().`);
    }
    originals[name] = gl[name];
    previousDescriptors.set(name, Object.getOwnPropertyDescriptor(gl, name) ?? null);
  }

  /** Open windows, each a Map of label → pass record plus a frame count. */
  const windows = new Set();
  /** Queries awaiting results, oldest first: { query, label, windows }. */
  const pendingQueries = [];

  let currentLabel = UNATTRIBUTED_PASS;
  const passStart = Object.create(null);
  let activeQuery = null;
  let disjointFrames = 0;
  let abandonedQueries = 0;
  let installed = true;

  function cumulative(field) {
    return uploadCounters.total[field] + uploadCounters.frame[field];
  }

  function markPassStart() {
    for (const field of ATTRIBUTED_FIELDS) passStart[field] = cumulative(field);
  }

  function recordFor(windowRecord, label) {
    let record = windowRecord.passes.get(label);
    if (record === undefined) {
      record = createPassRecord();
      windowRecord.passes.set(label, record);
    }
    return record;
  }

  function attributeCurrentPass() {
    if (windows.size === 0) return;
    for (const windowRecord of windows) {
      const record = recordFor(windowRecord, currentLabel);
      for (const field of ATTRIBUTED_FIELDS) {
        record[field] += cumulative(field) - passStart[field];
      }
    }
  }

  function endActiveQuery() {
    if (activeQuery === null) return;
    gl.endQuery(timerExtension.TIME_ELAPSED_EXT);
    pendingQueries.push(activeQuery);
    activeQuery = null;
  }

  function beginQuery(label) {
    if (!timing || windows.size === 0) return;
    const query = gl.createQuery();
    if (query === null) return;
    gl.beginQuery(timerExtension.TIME_ELAPSED_EXT, query);
    activeQuery = { query, label, windows: [...windows] };
  }

  function transition(label) {
    if (label === currentLabel) return;
    attributeCurrentPass();
    endActiveQuery();
    currentLabel = label;
    lastEntered.set(label, now());
    markPassStart();
    for (const windowRecord of windows) recordFor(windowRecord, label).entries++;
    beginQuery(label);
  }

  function labelOf(program) {
    if (program === null || program === undefined) return null;
    let label = programLabels.get(program);
    if (label === undefined) {
      label = classifyProgramUniforms(readActiveUniformNames(gl, program));
      programLabels.set(program, label);
    }
    return label;
  }

  /** Read every query whose result is ready, oldest first. */
  function pollQueries() {
    if (!timing || pendingQueries.length === 0) return;
    const disjoint = gl.getParameter(timerExtension.GPU_DISJOINT_EXT) === true;
    if (disjoint) disjointFrames++;
    while (pendingQueries.length > 0) {
      const pending = pendingQueries[0];
      const available = gl.getQueryParameter(
        pending.query,
        gl.QUERY_RESULT_AVAILABLE
      );
      if (!available) break;
      pendingQueries.shift();
      const nanoseconds = gl.getQueryParameter(pending.query, gl.QUERY_RESULT);
      gl.deleteQuery(pending.query);
      if (disjoint) continue;
      for (const windowRecord of pending.windows) {
        const record = recordFor(windowRecord, pending.label);
        record.gpuMs += nanoseconds / 1e6;
        record.gpuQueries++;
      }
    }
  }

  const wrappers = {
    useProgram(program) {
      const label = labelOf(program);
      if (label !== null) transition(label);
      return originals.useProgram.call(gl, program);
    },
    blitFramebuffer(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) {
      transition(RESOLVE_PASS);
      return originals.blitFramebuffer.call(gl, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9);
    },
    clear(mask) {
      transition(CLEAR_PASS);
      return originals.clear.call(gl, mask);
    }
  };

  for (const name of PROFILED_METHOD_NAMES) {
    Object.defineProperty(gl, name, {
      value: wrappers[name],
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  markPassStart();

  return Object.freeze({
    /** @returns {boolean} Whether GPU timer queries are in use. */
    get timing() {
      return timing;
    },
    /** @returns {boolean} True while the wrappers are installed. */
    get installed() {
      return installed;
    },

    /**
     * Close the frame: attribute the open pass, end its query, and read every
     * query result that has arrived. Call once per animation frame, after the
     * viewer has drawn.
     */
    endFrame() {
      attributeCurrentPass();
      endActiveQuery();
      currentLabel = UNATTRIBUTED_PASS;
      markPassStart();
      for (const windowRecord of windows) windowRecord.frames++;
      pollQueries();
    },

    /**
     * Open a window that accumulates every pass until `closeWindow`.
     *
     * @returns {Object} Opaque window token.
     */
    openWindow() {
      const windowRecord = { passes: new Map(), frames: 0 };
      windows.add(windowRecord);
      return windowRecord;
    },

    /**
     * Stop accumulating into a window and wait for its GPU results.
     *
     * @param {Object} windowRecord - Token from `openWindow`.
     * @returns {Promise<Object>} Plain per-pass summary.
     */
    async closeWindow(windowRecord) {
      if (!windows.has(windowRecord)) {
        throw new Error('The pass profiler window is not open.');
      }
      windows.delete(windowRecord);
      if (timing) {
        for (
          let frame = 0;
          frame < MAX_FLUSH_FRAMES &&
          pendingQueries.some(pending => pending.windows.includes(windowRecord));
          frame++
        ) {
          await new Promise(resolve => requestFrame(resolve));
          pollQueries();
        }
        for (let index = pendingQueries.length - 1; index >= 0; index--) {
          const pending = pendingQueries[index];
          const position = pending.windows.indexOf(windowRecord);
          if (position < 0) continue;
          pending.windows.splice(position, 1);
          abandonedQueries++;
        }
      }
      const passes = {};
      for (const [label, record] of windowRecord.passes) {
        passes[label] = {
          ...record,
          drawCallsPerFrame:
            windowRecord.frames > 0 ? record.drawCalls / windowRecord.frames : 0,
          gpuMsPerFrame:
            timing && windowRecord.frames > 0 ? record.gpuMs / windowRecord.frames : null
        };
      }
      return {
        frames: windowRecord.frames,
        timing,
        disjointFrames,
        abandonedQueries,
        passes
      };
    },

    /**
     * When the pass last began, on the `performance.now()` clock, or null if
     * it never has. A scenario waits on this to know a feature is drawing
     * (`'velocity-particles'`, `'edges'`, `'smoke-march'`).
     *
     * @param {string} label
     * @returns {number|null}
     */
    lastEnteredAt(label) {
      return lastEntered.get(label) ?? null;
    },

    /**
     * The pass label assigned to `program`, classifying it if needed.
     *
     * @param {WebGLProgram} program
     * @returns {string|null}
     */
    labelOfProgram(program) {
      return labelOf(program);
    },

    /** Remove the wrappers and release every query. Idempotent. */
    restore() {
      if (!installed) return;
      if (activeQuery !== null) {
        gl.endQuery(timerExtension.TIME_ELAPSED_EXT);
        gl.deleteQuery(activeQuery.query);
        activeQuery = null;
      }
      for (const pending of pendingQueries) gl.deleteQuery(pending.query);
      pendingQueries.length = 0;
      windows.clear();
      for (const name of PROFILED_METHOD_NAMES) {
        const descriptor = previousDescriptors.get(name);
        if (descriptor === null) {
          delete gl[name];
        } else {
          Object.defineProperty(gl, name, descriptor);
        }
        if (gl[name] !== originals[name]) {
          throw new Error(
            `The pass profiler could not restore context method ${name}().`
          );
        }
      }
      installed = false;
    }
  });
}
