/**
 * What a frame submits to the GPU, recorded in the page.
 *
 * Two frames are the same picture when the same draws ran with the same
 * inputs. A spec that compares the pixels of two ways of drawing one scene
 * (one store or many segments, cells added in place or opened directly)
 * asserts those inputs first: the bytes of the stores, the cameras, and, with
 * this recorder, every draw call of the frame it read: its program, mode,
 * vertex count, viewport, whether it rasterizes, and the value of every
 * uniform of its program at the call. Calls that follow one another under
 * the same state count as one of their summed count, so a store drawn one
 * call a segment submits what a store drawn in one call does.
 *
 * Why it is asserted and not left to the pixels:
 *
 * - The frame a spec reads has to be the same kind of frame on both sides.
 *   On hosted Windows Firefox two pixels of `segmented-point-stores` differed
 *   (nightly run 42180511574), and the draws attached to that failure were not
 *   the same on both sides: one frame was the first drawn after the level
 *   changed (it also ran the highlight renderer's transform-feedback pass,
 *   which writes the highlight words of the new level), the other a later
 *   pulse frame without it. Four animation frames after a change had stood
 *   for "a pulse frame has been drawn", which holds where frames are fast:
 *   the pulse is paced by the measured frame cost (`ambient-frame-pacing.js`),
 *   so on a slow renderer the first frame after a change is still the last
 *   one drawn. `steadyPulseFrame` waits for the frame loop to repeat itself.
 * - Where a renderer does not draw equal inputs to equal pixels (hosted macOS
 *   Firefox, `hosted-gl.mjs`), equal submissions are what a spec still proves
 *   exactly.
 *
 * Not recorded: the contents of textures and where a texture keeps its
 * texels, which vertices of a store a call draws (the stores' bytes and the
 * cells drawn tell that), and GL state other than the viewport and
 * rasterizer discard. Uniforms are read back from the GPU, a round trip
 * each, so they are recorded only for the frames a spec reads: a recorder
 * that slowed every frame would change what the page does by itself (its
 * pulse, its levels of detail and its culling follow the frame cost it
 * measures).
 */

/**
 * Start recording, in the page (`page.evaluate(recordSubmissions)`): once a
 * page, before the frames a spec reads. `window.__submissions` then holds
 * `frames` (how many frames with draws were drawn since), `last` (the draws
 * of the last such frame) and `previous` (of the one before it).
 */
export function recordSubmissions() {
  if (window.__submissions !== undefined) return;
  const gl = window._cellucidViewer.getGLContext();
  const ids = new Map();
  const idOf = object => {
    if (object === null) return null;
    if (!ids.has(object)) ids.set(object, ids.size);
    return ids.get(object);
  };
  // The active uniforms of a program: name and location, each element of an array on its own.
  const uniformsByProgram = new Map();
  const uniformsOf = program => {
    let uniforms = uniformsByProgram.get(program);
    if (uniforms === undefined) {
      uniforms = [];
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      for (let index = 0; index < count; index++) {
        const info = gl.getActiveUniform(program, index);
        const base = info.name.replace(/\[0\]$/, '');
        for (let element = 0; element < info.size; element++) {
          const name = info.size > 1 ? `${base}[${element}]` : info.name;
          const location = gl.getUniformLocation(program, name);
          if (location !== null) uniforms.push([name, location]);
        }
      }
      uniforms.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
      uniformsByProgram.set(program, uniforms);
    }
    return uniforms;
  };
  const uniformValues = program => {
    const values = {};
    for (const [name, location] of uniformsOf(program)) {
      const value = gl.getUniform(program, location);
      values[name] = ArrayBuffer.isView(value) || Array.isArray(value) ? Array.from(value) : value;
    }
    return values;
  };
  const submissions = { frames: 0, last: [], previous: [], withUniforms: false };
  window.__submissions = submissions;
  let frame = [];
  const record = (mode, first, count) => {
    const program = gl.getParameter(gl.CURRENT_PROGRAM);
    frame.push({
      program: idOf(program),
      mode,
      first,
      count,
      viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
      // A transform-feedback pass that writes a store and draws no pixel.
      rasterizes: !gl.isEnabled(gl.RASTERIZER_DISCARD),
      // Each uniform is read back from the GPU process, a round trip a
      // value: only for the frames a spec reads (`withUniforms`), so the
      // recorder does not slow the frames the page measures itself by.
      uniforms: program === null || !submissions.withUniforms ? null : uniformValues(program),
    });
  };
  const drawArrays = gl.drawArrays.bind(gl);
  gl.drawArrays = (mode, first, count) => {
    record(mode, first, count);
    return drawArrays(mode, first, count);
  };
  const drawArraysInstanced = gl.drawArraysInstanced.bind(gl);
  gl.drawArraysInstanced = (mode, first, count, instances) => {
    record(mode, first, count * instances);
    return drawArraysInstanced(mode, first, count, instances);
  };
  const drawElements = gl.drawElements.bind(gl);
  gl.drawElements = (mode, count, type, offset) => {
    record(mode, offset, count);
    return drawElements(mode, count, type, offset);
  };
  const multiDraw = gl.getExtension('WEBGL_multi_draw');
  if (multiDraw !== null) {
    const multiDrawArrays = multiDraw.multiDrawArraysWEBGL.bind(multiDraw);
    multiDraw.multiDrawArraysWEBGL = (mode, firsts, firstsOffset, counts, countsOffset, drawCount) => {
      for (let index = 0; index < drawCount; index++) record(mode, firsts[firstsOffset + index], counts[countsOffset + index]);
      return multiDrawArrays(mode, firsts, firstsOffset, counts, countsOffset, drawCount);
    };
  }
  // The viewer draws a frame inside one animation-frame callback, so the
  // draws between two of this recorder's callbacks are one frame's. A reader
  // closes the frame drawn so far itself (`closeFrame`), so `last` is the
  // frame whose pixels it reads next, wherever its own callback runs among
  // the frame's.
  const closeFrame = () => {
    if (frame.length === 0) return;
    submissions.previous = submissions.last;
    submissions.last = frame;
    submissions.frames += 1;
    frame = [];
  };
  submissions.closeFrame = closeFrame;
  const tick = () => {
    closeFrame();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // The first slot of the segment a draw reads (`u_slotBase`, the point
  // shaders): it differs from one segment's call to the next by construction.
  const SEGMENT_UNIFORMS = new Set(['u_slotBase']);
  const shared = uniforms => (uniforms === null
    ? null
    : Object.fromEntries(Object.entries(uniforms).filter(([name]) => !SEGMENT_UNIFORMS.has(name))));
  const stateOf = draw => JSON.stringify([draw.program, draw.mode, draw.viewport, draw.rasterizes, shared(draw.uniforms)]);
  /**
   * A frame's draws with the calls that follow one another under the same
   * state (program, mode, viewport, rasterizing, and every uniform but the
   * segment's first slot) joined into one of their summed count: what was
   * submitted, whatever the number of calls it took. A segment's call starts
   * at the segment's own first vertex, so which vertices a call draws is not
   * told by its range: the stores' bytes and the cells drawn, which a spec
   * asserts beside this, tell that.
   */
  submissions.joined = draws => {
    const joined = [];
    let state = null;
    for (const draw of draws) {
      const next = stateOf(draw);
      if (next === state) {
        joined.at(-1).count += draw.count;
        continue;
      }
      state = next;
      joined.push({ program: draw.program, mode: draw.mode, count: draw.count, viewport: draw.viewport, rasterizes: draw.rasterizes, uniforms: shared(draw.uniforms) });
    }
    return joined;
  };
  // A frame's passes without its uniforms: what tells one kind of frame from another.
  const passesOf = draws => JSON.stringify(submissions.joined(draws).map(draw => [draw.program, draw.mode, draw.count, draw.viewport, draw.rasterizes]));
  /**
   * Wait, one animation frame at a time, until the frame loop repeats
   * itself under a highlight's pulse, and return with such a frame the last
   * one drawn, its uniforms recorded: nothing invalidated, the last two
   * frames drawn since `after` (a `frames` count read before the change)
   * of the same passes, and one more of them drawn with every uniform read.
   * The pulse draws a frame whenever one is due and its phase is pinned by
   * the spec (`setHighlightAnimationTime`), so such a frame is the scene's
   * picture, with no work of a first frame in it. Bounded by the test's own
   * timeout: frames are as slow as the renderer.
   */
  submissions.steadyPulseFrame = async after => {
    const viewer = window._cellucidViewer;
    const nextFrame = () => new Promise(resolve => { requestAnimationFrame(resolve); });
    const pulsing = () => {
      const state = viewer.getFrameScheduleState();
      if (state.animationCause !== 'highlight' && state.settled) {
        throw new Error('The scene has no highlight pulse to draw steady frames.');
      }
      return !state.invalidated && state.animationCause === 'highlight';
    };
    try {
      for (;;) {
        closeFrame();
        if (pulsing() && submissions.frames >= after + 2 && passesOf(submissions.last) === passesOf(submissions.previous)) break;
        await nextFrame();
      }
      // One more of the same, read in full.
      for (;;) {
        const steady = passesOf(submissions.last);
        const drawn = submissions.frames;
        submissions.withUniforms = true;
        while (submissions.frames === drawn) {
          await nextFrame();
          closeFrame();
        }
        if (pulsing() && submissions.last.every(draw => draw.uniforms !== null || draw.program === null) && passesOf(submissions.last) === steady) return;
      }
    } finally {
      submissions.withUniforms = false;
    }
  };
  /**
   * Record every uniform of the frames drawn while `drawing` runs (a wait
   * for a scene without a pulse to settle), then close the last frame.
   */
  submissions.recordingUniforms = async drawing => {
    submissions.withUniforms = true;
    try {
      await drawing();
    } finally {
      submissions.withUniforms = false;
    }
    closeFrame();
  };
  // Where a linear texture keeps its texels (`rendering/linear-texture.js`,
  // `u_alphaLayout` and the like): storage that held more cells before a cut
  // in place lays the same texels out in more rows. The textures themselves
  // are not recorded, so neither is their layout.
  const isTextureLayout = name => /Layout(\[\d+\])?$/.test(name);
  /**
   * The first difference between two frames' joined draws, or null: how many
   * draws each has when that differs, else the draw's index and what differs
   * in it (a uniform by name).
   */
  submissions.difference = (left, right) => {
    const a = submissions.joined(left);
    const b = submissions.joined(right);
    if (a.length !== b.length) {
      const brief = draws => draws.map(draw => [draw.program, draw.mode, draw.count, draw.rasterizes]);
      return { draws: [a.length, b.length], left: brief(a), right: brief(b) };
    }
    for (let index = 0; index < a.length; index++) {
      for (const key of ['program', 'mode', 'count', 'rasterizes', 'viewport']) {
        if (JSON.stringify(a[index][key]) !== JSON.stringify(b[index][key])) return { draw: index, [key]: [a[index][key], b[index][key]] };
      }
      if (a[index].uniforms === null || b[index].uniforms === null) return { draw: index, uniforms: 'not recorded for this frame' };
      const names = new Set([...Object.keys(a[index].uniforms), ...Object.keys(b[index].uniforms)]);
      for (const name of names) {
        if (isTextureLayout(name)) continue;
        if (JSON.stringify(a[index].uniforms[name]) !== JSON.stringify(b[index].uniforms[name])) {
          return { draw: index, uniform: name, values: [a[index].uniforms[name], b[index].uniforms[name]] };
        }
      }
    }
    return null;
  };
}
