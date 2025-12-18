/**
 * Centralized Type Definitions for Analysis Module
 *
 * This file re-exports types from the canonical source (core/analysis-types.js)
 * to maintain a single source of truth for all type definitions.
 *
 * For JSDoc type support, import from either location:
 * - './shared/types.js' (this file)
 * - './core/analysis-types.js' (canonical source)
 *
 * @module shared/types
 */

// =============================================================================
// RE-EXPORT FROM CANONICAL SOURCE
// =============================================================================

// All type definitions and validation utilities are in core/analysis-types.js
// This file serves as a convenient alias for the shared directory structure.

export {
  // Validation functions
  validateAnalysisConfig,
  validateVariableSelection,
  validateTransformConfig,
  validatePlotConfig,
  validatePluginContract,
  validateOptionSchema,
  validateOptionsAgainstSchema,

  // Utility functions
  generateAnalysisId,
  createDefaultConfig,
  mergeOptions,
  cloneConfig,
  summarizeConfig
} from '../core/analysis-types.js';

// =============================================================================
// TYPE DEFINITIONS (JSDoc Reference)
// =============================================================================

/**
 * All type definitions are documented in core/analysis-types.js.
 *
 * Primary types:
 * @see {AnalysisConfig} - Complete analysis configuration
 * @see {VariableSelection} - Selected variable with role
 * @see {TransformConfig} - Transform pipeline configuration
 * @see {PlotConfig} - Plot specifications
 * @see {AnalysisResult} - Analysis result data
 * @see {StatisticalResult} - Statistical test results
 * @see {PluginContract} - Plugin interface contract
 * @see {OptionSchema} - Options UI schema
 * @see {ValidationResult} - Validation result structure
 *
 * Additional types defined in specialized modules:
 * - PageData, FetchOptions - data/data-layer.js
 * - BasicStats, CategoryAggregation - compute/operation-handlers.js
 * - Operation, ComputeResult - compute/operations.js
 * - PlotDefinition, PlotTrace, PlotLayout - plots/plot-factory.js
 * - ModalOptions, SelectorOptions - ui/ui-modal.js, ui/ui-selectors.js
 */

// Empty export object for IDE type resolution (some IDEs need this)
export const Types = {};
