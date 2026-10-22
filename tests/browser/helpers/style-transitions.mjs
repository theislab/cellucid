/**
 * Waiting for CSS transitions and animations to finish.
 *
 * A fixed wait is not their end. A transition starts on the first frame after
 * the style change that triggers it, and where frames are seconds apart (a
 * software renderer drawing the plot on a hosted runner) a timer can run out
 * before that frame: the element is then read at its starting value.
 */

/**
 * Resolve once no finite CSS transition or animation on a rendered element is
 * still running, so computed styles and client rectangles are final rather
 * than in flight.
 *
 * `getAnimations()` flushes pending style first, which is what starts a
 * transition for a style change made just before this call. The check repeats
 * on every animation frame rather than awaiting `finished`: a transition that
 * is cancelled or superseded mid-flight is no longer running, but engines do
 * not reliably settle its `finished` promise. Elements that are not rendered
 * (inside a closed accordion) are skipped: Firefox leaves their transitions
 * pending until they are shown. Infinite animations (spinners) never settle;
 * a paused one does not move.
 */
export async function settleStyleTransitions(page) {
  await page.evaluate(async () => {
    const inFlight = () => document.getAnimations().some(animation => (
      animation.playState === 'running' &&
      Number.isFinite(animation.effect?.getComputedTiming().endTime) &&
      animation.effect?.target?.checkVisibility() === true
    ));
    while (inFlight()) {
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  });
}
