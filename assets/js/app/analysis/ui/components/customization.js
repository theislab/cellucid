/**
 * Customization Components
 *
 * UI components for customizing analysis visualizations:
 * - Color palettes
 * - Color palette selector
 * - Annotation style selector
 * - Export resolution selector
 * - Axis rotation selector
 * - Combined customization panel
 */

import { StyleManager } from '../../../../utils/style-manager.js';

// =============================================================================
// COLOR PALETTES
// =============================================================================

/**
 * Predefined color palettes for analysis plots
 */
export const COLOR_PALETTES = {
  default: {
    name: 'Default',
    colors: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f']
  },
  categorical: {
    name: 'Categorical',
    colors: ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#ffff33', '#a65628', '#f781bf']
  },
  sequential: {
    name: 'Sequential Blue',
    colors: ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#084594']
  },
  diverging: {
    name: 'Diverging',
    colors: ['#d73027', '#f46d43', '#fdae61', '#fee090', '#e0f3f8', '#abd9e9', '#74add1', '#4575b4']
  },
  viridis: {
    name: 'Viridis',
    colors: ['#440154', '#482878', '#3e4a89', '#31688e', '#26838f', '#1f9d89', '#6cce5a', '#fde725']
  },
  pastel: {
    name: 'Pastel',
    colors: ['#fbb4ae', '#b3cde3', '#ccebc5', '#decbe4', '#fed9a6', '#ffffcc', '#e5d8bd', '#fddaec']
  },
  bold: {
    name: 'Bold',
    colors: ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6']
  },
  earth: {
    name: 'Earth Tones',
    colors: ['#8c510a', '#bf812d', '#dfc27d', '#f6e8c3', '#c7eae5', '#80cdc1', '#35978f', '#01665e']
  }
};

// =============================================================================
// COMMON PLOT OPTIONS
// =============================================================================

/**
 * Common plot customization option definitions
 * These can be added to any plot type's optionSchema
 */
export const COMMON_PLOT_OPTIONS = {
  annotationStyle: {
    type: 'select',
    label: 'Annotation Style',
    options: [
      { value: 'auto', label: 'Auto (context-aware)' },
      { value: 'compact', label: 'Compact (minimal)' },
      { value: 'detailed', label: 'Detailed (full stats)' },
      { value: 'none', label: 'None (hide all)' }
    ],
    default: 'auto'
  },
  exportResolution: {
    type: 'select',
    label: 'Export Resolution',
    options: [
      { value: 'low', label: 'Low (1x, fast)' },
      { value: 'medium', label: 'Medium (2x)' },
      { value: 'high', label: 'High (3x)' },
      { value: 'print', label: 'Print (4x, 300dpi)' }
    ],
    default: 'medium'
  },
  axisLabelRotation: {
    type: 'select',
    label: 'Axis Label Rotation',
    options: [
      { value: '0', label: 'Horizontal (0°)' },
      { value: '45', label: 'Diagonal (45°)' },
      { value: '90', label: 'Vertical (90°)' }
    ],
    default: '0'
  }
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get export scale factor from resolution setting
 * @param {string} resolution - 'low' | 'medium' | 'high' | 'print'
 * @returns {number} Scale factor
 */
export function getExportScaleFactor(resolution) {
  switch (resolution) {
    case 'low': return 1;
    case 'medium': return 2;
    case 'high': return 3;
    case 'print': return 4;
    default: return 2;
  }
}

/**
 * Get axis label rotation in degrees
 * @param {string|number} rotation - '0' | '45' | '90' or number
 * @returns {number} Rotation in degrees
 */
export function getAxisRotation(rotation) {
  const val = parseInt(rotation, 10);
  return isNaN(val) ? 0 : val;
}

// =============================================================================
// COLOR PALETTE SELECTOR
// =============================================================================

/**
 * Create a color palette selector with visual swatches
 * @param {Object} options
 * @param {string} options.selectedPalette - Currently selected palette key
 * @param {Function} options.onChange - Callback when selection changes
 * @param {string} options.label - Label text
 * @param {string} options.id - Element ID
 * @returns {HTMLElement}
 */
export function createColorPaletteSelector(options = {}) {
  const {
    selectedPalette = 'default',
    onChange,
    label = 'Color Palette',
    id = 'analysis-color-palette'
  } = options;

  const container = document.createElement('div');
  container.className = 'field-select color-palette-selector';

  const labelEl = document.createElement('label');
  labelEl.htmlFor = id;
  labelEl.textContent = label;
  container.appendChild(labelEl);

  // Custom dropdown with swatches
  const wrapper = document.createElement('div');
  wrapper.className = 'palette-dropdown-wrapper';

  // Selected display with swatches
  const selectedDisplay = document.createElement('div');
  selectedDisplay.className = 'palette-selected';
  selectedDisplay.tabIndex = 0;

  const updateSelectedDisplay = (paletteKey) => {
    const palette = COLOR_PALETTES[paletteKey] || COLOR_PALETTES.default;
    selectedDisplay.innerHTML = '';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'palette-name';
    nameSpan.textContent = palette.name;
    selectedDisplay.appendChild(nameSpan);

    const swatches = document.createElement('div');
    swatches.className = 'palette-swatches';
    palette.colors.slice(0, 6).forEach(color => {
      const swatch = document.createElement('span');
      swatch.className = 'palette-swatch';
      StyleManager.setVariable(swatch, '--palette-swatch-color', color);
      swatches.appendChild(swatch);
    });
    selectedDisplay.appendChild(swatches);

    const arrow = document.createElement('span');
    arrow.className = 'palette-arrow';
    arrow.textContent = '▾';
    selectedDisplay.appendChild(arrow);
  };

  // Dropdown list
  const dropdown = document.createElement('div');
  dropdown.className = 'palette-dropdown-list';
  dropdown.id = `${id}-dropdown`;

  let currentPalette = selectedPalette;
  let isOpen = false;

  const renderOptions = () => {
    dropdown.innerHTML = '';

    Object.entries(COLOR_PALETTES).forEach(([key, palette]) => {
      const item = document.createElement('div');
      item.className = 'palette-dropdown-item' + (key === currentPalette ? ' selected' : '');
      item.dataset.value = key;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'palette-name';
      nameSpan.textContent = palette.name;
      item.appendChild(nameSpan);

      const swatches = document.createElement('div');
      swatches.className = 'palette-swatches';
      palette.colors.slice(0, 8).forEach(color => {
        const swatch = document.createElement('span');
        swatch.className = 'palette-swatch';
        StyleManager.setVariable(swatch, '--palette-swatch-color', color);
        swatches.appendChild(swatch);
      });
      item.appendChild(swatches);

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        currentPalette = key;
        updateSelectedDisplay(key);
        renderOptions();
        closeDropdown();
        if (onChange) onChange(key);
      });

      dropdown.appendChild(item);
    });
  };

  const openDropdown = () => {
    isOpen = true;
    dropdown.classList.add('open');
    selectedDisplay.classList.add('open');
  };

  const closeDropdown = () => {
    isOpen = false;
    dropdown.classList.remove('open');
    selectedDisplay.classList.remove('open');
  };

  const toggleDropdown = () => {
    if (isOpen) {
      closeDropdown();
    } else {
      openDropdown();
    }
  };

  selectedDisplay.addEventListener('click', toggleDropdown);
  selectedDisplay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleDropdown();
    } else if (e.key === 'Escape') {
      closeDropdown();
    }
  });

  // Close on click outside
  document.addEventListener('click', (e) => {
    if (isOpen && !wrapper.contains(e.target)) {
      closeDropdown();
    }
  });

  wrapper.appendChild(selectedDisplay);
  wrapper.appendChild(dropdown);
  container.appendChild(wrapper);

  // Initialize
  updateSelectedDisplay(currentPalette);
  renderOptions();

  // Store references for external control
  container._getPalette = () => currentPalette;
  container._setPalette = (key) => {
    if (COLOR_PALETTES[key]) {
      currentPalette = key;
      updateSelectedDisplay(key);
      renderOptions();
    }
  };
  container._getColors = () => {
    const palette = COLOR_PALETTES[currentPalette] || COLOR_PALETTES.default;
    return [...palette.colors];
  };

  return container;
}

// =============================================================================
// ANNOTATION STYLE SELECTOR
// =============================================================================

/**
 * Create an annotation style selector
 * @param {Object} options
 * @param {string} options.selectedStyle - Currently selected style
 * @param {Function} options.onChange - Callback when selection changes
 * @returns {HTMLElement}
 */
export function createAnnotationStyleSelector(options = {}) {
  const { selectedStyle = 'auto', onChange } = options;

  const container = document.createElement('div');
  container.className = 'field-select';

  const label = document.createElement('label');
  label.htmlFor = 'analysis-annotation-style';
  label.textContent = 'Annotation Style';
  container.appendChild(label);

  const select = document.createElement('select');
  select.id = 'analysis-annotation-style';
  select.className = 'obs-select';

  COMMON_PLOT_OPTIONS.annotationStyle.options.forEach(opt => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === selectedStyle) option.selected = true;
    select.appendChild(option);
  });

  select.addEventListener('change', () => {
    if (onChange) onChange(select.value);
  });

  container.appendChild(select);
  return container;
}

// =============================================================================
// EXPORT RESOLUTION SELECTOR
// =============================================================================

/**
 * Create an export resolution selector
 * @param {Object} options
 * @param {string} options.selectedResolution - Currently selected resolution
 * @param {Function} options.onChange - Callback when selection changes
 * @returns {HTMLElement}
 */
export function createExportResolutionSelector(options = {}) {
  const { selectedResolution = 'medium', onChange } = options;

  const container = document.createElement('div');
  container.className = 'field-select';

  const label = document.createElement('label');
  label.htmlFor = 'analysis-export-resolution';
  label.textContent = 'Export Resolution';
  container.appendChild(label);

  const select = document.createElement('select');
  select.id = 'analysis-export-resolution';
  select.className = 'obs-select';

  COMMON_PLOT_OPTIONS.exportResolution.options.forEach(opt => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === selectedResolution) option.selected = true;
    select.appendChild(option);
  });

  select.addEventListener('change', () => {
    if (onChange) onChange(select.value);
  });

  container.appendChild(select);
  return container;
}

// =============================================================================
// AXIS ROTATION SELECTOR
// =============================================================================

/**
 * Create an axis label rotation selector
 * @param {Object} options
 * @param {string} options.selectedRotation - Currently selected rotation
 * @param {Function} options.onChange - Callback when selection changes
 * @returns {HTMLElement}
 */
export function createAxisRotationSelector(options = {}) {
  const { selectedRotation = '0', onChange } = options;

  const container = document.createElement('div');
  container.className = 'field-select';

  const label = document.createElement('label');
  label.htmlFor = 'analysis-axis-rotation';
  label.textContent = 'Axis Label Rotation';
  container.appendChild(label);

  const select = document.createElement('select');
  select.id = 'analysis-axis-rotation';
  select.className = 'obs-select';

  COMMON_PLOT_OPTIONS.axisLabelRotation.options.forEach(opt => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === String(selectedRotation)) option.selected = true;
    select.appendChild(option);
  });

  select.addEventListener('change', () => {
    if (onChange) onChange(select.value);
  });

  container.appendChild(select);
  return container;
}

// =============================================================================
// COMBINED CUSTOMIZATION PANEL
// =============================================================================

/**
 * Create a comprehensive customization panel with all common options
 * @param {Object} options
 * @param {Object} options.currentValues - Current option values
 * @param {Function} options.onChange - Callback when any option changes (key, value)
 * @param {boolean} options.showPalette - Whether to show color palette selector
 * @param {boolean} options.showAnnotation - Whether to show annotation style selector
 * @param {boolean} options.showResolution - Whether to show export resolution selector
 * @param {boolean} options.showRotation - Whether to show axis rotation selector
 * @returns {HTMLElement}
 */
export function createCustomizationPanel(options = {}) {
  const {
    currentValues = {},
    onChange,
    showPalette = true,
    showAnnotation = true,
    showResolution = true,
    showRotation = true
  } = options;

  const container = document.createElement('div');
  container.className = 'analysis-customization-panel';

  const title = document.createElement('div');
  title.className = 'analysis-customization-title';
  title.textContent = 'Customization';
  container.appendChild(title);

  const optionsContainer = document.createElement('div');
  optionsContainer.className = 'analysis-customization-options';

  if (showPalette) {
    const paletteSelector = createColorPaletteSelector({
      selectedPalette: currentValues.colorPalette || 'default',
      onChange: (value) => onChange && onChange('colorPalette', value)
    });
    optionsContainer.appendChild(paletteSelector);
  }

  if (showAnnotation) {
    const annotationSelector = createAnnotationStyleSelector({
      selectedStyle: currentValues.annotationStyle || 'auto',
      onChange: (value) => onChange && onChange('annotationStyle', value)
    });
    optionsContainer.appendChild(annotationSelector);
  }

  if (showResolution) {
    const resolutionSelector = createExportResolutionSelector({
      selectedResolution: currentValues.exportResolution || 'medium',
      onChange: (value) => onChange && onChange('exportResolution', value)
    });
    optionsContainer.appendChild(resolutionSelector);
  }

  if (showRotation) {
    const rotationSelector = createAxisRotationSelector({
      selectedRotation: currentValues.axisLabelRotation || '0',
      onChange: (value) => onChange && onChange('axisLabelRotation', value)
    });
    optionsContainer.appendChild(rotationSelector);
  }

  container.appendChild(optionsContainer);
  return container;
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  COLOR_PALETTES,
  COMMON_PLOT_OPTIONS,
  getExportScaleFactor,
  getAxisRotation,
  createColorPaletteSelector,
  createAnnotationStyleSelector,
  createExportResolutionSelector,
  createAxisRotationSelector,
  createCustomizationPanel
};
