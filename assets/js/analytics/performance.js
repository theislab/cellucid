// Tiny performance analytics (Web Vitals-lite) that stays off the hot path.
// Uses browser PerformanceObserver APIs only when available and samples to avoid overhead.

import { trackPerformanceMetric } from './tracker.js';

function onHidden(cb) {
  let called = false;
  const handler = (event) => {
    if (called) return;
    if (event.type === 'visibilitychange' && document.visibilityState !== 'hidden') return;
    called = true;
    cb();
    document.removeEventListener('visibilitychange', handler, true);
    window.removeEventListener('pagehide', handler, true);
  };
  document.addEventListener('visibilitychange', handler, true);
  window.addEventListener('pagehide', handler, true);
}

function getNavigationType() {
  const nav = performance.getEntriesByType?.('navigation')?.[0];
  return nav?.type;
}

export function initPerformanceAnalytics({ sampleRate = 1, longTaskSampleRate = null, contextProvider } = {}) {
  if (typeof PerformanceObserver === 'undefined') return;
  if (sampleRate < 1 && Math.random() > sampleRate) return;

  const getCtx = () => (typeof contextProvider === 'function' ? contextProvider() : {});
  const navType = getNavigationType();

  // First Contentful Paint & TTFB (static entries, no observers needed)
  try {
    const paintEntries = performance.getEntriesByType?.('paint') || [];
    const fcp = paintEntries.find((e) => e.name === 'first-contentful-paint');
    if (fcp) {
      trackPerformanceMetric('FCP', fcp.startTime, { ...getCtx(), navigationType: navType });
    }
    const navEntry = performance.getEntriesByType?.('navigation')?.[0];
    if (navEntry?.responseStart != null) {
      trackPerformanceMetric('TTFB', navEntry.responseStart, { ...getCtx(), navigationType: navType });
    }
  } catch (_) {
    /* ignore */
  }

  // CLS
  let clsValue = 0;
  let clsObserver = null;
  if (PerformanceObserver.supportedEntryTypes?.includes('layout-shift')) {
    clsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          clsValue += entry.value;
        }
      }
    });
    clsObserver.observe({ type: 'layout-shift', buffered: true });
  }

  // LCP
  let lcpEntry = null;
  let lcpObserver = null;
  if (PerformanceObserver.supportedEntryTypes?.includes('largest-contentful-paint')) {
    lcpObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length) {
        lcpEntry = entries[entries.length - 1];
      }
    });
    lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
  }

  // FID
  if (PerformanceObserver.supportedEntryTypes?.includes('first-input')) {
    const fidObserver = new PerformanceObserver((list) => {
      const entry = list.getEntries()[0];
      if (!entry) return;
      const fid = entry.processingStart - entry.startTime;
      trackPerformanceMetric('FID', fid, { ...getCtx(), navigationType: navType });
      fidObserver.disconnect();
    });
    fidObserver.observe({ type: 'first-input', buffered: true });
  }

  // INP (modern responsiveness)
  let inpEntry = null;
  if (PerformanceObserver.supportedEntryTypes?.includes('event')) {
    const inpObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry || entry.duration == null) continue;
        if (!inpEntry || entry.duration > inpEntry.duration) {
          inpEntry = entry;
        }
      }
    });
    inpObserver.observe({ type: 'event', buffered: true, durationThreshold: 40 });
  }

  // Long tasks (optional sampling)
  const shouldTrackLongTasks = (longTaskSampleRate ?? sampleRate) >= 1 || Math.random() <= (longTaskSampleRate ?? sampleRate);
  let totalLongTask = 0;
  let maxLongTask = 0;
  let longTaskObserver = null;
  if (shouldTrackLongTasks && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const duration = entry.duration || 0;
        totalLongTask += duration;
        if (duration > maxLongTask) {
          maxLongTask = duration;
        }
      }
    });
    longTaskObserver.observe({ type: 'longtask', buffered: true });
  }

  const finalize = () => {
    if (lcpObserver) lcpObserver.disconnect();
    if (clsObserver) clsObserver.disconnect();
    if (longTaskObserver) longTaskObserver.disconnect();

    if (lcpEntry) {
      const value = lcpEntry.renderTime || lcpEntry.loadTime || lcpEntry.startTime;
      trackPerformanceMetric('LCP', value, { ...getCtx(), navigationType: navType });
    }
    if (clsValue) {
      trackPerformanceMetric('CLS', clsValue, { ...getCtx(), navigationType: navType });
    }
    if (inpEntry?.duration != null) {
      trackPerformanceMetric('INP', inpEntry.duration, { ...getCtx(), navigationType: navType });
    }
    if (totalLongTask > 0) {
      const ctx = { ...getCtx(), navigationType: navType };
      trackPerformanceMetric('LONGTASK_TOTAL', totalLongTask, ctx);
      trackPerformanceMetric('LONGTASK_MAX', maxLongTask, ctx);
    }
  };

  onHidden(finalize);
}
