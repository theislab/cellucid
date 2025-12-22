/**
 * Genes Panel Module
 *
 * Public exports for the marker genes panel feature.
 * Provides hierarchical clustering heatmaps of marker genes
 * across cell type/cluster groups.
 *
 * @module genes-panel
 */

// Core engines
export { MarkerDiscoveryEngine, createMarkerDiscoveryEngine } from './marker-discovery-engine.js';
export { ExpressionMatrixBuilder, createExpressionMatrixBuilder } from './expression-matrix-builder.js';
export { ClusteringEngine, createClusteringEngine } from './clustering-engine.js';

// Caching
export { MarkerCache, createMarkerCache } from './marker-cache.js';

// Main controller
export { GenesPanelController, createGenesPanelController } from './genes-panel-controller.js';

// Constants and configuration
export {
  DEFAULTS,
  TOP_N_OPTIONS,
  METHOD_OPTIONS,
  TRANSFORM_OPTIONS,
  COLORSCALE_OPTIONS,
  DISTANCE_OPTIONS,
  LINKAGE_OPTIONS,
  MODE_OPTIONS,
  P_VALUE_THRESHOLDS,
  FOLD_CHANGE_THRESHOLDS,
  ERROR_MESSAGES,
  formatError,
  ANALYSIS_PHASES,
  CACHE_KEYS
} from './constants.js';

// Default export: main controller factory
export { createGenesPanelController as default } from './genes-panel-controller.js';
