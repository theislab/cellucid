/**
 * The fixed-function state of a WebGL2 context, kept on the page so it can be
 * read without asking the GPU.
 *
 * A renderer that draws into another's frame (the backdrop look, a GPU pass,
 * the smoke density build, the edge upload) saves the state it changes and
 * puts it back. Reading that state from the context is free for bindings and
 * pixel-store parameters, which every engine keeps on the page, but not for
 * the rest: in Firefox and WebKit `isEnabled`, `getParameter` of
 * `ACTIVE_TEXTURE`, `VIEWPORT`, `SCISSOR_BOX`, `COLOR_WRITEMASK`, the blend
 * functions and equations and `COLOR_CLEAR_VALUE` are round trips to the GPU
 * process that first run every command queued before them (measured: 6–8 ms
 * in Firefox and 16–24 ms in WebKit after one 64 MB texture upload; 0 ms for
 * a binding). The backdrop look asked three of them per pane per frame.
 * Chromium answers `getVertexAttrib(CURRENT_VERTEX_ATTRIB)` the same way: the
 * GPU permute pass asked it once a pass and waited for the frame before it
 * (2.3 s over a 100M-point adoption), so a generic attribute value is
 * shadowed too (`genericAttribute`).
 *
 * The shadow is installed once per context: the context's setters for that
 * state are wrapped on the instance, so every change, by any caller, lands in
 * the shadow too. A value is read from the context once, the first time it is
 * asked for before any setter gave it (or all at once, `primeGlState`, where
 * the context is made); every later read is a property read.
 *
 * What it does not do: validate. A setter given a value WebGL refuses (an
 * unknown enum, which records an error and changes nothing) is recorded as if
 * it had been accepted; the renderers pass only valid values.
 *
 * @module rendering/gl-state-shadow
 */

/** Capabilities toggled with enable/disable that the shadow tracks. */
const CAPABILITY_NAMES = Object.freeze([
  'BLEND',
  'CULL_FACE',
  'DEPTH_TEST',
  'DITHER',
  'POLYGON_OFFSET_FILL',
  'RASTERIZER_DISCARD',
  'SAMPLE_ALPHA_TO_COVERAGE',
  'SAMPLE_COVERAGE',
  'SCISSOR_TEST',
  'STENCIL_TEST',
]);

/** @type {WeakMap<object, ReturnType<typeof createShadow>>} */
const shadows = new WeakMap();

function createShadow(gl) {
  // Each value is read from the context the first time it is asked for, and
  // kept from then on by the wrapped setters; a value set before it is first
  // asked for is known without a read.
  const capabilities = new Map();
  const tracked = new Set();
  for (const name of CAPABILITY_NAMES) {
    if (Number.isInteger(gl[name])) tracked.add(gl[name]);
  }
  const known = new Map();
  const read = (key, query) => {
    if (!known.has(key)) known.set(key, query());
    return known.get(key);
  };

  const wrap = (name, record) => {
    const original = gl[name];
    if (typeof original !== 'function') return;
    gl[name] = function shadowedSetter(...args) {
      const result = Reflect.apply(original, gl, args);
      record(...args);
      return result;
    };
  };
  wrap('enable', capability => {
    if (tracked.has(capability)) capabilities.set(capability, true);
  });
  wrap('disable', capability => {
    if (tracked.has(capability)) capabilities.set(capability, false);
  });
  wrap('activeTexture', unit => { known.set('activeTexture', unit); });
  wrap('viewport', (x, y, width, height) => {
    known.set('viewport', Int32Array.of(x, y, width, height));
  });
  wrap('scissor', (x, y, width, height) => {
    known.set('scissorBox', Int32Array.of(x, y, width, height));
  });
  wrap('colorMask', (red, green, blue, alpha) => {
    known.set('colorMask', [Boolean(red), Boolean(green), Boolean(blue), Boolean(alpha)]);
  });
  wrap('clearColor', (red, green, blue, alpha) => {
    known.set('clearColor', [Math.fround(red), Math.fround(green), Math.fround(blue), Math.fround(alpha)]);
  });
  wrap('blendFunc', (source, destination) => {
    known.set('blendFunc', { srcRgb: source, dstRgb: destination, srcAlpha: source, dstAlpha: destination });
  });
  wrap('blendFuncSeparate', (srcRgb, dstRgb, srcAlpha, dstAlpha) => {
    known.set('blendFunc', { srcRgb, dstRgb, srcAlpha, dstAlpha });
  });
  wrap('blendEquation', mode => {
    known.set('blendEquation', { rgb: mode, alpha: mode });
  });
  wrap('blendEquationSeparate', (rgb, alpha) => {
    known.set('blendEquation', { rgb, alpha });
  });
  wrap('depthMask', flag => { known.set('depthMask', Boolean(flag)); });
  // Generic (constant) vertex attribute values, as `getVertexAttrib(location,
  // CURRENT_VERTEX_ATTRIB)` answers them: typed by the setter that gave them.
  wrap('vertexAttrib4f', (location, x, y, z, w) => {
    known.set(`generic${location}`, Float32Array.of(x, y, z, w));
  });
  wrap('vertexAttribI4i', (location, x, y, z, w) => {
    known.set(`generic${location}`, Int32Array.of(x, y, z, w));
  });
  wrap('vertexAttribI4ui', (location, x, y, z, w) => {
    known.set(`generic${location}`, Uint32Array.of(x, y, z, w));
  });

  const shadow = Object.freeze({
    /** Whether a tracked capability is on, as `gl.isEnabled` answers. */
    isEnabled(capability) {
      if (!tracked.has(capability)) {
        throw new RangeError(`The WebGL state shadow does not track capability 0x${Number(capability).toString(16)}.`);
      }
      if (!capabilities.has(capability)) capabilities.set(capability, gl.isEnabled(capability) === true);
      return capabilities.get(capability);
    },
    get activeTexture() {
      return read('activeTexture', () => gl.getParameter(gl.ACTIVE_TEXTURE));
    },
    /** A copy, as `getParameter(VIEWPORT)` returns one. */
    get viewport() {
      return Int32Array.from(read('viewport', () => Int32Array.from(gl.getParameter(gl.VIEWPORT))));
    },
    get scissorBox() {
      return Int32Array.from(read('scissorBox', () => Int32Array.from(gl.getParameter(gl.SCISSOR_BOX))));
    },
    get colorMask() {
      return [...read('colorMask', () => Array.from(gl.getParameter(gl.COLOR_WRITEMASK), Boolean))];
    },
    get clearColor() {
      return [...read('clearColor', () => Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE)))];
    },
    get blendFunc() {
      return { ...read('blendFunc', () => ({
        srcRgb: gl.getParameter(gl.BLEND_SRC_RGB),
        dstRgb: gl.getParameter(gl.BLEND_DST_RGB),
        srcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA),
        dstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
      })) };
    },
    get blendEquation() {
      return { ...read('blendEquation', () => ({
        rgb: gl.getParameter(gl.BLEND_EQUATION_RGB),
        alpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA),
      })) };
    },
    get depthMask() {
      return read('depthMask', () => gl.getParameter(gl.DEPTH_WRITEMASK) === true);
    },
    /**
     * The generic value of vertex attribute `location`, a copy as
     * `getVertexAttrib(location, CURRENT_VERTEX_ATTRIB)` returns it. Only the
     * four-component setters are shadowed; the renderers set no other. One
     * no setter gave is the context's initial value, float (0, 0, 0, 1)
     * (the OpenGL ES 3.0 initial value), which is not asked for: the shadow is installed
     * where the context is made, before any setter runs.
     */
    genericAttribute(location) {
      const value = known.get(`generic${location}`) ?? Float32Array.of(0, 0, 0, 1);
      return new value.constructor(value);
    },
  });
  return shadow;
}

/**
 * Read every value of `gl`'s shadow now (`glStateOf`), where the context is
 * made and nothing is queued yet, instead of the first time a pass asks for
 * one: a first read during a frame of a large view waits for that whole
 * frame (0.2 s for `colorMask`, first read by the GPU permute's source draw
 * during a 100M-point adoption).
 *
 * @param {WebGL2RenderingContext} gl
 */
export function primeGlState(gl) {
  const shadow = glStateOf(gl);
  for (const name of CAPABILITY_NAMES) {
    if (Number.isInteger(gl[name])) shadow.isEnabled(gl[name]);
  }
  for (const name of ['activeTexture', 'viewport', 'scissorBox', 'colorMask', 'clearColor', 'blendFunc', 'blendEquation', 'depthMask']) {
    void shadow[name];
  }
}

/**
 * The state shadow of `gl`, installed on first use (see the module overview).
 * Install it where the context is created, so no setter call is missed.
 *
 * @param {WebGL2RenderingContext} gl
 */
export function glStateOf(gl) {
  let shadow = shadows.get(gl);
  if (shadow === undefined) {
    shadow = createShadow(gl);
    shadows.set(gl, shadow);
  }
  return shadow;
}
