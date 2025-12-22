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
// CONCURRENCY
// =============================================================================

export {
  waitForAvailableSlot
} from './concurrency-utils.js';

// =============================================================================
// PLOT REGISTRY (centralized wrapper)
// =============================================================================

export { PlotRegistry } from './plot-registry-utils.js';

// =============================================================================
// NUMBER UTILITIES
// =============================================================================

export {
  isFiniteNumber,
  mean,
  variance,
  std,
  median,
  computeStats,
  filterFiniteNumbers,
  getFiniteMinMax
} from './number-utils.js';

// =============================================================================
// ANALYSIS UTILITIES
// =============================================================================

export {
  runAnalysisWithLoadingState,
  createLoadingState,
  validatePageRequirements,
  getRequirementText,
  toCSVCell,
  downloadCSV,
  pageDataToCSV,
  deResultsToCSV,
  signatureScoresToCSV,
  correlationResultsToCSV,
  getFormValues,
  getTypedFormValues,
  computeBasicStats,
  computeEffectSize,
  resolvePageNames,
  getPageInfo
} from './analysis-utils.js';

// =============================================================================
// DEBUG UTILITIES
// =============================================================================

export {
  enableDebug,
  disableDebug,
  debug,
  debugWarn,
  debugError,
  debugGroup,
  debugTime,
  debugMeasure,
  debugOnly,
  debugInspect
} from './debug-utils.js';

// =============================================================================
// ERROR HANDLING
// =============================================================================

export {
  AnalysisError,
  DataError,
  ComputeError,
  CancelledError,
  TimeoutError,
  ERROR_MESSAGES,
  getErrorMessage,
  isCancellationError,
  isTimeoutError,
  formatErrorForUser,
  handleError,
  wrapAsync,
  tryAsync,
  withTimeout,
  retry
} from './error-utils.js';

// =============================================================================
// CANCELLABLE OPERATIONS
// =============================================================================

export {
  OperationContext,
  CancellableOperation,
  OperationManager,
  createOperationContext,
  withCancellation,
  createRequestIdTracker
} from './cancellable-operation.js';

// =============================================================================
// RESULT RENDERING
// =============================================================================

export {
  renderStatsGrid,
  renderDESummaryStats,
  renderSignatureSummaryStats,
  renderDataTable,
  renderDEGenesTable,
  renderResultSection,
  createPlotContainer,
  renderGeneChips,
  renderDEResults,
  renderSignatureResults
} from './result-renderer.js';

// =============================================================================
// MATRIX UTILITIES
// =============================================================================

export {
  zscoreRowwise,
  log1pTransform,
  computeDistanceMatrix,
  correlationMatrix,
  euclideanDistanceMatrix,
  cosineDistanceMatrix,
  reorderRows,
  reorderCols,
  transposeMatrix,
  TRANSFORM_TYPES,
  DISTANCE_TYPES
} from './matrix-utils.js';
