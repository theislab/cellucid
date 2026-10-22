/**
 * The expanded analysis view opens at one layout, whatever its open transition
 * is doing.
 *
 * The card opens with `transform: scale(0.96)` easing to `scale(1)`. Opening
 * anchored it at its centred position by reading `getBoundingClientRect()` in
 * a 200 ms timer, and placed the panel-resizer corner from rectangles read in
 * a 250 ms timer. A client rectangle is the transformed box, so whenever the
 * transition had not finished by then — a slow frame, a busy machine — the
 * card was anchored off centre and the corner landed off the resizer crossing,
 * by a different amount on every open. Screenshots of the same view differed
 * run to run.
 *
 * The spec makes the transition long enough that a timer cannot outwait it,
 * observes the transition start in the task that opens the view (never after a
 * sleep: whether a transition is still running after so many milliseconds of
 * wall clock depends on the runner), waits for the transition itself to finish
 * (a wait on the clock is not its end either), and checks the settled geometry
 * against the layout it must equal.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { settleStyleTransitions } from './helpers/style-transitions.mjs';

const DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}`
  + '&dataset=current-ui-prepared&acceptance=analysis-modal-geometry-ci';

const OPEN_TRANSITION_MS = 1200;

test('an expanded analysis view settles centred with its resizer corner on the crossing', async ({
  page,
}) => {
  const productErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') productErrors.push(message.text());
  });
  page.on('pageerror', error => productErrors.push(error.message));

  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
  await page.addStyleTag({
    content: '.analysis-modal-content { transition-duration: '
      + `${OPEN_TRANSITION_MS}ms !important; }`,
  });

  // Open, and observe the open transition start. `getAnimations()` flushes
  // the style change that starts it, so it is read in the same task as the
  // open: nothing on the clock decides whether it is seen. (A read after a
  // fixed sleep was a race: where the page stalled for longer than the
  // transition, it had already ended and nothing was running.) The
  // `transitionrun` event, listened for before the open, records the start
  // even if the transition has ended by the time it is read.
  const opened = await page.evaluate(async () => {
    const { createAnalysisModal, openModal } =
      await import('/assets/js/app/analysis/ui/components/modal.js');
    const modal = createAnalysisModal();
    window.__geometryModal = modal;
    const content = modal.querySelector('.analysis-modal-content');
    const started = [];
    content.addEventListener('transitionrun', event => {
      if (event.target === content) started.push(event.propertyName);
    });
    openModal(modal);
    const running = content.getAnimations()
      .filter(animation => animation.transitionProperty === 'transform')
      .map(animation => animation.playState);
    // Transition events are dispatched with the next animation frames.
    for (let frame = 0; frame < 600 && !started.includes('transform'); frame++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return { running, started };
  });
  // Opening anchored the card while its transform was still in flight.
  expect(opened.running).toEqual(['running']);
  expect(opened.started).toContain('transform');
  // Then wait for the transition itself rather than a longer timer.
  await settleStyleTransitions(page);

  const geometry = await page.evaluate(async () => {
    const { closeModal } =
      await import('/assets/js/app/analysis/ui/components/modal.js');
    const modal = window.__geometryModal;
    delete window.__geometryModal;
    const content = modal.querySelector('.analysis-modal-content');
    await new Promise(resolve => requestAnimationFrame(() => resolve()));

    const centre = rect => ({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    const modalRect = modal.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const result = {
      transform: getComputedStyle(content).transform,
      left: contentRect.left - modalRect.left,
      top: contentRect.top - modalRect.top,
      centredLeft: (modal.clientWidth - content.offsetWidth) / 2,
      centredTop: (modal.clientHeight - content.offsetHeight) / 2,
      corner: centre(
        modal.querySelector('.analysis-modal-resizer-intersection')
          .getBoundingClientRect(),
      ),
      crossing: {
        x: centre(
          modal.querySelector('.analysis-modal-resizer-vertical')
            .getBoundingClientRect(),
        ).x,
        y: centre(
          modal.querySelector('.analysis-modal-resizer-horizontal')
            .getBoundingClientRect(),
        ).y,
      },
    };
    await closeModal(modal);
    return result;
  });

  // The transition has finished, so client rectangles are layout boxes now.
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(geometry.transform);
  // Layout offsets are whole pixels, so the anchor is within half a pixel of
  // the centred position; a rectangle read mid-transition was several off.
  expect(Math.abs(geometry.left - geometry.centredLeft)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(geometry.top - geometry.centredTop)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(geometry.corner.x - geometry.crossing.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.corner.y - geometry.crossing.y)).toBeLessThanOrEqual(1);
  expect(productErrors).toEqual([]);
});
