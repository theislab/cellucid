/**
 * Google Analytics delivery for Cellucid.
 *
 * Every event is built from coarse descriptors, validated against
 * `analytics/schema.js`, and only then handed to `gtag`. Validation runs on
 * every host, so a malformed event is caught in development and tests even
 * though nothing is sent there; on a production host an invalid event is
 * dropped whole, never trimmed into something half-true.
 *
 * Application code reaches this module only through `app/optional-analytics.js`,
 * which loads it with a dynamic import and keeps the application independent
 * of whether a privacy blocker lets it load.
 *
 * @module analytics/tracker
 */

import {
  FEATURES,
  SOURCE_TYPES,
  countBucket,
  describeError,
  dimensionsDescriptor,
  embeddingCandidateBucket,
  durationBucket,
  metricRating,
  validateEvent,
  validateUserProperties,
} from './schema.js';
import { DATA_CONFIG } from '../data/data-source.js';
import {
  SOFTWARE_RASTERIZER_MARKERS,
} from '../app/ui/modules/benchmark/renderer-identity.js';
import { detectSmokeSupport } from '../rendering/smoke-cloud/smoke-capabilities.js';

const SAMPLE_CATALOG_META_SELECTOR = 'meta[name="cellucid-sample-catalog"]';

let initialized = false;
let publicSampleCatalog = false;
let smokeSupported = null;
let appReadyReported = false;
let startupFailureReported = false;
const reportedFeatures = new Set();

function analyticsEnabled() {
  return (
    typeof window !== 'undefined' &&
    window.cellucidAnalyticsEnabled === true
  );
}

/**
 * A schema violation is a defect in Cellucid, not in the user's data. In
 * production the event is dropped; everywhere else the violation is raised as
 * an uncaught error so tests and development see it, without throwing into
 * the application code that asked for the event.
 */
function reportViolation(error) {
  if (analyticsEnabled()) {
    console.warn('[Cellucid] Dropped an invalid analytics event:', error.message);
    return;
  }
  if (typeof globalThis.reportError === 'function') {
    globalThis.reportError(error);
    return;
  }
  queueMicrotask(() => {
    throw error;
  });
}

function deliver(command, name, payload) {
  if (!analyticsEnabled()) return;
  if (typeof window.gtag !== 'function') {
    console.error('[Cellucid] Analytics is enabled but gtag is missing.');
    return;
  }
  if (command === 'event') window.gtag('event', name, payload);
  else window.gtag('set', 'user_properties', payload);
}

function send(name, params) {
  let payload;
  try {
    payload = validateEvent(name, params);
  } catch (error) {
    reportViolation(error);
    return;
  }
  deliver('event', name, payload);
}

function setUserProperties(properties) {
  let payload;
  try {
    payload = validateUserProperties(properties);
  } catch (error) {
    reportViolation(error);
    return;
  }
  deliver('set', null, payload);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// --------------------------------------------------------------------------
// Environment
// --------------------------------------------------------------------------

function inputClass() {
  const media = query => (
    typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  );
  const fine = media('(any-pointer: fine)');
  const coarse = media('(any-pointer: coarse)');
  if (fine && coarse) return 'hybrid';
  if (coarse) return 'touch';
  return 'mouse';
}

function viewportClass() {
  const width = window.innerWidth;
  if (width < 600) return 'phone';
  if (width < 1024) return 'tablet';
  if (width < 1920) return 'desktop';
  return 'wide';
}

/**
 * Only whether WebGL runs on a CPU rasterizer. The renderer string is a
 * fingerprinting surface: it is classified here and never leaves this
 * function. Chromium masks `RENDERER` as "WebKit WebGL", so the debug
 * extension is consulted only then; Firefox already reports a sanitized
 * renderer and is never asked for the extension, which it is retiring.
 */
function rendererClass(gl) {
  if (gl === null || typeof gl?.getParameter !== 'function') return 'unknown';
  try {
    let text = `${gl.getParameter(gl.RENDERER)} ${gl.getParameter(gl.VENDOR)}`;
    if (/^webkit webgl\b/i.test(text)) {
      const debugInfo = gl.getExtension?.('WEBGL_debug_renderer_info') ?? null;
      if (debugInfo === null) return 'unknown';
      text = `${gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)} ` +
        `${gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)}`;
    }
    const lower = text.toLowerCase();
    return SOFTWARE_RASTERIZER_MARKERS.some(marker => lower.includes(marker))
      ? 'software'
      : 'hardware';
  } catch {
    return 'unknown';
  }
}

/**
 * Whether a dataset id is public: only the sample catalog the deployment
 * itself declares. A catalog chosen with `?sampleCatalog=` can be anyone's.
 */
function readPublicSampleCatalog() {
  const metas = document.querySelectorAll(SAMPLE_CATALOG_META_SELECTOR);
  return (
    metas.length === 1 &&
    typeof DATA_CONFIG.SAMPLE_CATALOG_URL === 'string' &&
    DATA_CONFIG.SAMPLE_CATALOG_URL === metas[0].getAttribute('content')
  );
}

// --------------------------------------------------------------------------
// Feature adoption
// --------------------------------------------------------------------------

/**
 * Developer-declared controls, by element id, mapped to `[feature, variant]`.
 * A control is identified only by an id or attribute a developer wrote; its
 * label, value or text is never read, because those carry dataset content.
 */
const CLICK_CONTROLS = Object.freeze({
  'save-state-btn': ['session_save'],
  'load-state-btn': ['session_load'],
  'figure-export-btn': ['figure_export'],
  'add-highlight-page': ['highlight_page', 'add'],
  'select-bar-confirm': ['highlight_selection'],
  'split-keep-view-btn': ['multiview', 'keep_view'],
  'cinematic-save-btn': ['camera_path'],
  'benchmark-run': ['benchmark'],
  'highlight-mode-lasso': ['highlight_tool', 'lasso'],
  'highlight-mode-proximity': ['highlight_tool', 'proximity'],
  'highlight-mode-knn': ['highlight_tool', 'knn'],
  'highlight-mode-annotation': ['highlight_tool', 'annotation'],
  'analysis-header-simple': ['analysis', 'simple'],
  'analysis-header-detailed': ['analysis', 'detailed'],
  'analysis-header-correlation': ['analysis', 'correlation'],
  'analysis-header-differential': ['analysis', 'differential'],
  'analysis-header-signature': ['analysis', 'signature'],
  'analysis-header-genesPanel': ['analysis', 'genes_panel'],
  'gene-expression-dropdown': ['color_by_gene'],
});

/** `data-analytics-id` values declared on generated controls. */
const DECLARED_CONTROLS = Object.freeze({
  'data-mapping:default': ['data_mapping', 'default'],
  'data-mapping:add-columns': ['data_mapping', 'embedding_columns'],
  'legend:toggle-category': ['filter', 'category'],
  'legend:highlight-category': ['legend_highlight'],
  'highlight:delete-page': ['highlight_page', 'delete'],
});

/** `data-community-annotation-action` values. */
const ANNOTATION_ACTIONS = Object.freeze({
  'github-connection': ['community_annotation', 'github_connection'],
});

/**
 * Controls counted on `change`. A select's variant comes from its option
 * value only where those values are a fixed developer vocabulary; field
 * selects carry dataset field names and are never read.
 */
const CHANGE_CONTROLS = Object.freeze({
  'categorical-field': () => ['color_by_category'],
  'continuous-field': () => ['color_by_continuous'],
  'outlier-filter': () => ['filter', 'outlier'],
  'toggle-connectivity': el => (el.checked ? ['connectivity'] : null),
  'velocity-overlay-enabled': el => (el.checked ? ['vector_field'] : null),
  'render-mode': el => {
    if (el.value === 'points') return ['render_mode', 'points'];
    if (el.value !== 'smoke') return null;
    return ['render_mode', smokeSupported === false ? 'smoke_unsupported' : 'smoke'];
  },
  'view-layout-mode': el => (
    el.value === 'grid' || el.value === 'single'
      ? ['multiview', `layout_${el.value}`]
      : null
  ),
  'navigation-mode': el => (
    FEATURES.navigation_mode.includes(el.value)
      ? ['navigation_mode', el.value]
      : null
  ),
  // The representation picker: which dimension a view was switched to (its
  // option group); the option value is a dataset key and is never read.
  'view-representation-select': el => {
    const dimension = el.selectedOptions?.[0]?.parentElement?.label?.[0];
    return FEATURES.dimension.includes(dimension) ? ['dimension', dimension] : null;
  },
});

/**
 * `data-analytics-id` values declared on generated selects, counted on
 * `change` (their option values are dataset keys and are never read).
 */
const DECLARED_CHANGE_CONTROLS = Object.freeze({
  'data-mapping:embedding': ['data_mapping', 'embedding'],
  'data-mapping:embedding-columns': ['data_mapping', 'embedding_columns'],
  'data-mapping:knn': ['data_mapping', 'knn'],
  'data-mapping:gene-names': ['data_mapping', 'gene_names'],
  'data-mapping:expression': ['data_mapping', 'expression'],
  'data-mapping:latent': ['data_mapping', 'latent'],
  'data-mapping:vector-fields': ['data_mapping', 'vector_fields'],
});


const MAX_ANCESTOR_DEPTH = 8;

function resolveClick(target) {
  let element = target;
  for (let depth = 0; element && depth < MAX_ANCESTOR_DEPTH; depth++) {
    const declared = element.dataset?.analyticsId;
    if (declared !== undefined) {
      return Object.hasOwn(DECLARED_CONTROLS, declared)
        ? DECLARED_CONTROLS[declared]
        : null;
    }
    const action = element.dataset?.communityAnnotationAction;
    if (action !== undefined) {
      return Object.hasOwn(ANNOTATION_ACTIONS, action)
        ? ANNOTATION_ACTIONS[action]
        : null;
    }
    if (element.id && Object.hasOwn(CLICK_CONTROLS, element.id)) {
      return CLICK_CONTROLS[element.id];
    }
    element = element.parentElement;
  }
  return null;
}

function recordFeature(resolved) {
  if (resolved === null) return;
  const [feature, variant] = resolved;
  const key = `${feature}:${variant ?? ''}`;
  if (reportedFeatures.has(key)) return;
  reportedFeatures.add(key);
  send('feature_used', { feature, variant });
}

function attachFeatureListeners() {
  // Only user-initiated events count: the application dispatches synthetic
  // `change` events while it restores state, and those are not adoption.
  document.addEventListener('click', event => {
    if (!event.isTrusted) return;
    recordFeature(resolveClick(event.target));
  }, { capture: true, passive: true });
  document.addEventListener('change', event => {
    if (!event.isTrusted) return;
    const target = event.target;
    const declared = target?.dataset?.analyticsId;
    if (declared !== undefined && Object.hasOwn(DECLARED_CHANGE_CONTROLS, declared)) {
      recordFeature(DECLARED_CHANGE_CONTROLS[declared]);
      return;
    }
    if (!target?.id || !Object.hasOwn(CHANGE_CONTROLS, target.id)) return;
    recordFeature(CHANGE_CONTROLS[target.id](target));
  }, { capture: true, passive: true });
}

// --------------------------------------------------------------------------
// Entry points
// --------------------------------------------------------------------------

/**
 * Start analytics for this page: environment user properties and feature
 * listeners. Called once.
 */
export function initAnalytics() {
  if (initialized) {
    throw new Error('Cellucid analytics was initialized twice.');
  }
  initialized = true;
  publicSampleCatalog = readPublicSampleCatalog();
  setUserProperties({
    input_class: inputClass(),
    viewport_class: viewportClass(),
  });
  attachFeatureListeners();
}

function probeSmokeSupport(gl) {
  if (gl === null || typeof gl?.getExtension !== 'function') return false;
  try {
    return detectSmokeSupport(gl).supported === true;
  } catch {
    return false;
  }
}

/**
 * Report the viewer running for the first time.
 *
 * The device classes are probed only where they are sent, and with the pure
 * capability check rather than the viewer's own: the viewer detects smoke
 * support when smoke is first chosen, and analytics must observe the
 * application, never move its work earlier.
 *
 * @param {{viewer: Object, hasDataset: boolean}} options
 */
export function trackAppReady({ viewer, hasDataset }) {
  if (appReadyReported) return;
  appReadyReported = true;
  if (analyticsEnabled()) {
    const gl = viewer.getGLContext();
    smokeSupported = probeSmokeSupport(gl);
    setUserProperties({
      renderer_class: rendererClass(gl),
      smoke_supported: smokeSupported ? 'yes' : 'no',
    });
  }
  const startupMs = Math.round(performance.now());
  send('app_ready', {
    startup_ms: startupMs,
    startup_bucket: durationBucket(startupMs),
    has_dataset: hasDataset ? 1 : 0,
  });
}

/**
 * The source the page URL asked for. Only the presence of a parameter is
 * read, never its value, except `source`, which must be a declared type.
 */
function requestedSourceType() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('remote')) return 'remote';
  if (params.has('data')) return 'link';
  const source = params.get('source');
  return source !== null && SOURCE_TYPES.includes(source)
    ? source
    : 'local-demo';
}

/**
 * Report the terminal startup failure.
 *
 * @param {{phase: string|null, error: unknown}} options
 */
export function trackStartupFailure({ phase, error }) {
  if (startupFailureReported) return;
  startupFailureReported = true;
  send('startup_failure', {
    startup_phase: phase === null ? 'boot' : phase,
    source_type: requestedSourceType(),
    ...describeError(error),
  });
}

const STATE_RESTORES = Object.freeze({
  ready: 'none',
  'ready-state-restored': 'restored',
  'ready-state-error': 'failed',
  'ready-state-canceled': 'canceled',
  'ready-state-replaced': 'replaced',
});

/**
 * Report one dataset request's outcome.
 *
 * @param {{
 *   loadMethod: string,
 *   sourceType: string,
 *   outcome: 'success'|'failure',
 *   durationMs: number,
 *   datasetId?: string|null,
 *   metadata?: Object|null,
 *   stateStatus?: string,
 *   mapping?: {origin: 'default'|'best_guess', embeddingCandidates: number, enabledRepresentations: number, vectorFields: number}|null,
 *   error?: unknown
 * }} load
 */
export function trackDataLoad(load) {
  const metadata = load.metadata ?? null;
  const stats = metadata?.stats ?? null;
  const durationMs = Math.max(0, Math.round(load.durationMs));
  send('data_load', {
    load_method: load.loadMethod,
    source_type: load.sourceType,
    outcome: load.outcome,
    duration_ms: durationMs,
    duration_bucket: durationBucket(durationMs),
    dataset_id:
      load.sourceType === 'local-demo' &&
      publicSampleCatalog &&
      typeof load.datasetId === 'string'
        ? load.datasetId
        : undefined,
    cell_bucket: isCount(stats?.n_cells) ? countBucket(stats.n_cells) : undefined,
    gene_bucket: isCount(stats?.n_genes) ? countBucket(stats.n_genes) : undefined,
    field_count: isCount(stats?.n_obs_fields) ? stats.n_obs_fields : undefined,
    dimensions: dimensionsDescriptor(
      metadata?.embeddings?.defaults
    ),
    has_connectivity: typeof stats?.has_connectivity === 'boolean'
      ? Number(stats.has_connectivity)
      : undefined,
    has_vector_field: metadata === null
      ? undefined
      : Number((load.mapping?.vectorFields ?? 0) > 0),
    state_restore: load.outcome === 'success'
      ? STATE_RESTORES[load.stateStatus]
      : undefined,
    mapping_origin: load.outcome === 'success' && load.mapping
      ? load.mapping.origin
      : undefined,
    embedding_candidates: load.outcome === 'success' && load.mapping
      ? embeddingCandidateBucket(load.mapping.embeddingCandidates)
      : undefined,
    enabled_representations: load.outcome === 'success' && load.mapping
      ? embeddingCandidateBucket(load.mapping.enabledRepresentations)
      : undefined,
    ...(load.outcome === 'failure' ? describeError(load.error) : {}),
  });
}

/**
 * Report one performance metric. `performance.js` calls this once per metric.
 *
 * @param {string} metricName
 * @param {number} value
 * @param {{navigationType: string, sourceType: string|null}} context
 */
export function trackWebVital(metricName, value, { navigationType, sourceType }) {
  const rounded = metricName === 'CLS'
    ? Math.round(value * 1000) / 1000
    : Math.round(value);
  send('web_vital', {
    metric_name: metricName,
    metric_value: rounded,
    metric_rating: metricRating(metricName, value),
    navigation_type: navigationType,
    source_type: sourceType ?? undefined,
  });
}

