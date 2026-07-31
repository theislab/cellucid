/**
 * @fileoverview Rasterizer identity and canvas geometry for benchmark runs.
 *
 * A frame time measured on a software rasterizer is not a slow result, it is
 * a void one: SwiftShader and llvmpipe run the fragment stage on the CPU, so
 * every conclusion about GPU boundedness inverts. Headless Chromium selects
 * SwiftShader by default, which makes this the single easiest way for a later
 * cycle to record a meaningless baseline without noticing.
 *
 * A benchmark run therefore reads the unmasked renderer string and refuses to
 * publish a baseline unless it names real hardware.
 *
 * The same record carries the canvas backing-store size. A fill-rate result
 * without a pixel count cannot be compared against anything, and the device
 * pixel ratio alone does not give it: the canvas may be clamped.
 *
 * @module app/ui/modules/benchmark/renderer-identity
 */

/**
 * Substrings that identify a CPU rasterizer in an unmasked renderer string.
 * Matched case-insensitively against renderer and vendor together.
 */
export const SOFTWARE_RASTERIZER_MARKERS = Object.freeze([
  'swiftshader',
  'llvmpipe',
  'lavapipe',
  'softpipe',
  'software rasterizer',
  'microsoft basic render driver',
  'mesa offscreen',
  'apple software renderer',
  'generic renderer'
]);

function requireContext(gl) {
  if (
    gl === null ||
    typeof gl !== 'object' ||
    typeof gl.getParameter !== 'function' ||
    typeof gl.getExtension !== 'function'
  ) {
    throw new TypeError(
      'Renderer identity requires one WebGL2 rendering context.'
    );
  }
  return gl;
}

function readString(gl, parameter) {
  if (parameter === null || parameter === undefined) return null;
  const value = gl.getParameter(parameter);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Read the exact rasterizer identity plus the canvas backing-store size.
 *
 * @param {WebGL2RenderingContext} gl - Live context.
 * @returns {Object} Frozen identity record.
 */
export function readRendererIdentity(gl) {
  requireContext(gl);
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const unmaskedRenderer = debugInfo
    ? readString(gl, debugInfo.UNMASKED_RENDERER_WEBGL)
    : null;
  const unmaskedVendor = debugInfo
    ? readString(gl, debugInfo.UNMASKED_VENDOR_WEBGL)
    : null;
  const canvas = gl.canvas ?? null;
  const drawingBufferWidth = Number.isFinite(gl.drawingBufferWidth)
    ? gl.drawingBufferWidth
    : null;
  const drawingBufferHeight = Number.isFinite(gl.drawingBufferHeight)
    ? gl.drawingBufferHeight
    : null;
  const canvasWidth =
    canvas !== null && Number.isFinite(canvas.width) ? canvas.width : null;
  const canvasHeight =
    canvas !== null && Number.isFinite(canvas.height) ? canvas.height : null;
  const devicePixelRatio =
    typeof globalThis.devicePixelRatio === 'number'
      ? globalThis.devicePixelRatio
      : null;

  return Object.freeze({
    unmaskedRenderer,
    unmaskedVendor,
    maskedRenderer: readString(gl, gl.RENDERER),
    maskedVendor: readString(gl, gl.VENDOR),
    version: readString(gl, gl.VERSION),
    shadingLanguageVersion: readString(gl, gl.SHADING_LANGUAGE_VERSION),
    debugRendererInfoAvailable: debugInfo !== null,
    canvas: Object.freeze({
      width: canvasWidth,
      height: canvasHeight,
      drawingBufferWidth,
      drawingBufferHeight,
      devicePixelRatio,
      backingStorePixels:
        drawingBufferWidth !== null && drawingBufferHeight !== null
          ? drawingBufferWidth * drawingBufferHeight
          : null
    }),
    timerQueryAvailable:
      gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null
  });
}

/**
 * Classify a renderer identity as hardware or software rasterization.
 *
 * An absent unmasked string is not treated as hardware. Without the string the
 * rasterizer is unknown, and an unknown rasterizer cannot certify a baseline.
 *
 * @param {Object} identity - Record from `readRendererIdentity()`.
 * @returns {Object} Frozen classification with the matched marker, if any.
 */
export function classifyRasterizer(identity) {
  if (
    identity === null ||
    typeof identity !== 'object' ||
    Array.isArray(identity)
  ) {
    throw new TypeError('Rasterizer classification requires one identity.');
  }
  const parts = [];
  if (typeof identity.unmaskedRenderer === 'string') {
    parts.push(identity.unmaskedRenderer);
  }
  if (typeof identity.unmaskedVendor === 'string') {
    parts.push(identity.unmaskedVendor);
  }
  if (parts.length === 0) {
    return Object.freeze({
      kind: 'unknown',
      baselineEligible: false,
      matchedMarker: null,
      reason:
        'WEBGL_debug_renderer_info published no unmasked renderer string, ' +
        'so the rasterizer cannot be identified.'
    });
  }
  const haystack = parts.join(' ').toLowerCase();
  for (const marker of SOFTWARE_RASTERIZER_MARKERS) {
    if (haystack.includes(marker)) {
      return Object.freeze({
        kind: 'software',
        baselineEligible: false,
        matchedMarker: marker,
        reason:
          `Unmasked renderer "${parts[0]}" names the software rasterizer ` +
          `"${marker}"; frame times from it describe the CPU, not the GPU.`
      });
    }
  }
  return Object.freeze({
    kind: 'hardware',
    baselineEligible: true,
    matchedMarker: null,
    reason: `Unmasked renderer "${parts[0]}" names hardware rasterization.`
  });
}

/**
 * Throw unless the identity names hardware rasterization.
 *
 * Call this before recording any baseline. A run that reaches this and throws
 * has produced a stated failure, which is a better result than a number nobody
 * can interpret.
 *
 * @param {Object} identity - Record from `readRendererIdentity()`.
 * @returns {Object} The classification, when eligible.
 */
export function assertBaselineEligibleRasterizer(identity) {
  const classification = classifyRasterizer(identity);
  if (!classification.baselineEligible) {
    throw new Error(
      `Benchmark baseline refused: ${classification.reason}`
    );
  }
  return classification;
}

/**
 * A filesystem-safe key for the rasterizer, so baselines from different GPUs
 * are never compared against one another.
 *
 * @param {Object} identity - Record from `readRendererIdentity()`.
 * @returns {string} Slug derived from the unmasked renderer string.
 */
export function rendererBaselineKey(identity) {
  const classification = classifyRasterizer(identity);
  const name =
    typeof identity.unmaskedRenderer === 'string' &&
    identity.unmaskedRenderer.length > 0
      ? identity.unmaskedRenderer
      : `unknown-${classification.kind}`;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'unknown-renderer';
}
