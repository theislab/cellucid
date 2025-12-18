/**
 * Transform Pipeline for Page Analysis
 *
 * Provides chainable data transformations before plotting.
 * Uses the unified TransformPluginRegistry from plugin-contract.js
 * for transform execution with automatic backend selection (GPU > Worker > CPU).
 *
 * This module provides:
 * - TransformPipeline class for chainable transforms
 * - Legacy TRANSFORMS object (for backward compatibility)
 * - Pipeline initialization and configuration
 */

import { getTransformRegistry } from '../core/plugin-contract.js';
import { initTransformRegistry, BUILTIN_TRANSFORMS } from '../core/transform-registry.js';

// =============================================================================
// LEGACY TRANSFORMS OBJECT (for backward compatibility)
// =============================================================================

/**
 * Legacy TRANSFORMS object
 * Maps transform IDs to their definitions for backward compatibility.
 * New code should use the registry directly via getTransformRegistry().
 */
const TRANSFORMS = {};

// Populate TRANSFORMS from built-in definitions
for (const t of BUILTIN_TRANSFORMS) {
  TRANSFORMS[t.id] = {
    id: t.id,
    name: t.name,
    description: t.description,
    applicableTo: t.supportedTypes,
    defaultOptions: t.defaultOptions,

    // Wrap execute as apply for legacy compatibility
    apply(data, options = {}, cellIndices = null) {
      const registry = getTransformRegistry();
      const mergedOpts = { ...t.defaultOptions, ...options };

      // Synchronous wrapper - transforms that need async should use registry.execute()
      // For legacy sync API, we run the execute function directly with CPU backend
      const context = { backend: 'cpu', registry };
      const dataWithIndices = cellIndices ? { ...data, cellIndices } : data;

      // Note: This is a sync shim. For async transforms, use the registry directly.
      return t.execute(dataWithIndices, mergedOpts, context);
    }
  };
}

// =============================================================================
// TRANSFORM PIPELINE CLASS
// =============================================================================

/**
 * Transform Pipeline class
 * Provides a chainable API for applying multiple transforms to data.
 */
export class TransformPipeline {
  constructor() {
    this.steps = [];
    this._registry = null;
  }

  /**
   * Get the transform registry
   * @returns {import('./plugin-contract.js').TransformPluginRegistry}
   */
  _getRegistry() {
    if (!this._registry) {
      this._registry = getTransformRegistry();
    }
    return this._registry;
  }

  /**
   * Register a custom transform
   * @param {string} id - Transform identifier
   * @param {Object} transform - Transform definition
   * @deprecated Use getTransformRegistry().register() instead
   */
  static registerTransform(id, transform) {
    const registry = getTransformRegistry();
    registry.register({
      id,
      name: transform.name || id,
      description: transform.description || '',
      supportedTypes: transform.applicableTo || transform.supportedTypes || ['any'],
      defaultOptions: transform.defaultOptions || {},
      optionSchema: transform.optionSchema || {},
      execute: transform.execute || (async (data, opts) => transform.apply(data, opts))
    });

    // Also add to legacy TRANSFORMS for compatibility
    TRANSFORMS[id] = transform;
  }

  /**
   * Get a transform by ID
   * @param {string} id - Transform identifier
   * @returns {Object|null}
   */
  static getTransform(id) {
    // First check registry
    const registry = getTransformRegistry();
    const plugin = registry.get(id);
    if (plugin) {
      return {
        ...plugin,
        applicableTo: plugin.supportedTypes,
        apply(data, options = {}, cellIndices = null) {
          const mergedOpts = { ...plugin.defaultOptions, ...options };
          const context = { backend: 'cpu', registry };
          const dataWithIndices = cellIndices ? { ...data, cellIndices } : data;
          return plugin.execute(dataWithIndices, mergedOpts, context);
        }
      };
    }

    // Fallback to legacy TRANSFORMS
    return TRANSFORMS[id] || null;
  }

  /**
   * Get all available transforms
   * @returns {Object[]}
   */
  static getAllTransforms() {
    const registry = getTransformRegistry();
    return registry.getAll().map(plugin => ({
      ...plugin,
      applicableTo: plugin.supportedTypes
    }));
  }

  /**
   * Add a transform step to the pipeline
   * @param {string} type - Transform type identifier
   * @param {Object} options - Transform options
   * @returns {TransformPipeline} - For chaining
   */
  add(type, options = {}) {
    const registry = this._getRegistry();
    const plugin = registry.get(type);

    if (!plugin) {
      console.warn(`[TransformPipeline] Unknown transform: ${type}`);
      return this;
    }

    this.steps.push({
      type,
      options: { ...plugin.defaultOptions, ...options },
      enabled: true
    });

    return this;
  }

  /**
   * Remove last transform step
   * @returns {TransformPipeline}
   */
  pop() {
    this.steps.pop();
    return this;
  }

  /**
   * Clear all steps
   * @returns {TransformPipeline}
   */
  clear() {
    this.steps = [];
    return this;
  }

  /**
   * Apply the pipeline to data (synchronous, uses CPU)
   * For async execution with GPU support, use applyAsync()
   * @param {Object} data - Input data object with values array
   * @returns {Object} - Transformed data
   */
  apply(data) {
    const registry = this._getRegistry();

    // Create a deep copy of the data to avoid mutating the original
    let current = {
      ...data,
      values: [...data.values],
      cellIndices: data.cellIndices ? [...data.cellIndices] : null,
      variableInfo: data.variableInfo ? { ...data.variableInfo } : null
    };
    let accumulatedMetadata = {};

    for (const step of this.steps) {
      if (step.enabled === false) continue;

      const plugin = registry.get(step.type);
      if (!plugin) continue;

      // Synchronous execution with CPU backend
      const context = { backend: 'cpu', registry };
      const resultPromise = plugin.execute(current, step.options, context);

      // Handle both sync and async results
      let result;
      if (resultPromise && typeof resultPromise.then === 'function') {
        // This is async - for sync apply(), we need to handle this differently
        // For now, log a warning and skip
        console.warn(`[TransformPipeline] Transform '${step.type}' is async. Use applyAsync() for full support.`);
        continue;
      } else {
        result = resultPromise;
      }

      // Merge result into current data
      if (result) {
        current.values = result.values;
        if (result.cellIndices !== undefined) {
          current.cellIndices = result.cellIndices;
        }
        if (Array.isArray(result.values)) {
          current.cellCount = result.values.length;
        }
        if (result.metadata) {
          accumulatedMetadata = { ...accumulatedMetadata, ...result.metadata };
          if (result.metadata.kind) {
            current.variableInfo = {
              ...current.variableInfo,
              kind: result.metadata.kind
            };
          }
        }
      }
    }

    current.transformMetadata = accumulatedMetadata;
    return current;
  }

  /**
   * Apply the pipeline to data (async, with GPU/Worker support)
   * Uses the registry's execute() method for automatic backend selection.
   * @param {Object} data - Input data object with values array
   * @returns {Promise<Object>} - Transformed data
   */
  async applyAsync(data) {
    const registry = this._getRegistry();

    // Ensure registry is initialized
    if (!registry._initialized) {
      await registry.init();
    }

    // Create a deep copy of the data to avoid mutating the original
    let current = {
      ...data,
      values: [...data.values],
      cellIndices: data.cellIndices ? [...data.cellIndices] : null,
      variableInfo: data.variableInfo ? { ...data.variableInfo } : null
    };
    let accumulatedMetadata = {};

    for (const step of this.steps) {
      if (step.enabled === false) continue;

      try {
        // Use registry.execute() for automatic backend selection
        const result = await registry.execute(step.type, current, step.options);

        // Merge result into current data
        current.values = result.values;
        if (result.cellIndices !== undefined) {
          current.cellIndices = result.cellIndices;
        }
        if (Array.isArray(result.values)) {
          current.cellCount = result.values.length;
        }
        if (result.metadata) {
          accumulatedMetadata = { ...accumulatedMetadata, ...result.metadata };
          if (result.metadata.kind) {
            current.variableInfo = {
              ...current.variableInfo,
              kind: result.metadata.kind
            };
          }
        }
        if (result._meta) {
          accumulatedMetadata._execInfo = accumulatedMetadata._execInfo || [];
          accumulatedMetadata._execInfo.push(result._meta);
        }
      } catch (err) {
        console.error(`[TransformPipeline] Error in transform '${step.type}':`, err);
        throw err;
      }
    }

    current.transformMetadata = accumulatedMetadata;
    return current;
  }

  /**
   * Serialize pipeline to config object
   * @returns {Array<{type: string, options: Object}>}
   */
  toConfig() {
    return this.steps.map(step => ({ ...step }));
  }

  /**
   * Create pipeline from config
   * @param {Array<{type: string, options: Object}>} config
   * @returns {TransformPipeline}
   */
  static fromConfig(config) {
    const pipeline = new TransformPipeline();
    if (Array.isArray(config)) {
      for (const step of config) {
        pipeline.add(step.type, step.options);
      }
    }
    return pipeline;
  }

  /**
   * Clone the pipeline
   * @returns {TransformPipeline}
   */
  clone() {
    return TransformPipeline.fromConfig(this.toConfig());
  }
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create a new transform pipeline
 * @returns {TransformPipeline}
 */
export function createTransformPipeline() {
  return new TransformPipeline();
}

/**
 * Initialize the transform pipeline system
 * Call this before using transforms to ensure backends are detected
 * and built-in transforms are registered.
 * @returns {Promise<import('./plugin-contract.js').TransformPluginRegistry>}
 */
export async function initTransformPipeline() {
  return initTransformRegistry();
}

/**
 * Get backend availability status from the registry
 * @returns {Object} { gpuAvailable, workerAvailable }
 */
export function getBackendStatus() {
  const registry = getTransformRegistry();
  return {
    checked: registry._initialized,
    gpuAvailable: registry.isGPUAvailable(),
    workerAvailable: registry.isWorkerAvailable()
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

export { TRANSFORMS };

export default TransformPipeline;
