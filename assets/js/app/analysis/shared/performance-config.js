/**
 * Performance Configuration Module
 *
 * Centralized configuration for all performance-related settings in the analysis module.
 * Provides a single source of truth for memory budgets, batch sizes, and thresholds.
 *
 * Key Design Principles:
 * - DRY: All magic numbers defined once
 * - Flexible: All values can be overridden
 * - Data-aware: Recommended settings scale with dataset size
 *
 * @module shared/performance-config
 */

// =============================================================================
// DEFAULT CONFIGURATION VALUES
// =============================================================================

/**
 * Memory configuration defaults (in MB unless otherwise noted)
 * @type {Object}
 */
const MEMORY_DEFAULTS = {
  /** Default memory budget for batch operations (MB) */
  defaultBudgetMB: 512,
  /** Minimum allowed memory budget (MB) */
  minBudgetMB: 128,
  /** Maximum allowed memory budget (MB) */
  maxBudgetMB: 4096,
  /** Percentage of heap usage that triggers a warning */
  warningThresholdPercent: 75,
  /** Percentage of heap usage that triggers cleanup */
  cleanupThresholdPercent: 85,
  /** Safety margin when estimating available memory (0-1) */
  safetyMargin: 0.7,
  /** Bytes per Float32 element */
  bytesPerFloat32: 4,
  /** Overhead factor for Wilcoxon test (accounts for rank arrays, etc.) */
  wilcoxonOverheadFactor: 5,
  /** Overhead factor for t-test (simpler, less memory) */
  ttestOverheadFactor: 2
};

/**
 * Batch processing configuration defaults
 * @type {Object}
 */
const BATCH_DEFAULTS = {
  /** Default number of genes to preload in each batch */
  defaultPreloadCount: 100,
  /** Minimum genes per batch */
  minPreloadCount: 10,
  /** Maximum genes per batch */
  maxPreloadCount: 500,
  /** Number of concurrent network requests for gene loading */
  networkConcurrency: 6,
  /** Number of genes to keep ready for compute ahead of current */
  computeAheadBuffer: 50,
  /** Yield to UI every N genes processed */
  uiYieldInterval: 25,
  /** Progress update interval (genes) */
  progressUpdateInterval: 10
};

/**
 * Worker pool configuration defaults
 * @type {Object}
 */
const WORKER_DEFAULTS = {
  /** Maximum number of workers in pool */
  maxPoolSize: 8,
  /** Default timeout for worker operations (ms) */
  defaultTimeoutMs: 30000,
  /** Maximum compute operations in flight per analysis */
  maxComputeInFlight: 8
};

/**
 * Preset configurations for common scenarios
 * @type {Object}
 */
const PRESETS = {
  /** Conservative settings for low-memory devices */
  lowMemory: {
    name: 'Low Memory',
    description: 'For devices with limited RAM (< 4GB)',
    preloadCount: 20,
    memoryBudgetMB: 256,
    networkConcurrency: 4,
    maxComputeInFlight: 4
  },
  /** Balanced settings for typical usage */
  balanced: {
    name: 'Balanced',
    description: 'Good balance of speed and memory (4-8GB RAM)',
    preloadCount: 100,
    memoryBudgetMB: 512,
    networkConcurrency: 6,
    maxComputeInFlight: 6
  },
  /** High performance settings for powerful devices */
  highPerformance: {
    name: 'High Performance',
    description: 'Maximum speed on high-end devices (16GB+ RAM)',
    preloadCount: 200,
    memoryBudgetMB: 1024,
    networkConcurrency: 8,
    maxComputeInFlight: 8
  },
  /** Maximum performance (use with caution) */
  maximum: {
    name: 'Maximum',
    description: 'Aggressive settings (32GB+ RAM, may cause slowdowns)',
    preloadCount: 500,
    memoryBudgetMB: 2048,
    networkConcurrency: 10,
    maxComputeInFlight: 8
  }
};

// =============================================================================
// PERFORMANCE CONFIG CLASS
// =============================================================================

/**
 * Performance configuration manager
 *
 * Provides methods to get, set, and compute optimal performance settings
 * based on dataset characteristics and available system resources.
 *
 * @example
 * // Get recommended settings for a dataset
 * const settings = PerformanceConfig.getRecommendedSettings(1000000, 20000);
 * console.log(settings.preloadCount); // e.g., 100
 * console.log(settings.estimatedTimeMinutes); // e.g., 8
 *
 * @example
 * // Override default settings
 * PerformanceConfig.setDefaults({ defaultBudgetMB: 1024 });
 */
class PerformanceConfigManager {
  constructor() {
    /** @type {Object} Current memory configuration */
    this.memory = { ...MEMORY_DEFAULTS };

    /** @type {Object} Current batch configuration */
    this.batch = { ...BATCH_DEFAULTS };

    /** @type {Object} Current worker configuration */
    this.worker = { ...WORKER_DEFAULTS };

    /** @type {Object} Available presets */
    this.presets = PRESETS;
  }

  // ===========================================================================
  // CONFIGURATION METHODS
  // ===========================================================================

  /**
   * Update memory configuration
   * @param {Partial<typeof MEMORY_DEFAULTS>} overrides - Values to override
   */
  setMemoryConfig(overrides) {
    this.memory = { ...this.memory, ...overrides };
  }

  /**
   * Update batch configuration
   * @param {Partial<typeof BATCH_DEFAULTS>} overrides - Values to override
   */
  setBatchConfig(overrides) {
    this.batch = { ...this.batch, ...overrides };
  }

  /**
   * Update worker configuration
   * @param {Partial<typeof WORKER_DEFAULTS>} overrides - Values to override
   */
  setWorkerConfig(overrides) {
    this.worker = { ...this.worker, ...overrides };
  }

  /**
   * Apply a preset configuration
   * @param {'lowMemory' | 'balanced' | 'highPerformance' | 'maximum'} presetName
   */
  applyPreset(presetName) {
    const preset = this.presets[presetName];
    if (!preset) {
      console.warn(`[PerformanceConfig] Unknown preset: ${presetName}`);
      return;
    }

    this.batch.defaultPreloadCount = preset.preloadCount;
    this.memory.defaultBudgetMB = preset.memoryBudgetMB;
    this.batch.networkConcurrency = preset.networkConcurrency;
    this.worker.maxComputeInFlight = preset.maxComputeInFlight;
  }

  /**
   * Reset all configuration to defaults
   */
  resetToDefaults() {
    this.memory = { ...MEMORY_DEFAULTS };
    this.batch = { ...BATCH_DEFAULTS };
    this.worker = { ...WORKER_DEFAULTS };
  }

  // ===========================================================================
  // COMPUTATION METHODS
  // ===========================================================================

  /**
   * Get recommended performance settings based on dataset characteristics
   *
   * Analyzes the dataset size and computes optimal settings that balance
   * performance with memory constraints.
   *
   * @param {number} cellCount - Total number of cells in dataset
   * @param {number} geneCount - Total number of genes to process
   * @param {Object} [options] - Additional options
   * @param {string} [options.method='wilcox'] - Statistical method ('wilcox' | 'ttest')
   * @param {number} [options.availableMemoryMB] - Available memory (if known)
   * @returns {RecommendedSettings} Recommended settings object
   *
   * @typedef {Object} RecommendedSettings
   * @property {number} preloadCount - Recommended genes to preload per batch
   * @property {number} memoryBudgetMB - Recommended memory budget
   * @property {number} networkConcurrency - Recommended parallel network requests
   * @property {number} maxComputeInFlight - Recommended parallel compute operations
   * @property {number} bytesPerGene - Memory per gene (bytes)
   * @property {number} totalDataMB - Total data size estimate (MB)
   * @property {number} estimatedTimeMinutes - Estimated processing time
   * @property {string} presetMatch - Which preset best matches these settings
   * @property {string} explanation - Human-readable explanation
   */
  getRecommendedSettings(cellCount, geneCount, options = {}) {
    const { method = 'wilcox', availableMemoryMB = null } = options;

    // Calculate data characteristics
    const bytesPerGene = cellCount * this.memory.bytesPerFloat32;
    const bytesPerGeneMB = bytesPerGene / (1024 * 1024);
    const totalDataMB = bytesPerGeneMB * geneCount;

    // Overhead factor based on method
    const overheadFactor = method === 'wilcox'
      ? this.memory.wilcoxonOverheadFactor
      : this.memory.ttestOverheadFactor;

    // Memory per gene in-flight (including overhead)
    const memoryPerGeneInFlightMB = bytesPerGeneMB * overheadFactor;

    // Calculate available memory budget
    let effectiveBudgetMB = this.memory.defaultBudgetMB;
    if (availableMemoryMB !== null) {
      effectiveBudgetMB = Math.min(
        availableMemoryMB * this.memory.safetyMargin,
        this.memory.maxBudgetMB
      );
    }

    // Calculate optimal preload count based on memory
    // We want to keep memoryPerGeneInFlightMB * preloadCount < effectiveBudgetMB
    let recommendedPreload = Math.floor(effectiveBudgetMB / memoryPerGeneInFlightMB);

    // Clamp to reasonable bounds
    recommendedPreload = Math.max(
      this.batch.minPreloadCount,
      Math.min(recommendedPreload, this.batch.maxPreloadCount)
    );

    // Scale down for very large datasets (> 500K cells)
    const cellsM = cellCount / 1_000_000;
    if (cellsM > 0.5) {
      recommendedPreload = Math.max(
        this.batch.minPreloadCount,
        Math.floor(recommendedPreload / Math.sqrt(cellsM * 2))
      );
    }

    // Determine network concurrency
    let networkConcurrency = this.batch.networkConcurrency;
    // Reduce concurrency for very large genes to avoid network saturation
    if (bytesPerGeneMB > 10) {
      networkConcurrency = Math.max(2, Math.floor(networkConcurrency / 2));
    }

    // Determine compute parallelism
    const maxComputeInFlight = Math.min(
      this.worker.maxComputeInFlight,
      recommendedPreload
    );

    // Estimate processing time
    // Rough estimate: network latency + compute time
    const avgNetworkTimeMs = 100; // Conservative network time per gene
    const avgComputeTimeMs = method === 'wilcox' ? 50 : 20; // Wilcoxon is slower
    const effectiveParallelism = Math.min(networkConcurrency, maxComputeInFlight);
    const estimatedTotalMs = (geneCount / effectiveParallelism) *
      (avgNetworkTimeMs + avgComputeTimeMs);
    const estimatedTimeMinutes = Math.ceil(estimatedTotalMs / 60000);

    // Determine which preset best matches
    let presetMatch = 'balanced';
    if (recommendedPreload <= 30) presetMatch = 'lowMemory';
    else if (recommendedPreload >= 200) presetMatch = 'highPerformance';
    else if (recommendedPreload >= 400) presetMatch = 'maximum';

    // Generate explanation
    const explanation = this._generateExplanation({
      cellCount,
      geneCount,
      bytesPerGeneMB,
      recommendedPreload,
      effectiveBudgetMB,
      estimatedTimeMinutes
    });

    return {
      // Core settings
      preloadCount: recommendedPreload,
      memoryBudgetMB: Math.round(effectiveBudgetMB),
      networkConcurrency,
      maxComputeInFlight,

      // Data characteristics
      bytesPerGene,
      bytesPerGeneMB: Math.round(bytesPerGeneMB * 100) / 100,
      totalDataMB: Math.round(totalDataMB),
      memoryPerGeneInFlightMB: Math.round(memoryPerGeneInFlightMB * 100) / 100,

      // Estimates
      estimatedTimeMinutes,
      estimatedTimeFormatted: this._formatTime(estimatedTimeMinutes * 60),

      // Metadata
      presetMatch,
      explanation,
      method
    };
  }

  /**
   * Calculate memory requirements for a batch operation
   *
   * @param {number} cellCount - Cells per gene
   * @param {number} batchSize - Number of genes in batch
   * @param {string} [method='wilcox'] - Statistical method
   * @returns {Object} Memory estimate
   */
  estimateBatchMemory(cellCount, batchSize, method = 'wilcox') {
    const bytesPerGene = cellCount * this.memory.bytesPerFloat32;
    const overheadFactor = method === 'wilcox'
      ? this.memory.wilcoxonOverheadFactor
      : this.memory.ttestOverheadFactor;

    const rawDataMB = (bytesPerGene * batchSize) / (1024 * 1024);
    const withOverheadMB = rawDataMB * overheadFactor;

    return {
      rawDataMB: Math.round(rawDataMB * 100) / 100,
      withOverheadMB: Math.round(withOverheadMB * 100) / 100,
      bytesPerGene,
      batchSize,
      overheadFactor
    };
  }

  /**
   * Validate that proposed settings are safe for the given data
   *
   * @param {Object} settings - Proposed settings
   * @param {number} settings.preloadCount
   * @param {number} settings.memoryBudgetMB
   * @param {number} cellCount - Cells in dataset
   * @param {string} [method='wilcox'] - Statistical method
   * @returns {Object} Validation result
   */
  validateSettings(settings, cellCount, method = 'wilcox') {
    const { preloadCount, memoryBudgetMB } = settings;
    const estimate = this.estimateBatchMemory(cellCount, preloadCount, method);

    const isValid = estimate.withOverheadMB <= memoryBudgetMB;
    const warnings = [];
    const errors = [];

    if (!isValid) {
      errors.push(
        `Batch memory (${estimate.withOverheadMB}MB) exceeds budget (${memoryBudgetMB}MB). ` +
        `Reduce batch size to ${Math.floor(preloadCount * (memoryBudgetMB / estimate.withOverheadMB))} or increase budget.`
      );
    }

    if (preloadCount > 300 && cellCount > 500000) {
      warnings.push(
        'Large batch size with many cells may cause browser slowdown. ' +
        'Consider reducing batch size.'
      );
    }

    if (memoryBudgetMB > 2048) {
      warnings.push(
        'Very high memory budget may exhaust browser limits. ' +
        'Monitor browser memory during analysis.'
      );
    }

    return {
      isValid,
      warnings,
      errors,
      estimatedMemoryMB: estimate.withOverheadMB,
      suggestedPreloadCount: isValid
        ? preloadCount
        : Math.floor(preloadCount * (memoryBudgetMB / estimate.withOverheadMB) * 0.9)
    };
  }

  // ===========================================================================
  // HELPER METHODS
  // ===========================================================================

  /**
   * Generate human-readable explanation of settings
   * @private
   */
  _generateExplanation(params) {
    const { cellCount, geneCount, bytesPerGeneMB, recommendedPreload, effectiveBudgetMB, estimatedTimeMinutes } = params;

    const parts = [
      `Dataset: ${(cellCount / 1000).toFixed(0)}K cells, ${geneCount.toLocaleString()} genes.`,
      `Each gene requires ~${bytesPerGeneMB.toFixed(1)}MB.`,
      `Recommended: ${recommendedPreload} genes/batch within ${effectiveBudgetMB}MB budget.`,
      `Estimated time: ~${estimatedTimeMinutes} minute${estimatedTimeMinutes !== 1 ? 's' : ''}.`
    ];

    return parts.join(' ');
  }

  /**
   * Format seconds into human-readable time
   * @private
   */
  _formatTime(seconds) {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    if (minutes < 60) return `${minutes}m ${secs}s`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  }

  /**
   * Get UI-friendly options for batch size selector
   * @param {number} cellCount - Cells in dataset
   * @param {number} geneCount - Genes in dataset
   * @returns {Array<{value: number, label: string, recommended: boolean}>}
   */
  getBatchSizeOptions(cellCount, geneCount) {
    const recommended = this.getRecommendedSettings(cellCount, geneCount);
    const options = [
      { value: 50, label: '50 genes (minimal memory)' },
      { value: 100, label: '100 genes' },
      { value: 200, label: '200 genes' },
      { value: 500, label: '500 genes' },
      { value: 1000, label: '1000 genes (max prefetch)' }
    ];

    // Mark recommended option
    let bestMatch = options[2]; // default to 100
    let bestDiff = Infinity;
    for (const opt of options) {
      const diff = Math.abs(opt.value - recommended.preloadCount);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestMatch = opt;
      }
    }
    bestMatch.recommended = true;
    bestMatch.label += ' (recommended)';

    return options;
  }

  /**
   * Get UI-friendly options for memory budget selector
   * @returns {Array<{value: number, label: string}>}
   */
  getMemoryBudgetOptions() {
    return [
      { value: 256, label: '256 MB (conservative)' },
      { value: 512, label: '512 MB (balanced)' },
      { value: 1024, label: '1 GB' },
      { value: 2048, label: '2 GB' },
      { value: 4096, label: '4 GB (fast)' },
      { value: 8192, label: '8 GB (maximum)' }
    ];
  }

  /**
   * Get UI-friendly options for network concurrency selector
   * @param {number} [recommendedValue] - Recommended concurrency value
   * @returns {Array<{value: number, label: string, recommended?: boolean}>}
   */
  getNetworkConcurrencyOptions(recommendedValue = 6) {
    const options = [
      { value: 4, label: '4 parallel (conservative)' },
      { value: 6, label: '6 parallel (balanced)' },
      { value: 10, label: '10 parallel (fast)' },
      { value: 20, label: '20 parallel (aggressive)' },
      { value: 50, label: '50 parallel (maximum)' }
    ];

    // Mark recommended option
    for (const opt of options) {
      if (opt.value === recommendedValue || (opt.value <= recommendedValue && options.find(o => o.value > recommendedValue)?.value !== opt.value)) {
        opt.recommended = true;
        opt.label += ' (recommended)';
        break;
      }
    }

    return options;
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

/** @type {PerformanceConfigManager|null} */
let instance = null;

/**
 * Get the singleton PerformanceConfig instance
 * @returns {PerformanceConfigManager}
 */
export function getPerformanceConfig() {
  if (!instance) {
    instance = new PerformanceConfigManager();
  }
  return instance;
}

/**
 * Shorthand access to PerformanceConfig
 * @type {PerformanceConfigManager}
 */
export const PerformanceConfig = {
  get memory() { return getPerformanceConfig().memory; },
  get batch() { return getPerformanceConfig().batch; },
  get worker() { return getPerformanceConfig().worker; },
  get presets() { return getPerformanceConfig().presets; },

  setMemoryConfig: (o) => getPerformanceConfig().setMemoryConfig(o),
  setBatchConfig: (o) => getPerformanceConfig().setBatchConfig(o),
  setWorkerConfig: (o) => getPerformanceConfig().setWorkerConfig(o),
  applyPreset: (p) => getPerformanceConfig().applyPreset(p),
  resetToDefaults: () => getPerformanceConfig().resetToDefaults(),

  getRecommendedSettings: (c, g, o) => getPerformanceConfig().getRecommendedSettings(c, g, o),
  estimateBatchMemory: (c, b, m) => getPerformanceConfig().estimateBatchMemory(c, b, m),
  validateSettings: (s, c, m) => getPerformanceConfig().validateSettings(s, c, m),
  getBatchSizeOptions: (c, g) => getPerformanceConfig().getBatchSizeOptions(c, g),
  getMemoryBudgetOptions: () => getPerformanceConfig().getMemoryBudgetOptions(),
  getNetworkConcurrencyOptions: (r) => getPerformanceConfig().getNetworkConcurrencyOptions(r)
};

export default PerformanceConfig;
