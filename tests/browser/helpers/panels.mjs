import { expect } from './test.mjs';

/**
 * Visualization, Navigation and Compare views start collapsed. A spec that
 * drives their controls opens them first, as a user does.
 */
export const COLLAPSED_BY_DEFAULT = Object.freeze([
  'visualization-section',
  'navigation-section',
  'compare-views-section',
]);

/**
 * Opens the panels and returns once each one opened has dispatched its
 * `toggle`. That event is queued as a task, so returning right after setting
 * `open` left it pending: a listener a spec attached next (the toggle counter
 * of `panel-header-controls.spec.mjs`) could still receive it, and on macOS
 * WebKit it did, counting a toggle no control had caused.
 */
export async function openCollapsedPanels(page) {
  await page.evaluate(ids => Promise.all(ids.map(id => {
    const section = document.getElementById(id);
    if (!(section instanceof HTMLDetailsElement)) {
      throw new Error(`#${id} is not a panel`);
    }
    if (section.open) return null;
    const toggled = new Promise(resolve => {
      section.addEventListener('toggle', resolve, { once: true });
    });
    section.open = true;
    return toggled;
  })), COLLAPSED_BY_DEFAULT);
}

/**
 * Waits until `frame` floats and its lift is over. Undocking plays a lift
 * (`floating-enter`, `_accordion.css`): the frame scales up from 0.96 and its
 * card's shadow grows. A box or shadow read while it runs is neither what the
 * window settles to nor what is on the screen a moment later.
 *
 * @param {import('@playwright/test').Locator} frame
 */
export async function expectFloatingSettled(frame) {
  await expect(frame).toHaveClass(/\baccordion-floating\b/);
  await expect(frame).not.toHaveClass(/\bfloating-enter\b/);
}
