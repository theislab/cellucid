/**
 * Observing whether the viewer draws.
 *
 * The viewer draws only after something can have changed, plus a settle
 * window (`FRAME_SETTLE_MIN_FRAMES` frames, in
 * `rendering/viewer.js`). These helpers count the draw calls it issues so a
 * spec can prove a scene goes quiet, and that a mutation draws it again.
 */

// Once the viewer reports its scene settled, a whole observation window of
// this length must pass without a single draw call.
export const QUIET_WINDOW_MS = 500;

/**
 * Count draw calls over an observation window: `milliseconds` of wall-clock
 * time, or — after a mutation — the next two animation frames. The mutation
 * arms the viewer's frame callback before this helper requests its own, so
 * the viewer's runs first; two frames therefore contain the frame the
 * mutation invalidated however slowly a loaded runner produces frames.
 */
export async function countDrawsDuring(page, milliseconds, { mutate = false } = {}) {
  return countDraws(page, { duration: milliseconds, frames: null, mutate });
}

/**
 * Count draw calls over the next `frames` animation frames. Unlike a
 * wall-clock window, this observes frames however far apart a slow renderer
 * draws them.
 */
export async function countDrawsOverFrames(page, frames = 2) {
  return countDraws(page, { duration: null, frames, mutate: false });
}

/**
 * 'quiet' once the scene has settled and stays quiet; otherwise why not, so a
 * poll that times out names the cause. Use as
 * `await expect.poll(() => sceneQuietness(page)).toBe('quiet')`.
 *
 * Settled is the frame loop's own stop condition
 * (`getFrameScheduleState().settled`): nothing has started a settle window and
 * the last one has run out, frames included. A wall-clock window without a
 * draw is not proof of that: a renderer that takes longer per frame than the
 * window draws nothing in it while still owing settle frames, and those frames
 * then land in whatever the test measures next. The window that follows
 * proves the settled scene really stays undrawn.
 */
export async function sceneQuietness(page) {
  const state = await page.evaluate(
    () => window._cellucidViewer.getFrameScheduleState(),
  );
  if (!state.settled) return `settling: ${JSON.stringify(state)}`;
  const draws = await countDrawsDuring(page, QUIET_WINDOW_MS);
  return draws === 0 ? 'quiet' : `drew ${draws} times after settling`;
}

async function countDraws(page, { duration, frames, mutate }) {
  return page.evaluate(async ({ duration, frames, mutate: applyMutation }) => {
    const viewer = window._cellucidViewer;
    const gl = viewer.getGLContext();
    let draws = 0;
    const originals = {
      drawArrays: gl.drawArrays,
      drawElements: gl.drawElements,
      drawArraysInstanced: gl.drawArraysInstanced,
      drawElementsInstanced: gl.drawElementsInstanced,
    };
    for (const [name, original] of Object.entries(originals)) {
      gl[name] = function countedDraw(...args) {
        draws += 1;
        return Reflect.apply(original, this, args);
      };
    }
    try {
      if (applyMutation) viewer.setPointSize(3);
      if (applyMutation || frames !== null) {
        await new Promise(resolve => {
          let remaining = applyMutation ? 2 : frames;
          const step = () => {
            remaining -= 1;
            if (remaining <= 0) resolve();
            else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
      } else {
        await new Promise(resolve => setTimeout(resolve, duration));
      }
    } finally {
      for (const name of Object.keys(originals)) delete gl[name];
    }
    return draws;
  }, { duration, frames, mutate });
}
