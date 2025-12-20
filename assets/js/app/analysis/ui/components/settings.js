/**
 * Analysis Settings Module
 *
 * Defines analysis settings for data processing and statistical analysis,
 * and provides UI components for settings configuration.
 *
 * Settings control:
 * - Data normalization methods
 * - Outlier handling strategies
 * - Statistical test selection
 * - Multiple testing correction
 * - Significance thresholds
 * - Effect size display options
 */

import { getFiniteMinMax, mean, std } from '../../shared/number-utils.js';

// =============================================================================
// ANALYSIS SETTINGS DEFINITIONS
// =============================================================================

/**
 * Analysis settings definitions for data processing and statistical analysis.
 * These settings control how data is transformed, how outliers are handled,
 * and which statistical tests are applied.
 */
export const ANALYSIS_SETTINGS = {
  // Data Normalization Settings
  normalization: {
    type: 'select',
    label: 'Data Normalization',
    description: 'How to transform values before analysis',
    options: [
      { value: 'none', label: 'Raw values (no transform)' },
      { value: 'log1p', label: 'Log1p: log(1 + x)' },
      { value: 'zscore', label: 'Z-score: (x - μ) / σ' },
      { value: 'minmax', label: 'Min-Max: scale to [0, 1]' },
      { value: 'quantile', label: 'Quantile normalization' }
    ],
    default: 'none',
    affects: ['continuous', 'gene_expression']
  },

  // Outlier Handling Settings
  outlierHandling: {
    type: 'select',
    label: 'Outlier Handling',
    description: 'How to handle extreme values',
    options: [
      { value: 'include', label: 'Include all values' },
      { value: 'iqr', label: 'Exclude IQR outliers (1.5×IQR)' },
      { value: 'percentile', label: 'Exclude top/bottom 1%' },
      { value: 'winsorize', label: 'Winsorize (cap at 5%/95%)' },
      { value: 'mad', label: 'MAD-based (3×MAD)' }
    ],
    default: 'include',
    affects: ['continuous', 'gene_expression']
  },

  // Statistical Test Selection
  statisticalTest: {
    type: 'select',
    label: 'Statistical Test',
    description: 'Test for comparing groups',
    options: [
      { value: 'auto', label: 'Auto (select based on data)' },
      { value: 'ttest', label: 't-test (parametric, 2 groups)' },
      { value: 'welch', label: 'Welch t-test (unequal variance)' },
      { value: 'mannwhitney', label: 'Mann-Whitney U (non-parametric)' },
      { value: 'anova', label: 'ANOVA (3+ groups)' },
      { value: 'kruskal', label: 'Kruskal-Wallis (non-parametric)' },
      { value: 'chisquare', label: 'Chi-squared (categorical)' },
      { value: 'fisher', label: 'Fisher exact (2×2 tables)' }
    ],
    default: 'auto',
    affects: ['continuous', 'categorical', 'gene_expression']
  },

  // Multiple Testing Correction
  multipleTestingCorrection: {
    type: 'select',
    label: 'Multiple Testing Correction',
    description: 'Adjust p-values for multiple comparisons',
    options: [
      { value: 'none', label: 'None (raw p-values)' },
      { value: 'bonferroni', label: 'Bonferroni (conservative)' },
      { value: 'holm', label: 'Holm-Bonferroni (step-down)' },
      { value: 'bh', label: 'Benjamini-Hochberg (FDR)' },
      { value: 'by', label: 'Benjamini-Yekutieli (FDR, correlated)' }
    ],
    default: 'bh',
    affects: ['differential', 'correlation']
  },

  // Significance Threshold
  significanceThreshold: {
    type: 'select',
    label: 'Significance Level (α)',
    description: 'Threshold for statistical significance',
    options: [
      { value: '0.001', label: 'α = 0.001 (very stringent)' },
      { value: '0.01', label: 'α = 0.01 (stringent)' },
      { value: '0.05', label: 'α = 0.05 (standard)' },
      { value: '0.1', label: 'α = 0.10 (lenient)' }
    ],
    default: '0.05',
    affects: ['all']
  },

  // Effect Size Display
  showEffectSize: {
    type: 'checkbox',
    label: 'Show Effect Size',
    description: 'Display effect size measures (Cohen\'s d, etc.)',
    default: true,
    affects: ['continuous', 'gene_expression']
  },

  // Confidence Interval Settings
  confidenceInterval: {
    type: 'select',
    label: 'Confidence Interval',
    description: 'CI level for error bars and estimates',
    options: [
      { value: 'none', label: 'Don\'t show' },
      { value: '0.90', label: '90% CI' },
      { value: '0.95', label: '95% CI' },
      { value: '0.99', label: '99% CI' }
    ],
    default: '0.95',
    affects: ['continuous', 'gene_expression']
  },

  // Minimum Sample Size
  minSampleSize: {
    type: 'select',
    label: 'Minimum Sample Size',
    description: 'Minimum cells required per group for analysis',
    options: [
      { value: '3', label: '3 cells (minimum)' },
      { value: '10', label: '10 cells' },
      { value: '20', label: '20 cells' },
      { value: '50', label: '50 cells' }
    ],
    default: '10',
    affects: ['all']
  },

  // Expression Threshold
  expressionThreshold: {
    type: 'select',
    label: 'Expression Threshold',
    description: 'Minimum expression for gene analysis',
    options: [
      { value: '0', label: 'Include all (0)' },
      { value: '0.1', label: '> 0.1 (low)' },
      { value: '0.5', label: '> 0.5 (medium)' },
      { value: '1.0', label: '> 1.0 (high)' }
    ],
    default: '0',
    affects: ['gene_expression', 'differential']
  },

  // Fold Change Threshold (for DE)
  foldChangeThreshold: {
    type: 'select',
    label: 'Fold Change Threshold',
    description: 'Minimum |log2FC| for differential expression',
    options: [
      { value: '0', label: 'No threshold' },
      { value: '0.25', label: '|log2FC| > 0.25' },
      { value: '0.5', label: '|log2FC| > 0.5' },
      { value: '1.0', label: '|log2FC| > 1.0 (2-fold)' },
      { value: '2.0', label: '|log2FC| > 2.0 (4-fold)' }
    ],
    default: '0.25',
    affects: ['differential']
  }
};

/**
 * Default analysis settings values
 */
export const DEFAULT_ANALYSIS_SETTINGS = Object.fromEntries(
  Object.entries(ANALYSIS_SETTINGS).map(([key, setting]) => [key, setting.default])
);

// =============================================================================
// SETTINGS CATEGORIES
// =============================================================================

/**
 * Settings grouped by category for organized display
 */
export const SETTINGS_CATEGORIES = {
  data: {
    label: 'Data Processing',
    settings: ['normalization', 'outlierHandling', 'expressionThreshold']
  },
  statistics: {
    label: 'Statistical Analysis',
    settings: ['statisticalTest', 'multipleTestingCorrection', 'significanceThreshold']
  },
  display: {
    label: 'Display Options',
    settings: ['showEffectSize', 'confidenceInterval', 'minSampleSize', 'foldChangeThreshold']
  }
};

// =============================================================================
// SETTINGS PANEL UI
// =============================================================================

/**
 * Create an analysis settings panel with collapsible sections.
 *
 * @param {Object} options
 * @param {Object} options.currentSettings - Current settings values
 * @param {Function} options.onChange - Callback when settings change
 * @param {string} [options.context='general'] - Context to filter relevant settings
 * @param {boolean} [options.compact=false] - Use compact layout
 * @returns {HTMLElement} Settings panel element
 */
export function createAnalysisSettingsPanel(options = {}) {
  const {
    currentSettings = { ...DEFAULT_ANALYSIS_SETTINGS },
    onChange,
    context = 'general',
    compact = false
  } = options;

  const container = document.createElement('div');
  container.className = `analysis-settings-panel${compact ? ' compact' : ''}`;

  // Create settings by category
  for (const [categoryKey, category] of Object.entries(SETTINGS_CATEGORIES)) {
    // Filter settings relevant to context
    const relevantSettings = category.settings.filter(settingKey => {
      const setting = ANALYSIS_SETTINGS[settingKey];
      if (!setting) return false;
      if (context === 'general') return true;
      return setting.affects.includes('all') || setting.affects.includes(context);
    });

    if (relevantSettings.length === 0) continue;

    // Create collapsible section
    const section = document.createElement('details');
    section.className = 'settings-section';
    section.open = categoryKey === 'data'; // Open data section by default

    const summary = document.createElement('summary');
    summary.className = 'settings-section-header';
    summary.textContent = category.label;
    section.appendChild(summary);

    const content = document.createElement('div');
    content.className = 'settings-section-content';

    // Create setting controls
    for (const settingKey of relevantSettings) {
      const setting = ANALYSIS_SETTINGS[settingKey];
      if (!setting) continue;

      const settingRow = document.createElement('div');
      settingRow.className = 'setting-row';

      if (setting.type === 'select') {
        const label = document.createElement('label');
        label.className = 'setting-label';
        label.textContent = setting.label;
        if (setting.description) {
          label.title = setting.description;
        }
        settingRow.appendChild(label);

        const select = document.createElement('select');
        select.className = 'setting-select';
        select.dataset.settingKey = settingKey;

        for (const option of setting.options) {
          const optEl = document.createElement('option');
          optEl.value = option.value;
          optEl.textContent = option.label;
          if (currentSettings[settingKey] === option.value) {
            optEl.selected = true;
          }
          select.appendChild(optEl);
        }

        select.addEventListener('change', () => {
          currentSettings[settingKey] = select.value;
          if (onChange) onChange(settingKey, select.value, currentSettings);
        });

        settingRow.appendChild(select);

      } else if (setting.type === 'checkbox') {
        const label = document.createElement('label');
        label.className = 'setting-checkbox-label';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'setting-checkbox';
        checkbox.dataset.settingKey = settingKey;
        checkbox.checked = currentSettings[settingKey] === true || currentSettings[settingKey] === 'true';

        checkbox.addEventListener('change', () => {
          currentSettings[settingKey] = checkbox.checked;
          if (onChange) onChange(settingKey, checkbox.checked, currentSettings);
        });

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(' ' + setting.label));
        if (setting.description) {
          label.title = setting.description;
        }
        settingRow.appendChild(label);
      }

      content.appendChild(settingRow);
    }

    section.appendChild(content);
    container.appendChild(section);
  }

  // Add reset button
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'settings-reset-btn';
  resetBtn.textContent = 'Reset to Defaults';
  resetBtn.addEventListener('click', () => {
    // Reset all settings to defaults
    for (const [key, setting] of Object.entries(ANALYSIS_SETTINGS)) {
      currentSettings[key] = setting.default;
    }

    // Update all UI controls
    container.querySelectorAll('.setting-select').forEach(select => {
      const key = select.dataset.settingKey;
      if (key && ANALYSIS_SETTINGS[key]) {
        select.value = ANALYSIS_SETTINGS[key].default;
      }
    });

    container.querySelectorAll('.setting-checkbox').forEach(checkbox => {
      const key = checkbox.dataset.settingKey;
      if (key && ANALYSIS_SETTINGS[key]) {
        checkbox.checked = ANALYSIS_SETTINGS[key].default === true;
      }
    });

    if (onChange) onChange('_reset', null, currentSettings);
  });

  container.appendChild(resetBtn);

  // Add helper method to get current settings
  container.getSettings = () => ({ ...currentSettings });

  // Add helper method to update a specific setting
  container.setSetting = (key, value) => {
    currentSettings[key] = value;
    const select = container.querySelector(`[data-setting-key="${key}"]`);
    if (select) {
      if (select.type === 'checkbox') {
        select.checked = value === true;
      } else {
        select.value = value;
      }
    }
  };

  return container;
}

// =============================================================================
// DATA PROCESSING
// =============================================================================

/**
 * Apply analysis settings to data values.
 * Performs normalization and outlier handling based on settings.
 *
 * @param {Float32Array|number[]} values - Input values
 * @param {Object} settings - Analysis settings object
 * @returns {Object} { values: Float32Array, stats: Object, excluded: number[] }
 */
export function applyAnalysisSettings(values, settings = {}) {
  const {
    normalization = 'none',
    outlierHandling = 'include',
    expressionThreshold = 0
  } = settings;

  // Convert to Float32Array if needed
  let data = values instanceof Float32Array
    ? new Float32Array(values)
    : new Float32Array(values);

  const stats = { original: { count: data.length }, processed: {} };
  const excluded = [];

  // Step 1: Apply expression threshold (for gene data)
  const threshold = parseFloat(expressionThreshold);
  if (threshold > 0) {
    for (let i = 0; i < data.length; i++) {
      if (data[i] <= threshold) {
        data[i] = NaN;
        excluded.push(i);
      }
    }
  }

  // Step 2: Compute initial statistics for outlier detection
  let validValues = [];
  for (let i = 0; i < data.length; i++) {
    if (Number.isFinite(data[i])) validValues.push(data[i]);
  }

  if (validValues.length === 0) {
    return { values: data, stats, excluded };
  }

  validValues.sort((a, b) => a - b);
  const n = validValues.length;
  const q1 = validValues[Math.floor(n * 0.25)];
  const q3 = validValues[Math.floor(n * 0.75)];
  const iqr = q3 - q1;
  const meanVal = mean(validValues);
  const stdVal = std(validValues);

  // MAD calculation
  const medianVal = validValues[Math.floor(n * 0.5)];
  const deviations = validValues.map(v => Math.abs(v - medianVal)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(n * 0.5)] * 1.4826; // Scale factor for consistency

  stats.original.mean = meanVal;
  stats.original.std = stdVal;
  stats.original.min = validValues[0];
  stats.original.max = validValues[n - 1];

  // Step 3: Handle outliers
  switch (outlierHandling) {
    case 'iqr': {
      const lower = q1 - 1.5 * iqr;
      const upper = q3 + 1.5 * iqr;
      for (let i = 0; i < data.length; i++) {
        if (Number.isFinite(data[i]) && (data[i] < lower || data[i] > upper)) {
          data[i] = NaN;
          excluded.push(i);
        }
      }
      break;
    }
    case 'percentile': {
      const p1 = validValues[Math.floor(n * 0.01)];
      const p99 = validValues[Math.floor(n * 0.99)];
      for (let i = 0; i < data.length; i++) {
        if (Number.isFinite(data[i]) && (data[i] < p1 || data[i] > p99)) {
          data[i] = NaN;
          excluded.push(i);
        }
      }
      break;
    }
    case 'winsorize': {
      const p5 = validValues[Math.floor(n * 0.05)];
      const p95 = validValues[Math.floor(n * 0.95)];
      for (let i = 0; i < data.length; i++) {
        if (Number.isFinite(data[i])) {
          if (data[i] < p5) data[i] = p5;
          if (data[i] > p95) data[i] = p95;
        }
      }
      break;
    }
    case 'mad': {
      const madLower = medianVal - 3 * mad;
      const madUpper = medianVal + 3 * mad;
      for (let i = 0; i < data.length; i++) {
        if (Number.isFinite(data[i]) && (data[i] < madLower || data[i] > madUpper)) {
          data[i] = NaN;
          excluded.push(i);
        }
      }
      break;
    }
    // 'include' - do nothing
  }

  // Recompute valid values after outlier handling
  validValues = [];
  for (let i = 0; i < data.length; i++) {
    if (Number.isFinite(data[i])) validValues.push(data[i]);
  }

  if (validValues.length === 0) {
    return { values: data, stats, excluded };
  }

  const newMean = mean(validValues);
  const newStd = std(validValues);
  const { min: newMin, max: newMax } = getFiniteMinMax(validValues);

  // Step 4: Apply normalization
  switch (normalization) {
    case 'log1p':
      for (let i = 0; i < data.length; i++) {
        if (Number.isFinite(data[i]) && data[i] > -1) {
          data[i] = Math.log1p(data[i]);
        }
      }
      break;
    case 'zscore':
      if (newStd > 0) {
        for (let i = 0; i < data.length; i++) {
          if (Number.isFinite(data[i])) {
            data[i] = (data[i] - newMean) / newStd;
          }
        }
      }
      break;
    case 'minmax': {
      const range = newMax - newMin;
      if (range > 0) {
        for (let i = 0; i < data.length; i++) {
          if (Number.isFinite(data[i])) {
            data[i] = (data[i] - newMin) / range;
          }
        }
      }
      break;
    }
    case 'quantile':
      // Simple rank-based quantile normalization
      const indexedValues = [];
      for (let i = 0; i < data.length; i++) {
        if (Number.isFinite(data[i])) {
          indexedValues.push({ idx: i, val: data[i] });
        }
      }
      indexedValues.sort((a, b) => a.val - b.val);
      const len = indexedValues.length;
      for (let rank = 0; rank < len; rank++) {
        data[indexedValues[rank].idx] = rank / (len - 1);
      }
      break;
    // 'none' - do nothing
  }

  // Final stats
  validValues = [];
  for (let i = 0; i < data.length; i++) {
    if (Number.isFinite(data[i])) validValues.push(data[i]);
  }

  if (validValues.length > 0) {
    stats.processed.count = validValues.length;
    stats.processed.mean = mean(validValues);
    const { min, max } = getFiniteMinMax(validValues);
    stats.processed.min = min;
    stats.processed.max = max;
  }

  return { values: data, stats, excluded };
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  ANALYSIS_SETTINGS,
  DEFAULT_ANALYSIS_SETTINGS,
  SETTINGS_CATEGORIES,
  createAnalysisSettingsPanel,
  applyAnalysisSettings
};
