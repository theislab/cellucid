/**
 * Analysis Module - Main Entry Point
 *
 * This module provides a unified interface for all analysis functionality.
 * Import from here for clean, organized access to analysis features.
 *
 * Directory Structure:
 * analysis/
 * ├── index.js                 # This file - main entry point
 * ├── comparison-module.js     # Main comparison module
 * ├── core/                    # Core types and registries
 * ├── compute/                 # Compute backends (GPU, Worker, CPU)
 * ├── data/                    # Data layer and transforms
 * ├── stats/                   # Statistical tests
 * ├── plots/                   # Plot utilities and types
 * │   └── types/               # Individual plot implementations
 * └── ui/                      # UI components
 */

// =============================================================================
// CORE - Types, Validation, Registries
// =============================================================================

export {
  // Validation functions
  validatePluginContract,
  validateOptionsAgainstSchema,
  mergeOptions,
  // Base registry
  BasePluginRegistry,
  // Specialized registries
  PlotPluginRegistry,
  TransformPluginRegistry,
  StatPluginRegistry,
  // Plugin manager
  getPluginManager,
  initPluginManager,
  getPlotRegistry,
  getTransformRegistry,
  getStatRegistry,
  // Colors and helpers
  PAGE_COLORS,
  getPageColor,
  PlotHelpers
} from './core/plugin-contract.js';

export {
  validateAnalysisConfig,
  validateVariableSelection,
  validateTransformConfig,
  validatePlotConfig,
  validateOptionSchema,
  generateAnalysisId,
  createDefaultConfig,
  cloneConfig,
  summarizeConfig
} from './core/analysis-types.js';

// PlotRegistry (from plot-factory.js which wraps plugin-contract.js)
export {
  PlotRegistry
} from './plots/plot-factory.js';

// =============================================================================
// COMPUTE - GPU, Worker, CPU backends
// =============================================================================

// Operation definitions (single source of truth)
export {
  OperationType,
  OperationCategory,
  Operations,
  GPU_CAPABLE_OPERATIONS,
  WORKER_CAPABLE_OPERATIONS,
  getOperation,
  isValidOperation,
  isGPUCapable,
  isWorkerCapable,
  validatePayload
} from './compute/operations.js';

// Mathematical utilities
export {
  normalCDF,
  tCDF,
  computePearsonR,
  computeSpearmanR,
  computeRanks,
  linearRegression,
  equalWidthBreaks,
  quantileBreaks,
  FilterOperator,
  evaluateCondition,
  filterNumeric,
  isValidNumber,
  isMissing
} from './compute/math-utils.js';

// Shared operation handlers
export {
  extractValues,
  batchExtract,
  computeStats,
  computeCorrelation,
  computeDifferential,
  aggregateCategories,
  binValues,
  filterCells,
  computeDensity,
  computeHistogram,
  compareDistributions,
  executeOperation
} from './compute/operation-handlers.js';

// ComputeManager (main orchestrator)
export {
  ComputeManager,
  getComputeManager,
  createComputeManager,
  initComputeManager,
  BackendStatus
} from './compute/compute-manager.js';

// GPU backend
export {
  GPUCompute,
  getGPUCompute,
  createGPUCompute
} from './compute/gpu-compute.js';

// Worker pool
export {
  WorkerPool,
  getWorkerPool,
  createWorkerPool
} from './compute/worker-pool.js';

// Fallback operations
export {
  executeFallback
} from './compute/fallback-operations.js';

// =============================================================================
// DATA - Data Layer, Transforms, Query Builder
// =============================================================================

// Unified DataLayer
export {
  DataLayer,
  createDataLayer
} from './data/data-layer.js';

export {
  TransformPipeline,
  createTransformPipeline
} from './data/transform-pipeline.js';

export {
  QueryBuilder,
  createQueryBuilder,
  OPERATORS
} from './data/query-builder.js';

// =============================================================================
// STATS - Statistical Tests
// =============================================================================

export {
  chiSquaredTest,
  tTest,
  mannWhitneyU,
  oneWayANOVA,
  kruskalWallis,
  runStatisticalTests,
  formatStatisticalResult,
  benjaminiHochberg,
  bonferroniCorrection,
  applyMultipleTestingCorrection,
  confidenceInterval,
  computeFoldChange,
  classifyResult,
  registerStatisticalTests,
  getStatisticalTestRegistry
} from './stats/statistical-tests.js';

export {
  MultiVariableAnalysis,
  createMultiVariableAnalysis
} from './stats/multi-variable-analysis.js';

// =============================================================================
// PLOTS - Plot Types and Utilities
// =============================================================================

// BasePlot class for new plot types
export {
  BasePlot,
  createPlotDefinition,
  COMMON_HOVER_STYLE
} from './plots/plot-base.js';

export {
  createMinimalPlotly,
  loadPlotly,
  isPlotlyLoaded,
  newPlot,
  purgePlot,
  downloadImage,
  getPlotlyConfig,
  getPlotlyLayout,
  withPlotly
} from './plots/plotly-loader.js';

export {
  LayoutEngine,
  createLayoutEngine
} from './plots/layout-engine.js';

export {
  ScatterBuilder,
  createScatterBuilder
} from './plots/scatter-builder.js';

// =============================================================================
// UI - Components
// =============================================================================

export {
  ANALYSIS_SETTINGS,
  DEFAULT_ANALYSIS_SETTINGS,
  COMMON_PLOT_OPTIONS,
  COLOR_PALETTES,
  getExportScaleFactor,
  getAxisRotation,
  createAnalysisSettingsPanel,
  applyAnalysisSettings,
  createVariableSelector,
  createGeneExpressionSelector,
  createPageSelector,
  createPlotTypeSelector,
  createAnalysisModal,
  openModal,
  closeModal,
  renderPlotOptions,
  createExportToolbar,
  createExpandButton,
  createColorPaletteSelector,
  createAnnotationStyleSelector,
  createExportResolutionSelector,
  createAxisRotationSelector,
  createCustomizationPanel,
  renderSummaryStats,
  renderStatisticalAnnotations
} from './ui/index.js';

export {
  DetailedAnalysisUI,
  createDetailedAnalysisUI
} from './ui/analysis-types/detailed-analysis-ui.js';

export {
  QuickInsights,
  createQuickInsights
} from './ui/analysis-types/quick-insights-ui.js';

export {
  CorrelationAnalysisUI,
  createCorrelationAnalysisUI,
  DEAnalysisUI,
  createDEAnalysisUI,
  GeneSignatureUI,
  createGeneSignatureUI,
  ANALYSIS_TYPES,
  isAnalysisTypeAvailable,
  getAvailableAnalysisTypes
} from './ui/analysis-types/index.js';

// Base class for analysis UIs
export {
  BaseAnalysisUI,
  createAnalysisUI
} from './ui/base-analysis-ui.js';

// =============================================================================
// SHARED UTILITIES
// =============================================================================

// LRU Cache
export {
  LRUCache,
  createLRUCache
} from './shared/lru-cache.js';

// Centralized PlotRegistry wrapper
export { PlotRegistry as PlotRegistryUtils } from './shared/plot-registry-utils.js';

// Formatting utilities (centralized, used across modules)
export {
  formatNumber,
  formatFixed,
  formatCount,
  formatPercent,
  formatPValue,
  formatPValueExponential,
  formatPValueWithStars,
  getSignificanceStars,
  getSignificanceMarker,
  getSignificanceClass,
  formatEffectSize,
  getEffectSizeInterpretation,
  formatFoldChange,
  formatLog2FoldChange,
  formatConfidenceInterval,
  formatRange,
  formatDuration,
  formatBytes
} from './shared/formatting.js';

// =============================================================================
// MAIN MODULE
// =============================================================================

export {
  ComparisonModule,
  createComparisonModule
} from './comparison-module.js';

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

// Re-export the main module as default
export { ComparisonModule as default } from './comparison-module.js';
