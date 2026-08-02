/**
 * Analysis Types - Individual Analysis UI Components
 *
 * This module exports all analysis UI components:
 *
 * BASE CLASSES:
 * - FormBasedAnalysisUI: Base for form + results pattern (DE, Signature, Correlation)
 *
 * ANALYSIS UIs:
 * - DetailedAnalysisUI: Full-featured analysis with plot customization
 * - QuickInsights: Auto-generated insights panel (extends BaseAnalysisUI)
 * - CorrelationAnalysisUI: Scatter plot correlation explorer
 * - DEAnalysisUI: Differential expression analysis (extends FormBasedAnalysisUI)
 * - GeneSignatureUI: Gene signature scoring (extends FormBasedAnalysisUI)
 *
 * Each component can be used independently or initialized directly
 * by ComparisonModule for specific analysis modes.
 *
 * INHERITANCE HIERARCHY:
 * BaseAnalysisUI (abstract)
 * ├── FormBasedAnalysisUI (form + results pattern)
 * │   ├── DEAnalysisUI
 * │   ├── GeneSignatureUI
 * │   └── CorrelationAnalysisUI
 * ├── DetailedAnalysisUI
 * ├── QuickInsights
 *
 * @example
 * import { createDetailedAnalysisUI, FormBasedAnalysisUI } from './analysis-types';
 *
 * const detailedUI = createDetailedAnalysisUI({
 *   dataLayer,
 *   comparisonModule
 * });
 * detailedUI.init(container);
 */

// =============================================================================
// BASE CLASSES
// =============================================================================

export {
  FormBasedAnalysisUI,
  createFormBasedAnalysisUI
} from './base/form-based-analysis.js';

// =============================================================================
// DETAILED ANALYSIS
// =============================================================================

export {
  DetailedAnalysisUI,
  createDetailedAnalysisUI
} from './detailed-analysis-ui.js';

// =============================================================================
// QUICK INSIGHTS
// =============================================================================

export {
  QuickInsights,
  createQuickInsights
} from './quick-insights-ui.js';

// =============================================================================
// CORRELATION EXPLORER
// =============================================================================

export {
  CorrelationAnalysisUI,
  createCorrelationAnalysisUI
} from './correlation-analysis-ui.js';

// =============================================================================
// DIFFERENTIAL EXPRESSION
// =============================================================================

export {
  DEAnalysisUI,
  createDEAnalysisUI
} from './de-analysis-ui.js';

// =============================================================================
// GENE SIGNATURE SCORE
// =============================================================================

export {
  GeneSignatureUI,
  createGeneSignatureUI
} from './gene-signature-ui.js';

// =============================================================================
// MARKER GENES PANEL
// =============================================================================

export {
  GenesPanelUI,
  createGenesPanelUI
} from './genes-panel-ui.js';
