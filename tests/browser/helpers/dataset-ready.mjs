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
 * ended (`data-startup-phase` is `ready`, where a startup ran), the gene
 * list read (`whenGenesListed`), and the viewer at rest: its frame loop
 * settled, which holds while the opening's frame-cost measurement is armed
 * or reads a sample (`getFrameScheduleState().settled`,
 * `rendering/full-detail-frame-cost.js`), and every presented view drawn
 * from its final geometry (`isPresentedGeometrySettled`: no tree still to
 * land, no draw order still to adopt). What a spec does after it lands on a
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
  const startup = await page.evaluate(() => document.documentElement.dataset.startupPhase ?? null);
  if (startup !== null) {
    await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready', timeout === undefined ? undefined : { timeout });
  }
  await page.evaluate(() => window._cellucidState?.whenGenesListed?.());
  await expect.poll(() => page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const schedule = viewer.getFrameScheduleState();
    const onlyThePulse = schedule.animationCause === 'highlight' && !schedule.invalidated
      && !schedule.canvasResized && schedule.frameCostPhase === null;
    if (!schedule.settled && !onlyThePulse) return `drawing: ${JSON.stringify({ lastCause: schedule.lastCause, frameCostPhase: schedule.frameCostPhase, animationCause: schedule.animationCause })}`;
    if (!viewer.isPresentedGeometrySettled()) return 'a view awaits its final geometry';
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
 * Wait until the page shows every action asked of it so far: done
 * (`whenActionsDone`; the dispatcher's `idle` includes recording the step)
 * and drawn. The History panel draws a new step on a later frame, at most
 * once a frame (`ui/modules/state/index.js`), as do the controls that
 * follow a store; the History sits above every other panel of the sidebar,
 * so its new row moves each control below it. A spec that clicks again in
 * the sidebar right after a step (Save position, twice) clicks once the page
 * shows that step, or the press and the release land on either side of the
 * row (`split-clicks.mjs`; measured on macOS WebKit: a Camera Path step's row
 * one to two frames after its click returned).
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
