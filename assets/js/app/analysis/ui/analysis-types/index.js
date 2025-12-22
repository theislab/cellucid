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

// =============================================================================
// ANALYSIS TYPE REGISTRY
// =============================================================================

/**
 * Registry of available analysis types with their requirements
 */
export const ANALYSIS_TYPES = {
  detailed: {
    id: 'detailed',
    name: 'Detailed Analysis',
    description: 'Full control over variables, plots, and customization',
    icon: 'sliders',
    minPages: 1,
    maxPages: null,
    component: 'DetailedAnalysisUI'
  },
  quick: {
    id: 'quick',
    name: 'Quick Insights',
    description: 'Auto-generated insights for selected pages',
    icon: 'lightbulb',
    minPages: 1,
    maxPages: null,
    component: 'QuickInsights'
  },
  correlation: {
    id: 'correlation',
    name: 'Correlation Explorer',
    description: 'Explore correlations between two variables',
    icon: 'scatter',
    minPages: 1,
    maxPages: null,
    component: 'CorrelationAnalysisUI'
  },
  differential: {
    id: 'differential',
    name: 'Differential Expression',
    description: 'Find differentially expressed genes between pages',
    icon: 'bar-chart',
    minPages: 2,
    maxPages: 2,
    component: 'DEAnalysisUI'
  },
  signature: {
    id: 'signature',
    name: 'Gene Signature Score',
    description: 'Compute gene signature scores across pages',
    icon: 'list',
    minPages: 1,
    maxPages: null,
    component: 'GeneSignatureUI'
  },
  genesPanel: {
    id: 'genesPanel',
    name: 'Marker Genes',
    description: 'Discover and visualize marker genes across cell groups',
    icon: 'grid',
    minPages: 1,
    maxPages: null,
    component: 'GenesPanelUI'
  }
};

/**
 * Check if an analysis type is available for given page selection
 * @param {string} analysisType - Analysis type ID
 * @param {number} pageCount - Number of selected pages
 * @returns {boolean} True if analysis is available
 */
export function isAnalysisTypeAvailable(analysisType, pageCount) {
  const type = ANALYSIS_TYPES[analysisType];
  if (!type) return false;

  if (type.minPages && pageCount < type.minPages) return false;
  if (type.maxPages && pageCount > type.maxPages) return false;

  return true;
}

/**
 * Get analysis types available for current page selection
 * @param {number} pageCount - Number of selected pages
 * @returns {Object[]} Available analysis types
 */
export function getAvailableAnalysisTypes(pageCount) {
  return Object.values(ANALYSIS_TYPES).filter(type =>
    isAnalysisTypeAvailable(type.id, pageCount)
  );
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default {
  // Base classes
  FormBasedAnalysisUI: () => import('./base/form-based-analysis.js'),
  // Analysis UIs
  DetailedAnalysisUI: () => import('./detailed-analysis-ui.js'),
  QuickInsights: () => import('./quick-insights-ui.js'),
  CorrelationAnalysisUI: () => import('./correlation-analysis-ui.js'),
  DEAnalysisUI: () => import('./de-analysis-ui.js'),
  GeneSignatureUI: () => import('./gene-signature-ui.js'),
  GenesPanelUI: () => import('./genes-panel-ui.js'),
  // Registry
  ANALYSIS_TYPES
};
