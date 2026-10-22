/**
 * Page performance metrics, reported once per page load and never per frame.
 *
 * FCP and TTFB are read from buffered entries when this starts; LCP, CLS, INP
 * and the long-task totals accumulate in observers and are reported once,
 * when the page is first hidden (tab switch, close, navigation) - the point
 * after which the browser may never run this page's code again. INP is the
 * longest observed interaction (event entries of at least 40 ms). FID is not
 * reported: browsers retired it in favour of INP.
 *
 * @module analytics/performance
 */

import { METRIC_NAMES, NAVIGATION_TYPES } from './schema.js';
import { trackWebVital } from './tracker.js';

let started = false;

function onFirstHidden(callback) {
  let called = false;
  const handler = event => {
    if (called) return;
    if (
      event.type === 'visibilitychange' &&
      document.visibilityState !== 'hidden'
    ) {
      return;
    }
    called = true;
    document.removeEventListener('visibilitychange', handler, true);
    window.removeEventListener('pagehide', handler, true);
    callback();
  };
  document.addEventListener('visibilitychange', handler, true);
  window.addEventListener('pagehide', handler, true);
}

function observe(type, onEntries, options = {}) {
  if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return null;
  const observer = new PerformanceObserver(list => onEntries(list.getEntries()));
  observer.observe({ type, buffered: true, ...options });
  return observer;
}

/**
 * Start collecting. Called once, after startup has gone idle.
 *
 * @param {{dataSourceManager: {getCurrentSourceType: () => string|null}}} options
 */
export function initPerformanceAnalytics({ dataSourceManager }) {
  if (started) {
    throw new Error('Performance analytics was started twice.');
  }
  started = true;
  if (typeof PerformanceObserver === 'undefined') return;

  const navigation = performance.getEntriesByType?.('navigation')?.[0];
  const navigationType = NAVIGATION_TYPES.includes(navigation?.type)
    ? navigation.type
    : 'other';
  const report = (metricName, value) => {
    if (!METRIC_NAMES.includes(metricName) || !(value >= 0)) return;
    trackWebVital(metricName, value, {
      navigationType,
      sourceType: dataSourceManager.getCurrentSourceType(),
    });
  };

  const fcp = (performance.getEntriesByType?.('paint') || [])
    .find(entry => entry.name === 'first-contentful-paint');
  if (fcp) report('FCP', fcp.startTime);
  if (navigation?.responseStart > 0) report('TTFB', navigation.responseStart);

  let cls = 0;
  let lcp = null;
  let inp = null;
  let longTaskTotal = 0;
  let longTaskMax = 0;
  const observers = [
    observe('layout-shift', entries => {
      for (const entry of entries) {
        if (!entry.hadRecentInput) cls += entry.value;
      }
    }),
    observe('largest-contentful-paint', entries => {
      if (entries.length) lcp = entries[entries.length - 1];
    }),
    observe('event', entries => {
      for (const entry of entries) {
        if (entry.interactionId && (!inp || entry.duration > inp.duration)) {
          inp = entry;
        }
      }
    }, { durationThreshold: 40 }),
    observe('longtask', entries => {
      for (const entry of entries) {
        longTaskTotal += entry.duration;
        longTaskMax = Math.max(longTaskMax, entry.duration);
      }
    }),
  ].filter(Boolean);

  onFirstHidden(() => {
    for (const observer of observers) observer.disconnect();
    if (lcp) report('LCP', lcp.renderTime || lcp.loadTime || lcp.startTime);
    if (PerformanceObserver.supportedEntryTypes?.includes('layout-shift')) {
      report('CLS', cls);
    }
    if (inp) report('INP', inp.duration);
    if (longTaskTotal > 0) {
      report('LONGTASK_TOTAL', longTaskTotal);
      report('LONGTASK_MAX', longTaskMax);
    }
  });
}
