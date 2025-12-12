// WebGL helpers for shader/program creation and data normalization.
export function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('Could not compile shader:\n' + info);
  }
  return shader;
}

export function createProgram(gl, vsSource, fsSource) {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('Could not link program:\n' + info);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
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

/** @deprecated Use createCanvasResizeObserver instead to avoid per-frame layout reads */
export function resizeCanvasToDisplaySize(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const displayWidth = Math.floor(canvas.clientWidth * dpr);
  const displayHeight = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
    canvas.width = displayWidth;
    canvas.height = displayHeight;
  }
  return [displayWidth, displayHeight];
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

export function applyNormalizationToCentroids(obs, transform) {
  if (!obs || !obs.fields || !transform) return;
  const cx = transform.center[0];
  const cy = transform.center[1];
  const cz = transform.center[2];
  const s = transform.scale;
  for (const field of obs.fields) {
    if (!field.centroids) continue;
    for (const c of field.centroids) {
      const p = c.position;
      if (!p || p.length < 3) continue;
      p[0] = (p[0] - cx) * s;
      p[1] = (p[1] - cy) * s;
      p[2] = (p[2] - cz) * s;
    }
  }
}
