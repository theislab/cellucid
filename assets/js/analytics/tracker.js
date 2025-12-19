// Lightweight Google Analytics helpers to track dataset loads and UI interactions
// without impacting rendering performance.

const MAX_QUEUE_LENGTH = 50;
const MAX_FLUSH_ATTEMPTS = 8;
const ANALYTICS_ID_MAX = 60;
const BUTTON_SELECTOR = 'button, [role="button"], a, input[type="button"], input[type="submit"]';

export const DATA_LOAD_METHODS = {
  DEFAULT_DEMO: 'default-demo',
  DATASET_DROPDOWN: 'dataset-dropdown',
  DATASET_URL_PARAM: 'dataset-url-param',
  SAMPLE_DEMO: 'sample-demo',
  LOCAL_PREPARED: 'local-user-prepared',
  LOCAL_H5AD: 'local-user-h5ad',
  LOCAL_ZARR: 'local-user-zarr',
  REMOTE_URL_PARAM: 'remote-url-param',
  REMOTE_CONNECT: 'remote-connect',
  REMOTE_DISCONNECT_FALLBACK: 'remote-disconnect-fallback',
  GITHUB_URL_PARAM: 'github-url-param',
  GITHUB_CONNECT: 'github-connect',
  GITHUB_DISCONNECT_FALLBACK: 'github-disconnect-fallback',
  JUPYTER_AUTO: 'jupyter-auto',
  BENCHMARK_SYNTHETIC: 'benchmark-synthetic',
  STATE_RESTORE_FILE: 'state-restore-file',
  STATE_RESTORE_URL: 'state-restore-url',
  STATE_RESTORE_AUTO: 'state-restore-auto'
};

const KNOWN_BUTTON_IDS = {
  'welcome-demo-btn': 'hero:start-exploring',
  'save-state-btn': 'session:save',
  'load-state-btn': 'session:load',
  'user-data-h5ad-btn': 'data:load-h5ad',
  'user-data-zarr-btn': 'data:load-zarr',
  'user-data-browse-btn': 'data:load-prepared',
  'remote-connect-btn': 'data:remote-connect',
  'remote-disconnect-btn': 'data:remote-disconnect',
  'github-connect-btn': 'data:github-connect',
  'github-disconnect-btn': 'data:github-disconnect',
  'add-highlight-page': 'highlight:add-page',
  'clear-all-highlights': 'highlight:clear',
  'benchmark-run': 'benchmark:load-synthetic',
  'benchmark-report-btn': 'benchmark:copy-report',
  'bottleneck-analyze-btn': 'benchmark:analyze'
};

const pendingEvents = [];
let flushHandle = null;
let buttonTrackingAttached = false;
let flushAttempts = 0;
const loadSessions = new Map();

const scheduleIdle = (fn, timeout = 500) => {
  if (typeof requestIdleCallback === 'function') {
    return requestIdleCallback(() => fn(), { timeout });
  }
  return setTimeout(fn, timeout);
};

function isGtagReady() {
  return typeof window !== 'undefined' && typeof window.gtag === 'function';
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeAnalyticsId(rawId) {
  if (!rawId) return null;
  return rawId
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9:_-]/g, '')
    .slice(0, ANALYTICS_ID_MAX);
}

function scheduleFlush() {
  if (flushHandle) return;
  if (flushAttempts >= MAX_FLUSH_ATTEMPTS && !isGtagReady()) {
    pendingEvents.length = 0;
    return;
  }
  flushHandle = scheduleIdle(() => {
    flushHandle = null;
    flushAttempts += 1;
    flushPending();
  }, 400);
}

function flushPending() {
  if (!pendingEvents.length) return;
  if (!isGtagReady()) {
    scheduleFlush();
    return;
  }
  const gtag = window.gtag;
  flushAttempts = 0;
  while (pendingEvents.length) {
    const evt = pendingEvents.shift();
    gtag('event', evt.name, evt.params);
  }
}

function sendEvent(name, params = {}) {
  if (!name) return;

  // Drop empty/undefined values to keep payload lean
  const cleaned = {};
  for (const [key, val] of Object.entries(params)) {
    if (val === undefined || val === null || val === '') continue;
    cleaned[key] = val;
  }
  cleaned.transport_type = cleaned.transport_type || 'beacon';

  if (isGtagReady()) {
    window.gtag('event', name, cleaned);
    return;
  }

  if (pendingEvents.length >= MAX_QUEUE_LENGTH) {
    pendingEvents.shift();
  }
  pendingEvents.push({ name, params: cleaned });
  scheduleFlush();
}

function tagKnownButtons() {
  Object.entries(KNOWN_BUTTON_IDS).forEach(([id, analyticsId]) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (!el.dataset.analyticsId) {
      el.dataset.analyticsId = analyticsId;
    }
  });
}

function getClickType(event) {
  if (event.button === 1) return 'middle';
  if (event.button === 2) return 'secondary';
  return 'primary';
}

export function trackButtonClick(controlId, meta = {}) {
  if (!controlId) return;
  sendEvent('ui_button_click', {
    control_id: controlId,
    control_type: meta.controlType,
    click_type: meta.clickType,
    pointer_type: meta.pointerType,
    dataset_id: meta.datasetId,
    modifiers: meta.modifiers
  });
}

export function trackDataLoadMethod(method, context = {}) {
  if (!method) return;

  const stats = context.metadata?.stats || {};
  const cellCount = safeNumber(stats.n_cells ?? context.cellCount);
  const geneCount = safeNumber(stats.n_genes ?? context.geneCount);
  const obsCount = safeNumber(stats.n_obs_fields ?? context.obsFieldCount);
  const edgeCount = safeNumber(stats.n_edges ?? context.edgeCount);

  const payload = {
    load_method: method,
    source_type: context.sourceType,
    dataset_id: context.datasetId || context.metadata?.id,
    dataset_name: context.datasetName || context.metadata?.name,
    cell_count: cellCount,
    gene_count: geneCount,
    obs_field_count: obsCount,
    edge_count: edgeCount,
    duration_ms: safeNumber(context.durationMs),
    has_connectivity: stats.has_connectivity != null ? Number(!!stats.has_connectivity) : undefined,
    previous_source: context.previousSource,
    previous_dataset_id: context.previousDatasetId,
    reload: context.reload ? 1 : 0,
    sample_dataset: context.sourceType === 'local-demo' ? 1 : undefined,
    error_code: context.errorCode,
    http_status: safeNumber(context.httpStatus),
    failure_reason: context.failureReason
  };

  if (context.success !== undefined && context.success !== null) {
    payload.success = context.success ? 1 : 0;
  }

  sendEvent('data_load', payload);
}

export function beginDataLoad(method, context = {}) {
  const token = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  loadSessions.set(token, {
    method,
    start: typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(),
    context
  });
  return token;
}

function getDuration(start) {
  const end = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  return start != null ? end - start : undefined;
}

function sanitizeError(err) {
  if (!err) return { errorCode: undefined, httpStatus: undefined, failureReason: undefined };
  const httpStatus = safeNumber(err.status || err.statusCode || err.response?.status);
  const errorCode = err.code || err.name || err.type;
  const failureReason = (err.message || '').slice(0, 160) || undefined;
  return { errorCode, httpStatus, failureReason };
}

export function completeDataLoadSuccess(token, context = {}) {
  const session = loadSessions.get(token);
  const durationMs = session ? getDuration(session.start) : undefined;
  const base = session ? session.context : {};
  trackDataLoadMethod(session?.method || context.loadMethod, {
    ...base,
    ...context,
    durationMs,
    success: 1
  });
  loadSessions.delete(token);
}

export function completeDataLoadFailure(token, context = {}) {
  const session = loadSessions.get(token);
  const durationMs = session ? getDuration(session.start) : undefined;
  const base = session ? session.context : {};
  const { errorCode, httpStatus, failureReason } = sanitizeError(context.error || context);
  trackDataLoadMethod(session?.method || context.loadMethod, {
    ...base,
    ...context,
    durationMs,
    success: 0,
    errorCode: context.errorCode || errorCode,
    httpStatus: context.httpStatus || httpStatus,
    failureReason: context.failureReason || failureReason
  });
  loadSessions.delete(token);
}

export function trackPerformanceMetric(metricName, value, context = {}) {
  if (!metricName || value == null) return;
  const numericValue = safeNumber(value);
  if (numericValue === undefined) return;

  sendEvent('web_vital', {
    metric_name: metricName,
    metric_value: numericValue,
    navigation_type: context.navigationType,
    dataset_id: context.datasetId,
    source_type: context.sourceType
  });
}

function attachDatasetChangeAnalytics(dataSourceManager) {
  if (!dataSourceManager?.onDatasetChange) return;

  dataSourceManager.onDatasetChange((event) => {
    if (!event?.metadata) return;
    const meta = event.metadata;
    const method = event.loadMethod || dataSourceManager.getLastLoadMethod?.() || 'unspecified';
    trackDataLoadMethod(method, {
      metadata: meta,
      sourceType: event.sourceType,
      datasetId: event.datasetId,
      datasetName: meta.name,
      previousDatasetId: event.previousDatasetId,
      previousSource: event.previousSourceType
    });
  });
}

function setupButtonTracking({ dataSourceManager } = {}) {
  if (buttonTrackingAttached || typeof document === 'undefined') return;
  buttonTrackingAttached = true;

  document.addEventListener('click', (event) => {
    const target = event.target?.closest(BUTTON_SELECTOR);
    if (!target) return;

    const analyticsId = normalizeAnalyticsId(
      target.dataset.analyticsId
      || target.id
      || target.name
      || target.getAttribute('aria-label')
      || (target.textContent || '').slice(0, 80)
    ) || `button:${(target.tagName || 'unknown').toLowerCase()}`;
    if (!analyticsId) return;

    const datasetId = typeof dataSourceManager?.getCurrentDatasetId === 'function'
      ? dataSourceManager.getCurrentDatasetId()
      : undefined;

    trackButtonClick(analyticsId, {
      controlType: target.tagName?.toLowerCase(),
      clickType: getClickType(event),
      pointerType: event.pointerType || 'mouse',
      datasetId,
      modifiers: [
        event.altKey ? 'alt' : '',
        event.ctrlKey ? 'ctrl' : '',
        event.metaKey ? 'meta' : '',
        event.shiftKey ? 'shift' : ''
      ].filter(Boolean).join('+') || undefined
    });
  }, { capture: true, passive: true });
}

export function initAnalytics({ dataSourceManager } = {}) {
  tagKnownButtons();
  setupButtonTracking({ dataSourceManager });
  attachDatasetChangeAnalytics(dataSourceManager);

  // If a dataset is already active (e.g., loaded before analytics init), emit one snapshot.
  if (dataSourceManager?.hasActiveDataset?.()) {
    const metadata = dataSourceManager.getCurrentMetadata?.();
    if (metadata) {
      trackDataLoadMethod(dataSourceManager.getLastLoadMethod?.() || DATA_LOAD_METHODS.DEFAULT_DEMO, {
        metadata,
        sourceType: dataSourceManager.getCurrentSourceType?.(),
        datasetId: dataSourceManager.getCurrentDatasetId?.()
      });
    }
  }
}
