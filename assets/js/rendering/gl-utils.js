import { formatCountOf } from '../utils/format-units.js';
// WebGL helpers for shader/program creation and data normalization.
function asError(value, defaultMessage) {
  return value instanceof Error ? value : new Error(defaultMessage);
}

function attemptCleanup(failures, cleanup, defaultMessage) {
  try {
    cleanup();
  } catch (error) {
    failures.push(asError(error, defaultMessage));
  }
}

function throwTransactionFailure(failures, message) {
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
}

export function createShader(gl, type, source) {
  let shader = null;
  try {
    shader = gl.createShader(type);
    if (!shader) {
      throw new Error('Required WebGL shader allocation failed.');
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      throw new Error('Could not compile shader:\n' + info);
    }
    return shader;
  } catch (error) {
    const failures = [
      asError(error, 'WebGL shader creation failed with a non-Error value.')
    ];
    if (shader) {
      attemptCleanup(
        failures,
        () => gl.deleteShader(shader),
        'WebGL shader rollback failed with a non-Error value.'
      );
    }
    throwTransactionFailure(
      failures,
      'WebGL shader creation and rollback failed.'
    );
  }
}

function createLinkedProgram(
  gl,
  vsSource,
  fsSource,
  configureProgram,
  linkFailurePrefix
) {
  let vs = null;
  let fs = null;
  let program = null;
  try {
    vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
    fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
    program = gl.createProgram();
    if (!program) {
      throw new Error('Could not allocate the required WebGL program.');
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    configureProgram(program);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      throw new Error(`${linkFailurePrefix}:\n${info}`);
    }

    const cleanupFailures = [];
    const ownedVs = vs;
    vs = null;
    attemptCleanup(
      cleanupFailures,
      () => gl.deleteShader(ownedVs),
      'WebGL vertex-shader cleanup failed with a non-Error value.'
    );
    const ownedFs = fs;
    fs = null;
    attemptCleanup(
      cleanupFailures,
      () => gl.deleteShader(ownedFs),
      'WebGL fragment-shader cleanup failed with a non-Error value.'
    );
    if (cleanupFailures.length > 0) {
      const ownedProgram = program;
      program = null;
      attemptCleanup(
        cleanupFailures,
        () => gl.deleteProgram(ownedProgram),
        'WebGL program rollback failed with a non-Error value.'
      );
      throwTransactionFailure(
        cleanupFailures,
        'WebGL program linked but shader cleanup failed.'
      );
    }
    const result = program;
    program = null;
    return result;
  } catch (error) {
    const failures = [
      asError(error, 'WebGL program creation failed with a non-Error value.')
    ];
    if (program) {
      attemptCleanup(
        failures,
        () => gl.deleteProgram(program),
        'WebGL program rollback failed with a non-Error value.'
      );
    }
    if (fs) {
      attemptCleanup(
        failures,
        () => gl.deleteShader(fs),
        'WebGL fragment-shader rollback failed with a non-Error value.'
      );
    }
    if (vs) {
      attemptCleanup(
        failures,
        () => gl.deleteShader(vs),
        'WebGL vertex-shader rollback failed with a non-Error value.'
      );
    }
    throwTransactionFailure(
      failures,
      'WebGL program creation and rollback failed.'
    );
  }
}

/**
 * Delete a program without leaving it current.
 *
 * WebGL keeps a deleted program current until another one is used, and
 * `getParameter(CURRENT_PROGRAM)` keeps returning it. Every owner that saves
 * the current program and restores it afterwards (a transform-feedback
 * permute, a noise batch, a density build) would then pass a deleted object
 * to `useProgram`, which raises INVALID_OPERATION (0x502); nothing reads it
 * there, so the next owner to read the error queue -- a dataset load's
 * renderer -- fails with it as its own. `CURRENT_PROGRAM` is answered by the
 * page (no GPU round trip).
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram|null} program
 */
export function deleteProgramReleasingUse(gl, program) {
  if (program === null) return;
  if (gl.getParameter(gl.CURRENT_PROGRAM) === program) gl.useProgram(null);
  gl.deleteProgram(program);
}

/**
 * Textures deleted through `deleteTextureTracked`. Chrome's page-side record
 * of each unit's bindings can outlive a deletion: a texture bound to
 * TEXTURE_3D or TEXTURE_2D_ARRAY on a unit is not cleared from that unit when
 * the unit is beyond the last one it counts as holding a 2D or cube-map
 * texture, so `getParameter(TEXTURE_BINDING_3D)` keeps returning the deleted
 * texture (measured: bind a 3D texture on unit 4, bind null to TEXTURE_2D on
 * unit 4, delete it -- unit 4 still reports it). An owner that saved that
 * binding and restores it passes a deleted object to `bindTexture`:
 * INVALID_OPERATION (0x502), read by whichever owner reads the error queue
 * next (a dataset switch's renderer load).
 */
const DELETED_TEXTURES = new WeakSet();

/**
 * Delete a texture and remember it, so no saved binding of it is restored
 * (`restorableTexture`). Every texture the renderers own is deleted here.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture|null} texture
 */
export function deleteTextureTracked(gl, texture) {
  if (texture === null || texture === undefined) return;
  gl.deleteTexture(texture);
  DELETED_TEXTURES.add(texture);
}

/**
 * A saved texture binding, safe to restore: null when the texture has been
 * deleted since it was saved (or was already deleted and still reported).
 *
 * @param {WebGLTexture|null} texture
 * @returns {WebGLTexture|null}
 */
export function restorableTexture(texture) {
  return texture !== null && DELETED_TEXTURES.has(texture) ? null : texture;
}

/**
 * Delete one GL object by its deletion method's name, through the owners
 * above for programs and textures.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {string} deleteMethod - e.g. 'deleteBuffer'
 * @param {object} object
 */
/**
 * Whether a WebGL object (or a segmented point store or vertex array, which
 * stand where one buffer or VAO stood) still holds GPU objects: asked after
 * a deletion threw, to know whether it must be retried.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {string} livenessMethod - `isBuffer`, `isTexture`, `isVertexArray`, ...
 * @param {object} object
 * @returns {boolean}
 */
export function isGlObjectAlive(gl, livenessMethod, object) {
  if (typeof object?.delete === 'function' && object.gl === gl) return object.deleted !== true;
  return typeof gl[livenessMethod] === 'function' ? gl[livenessMethod](object) : true;
}

export function deleteGlObject(gl, deleteMethod, object) {
  // A segmented point store or its vertex arrays
  // (`high-perf/point-store-segments.js`) stand where one buffer or VAO
  // stood, and delete every object they hold.
  if (typeof object?.delete === 'function' && object.gl === gl) object.delete();
  else if (deleteMethod === 'deleteProgram') deleteProgramReleasingUse(gl, object);
  else if (deleteMethod === 'deleteTexture') deleteTextureTracked(gl, object);
  else gl[deleteMethod](object);
}

export function createProgram(gl, vsSource, fsSource) {
  return createLinkedProgram(
    gl,
    vsSource,
    fsSource,
    () => {},
    'Could not link program'
  );
}

/**
 * Create a WebGL2 program configured for transform feedback.
 *
 * WebGL2 requires `transformFeedbackVaryings()` to be set before linking the
 * program. This helper keeps the boilerplate centralized so transform-feedback
 * users (GPU particle systems, etc.) stay DRY.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {string} vsSource
 * @param {string} fsSource
 * @param {string[]} varyings - Vertex shader outputs to capture
 * @param {number} [bufferMode] - gl.INTERLEAVED_ATTRIBS or gl.SEPARATE_ATTRIBS
 * @returns {WebGLProgram}
 */
export function createTransformFeedbackProgram(
  gl,
  vsSource,
  fsSource,
  varyings,
  bufferMode = undefined
) {
  const mode = bufferMode ?? gl.INTERLEAVED_ATTRIBS;
  return createLinkedProgram(
    gl,
    vsSource,
    fsSource,
    program => gl.transformFeedbackVaryings(program, varyings, mode),
    'Could not link transform feedback program'
  );
}

/**
 * Create several programs in one batch: each distinct shader source is
 * compiled once and shared, every program is linked before any status is
 * read, and status is read once per program at the end. A driver overlaps
 * the compiles and links of a batch; reading status after each step makes it
 * finish them one after another. On any failure every program and shader of
 * the batch is deleted and the error names the program and its diagnostic.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {Array<{label: string, vs: string, fs: string, varyings?: string[], bufferMode?: number}>} specs
 * @returns {WebGLProgram[]} One program per spec, in order.
 */
export function createProgramBatch(gl, specs) {
  const shaders = new Map();
  const programs = [];
  const shaderOf = (type, source) => {
    const key = `${type}:${source}`;
    let shader = shaders.get(key);
    if (shader !== undefined) return shader;
    shader = gl.createShader(type);
    if (!shader) throw new Error('Required WebGL shader allocation failed.');
    shaders.set(key, shader);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const diagnose = (spec, program) => {
    for (const [type, source, kind] of [[gl.VERTEX_SHADER, spec.vs, 'vertex'], [gl.FRAGMENT_SHADER, spec.fs, 'fragment']]) {
      const shader = shaders.get(`${type}:${source}`);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        return `Could not compile the ${spec.label} ${kind} shader:\n${gl.getShaderInfoLog(shader)}`;
      }
    }
    return `Could not link the ${spec.label} program:\n${gl.getProgramInfoLog(program)}`;
  };
  try {
    for (const spec of specs) {
      const vs = shaderOf(gl.VERTEX_SHADER, spec.vs);
      const fs = shaderOf(gl.FRAGMENT_SHADER, spec.fs);
      const program = gl.createProgram();
      if (!program) throw new Error('Could not allocate the required WebGL program.');
      programs.push(program);
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      if (spec.varyings) {
        gl.transformFeedbackVaryings(program, spec.varyings, spec.bufferMode ?? gl.INTERLEAVED_ATTRIBS);
      }
      gl.linkProgram(program);
    }
    specs.forEach((spec, index) => {
      if (!gl.getProgramParameter(programs[index], gl.LINK_STATUS)) {
        throw new Error(diagnose(spec, programs[index]));
      }
    });
  } catch (error) {
    const failures = [asError(error, 'WebGL program batch failed with a non-Error value.')];
    for (const program of programs) {
      attemptCleanup(failures, () => gl.deleteProgram(program), 'WebGL program rollback failed with a non-Error value.');
    }
    for (const shader of shaders.values()) {
      attemptCleanup(failures, () => gl.deleteShader(shader), 'WebGL shader rollback failed with a non-Error value.');
    }
    throwTransactionFailure(failures, 'WebGL program batch creation and rollback failed.');
  }
  const cleanupFailures = [];
  for (const shader of shaders.values()) {
    attemptCleanup(cleanupFailures, () => gl.deleteShader(shader), 'WebGL shader cleanup failed with a non-Error value.');
  }
  if (cleanupFailures.length > 0) {
    for (const program of programs) {
      attemptCleanup(cleanupFailures, () => gl.deleteProgram(program), 'WebGL program rollback failed with a non-Error value.');
    }
    throwTransactionFailure(cleanupFailures, 'WebGL programs linked but shader cleanup failed.');
  }
  return programs;
}

/**
 * Publish the straight-alpha blend contract shared by Cellucid's translucent
 * point, grid, highlight, connectivity, and centroid passes.
 *
 * Render passes call this at their draw boundary instead of relying on
 * long-lived ambient WebGL state. The explicit calls are intentionally cheaper
 * than querying and conditionally restoring driver state in every pane.
 *
 * @param {WebGL2RenderingContext} gl
 */
export function configureStraightAlphaBlending(gl) {
  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  // RGB is straight-alpha compositing. Alpha itself must use the unscaled
  // source coverage; using blendFunc() would multiply source alpha by itself,
  // corrupting transparent exports and the browser compositing surface.
  gl.blendFuncSeparate(
    gl.SRC_ALPHA,
    gl.ONE_MINUS_SRC_ALPHA,
    gl.ONE,
    gl.ONE_MINUS_SRC_ALPHA
  );
}

/**
 * Most vertices one point draw submits.
 *
 * Firefox refuses any draw over 30,000,000 vertex ids
 * (`webgl.max-vert-ids-per-draw`) with `INVALID_OPERATION` and draws nothing;
 * 30,000,000 is accepted, 30,000,001 is not (probed on all three engines,
 * scale plan section 3.1). Chromium and WebKit drew 200M points in one call.
 * Every draw whose vertex count grows with the data therefore goes through
 * `drawPointsInSegments`, on every engine, so one code path draws every size.
 *
 * Splitting is invisible: draws execute in submission order, so consecutive
 * ranges rasterize the same points in the same order (blending, depth and
 * transform-feedback output are those of the single draw), and `gl_VertexID`
 * keeps counting from the range's `first`. 2^24 keeps every segment far below
 * the Firefox limit and costs at most 6 extra calls at 100M points.
 */
export const MAX_VERTICES_PER_DRAW = 16_777_216;

/**
 * Draw `count` points from `first` as consecutive `drawArrays(POINTS)` calls
 * of at most `MAX_VERTICES_PER_DRAW` vertices.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {number} first
 * @param {number} count
 * @returns {number} The number of draw calls issued.
 */
export function drawPointsInSegments(gl, first, count) {
  let calls = 0;
  for (let offset = 0; offset < count; offset += MAX_VERTICES_PER_DRAW) {
    gl.drawArrays(gl.POINTS, first + offset, Math.min(MAX_VERTICES_PER_DRAW, count - offset));
    calls++;
  }
  return calls;
}

/**
 * Release vertex attribute `location` of the bound vertex array from the
 * buffer it reads: point it at `holder` and disable it. Leaves no
 * `ARRAY_BUFFER` bound.
 *
 * An attribute is never pointed at no buffer. Chromium's command-buffer
 * client does not send `vertexAttribPointer` / `vertexAttribIPointer` to the
 * GPU process while no `ARRAY_BUFFER` is bound (it keeps the pointer as a
 * client-side array), so on Chromium that call leaves the vertex array
 * holding the buffer it read, while `getVertexAttrib` says it holds none.
 * The buffer then stays alive after `deleteBuffer`, and while that vertex
 * array is bound a transform-feedback pass writing the buffer fails with
 * INVALID_OPERATION ("A transform feedback buffer that would be written to
 * is also bound to a non-transform-feedback target").
 *
 * @param {WebGL2RenderingContext} gl
 * @param {number} location
 * @param {WebGLBuffer} holder - A buffer the vertex array may keep: one that
 *   lives at least as long as it and that no transform-feedback pass writes
 *   while it is bound (it already holds it, or owns it for this).
 */
export function releaseVertexAttribute(gl, location, holder) {
  if (!holder) {
    throw new TypeError('A vertex attribute is released onto a buffer the vertex array may keep, never onto none.');
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, holder);
  gl.vertexAttribPointer(location, 1, gl.UNSIGNED_BYTE, false, 0, 0);
  gl.disableVertexAttribArray(location);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
}

// Whether the browser can observe the device-pixel box, which also reports a
// move that changes the snapped size without changing the CSS size.
const REPORTS_DEVICE_PIXEL_BOX = typeof ResizeObserverEntry === 'function'
  && 'devicePixelContentBoxSize' in ResizeObserverEntry.prototype;

/**
 * The canvas's size in the device pixels the browser composites it onto.
 *
 * The compositor snaps each edge of the canvas to a device pixel, so the
 * picture covers `round(right · dpr) - round(left · dpr)` pixels, not
 * `floor(width · dpr)`. A drawing buffer of any other size is rescaled to fit
 * on every frame, and a fractional layout width (a canvas beside a sidebar is
 * often 1009.5 CSS px wide) is enough to resample every one-pixel line and dot
 * of the scene. The size comes from the snapped edges themselves (the canvas
 * has no border or padding, so its border box is its content box): the
 * ResizeObserver's own device-pixel box is not used, because under emulated
 * device scales it reports unscaled pixels in Chromium and Firefox. One layout
 * read per resize, never per frame.
 */
function snappedDevicePixelSize(canvas, dpr) {
  const rect = canvas.getBoundingClientRect();
  return {
    width: Math.max(0, Math.round(rect.right * dpr) - Math.round(rect.left * dpr)),
    height: Math.max(0, Math.round(rect.bottom * dpr) - Math.round(rect.top * dpr)),
  };
}

/**
 * Creates a ResizeObserver-based canvas size tracker to avoid per-frame layout reads.
 * Also monitors DPR changes (e.g., moving window between monitors with different scales).
 * Returns an object with a getSize() method that returns cached dimensions.
 * `onChange` (optional) runs after the cached size changes, so a frame loop
 * that stops while nothing changes can be asked for a frame at the new size.
 */
export function createCanvasResizeObserver(canvas, onChange = null) {
  let currentDpr = window.devicePixelRatio || 1;
  let cachedCssWidth = canvas.clientWidth;
  let cachedCssHeight = canvas.clientHeight;
  const initialSize = snappedDevicePixelSize(canvas, currentDpr);
  let cachedWidth = initialSize.width;
  let cachedHeight = initialSize.height;
  const cachedSizeView = Object.freeze({
    get cssHeight() {
      return cachedCssHeight;
    },
    get cssWidth() {
      return cachedCssWidth;
    },
    get height() {
      return cachedHeight;
    },
    get width() {
      return cachedWidth;
    },
  });
  let observer = null;
  let activeDprRegistration = null;
  const dprRegistrations = new Set();
  let subscriptionActive = true;

  // Function to recalculate dimensions with current DPR
  const updateDimensions = () => {
    currentDpr = window.devicePixelRatio || 1;
    const size = snappedDevicePixelSize(canvas, currentDpr);
    cachedWidth = size.width;
    cachedHeight = size.height;
    onChange?.();
  };

  const handleResize = entries => {
    if (!subscriptionActive) return;
    const entry = entries[0];
    currentDpr = window.devicePixelRatio || 1;
    cachedCssWidth = entry.contentRect.width;
    cachedCssHeight = entry.contentRect.height;
    const size = snappedDevicePixelSize(canvas, currentDpr);
    cachedWidth = size.width;
    cachedHeight = size.height;
    onChange?.();
  };

  const retireDprRegistration = registration => {
    registration.mediaQuery.removeEventListener(
      'change',
      registration.handler
    );
    dprRegistrations.delete(registration);
  };

  // Monitor DPR changes (e.g., dragging window between monitors with different
  // scales). A candidate listener is fully subscribed before it replaces the
  // active generation, so a fallible host cannot leave a monitoring gap.
  const armDprMonitor = () => {
    if (!subscriptionActive) return;
    const dpr = window.devicePixelRatio || 1;
    const registration = {
      handler: null,
      mediaQuery: window.matchMedia(`(resolution: ${dpr}dppx)`),
    };
    registration.handler = () => {
      if (
        !subscriptionActive ||
        activeDprRegistration !== registration
      ) {
        return;
      }
      updateDimensions();
      armDprMonitor();
    };
    // Record ownership before the fallible subscription. Some wrappers attach
    // the listener and then throw, and that retained handle must be removable.
    dprRegistrations.add(registration);
    try {
      registration.mediaQuery.addEventListener(
        'change',
        registration.handler
      );
    } catch (error) {
      try {
        retireDprRegistration(registration);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Canvas DPR-listener setup and rollback both failed.'
        );
      }
      throw error;
    }

    activeDprRegistration = registration;
    // Identity fencing makes retained stale callbacks inert. Retry every stale
    // removal opportunistically; explicit disconnect owns the final attempt.
    for (const staleRegistration of dprRegistrations) {
      if (staleRegistration === registration) continue;
      try {
        retireDprRegistration(staleRegistration);
      } catch {
        // Retain exact ownership for a bounded retry.
      }
    }
  };

  const disconnectResizeSources = () => {
    // Fence callbacks before any fallible host cleanup. A retained queued DPR
    // callback can therefore neither mutate dimensions nor publish a listener.
    subscriptionActive = false;
    activeDprRegistration = null;
    const failures = [];
    if (observer !== null) {
      try {
        observer.disconnect();
        observer = null;
      } catch (error) {
        failures.push(error);
      }
    }
    for (const registration of dprRegistrations) {
      try {
        retireDprRegistration(registration);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Canvas resize subscription retains ${failures.length} pending cleanup failure(s).`
      );
    }
  };

  try {
    observer = new ResizeObserver(handleResize);
    observer.observe(
      canvas,
      REPORTS_DEVICE_PIXEL_BOX ? { box: 'device-pixel-content-box' } : undefined
    );
    armDprMonitor();
  } catch (error) {
    const cleanupFailures = [];
    try {
      disconnectResizeSources();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Canvas resize-observer construction and rollback both failed.'
      );
    }
    throw error;
  }

  return {
    /**
     * Returns current display size and resizes canvas if needed.
     * No layout read or per-call allocation occurs; callers receive one stable,
     * read-only view over the cached ResizeObserver-owned scalar dimensions.
     */
    getSize() {
      if (canvas.width !== cachedWidth || canvas.height !== cachedHeight) {
        canvas.width = cachedWidth;
        canvas.height = cachedHeight;
      }
      return cachedSizeView;
    },
    disconnect() {
      disconnectResizeSources();
    }
  };
}

/**
 * Centre and scale positions in place so the largest axis range spans [-1, 1].
 *
 * `dimension` is the number of components each cell holds (see
 * `position-layout.js`). An axis the embedding does not have is exactly zero,
 * so it contributes a zero range and a zero centre: normalizing a 2-D array
 * gives bit-for-bit the x and y a zero-padded XYZ copy would have received.
 *
 * @param {Float32Array} positions
 * @param {1|2|3} [dimension=3]
 * @returns {{ center: [number, number, number], scale: number }}
 */
export function normalizePositions(positions, dimension = 3) {
  if (dimension !== 1 && dimension !== 2 && dimension !== 3) {
    throw new RangeError('normalizePositions dimension must be exactly 1, 2, or 3.');
  }
  if (!positions || positions.length === 0) {
    return {
      center: [0, 0, 0],
      scale: 1
    };
  }
  if (positions.length % dimension !== 0) {
    throw new RangeError(
      `normalizePositions received ${formatCountOf(positions.length, 'value')}, which is not a whole number of ${dimension}-component points.`
    );
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let axis = 0; axis < dimension; axis++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = axis; i < positions.length; i += dimension) {
      const v = positions[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[axis] = lo;
    max[axis] = hi;
  }
  for (let axis = dimension; axis < 3; axis++) {
    min[axis] = 0;
    max[axis] = 0;
  }

  const centerX = 0.5 * (min[0] + max[0]);
  const centerY = 0.5 * (min[1] + max[1]);
  const centerZ = 0.5 * (min[2] + max[2]);
  const center = [centerX, centerY, centerZ];

  const rangeX = max[0] - min[0];
  const rangeY = max[1] - min[1];
  const rangeZ = max[2] - min[2];
  let maxRange = Math.max(rangeX, rangeY, rangeZ);
  if (maxRange === 0) maxRange = 1.0;
  const scale = 2.0 / maxRange;

  for (let axis = 0; axis < dimension; axis++) {
    const c = center[axis];
    for (let i = axis; i < positions.length; i += dimension) {
      positions[i] = (positions[i] - c) * scale;
    }
  }

  return {
    center,
    scale
  };
}
