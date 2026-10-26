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
  return countDraws(page, { duration: milliseconds, mutate });
}

/**
 * Count the viewer's draw calls from now on, across polls: `count()` reads
 * the total so far, `stop()` stops counting.
 *
 * A pulse paced to a slow renderer (`rendering/ambient-frame-pacing.js`)
 * draws one frame and then leaves the main thread free for as long, so a
 * window of a few animation frames falls between two pulse frames, and on
 * the Linux CI runners it did every time: an observation that starts after
 * a pulse frame is already in its wait. Polling a running count sees every
 * frame the pulse draws, however far apart.
 */
export async function watchDraws(page) {
  await page.evaluate(() => {
    if (window.__drawWatch !== undefined) throw new Error('Draws are already watched.');
    const gl = window._cellucidViewer.getGLContext();
    const watch = window.__drawWatch = { count: 0, names: [] };
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const original = gl[name];
      watch.names.push(name);
      gl[name] = function watchedDraw(...args) {
        watch.count += 1;
        return Reflect.apply(original, this, args);
      };
    }
  });
  return Object.freeze({
    count: () => page.evaluate(() => window.__drawWatch.count),
    stop: () => page.evaluate(() => {
      const gl = window._cellucidViewer.getGLContext();
      for (const name of window.__drawWatch.names) delete gl[name];
      delete window.__drawWatch;
    }),
  });
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

async function countDraws(page, { duration, mutate }) {
  return page.evaluate(async ({ duration, mutate: applyMutation }) => {
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
      if (applyMutation) {
        await new Promise(resolve => {
          let remaining = 2;
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
  }, { duration, mutate });
}
