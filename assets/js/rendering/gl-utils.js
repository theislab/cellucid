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
 * Creates a ResizeObserver-based canvas size tracker to avoid per-frame layout reads.
 * Also monitors DPR changes (e.g., moving window between monitors with different scales).
 * Returns an object with a getSize() method that returns cached dimensions.
 */
export function createCanvasResizeObserver(canvas) {
  let currentDpr = window.devicePixelRatio || 1;
  let cachedWidth = Math.floor(canvas.clientWidth * currentDpr);
  let cachedHeight = Math.floor(canvas.clientHeight * currentDpr);

  // Function to recalculate dimensions with current DPR
  const updateDimensions = () => {
    currentDpr = window.devicePixelRatio || 1;
    cachedWidth = Math.floor(canvas.clientWidth * currentDpr);
    cachedHeight = Math.floor(canvas.clientHeight * currentDpr);
  };

  const observer = new ResizeObserver(entries => {
    const entry = entries[0];
    currentDpr = window.devicePixelRatio || 1;
    cachedWidth = Math.floor(entry.contentRect.width * currentDpr);
    cachedHeight = Math.floor(entry.contentRect.height * currentDpr);
  });
  observer.observe(canvas);

  // Monitor DPR changes (e.g., dragging window between monitors with different scales)
  // matchMedia with resolution query fires when DPR changes
  let dprMediaQuery = null;
  let dprChangeHandler = null;

  const setupDprMonitor = () => {
    // Clean up previous listener if any
    if (dprMediaQuery && dprChangeHandler) {
      dprMediaQuery.removeEventListener('change', dprChangeHandler);
    }
    // Create new media query for current DPR
    dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprChangeHandler = () => {
      updateDimensions();
      // Re-setup for the new DPR value
      setupDprMonitor();
    };
    dprMediaQuery.addEventListener('change', dprChangeHandler);
  };
  setupDprMonitor();

  return {
    /**
     * Returns current display size and resizes canvas if needed.
     * No layout read occurs - uses cached values from ResizeObserver.
     */
    getSize() {
      if (canvas.width !== cachedWidth || canvas.height !== cachedHeight) {
        canvas.width = cachedWidth;
        canvas.height = cachedHeight;
      }
      return [cachedWidth, cachedHeight];
    },
    disconnect() {
      observer.disconnect();
      if (dprMediaQuery && dprChangeHandler) {
        dprMediaQuery.removeEventListener('change', dprChangeHandler);
      }
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
