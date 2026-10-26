/**
 * @module rendering/pulse-layer-cache
 *
 * The base layer of a pane, kept while only the highlight pulse moves.
 *
 * In Full quality the highlights pulse: every frame of the pulse used to draw
 * the whole pane again, every point of the dataset included, to change only
 * the rings around the highlighted cells. A pane's frame is two layers in a
 * fixed order: the **base** (backdrop, grid, every point, the vector-field
 * overlay) and what is drawn over it (highlights, neighbour edges, centroids,
 * projectiles, the orbit anchor). The pulse changes only the second.
 *
 * So while highlights animate, the base is drawn into a framebuffer of this
 * module (`base`) instead of the canvas, and kept. Every frame then copies the
 * base, colour and depth, into a second framebuffer (`work`), draws the upper
 * layer there, against the base's depth exactly as it would have against the
 * canvas, and copies the colour onto the canvas. A frame that only moves the
 * pulse skips the base: its cost is the highlighted cells, two copies of the
 * pane and the small upper passes, not the dataset.
 *
 * The output is the frame drawn directly, pixel for pixel: both framebuffers
 * have the default framebuffer's colour format (RGBA8) and its depth format
 * (`DEPTH_BITS` of the drawing buffer), so every pass writes and tests the same
 * bits it would there, and a blit between framebuffers of identical formats is
 * an exact copy. A drawing buffer whose depth format this cannot match (no
 * depth, or bits other than 16 or 24) is drawn directly.
 *
 * Multisampled frames (antialiasing on, `scene-msaa-target.js`) keep no base
 * here: WebGL2 cannot copy a multisampled buffer into another one (a blit
 * into a multisampled framebuffer is an error, and there are no multisampled
 * textures), and a resolved copy would change the edges the highlights blend
 * against. They keep the scene target's own samples instead and draw again
 * only under the rings (`pulse-sample-mask.js`).
 */

/** The depth renderbuffer format matching a drawing buffer of `bits` depth bits, or 0. */
function depthFormatOf(gl, bits) {
  if (bits === 24) return gl.DEPTH_COMPONENT24;
  if (bits === 16) return gl.DEPTH_COMPONENT16;
  return 0;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {{depthBits: number}} drawingBuffer - The default framebuffer's depth
 *   bits, read once while it is bound
 */
export function createPulseLayerCache(gl, { depthBits }) {
  const depthFormat = depthFormatOf(gl, depthBits);
  let width = 0;
  let height = 0;
  let base = null;
  let work = null;
  let lost = false;

  function createTarget() {
    const framebuffer = gl.createFramebuffer();
    const color = gl.createRenderbuffer();
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, depthFormat, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteRenderbuffer(color);
      gl.deleteRenderbuffer(depth);
      throw new Error(`The pulse layer framebuffer is incomplete (status 0x${status.toString(16)}).`);
    }
    return { framebuffer, color, depth };
  }

  function deleteTarget(target) {
    if (target === null || lost) return;
    gl.deleteFramebuffer(target.framebuffer);
    gl.deleteRenderbuffer(target.color);
    gl.deleteRenderbuffer(target.depth);
  }

  function release() {
    deleteTarget(base);
    deleteTarget(work);
    base = null;
    work = null;
    width = 0;
    height = 0;
  }

  function copy(from, to, x, y, w, h, mask) {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to);
    gl.blitFramebuffer(x, y, x + w, y + h, x, y, x + w, y + h, mask, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  }

  return Object.freeze({
    /** Whether this drawing buffer's formats can be matched at all. */
    isSupported() {
      return depthFormat !== 0 && !lost;
    },

    /**
     * Have both framebuffers at the drawing buffer's size. False when they
     * cannot be (the frame is then drawn directly).
     */
    ensure(nextWidth, nextHeight) {
      if (depthFormat === 0 || lost || nextWidth <= 0 || nextHeight <= 0) return false;
      if (base !== null && width === nextWidth && height === nextHeight) return true;
      release();
      width = nextWidth;
      height = nextHeight;
      try {
        base = createTarget();
        work = createTarget();
      } catch (error) {
        release();
        console.warn('[PulseLayerCache] The pulse is drawn directly:', error);
        return false;
      }
      return true;
    },

    /** The framebuffer the base layer is drawn into. */
    baseFramebuffer() {
      return base.framebuffer;
    },

    /**
     * Copy a pane's base (colour and depth) into the work framebuffer and bind
     * it for the upper layer.
     */
    beginUpperLayer(x, y, w, h) {
      copy(base.framebuffer, work.framebuffer, x, y, w, h, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, work.framebuffer);
    },

    /** Copy a finished pane onto `target` (the scene framebuffer) and bind it. */
    present(target, x, y, w, h) {
      copy(work.framebuffer, target, x, y, w, h, gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    },

    /** Release both framebuffers (highlights stopped animating, or disposal). */
    release,

    /** After context loss every handle is gone; nothing is deleted. */
    handleContextLost() {
      lost = true;
      base = null;
      work = null;
    },
  });
}
