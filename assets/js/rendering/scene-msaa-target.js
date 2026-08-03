/**
 * @module rendering/scene-msaa-target
 *
 * Multisample antialiasing that can be switched on and off while the page is
 * open.
 *
 * ## Why this exists
 *
 * `antialias` is a WebGL **context-creation attribute**. Asking
 * `getContext('webgl2', { antialias: true })` for it makes the browser hand back
 * a multisampled default drawing buffer and resolve it on present, and nothing
 * can change that afterwards: passing different attributes to a canvas that
 * already has a context returns the existing context and ignores them, and
 * Cellucid deliberately has no path to a second context — a lost one is terminal
 * by design.
 *
 * That made antialiasing the one render setting that could not take effect until
 * the page was reloaded, and the control said so. It is also the setting whose
 * right answer depends on the dataset: at eighteen million cells multisampling
 * is the difference between a view that turns and one that does not, and at four
 * thousand it costs nothing worth measuring. A per-dataset answer and a
 * process-lifetime attribute cannot both be true, and datasets are switched in
 * place with no reload, so the attribute had to go.
 *
 * ## What replaces it
 *
 * The context is created single-sampled, and the scene is drawn into a
 * multisampled renderbuffer of the app's own, which is blitted onto the default
 * framebuffer at the end of each frame. That is exactly what the browser does
 * for a multisampled default buffer — same sample count, same coverage
 * arithmetic, same resolve — so the image is the one the attribute produced,
 * and the app owns the switch.
 *
 * With antialiasing off, `beginFrame` binds framebuffer zero and `resolveFrame`
 * does nothing: the frame is drawn exactly as it was before this module existed,
 * at exactly the same cost. Nothing is allocated until it is switched on, and
 * everything is released when it is switched off.
 *
 * ## What callers must respect
 *
 * Anything drawing into the scene must target `getSceneFramebuffer()` rather
 * than assuming zero. Two owners bind a framebuffer of their own mid-frame and
 * have to come back to the scene rather than to the default: the smoke renderer
 * and the velocity overlay. Anything reading pixels back must read after
 * `resolveFrame`, from the default framebuffer, or read the resolved copy.
 */

/**
 * Samples to ask for.
 *
 * Four is what browsers grant for a multisampled default drawing buffer, so
 * asking for four reproduces what `antialias: true` used to give rather than
 * quietly changing the image while claiming to preserve it. A device whose
 * maximum is lower gets its maximum, which is also what the attribute would
 * have done.
 */
export const SCENE_MSAA_TARGET_SAMPLES = 4;

function requireDrawingBufferExtent(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `${label} must be one non-negative integer of device pixels.`
    );
  }
  return value;
}

/**
 * Create the switchable multisample resolve target for one context.
 *
 * @param {WebGL2RenderingContext} gl
 * @returns {Readonly<{
 *   isAvailable: () => boolean,
 *   isEnabled: () => boolean,
 *   getSampleCount: () => number,
 *   setEnabled: (enabled: boolean) => boolean,
 *   getSceneFramebuffer: () => WebGLFramebuffer|null,
 *   beginFrame: (width: number, height: number) => void,
 *   resolveFrame: (width: number, height: number) => void,
 *   handleContextLost: () => void,
 *   dispose: () => void
 * }>}
 */
export function createSceneMsaaTarget(gl) {
  if (
    gl === null
    || typeof gl !== 'object'
    || typeof gl.createFramebuffer !== 'function'
    || typeof gl.renderbufferStorageMultisample !== 'function'
    || typeof gl.blitFramebuffer !== 'function'
  ) {
    throw new TypeError(
      'A scene multisample target requires one current WebGL2 context.'
    );
  }

  // Read once, at construction: it is a property of the device, and reading it
  // per frame would query a context that may already be lost.
  const maximumSamples = (() => {
    const reported = gl.getParameter(gl.MAX_SAMPLES);
    return Number.isInteger(reported) && reported >= 2 ? reported : 0;
  })();
  const sampleCount = maximumSamples === 0
    ? 0
    : Math.min(SCENE_MSAA_TARGET_SAMPLES, maximumSamples);
  const available = sampleCount >= 2;

  let enabled = false;
  let contextLost = false;
  let disposed = false;
  let framebuffer = null;
  let colorBuffer = null;
  let depthBuffer = null;
  let allocatedWidth = 0;
  let allocatedHeight = 0;
  let boundThisFrame = false;

  function releaseResources() {
    // After context loss every handle is already invalid; issuing deletions
    // against a lost context is the one thing that turns cleanup into an error.
    if (!contextLost) {
      if (framebuffer !== null) gl.deleteFramebuffer(framebuffer);
      if (colorBuffer !== null) gl.deleteRenderbuffer(colorBuffer);
      if (depthBuffer !== null) gl.deleteRenderbuffer(depthBuffer);
    }
    framebuffer = null;
    colorBuffer = null;
    depthBuffer = null;
    allocatedWidth = 0;
    allocatedHeight = 0;
  }

  /**
   * Allocate, or reallocate, at one exact drawing-buffer size.
   *
   * Publication is transactional: a failure releases the partial attempt and
   * leaves nothing allocated, so the frame draws unantialiased instead of into
   * an incomplete framebuffer.
   */
  function allocate(width, height) {
    releaseResources();
    let candidateFramebuffer = null;
    let candidateColor = null;
    let candidateDepth = null;
    try {
      candidateColor = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, candidateColor);
      gl.renderbufferStorageMultisample(
        gl.RENDERBUFFER,
        sampleCount,
        gl.RGBA8,
        width,
        height
      );
      candidateDepth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, candidateDepth);
      gl.renderbufferStorageMultisample(
        gl.RENDERBUFFER,
        sampleCount,
        gl.DEPTH24_STENCIL8,
        width,
        height
      );
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);

      candidateFramebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, candidateFramebuffer);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.RENDERBUFFER,
        candidateColor
      );
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_STENCIL_ATTACHMENT,
        gl.RENDERBUFFER,
        candidateDepth
      );
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(
          `Scene multisample framebuffer is incomplete (0x${status.toString(16)}).`
        );
      }
    } catch (error) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (candidateFramebuffer !== null) {
        gl.deleteFramebuffer(candidateFramebuffer);
      }
      if (candidateColor !== null) gl.deleteRenderbuffer(candidateColor);
      if (candidateDepth !== null) gl.deleteRenderbuffer(candidateDepth);
      throw error;
    }
    framebuffer = candidateFramebuffer;
    colorBuffer = candidateColor;
    depthBuffer = candidateDepth;
    allocatedWidth = width;
    allocatedHeight = height;
  }

  function usable() {
    return available && enabled && !contextLost && !disposed;
  }

  return Object.freeze({
    /** Whether this device can multisample at all. */
    isAvailable() {
      return available;
    },

    /** Whether the scene is currently being drawn multisampled. */
    isEnabled() {
      return usable() && framebuffer !== null;
    },

    /** Samples per pixel, or 0 when the device cannot multisample. */
    getSampleCount() {
      return available ? sampleCount : 0;
    },

    /**
     * Turn antialiasing on or off for every following frame.
     *
     * Returns what is actually in force, which is not always what was asked
     * for: a device that cannot multisample answers `false` to a request for
     * `true`, and the caller is entitled to say so on screen rather than showing
     * a setting that does nothing.
     *
     * @param {boolean} next
     * @returns {boolean}
     */
    setEnabled(next) {
      if (typeof next !== 'boolean') {
        throw new TypeError('Scene antialiasing must be an exact boolean.');
      }
      if (disposed) {
        throw new Error('Scene antialiasing cannot change after disposal.');
      }
      enabled = next;
      if (!enabled) releaseResources();
      return available && enabled;
    },

    /**
     * The framebuffer the scene is being drawn into this frame.
     *
     * Null means the default framebuffer, which is what every caller assumed
     * before this module existed.
     */
    getSceneFramebuffer() {
      return usable() ? framebuffer : null;
    },

    /**
     * Bind the scene target for one frame at the current drawing-buffer size.
     *
     * An allocation failure is not fatal to the frame: antialiasing is switched
     * off and the frame proceeds on the default framebuffer. A view that turns
     * without smooth edges is strictly better than no view.
     *
     * @param {number} width
     * @param {number} height
     */
    beginFrame(width, height) {
      boundThisFrame = false;
      if (!usable()) return;
      requireDrawingBufferExtent(width, 'Scene multisample width');
      requireDrawingBufferExtent(height, 'Scene multisample height');
      // A canvas that is laid out to nothing — display:none, or a pane mid-drag
      // — has a zero-sized drawing buffer, which no renderbuffer can match. The
      // frame still runs, unantialiased, against a buffer with no pixels in it.
      if (width === 0 || height === 0) return;
      if (
        framebuffer === null
        || allocatedWidth !== width
        || allocatedHeight !== height
      ) {
        try {
          allocate(width, height);
        } catch (error) {
          enabled = false;
          releaseResources();
          console.error(
            '[SceneMsaaTarget] Antialiasing was switched off:',
            error
          );
          return;
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      boundThisFrame = true;
    },

    /**
     * Resolve the frame onto the default framebuffer and rebind it.
     *
     * `NEAREST` is required for a multisample resolve blit, and the rectangles
     * are identical, so the filter never interpolates: this is the resolve, not
     * a rescale.
     *
     * @param {number} width
     * @param {number} height
     */
    resolveFrame(width, height) {
      if (!boundThisFrame) return;
      boundThisFrame = false;
      if (contextLost || disposed || framebuffer === null) {
        if (!contextLost && !disposed) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
        return;
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(
        0, 0, width, height,
        0, 0, width, height,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST
      );
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },

    /** Drop every handle without touching the lost context. */
    handleContextLost() {
      contextLost = true;
      boundThisFrame = false;
      releaseResources();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      boundThisFrame = false;
      releaseResources();
    },
  });
}
