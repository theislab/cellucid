/**
 * The page's automatic level of detail and culling, observed: every report of
 * the frame-cost measurement (`viewer.onFullDetailFrameCost`) and every
 * presented-view change (`onPresentedViewStateChanged`), with the time each
 * came, from the page's start; and the Performance boxes and tip. A wait on
 * the page's verdict that times out says what the page did meanwhile, so a
 * failure on a runner names its sequence instead of only the last tip.
 */
import { expect } from './test.mjs';

/**
 * Record from the start of every document of `page`.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<() => Promise<Array<{kind: string, opening: number, verdict: string|null, culling: boolean, at: number}>>>}
 *   Reads the reports so far, each with the culling box as the page left it
 *   after the report.
 */
export async function recordFrameCost(page) {
  await page.addInitScript(() => {
    window.__frameCostLog = { reports: [], presented: [] };
    let viewer;
    // The viewer is assigned once by the application (`app/main.js`).
    Object.defineProperty(window, '_cellucidViewer', {
      configurable: true,
      get: () => viewer,
      set(value) {
        viewer = value;
        Object.defineProperty(window, '_cellucidViewer', { configurable: true, writable: true, value });
        const at = () => Math.round(performance.now());
        value.onFullDetailFrameCost(event => {
          const report = { kind: event.kind, opening: event.opening, verdict: event.verdict ?? null, culling: null, at: at() };
          window.__frameCostLog.reports.push(report);
          // The culling box once every listener has acted on the report
          // (the render controls' listener runs after this one).
          queueMicrotask(() => {
            report.culling = document.getElementById('hp-frustum-culling')?.checked === true;
          });
        });
        value.onPresentedViewStateChanged(({ reason }) => window.__frameCostLog.presented.push(`${reason}@${at()}`));
      },
    });
  });
  return () => page.evaluate(() => window.__frameCostLog.reports);
}

/** The Performance boxes and tip. */
export function performanceState(page) {
  return page.evaluate(() => ({
    lod: document.getElementById('hp-lod-enabled').checked,
    culling: document.getElementById('hp-frustum-culling').checked,
    tip: document.getElementById('hp-performance-status').textContent,
  }));
}

/**
 * Wait until the Performance boxes and tip match `expected`
 * (`toMatchObject`); on a timeout the error carries what the page reported
 * and its frame schedule.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} expected
 * @param {{timeout?: number}} [options]
 */
export async function expectPerformance(page, expected, { timeout = 60_000 } = {}) {
  try {
    await expect.poll(() => performanceState(page), { timeout }).toMatchObject(expected);
  } catch (error) {
    const log = await page.evaluate(() => ({
      ...window.__frameCostLog,
      schedule: window._cellucidViewer?.getFrameScheduleState(),
      now: Math.round(performance.now()),
    })).catch(reason => `unreadable: ${reason}`);
    error.message += `\nFrame-cost log: ${JSON.stringify(log)}`;
    throw error;
  }
}
