/**
 * The GL owner of the backdrop looks (`backdrop-looks.js`).
 *
 * LIFECYCLE
 * - `setLook(id)` starts the look's bake in idle slices: its programs compile
 *   in parallel (KHR_parallel_shader_compile where available), then one band
 *   of one cube face (or of the tile) is rendered offscreen per slice, so no
 *   slice hands the GPU more than a few milliseconds of work. Nothing is drawn
 *   until the bake has landed; the pane shows the look's surface colour
 *   meanwhile, then the look fades in over `BACKDROP_LOOK_FADE_SECONDS` (at
 *   once under reduced motion).
 * - Only the family on screen keeps its bake: choosing another family, or a
 *   background that is not a look, releases the rest. The light and dark
 *   twins of a family share their bake, so switching between them is instant.
 * - Per pane, derived data bakes (Atelier's contact shadow, the data tints)
 *   re-run in idle slices only when the pane's positions, visibility or
 *   colours change; never on a camera move. New tints apply at once: a
 *   crossfade would redraw every pane for its duration.
 *
 * COST WHILE STILL
 * Zero: no frame callback, no timers. Ambient motion (star twinkle, mote
 * drift) is off by default; when enabled it wakes the viewer through
 * `invalidate()` at most `BACKDROP_AMBIENT_MAX_HZ` times a second, and never
 * while the tab is hidden or the user prefers reduced motion (a change of
 * that setting takes effect at once).
 *
 * DRAW CONTRACT
 * `draw()` is a pure function of (look state, `version`, the pane's camera,
 * viewport and geometry): it reads baked textures and uniforms, renders one
 * opaque full-pane triangle (plus the Abyss motes) into the bound target,
 * and restores the GL state it touched. `version` changes whenever a bake
 * lands or the look, its fade or its tints change. Figure export draws with
 * a pane's frozen state (`getExportState()`) through `p.frozen`, mapped onto
 * the figure's plot rectangle by `p.ndcTransform`.
 */

import { BACKDROP_LOOK_PROGRAMS } from './backdrop-look-shaders.js';
import { deleteProgramReleasingUse, deleteTextureTracked } from '../gl-utils.js';
import {
  ATELIER_KEY_LIGHT,
  ATELIER_PAPER_GAP,
  BACKDROP_AMBIENT_MAX_HZ,
  BACKDROP_LOOK_FADE_SECONDS,
  BACKDROP_LOOKS,
  SHADOW_MAP_SIZE,
  extractDominantColors,
  isBackdropLook,
  shapeBackdropTint,
} from './backdrop-looks.js';

/** Texture units the looks bind; the scene's own passes use units 0..5. */
const UNIT_SKY = 9;
const UNIT_TILE = 10;
const UNIT_SHADOW = 11;

const IDENTITY_NDC = Object.freeze([1, 1, 0, 0]);

/** Work done in one idle slice before yielding back to the page. */
const SLICE_BUDGET_MS = 8;

/**
 * A job yields this while it waits on the GPU (a fence, a compile, a query):
 * the slice ends at once instead of polling, and the next one runs later.
 */
const WAIT = Symbol('wait');

/**
 * Each cube face and the tile are baked in scissored bands of at most this
 * many texels, so no band hands the GPU more than a slice of work: a 1024²
 * face is eight bands. Once a level has measured the GPU, bands shrink so
 * that each costs about `BAKE_BAND_GPU_BUDGET_MS` of GPU time.
 */
const BAKE_BAND_TEXELS = 131072;

/**
 * Cube faces are 1024² RGBA8 (25 MB): one texel is about 0.09° of sky, finer
 * than a pixel of a 4K or DPR-2 pane, so skies stay sharp; fine structure
 * below that comes from per-fragment detail in the draw shaders.
 *
 * A sky is baked progressively: first at `BAKE_FIRST_SIZE` (64 times fewer
 * texels, so the look appears after a small fraction of the full work), then
 * at each doubling up to `CUBE_SIZE` while the GPU keeps up. The level just
 * baked measures the GPU (milliseconds per texel, from each band's fence);
 * the next level, four times the texels, is baked only when that rate says
 * it will land within `BAKE_REFINE_BUDGET_MS`, in bands of at most
 * `BAKE_BAND_GPU_BUDGET_MS` of GPU time each, so the frames drawn between
 * bands are not held behind one. Hardware reaches 1024² in a few hundred
 * milliseconds; a software rasterizer stops at the level it can refine
 * without stalling the scene, and a very slow one shows the first level.
 */
const CUBE_SIZE = 1024;
const BAKE_FIRST_SIZE = 128;
const BAKE_BAND_GPU_BUDGET_MS = 16;
const BAKE_REFINE_BUDGET_MS = 2000;
const TILE_SIZE = 512;
const MOTE_COUNT = 3200;

/** Per family: which bake program and which draw program. */
const FAMILY_PROGRAMS = Object.freeze({
  nebula: { bake: 'bake:nebula', draw: 'draw:nebula', cube: 'byte', tile: true },
  atelier: { bake: null, draw: 'draw:atelier', cube: null, tile: false },
  abyss: { bake: 'bake:abyss', draw: 'draw:abyss', cube: 'byte', tile: true, motes: true },
  aurora: { bake: 'bake:aurora', draw: 'draw:aurora', cube: 'byte', tile: true },
});

function halfFromFloat(value) {
  // IEEE 754 binary16, round-to-nearest; inputs here are 0..1.
  const f32 = halfFromFloat.f32 ??= new Float32Array(1);
  const u32 = halfFromFloat.u32 ??= new Uint32Array(f32.buffer);
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exponent = ((x >>> 23) & 0xff) - 127 + 15;
  let mantissa = x & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    mantissa = (mantissa | 0x800000) >> (1 - exponent);
    return sign | ((mantissa + 0x1000) >> 13);
  }
  if (exponent >= 31) return sign | 0x7c00;
  const rounded = mantissa + 0x1000;
  if (rounded & 0x800000) {
    exponent += 1;
    if (exponent >= 31) return sign | 0x7c00;
    return sign | (exponent << 10);
  }
  return sign | (exponent << 10) | (rounded >> 13);
}

/**
 * Separable box blur of one channel, in place, `passes` times. Yields every
 * `BLUR_LINES_PER_UNIT` rows or columns, so even its first, unoptimised run
 * never holds a slice for long.
 */
const BLUR_LINES_PER_UNIT = 64;
function* boxBlur(field, size, radius, passes, scratch) {
  if (radius < 1) return;
  const window = radius * 2 + 1;
  for (let pass = 0; pass < passes; pass++) {
    // Rows.
    for (let y = 0; y < size; y++) {
      const row = y * size;
      let sum = 0;
      for (let x = -radius; x <= radius; x++) sum += field[row + Math.min(size - 1, Math.max(0, x))];
      for (let x = 0; x < size; x++) {
        scratch[row + x] = sum / window;
        const add = Math.min(size - 1, x + radius + 1);
        const remove = Math.max(0, x - radius);
        sum += field[row + add] - field[row + remove];
      }
      if ((y + 1) % BLUR_LINES_PER_UNIT === 0) yield;
    }
    // Columns.
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let y = -radius; y <= radius; y++) sum += scratch[Math.min(size - 1, Math.max(0, y)) * size + x];
      for (let y = 0; y < size; y++) {
        field[y * size + x] = sum / window;
        const add = Math.min(size - 1, y + radius + 1);
        const remove = Math.max(0, y - radius);
        sum += scratch[add * size + x] - scratch[remove * size + x];
      }
      if ((x + 1) % BLUR_LINES_PER_UNIT === 0) yield;
    }
  }
}

/** A cheap content signature of a visibility array (positions + filter). */
function visibilitySignature(visibility) {
  if (!(visibility instanceof Uint8Array)) return 0;
  const words = new Uint32Array(visibility.buffer, visibility.byteOffset, visibility.byteLength >>> 2);
  let hash = 2166136261 ^ visibility.length;
  for (let i = 0; i < words.length; i++) {
    hash = Math.imul(hash ^ words[i], 16777619);
  }
  for (let i = words.length * 4; i < visibility.length; i++) {
    hash = Math.imul(hash ^ visibility[i], 16777619);
  }
  return hash >>> 0;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {object} options
 * @param {() => void} options.invalidate - asks the viewer for one frame
 * @param {() => boolean} options.prefersReducedMotion
 * @param {(viewId: string) => null | {
 *   positions: Float32Array; dimension: number; colors: Uint8Array|null;
 *   visibility: Uint8Array|null; generation: number }} options.readViewSource
 */
export function createBackdropLookRenderer(gl, { invalidate, prefersReducedMotion, readViewSource }) {
  const now = () => performance.now();
  const parallelCompile = gl.getExtension('KHR_parallel_shader_compile');
  const maxPointSize = Math.min(64, gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] || 64);

  let disposed = false;
  let activeId = null;
  let opacity = 0;
  let version = 1;
  let ambientEnabled = false;
  let ambientTimer = null;
  let ambientClock = 0;
  let ambientLastWall = 0;
  let textureBytes = 0;

  /** program key -> { program, shaders, ready, failed, uniforms: Map } */
  const programs = new Map();
  /** family -> { cube, tile, ready, job, stats } */
  const families = new Map();
  /** viewId -> per-pane derived state */
  const panes = new Map();

  // -------------------------------------------------------------------------
  // Idle-slice queue
  // -------------------------------------------------------------------------
  const jobs = [];
  const jobHistory = [];
  let sliceHandle = null;
  let sliceKind = null;
  const sliceStats = { slices: 0, maxSliceMs: 0, totalMs: 0 };

  function scheduleSlice() {
    if (sliceHandle !== null || disposed) return;
    if (typeof requestIdleCallback === 'function') {
      sliceKind = 'idle';
      sliceHandle = requestIdleCallback(runSlice, { timeout: 120 });
    } else {
      sliceKind = 'timeout';
      sliceHandle = setTimeout(runSlice, 4);
    }
  }

  function cancelSlice() {
    if (sliceHandle === null) return;
    if (sliceKind === 'idle') cancelIdleCallback(sliceHandle);
    else clearTimeout(sliceHandle);
    sliceHandle = null;
  }

  function runSlice() {
    sliceHandle = null;
    if (disposed || jobs.length === 0) return;
    const start = now();
    let waiting = false;
    while (jobs.length > 0) {
      const job = jobs[0];
      const unitStart = now();
      let step;
      try {
        step = job.iterator.next();
      } catch (error) {
        jobs.shift();
        console.error(`[backdrop-looks] ${job.name} failed:`, error);
        continue;
      }
      const unitMs = now() - unitStart;
      job.cpuMs += unitMs;
      job.units += 1;
      if (unitMs > job.maxUnitMs) {
        job.maxUnitMs = unitMs;
        job.maxUnitStage = job.stage;
      }
      if (!step.done && step.value === WAIT) {
        waiting = true;
        break;
      }
      if (step.done) {
        jobs.shift();
        job.doneAt = now();
        jobHistory.push({
          name: job.name,
          units: job.units,
          cpuMs: +job.cpuMs.toFixed(2),
          maxUnitMs: +job.maxUnitMs.toFixed(2),
          maxUnitStage: job.maxUnitStage,
          wallMs: +(job.doneAt - job.startedAt).toFixed(1),
        });
        if (jobHistory.length > 40) jobHistory.shift();
      }
      if (now() - start >= SLICE_BUDGET_MS) break;
    }
    const spent = now() - start;
    sliceStats.slices += 1;
    sliceStats.totalMs += spent;
    sliceStats.maxSliceMs = Math.max(sliceStats.maxSliceMs, spent);
    if (jobs.length > 0) {
      if (waiting) {
        // Let the GPU work: look again shortly, without spinning.
        sliceKind = 'timeout';
        sliceHandle = setTimeout(runSlice, 1);
      } else {
        scheduleSlice();
      }
    }
  }

  function enqueue(name, generatorFactory, priority = false) {
    // `stage` names the part of the job running, for the diagnostics.
    const job = { name, iterator: null, cpuMs: 0, units: 0, maxUnitMs: 0, maxUnitStage: null, stage: 'start', startedAt: now(), doneAt: null, cancelled: false };
    job.iterator = generatorFactory(job);
    if (priority) jobs.unshift(job);
    else jobs.push(job);
    scheduleSlice();
    return job;
  }

  function cancelJob(job) {
    if (job === null || job === undefined) return;
    job.cancelled = true;
    const index = jobs.indexOf(job);
    if (index >= 0) jobs.splice(index, 1);
  }

  // -------------------------------------------------------------------------
  // GL state helpers
  // -------------------------------------------------------------------------
  const triangleVao = gl.createVertexArray();
  const triangleBuffer = gl.createBuffer();
  gl.bindVertexArray(triangleVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, triangleBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  let moteVao = null;
  let moteBuffer = null;
  function ensureMotes() {
    if (moteVao !== null) return;
    const seeds = new Float32Array(MOTE_COUNT * 4);
    let s = 1234567;
    const random = () => {
      s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909);
      s ^= s >>> 16;
      return (s >>> 0) / 4294967296;
    };
    for (let i = 0; i < MOTE_COUNT; i++) {
      seeds[i * 4] = random() * 2 - 1;
      seeds[i * 4 + 1] = random() * 2 - 1;
      seeds[i * 4 + 2] = random() * 2 - 1;
      seeds[i * 4 + 3] = random();
    }
    moteVao = gl.createVertexArray();
    moteBuffer = gl.createBuffer();
    gl.bindVertexArray(moteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, moteBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    textureBytes += seeds.byteLength;
  }

  function saveState() {
    return {
      framebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
      viewport: gl.getParameter(gl.VIEWPORT),
      program: gl.getParameter(gl.CURRENT_PROGRAM),
      vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      blend: gl.isEnabled(gl.BLEND),
      depth: gl.isEnabled(gl.DEPTH_TEST),
      scissor: gl.isEnabled(gl.SCISSOR_TEST),
      scissorBox: gl.getParameter(gl.SCISSOR_BOX),
      cull: gl.isEnabled(gl.CULL_FACE),
      activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE),
    };
  }

  function restoreState(state) {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.framebuffer);
    gl.viewport(state.viewport[0], state.viewport[1], state.viewport[2], state.viewport[3]);
    gl.useProgram(state.program);
    gl.bindVertexArray(state.vao);
    (state.blend ? gl.enable : gl.disable).call(gl, gl.BLEND);
    (state.depth ? gl.enable : gl.disable).call(gl, gl.DEPTH_TEST);
    (state.scissor ? gl.enable : gl.disable).call(gl, gl.SCISSOR_TEST);
    gl.scissor(state.scissorBox[0], state.scissorBox[1], state.scissorBox[2], state.scissorBox[3]);
    (state.cull ? gl.enable : gl.disable).call(gl, gl.CULL_FACE);
    gl.activeTexture(state.activeTexture);
  }

  // -------------------------------------------------------------------------
  // Programs
  // -------------------------------------------------------------------------
  function startProgram(key) {
    let record = programs.get(key);
    if (record) return record;
    const source = BACKDROP_LOOK_PROGRAMS[key];
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, source.vs);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, source.fs);
    gl.compileShader(fs);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, key === 'draw:motes' ? 'a_seed' : 'a_corner');
    gl.linkProgram(program);
    record = { key, program, vs, fs, ready: false, failed: false, uniforms: new Map(), startedAt: now(), readyAt: 0 };
    programs.set(key, record);
    return record;
  }

  /** True once the program is settled (ready or failed). */
  function pollProgram(record) {
    if (record.ready || record.failed) return true;
    if (parallelCompile && !gl.getProgramParameter(record.program, parallelCompile.COMPLETION_STATUS_KHR)) {
      return false;
    }
    if (!gl.getProgramParameter(record.program, gl.LINK_STATUS)) {
      record.failed = true;
      console.error(
        `[backdrop-looks] ${record.key} failed to link:`,
        gl.getProgramInfoLog(record.program),
        gl.getShaderInfoLog(record.vs),
        gl.getShaderInfoLog(record.fs)
      );
      return true;
    }
    const count = gl.getProgramParameter(record.program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(record.program, i);
      const name = info.name.replace(/\[0\]$/, '');
      record.uniforms.set(name, gl.getUniformLocation(record.program, info.name));
    }
    record.ready = true;
    record.readyAt = now();
    return true;
  }

  function* awaitPrograms(keys) {
    const records = keys.map(startProgram);
    while (!records.every(pollProgram)) yield WAIT;
    return records;
  }

  // -------------------------------------------------------------------------
  // Family bakes
  // -------------------------------------------------------------------------
  function createTexture(target, unit) {
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, texture);
    return texture;
  }

  function familyState(family) {
    let state = families.get(family);
    if (!state) {
      state = {
        family,
        cube: null,
        cubeSize: 0,
        // The next level while it bakes; deleted with the family if cancelled.
        candidateCube: null,
        tile: null,
        ready: false,
        job: null,
        framebuffer: null,
        stats: null,
      };
      families.set(family, state);
    }
    return state;
  }

  /**
   * Estimate the GPU time of a band from its fence: the fence signalled
   * between the previous poll and this one, so the midpoint of that interval
   * (from the issue for the first poll). A band that signals at its first
   * poll on fast hardware is thereby counted as half the poll's wait, not as
   * the timer latency the wait was.
   */
  function* awaitFence(fence, issuedAt, job) {
    let previous = issuedAt;
    job.stage = 'band-wait';
    for (;;) {
      const status = gl.clientWaitSync(fence, gl.SYNC_FLUSH_COMMANDS_BIT, 0);
      const polled = now();
      if (status !== gl.TIMEOUT_EXPIRED) {
        gl.deleteSync(fence);
        job.stage = 'bands';
        return (previous - issuedAt) + (polled - previous) / 2;
      }
      previous = polled;
      yield WAIT;
    }
  }

  /**
   * Bake one target (a cube face `face` 0..5 of `texture`, or the tile when
   * `face` is -1) of `size` texels a side, `rowsPerBand` rows at a time, each
   * band waited for before the next is issued. Adds to `level` what the GPU
   * did. False when the job was cancelled part way.
   */
  function* bakeTarget(state, bake, face, texture, size, rowsPerBand, job, level) {
    for (let row = 0; row < size; row += rowsPerBand) {
      if (job.cancelled) return false;
      const rows = Math.min(rowsPerBand, size - row);
      const issuedAt = now();
      const saved = saveState();
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.framebuffer);
      if (face >= 0) {
        gl.framebufferTexture2D(
          gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, texture, 0
        );
      } else {
        gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      }
      gl.viewport(0, 0, size, size);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, row, size, rows);
      gl.useProgram(bake.program);
      gl.uniform1i(bake.uniforms.get('u_face'), face);
      gl.uniform1f(bake.uniforms.get('u_size'), size);
      gl.bindVertexArray(triangleVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
      if (face < 0 && row + rows >= size) {
        gl.activeTexture(gl.TEXTURE0 + UNIT_TILE);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.generateMipmap(gl.TEXTURE_2D);
      }
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      restoreState(saved);
      level.issueMs += now() - issuedAt;
      const gpuMs = yield* awaitFence(fence, issuedAt, job);
      level.gpuMs += gpuMs;
      level.maxBandMs = Math.max(level.maxBandMs, gpuMs);
      level.texels += size * rows;
      level.bands += 1;
    }
    return true;
  }

  /** Rows per band so a band costs about the GPU budget at `rate` ms/texel. */
  function rowsPerBandFor(size, rate) {
    const texelsPerBand = rate === null
      ? BAKE_BAND_TEXELS
      : Math.min(BAKE_BAND_TEXELS, BAKE_BAND_GPU_BUDGET_MS / rate);
    return Math.max(1, Math.min(size, Math.floor(texelsPerBand / size)));
  }

  function createCube(size) {
    const cube = createTexture(gl.TEXTURE_CUBE_MAP, UNIT_SKY);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, 1, gl.RGBA8, size, size);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return cube;
  }

  function* bakeFamily(family, job) {
    const spec = FAMILY_PROGRAMS[family];
    const state = familyState(family);
    const stats = {
      family,
      startedAt: job.startedAt,
      programsReadyMs: 0,
      // One record per level baked: size, bands, GPU and issue time, texels.
      levels: [],
      cubeSize: 0,
      texelRateMs: null,
      readyMs: 0,
      wallMs: 0,
      cpuMs: 0,
      bytes: 0,
    };
    state.stats = stats;
    const keys = [spec.draw];
    if (spec.bake) keys.push(spec.bake);
    if (spec.motes) keys.push('draw:motes');
    job.stage = 'compile';
    const records = yield* awaitPrograms(keys);
    job.stage = 'allocate';
    stats.programsReadyMs = now() - job.startedAt;
    if (records.some((record) => record.failed)) return;
    if (spec.motes) ensureMotes();
    if (spec.bake) {
      const bake = programs.get(spec.bake);
      const tileBytes = Math.round(TILE_SIZE * TILE_SIZE * 4 * 4 / 3);
      const newLevel = (size) => ({ size, bands: 0, gpuMs: 0, maxBandMs: 0, issueMs: 0, texels: 0, wallMs: 0 });
      let rate = null;
      state.framebuffer ??= gl.createFramebuffer();

      // The first sky level: small enough to land soon everywhere, and the
      // measurement every later decision rests on.
      let size = BAKE_FIRST_SIZE;
      const saved = saveState();
      let candidate = createCube(size);
      restoreState(saved);
      yield;
      job.stage = 'bands';
      let level = newLevel(size);
      const levelStart = now();
      for (let face = 0; face < 6; face++) {
        const done = yield* bakeTarget(state, bake, face, candidate, size, rowsPerBandFor(size, rate), job, level);
        if (!done) { deleteTextureTracked(gl, candidate); return; }
      }
      level.wallMs = now() - levelStart;
      stats.levels.push(level);
      rate = level.gpuMs / level.texels;
      stats.texelRateMs = rate;
      state.cube = candidate;
      state.cubeSize = size;
      stats.cubeSize = size;
      stats.bytes = size * size * 6 * 4 + tileBytes;
      textureBytes += stats.bytes;

      // The tile, banded by what the sky just measured.
      const savedTile = saveState();
      state.tile = createTexture(gl.TEXTURE_2D, UNIT_TILE);
      gl.texStorage2D(gl.TEXTURE_2D, Math.log2(TILE_SIZE) + 1, gl.RGBA8, TILE_SIZE, TILE_SIZE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      restoreState(savedTile);
      yield;
      const tileLevel = newLevel(TILE_SIZE);
      const tileStart = now();
      const tileDone = yield* bakeTarget(state, bake, -1, state.tile, TILE_SIZE, rowsPerBandFor(TILE_SIZE, rate), job, tileLevel);
      if (!tileDone) return;
      tileLevel.wallMs = now() - tileStart;
      stats.tile = tileLevel;

      // The look can show: the fade starts, the viewer draws one frame.
      stats.readyMs = now() - job.startedAt;
      state.ready = true;
      version += 1;
      invalidate();
      notifyReady();

      // Refine while the next level (four times the texels) is expected to
      // land within the budget at the rate the last one measured.
      while (size < CUBE_SIZE) {
        const next = size * 2;
        const predictedMs = rate * next * next * 6;
        if (predictedMs > BAKE_REFINE_BUDGET_MS) break;
        const savedNext = saveState();
        candidate = createCube(next);
        restoreState(savedNext);
        state.candidateCube = candidate;
        yield;
        level = newLevel(next);
        const start = now();
        let complete = true;
        for (let face = 0; face < 6 && complete; face++) {
          complete = yield* bakeTarget(state, bake, face, candidate, next, rowsPerBandFor(next, rate), job, level);
        }
        if (!complete) {
          deleteTextureTracked(gl, candidate);
          state.candidateCube = null;
          return;
        }
        level.wallMs = now() - start;
        stats.levels.push(level);
        rate = level.gpuMs / level.texels;
        stats.texelRateMs = rate;
        // Swap between frames: the next frame samples the sharper sky.
        deleteTextureTracked(gl, state.cube);
        state.cube = candidate;
        state.candidateCube = null;
        textureBytes += next * next * 6 * 4 - size * size * 6 * 4;
        stats.bytes += next * next * 6 * 4 - size * size * 6 * 4;
        size = next;
        state.cubeSize = size;
        stats.cubeSize = size;
        version += 1;
        invalidate();
      }
      stats.wallMs = now() - job.startedAt;
      stats.cpuMs = job.cpuMs;
      state.job = null;
      return;
    }
    stats.wallMs = now() - job.startedAt;
    stats.cpuMs = job.cpuMs;
    state.ready = true;
    state.job = null;
    version += 1;
    invalidate();
    notifyReady();
  }

  function ensureFamily(family) {
    const state = familyState(family);
    if (state.ready || state.job !== null) return state;
    state.job = enqueue(`bake ${family}`, (job) => bakeFamily(family, job), true);
    return state;
  }

  /**
   * Release every family's baked textures except `keep`'s: only the look on
   * screen (and its twin, which shares the bake) stays resident.
   */
  function evictFamiliesExcept(keep) {
    for (const [family, state] of families) {
      if (family === keep) continue;
      cancelJob(state.job);
      state.job = null;
      if (state.cube || state.tile) textureBytes -= state.stats?.bytes ?? 0;
      if (state.cube) deleteTextureTracked(gl, state.cube);
      if (state.candidateCube) deleteTextureTracked(gl, state.candidateCube);
      if (state.tile) deleteTextureTracked(gl, state.tile);
      if (state.framebuffer) gl.deleteFramebuffer(state.framebuffer);
      state.cube = null;
      state.cubeSize = 0;
      state.candidateCube = null;
      state.tile = null;
      state.framebuffer = null;
      state.ready = false;
    }
  }

  const readyWaiters = new Set();
  function notifyReady() {
    for (const waiter of [...readyWaiters]) {
      if (waiter.check()) {
        readyWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Per-pane derived bakes: tints and the contact shadow
  // -------------------------------------------------------------------------
  function paneState(viewId) {
    let pane = panes.get(viewId);
    if (!pane) {
      pane = {
        generation: -1,
        tints: null,
        tintLook: null,
        tintJob: null,
        shadowKey: null,
        checkedKey: null,
        shadowJob: null,
        shadowTexture: null,
        shadowSpare: null,
        shadowPacked: null,
        shadowWindow: [0, 0, 1],
        shadowStats: null,
      };
      panes.set(viewId, pane);
    }
    return pane;
  }

  function lookTintsLinear(look) {
    return look.defaultTints.map((srgb) => shapeBackdropTint(srgb, 0.85));
  }

  function* computeTints(viewId, source, look, job) {
    const pane = paneState(viewId);
    let tints = lookTintsLinear(look);
    if (source !== null && source.colors instanceof Uint8Array && source.colors.length > 0) {
      const dominant = extractDominantColors(source.colors, source.visibility, 3, 65536);
      yield;
      if (job.cancelled) return;
      if (dominant.colors.length > 0) {
        const saturation = look.tone === 'dark' ? 0.8 : 0.6;
        tints = [0, 1, 2].map((i) => shapeBackdropTint(
          dominant.colors[Math.min(i, dominant.colors.length - 1)],
          saturation
        ));
      }
    }
    // Tints change at once: a crossfade would redraw every pane of the scene
    // for its whole duration.
    pane.tints = tints;
    pane.tintLook = look.id;
    pane.tintJob = null;
    notifyReady();
    version += 1;
    invalidate();
  }

  function currentTints(pane, look) {
    if (pane.tints === null || pane.tintLook !== look.id) return null;
    return pane.tints;
  }

  function* bakeShadow(viewId, source, geometry, planar, key, job) {
    const pane = paneState(viewId);
    const started = now();
    const size = SHADOW_MAP_SIZE;
    job.stage = 'shadow-allocate';
    const sharp = new Float32Array(size * size);
    const soft = new Float32Array(size * size);
    const ao = new Float32Array(size * size);
    const scratch = new Float32Array(size * size);
    const { positions, dimension, visibility } = source;
    const count = Math.floor(positions.length / dimension);
    // The floor (3-D) or the paper behind the data (planar).
    let centerU;
    let centerV;
    let half;
    let lightU;
    let lightV;
    let paperZ = 0;
    const heightRange = planar
      ? Math.max(geometry.extentZ * 2 + ATELIER_PAPER_GAP, ATELIER_PAPER_GAP)
      : Math.max(geometry.extentY * 2 + 0.12, 0.12);
    if (planar) {
      // Toward the light: up-left and toward the viewer, so the data's
      // shadow falls down-right on the paper.
      const paperLight = [-0.45, 0.55, 0.70];
      lightU = -paperLight[0] / paperLight[2];
      lightV = -paperLight[1] / paperLight[2];
      paperZ = geometry.stageZ - geometry.extentZ - ATELIER_PAPER_GAP;
      centerU = geometry.stageX;
      centerV = geometry.centerY;
      half = Math.max(geometry.extentX, geometry.extentY) * 1.3 + heightRange * 0.8 + 0.3;
    } else {
      lightU = -ATELIER_KEY_LIGHT[0] / ATELIER_KEY_LIGHT[1];
      lightV = -ATELIER_KEY_LIGHT[2] / ATELIER_KEY_LIGHT[1];
      centerU = geometry.stageX;
      centerV = geometry.stageZ;
      const reach = heightRange * Math.hypot(lightU, lightV);
      half = Math.max(geometry.extentX, geometry.extentZ) * 1.25 + reach * 0.6 + 0.35;
    }
    const scale = size / (2 * half);
    const originU = centerU - half;
    const originV = centerV - half;
    // At most ~2M splats: stride larger data.
    const stride = Math.max(1, Math.floor(count / 2_000_000));
    const chunk = 40_000;
    let visible = 0;
    job.stage = 'shadow-splat';
    for (let begin = 0; begin < count; begin += chunk * stride) {
      const end = Math.min(count, begin + chunk * stride);
      for (let i = begin; i < end; i += stride) {
        // Point transparency is exactly 0 (filtered out) or 1 (shown).
        const weight = visibility === null || visibility[i] !== 0 ? 1 : 0;
        if (weight <= 0) continue;
        const base = i * dimension;
        const x = positions[base];
        const y = dimension > 1 ? positions[base + 1] : 0;
        const z = dimension > 2 ? positions[base + 2] : 0;
        let u;
        let v;
        let h;
        let groundU;
        let groundV;
        if (planar) {
          h = z - paperZ;
          groundU = x;
          groundV = y;
        } else {
          h = y - geometry.floorY;
          groundU = x;
          groundV = z;
        }
        u = groundU + lightU * h;
        v = groundV + lightV * h;
        visible += weight;
        const lift = Math.min(1, Math.max(0, h / heightRange));
        // Cast shadow, split by height so high cells cast softer shadows.
        let fu = (u - originU) * scale - 0.5;
        let fv = (v - originV) * scale - 0.5;
        let iu = Math.floor(fu);
        let iv = Math.floor(fv);
        if (iu >= 0 && iv >= 0 && iu < size - 1 && iv < size - 1) {
          const tu = fu - iu;
          const tv = fv - iv;
          const index = iv * size + iu;
          const wSharp = weight * (1 - lift);
          const wSoft = weight * lift;
          const w00 = (1 - tu) * (1 - tv);
          const w10 = tu * (1 - tv);
          const w01 = (1 - tu) * tv;
          const w11 = tu * tv;
          sharp[index] += wSharp * w00; sharp[index + 1] += wSharp * w10;
          sharp[index + size] += wSharp * w01; sharp[index + size + 1] += wSharp * w11;
          soft[index] += wSoft * w00; soft[index + 1] += wSoft * w10;
          soft[index + size] += wSoft * w01; soft[index + size + 1] += wSoft * w11;
        }
        // Ambient occlusion: straight down, strongest for cells near the floor.
        fu = (groundU - originU) * scale;
        fv = (groundV - originV) * scale;
        iu = fu | 0;
        iv = fv | 0;
        if (iu >= 0 && iv >= 0 && iu < size && iv < size) {
          ao[iv * size + iu] += weight * Math.exp(-lift * 2.2);
        }
      }
      yield;
      if (job.cancelled) return;
    }
    // Blur: a near-Gaussian from three box passes per channel.
    const texelsPerUnit = scale;
    const sharpRadius = Math.max(1, Math.round(texelsPerUnit * 0.035));
    const softRadius = Math.max(2, Math.round(texelsPerUnit * 0.11));
    const aoRadius = Math.max(3, Math.round(texelsPerUnit * 0.16));
    job.stage = 'shadow-blur';
    yield* boxBlur(sharp, size, sharpRadius, 3, scratch);
    if (job.cancelled) return;
    yield* boxBlur(soft, size, softRadius, 3, scratch);
    if (job.cancelled) return;
    yield* boxBlur(ao, size, aoRadius, 3, scratch);
    if (job.cancelled) return;
    // Normalise each channel to a high percentile of its own density, so the
    // shadow's darkness does not depend on the cell count.
    // The 97th percentile of a field's positive values, from a histogram:
    // linear time, no sort.
    const percentile = (field) => {
      let max = 0;
      for (let i = 0; i < field.length; i++) if (field[i] > max) max = field[i];
      if (!(max > 0)) return 1;
      const bins = new Uint32Array(1024);
      let positive = 0;
      for (let i = 0; i < field.length; i++) {
        const value = field[i];
        if (value > 0) {
          bins[Math.min(1023, Math.floor((value / max) * 1024))] += 1;
          positive += 1;
        }
      }
      let target = positive * 0.97;
      for (let bin = 0; bin < 1024; bin++) {
        target -= bins[bin];
        if (target <= 0) return ((bin + 1) / 1024) * max;
      }
      return max;
    };
    for (let i = 0; i < sharp.length; i++) sharp[i] += soft[i] * 0.8;
    job.stage = 'shadow-normalise';
    const shadowRef = percentile(sharp);
    yield;
    const aoRef = percentile(ao);
    yield;
    // Half-float packing, a band of rows per unit: one slice never holds it.
    const packed = new Uint16Array(size * size * 2);
    const rowsPerUnit = 64;
    job.stage = 'shadow-pack';
    for (let row = 0; row < size; row += rowsPerUnit) {
      const end = Math.min(size, row + rowsPerUnit) * size;
      for (let i = row * size; i < end; i++) {
        packed[i * 2] = halfFromFloat(1 - Math.exp(-1.4 * sharp[i] / shadowRef));
        packed[i * 2 + 1] = halfFromFloat(1 - Math.exp(-1.2 * ao[i] / aoRef));
      }
      yield;
      if (job.cancelled) return;
    }
    if (job.cancelled) return;
    job.stage = 'shadow-upload';
    // Into the pane's spare map, in bands of rows (no single upload waits on
    // a busy transfer buffer for long); the spare becomes the drawn map only
    // once complete, so a frame never shows half an old and half a new map.
    let target = pane.shadowSpare;
    if (target === null) {
      const saved = saveState();
      target = createTexture(gl.TEXTURE_2D, UNIT_SHADOW);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG16F, size, size);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      restoreState(saved);
      textureBytes += size * size * 4;
      pane.shadowSpare = target;
      yield;
    }
    for (let row = 0; row < size; row += rowsPerUnit) {
      if (job.cancelled) return;
      const rows = Math.min(rowsPerUnit, size - row);
      const saved = saveState();
      gl.activeTexture(gl.TEXTURE0 + UNIT_SHADOW);
      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, row, size, rows, gl.RG, gl.HALF_FLOAT,
        packed.subarray(row * size * 2, (row + rows) * size * 2)
      );
      restoreState(saved);
      yield;
    }
    if (job.cancelled) return;
    pane.shadowSpare = pane.shadowTexture;
    pane.shadowTexture = target;
    pane.shadowWindow = [centerU, centerV, half];
    pane.shadowPacked = packed;
    pane.shadowKey = key;
    notifyReady();
    pane.shadowJob = null;
    pane.shadowStats = {
      points: count,
      visible: Math.round(visible),
      stride,
      wallMs: now() - started,
      cpuMs: job.cpuMs,
    };
    version += 1;
    invalidate();
  }

  /**
   * Bring a pane's derived bakes up to date with its data. Called from
   * draw(); only compares keys and, on a change, queues idle work.
   */
  function syncPane(viewId, look, geometry, planar) {
    const pane = paneState(viewId);
    const source = readViewSource(viewId);
    const generation = source === null ? 0 : source.generation;
    if ((generation !== pane.generation || pane.tintLook !== look.id) && pane.tintJob === null) {
      pane.generation = generation;
      pane.tintJob = enqueue(`tints ${viewId}`, (job) => computeTints(viewId, source, look, job));
    }
    if (look.family === 'atelier' && look.program === 'atelier' && source !== null && source.positions.length > 0) {
      // A representation switch publishes a new positions array.
      if (pane.positionsRef !== source.positions) {
        pane.positionsRef = source.positions;
        pane.positionsEpoch = (pane.positionsEpoch ?? 0) + 1;
      }
      const base = [
        pane.positionsEpoch,
        source.positions.length,
        source.dimension,
        planar ? 1 : 0,
        geometry.floorY.toFixed(5),
        geometry.stageX.toFixed(5),
        geometry.stageZ.toFixed(5),
      ].join('|');
      // The draw path only compares this key. A change queues an idle check
      // that hashes the visibility: a filter moves the shadow, a recolour
      // (which bumps the same generation) does not.
      const checkKey = `${base}|${generation}`;
      if (checkKey !== pane.checkedKey) {
        pane.checkedKey = checkKey;
        cancelJob(pane.shadowJob);
        const geometryCopy = { ...geometry };
        pane.shadowJob = enqueue(`shadow ${viewId}`, function* (job) {
          job.stage = 'shadow-signature';
          const fullKey = `${base}|${visibilitySignature(source.visibility)}`;
          yield;
          if (job.cancelled) return;
          if (fullKey === pane.shadowKey) {
            pane.shadowJob = null;
            return;
          }
          yield* bakeShadow(viewId, source, geometryCopy, planar, fullKey, job);
        });
      }
    }
    return pane;
  }

  // -------------------------------------------------------------------------
  // Ambient motion
  // -------------------------------------------------------------------------
  function ambientWanted() {
    return ambientEnabled
      && activeId !== null
      && !prefersReducedMotion()
      && (typeof document === 'undefined' || document.visibilityState !== 'hidden')
      && (activeId === 'nebula' || activeId === 'aurora-dark' || activeId.startsWith('abyss'));
  }

  function tickAmbient() {
    ambientTimer = null;
    if (!ambientWanted()) return;
    const wall = now();
    ambientClock += Math.min(0.1, (wall - ambientLastWall) / 1000);
    ambientLastWall = wall;
    version += 1;
    invalidate();
    ambientTimer = setTimeout(tickAmbient, 1000 / BACKDROP_AMBIENT_MAX_HZ);
  }

  function syncAmbient() {
    if (ambientWanted()) {
      if (ambientTimer === null) {
        ambientLastWall = now();
        ambientTimer = setTimeout(tickAmbient, 1000 / BACKDROP_AMBIENT_MAX_HZ);
      }
    } else if (ambientTimer !== null) {
      clearTimeout(ambientTimer);
      ambientTimer = null;
    }
  }

  const onVisibility = () => syncAmbient();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  // A change of the system's reduced-motion setting takes effect at once:
  // ambient motion stops (or may resume) without waiting for another event.
  const reducedMotionQuery = typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)')
    : null;
  const onReducedMotion = () => {
    syncAmbient();
    if (prefersReducedMotion() && opacity < 1 && isLookReady()) {
      opacity = 1;
      version += 1;
      invalidate();
    }
  };
  reducedMotionQuery?.addEventListener?.('change', onReducedMotion);

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------
  function setLook(id) {
    const next = id === null ? null : id;
    if (next !== null && !isBackdropLook(next)) throw new TypeError(`Unknown backdrop look "${id}".`);
    if (next === activeId) return;
    const previousFamily = activeId === null ? null : BACKDROP_LOOKS[activeId].program;
    activeId = next;
    version += 1;
    if (next !== null) {
      const family = BACKDROP_LOOKS[next].program;
      evictFamiliesExcept(family);
      const state = ensureFamily(family);
      // A look whose bake is already resident appears at once when only
      // the tone changes inside its family; otherwise it fades in.
      opacity = state.ready && previousFamily === family ? 1 : 0;
    } else {
      // No look on screen: nothing stays resident or keeps baking.
      evictFamiliesExcept(null);
      opacity = 0;
    }
    syncAmbient();
  }

  function isLookReady() {
    if (activeId === null) return false;
    const state = families.get(BACKDROP_LOOKS[activeId].program);
    return state !== undefined && state.ready;
  }

  /** Advance the fade-in by `dt` seconds (at once under reduced motion). */
  function advance(dt) {
    if (activeId === null) return;
    if (isLookReady() && opacity < 1) {
      opacity = prefersReducedMotion() ? 1 : Math.min(1, opacity + dt / BACKDROP_LOOK_FADE_SECONDS);
      version += 1;
    }
  }

  /** The time-driven change still owed to the next frame, or null. */
  function frameCause() {
    if (activeId === null) return null;
    if (isLookReady() && opacity < 1) return 'backdrop-fade';
    return null;
  }

  function setUniform3(program, name, value) {
    const location = program.uniforms.get(name);
    if (location !== undefined) gl.uniform3f(location, value[0], value[1], value[2]);
  }
  function setUniform1(program, name, value) {
    const location = program.uniforms.get(name);
    if (location !== undefined) gl.uniform1f(location, value);
  }
  function setUniform4(program, name, value) {
    const location = program.uniforms.get(name);
    if (location !== undefined) gl.uniform4f(location, value[0], value[1], value[2], value[3]);
  }

  // Figure export draws with the screen's own shadow map, uploaded once.
  let frozenShadowTexture = null;
  let frozenShadowPacked = null;
  function frozenShadow(shadow) {
    if (shadow === null) return { texture: null, window: [0, 0, 1], ready: false };
    if (frozenShadowPacked !== shadow.packed) {
      if (frozenShadowTexture === null) {
        frozenShadowTexture = createTexture(gl.TEXTURE_2D, UNIT_SHADOW);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      } else {
        gl.activeTexture(gl.TEXTURE0 + UNIT_SHADOW);
        gl.bindTexture(gl.TEXTURE_2D, frozenShadowTexture);
      }
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, shadow.size, shadow.size, 0, gl.RG, gl.HALF_FLOAT, shadow.packed);
      frozenShadowPacked = shadow.packed;
    }
    return { texture: frozenShadowTexture, window: shadow.window, ready: true };
  }

  const _tintScratch = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

  /**
   * Draw the active look into the bound target for one pane.
   *
   * @param {object} p
   * @param {string} p.viewId
   * @param {Float32Array} p.invMvp
   * @param {Float32Array} p.mvp
   * @param {Float32Array} p.projection
   * @param {Float32Array} p.eye
   * @param {number} p.pixelRatio
   * @param {number} p.glowCenterX
   * @param {number} p.viewportWidth
   * @param {number} p.viewportHeight
   * @param {0|1} p.planar
   * @param {object} p.geometry - resolveStudioPaneGeometry() record
   * @param {number[]} [p.ndcTransform] - pane NDC = target NDC * xy + zw
   *   (figure export); the identity on screen
   * @param {object} [p.frozen] - figure export: the screen's exact state for
   *   this pane (`getExportState`) instead of this renderer's own
   * @returns {boolean} whether anything was drawn
   */
  function draw(p) {
    if (disposed || activeId === null) return false;
    const look = BACKDROP_LOOKS[activeId];
    const familyKey = look.program;
    const family = families.get(familyKey);
    const spec = FAMILY_PROGRAMS[familyKey];
    const frozen = p.frozen ?? null;
    const pane = frozen === null ? syncPane(p.viewId, look, p.geometry, p.planar === 1) : null;
    const drawOpacity = frozen === null ? opacity : 1;
    if (!family || !family.ready || drawOpacity <= 0) return false;
    const program = programs.get(spec.draw);
    if (!program || !program.ready) return false;
    const ndc = p.ndcTransform ?? IDENTITY_NDC;
    const clock = frozen === null ? ambientClock : frozen.time;

    const tints = frozen !== null
      ? frozen.tints
      : (currentTints(pane, look) ?? lookTintsLinear(look));
    for (let i = 0; i < 3; i++) {
      _tintScratch[i][0] = tints[i][0];
      _tintScratch[i][1] = tints[i][1];
      _tintScratch[i][2] = tints[i][2];
    }

    const blend = gl.isEnabled(gl.BLEND);
    const depth = gl.isEnabled(gl.DEPTH_TEST);
    const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
    const g = p.geometry;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(program.program);
    gl.uniformMatrix4fv(program.uniforms.get('u_invMvp'), false, p.invMvp);
    gl.uniform3f(program.uniforms.get('u_eye'), p.eye[0], p.eye[1], p.eye[2]);
    setUniform1(program, 'u_pixelRatio', p.pixelRatio);
    const viewportLocation = program.uniforms.get('u_viewport');
    if (viewportLocation !== undefined) gl.uniform2f(viewportLocation, p.viewportWidth, p.viewportHeight);
    setUniform1(program, 'u_glowCenterX', p.glowCenterX);
    setUniform1(program, 'u_opacity', drawOpacity);
    setUniform4(program, 'u_ndcTransform', ndc);
    const surface = look.surface;
    setUniform3(program, 'u_surface', [surface[0] / 255, surface[1] / 255, surface[2] / 255]);
    setUniform1(program, 'u_planar', p.planar);
    setUniform3(program, 'u_stageCenter', [g.stageX, g.centerY, g.stageZ]);
    setUniform3(program, 'u_stageExtent', [g.extentX, g.extentY, g.extentZ]);
    setUniform1(program, 'u_floorY', g.floorY);
    setUniform1(program, 'u_time', clock);
    setUniform1(program, 'u_ambient', frozen === null ? (ambientTimer !== null ? 1 : 0) : frozen.ambient);
    setUniform1(program, 'u_dark', look.tone === 'dark' ? 1 : 0);
    setUniform3(program, 'u_tint0', _tintScratch[0]);
    setUniform3(program, 'u_tint1', _tintScratch[1]);
    setUniform3(program, 'u_tint2', _tintScratch[2]);
    if (family.cube) {
      gl.activeTexture(gl.TEXTURE0 + UNIT_SKY);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, family.cube);
      const location = program.uniforms.get('u_sky');
      if (location !== undefined) gl.uniform1i(location, UNIT_SKY);
    }
    if (family.tile) {
      gl.activeTexture(gl.TEXTURE0 + UNIT_TILE);
      gl.bindTexture(gl.TEXTURE_2D, family.tile);
      const location = program.uniforms.get('u_tile');
      if (location !== undefined) gl.uniform1i(location, UNIT_TILE);
    }
    if (familyKey === 'atelier') {
      const shadow = frozen === null
        ? { texture: pane.shadowTexture, window: pane.shadowWindow, ready: pane.shadowTexture !== null && pane.shadowKey !== null }
        : frozenShadow(frozen.shadow);
      gl.activeTexture(gl.TEXTURE0 + UNIT_SHADOW);
      gl.bindTexture(gl.TEXTURE_2D, shadow.texture);
      const location = program.uniforms.get('u_shadow');
      if (location !== undefined) gl.uniform1i(location, UNIT_SHADOW);
      setUniform3(program, 'u_shadowWindow', shadow.window);
      setUniform1(program, 'u_shadowReady', shadow.ready ? 1 : 0);
      setUniform3(program, 'u_keyLight', ATELIER_KEY_LIGHT);
      setUniform1(program, 'u_paperGap', ATELIER_PAPER_GAP);
    }
    gl.bindVertexArray(triangleVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    let savedBlendFunc = null;
    if (spec.motes && moteVao !== null) {
      const motes = programs.get('draw:motes');
      if (motes && motes.ready) {
        savedBlendFunc = [
          gl.getParameter(gl.BLEND_SRC_RGB), gl.getParameter(gl.BLEND_DST_RGB),
          gl.getParameter(gl.BLEND_SRC_ALPHA), gl.getParameter(gl.BLEND_DST_ALPHA),
        ];
        gl.useProgram(motes.program);
        gl.enable(gl.BLEND);
        if (look.tone === 'dark') gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
        else gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
        gl.uniformMatrix4fv(motes.uniforms.get('u_mvp'), false, p.mvp);
        setUniform3(motes, 'u_eye', p.eye);
        setUniform3(motes, 'u_stageCenter', [g.stageX, g.centerY, g.stageZ]);
        setUniform3(motes, 'u_stageExtent', [g.extentX, g.extentY, g.extentZ]);
        setUniform1(motes, 'u_projScale', p.projection[5]);
        setUniform1(motes, 'u_viewportHeight', p.viewportHeight);
        setUniform1(motes, 'u_pixelRatio', p.pixelRatio);
        setUniform1(motes, 'u_time', clock);
        setUniform4(motes, 'u_ndcTransform', ndc);
        setUniform1(motes, 'u_planar', p.planar);
        setUniform1(motes, 'u_dark', look.tone === 'dark' ? 1 : 0);
        setUniform1(motes, 'u_opacity', drawOpacity);
        setUniform1(motes, 'u_maxPointSize', maxPointSize);
        setUniform3(motes, 'u_tint0', _tintScratch[0]);
        setUniform3(motes, 'u_tint1', _tintScratch[1]);
        gl.bindVertexArray(moteVao);
        gl.drawArrays(gl.POINTS, 0, MOTE_COUNT);
      }
    }

    gl.bindVertexArray(null);
    gl.depthMask(true);
    (blend ? gl.enable : gl.disable).call(gl, gl.BLEND);
    if (savedBlendFunc !== null) gl.blendFuncSeparate(...savedBlendFunc);
    (depth ? gl.enable : gl.disable).call(gl, gl.DEPTH_TEST);
    gl.activeTexture(activeTexture);
    return true;
  }

  function forgetView(viewId) {
    const pane = panes.get(viewId);
    if (!pane) return;
    cancelJob(pane.tintJob);
    cancelJob(pane.shadowJob);
    for (const texture of [pane.shadowTexture, pane.shadowSpare]) {
      if (texture === null) continue;
      deleteTextureTracked(gl, texture);
      textureBytes -= SHADOW_MAP_SIZE * SHADOW_MAP_SIZE * 4;
    }
    panes.delete(viewId);
    exportStateCache.delete(viewId);
  }

  function teardown(deleteObjects) {
    if (disposed) return;
    disposed = true;
    cancelSlice();
    jobs.length = 0;
    if (ambientTimer !== null) clearTimeout(ambientTimer);
    ambientTimer = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    reducedMotionQuery?.removeEventListener?.('change', onReducedMotion);
    for (const waiter of readyWaiters) waiter.reject(new Error('Backdrop look renderer disposed.'));
    readyWaiters.clear();
    if (!deleteObjects) return;
    for (const record of programs.values()) {
      deleteProgramReleasingUse(gl, record.program);
      gl.deleteShader(record.vs);
      gl.deleteShader(record.fs);
    }
    for (const state of families.values()) {
      if (state.cube) deleteTextureTracked(gl, state.cube);
      if (state.candidateCube) deleteTextureTracked(gl, state.candidateCube);
      if (state.tile) deleteTextureTracked(gl, state.tile);
      if (state.framebuffer) gl.deleteFramebuffer(state.framebuffer);
    }
    for (const pane of panes.values()) {
      if (pane.shadowTexture) deleteTextureTracked(gl, pane.shadowTexture);
      if (pane.shadowSpare) deleteTextureTracked(gl, pane.shadowSpare);
    }
    if (frozenShadowTexture) deleteTextureTracked(gl, frozenShadowTexture);
    gl.deleteVertexArray(triangleVao);
    gl.deleteBuffer(triangleBuffer);
    if (moteVao) gl.deleteVertexArray(moteVao);
    if (moteBuffer) gl.deleteBuffer(moteBuffer);
  }

  function getDiagnostics() {
    const familyStats = {};
    for (const [key, state] of families) {
      familyStats[key] = { ready: state.ready, ...(state.stats ?? {}) };
    }
    const paneStats = {};
    for (const [viewId, pane] of panes) paneStats[viewId] = pane.shadowStats;
    return {
      activeId,
      opacity,
      version,
      textureBytes,
      jobsQueued: jobs.length,
      jobHistory: jobHistory.slice(),
      slices: { ...sliceStats },
      families: familyStats,
      shadows: paneStats,
      ambient: ambientTimer !== null,
      parallelCompile: parallelCompile !== null,
      programs: [...programs.values()].map((r) => ({
        key: r.key,
        ready: r.ready,
        failed: r.failed,
        compileMs: r.readyAt ? r.readyAt - r.startedAt : null,
      })),
    };
  }

  /**
   * Everything figure export needs to draw this pane's look exactly as the
   * screen shows it, frozen: the look, its data tints, the ambient clock and
   * (Atelier) the baked contact-shadow map. Null without an active look.
   */
  function getExportState(viewId) {
    if (activeId === null) return null;
    const look = BACKDROP_LOOKS[activeId];
    const pane = panes.get(viewId) ?? null;
    const tints = (pane && currentTints(pane, look)) ?? null;
    const packed = look.program === 'atelier' ? (pane?.shadowPacked ?? null) : null;
    const ambient = ambientTimer !== null ? 1 : 0;
    // Cached, so a caller that asks every frame allocates nothing.
    const cache = exportStateCache.get(viewId);
    if (
      cache !== undefined
      && cache.id === activeId
      && cache.tintsRef === tints
      && cache.packed === packed
      && cache.state.time === ambientClock
      && cache.state.ambient === ambient
    ) {
      return cache.state;
    }
    const resolvedTints = tints ?? lookTintsLinear(look);
    const state = Object.freeze({
      id: activeId,
      tints: Object.freeze(resolvedTints.map((t) => Object.freeze([t[0], t[1], t[2]]))),
      time: ambientClock,
      ambient,
      shadow: packed === null
        ? null
        : Object.freeze({ packed, window: Object.freeze([...pane.shadowWindow]), size: SHADOW_MAP_SIZE }),
    });
    exportStateCache.set(viewId, { id: activeId, tintsRef: tints, packed, state });
    return state;
  }
  const exportStateCache = new Map();

  /** Resolves once the active look's bake has landed (figure export). */
  function whenReady() {
    const check = () => isLookReady();
    if (check()) return Promise.resolve();
    return new Promise((resolve, reject) => readyWaiters.add({ check, resolve, reject }));
  }

  return {
    setLook,
    advance,
    getExportState,
    whenReady,
    frameCause,
    draw,
    forgetView,
    dispose: () => teardown(true),
    abandon: () => teardown(false),
    isActive: () => activeId !== null,
    getVersion: () => version,
    setAmbientMotion(enabled) {
      ambientEnabled = enabled === true;
      syncAmbient();
    },
    getDiagnostics,
  };
}

