/**
 * UI Components - Unified Entry Point
 *
 * This module re-exports all UI components from their respective modules,
 * providing a single import point for the UI component system.
 *
 * Modules:
 * - selectors: Variable, gene, page-comparison, and plot type selectors
 * - modal: Modal system with resize and drag
 * - export: Export toolbar and expand button
 * - multi-select-dropdown: Reusable multi-select popup dropdown
 * - stats-display: Statistics rendering
 * - options: Plot options rendering
 */

// =============================================================================
// SELECTORS
// =============================================================================

export { createPlotTypeSelector } from './selectors.js';

// PlotRegistry should be imported from '../shared/plot-registry-utils.js'

// =============================================================================
// MODAL
// =============================================================================

export {
  createAnalysisModal,
  openModal,
  closeModal
} from './modal.js';

// =============================================================================
// EXPORT COMPONENTS
// =============================================================================

export { createExpandButton } from './export.js';

// =============================================================================
// STATS DISPLAY
// =============================================================================

export {
  preparePageStatistics,
  renderSummaryStats,
  renderStatisticalAnnotations
} from './stats-display.js';

// =============================================================================
// OPTIONS
// =============================================================================

export {
  renderPlotOptions
} from './options.js';
