/**
 * Analysis History Tracker
 *
 * Tracks analysis runs for reproducibility and workflow analytics.
 * Each entry contains the analysis config, dataset identity, timing,
 * and a summary of results.
 *
 * Features:
 * - Track every analysis run with full configuration
 * - Query history by ID or filter by criteria
 * - Limit history size with LRU eviction
 * - Event-based notifications for new entries
 *
 * NOTE: This tracker is designed to be used for multiple purposes beyond
 * just history display. The recorded data can be used for:
 * - Workflow analytics and usage patterns
 * - Reproducibility audit trails
 * - Session reconstruction
 * - Integration with external logging/analytics systems
 * - Machine learning training data for analysis recommendations
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * @typedef {Object} AnalysisHistoryEntry
 * @property {string} id - Unique entry ID
 * @property {number} timestamp - Unix timestamp (ms)
 * @property {string} datasetId - Dataset identifier
 * @property {string} datasetName - Human-readable dataset name
 * @property {Object} config - Analysis configuration
 * @property {string} config.analysisType - Type of analysis
 * @property {string[]} config.pageIds - Page IDs involved
 * @property {string} config.variable - Variable analyzed
 * @property {Object} config.options - Analysis options
 * @property {Object} resultSummary - Summary of results
 * @property {number} resultSummary.pageCount - Number of pages
 * @property {number} resultSummary.cellCount - Total cells analyzed
 * @property {string} resultSummary.plotType - Plot type used
 * @property {Object} [resultSummary.stats] - Statistical results
 * @property {number} durationMs - Execution time in milliseconds
 * @property {string} [error] - Error message if failed
 */

const HISTORY_EVENTS = new Set(['record', 'clear', 'remove']);
const TRACKER_OPTION_KEYS = new Set([
  'maxEntries',
  'persistToStorage',
  'storageKey'
]);
const RECORD_INPUT_KEYS = new Set([
  'config',
  'datasetId',
  'datasetName',
  'durationMs',
  'error',
  'resultSummary'
]);
const STORED_ENTRY_KEYS = [
  'config',
  'datasetId',
  'datasetName',
  'durationMs',
  'error',
  'id',
  'resultSummary',
  'timestamp'
];
const CONFIG_KEYS = [
  'analysisType',
  'options',
  'pageIds',
  'plotType',
  'variable'
];

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, name) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  return value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireFiniteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number.`);
  }
  return value;
}

function requireExactKeys(value, expectedKeys, name) {
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(
      `${name} must contain exactly: ${sortedExpected.join(', ')}.`
    );
  }
}

function cloneValue(value, name) {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new TypeError(`${name} must be structured-cloneable.`, {
      cause: error
    });
  }
}

function cloneJsonValue(value, name, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${name} numbers must be finite.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError(`${name} must not contain a cycle.`);
    }
    ancestors.add(value);
    const result = value.map((item, index) =>
      cloneJsonValue(item, `${name}[${index}]`, ancestors)
    );
    ancestors.delete(value);
    return result;
  }
  if (isPlainObject(value)) {
    if (ancestors.has(value)) {
      throw new TypeError(`${name} must not contain a cycle.`);
    }
    ancestors.add(value);
    const result = {};
    const ownKeys = Reflect.ownKeys(value);
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== 'string' ||
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        throw new TypeError(
          `${name} must contain only enumerable string data properties.`
        );
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cloneJsonValue(
          descriptor.value,
          `${name}.${key}`,
          ancestors
        )
      });
    }
    ancestors.delete(value);
    return result;
  }
  throw new TypeError(`${name} must contain only JSON values.`);
}

function validateConfig(config) {
  requirePlainObject(config, 'Analysis config');
  requireExactKeys(config, CONFIG_KEYS, 'Analysis config');
  requireNonEmptyString(config.analysisType, 'Analysis config analysisType');
  if (!Array.isArray(config.pageIds)) {
    throw new TypeError('Analysis config pageIds must be an array.');
  }
  const pageIds = config.pageIds.map((pageId, index) =>
    requireNonEmptyString(pageId, `Analysis config pageIds[${index}]`)
  );
  if (new Set(pageIds).size !== pageIds.length) {
    throw new TypeError('Analysis config pageIds must be unique.');
  }
  if (config.variable !== null) {
    requireNonEmptyString(config.variable, 'Analysis config variable');
  }
  if (config.plotType !== null) {
    requireNonEmptyString(config.plotType, 'Analysis config plotType');
  }
  requirePlainObject(config.options, 'Analysis config options');

  return {
    analysisType: config.analysisType,
    pageIds: [...pageIds],
    variable: config.variable,
    plotType: config.plotType,
    options: cloneJsonValue(config.options, 'Analysis config options')
  };
}

function validateResultSummary(resultSummary) {
  requirePlainObject(resultSummary, 'Analysis resultSummary');
  if (Object.hasOwn(resultSummary, 'cellCount')) {
    if (
      !Number.isSafeInteger(resultSummary.cellCount) ||
      resultSummary.cellCount < 0
    ) {
      throw new TypeError(
        'Analysis resultSummary cellCount must be a non-negative safe integer.'
      );
    }
  }
  return cloneJsonValue(resultSummary, 'Analysis resultSummary');
}

function validateStoredEntry(entry, index) {
  const name = `Analysis history entry ${index}`;
  requirePlainObject(entry, name);
  requireExactKeys(entry, STORED_ENTRY_KEYS, name);
  requireNonEmptyString(entry.id, `${name} id`);
  if (!Number.isSafeInteger(entry.timestamp) || entry.timestamp < 0) {
    throw new TypeError(`${name} timestamp must be a non-negative safe integer.`);
  }
  requireNonEmptyString(entry.datasetId, `${name} datasetId`);
  requireNonEmptyString(entry.datasetName, `${name} datasetName`);
  requireFiniteNonNegative(entry.durationMs, `${name} durationMs`);
  if (entry.error !== null) {
    requireNonEmptyString(entry.error, `${name} error`);
  }

  return {
    id: entry.id,
    timestamp: entry.timestamp,
    datasetId: entry.datasetId,
    datasetName: entry.datasetName,
    config: validateConfig(entry.config),
    resultSummary: validateResultSummary(entry.resultSummary),
    durationMs: entry.durationMs,
    error: entry.error
  };
}

function validateStoredHistory(value, maxEntries) {
  if (!Array.isArray(value)) {
    throw new TypeError('Stored analysis history must be an array.');
  }
  if (value.length > maxEntries) {
    throw new RangeError(
      `Stored analysis history has ${value.length} entries; the configured maximum is ${maxEntries}.`
    );
  }
  const entries = value.map((entry, index) => validateStoredEntry(entry, index));
  const ids = entries.map(entry => entry.id);
  if (new Set(ids).size !== ids.length) {
    throw new TypeError('Analysis history entry ids must be unique.');
  }
  return entries.sort((a, b) => b.timestamp - a.timestamp);
}

// =============================================================================
// HISTORY TRACKER CLASS
// =============================================================================

/**
 * Analysis History Tracker
 */
export class AnalysisHistoryTracker {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxEntries=100] - Maximum history entries
   * @param {boolean} [options.persistToStorage=false] - Persist to sessionStorage
  * @param {string} [options.storageKey='cellucid_analysis_history'] - Storage key
   */
  constructor(options = {}) {
    requirePlainObject(options, 'Analysis history options');
    for (const key of Object.keys(options)) {
      if (!TRACKER_OPTION_KEYS.has(key)) {
        throw new TypeError(`Unknown analysis history option "${key}".`);
      }
    }
    const maxEntries = options.maxEntries ?? 100;
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new TypeError('Analysis history maxEntries must be a positive safe integer.');
    }
    const persistToStorage = options.persistToStorage ?? false;
    if (typeof persistToStorage !== 'boolean') {
      throw new TypeError('Analysis history persistToStorage must be a boolean.');
    }
    const storageKey = options.storageKey ?? 'cellucid_analysis_history';
    requireNonEmptyString(storageKey, 'Analysis history storageKey');

    this._maxEntries = maxEntries;
    this._persistToStorage = persistToStorage;
    this._storageKey = storageKey;

    /** @type {AnalysisHistoryEntry[]} */
    this._history = [];

    /** @type {Map<string, Function[]>} */
    this._listeners = new Map();

    this._nextId = 0;

    // Load from storage if enabled
    if (this._persistToStorage) {
      this._loadFromStorage();
    }
  }

  // ===========================================================================
  // RECORDING
  // ===========================================================================

  /**
   * Record an analysis run
   * @param {Object} entry
   * @param {string} entry.datasetId - Dataset identifier
   * @param {string} [entry.datasetName] - Dataset display name
   * @param {Object} entry.config - Analysis configuration
   * @param {Object} [entry.resultSummary] - Summary of results
   * @param {number} [entry.durationMs] - Execution duration
   * @param {string} [entry.error] - Error message if failed
   * @returns {string} Entry ID
   */
  record(entry) {
    requirePlainObject(entry, 'Analysis history record');
    for (const key of Object.keys(entry)) {
      if (!RECORD_INPUT_KEYS.has(key)) {
        throw new TypeError(`Unknown analysis history record field "${key}".`);
      }
    }
    if (!Object.hasOwn(entry, 'datasetId') || !Object.hasOwn(entry, 'config')) {
      throw new TypeError(
        'Analysis history record requires datasetId and config.'
      );
    }
    requireNonEmptyString(entry.datasetId, 'Analysis history datasetId');
    if (entry.datasetName !== undefined) {
      requireNonEmptyString(entry.datasetName, 'Analysis history datasetName');
    }
    if (entry.durationMs !== undefined) {
      requireFiniteNonNegative(entry.durationMs, 'Analysis history durationMs');
    }
    if (entry.error !== undefined && entry.error !== null) {
      requireNonEmptyString(entry.error, 'Analysis history error');
    }
    const id = this._generateId();

    const record = {
      id,
      timestamp: Date.now(),
      datasetId: entry.datasetId,
      datasetName: entry.datasetName ?? entry.datasetId,
      config: validateConfig(entry.config),
      resultSummary: validateResultSummary(entry.resultSummary ?? {}),
      durationMs: entry.durationMs ?? 0,
      error: entry.error ?? null
    };

    // Add to beginning (most recent first)
    const nextHistory = [record, ...this._history].slice(0, this._maxEntries);
    this._saveHistoryToStorage(nextHistory);
    this._history = nextHistory;

    // Emit event
    this._emit('record', cloneValue(record, 'Analysis history record event'));

    return id;
  }

  /**
   * Start timing an analysis (returns a function to call when done)
   * @param {Object} entry - Partial entry with config
   * @returns {Function} Call with resultSummary to record
   */
  startTiming(entry) {
    requirePlainObject(entry, 'Analysis timing record');
    const keys = Object.keys(entry);
    if (
      keys.some(
        key => !['config', 'datasetId', 'datasetName'].includes(key)
      ) ||
      !Object.hasOwn(entry, 'config') ||
      !Object.hasOwn(entry, 'datasetId')
    ) {
      throw new TypeError(
        'Analysis timing record must contain datasetId, config, and optional datasetName.'
      );
    }
    requireNonEmptyString(entry.datasetId, 'Analysis timing datasetId');
    if (entry.datasetName !== undefined) {
      requireNonEmptyString(
        entry.datasetName,
        'Analysis timing datasetName'
      );
    }
    const ownedEntry = {
      datasetId: entry.datasetId,
      datasetName: entry.datasetName,
      config: validateConfig(entry.config)
    };
    const startTime = performance.now();
    let completed = false;

    return (resultSummary, error = null) => {
      if (completed) {
        throw new Error(
          'Analysis timing completion may be published exactly once.'
        );
      }
      completed = true;
      const durationMs = performance.now() - startTime;
      return this.record({
        ...ownedEntry,
        resultSummary,
        durationMs,
        error
      });
    };
  }

  // ===========================================================================
  // QUERYING
  // ===========================================================================

  /**
   * Get all history entries
   * @returns {AnalysisHistoryEntry[]}
   */
  getHistory() {
    return cloneValue(this._history, 'Analysis history');
  }

  /**
   * Get entry by ID
   * @param {string} id - Entry ID
   * @returns {AnalysisHistoryEntry|null}
   */
  getById(id) {
    requireNonEmptyString(id, 'Analysis history id');
    const entry = this._history.find(h => h.id === id);
    return entry === undefined ? null : cloneValue(entry, 'Analysis history entry');
  }

  /**
   * Get entries for a specific dataset
   * @param {string} datasetId - Dataset identifier
   * @returns {AnalysisHistoryEntry[]}
   */
  getByDataset(datasetId) {
    requireNonEmptyString(datasetId, 'Analysis history datasetId');
    return cloneValue(
      this._history.filter(h => h.datasetId === datasetId),
      'Analysis history entries'
    );
  }

  /**
   * Get entries by analysis type
   * @param {string} analysisType - Analysis type
   * @returns {AnalysisHistoryEntry[]}
   */
  getByType(analysisType) {
    requireNonEmptyString(analysisType, 'Analysis history analysisType');
    return cloneValue(
      this._history.filter(h => h.config.analysisType === analysisType),
      'Analysis history entries'
    );
  }

  /**
   * Get recent entries
   * @param {number} count - Number of entries to return
   * @returns {AnalysisHistoryEntry[]}
   */
  getRecent(count = 10) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError('Analysis history count must be a non-negative safe integer.');
    }
    return cloneValue(
      this._history.slice(0, count),
      'Recent analysis history entries'
    );
  }

  /**
   * Get entries within a time range
   * @param {number} startTime - Start timestamp (ms)
   * @param {number} endTime - End timestamp (ms)
   * @returns {AnalysisHistoryEntry[]}
   */
  getByTimeRange(startTime, endTime) {
    requireFiniteNonNegative(startTime, 'Analysis history startTime');
    requireFiniteNonNegative(endTime, 'Analysis history endTime');
    if (startTime > endTime) {
      throw new RangeError('Analysis history startTime cannot exceed endTime.');
    }
    return cloneValue(
      this._history.filter(h =>
        h.timestamp >= startTime && h.timestamp <= endTime
      ),
      'Analysis history entries'
    );
  }

  /**
   * Search entries by variable name
   * @param {string} variable - Variable name to search
   * @returns {AnalysisHistoryEntry[]}
   */
  searchByVariable(variable) {
    requireNonEmptyString(variable, 'Analysis history variable');
    const lower = variable.toLowerCase();
    return cloneValue(
      this._history.filter(h =>
        h.config.variable !== null &&
        h.config.variable.toLowerCase().includes(lower)
      ),
      'Analysis history entries'
    );
  }

  /**
   * Get failed analyses
   * @returns {AnalysisHistoryEntry[]}
   */
  getFailed() {
    return cloneValue(
      this._history.filter(h => h.error !== null),
      'Failed analysis history entries'
    );
  }

  // ===========================================================================
  // STATISTICS
  // ===========================================================================

  /**
   * Get history statistics
   * @returns {Object}
   */
  getStats() {
    const total = this._history.length;
    const failed = this._history.filter(h => h.error).length;
    const successful = total - failed;

    // Group by analysis type
    const typeCounts = new Map();
    for (const h of this._history) {
      const type = h.config.analysisType;
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    }
    const byType = Object.fromEntries(typeCounts);

    // Average duration (excluding failed)
    const durations = this._history
      .filter(h => !h.error && h.durationMs > 0)
      .map(h => h.durationMs);
    const totalDuration = durations.reduce((sum, duration) => {
      const next = sum + duration;
      if (!Number.isFinite(next)) {
        throw new RangeError(
          'Analysis history durations exceed the finite numeric range.'
        );
      }
      return next;
    }, 0);
    const avgDuration = durations.length > 0
      ? totalDuration / durations.length
      : 0;

    // Total cells analyzed
    const totalCells = this._history
      .filter(h => !h.error)
      .reduce((sum, h) => {
        const count = Object.hasOwn(h.resultSummary, 'cellCount')
          ? h.resultSummary.cellCount
          : 0;
        const next = sum + count;
        if (!Number.isSafeInteger(next)) {
          throw new RangeError(
            'Analysis history total cell count exceeds the safe integer range.'
          );
        }
        return next;
      }, 0);

    return {
      total,
      successful,
      failed,
      byType,
      avgDurationMs: Math.round(avgDuration),
      totalCellsAnalyzed: totalCells
    };
  }

  // ===========================================================================
  // MANAGEMENT
  // ===========================================================================

  /**
   * Clear all history
   */
  clear() {
    this._saveHistoryToStorage([]);
    this._history = [];
    this._emit('clear');
  }

  /**
   * Remove a specific entry
   * @param {string} id - Entry ID
   * @returns {boolean} True if removed
   */
  remove(id) {
    requireNonEmptyString(id, 'Analysis history id');
    const idx = this._history.findIndex(h => h.id === id);
    if (idx >= 0) {
      const nextHistory = this._history.filter((_, index) => index !== idx);
      this._saveHistoryToStorage(nextHistory);
      this._history = nextHistory;
      this._emit('remove', { id });
      return true;
    }
    return false;
  }

  /**
   * Set maximum entries
   * @param {number} max - Maximum entries
   */
  setMaxEntries(max) {
    if (!Number.isSafeInteger(max) || max <= 0) {
      throw new TypeError('Analysis history maxEntries must be a positive safe integer.');
    }
    const nextHistory = this._history.slice(0, max);
    this._saveHistoryToStorage(nextHistory);
    this._maxEntries = max;
    this._history = nextHistory;
  }

  // ===========================================================================
  // EVENTS
  // ===========================================================================

  /**
   * Add event listener
   * @param {'record'|'clear'|'remove'} event - Event name
   * @param {Function} handler - Handler function
   */
  on(event, handler) {
    if (!HISTORY_EVENTS.has(event)) {
      throw new TypeError(`Unknown analysis history event "${event}".`);
    }
    if (typeof handler !== 'function') {
      throw new TypeError('Analysis history event handler must be a function.');
    }
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(handler);
  }

  /**
   * Remove event listener
   * @param {string} event - Event name
   * @param {Function} handler - Handler function
   */
  off(event, handler) {
    if (!HISTORY_EVENTS.has(event)) {
      throw new TypeError(`Unknown analysis history event "${event}".`);
    }
    if (typeof handler !== 'function') {
      throw new TypeError('Analysis history event handler must be a function.');
    }
    const handlers = this._listeners.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) {
        handlers.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  /**
   * Emit event
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  _emit(event, data) {
    const handlers = this._listeners.get(event);
    if (handlers) {
      const failures = [];
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Analysis history "${event}" event handler failure.`
        );
      }
    }
  }

  // ===========================================================================
  // INTERNAL HELPERS
  // ===========================================================================

  /**
   * Generate unique ID
   * @returns {string}
   */
  _generateId() {
    const timestamp = Date.now();
    let id;
    do {
      this._nextId++;
      id = `ah_${timestamp}_${this._nextId}`;
    } while (this._history.some(entry => entry.id === id));
    return id;
  }

  /**
   * Load history from session storage
   */
  _loadFromStorage() {
    if (
      typeof sessionStorage !== 'object' ||
      sessionStorage === null ||
      typeof sessionStorage.getItem !== 'function' ||
      typeof sessionStorage.setItem !== 'function'
    ) {
      throw new TypeError(
        'Analysis history persistence requires the sessionStorage contract.'
      );
    }
    const stored = sessionStorage.getItem(this._storageKey);
    if (stored !== null) {
      const parsed = JSON.parse(stored);
      this._history = validateStoredHistory(parsed, this._maxEntries);
    }
  }

  /**
   * Save a proposed history to session storage before publishing it in memory.
   * @param {AnalysisHistoryEntry[]} history
   */
  _saveHistoryToStorage(history) {
    if (!this._persistToStorage) {
      return;
    }
    sessionStorage.setItem(this._storageKey, JSON.stringify(history));
  }

  /**
   * Export history to JSON
   * @returns {string}
   */
  exportJSON() {
    return JSON.stringify(this._history, null, 2);
  }

  /**
   * Import history from JSON
   * @param {string} json - JSON string
   * @param {boolean} [merge=false] - Merge with existing history
   */
  importJSON(json, merge = false) {
    if (typeof json !== 'string') {
      throw new TypeError('Analysis history JSON must be a string.');
    }
    if (typeof merge !== 'boolean') {
      throw new TypeError('Analysis history merge must be a boolean.');
    }
    const parsed = JSON.parse(json);
    const imported = validateStoredHistory(parsed, this._maxEntries);
    let nextHistory = imported;

    if (merge) {
      const existingIds = new Set(this._history.map(entry => entry.id));
      const colliding = imported.find(entry => existingIds.has(entry.id));
      if (colliding !== undefined) {
        throw new TypeError(
          `Cannot merge duplicate analysis history id "${colliding.id}".`
        );
      }
      nextHistory = [...this._history, ...imported]
        .sort((a, b) => b.timestamp - a.timestamp);
      if (nextHistory.length > this._maxEntries) {
        throw new RangeError(
          `Merged analysis history has ${nextHistory.length} entries; the configured maximum is ${this._maxEntries}.`
        );
      }
    }

    this._saveHistoryToStorage(nextHistory);
    this._history = nextHistory;
  }
}

// =============================================================================
// SINGLETON & EXPORTS
// =============================================================================

let _instance = null;

/**
 * Get the singleton AnalysisHistoryTracker instance
 * @param {Object} [options] - Options for initialization
 * @returns {AnalysisHistoryTracker}
 */
export function getAnalysisHistory(options = {}) {
  if (!_instance) {
    _instance = new AnalysisHistoryTracker(options);
  } else {
    requirePlainObject(options, 'Analysis history options');
    if (Object.keys(options).length > 0) {
      throw new TypeError(
        'Analysis history singleton options are only accepted on first initialization.'
      );
    }
  }
  return _instance;
}

/**
 * Create a new AnalysisHistoryTracker instance
 * @param {Object} options - Tracker options
 * @returns {AnalysisHistoryTracker}
 */
export function createAnalysisHistory(options) {
  return new AnalysisHistoryTracker(options);
}

export default AnalysisHistoryTracker;
