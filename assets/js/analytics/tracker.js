// Lightweight Google Analytics helpers to track dataset loads and UI interactions
// without impacting rendering performance.

const ANALYTICS_ID_MAX = 60;
const BUTTON_SELECTOR = 'button, [role="button"], a, input[type="button"], input[type="submit"]';

export const DATA_LOAD_METHODS = {
  DEFAULT_DEMO: 'default-demo',
  SERVER_AUTO: 'server-auto',
  DATASET_DROPDOWN: 'dataset-dropdown',
  DATASET_URL_PARAM: 'dataset-url-param',
  SAMPLE_DEMO: 'sample-demo',
  LOCAL_PREPARED: 'local-user-prepared',
  LOCAL_H5AD: 'local-user-h5ad',
  LOCAL_ZARR_DIRECTORY: 'local-user-zarr-directory',
  LOCAL_ZARR_ZIP: 'local-user-zarr-zip',
  REMOTE_URL_PARAM: 'remote-url-param',
  REMOTE_CONNECT: 'remote-connect',
  GITHUB_URL_PARAM: 'github-url-param',
  GITHUB_CONNECT: 'github-connect',
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

let buttonTrackingAttached = false;
const loadSessions = new Map();

const clampString = (value, maxLen = 120) => {
  if (value === undefined || value === null) return undefined;
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
};

function isAnalyticsEnabled() {
  return (
    typeof window !== 'undefined' &&
    window.cellucidAnalyticsEnabled === true
  );
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

function sendEvent(name, params = {}) {
  if (!name) return;
  if (!isAnalyticsEnabled()) return;
  if (typeof window.gtag !== 'function') {
    throw new Error(
      'Analytics is enabled but the production bootstrap is incomplete'
    );
  }

  // Drop empty/undefined values to keep payload lean
  const cleaned = {};
  for (const [key, val] of Object.entries(params)) {
    if (val === undefined || val === null || val === '') continue;
    cleaned[key] = val;
  }
  cleaned.transport_type = cleaned.transport_type || 'beacon';

  window.gtag('event', name, cleaned);
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
    control_id: clampString(controlId, ANALYTICS_ID_MAX),
    control_type: clampString(meta.controlType, 32),
    click_type: clampString(meta.clickType, 16),
    pointer_type: clampString(meta.pointerType, 16),
    dataset_id: clampString(meta.datasetId, 120),
    modifiers: clampString(meta.modifiers, 40)
  });
}

export function trackDataLoadMethod(method, context = {}) {
  if (!method) return;
  const payload = {
    load_method: clampString(method, 64),
    ...buildDatasetStatsPayload(context),
    duration_ms: safeNumber(context.durationMs),
    error_code: clampString(context.errorCode, 80),
    http_status: safeNumber(context.httpStatus),
    failure_reason: clampString(context.failureReason, 160)
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

function buildDatasetStatsPayload(context = {}) {
  const stats = context.metadata?.stats || {};
  const cellCount = safeNumber(stats.n_cells ?? context.cellCount);
  const geneCount = safeNumber(stats.n_genes ?? context.geneCount);
  const obsCount = safeNumber(stats.n_obs_fields ?? context.obsFieldCount);
  const edgeCount = safeNumber(stats.n_edges ?? context.edgeCount);

  return {
    source_type: clampString(context.sourceType, 64),
    dataset_id: clampString(context.datasetId || context.metadata?.id, 120),
    dataset_name: clampString(context.datasetName || context.metadata?.name, 120),
    cell_count: cellCount,
    gene_count: geneCount,
    obs_field_count: obsCount,
    edge_count: edgeCount,
    has_connectivity: stats.has_connectivity != null ? Number(!!stats.has_connectivity) : undefined,
    previous_source: clampString(context.previousSource, 64),
    previous_dataset_id: clampString(context.previousDatasetId, 120),
    reload: context.reload ? 1 : 0,
    sample_dataset: context.sourceType === 'local-demo' ? 1 : undefined
  };
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

/**
 * Discard an in-flight load session without recording success or failure.
 * Used when a newer dataset request supersedes work before it owns any result.
 *
 * @param {string} token
 */
export function cancelDataLoad(token) {
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

export function trackDatasetSelected(method, context = {}) {
  if (!method) return;
  sendEvent('dataset_selected', {
    load_method: clampString(method, 64),
    ...buildDatasetStatsPayload(context)
  });
}

function attachDatasetChangeAnalytics(dataSourceManager) {
  if (!dataSourceManager?.onDatasetChange) return;

  dataSourceManager.onDatasetChange((event) => {
    if (!event?.metadata) return;
    const meta = event.metadata;
    const method = event.loadMethod || dataSourceManager.getLastLoadMethod?.() || 'unspecified';
    trackDatasetSelected(method, {
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
      trackDatasetSelected(dataSourceManager.getLastLoadMethod?.() || DATA_LOAD_METHODS.DEFAULT_DEMO, {
        metadata,
        sourceType: dataSourceManager.getCurrentSourceType?.(),
        datasetId: dataSourceManager.getCurrentDatasetId?.()
      });
    }
  }
}
