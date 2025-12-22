/**
 * Plot Types - Unified Registry Import
 *
 * This module imports all plot type implementations, triggering their
 * self-registration with the PlotRegistry. Importing this module ensures
 * all plot types are available for use.
 *
 * Plot types register themselves via PlotRegistry.register() when their
 * modules are imported. This pattern enables:
 * - Lazy loading of plot implementations
 * - Easy addition of new plot types
 * - Consistent registration across all plot types
 *
 * @module plots/types
 */

// =============================================================================
// CATEGORICAL DATA PLOT TYPES
// =============================================================================

// Bar plot - Shows category distribution across pages
import './barplot.js';

// Pie/Donut chart - Shows proportional composition
import './pieplot.js';

// =============================================================================
// CONTINUOUS DATA PLOT TYPES
// =============================================================================

// Box plot - Shows distribution quartiles
import './boxplot.js';

// Violin plot - Shows distribution density with kernel estimation
import './violinplot.js';

// Histogram - Shows frequency distribution
import './histogram.js';

// Density plot - Shows smooth probability density
import './densityplot.js';

// =============================================================================
// ADVANCED PLOT TYPES
// =============================================================================

// Heatmap - Shows gene expression patterns across pages
import './heatmap.js';

// Volcano plot - Shows differential expression (log2FC vs -log10 p-value)
import './volcanoplot.js';

// Scatter plot - Shows correlation between two variables
import './scatterplot.js';

// =============================================================================
// MARKER GENES PANEL PLOT TYPES
// =============================================================================

// Gene heatmap - Shows marker gene expression across cell groups
import './gene-heatmap.js';

// =============================================================================
// PLOT TYPE SUMMARY
// =============================================================================

/**
 * Available plot types after this module is imported:
 *
 * For categorical data:
 * - barplot: Grouped/stacked bar charts
 * - pieplot: Pie and donut charts
 *
 * For continuous data:
 * - boxplot: Box and whisker plots
 * - violinplot: Violin plots with optional box overlay
 * - histogram: Frequency histograms
 * - densityplot: Kernel density estimates
 *
 * For advanced analysis:
 * - heatmap: Gene expression heatmaps
 * - volcanoplot: Differential expression visualization
 * - scatterplot: Two-variable correlation plots
 */

// Export a list of registered plot type IDs for convenience
export const PLOT_TYPE_IDS = [
  'barplot',
  'pieplot',
  'boxplot',
  'violinplot',
  'histogram',
  'densityplot',
  'heatmap',
  'volcanoplot',
  'scatterplot',
  'gene-heatmap'
];

// Categorical plot types
export const CATEGORICAL_PLOT_IDS = ['barplot', 'pieplot'];

// Continuous plot types
export const CONTINUOUS_PLOT_IDS = ['boxplot', 'violinplot', 'histogram', 'densityplot'];

// Advanced plot types (require specific data configurations)
export const ADVANCED_PLOT_IDS = ['heatmap', 'volcanoplot', 'scatterplot', 'gene-heatmap'];
