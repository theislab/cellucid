/**
 * Analysis UI Components - Unified Entry Point
 *
 * This module re-exports all UI components from their respective modules,
 * providing a single import point for the entire UI system.
 *
 * Directory Structure:
 * - shared/: DOM utilities and shared UI components
 * - components/: Core UI components (selectors, modal, export, etc.)
 * - analysis-types/: Individual analysis type UIs
 */

// =============================================================================
// SHARED UTILITIES
// =============================================================================

export {
  // Constants
  NONE_VALUE,
  // Page utilities
  getCellCountForPage,
  // Element factories
  createLabeledContainer,
  createSelect,
  createButton,
  createCheckbox,
  createRangeSlider,
  // Form utilities (for Analysis UIs)
  createFormRow,
  createFormSelect,
  createFormTextarea,
  createFormButton,
  createNotice,
  createResultHeader,
  createActionsBar,
  // DOM manipulation
  clearElement,
  addClass,
  removeClass,
  toggleClass,
  setStyles,
  // Events
  addListener,
  debounce,
  throttle
} from '../shared/dom-utils.js';

export {
  formatNumber,
  formatCount,
  formatPValue,
  getSignificanceMarker,
  getSignificanceClass
} from '../shared/formatting.js';

// =============================================================================
// COMPONENTS (from components/ directory)
// =============================================================================

// Selectors
export {
  createVariableSelector,
  createGeneExpressionSelector,
  createPlotTypeSelector
} from './components/selectors.js';

// PlotRegistry should be imported from '../shared/plot-registry-utils.js'

// Modal
export {
  createAnalysisModal,
  openModal,
  closeModal
} from './components/modal.js';

// Export
export {
  createExportToolbar,
  createExpandButton
} from './components/export.js';

// Stats Display
export {
  renderSummaryStats,
  renderStatisticalAnnotations
} from './components/stats-display.js';

// Options
export {
  renderPlotOptions
} from './components/options.js';

// =============================================================================
// BASE CLASS
// =============================================================================

export {
  BaseAnalysisUI,
  createAnalysisUI
} from './base-analysis-ui.js';

// =============================================================================
// UI MANAGER (Unified analysis type management)
// =============================================================================

export {
  AnalysisUIManager,
  createAnalysisUIManager
} from './analysis-ui-manager.js';

// =============================================================================
// ANALYSIS MODE UIs
// =============================================================================

// QUICK mode
export {
  QuickInsights,
  createQuickInsights
} from './analysis-types/quick-insights-ui.js';

// DETAILED mode
export {
  DetailedAnalysisUI,
  createDetailedAnalysisUI
} from './analysis-types/detailed-analysis-ui.js';

// =============================================================================
// INDIVIDUAL ANALYSIS TYPE UIs
// =============================================================================

export {
  CorrelationAnalysisUI,
  createCorrelationAnalysisUI,
  DEAnalysisUI,
  createDEAnalysisUI,
  GeneSignatureUI,
  createGeneSignatureUI
} from './analysis-types/index.js';

// Cross-highlighting

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

// Default export for convenient destructuring
import * as domUtils from '../shared/dom-utils.js';
import componentsModule from './components/index.js';

export default {
  ...domUtils,
  ...componentsModule
};
