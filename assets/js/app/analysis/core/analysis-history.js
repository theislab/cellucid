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
    this._maxEntries = options.maxEntries || 100;
    this._persistToStorage = options.persistToStorage || false;
    this._storageKey = options.storageKey || 'cellucid_analysis_history';

    /** @type {AnalysisHistoryEntry[]} */
    this._history = [];

    /** @type {Map<string, Function[]>} */
    this._listeners = new Map();

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
    const id = this._generateId();

    const record = {
      id,
      timestamp: Date.now(),
      datasetId: entry.datasetId,
      datasetName: entry.datasetName || entry.datasetId,
      config: this._normalizeConfig(entry.config),
      resultSummary: entry.resultSummary || {},
      durationMs: entry.durationMs || 0,
      error: entry.error || null
    };

    // Add to beginning (most recent first)
    this._history.unshift(record);

    // Evict oldest if over limit
    if (this._history.length > this._maxEntries) {
      this._history.pop();
    }

    // Persist if enabled
    if (this._persistToStorage) {
      this._saveToStorage();
    }

    // Emit event
    this._emit('record', record);

    return id;
  }

  /**
   * Start timing an analysis (returns a function to call when done)
   * @param {Object} entry - Partial entry with config
   * @returns {Function} Call with resultSummary to record
   */
  startTiming(entry) {
    const startTime = performance.now();

    return (resultSummary, error = null) => {
      const durationMs = performance.now() - startTime;
      return this.record({
        ...entry,
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
    return [...this._history];
  }

  /**
   * Get entry by ID
   * @param {string} id - Entry ID
   * @returns {AnalysisHistoryEntry|null}
   */
  getById(id) {
    return this._history.find(h => h.id === id) || null;
  }

  /**
   * Get entries for a specific dataset
   * @param {string} datasetId - Dataset identifier
   * @returns {AnalysisHistoryEntry[]}
   */
  getByDataset(datasetId) {
    return this._history.filter(h => h.datasetId === datasetId);
  }

  /**
   * Get entries by analysis type
   * @param {string} analysisType - Analysis type
   * @returns {AnalysisHistoryEntry[]}
   */
  getByType(analysisType) {
    return this._history.filter(h => h.config?.analysisType === analysisType);
  }

  /**
   * Get recent entries
   * @param {number} count - Number of entries to return
   * @returns {AnalysisHistoryEntry[]}
   */
  getRecent(count = 10) {
    return this._history.slice(0, count);
  }

  /**
   * Get entries within a time range
   * @param {number} startTime - Start timestamp (ms)
   * @param {number} endTime - End timestamp (ms)
   * @returns {AnalysisHistoryEntry[]}
   */
  getByTimeRange(startTime, endTime) {
    return this._history.filter(h =>
      h.timestamp >= startTime && h.timestamp <= endTime
    );
  }

  /**
   * Search entries by variable name
   * @param {string} variable - Variable name to search
   * @returns {AnalysisHistoryEntry[]}
   */
  searchByVariable(variable) {
    const lower = variable.toLowerCase();
    return this._history.filter(h =>
      h.config?.variable?.toLowerCase().includes(lower)
    );
  }

  /**
   * Get failed analyses
   * @returns {AnalysisHistoryEntry[]}
   */
  getFailed() {
    return this._history.filter(h => h.error !== null);
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
    const byType = {};
    for (const h of this._history) {
      const type = h.config?.analysisType || 'unknown';
      byType[type] = (byType[type] || 0) + 1;
    }

    // Average duration (excluding failed)
    const durations = this._history
      .filter(h => !h.error && h.durationMs > 0)
      .map(h => h.durationMs);
    const avgDuration = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;

    // Total cells analyzed
    const totalCells = this._history
      .filter(h => !h.error)
      .reduce((sum, h) => sum + (h.resultSummary?.cellCount || 0), 0);

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
    this._history = [];
    if (this._persistToStorage) {
      this._saveToStorage();
    }
    this._emit('clear');
  }

  /**
   * Remove a specific entry
   * @param {string} id - Entry ID
   * @returns {boolean} True if removed
   */
  remove(id) {
    const idx = this._history.findIndex(h => h.id === id);
    if (idx >= 0) {
      this._history.splice(idx, 1);
      if (this._persistToStorage) {
        this._saveToStorage();
      }
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
    this._maxEntries = max;
    if (this._history.length > max) {
      this._history = this._history.slice(0, max);
      if (this._persistToStorage) {
        this._saveToStorage();
      }
    }
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
    const handlers = this._listeners.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }

  /**
   * Emit event
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  _emit(event, data) {
    const handlers = this._listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (e) {
          console.error('[AnalysisHistory] Event handler error:', e);
        }
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
    return `ah_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Normalize config object
   * @param {Object} config
   * @returns {Object}
   */
  _normalizeConfig(config) {
    if (!config) return {};

    return {
      analysisType: config.analysisType || config.type || 'unknown',
      pageIds: config.pageIds || [],
      variable: config.variable || config.variableKey || null,
      plotType: config.plotType || null,
      options: config.options || {}
    };
  }

  /**
   * Load history from session storage
   */
  _loadFromStorage() {
    try {
      const stored = sessionStorage.getItem(this._storageKey);
      if (stored) {
        this._history = JSON.parse(stored);
      }
    } catch (e) {
      console.warn('[AnalysisHistory] Failed to load from storage:', e);
    }
  }

  /**
   * Save history to session storage
   */
  _saveToStorage() {
    try {
      sessionStorage.setItem(this._storageKey, JSON.stringify(this._history));
    } catch (e) {
      console.warn('[AnalysisHistory] Failed to save to storage:', e);
    }
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
    try {
      const imported = JSON.parse(json);
      if (Array.isArray(imported)) {
        if (merge) {
          // Add imported entries, avoiding duplicates by ID
          const existingIds = new Set(this._history.map(h => h.id));
          for (const entry of imported) {
            if (!existingIds.has(entry.id)) {
              this._history.push(entry);
            }
          }
          // Sort by timestamp (newest first)
          this._history.sort((a, b) => b.timestamp - a.timestamp);
          // Trim to max
          if (this._history.length > this._maxEntries) {
            this._history = this._history.slice(0, this._maxEntries);
          }
        } else {
          this._history = imported.slice(0, this._maxEntries);
        }
        if (this._persistToStorage) {
          this._saveToStorage();
        }
      }
    } catch (e) {
      console.error('[AnalysisHistory] Failed to import JSON:', e);
      throw e;
    }
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
