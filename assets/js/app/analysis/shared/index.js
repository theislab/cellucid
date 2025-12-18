/**
 * Shared Utilities - Analysis Module
 *
 * Common utilities used across the analysis module.
 * Import from here for clean access to shared functionality.
 *
 * @module shared
 */

// =============================================================================
// TYPE DEFINITIONS (JSDoc types for IDE support)
// =============================================================================

// Types are defined in types.js - import them for JSDoc references
// Usage: @type {import('./shared/types.js').VariableInfo}
export { Types } from './types.js';

// =============================================================================
// CACHING
// =============================================================================

export {
  LRUCache,
  createLRUCache
} from './lru-cache.js';

// =============================================================================
// FORMATTING (centralized, replaces duplicates in math-utils and dom-utils)
// =============================================================================

export {
  // Number formatting
  formatNumber,
  formatFixed,
  formatCount,
  formatPercent,
  // P-value formatting
  formatPValue,
  formatPValueExponential,
  formatPValueWithStars,
  getSignificanceStars,
  getSignificanceMarker,
  getSignificanceClass,
  // Effect size
  formatEffectSize,
  getEffectSizeInterpretation,
  // Fold change
  formatFoldChange,
  formatLog2FoldChange,
  // Other
  formatConfidenceInterval,
  formatRange,
  formatDuration,
  formatBytes
} from './formatting.js';

// =============================================================================
// DOM UTILITIES (centralized location)
// =============================================================================

export {
  NONE_VALUE,
  getCellCountForPage,
  createLabeledContainer,
  createSelect,
  createButton,
  createCheckbox,
  createRangeSlider,
  clearElement,
  addClass,
  removeClass,
  toggleClass,
  setStyles,
  addListener,
  debounce,
  throttle
} from './dom-utils.js';

// Default export for convenience
import domUtils from './dom-utils.js';
export { domUtils };

// =============================================================================
// MEMORY MONITORING
// =============================================================================

export {
  MemoryMonitor,
  getMemoryMonitor,
  createMemoryMonitor,
  THRESHOLDS as MEMORY_THRESHOLDS,
  INTERVALS as MEMORY_INTERVALS
} from './memory-monitor.js';

// =============================================================================
// PLOT REGISTRY (centralized wrapper)
// =============================================================================

export { PlotRegistry } from './plot-registry-utils.js';
