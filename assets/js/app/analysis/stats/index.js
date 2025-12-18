/**
 * Statistics Module - Unified Entry Point
 *
 * Re-exports all statistical functions and classes from:
 * - statistical-tests.js: Core statistical tests (chi-squared, t-test, ANOVA, etc.)
 * - multi-variable-analysis.js: Multi-variable correlation and DE analysis
 * - quick-stats.js: Streaming statistics and field scoring for quick insights
 */

// =============================================================================
// STATISTICAL TESTS
// =============================================================================

export {
  // Core tests
  chiSquaredTest,
  tTest,
  mannWhitneyU,
  oneWayANOVA,
  kruskalWallis,
  runStatisticalTests,

  // Formatting
  formatStatisticalResult,

  // Multiple testing correction
  benjaminiHochberg,
  bonferroniCorrection,
  applyMultipleTestingCorrection,

  // Utility functions
  confidenceInterval,
  computeFoldChange,
  classifyResult,

  // Registry
  registerStatisticalTests,
  getStatisticalTestRegistry
} from './statistical-tests.js';

// =============================================================================
// MULTI-VARIABLE ANALYSIS
// =============================================================================

export {
  MultiVariableAnalysis,
  createMultiVariableAnalysis
} from './multi-variable-analysis.js';

// =============================================================================
// QUICK STATS (Streaming & Field Scoring)
// =============================================================================

export {
  // Streaming statistics
  computeStreamingStats,

  // Field scoring (for intelligent selection)
  computeEntropy,
  computeVarianceScore,
  computeMissingness,
  scoreCategoricalField,
  scoreContinuousField,
  scoreFieldDifference,

  // Two-page comparison utilities
  computeEffectSizeWithCI,
  computeCategoricalShifts,
  computeQuickDifferentialExpression
} from './quick-stats.js';

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

import StatisticalTests from './statistical-tests.js';
import MultiVariableAnalysis from './multi-variable-analysis.js';
import QuickStats from './quick-stats.js';

export default {
  ...StatisticalTests,
  MultiVariableAnalysis,
  ...QuickStats
};
