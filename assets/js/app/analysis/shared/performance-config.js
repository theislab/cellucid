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

import { residencyBudgetBytes } from '../../../data/memory-budget.js';

// =============================================================================
// HARDWARE
// =============================================================================

/**
 * Analysis workers to run: one per core, less one core for the page and one
 * for the AnnData reader worker that feeds them — the same rule the reader's
 * decode pool follows (formats/io/decode-pool.js). A browser that does not
 * report its cores is taken to have four, as the decode pool takes it.
 *
 * @param {Object} [environment] - `globalThis`, or a stand-in in tests
 * @returns {number}
 */
export function analysisWorkerCount(environment = globalThis) {
  const reported = environment?.navigator?.hardwareConcurrency;
  const cores = Number.isSafeInteger(reported) && reported > 0 ? reported : 4;
  return Math.max(1, cores - 2);
}

/**
 * The default memory budget of a bulk analysis run, in MB: the `analysis`
 * share of the app's memory allowance (data/memory-budget.js), a sixteenth
 * of the estimated device memory (512 MB on an 8 GiB device, 896 MB on a
 * 16 GiB Mac whose Chromium reports a 3.76 GB heap limit).
 *
 * @param {Object} [environment]
 * @returns {number}
 */
export function analysisMemoryBudgetMB(environment = globalThis) {
  return Math.round(residencyBudgetBytes('analysis', environment) / 2 ** 20);
}

// =============================================================================
// DEFAULT CONFIGURATION VALUES
// =============================================================================

/**
 * Memory configuration defaults (in MB unless otherwise noted)
 * @type {Object}
 */
const MEMORY_DEFAULTS = {
  /** Default memory budget for batch operations (MB): see analysisMemoryBudgetMB */
  defaultBudgetMB: analysisMemoryBudgetMB(),
  /** Percentage of heap usage that triggers a warning */
  warningThresholdPercent: 75,
  /** Percentage of heap usage that triggers cleanup */
  cleanupThresholdPercent: 85,
  /** Percentage of heap usage that triggers critical cleanup */
  criticalThresholdPercent: 95
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
  /**
   * Number of field and gene loads a run keeps in flight at once.
   *
   * The AnnData reader reads the loads asked for together as one batch of
   * coalesced range requests, so a run that awaited each load before asking
   * for the next would pay one round trip per gene on a remote file. Twelve
   * keeps a batch large enough to cover a round trip while a decoded gene (4
   * bytes per cell) stays a small share of memory.
   */
  networkConcurrency: 12
};

/**
 * Worker pool configuration defaults
 * @type {Object}
 */
const WORKER_DEFAULTS = {
  /** Analysis workers (see analysisWorkerCount) */
  poolSize: analysisWorkerCount(),
  /** Default timeout for worker operations (ms) */
  defaultTimeoutMs: 30000
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
    networkConcurrency: 6
  },
  /** Balanced settings for typical usage */
  balanced: {
    name: 'Balanced',
    description: 'Good balance of speed and memory (4-8GB RAM)',
    preloadCount: 100,
    memoryBudgetMB: 512,
    networkConcurrency: 12
  },
  /** High performance settings for powerful devices */
  highPerformance: {
    name: 'High Performance',
    description: 'Maximum speed on high-end devices (16GB+ RAM)',
    preloadCount: 200,
    memoryBudgetMB: 1024,
    networkConcurrency: 16
  },
  /** Maximum performance (use with caution) */
  maximum: {
    name: 'Maximum',
    description: 'Aggressive settings (32GB+ RAM, may cause slowdowns)',
    preloadCount: 500,
    memoryBudgetMB: 2048,
    networkConcurrency: 24
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
 *
 * @example
 * // Override default settings
 * PerformanceConfig.setMemoryConfig({ defaultBudgetMB: 1024 });
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
      throw new Error(
        `[PerformanceConfig] Unknown preset "${String(presetName)}"`
      );
    }

    this.batch.defaultPreloadCount = preset.preloadCount;
    this.memory.defaultBudgetMB = preset.memoryBudgetMB;
    this.batch.networkConcurrency = preset.networkConcurrency;
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
   * Recommended settings of a bulk gene run over a dataset.
   *
   * A gene in flight is one column of 4 bytes per cell on its way to an
   * analysis worker, whatever the test (the kernels keep their own reused
   * space per worker), so the number of genes the budget holds ahead is the
   * budget over one column, within the batch bounds. Compute parallelism is
   * one gene per analysis worker.
   *
   * @param {number} cellCount - Total number of cells in dataset
   * @param {number} geneCount - Total number of genes to process
   * @returns {{preloadCount: number, memoryBudgetMB: number, networkConcurrency: number, maxComputeInFlight: number, bytesPerGene: number}}
   */
  getRecommendedSettings(cellCount, geneCount) {
    if (!Number.isSafeInteger(cellCount) || cellCount <= 0) {
      throw new RangeError(
        'PerformanceConfig cellCount must be a positive integer'
      );
    }
    if (!Number.isSafeInteger(geneCount) || geneCount <= 0) {
      throw new RangeError(
        'PerformanceConfig geneCount must be a positive integer'
      );
    }
    const bytesPerGene = cellCount * 4;
    const memoryBudgetMB = this.memory.defaultBudgetMB;
    const byMemory = Math.floor((memoryBudgetMB * 1024 * 1024) / bytesPerGene);
    const preloadCount = Math.max(
      this.batch.minPreloadCount,
      Math.min(byMemory, this.batch.maxPreloadCount)
    );
    return {
      preloadCount,
      memoryBudgetMB,
      networkConcurrency: this.batch.networkConcurrency,
      maxComputeInFlight: this.worker.poolSize,
      bytesPerGene
    };
  }

  // ===========================================================================
  // HELPER METHODS
  // ===========================================================================

  /**
   * Get UI-friendly options for batch size selector
   * @param {number} cellCount - Cells in dataset
   * @param {number} geneCount - Genes in dataset
   * @returns {Array<{value: number, label: string, selected?: boolean}>}
   */
  getBatchSizeOptions(cellCount, geneCount) {
    const recommended = this.getRecommendedSettings(
      cellCount,
      geneCount
    ).preloadCount;
    const values = [...new Set([
      this.batch.minPreloadCount,
      20,
      50,
      100,
      200,
      this.batch.maxPreloadCount,
      recommended
    ])]
      .filter(
        value =>
          Number.isSafeInteger(value) &&
          value >= this.batch.minPreloadCount &&
          value <= this.batch.maxPreloadCount
      )
      .sort((a, b) => a - b);

    return values.map(value => ({
      value,
      label: value === recommended
        ? `${value} genes (recommended)`
        : `${value} genes`,
      selected: value === recommended
    }));
  }

  /**
   * Get UI-friendly options for memory budget selector: a thirty-second up to
   * half of the memory the browser reports for the device (256 MB to 4 GB at
   * the 8 GiB Chromium reports at most), always including the default.
   * @returns {Array<{value: number, label: string, selected?: boolean}>}
   */
  getMemoryBudgetOptions() {
    const deviceMB = analysisMemoryBudgetMB() * 16;
    const values = [...new Set([
      ...[32, 16, 8, 4, 2].map(divisor => Math.round(deviceMB / divisor)),
      this.memory.defaultBudgetMB
    ])].sort((a, b) => a - b);
    return values.map(value => ({
      value,
      label: value < 1024 ? `${value} MB` : `${+(value / 1024).toFixed(1)} GB`,
      selected: value === this.memory.defaultBudgetMB
    }));
  }

  /**
   * Get UI-friendly options for network concurrency selector
   * @returns {Array<{value: number, label: string, selected?: boolean}>}
   */
  getNetworkConcurrencyOptions() {
    return [2, 4, 6, 12, 16, 24].map(value => ({
      value,
      label: `${value} parallel`,
      selected: value === this.batch.networkConcurrency
    }));
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

  getRecommendedSettings: (c, g) => getPerformanceConfig().getRecommendedSettings(c, g),
  getBatchSizeOptions: (c, g) => getPerformanceConfig().getBatchSizeOptions(c, g),
  getMemoryBudgetOptions: () => getPerformanceConfig().getMemoryBudgetOptions(),
  getNetworkConcurrencyOptions: (r) => getPerformanceConfig().getNetworkConcurrencyOptions(r)
};
