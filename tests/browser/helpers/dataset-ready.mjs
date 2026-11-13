/**
 * The moment a spec may name a gene of the dataset just opened.
 *
 * A dataset is shown before its gene list is read (`DataState
 * .listPublishedGenes`, right after the first view): its cells are open, but
 * a gene named through the app's internals (the data layer, an analysis
 * controller) is not found yet. The app's own surfaces wait for the list
 * (`whenGenesListed`; the analysis forms open once it is read), so a spec
 * that calls the internals waits for the same signal -- never a timeout.
 */
import { expect } from './test.mjs';

/**
 * Wait until `cells` cells are open and the gene list is read.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} cells
 * @param {{timeout?: number}} [options]
 */
export async function waitForDatasetReady(page, cells, { timeout } = {}) {
  await expect.poll(
    () => page.evaluate(() => window._cellucidState?.pointCount ?? 0),
    timeout === undefined ? undefined : { timeout },
  ).toBe(cells);
  await page.evaluate(() => window._cellucidState.whenGenesListed());
}

/**
 * Wait until the page has finished what it started by itself: startup
 * ended (`data-startup-phase` is `ready`), the gene
 * list read (`whenGenesListed`), and the viewer at rest: its frame loop
 * settled, which holds while the opening's frame-cost measurement is armed
 * or reads a sample (`getFrameScheduleState().settled`,
 * `rendering/full-detail-frame-cost.js`), and every presented view drawn
 * from its final geometry (`isPresentedGeometrySettled`: no tree still to
 * land, no draw order still to adopt), with the sidebar not sliding (the
 * panes take their final centers when it stops) and the State panel, while it
 * is open, showing the history the dataset opened with (it is drawn a frame
 * after the history starts and moves every row below it down: a click aimed
 * at a row while it moves is retried by Playwright with the row scrolled to
 * the foot of the sidebar). What a spec does after it lands on a
 * page that changes nothing by itself until something asks; a poll that
 * times out names what was still under way. A pulsing highlight (the `full`
 * quality's ring) keeps the loop drawing by itself and changes nothing else:
 * a scene that draws for the pulse alone (`animationCause` 'highlight',
 * nothing invalidated or resized, no measurement armed) is at rest too.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{timeout?: number}} [options]
 */
export async function waitForPageAtRest(page, { timeout } = {}) {
  // Every page's startup publishes its phases and ends `ready`
  // (`app/startup-phase.js`, `main.js`), but only once `main.js` has reached
  // its first network step, after the viewer exists: a page asked right after
  // `domcontentloaded` may not have published one yet. A look at the
  // attribute that skipped the wait when it was absent would read a viewer
  // not made yet.
  await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready', timeout === undefined ? undefined : { timeout });
  await page.evaluate(() => window._cellucidState?.whenGenesListed?.());
  await expect.poll(() => page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const schedule = viewer.getFrameScheduleState();
    const onlyThePulse = schedule.animationCause === 'highlight' && !schedule.invalidated
      && !schedule.canvasResized && schedule.frameCostPhase === null;
    if (!schedule.settled && !onlyThePulse) return `drawing: ${JSON.stringify({ lastCause: schedule.lastCause, frameCostPhase: schedule.frameCostPhase, animationCause: schedule.animationCause })}`;
    if (!viewer.isPresentedGeometrySettled()) return 'a view awaits its final geometry';
    // The sidebar's slide counts as shown: the area beside it, and so each
    // pane's center, is published once it has stopped
    // (`sidebar-controls.js`). Until then a view is drawn, and picked, around
    // the center it had before, so a pick at the canvas center inside the
    // slide misses a cell drawn beside it (measured: 38_decisions_testing_and_hosted_runners.md).
    if ((document.getElementById('sidebar')?.getAnimations().length ?? 0) > 0) return 'the sidebar is sliding';
    // The State panel draws its graph only while no closed section holds it (`visibility-gate.js`).
    const graph = document.getElementById('history-graph');
    const graphShown = graph !== null && graph.closest('details:not([open])') === null
      && !(document.getElementById('sidebar')?.classList.contains('hidden') ?? false);
    if (window._cellucidHistories?.current()?.active != null && graphShown && graph.hidden) return 'the State panel has not drawn the history yet';
    return 'at rest';
  }), timeout === undefined ? undefined : { timeout }).toBe('at rest');
}

/**
 * Wait until every action asked of the page so far is done: a control's
 * change is dispatched as an action and applied when those before it have
 * finished, with whatever it reads on the way (a field's values), so the
 * state it leads to is there only then (`getActions().idle()`, the
 * dispatcher's own promise). A spec that goes on through the page's
 * internals (a domain restored directly, a pick, a selection gesture) waits
 * for it first: through the interface the dispatcher keeps the order itself.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function whenActionsDone(page) {
  await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    await getActions().idle();
  });
}

/**
 * Choose the categorical field a file is colored by through the Color by
 * control, and wait until the legend it leads to is the one that stays.
 *
 * A file opens colored by its first coloring (`first-coloring.js`) before its
 * history begins, the choice is then applied as an action, and the legend is
 * built anew by each (and once more as the field's counts arrive): a list
 * read or scrolled before the last of them is a list the next draw replaces,
 * detached, so the scroll is lost (a third draw can follow the list by over
 * 100 ms; measured: 38_decisions_testing_and_hosted_runners.md). So:
 * the file's history has begun, the choice is made, and every action is done.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} datasetName - the name the opened file shows
 * @param {string} label - the field's label in the control
 */
export async function chooseCategoricalField(page, datasetName, label) {
  await page.waitForFunction(name => {
    const history = window._cellucidHistories?.current();
    return history?.dataset?.name === name && history.active != null;
  }, datasetName);
  await page.locator('#categorical-field').selectOption({ label });
  await whenActionsDone(page);
}

/**
 * Wait until the page shows every action asked of it so far: done
 * (`whenActionsDone`; the dispatcher's `idle` includes recording the step)
 * and drawn. The History panel draws a new step on a later frame, at most
 * once a frame (`ui/modules/state/index.js`), as do the controls that
 * follow a store; the History sits above every other panel of the sidebar,
 * so its new row moves each control below it. A spec that clicks again in
 * the sidebar right after a step (Save position, twice) clicks once the page
 * shows that step, or the press and the release land on either side of the
 * row (`split-clicks.mjs`); the row can come a frame or two after the click
 * returns (measured: 38_decisions_testing_and_hosted_runners.md).
 *
 * @param {import('@playwright/test').Page} page
 */
export async function whenActionsShown(page) {
  await whenActionsDone(page);
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

/**
 * Wait until the code the page imports by itself as it starts is in: the
 * analysis tools (`main.js`, `analysisCode`), hundreds of files that keep
 * arriving long after the first view on a loaded machine. The page publishes
 * `window._comparisonModule` in the continuation of that import, once every
 * file of its graph has loaded and run; nothing else is imported without
 * being asked for (a panel opened, a figure exported, a worker started).
 * No time of its own bounds the wait: the files arrive as fast as the
 * machine serves them, and the test's timeout is the fence.
 */
export async function whenStartupCodeLoaded(page) {
  await page.waitForFunction(() => window._comparisonModule !== undefined, null, { timeout: 0 });
}
