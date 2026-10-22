// Emulates the WebGL2 capability set of iOS Safari (Apple GPUs) on any engine.
//
// The app learns its capabilities only through getExtension(),
// getSupportedExtensions() and getParameter(), so this is what it sees on an
// iPhone: no EXT_float_blend, no OES_texture_float_linear, and an older
// device's limits. An extension hidden here is also never enabled. (Some
// engines enable float32 blending implicitly with EXT_color_buffer_float, so
// a draw that blends into float32 is not reliably refused under emulation;
// the app must never depend on such a refusal, only on the queries.) Many
// Android GPUs share the same two gaps.
//
// Limits are capped to an older iPhone's, never raised above what the host
// reports.

/** Extensions iOS Safari 16-18 exposes on WebGL2; everything else is hidden. */
export const IOS_WEBGL2_EXTENSIONS = Object.freeze([
  'EXT_color_buffer_float',
  'EXT_color_buffer_half_float',
  'EXT_texture_filter_anisotropic',
  'KHR_parallel_shader_compile',
  'OES_draw_buffers_indexed',
  'WEBGL_compressed_texture_astc',
  'WEBGL_compressed_texture_etc',
  'WEBGL_compressed_texture_etc1',
  'WEBGL_compressed_texture_pvrtc',
  'WEBGL_debug_renderer_info',
  'WEBGL_debug_shaders',
  'WEBGL_lose_context',
  'WEBGL_multi_draw',
]);

export const IOS_WEBGL2_LIMITS = Object.freeze({
  MAX_TEXTURE_SIZE: 4096,
  MAX_3D_TEXTURE_SIZE: 2048,
  MAX_RENDERBUFFER_SIZE: 4096,
  MAX_SAMPLES: 4,
  MAX_VIEWPORT_DIMS: 4096,
});

/** Installs the emulation for every document the page loads from now on. */
export async function installIosWebGLCapabilities(page) {
  await page.addInitScript(([allowed, limits]) => {
    const allow = new Set(allowed);
    const proto = WebGL2RenderingContext.prototype;
    const getExtension = proto.getExtension;
    const getSupportedExtensions = proto.getSupportedExtensions;
    const getParameter = proto.getParameter;
    proto.getExtension = function emulatedGetExtension(name) {
      return allow.has(name) ? getExtension.call(this, name) : null;
    };
    proto.getSupportedExtensions = function emulatedGetSupportedExtensions() {
      const list = getSupportedExtensions.call(this);
      return list === null ? null : list.filter(name => allow.has(name));
    };
    proto.getParameter = function emulatedGetParameter(parameter) {
      const value = getParameter.call(this, parameter);
      switch (parameter) {
        case this.MAX_TEXTURE_SIZE:
          return Math.min(value, limits.MAX_TEXTURE_SIZE);
        case this.MAX_3D_TEXTURE_SIZE:
          return Math.min(value, limits.MAX_3D_TEXTURE_SIZE);
        case this.MAX_RENDERBUFFER_SIZE:
          return Math.min(value, limits.MAX_RENDERBUFFER_SIZE);
        case this.MAX_SAMPLES:
          return Math.min(value, limits.MAX_SAMPLES);
        case this.MAX_VIEWPORT_DIMS:
          return Int32Array.from(value, size => Math.min(size, limits.MAX_VIEWPORT_DIMS));
        default:
          return value;
      }
    };
    Object.defineProperty(window, '__cellucidIosWebGLEmulation', {
      value: true,
      configurable: false,
    });
  }, [IOS_WEBGL2_EXTENSIONS, IOS_WEBGL2_LIMITS]);
}
