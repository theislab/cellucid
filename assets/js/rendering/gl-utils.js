// WebGL helpers for shader/program creation and data normalization.
function asError(value, fallbackMessage) {
  return value instanceof Error ? value : new Error(fallbackMessage);
}

function attemptCleanup(failures, cleanup, fallbackMessage) {
  try {
    cleanup();
  } catch (error) {
    failures.push(asError(error, fallbackMessage));
  }
}

function throwTransactionFailure(failures, message) {
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
}

export function createRequiredTexture(gl, role) {
  if (!gl || typeof gl.createTexture !== 'function') {
    throw new TypeError(
      'Required WebGL texture allocation needs a WebGL2 context.'
    );
  }
  if (typeof role !== 'string' || role.length === 0) {
    throw new TypeError('Required WebGL allocation needs a non-empty texture role.');
  }
  const texture = gl.createTexture();
  if (texture === null) {
    throw new Error(
      `WebGL2 could not allocate the required ${role} texture.`
    );
  }
  return texture;
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
 * Creates a ResizeObserver-based canvas size tracker to avoid per-frame layout reads.
 * Also monitors DPR changes (e.g., moving window between monitors with different scales).
 * Returns an object with a getSize() method that returns cached dimensions.
 */
export function createCanvasResizeObserver(canvas) {
  let currentDpr = window.devicePixelRatio || 1;
  let cachedCssWidth = canvas.clientWidth;
  let cachedCssHeight = canvas.clientHeight;
  let cachedWidth = Math.floor(cachedCssWidth * currentDpr);
  let cachedHeight = Math.floor(cachedCssHeight * currentDpr);
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
    cachedWidth = Math.floor(cachedCssWidth * currentDpr);
    cachedHeight = Math.floor(cachedCssHeight * currentDpr);
  };

  const handleResize = entries => {
    if (!subscriptionActive) return;
    const entry = entries[0];
    currentDpr = window.devicePixelRatio || 1;
    cachedCssWidth = entry.contentRect.width;
    cachedCssHeight = entry.contentRect.height;
    cachedWidth = Math.floor(cachedCssWidth * currentDpr);
    cachedHeight = Math.floor(cachedCssHeight * currentDpr);
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
    observer.observe(canvas);
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

export function normalizePositions(positions) {
  if (!positions || positions.length === 0) {
    return {
      center: [0, 0, 0],
      scale: 1
    };
  }
  const n = positions.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < n; i++) {
    const x = positions[3 * i];
    const y = positions[3 * i + 1];
    const z = positions[3 * i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  const centerX = 0.5 * (minX + maxX);
  const centerY = 0.5 * (minY + maxY);
  const centerZ = 0.5 * (minZ + maxZ);

  const rangeX = maxX - minX;
  const rangeY = maxY - minY;
  const rangeZ = maxZ - minZ;
  let maxRange = Math.max(rangeX, rangeY, rangeZ);
  if (maxRange === 0) maxRange = 1.0;
  const scale = 2.0 / maxRange;

  for (let i = 0; i < n; i++) {
    const idx = 3 * i;
    positions[idx] = (positions[idx] - centerX) * scale;
    positions[idx + 1] = (positions[idx + 1] - centerY) * scale;
    positions[idx + 2] = (positions[idx + 2] - centerZ) * scale;
  }

  return {
    center: [centerX, centerY, centerZ],
    scale
  };
}
