/**
 * A selection gesture on the plot, made once the page can take it.
 *
 * A press on the plot goes to the tool in use and is read against the frame
 * on screen. Two things decide what it does, and both take as long as the
 * machine: the tool's mode is switched by an action (a tool button's click
 * is dispatched and applied when the actions before it are done), and a
 * pick is of the frame that was drawn (while a view still opens, its camera
 * settles or a geometry lands, the cell under the pointer is not yet the
 * one that will be). A gesture made before either is read by another tool,
 * or picks nothing.
 *
 * A gesture repeated until its tool armed would, on a runner that takes
 * longer to arm, land a second time on top of the first, and the tool would
 * hold something else. So the gesture is made once, after what it depends
 * on: every action asked so far is done (`getActions().idle()`) and the page
 * is at rest (`waitForPageAtRest`). A gesture the page then does not take is
 * a defect, and fails the spec.
 */
import { waitForPageAtRest, whenActionsDone } from './dataset-ready.mjs';
import { expect } from './test.mjs';

/**
 * @param {import('@playwright/test').Page} page
 */
export async function readyForGesture(page) {
  await whenActionsDone(page);
  await waitForPageAtRest(page);
}

/**
 * Make `gesture` once the page can take it, and wait for `tool`'s step
 * controls (`annotation`, `lasso`, `proximity`, `knn`).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} tool
 * @param {() => Promise<void>} gesture
 */
export async function armSelection(page, tool, gesture) {
  await readyForGesture(page);
  await gesture();
  await expect(page.locator(`#${tool}-step-controls`)).toBeAttached();
}
