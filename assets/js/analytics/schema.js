/**
 * The complete Google Analytics 4 vocabulary Cellucid may send, and the
 * validator every event passes before it reaches `gtag`.
 *
 * Nothing leaves the browser that is not declared here. Every parameter value
 * is a closed enum, a bounded integer, or a bounded pattern: no free text, no
 * names, no paths, no URLs, no error messages. A dataset is described by coarse
 * shape only; its id is sent solely for the public sample catalog, whose ids
 * are already public.
 *
 * ## Automatic hits
 *
 * `page_view` - sent once per page load by the `config` call in
 * `app/ui/core/ga-init.js`, with `page_location` reduced to origin + path. The
 * query string (dataset ids, `remote` addresses and `data` links, `sampleCatalog`) is
 * never part of it. GA4's own "enhanced measurement" adds further automatic
 * events (history-change page views, scrolls, outbound clicks); those are
 * configured in the GA4 admin, not here.
 *
 * ## Events
 *
 * `app_ready` - once, when the viewer first runs.
 *   - `startup_ms` (int): milliseconds from navigation start to ready.
 *   - `startup_bucket` (enum DURATION_BUCKETS).
 *   - `has_dataset` (0|1): whether startup opened a dataset.
 *   Example: `{startup_ms: 2140, startup_bucket: '1-3s', has_dataset: 1}`
 *
 * `startup_failure` - once, when startup ends on the terminal failure card,
 * or when the code-load watch sees the module graph fail to download.
 *   - `startup_phase` (enum STARTUP_PHASES): where startup stopped.
 *   - `source_type` (enum SOURCE_TYPES): which source the page URL asked for.
 *   - `error_code` (enum ERROR_CODES), `error_name` (enum ERROR_NAMES),
 *     `http_status` (int, optional).
 *   Example: `{startup_phase: 'catalog', source_type: 'remote',
 *     error_code: 'NETWORK_ERROR', error_name: 'DataSourceError'}`
 *
 * `data_load` - once per dataset request that reaches an outcome. A request
 * superseded by a newer one, or abandoned, sends nothing.
 *   - `load_method` (enum LOAD_METHODS): how the dataset was chosen.
 *   - `source_type` (enum SOURCE_TYPES).
 *   - `outcome` ('success'|'failure').
 *   - `duration_ms` (int): from the request (navigation for a startup load,
 *     the click or file pick for an interactive one) to ready or failure.
 *   - `duration_bucket` (enum DURATION_BUCKETS).
 *   - `dataset_id` (id pattern): public sample catalog datasets only.
 *   - `cell_bucket`, `gene_bucket` (enum COUNT_BUCKETS).
 *   - `field_count` (int): number of obs fields.
 *   - `dimensions` (enum DIMENSIONS): embedding dimensions, e.g. `'2+3'`.
 *   - `has_connectivity`, `has_vector_field` (0|1).
 *   - `state_restore` (enum STATE_RESTORES): the dataset's published
 *     default session, success only.
 *   - `mapping_origin` (enum MAPPING_ORIGINS): whether the embeddings shown
 *     were the dataset's defaults or a best guess (a file without a UMAP),
 *     success only. No key name is ever sent.
 *   - `embedding_candidates` (enum EMBEDDING_CANDIDATE_BUCKETS): how many
 *     embeddings the dataset could show, success only.
 *   - `enabled_representations` (enum EMBEDDING_CANDIDATE_BUCKETS): how many
 *     of them it opened with turned on, success only.
 *   - `error_code`, `error_name`, `http_status`: failure only.
 *   Example: `{load_method: 'local-user-h5ad', source_type: 'local-user',
 *     outcome: 'success', duration_ms: 3812, duration_bucket: '3-10s',
 *     cell_bucket: '10k-100k', gene_bucket: '10k-100k', field_count: 14,
 *     dimensions: '2', has_connectivity: 0, has_vector_field: 0}`
 *
 * `feature_used` - the first use of a feature (per feature and variant) in a
 * page load, from a user-initiated event. Repeats are not sent.
 *   - `feature` (enum FEATURES), `variant` (enum FEATURES[feature], when the
 *     feature declares variants).
 *   Example: `{feature: 'render_mode', variant: 'smoke_unsupported'}`
 *
 * `web_vital` - once per metric per page load, when the page is first hidden.
 *   - `metric_name` (enum METRIC_NAMES), `metric_value` (number, ms; CLS is
 *     unitless), `metric_rating` (enum RATINGS, Core Web Vitals only),
 *     `navigation_type` (enum NAVIGATION_TYPES), `source_type` (optional).
 *   Example: `{metric_name: 'LCP', metric_value: 1840, metric_rating: 'good',
 *     navigation_type: 'navigate', source_type: 'local-demo'}`
 *
 * ## User properties
 *
 * Set with `gtag('set', 'user_properties', ...)`; every later event carries
 * them. `input_class` and `viewport_class` are set when analytics starts,
 * `renderer_class` and `smoke_supported` when the viewer runs.
 *
 * - `input_class`: 'touch' | 'mouse' | 'hybrid'.
 * - `viewport_class`: 'phone' | 'tablet' | 'desktop' | 'wide' (CSS width).
 * - `renderer_class`: 'hardware' | 'software' | 'unknown' - only whether
 *   WebGL runs on a CPU rasterizer, never the renderer string.
 * - `smoke_supported`: 'yes' | 'no'.
 *
 * Reports only show a parameter once it is registered as a custom dimension or
 * metric in the GA4 admin; see `GA4_CUSTOM_DEFINITIONS`.
 *
 * @module analytics/schema
 */

import { DATA_LOAD_METHODS } from '../app/data-load-methods.js';
import { DataSourceErrorCode } from '../data/data-source.js';
import { STARTUP_STALL_CODE } from '../app/startup-phase.js';

/** GA4 collection limits (https://support.google.com/analytics/answer/9267744). */
export const GA4_LIMITS = Object.freeze({
  eventNameLength: 40,
  paramsPerEvent: 25,
  paramNameLength: 40,
  paramValueLength: 100,
  userPropertyNameLength: 24,
  userPropertyValueLength: 36,
  userProperties: 25,
});

const RESERVED_PREFIXES = Object.freeze(['google_', 'ga_', 'firebase_', '_']);

/** Event names GA4 reserves for its own collection. */
export const RESERVED_EVENT_NAMES = Object.freeze(new Set([
  'ad_activeview', 'ad_click', 'ad_exposure', 'ad_impression', 'ad_query',
  'ad_reward', 'adunit_exposure', 'app_background', 'app_clear_data',
  'app_exception', 'app_install', 'app_remove', 'app_store_refund',
  'app_update', 'app_upgrade', 'dynamic_link_app_open',
  'dynamic_link_app_update', 'dynamic_link_first_open', 'error', 'first_open',
  'first_visit', 'in_app_purchase', 'notification_dismiss',
  'notification_foreground', 'notification_open', 'notification_receive',
  'os_update', 'screen_view', 'session_start', 'user_engagement',
]));

const RESERVED_USER_PROPERTIES = Object.freeze(new Set([
  'first_open_after_install', 'first_open_time', 'first_visit_time',
  'last_deep_link_referrer', 'user_id',
]));

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

export const LOAD_METHODS = Object.freeze(Object.values(DATA_LOAD_METHODS));

export const SOURCE_TYPES = Object.freeze([
  'local-demo', 'local-user', 'remote', 'link', 'jupyter',
]);

export const STARTUP_PHASES = Object.freeze([
  'code-load', 'boot', 'sign-in', 'health', 'catalog', 'dataset',
  'positions', 'ui', 'session', 'ready',
]);

/** Stable codes the loaders publish on `error.code`; anything else is `other`. */
export const ERROR_CODES = Object.freeze([
  ...Object.values(DataSourceErrorCode),
  STARTUP_STALL_CODE,
  'CODE_LOAD_FAILED',
  'none',
  'other',
]);

/** Error constructor / DOMException names; anything else is `other`. */
export const ERROR_NAMES = Object.freeze([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'DataSourceError', 'ConfigurationError', 'TimeoutError', 'AbortError',
  'NotFoundError', 'NotReadableError', 'NotAllowedError', 'SecurityError',
  'QuotaExceededError', 'NetworkError', 'EncodingError', 'InvalidStateError',
  'DataCloneError', 'other',
]);

export const DURATION_BUCKETS = Object.freeze([
  '<1s', '1-3s', '3-10s', '10-30s', '30-120s', '120s+',
]);

export const COUNT_BUCKETS = Object.freeze([
  '<1k', '1k-10k', '10k-100k', '100k-1M', '1M-10M', '10M+',
]);

export const DIMENSIONS = Object.freeze([
  '1', '2', '3', '1+2', '1+3', '2+3', '1+2+3',
]);

/** How a dataset's data mapping was chosen when it opened. */
export const MAPPING_ORIGINS = Object.freeze(['default', 'best_guess']);

/** How many embeddings a dataset could show, bucketed. */
export const EMBEDDING_CANDIDATE_BUCKETS = Object.freeze(['1', '2-3', '4-9', '10+']);

export const STATE_RESTORES = Object.freeze([
  'none', 'restored', 'failed', 'canceled', 'replaced',
]);

export const METRIC_NAMES = Object.freeze([
  'LCP', 'CLS', 'INP', 'FCP', 'TTFB', 'LONGTASK_TOTAL', 'LONGTASK_MAX',
]);

export const RATINGS = Object.freeze(['good', 'needs_improvement', 'poor']);

/** `PerformanceNavigationTiming.type`; anything else is `other`. */
export const NAVIGATION_TYPES = Object.freeze([
  'navigate', 'reload', 'back_forward', 'prerender', 'other',
]);

/**
 * Every feature counted by `feature_used`, with its allowed variants
 * (`null` when the feature has none).
 */
export const FEATURES = Object.freeze({
  color_by_category: null,
  color_by_continuous: null,
  color_by_gene: null,
  filter: Object.freeze(['category', 'outlier']),
  highlight_tool: Object.freeze(['lasso', 'proximity', 'knn', 'annotation']),
  highlight_selection: null,
  highlight_page: Object.freeze(['add', 'delete']),
  legend_highlight: null,
  multiview: Object.freeze(['keep_view', 'layout_grid', 'layout_single']),
  dimension: Object.freeze(['1', '2', '3']),
  navigation_mode: Object.freeze(['orbit', 'planar', 'free']),
  render_mode: Object.freeze(['points', 'smoke', 'smoke_unsupported']),
  connectivity: null,
  vector_field: null,
  analysis: Object.freeze([
    'simple', 'detailed', 'correlation', 'differential', 'signature',
    'genes_panel', 'dotplot', 'composition',
  ]),
  figure_export: null,
  camera_path: null,
  session_save: null,
  session_load: null,
  community_annotation: Object.freeze(['github_connection']),
  benchmark: null,
  data_mapping: Object.freeze([
    'embedding', 'embedding_columns', 'default', 'knn', 'gene_names', 'expression',
    'log1p', 'highly_variable', 'latent', 'vector_fields',
  ]),
});

export const USER_PROPERTIES = Object.freeze({
  input_class: Object.freeze(['touch', 'mouse', 'hybrid']),
  viewport_class: Object.freeze(['phone', 'tablet', 'desktop', 'wide']),
  renderer_class: Object.freeze(['hardware', 'software', 'unknown']),
  smoke_supported: Object.freeze(['yes', 'no']),
});

const enumOf = values => Object.freeze({ kind: 'enum', values });
const int = (min, max) => Object.freeze({ kind: 'int', min, max });
const FLAG = int(0, 1);
const DATASET_ID = Object.freeze({
  kind: 'pattern',
  pattern: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/,
});

const ERROR_PARAMS = Object.freeze({
  error_code: enumOf(ERROR_CODES),
  error_name: enumOf(ERROR_NAMES),
  http_status: int(100, 599),
});

/**
 * Event name -> { required: [...], params: { name: type } }.
 * `required` params must be present; the rest are optional.
 */
export const EVENTS = Object.freeze({
  app_ready: Object.freeze({
    required: Object.freeze(['startup_ms', 'startup_bucket', 'has_dataset']),
    params: Object.freeze({
      startup_ms: int(0, 86_400_000),
      startup_bucket: enumOf(DURATION_BUCKETS),
      has_dataset: FLAG,
    }),
  }),
  startup_failure: Object.freeze({
    required: Object.freeze([
      'startup_phase', 'source_type', 'error_code', 'error_name',
    ]),
    params: Object.freeze({
      startup_phase: enumOf(STARTUP_PHASES),
      source_type: enumOf(SOURCE_TYPES),
      ...ERROR_PARAMS,
    }),
  }),
  data_load: Object.freeze({
    required: Object.freeze([
      'load_method', 'source_type', 'outcome', 'duration_ms',
      'duration_bucket',
    ]),
    params: Object.freeze({
      load_method: enumOf(LOAD_METHODS),
      source_type: enumOf(SOURCE_TYPES),
      outcome: enumOf(Object.freeze(['success', 'failure'])),
      duration_ms: int(0, 86_400_000),
      duration_bucket: enumOf(DURATION_BUCKETS),
      dataset_id: DATASET_ID,
      cell_bucket: enumOf(COUNT_BUCKETS),
      gene_bucket: enumOf(COUNT_BUCKETS),
      field_count: int(0, 100_000),
      dimensions: enumOf(DIMENSIONS),
      has_connectivity: FLAG,
      has_vector_field: FLAG,
      state_restore: enumOf(STATE_RESTORES),
      mapping_origin: enumOf(MAPPING_ORIGINS),
      embedding_candidates: enumOf(EMBEDDING_CANDIDATE_BUCKETS),
      enabled_representations: enumOf(EMBEDDING_CANDIDATE_BUCKETS),
      ...ERROR_PARAMS,
    }),
  }),
  feature_used: Object.freeze({
    required: Object.freeze(['feature']),
    params: Object.freeze({
      feature: enumOf(Object.freeze(Object.keys(FEATURES))),
      variant: Object.freeze({ kind: 'variant' }),
    }),
  }),
  web_vital: Object.freeze({
    required: Object.freeze(['metric_name', 'metric_value', 'navigation_type']),
    params: Object.freeze({
      metric_name: enumOf(METRIC_NAMES),
      metric_value: Object.freeze({ kind: 'number', min: 0, max: 86_400_000 }),
      metric_rating: enumOf(RATINGS),
      navigation_type: enumOf(NAVIGATION_TYPES),
      source_type: enumOf(SOURCE_TYPES),
    }),
  }),
});

/**
 * What the owner registers in GA4 admin (Admin > Custom definitions) so the
 * parameters above appear in reports. Unregistered parameters are collected
 * but invisible outside Explorations and BigQuery.
 */
export const GA4_CUSTOM_DEFINITIONS = Object.freeze({
  eventDimensions: Object.freeze([
    'load_method', 'source_type', 'outcome', 'duration_bucket', 'dataset_id',
    'cell_bucket', 'gene_bucket', 'dimensions',
    'state_restore', 'mapping_origin', 'embedding_candidates',
    'enabled_representations', 'error_code',
    'error_name', 'startup_phase',
    'startup_bucket', 'feature', 'variant', 'metric_name', 'metric_rating',
    'navigation_type',
  ]),
  eventMetrics: Object.freeze([
    { name: 'duration_ms', unit: 'milliseconds' },
    { name: 'startup_ms', unit: 'milliseconds' },
    { name: 'metric_value', unit: 'standard' },
    { name: 'field_count', unit: 'standard' },
  ]),
  // Low-cardinality 0/1 flags and the HTTP status are clearer as dimensions.
  eventFlagDimensions: Object.freeze([
    'has_dataset', 'has_connectivity', 'has_vector_field', 'http_status',
  ]),
  userDimensions: Object.freeze(Object.keys(USER_PROPERTIES)),
});

/** A payload that violates this schema. */
export class AnalyticsSchemaError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'AnalyticsSchemaError';
  }
}

function checkName(name, kind, maxLength) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > maxLength ||
    !SNAKE_CASE.test(name) ||
    RESERVED_PREFIXES.some(prefix => name.startsWith(prefix))
  ) {
    throw new AnalyticsSchemaError(
      `${kind} ${JSON.stringify(name)} must be snake_case, at most ` +
      `${maxLength} characters, without a reserved prefix.`
    );
  }
}

function checkValue(eventName, paramName, type, value, params) {
  const where = `${eventName}.${paramName}`;
  switch (type.kind) {
    case 'enum':
      if (!type.values.includes(value)) {
        throw new AnalyticsSchemaError(
          `${where} must be one of ${type.values.join(', ')}; ` +
          `received ${JSON.stringify(value)}.`
        );
      }
      return value;
    case 'variant': {
      const variants = FEATURES[params.feature];
      if (!Array.isArray(variants) || !variants.includes(value)) {
        throw new AnalyticsSchemaError(
          `${where} ${JSON.stringify(value)} is not a declared variant of ` +
          `${JSON.stringify(params.feature)}.`
        );
      }
      return value;
    }
    case 'int':
      if (!Number.isSafeInteger(value) || value < type.min || value > type.max) {
        throw new AnalyticsSchemaError(
          `${where} must be an integer in [${type.min}, ${type.max}]; ` +
          `received ${JSON.stringify(value)}.`
        );
      }
      return value;
    case 'number':
      if (!Number.isFinite(value) || value < type.min || value > type.max) {
        throw new AnalyticsSchemaError(
          `${where} must be a finite number in [${type.min}, ${type.max}].`
        );
      }
      return value;
    case 'pattern':
      if (typeof value !== 'string' || !type.pattern.test(value)) {
        throw new AnalyticsSchemaError(
          `${where} must match ${type.pattern}; received ` +
          `${JSON.stringify(String(value).slice(0, 40))}.`
        );
      }
      return value;
    default:
      throw new AnalyticsSchemaError(`${where} has an unknown type.`);
  }
}

/**
 * Validate one event against the schema and GA4's limits.
 *
 * `undefined` parameters are dropped (an optional parameter that does not
 * apply); every other value must match its declared type exactly. Nothing is
 * coerced or truncated: a payload either is valid or is refused whole.
 *
 * @param {string} name
 * @param {Record<string, unknown>} params
 * @returns {Readonly<Record<string, string|number>>} The exact params to send.
 * @throws {AnalyticsSchemaError}
 */
export function validateEvent(name, params) {
  checkName(name, 'Event name', GA4_LIMITS.eventNameLength);
  if (RESERVED_EVENT_NAMES.has(name)) {
    throw new AnalyticsSchemaError(`Event name ${name} is reserved by GA4.`);
  }
  const definition = Object.hasOwn(EVENTS, name) ? EVENTS[name] : null;
  if (definition === null) {
    throw new AnalyticsSchemaError(`Event ${name} is not declared.`);
  }
  if (
    params === null ||
    typeof params !== 'object' ||
    Array.isArray(params) ||
    Object.getPrototypeOf(params) !== Object.prototype
  ) {
    throw new AnalyticsSchemaError(`Event ${name} params must be a plain object.`);
  }
  const out = {};
  for (const [paramName, value] of Object.entries(params)) {
    if (value === undefined) continue;
    checkName(paramName, `Parameter of ${name}`, GA4_LIMITS.paramNameLength);
    if (!Object.hasOwn(definition.params, paramName)) {
      throw new AnalyticsSchemaError(
        `Parameter ${name}.${paramName} is not declared.`
      );
    }
    const checked = checkValue(
      name,
      paramName,
      definition.params[paramName],
      value,
      params
    );
    if (
      typeof checked === 'string' &&
      checked.length > GA4_LIMITS.paramValueLength
    ) {
      throw new AnalyticsSchemaError(
        `${name}.${paramName} exceeds ${GA4_LIMITS.paramValueLength} characters.`
      );
    }
    out[paramName] = checked;
  }
  for (const required of definition.required) {
    if (!Object.hasOwn(out, required)) {
      throw new AnalyticsSchemaError(`${name}.${required} is required.`);
    }
  }
  if (
    name === 'feature_used' &&
    Array.isArray(FEATURES[out.feature]) &&
    !Object.hasOwn(out, 'variant')
  ) {
    throw new AnalyticsSchemaError(
      `feature_used ${out.feature} requires one of its variants.`
    );
  }
  if (Object.keys(out).length > GA4_LIMITS.paramsPerEvent) {
    throw new AnalyticsSchemaError(
      `${name} exceeds ${GA4_LIMITS.paramsPerEvent} parameters.`
    );
  }
  return Object.freeze(out);
}

/**
 * Validate a user-property update.
 *
 * @param {Record<string, unknown>} properties
 * @returns {Readonly<Record<string, string>>}
 * @throws {AnalyticsSchemaError}
 */
export function validateUserProperties(properties) {
  if (
    properties === null ||
    typeof properties !== 'object' ||
    Object.getPrototypeOf(properties) !== Object.prototype
  ) {
    throw new AnalyticsSchemaError('User properties must be a plain object.');
  }
  const out = {};
  for (const [name, value] of Object.entries(properties)) {
    checkName(name, 'User property', GA4_LIMITS.userPropertyNameLength);
    if (RESERVED_USER_PROPERTIES.has(name)) {
      throw new AnalyticsSchemaError(`User property ${name} is reserved.`);
    }
    const allowed = Object.hasOwn(USER_PROPERTIES, name)
      ? USER_PROPERTIES[name]
      : null;
    if (allowed === null) {
      throw new AnalyticsSchemaError(`User property ${name} is not declared.`);
    }
    if (!allowed.includes(value)) {
      throw new AnalyticsSchemaError(
        `User property ${name} must be one of ${allowed.join(', ')}.`
      );
    }
    if (value.length > GA4_LIMITS.userPropertyValueLength) {
      throw new AnalyticsSchemaError(`User property ${name} is too long.`);
    }
    out[name] = value;
  }
  if (Object.keys(USER_PROPERTIES).length > GA4_LIMITS.userProperties) {
    throw new AnalyticsSchemaError('Too many user properties are declared.');
  }
  return Object.freeze(out);
}

// --------------------------------------------------------------------------
// Coarse descriptors. Each maps a raw measurement onto a declared enum.
// --------------------------------------------------------------------------

/**
 * @param {number} ms
 * @returns {string} One of DURATION_BUCKETS.
 */
export function durationBucket(ms) {
  if (ms < 1_000) return '<1s';
  if (ms < 3_000) return '1-3s';
  if (ms < 10_000) return '3-10s';
  if (ms < 30_000) return '10-30s';
  if (ms < 120_000) return '30-120s';
  return '120s+';
}

/**
 * @param {number} count
 * @returns {string} One of COUNT_BUCKETS.
 */
/**
 * @param {number} count - Embeddings a dataset could show (at least 1).
 * @returns {string} One of EMBEDDING_CANDIDATE_BUCKETS.
 */
export function embeddingCandidateBucket(count) {
  if (count <= 1) return '1';
  if (count <= 3) return '2-3';
  if (count <= 9) return '4-9';
  return '10+';
}

export function countBucket(count) {
  if (count < 1_000) return '<1k';
  if (count < 10_000) return '1k-10k';
  if (count < 100_000) return '10k-100k';
  if (count < 1_000_000) return '100k-1M';
  if (count < 10_000_000) return '1M-10M';
  return '10M+';
}

/**
 * @param {unknown} defaults - `embeddings.defaults`, whose keys ("1d", "2d",
 *   "3d") are the dimensions the dataset shows.
 * @returns {string|undefined} One of DIMENSIONS.
 */
export function dimensionsDescriptor(defaults) {
  if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) {
    return undefined;
  }
  const value = Object.keys(defaults)
    .map(slot => ({ '1d': 1, '2d': 2, '3d': 3 })[slot])
    .filter(dim => dim !== undefined)
    .sort()
    .join('+');
  return DIMENSIONS.includes(value) ? value : undefined;
}

const RATING_THRESHOLDS = Object.freeze({
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
});

/**
 * Core Web Vitals rating (web.dev thresholds), or undefined for metrics
 * without a published threshold.
 *
 * @param {string} metricName
 * @param {number} value
 * @returns {string|undefined}
 */
export function metricRating(metricName, value) {
  const thresholds = RATING_THRESHOLDS[metricName];
  if (thresholds === undefined) return undefined;
  if (value <= thresholds[0]) return 'good';
  if (value <= thresholds[1]) return 'needs_improvement';
  return 'poor';
}

function firstCause(error) {
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (current instanceof AggregateError && current.errors.length > 0) {
      current = current.errors[0];
      continue;
    }
    break;
  }
  return current;
}

/**
 * The stable, non-identifying description of an error: its published `code`,
 * its constructor name, and an HTTP status when the loader recorded one.
 * The message is never read - it can carry file names and URLs.
 *
 * @param {unknown} error
 * @returns {{error_code: string, error_name: string, http_status?: number}}
 */
export function describeError(error) {
  const cause = firstCause(error);
  const code = cause !== null && typeof cause === 'object' ? cause.code : undefined;
  const name = cause !== null && typeof cause === 'object' ? cause.name : undefined;
  const status = cause !== null && typeof cause === 'object'
    ? (cause.details?.status ?? cause.status)
    : undefined;
  return {
    error_code: typeof code === 'string'
      ? (ERROR_CODES.includes(code) ? code : 'other')
      : 'none',
    error_name: typeof name === 'string' && ERROR_NAMES.includes(name)
      ? name
      : 'other',
    http_status: Number.isSafeInteger(status) && status >= 100 && status <= 599
      ? status
      : undefined,
  };
}
