/**
 * @module rendering/pulse-sample-mask
 *
 * The highlight pulse with antialiasing on: a pulse frame draws again only the
 * samples the rings cover.
 *
 * Single-sampled frames keep each pane's base layer in a framebuffer of their
 * own (`pulse-layer-cache.js`). A multisampled frame cannot: WebGL2 has no
 * multisampled texture, a blit into a multisampled framebuffer is an error, and
 * a copy of the resolved base would change every pixel where a ring edge and a
 * base edge share a pixel (the resolve averages the ring blended over each
 * sample, not over the average). What WebGL2 does keep is the scene target
 * itself (`scene-msaa-target.js`): its renderbuffer holds every sample of the
 * last frame, colour, depth and stencil, until something draws over it.
 *
 * The samples the rings cover do not depend on the pulse phase. The phase
 * (`u_time`, `u_glow` of HP_FS_HIGHLIGHT) only colours a fragment; whether a
 * fragment exists depends on the highlight records, the style, the camera and
 * the point size. So while highlights pulse in a multisampled frame, the
 * highlight pass also writes 1 into the stencil of every sample it covers
 * (`beginRingPass`; the depth test passing or not), into a stencil the pane's
 * clear set to 0. The next frame of a pane whose base and highlight records
 * are unchanged (`viewer.js`, maskedPulsePaneReady) differs from that frame
 * only at those samples, and finds them marked:
 *
 * 1. the marked samples are reset to what the frame's clear writes, colour and
 *    depth, and the stencil test is left passing only there
 *    (`beginMaskedPane`);
 * 2. the pane is drawn exactly as a whole frame draws it (backdrop, grid,
 *    points, overlays, rings, edges, centroids, projectiles, anchor);
 * 3. `endPane` checks that no pass turned the stencil test off.
 *
 * A sample outside the mark keeps the value the last frame gave it, which a
 * whole draw of this frame gives it too: no ring touches it, and nothing else
 * changed. A sample inside starts from the clear values and receives the same
 * fragments in the same order as in a whole draw. Every draw computes its
 * fragment's colour once per pixel and its depth per sample, neither of which
 * depends on which samples the stencil test lets through, so each sample ends
 * with the value a whole draw gives it, and the resolve is the whole frame's
 * resolve, pixel for pixel. The mark costs nothing (the ring pass the frame
 * draws anyway writes it); vertex work stays (every point is still
 * submitted); fragment, blending and sample work fall to the ring area.
 *
 * What this relies on, and checks:
 * - nothing in a pane's passes uses the stencil, or turns its test off
 *   between `beginMaskedPane` and `endPane` (`endPane` throws if one did, and
 *   the frame is then drawn whole);
 * - the only depth function in the scene's passes is `LEQUAL` (`viewer.js`,
 *   the point renderer), which the reset puts back after its own `ALWAYS`;
 * - the clear colour is the context's, read from its state shadow, and is
 *   written by a draw: `clear` ignores the stencil test.
 */

import { deleteProgramReleasingUse } from './gl-utils.js';
import { glStateOf } from './gl-state-shadow.js';

// One triangle over the whole viewport. Its corners are an attribute at
// location 0 backed by an array, so no engine emulates attribute 0.
const CLEAR_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
void main() {
  gl_Position = vec4(a_corner, 0.0, 1.0);
}
`;
const CORNERS = new Float32Array([-1, -1, 3, -1, -1, 3]);

const CLEAR_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 fragColor;
void main() {
  fragColor = u_color;
  // The value clear(DEPTH_BUFFER_BIT) writes (the default clear depth).
  gl_FragDepth = 1.0;
}
`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

/** Compile and link the reset program, reading no status (`prepare`). */
function startProgram(gl) {
  const vs = compile(gl, gl.VERTEX_SHADER, CLEAR_VS);
  const fs = compile(gl, gl.FRAGMENT_SHADER, CLEAR_FS);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  return { program, vs, fs };
}

/**
 * @param {WebGL2RenderingContext} gl
 */
export function createPulseSampleMask(gl) {
  const glState = glStateOf(gl);
  let program = null;
  let colorLocation = null;
  let vertexArray = null;
  let corners = null;
  let lost = false;
  // Between beginMaskedPane and endPane: the pane's draws are bounded by the
  // mark.
  let paneActive = false;
  // The reset program `prepare` started, linked on first use.
  let started = null;
  const parallelCompile = gl.getExtension('KHR_parallel_shader_compile');

  function ensureProgram() {
    if (program !== null) return;
    const { program: candidate, vs, fs } = started ?? startProgram(gl);
    started = null;
    const linked = gl.getProgramParameter(candidate, gl.LINK_STATUS) === true;
    const log = linked ? '' : `${gl.getProgramInfoLog(candidate)} ${gl.getShaderInfoLog(fs)}`;
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!linked) {
      deleteProgramReleasingUse(gl, candidate);
      throw new Error(`The pulse sample reset program did not link: ${log}`);
    }
    program = candidate;
    colorLocation = gl.getUniformLocation(program, 'u_color');
    vertexArray = gl.createVertexArray();
    corners = gl.createBuffer();
    const arrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    const boundVertexArray = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, CORNERS, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(boundVertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, arrayBuffer);
  }

  function stopBounding() {
    paneActive = false;
    gl.disable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
  }

  return Object.freeze({
    /**
     * Start compiling the reset program, so the first pane drawn over its
     * kept samples only reads its status (a program compiled at first use
     * holds that frame for the whole compile: about 100 ms).
     */
    prepare() {
      if (lost || program !== null || started !== null) return;
      started = startProgram(gl);
    },

    /**
     * Whether a pane can be drawn over its kept samples without waiting for
     * the reset program: linked, or (with KHR_parallel_shader_compile) done
     * compiling. Until then panes are drawn whole, which needs no program.
     * Without the extension a status cannot be read without waiting, and the
     * first use waits.
     */
    isReady() {
      if (lost) return false;
      if (program !== null || started === null || parallelCompile === null) return true;
      return gl.getProgramParameter(started.program, parallelCompile.COMPLETION_STATUS_KHR) === true;
    },

    /**
     * Set up the highlight pass of a pane. In a whole frame (`masked`
     * false) it writes 1 into the stencil of every sample it covers, the
     * depth test passing or not; in a masked pane the stencil already holds
     * exactly that and the test stays `EQUAL 1`.
     */
    beginRingPass(masked) {
      if (masked) return;
      gl.enable(gl.STENCIL_TEST);
      gl.stencilMask(0xff);
      gl.stencilFunc(gl.ALWAYS, 1, 0xff);
      gl.stencilOp(gl.KEEP, gl.REPLACE, gl.REPLACE);
    },

    /** End the highlight pass `beginRingPass` set up. */
    endRingPass(masked) {
      if (masked) return;
      gl.disable(gl.STENCIL_TEST);
    },

    /**
     * Start a pane over its kept samples: reset the marked ones to the
     * frame's clear values (colour from the context, depth 1) and leave the
     * stencil test passing only there. `width`/`height` are the drawing
     * buffer's: points may be rasterised outside their pane's viewport
     * wherever no scissor bounds them, so the reset covers the whole buffer
     * and the scissor (in a grid) bounds it.
     */
    beginMaskedPane(width, height) {
      if (lost) throw new Error('The pulse sample mask belongs to a lost context.');
      ensureProgram();
      const clearColor = glState.clearColor;
      const viewport = glState.viewport;
      const colorMask = glState.colorMask;
      const blend = glState.isEnabled(gl.BLEND);
      const depthTest = glState.isEnabled(gl.DEPTH_TEST);
      const depthMask = glState.depthMask;
      paneActive = true;
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl.EQUAL, 1, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      gl.stencilMask(0);
      gl.colorMask(true, true, true, true);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.ALWAYS);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.useProgram(program);
      gl.uniform4f(colorLocation, clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
      const boundVertexArray = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
      gl.bindVertexArray(vertexArray);
      gl.viewport(0, 0, width, height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
      gl.bindVertexArray(boundVertexArray);
      gl.useProgram(null);
      // The state the pane's passes find in a whole frame.
      gl.colorMask(colorMask[0], colorMask[1], colorMask[2], colorMask[3]);
      if (blend) gl.enable(gl.BLEND);
      if (!depthTest) gl.disable(gl.DEPTH_TEST);
      gl.depthMask(depthMask);
      gl.depthFunc(gl.LEQUAL);
    },

    /**
     * End a masked pane. Throws when a pass turned the stencil test off: the
     * draws after it reached samples outside the mark, so the pane is not the
     * whole frame and the caller must draw the frame whole.
     */
    endPane() {
      if (!paneActive) return;
      const intact = glState.isEnabled(gl.STENCIL_TEST);
      stopBounding();
      if (!intact) {
        throw new Error('A pass turned the stencil test off inside a pulse pane drawn over its kept samples.');
      }
    },

    /** Stop bounding draws by the mark without checking (a failed pane). */
    abandonPane() {
      if (paneActive) stopBounding();
    },

    handleContextLost() {
      lost = true;
      program = null;
      started = null;
      vertexArray = null;
      corners = null;
      paneActive = false;
    },

    dispose() {
      if (!lost) {
        if (started !== null) {
          gl.deleteShader(started.vs);
          gl.deleteShader(started.fs);
          deleteProgramReleasingUse(gl, started.program);
        }
        if (program !== null) deleteProgramReleasingUse(gl, program);
        if (vertexArray !== null) gl.deleteVertexArray(vertexArray);
        if (corners !== null) gl.deleteBuffer(corners);
      }
      program = null;
      started = null;
      vertexArray = null;
      corners = null;
    },
  });
}
