/**
 * UI Components - Unified Entry Point
 *
 * This module re-exports all UI components from their respective modules,
 * providing a single import point for the UI component system.
 *
 * Modules:
 * - selectors: Variable, gene, page, and plot type selectors
 * - modal: Modal system with resize and drag
 * - export: Export toolbar and expand button
 * - customization: Color palettes and customization selectors
 * - multi-select-dropdown: Reusable multi-select popup dropdown
 * - stats-display: Statistics rendering
 * - options: Plot options rendering
 * - settings: Analysis settings definitions and panel
 */

// =============================================================================
// SELECTORS
// =============================================================================

export {
  createVariableSelector,
  createGeneExpressionSelector,
  createPageSelector,
  createPageMultiSelect,
  createPageComparisonSelector,
  createPlotTypeSelector
} from './selectors.js';

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

export {
  createExportToolbar,
  createExpandButton
} from './export.js';

// =============================================================================
// MULTI-SELECT DROPDOWN
// =============================================================================

export {
  createMultiSelectDropdown
} from './multi-select-dropdown.js';

// =============================================================================
// CUSTOMIZATION
// =============================================================================

export {
  COLOR_PALETTES,
  COMMON_PLOT_OPTIONS,
  getExportScaleFactor,
  getAxisRotation,
  createColorPaletteSelector,
  createAnnotationStyleSelector,
  createExportResolutionSelector,
  createAxisRotationSelector,
  createCustomizationPanel
} from './customization.js';

// =============================================================================
// STATS DISPLAY
// =============================================================================

export {
  renderSummaryStats,
  renderStatisticalAnnotations
} from './stats-display.js';

// =============================================================================
// OPTIONS
// =============================================================================

export {
  renderPlotOptions
} from './options.js';

// =============================================================================
// SETTINGS
// =============================================================================

export {
  ANALYSIS_SETTINGS,
  DEFAULT_ANALYSIS_SETTINGS,
  SETTINGS_CATEGORIES,
  createAnalysisSettingsPanel,
  applyAnalysisSettings
} from './settings.js';

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

import selectorsModule from './selectors.js';
import modalModule from './modal.js';
import exportModule from './export.js';
import multiSelectDropdownModule from './multi-select-dropdown.js';
import customizationModule from './customization.js';
import statsDisplayModule from './stats-display.js';
import optionsModule from './options.js';
import settingsModule from './settings.js';

export default {
  ...selectorsModule,
  ...modalModule,
  ...exportModule,
  ...multiSelectDropdownModule,
  ...customizationModule,
  ...statsDisplayModule,
  ...optionsModule,
  ...settingsModule
};
