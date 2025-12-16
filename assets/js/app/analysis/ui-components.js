/**
 * UI Components for Page Analysis
 *
 * Minimal, clean components that exactly match the Filtering section pattern.
 * - Simple dropdowns for obs fields (categorical/continuous)
 * - Searchable dropdown with badge for gene expression
 * - Page selector that MATCHES the highlight module tabs style exactly
 * - Plot type dropdown
 * - Modal/popup for analysis output with customization panel
 * - Statistical annotations panel with significance tests
 */

import { PlotRegistry } from './plot-registry.js';
import { getPageColor } from './plot-registry.js';
import { runStatisticalTests, formatStatisticalResult } from './statistical-tests.js';

const NONE_VALUE = '-1';

/**
 * Create a variable selector dropdown matching the filtering section pattern exactly
 * Uses .field-select container and .obs-select dropdown
 * @param {Object} options
 * @param {Object[]} options.variables - Array of variable info objects
 * @param {Function} options.onChange - Callback when selection changes
 * @param {string} options.selectedValue - Currently selected value
 * @param {string} options.label - Label text
 * @param {string} options.id - Element ID
 * @returns {HTMLElement}
 */
export function createVariableSelector(options = {}) {
  const {
    variables = [],
    onChange,
    selectedValue = '',
    label = 'Variable',
    id = ''
  } = options;

  const container = document.createElement('div');
  container.className = 'field-select';

  const labelEl = document.createElement('label');
  if (id) labelEl.htmlFor = id;
  labelEl.textContent = label;
  container.appendChild(labelEl);

  const select = document.createElement('select');
  select.className = 'obs-select';
  if (id) select.id = id;

  // Add "None" option - exactly matching filtering section
  const noneOption = document.createElement('option');
  noneOption.value = NONE_VALUE;
  noneOption.textContent = 'None';
  noneOption.selected = !selectedValue || selectedValue === NONE_VALUE;
  select.appendChild(noneOption);

  // Add variable options
  variables.forEach(v => {
    const option = document.createElement('option');
    option.value = v.key;
    option.textContent = v.key;
    if (v.key === selectedValue) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  select.addEventListener('change', () => {
    if (onChange) onChange(select.value === NONE_VALUE ? '' : select.value);
  });

  container.appendChild(select);

  return container;
}

/**
 * Create a gene expression searchable dropdown - exactly matches the filtering section pattern
 * @param {Object} options
 * @param {Object[]} options.genes - Array of gene variable info objects
 * @param {Function} options.onChange - Callback when selection changes
 * @param {string} options.selectedValue - Currently selected gene
 * @param {string} options.label - Label text
 * @param {string} options.id - Element ID
 * @returns {HTMLElement}
 */
export function createGeneExpressionSelector(options = {}) {
  const {
    genes = [],
    onChange,
    selectedValue = '',
    label = 'Gene expression:',
    id = 'analysis-gene-expression'
  } = options;

  const container = document.createElement('div');
  container.className = 'field-select';
  container.id = `${id}-container`;

  const labelEl = document.createElement('label');
  labelEl.htmlFor = `${id}-search`;
  labelEl.textContent = label;
  container.appendChild(labelEl);

  const wrapper = document.createElement('div');
  wrapper.className = 'searchable-dropdown';

  // Search input - matches existing pattern exactly
  const input = document.createElement('input');
  input.type = 'text';
  input.id = `${id}-search`;
  input.className = 'search-input';
  input.placeholder = 'Search genes...';
  input.autocomplete = 'off';

  // Dropdown list
  const dropdown = document.createElement('div');
  dropdown.id = `${id}-dropdown`;
  dropdown.className = 'dropdown-list';

  // Selected gene badge - matches existing pattern exactly
  const selectedBadge = document.createElement('div');
  selectedBadge.id = `${id}-selected`;
  selectedBadge.className = 'selected-gene';

  let currentSelectedGene = selectedValue;

  const updateSelectedDisplay = () => {
    if (currentSelectedGene) {
      selectedBadge.innerHTML = `
        <span>${currentSelectedGene}</span>
        <button type="button" class="clear-btn" title="Clear gene selection">×</button>
      `;
      selectedBadge.classList.add('visible');

      const clearBtn = selectedBadge.querySelector('.clear-btn');
      clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        currentSelectedGene = '';
        input.value = '';
        updateSelectedDisplay();
        if (onChange) onChange('');
      });
    } else {
      selectedBadge.innerHTML = '';
      selectedBadge.classList.remove('visible');
    }
  };

  const renderOptions = (filter = '') => {
    dropdown.innerHTML = '';
    const lowerFilter = filter.toLowerCase();
    const filtered = genes.filter(g =>
      g.key.toLowerCase().includes(lowerFilter)
    ).slice(0, 50);

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dropdown-item';
      empty.textContent = filter ? 'No matches' : 'Type to search genes';
      empty.style.color = 'var(--viewer-ink-muted)';
      empty.style.fontStyle = 'italic';
      dropdown.appendChild(empty);
      return;
    }

    filtered.forEach(g => {
      const item = document.createElement('div');
      item.className = 'dropdown-item';
      item.textContent = g.key;

      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        currentSelectedGene = g.key;
        input.value = '';
        dropdown.style.display = 'none';
        input.blur();
        updateSelectedDisplay();
        if (onChange) onChange(g.key);
      });

      dropdown.appendChild(item);
    });
  };

  input.addEventListener('focus', () => {
    renderOptions(input.value);
    dropdown.style.display = 'block';
  });

  input.addEventListener('input', () => {
    renderOptions(input.value);
    dropdown.style.display = 'block';
  });

  input.addEventListener('blur', () => {
    // Small delay to allow mousedown on items to fire
    requestAnimationFrame(() => {
      dropdown.style.display = 'none';
    });
  });

  wrapper.appendChild(input);
  wrapper.appendChild(dropdown);
  wrapper.appendChild(selectedBadge);
  container.appendChild(wrapper);

  // Set initial state
  if (selectedValue) {
    currentSelectedGene = selectedValue;
    updateSelectedDisplay();
  }

  // Store reference for external control
  container._clearSelection = () => {
    currentSelectedGene = '';
    input.value = '';
    updateSelectedDisplay();
  };

  container._setSelection = (gene) => {
    currentSelectedGene = gene;
    input.value = '';
    updateSelectedDisplay();
  };

  return container;
}

/**
 * Create page selector that MATCHES the highlight module tabs style exactly
 * Uses the same .highlight-page-tab styling with colors, names, counts
 * Includes color picker for each page
 * @param {Object} options
 * @param {Object[]} options.pages - Array of page objects { id, name, highlightedGroups }
 * @param {string[]} options.selectedIds - Currently selected page IDs
 * @param {Function} options.onChange - Callback when selection changes
 * @param {Function} options.onColorChange - Callback when color changes (pageId, color)
 * @param {Map} options.customColors - Map of pageId -> custom color
 * @returns {HTMLElement}
 */
export function createPageSelector(options = {}) {
  const { pages = [], selectedIds = [], onChange, onColorChange, customColors = new Map() } = options;

  const container = document.createElement('div');
  container.className = 'control-block analysis-page-selector';

  const label = document.createElement('label');
  label.textContent = 'Compare pages:';
  container.appendChild(label);

  if (pages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'legend-help';
    empty.textContent = 'Create highlight pages first using the Highlighted Cells section above.';
    container.appendChild(empty);
    return container;
  }

  const helpText = document.createElement('div');
  helpText.className = 'legend-help';
  helpText.textContent = 'Click pages to select. Click color to customize.';
  container.appendChild(helpText);

  // Create tabs container matching highlight module exactly
  const tabsContainer = document.createElement('div');
  tabsContainer.className = 'analysis-page-tabs';

  let selected = new Set(selectedIds);

  const renderTabs = () => {
    tabsContainer.innerHTML = '';

    pages.forEach((page, index) => {
      const isSelected = selected.has(page.id);
      const groupCount = page.highlightedGroups?.length || 0;
      const cellCount = getCellCountForPage(page);
      const currentColor = customColors.get(page.id) || getPageColor(index);

      const tab = document.createElement('div');
      tab.className = 'analysis-page-tab' + (isSelected ? ' selected' : '');
      tab.dataset.pageId = page.id;

      // Color swatch container (rectangular, matching categorical obs legend style)
      const colorIndicator = document.createElement('span');
      colorIndicator.className = 'analysis-page-color';
      colorIndicator.style.backgroundColor = currentColor;
      colorIndicator.title = 'Click to change color';

      // Color picker input (overlays the swatch)
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.className = 'analysis-page-color-input';
      colorInput.value = currentColor;
      colorInput.title = 'Click to change color';
      colorInput.addEventListener('input', (e) => {
        const newColor = e.target.value;
        customColors.set(page.id, newColor);
        colorIndicator.style.backgroundColor = newColor;
        if (onColorChange) onColorChange(page.id, newColor);
      });
      colorInput.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent tab selection toggle
      });

      // Nest input inside swatch for proper absolute positioning
      colorIndicator.appendChild(colorInput);
      tab.appendChild(colorIndicator);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'analysis-page-name';
      nameSpan.textContent = page.name;
      nameSpan.title = page.name;
      tab.appendChild(nameSpan);

      const countSpan = document.createElement('span');
      countSpan.className = 'analysis-page-count';
      countSpan.textContent = cellCount > 0 ? `${formatCount(cellCount)}` : `(${groupCount})`;
      tab.appendChild(countSpan);

      // Click to toggle selection (but not on color indicator)
      tab.addEventListener('click', () => {
        if (selected.has(page.id)) {
          selected.delete(page.id);
        } else {
          selected.add(page.id);
        }
        renderTabs();
        if (onChange) onChange(Array.from(selected));
      });

      tabsContainer.appendChild(tab);
    });

    // Add "Select All" / "Clear" buttons
    const actionsRow = document.createElement('div');
    actionsRow.className = 'analysis-page-actions';

    if (pages.length > 1) {
      const selectAllBtn = document.createElement('button');
      selectAllBtn.type = 'button';
      selectAllBtn.className = 'btn-small';
      selectAllBtn.textContent = selected.size === pages.length ? 'Deselect All' : 'Select All';
      selectAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (selected.size === pages.length) {
          selected.clear();
        } else {
          selected = new Set(pages.map(p => p.id));
        }
        renderTabs();
        if (onChange) onChange(Array.from(selected));
      });
      actionsRow.appendChild(selectAllBtn);
    }

    tabsContainer.appendChild(actionsRow);
  };

  renderTabs();
  container.appendChild(tabsContainer);

  // Store reference for external update
  container._updateSelection = (newIds) => {
    selected = new Set(newIds);
    renderTabs();
  };

  container._getSelection = () => Array.from(selected);

  container._getCustomColors = () => new Map(customColors);

  return container;
}

// Legacy function name for backwards compatibility
export function createPageMultiSelect(options) {
  return createPageSelector(options);
}

/**
 * Get cell count for a page
 */
function getCellCountForPage(page) {
  if (!page.highlightedGroups) return 0;
  const indices = new Set();
  for (const group of page.highlightedGroups) {
    if (group.enabled === false) continue;
    if (group.cellIndices) {
      for (const idx of group.cellIndices) {
        indices.add(idx);
      }
    }
  }
  return indices.size;
}

/**
 * Format count for display
 */
function formatCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

/**
 * Create a simple plot type dropdown - minimal design
 * @param {Object} options
 * @param {string} options.dataType - Current data type
 * @param {string} options.selectedId - Currently selected plot type
 * @param {Function} options.onChange - Callback when selection changes
 * @returns {HTMLElement}
 */
export function createPlotTypeSelector(options = {}) {
  const { dataType = 'categorical', selectedId = '', onChange } = options;

  const container = document.createElement('div');
  container.className = 'field-select';

  const label = document.createElement('label');
  label.htmlFor = 'analysis-plot-type';
  label.textContent = 'Plot type:';
  container.appendChild(label);

  const select = document.createElement('select');
  select.id = 'analysis-plot-type';
  select.className = 'obs-select';

  // Get compatible plot types
  const plotTypes = PlotRegistry.getForDataType(dataType);

  if (plotTypes.length === 0) {
    const noneOption = document.createElement('option');
    noneOption.value = '';
    noneOption.textContent = 'No plots available';
    select.appendChild(noneOption);
    select.disabled = true;
  } else {
    plotTypes.forEach(pt => {
      const option = document.createElement('option');
      option.value = pt.id;
      option.textContent = pt.name;
      if (pt.id === selectedId || (!selectedId && pt === plotTypes[0])) {
        option.selected = true;
      }
      select.appendChild(option);
    });
  }

  select.addEventListener('change', () => {
    if (onChange) onChange(select.value);
  });

  container.appendChild(select);

  return container;
}

/**
 * Create the analysis popup/modal component
 * The output area is a popup following the design principles of the website
 * Features:
 * - Resizable grid layout with plot, options panel, and statistical panel
 * - Summary statistics and statistical annotations
 * @param {Object} options
 * @param {Function} options.onClose - Callback when modal is closed
 * @param {Function} options.onExportPNG - Export PNG callback
 * @param {Function} options.onExportSVG - Export SVG callback
 * @param {Function} options.onExportCSV - Export CSV callback
 * @returns {HTMLElement}
 */
export function createAnalysisModal(options = {}) {
  const { onClose, onExportPNG, onExportSVG, onExportCSV } = options;

  // Create modal backdrop
  const modal = document.createElement('div');
  modal.className = 'analysis-modal';

  const backdrop = document.createElement('div');
  backdrop.className = 'analysis-modal-backdrop';
  backdrop.addEventListener('click', () => {
    if (onClose) onClose();
    closeModal(modal);
  });
  modal.appendChild(backdrop);

  // Create modal content with resizable grid
  const content = document.createElement('div');
  content.className = 'analysis-modal-content';

  // Header with title and close button
  const header = document.createElement('div');
  header.className = 'analysis-modal-header';

  const title = document.createElement('h3');
  title.className = 'analysis-modal-title';
  title.textContent = 'Page Analysis';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'analysis-modal-close';
  closeBtn.innerHTML = '×';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', () => {
    if (onClose) onClose();
    closeModal(modal);
  });

  header.appendChild(title);
  header.appendChild(closeBtn);
  content.appendChild(header);

  // Main body with resizable grid: plot + options
  const body = document.createElement('div');
  body.className = 'analysis-modal-body';

  // Left side: Plot container
  const plotSection = document.createElement('div');
  plotSection.className = 'analysis-modal-plot-section';

  const plotContainer = document.createElement('div');
  plotContainer.className = 'analysis-modal-plot';
  plotContainer.id = 'analysis-modal-plot-container';
  plotSection.appendChild(plotContainer);

  // Export toolbar below plot
  const exportToolbar = document.createElement('div');
  exportToolbar.className = 'analysis-modal-export';

  const createExportBtn = (label, title, onClick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-small';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  };

  if (onExportPNG) exportToolbar.appendChild(createExportBtn('PNG', 'Download as PNG', onExportPNG));
  if (onExportSVG) exportToolbar.appendChild(createExportBtn('SVG', 'Download as SVG', onExportSVG));
  if (onExportCSV) exportToolbar.appendChild(createExportBtn('CSV', 'Download data', onExportCSV));

  plotSection.appendChild(exportToolbar);
  body.appendChild(plotSection);

  // Vertical resizer between plot and options
  const verticalResizer = document.createElement('div');
  verticalResizer.className = 'analysis-modal-resizer analysis-modal-resizer-vertical';
  verticalResizer.title = 'Drag to resize';
  body.appendChild(verticalResizer);

  // Right side: Options panel
  const optionsPanel = document.createElement('div');
  optionsPanel.className = 'analysis-modal-options';
  optionsPanel.id = 'analysis-modal-options';

  const optionsTitle = document.createElement('div');
  optionsTitle.className = 'analysis-options-title';
  optionsTitle.textContent = 'Plot Options';
  optionsPanel.appendChild(optionsTitle);

  const optionsContent = document.createElement('div');
  optionsContent.className = 'analysis-options-content';
  optionsContent.id = 'analysis-options-content';
  optionsPanel.appendChild(optionsContent);

  body.appendChild(optionsPanel);
  content.appendChild(body);

  // Horizontal resizer between body and footer
  const horizontalResizer = document.createElement('div');
  horizontalResizer.className = 'analysis-modal-resizer analysis-modal-resizer-horizontal';
  horizontalResizer.title = 'Drag to resize vertically';
  content.appendChild(horizontalResizer);

  // Intersection resizer (corner handle for both vertical and horizontal resize)
  const intersectionResizer = document.createElement('div');
  intersectionResizer.className = 'analysis-modal-resizer-intersection';
  intersectionResizer.title = 'Drag to resize both directions';
  content.appendChild(intersectionResizer);

  // Footer area with two panels: Summary Stats (left) + Statistical Annotations (right)
  const footerArea = document.createElement('div');
  footerArea.className = 'analysis-modal-footer-area';

  // Summary stats panel (left)
  const statsPanel = document.createElement('div');
  statsPanel.className = 'analysis-modal-stats-panel';
  statsPanel.id = 'analysis-modal-stats';

  const statsTitle = document.createElement('div');
  statsTitle.className = 'analysis-panel-title';
  statsTitle.textContent = 'Summary Statistics';
  statsPanel.appendChild(statsTitle);

  const statsContent = document.createElement('div');
  statsContent.className = 'analysis-stats-content';
  statsContent.id = 'analysis-stats-content';
  statsPanel.appendChild(statsContent);

  footerArea.appendChild(statsPanel);

  // Footer panel resizer
  const footerResizer = document.createElement('div');
  footerResizer.className = 'analysis-modal-resizer analysis-modal-resizer-vertical';
  footerResizer.title = 'Drag to resize';
  footerArea.appendChild(footerResizer);

  // Statistical annotations panel (right)
  const annotationsPanel = document.createElement('div');
  annotationsPanel.className = 'analysis-modal-annotations-panel';
  annotationsPanel.id = 'analysis-modal-annotations';

  const annotationsTitle = document.createElement('div');
  annotationsTitle.className = 'analysis-panel-title';
  annotationsTitle.textContent = 'Statistical Analysis';
  annotationsPanel.appendChild(annotationsTitle);

  const annotationsContent = document.createElement('div');
  annotationsContent.className = 'analysis-annotations-content';
  annotationsContent.id = 'analysis-annotations-content';
  annotationsPanel.appendChild(annotationsContent);

  footerArea.appendChild(annotationsPanel);
  content.appendChild(footerArea);

  // Add edge resize handles for modal resizing (right and bottom only)
  const edgeRight = document.createElement('div');
  edgeRight.className = 'analysis-modal-edge-resize analysis-modal-edge-resize-right';
  content.appendChild(edgeRight);

  const edgeBottom = document.createElement('div');
  edgeBottom.className = 'analysis-modal-edge-resize analysis-modal-edge-resize-bottom';
  content.appendChild(edgeBottom);

  modal.appendChild(content);

  // Initialize modal edge resize
  initializeModalResize(content, edgeRight, edgeBottom);

  // Initialize internal panel resizers
  initializeResizers(content, body, footerArea, verticalResizer, horizontalResizer, footerResizer, intersectionResizer, optionsPanel);

  // Initialize modal dragging
  initializeModalDrag(modal, content, header);

  // Store references
  modal._plotContainer = plotContainer;
  modal._optionsContent = optionsContent;
  modal._footer = statsContent; // For backwards compatibility
  modal._statsContent = statsContent;
  modal._annotationsContent = annotationsContent;
  modal._title = title;

  return modal;
}

/**
 * Initialize modal edge resize behavior (right and bottom edges only)
 */
function initializeModalResize(content, edgeRight, edgeBottom) {
  const MIN_WIDTH = 600;
  const MIN_HEIGHT = 500; // Increased to accommodate min body (200) + min footer (200) + header

  let isResizing = false;
  let resizeType = null; // 'right' or 'bottom'
  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let startHeight = 0;

  const startResize = (e, type) => {
    isResizing = true;
    resizeType = type;
    startX = e.clientX;
    startY = e.clientY;
    startWidth = content.offsetWidth;
    startHeight = content.offsetHeight;

    document.body.style.userSelect = 'none';
    document.body.style.cursor = type === 'right' ? 'ew-resize' : 'ns-resize';

    e.preventDefault();
    e.stopPropagation();
  };

  edgeRight.addEventListener('mousedown', (e) => startResize(e, 'right'));
  edgeBottom.addEventListener('mousedown', (e) => startResize(e, 'bottom'));

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;

    if (resizeType === 'right') {
      const newWidth = Math.max(MIN_WIDTH, startWidth + deltaX);
      content.style.width = `${newWidth}px`;
      content.style.maxWidth = 'none';
    }

    if (resizeType === 'bottom') {
      const newHeight = Math.max(MIN_HEIGHT, startHeight + deltaY);
      content.style.height = `${newHeight}px`;
      content.style.maxHeight = 'none';
    }
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      resizeType = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

/**
 * Initialize internal panel resizable behavior using flexbox and direct pixel manipulation
 * This approach is more predictable than CSS Grid fr units for resizing
 */
function initializeResizers(content, body, footerArea, verticalResizer, horizontalResizer, footerResizer, intersectionResizer, optionsPanel) {
  // Minimum sizes in pixels
  const MIN = {
    optionsWidth: 200,    // Right panel min width
    plotWidth: 250,       // Left plot area min width
    footerHeight: 200,    // Bottom panels min height
    bodyHeight: 200,      // Main body min height
    statsWidth: 200,      // Stats panel min width
    annotationsWidth: 200 // Annotations panel min width
  };

  // State tracking
  let activeResizer = null; // 'vertical' | 'horizontal' | 'footer' | 'intersection'
  let startX = 0;
  let startY = 0;
  let startOptionsWidth = 0;
  let startFooterHeight = 0;
  let startStatsWidth = 0;

  // Get elements
  const statsPanel = footerArea.querySelector('.analysis-modal-stats-panel');

  // Position the intersection resizer at the corner of vertical and horizontal resizers
  const updateIntersectionPosition = () => {
    const contentRect = content.getBoundingClientRect();
    const verticalResizerRect = verticalResizer.getBoundingClientRect();
    const horizontalResizerRect = horizontalResizer.getBoundingClientRect();
    const intersectionSize = 16;

    // Get the center point of each resizer
    const verticalResizerCenterX = verticalResizerRect.left + (verticalResizerRect.width / 2);
    const horizontalResizerCenterY = horizontalResizerRect.top + (horizontalResizerRect.height / 2);

    // Position intersection centered on both resizers (relative to content)
    const leftPos = verticalResizerCenterX - contentRect.left - (intersectionSize / 2);
    const topPos = horizontalResizerCenterY - contentRect.top - (intersectionSize / 2);

    intersectionResizer.style.left = `${leftPos}px`;
    intersectionResizer.style.top = `${topPos}px`;
    intersectionResizer.style.right = 'auto';
  };

  // Start resize handler using pointer events
  const startResize = (e, type) => {
    e.preventDefault();
    e.stopPropagation();

    activeResizer = type;
    startX = e.clientX;
    startY = e.clientY;
    startOptionsWidth = optionsPanel.offsetWidth;
    startFooterHeight = footerArea.offsetHeight;
    startStatsWidth = statsPanel ? statsPanel.offsetWidth : 0;

    // Add resizing class for visual feedback
    if (type === 'vertical' || type === 'intersection') {
      verticalResizer.classList.add('resizing');
    }
    if (type === 'horizontal' || type === 'intersection') {
      horizontalResizer.classList.add('resizing');
    }
    if (type === 'footer') {
      footerResizer.classList.add('resizing');
    }
    if (type === 'intersection') {
      intersectionResizer.classList.add('resizing');
    }

    // Set cursor based on resize type
    const cursors = {
      vertical: 'col-resize',
      horizontal: 'row-resize',
      footer: 'col-resize',
      intersection: 'nwse-resize'
    };
    document.body.style.cursor = cursors[type];
    document.body.style.userSelect = 'none';

    // Capture pointer for reliable tracking
    e.target.setPointerCapture(e.pointerId);
  };

  // Pointer move handler
  const handlePointerMove = (e) => {
    if (!activeResizer) return;

    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;

    // Handle vertical resizer (options panel width)
    if (activeResizer === 'vertical' || activeResizer === 'intersection') {
      const bodyRect = body.getBoundingClientRect();
      const resizerWidth = verticalResizer.offsetWidth;
      const maxOptionsWidth = bodyRect.width - MIN.plotWidth - resizerWidth;

      // Negative deltaX = dragging left = increasing options width
      let newOptionsWidth = startOptionsWidth - deltaX;
      newOptionsWidth = Math.max(MIN.optionsWidth, Math.min(newOptionsWidth, maxOptionsWidth));

      optionsPanel.style.width = `${newOptionsWidth}px`;
    }

    // Handle horizontal resizer (footer height)
    if (activeResizer === 'horizontal' || activeResizer === 'intersection') {
      const contentRect = content.getBoundingClientRect();
      const headerEl = content.querySelector('.analysis-modal-header');
      const headerHeight = headerEl ? headerEl.offsetHeight : 0;
      const hResizerHeight = horizontalResizer.offsetHeight;
      const maxFooterHeight = contentRect.height - headerHeight - MIN.bodyHeight - hResizerHeight;

      // Negative deltaY = dragging up = increasing footer height
      let newFooterHeight = startFooterHeight - deltaY;
      newFooterHeight = Math.max(MIN.footerHeight, Math.min(newFooterHeight, maxFooterHeight));

      footerArea.style.height = `${newFooterHeight}px`;
    }

    // Handle footer resizer (stats/annotations split)
    if (activeResizer === 'footer') {
      const footerRect = footerArea.getBoundingClientRect();
      const fResizerWidth = footerResizer.offsetWidth;
      const maxStatsWidth = footerRect.width - MIN.annotationsWidth - fResizerWidth;

      let newStatsWidth = startStatsWidth + deltaX;
      newStatsWidth = Math.max(MIN.statsWidth, Math.min(newStatsWidth, maxStatsWidth));

      if (statsPanel) {
        statsPanel.style.flex = 'none';
        statsPanel.style.width = `${newStatsWidth}px`;
      }
    }

    // Update intersection position during resize
    if (activeResizer === 'vertical' || activeResizer === 'horizontal' || activeResizer === 'intersection') {
      requestAnimationFrame(updateIntersectionPosition);
    }
  };

  // Pointer up handler
  const handlePointerUp = (e) => {
    if (!activeResizer) return;

    // Remove resizing classes
    verticalResizer.classList.remove('resizing');
    horizontalResizer.classList.remove('resizing');
    footerResizer.classList.remove('resizing');
    intersectionResizer.classList.remove('resizing');

    activeResizer = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    // Release pointer capture
    if (e.target.hasPointerCapture && e.target.hasPointerCapture(e.pointerId)) {
      e.target.releasePointerCapture(e.pointerId);
    }

    // Final position update for intersection
    updateIntersectionPosition();
  };

  // Attach pointer event handlers to resizers
  verticalResizer.addEventListener('pointerdown', (e) => startResize(e, 'vertical'));
  horizontalResizer.addEventListener('pointerdown', (e) => startResize(e, 'horizontal'));
  footerResizer.addEventListener('pointerdown', (e) => startResize(e, 'footer'));
  intersectionResizer.addEventListener('pointerdown', (e) => startResize(e, 'intersection'));

  // Global pointer move/up handlers
  document.addEventListener('pointermove', handlePointerMove);
  document.addEventListener('pointerup', handlePointerUp);

  // Update intersection position on window resize
  window.addEventListener('resize', () => {
    requestAnimationFrame(updateIntersectionPosition);
  });

  // Create a ResizeObserver to update intersection position when content changes
  // This will also fire when the modal is first added to DOM and laid out
  const resizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(updateIntersectionPosition);
  });
  resizeObserver.observe(content);
  resizeObserver.observe(body);
  resizeObserver.observe(footerArea);

  // Also update after modal open animation completes (200ms + buffer)
  setTimeout(() => {
    updateIntersectionPosition();
  }, 250);
}

/**
 * Initialize modal dragging from header
 */
function initializeModalDrag(modal, content, header) {
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  header.addEventListener('mousedown', (e) => {
    // Don't drag if clicking close button
    if (e.target.closest('.analysis-modal-close')) return;

    isDragging = true;

    // Get current position from styles (already absolute positioned after open)
    initialLeft = parseFloat(content.style.left) || 0;
    initialTop = parseFloat(content.style.top) || 0;

    startX = e.clientX;
    startY = e.clientY;

    document.body.style.cursor = 'move';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;

    const newLeft = initialLeft + deltaX;
    const newTop = initialTop + deltaY;

    // Keep modal within viewport bounds
    const modalRect = modal.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();

    const maxLeft = modalRect.width - contentRect.width - 20;
    const maxTop = modalRect.height - contentRect.height - 20;

    content.style.left = `${Math.max(20, Math.min(newLeft, maxLeft))}px`;
    content.style.top = `${Math.max(20, Math.min(newTop, maxTop))}px`;
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

/**
 * Open the analysis modal
 */
export function openModal(modal) {
  document.body.appendChild(modal);
  // Force reflow for animation
  modal.offsetHeight;
  modal.classList.add('open');

  // After animation, switch to absolute positioning so resize anchors top-left
  const content = modal.querySelector('.analysis-modal-content');
  if (content) {
    // Wait for open animation to complete
    setTimeout(() => {
      const rect = content.getBoundingClientRect();
      const modalRect = modal.getBoundingClientRect();

      // Switch to absolute positioning anchored at top-left
      content.style.position = 'absolute';
      content.style.left = `${rect.left - modalRect.left}px`;
      content.style.top = `${rect.top - modalRect.top}px`;
      content.style.margin = '0';
    }, 200);
  }

  // Trap focus
  const focusableEls = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (focusableEls.length > 0) {
    focusableEls[0].focus();
  }

  // Close on Escape
  const handleEscape = (e) => {
    if (e.key === 'Escape') {
      closeModal(modal);
      document.removeEventListener('keydown', handleEscape);
    }
  };
  document.addEventListener('keydown', handleEscape);
}

/**
 * Close the analysis modal
 */
export function closeModal(modal) {
  modal.classList.remove('open');
  setTimeout(() => {
    if (modal.parentNode) {
      modal.parentNode.removeChild(modal);
    }
  }, 200);
}

/**
 * Render plot options panel based on current plot type
 * @param {HTMLElement} container - Options container
 * @param {string} plotTypeId - Current plot type ID
 * @param {Object} currentOptions - Current option values
 * @param {Function} onChange - Callback when option changes
 */
export function renderPlotOptions(container, plotTypeId, currentOptions = {}, onChange) {
  container.innerHTML = '';

  const plotType = PlotRegistry.get(plotTypeId);
  if (!plotType || !plotType.optionSchema) {
    const empty = document.createElement('div');
    empty.className = 'legend-help';
    empty.textContent = 'No customization options available.';
    container.appendChild(empty);
    return;
  }

  const visibleOptions = PlotRegistry.getVisibleOptions(plotTypeId, currentOptions);

  for (const [key, def] of Object.entries(visibleOptions)) {
    const value = currentOptions[key] ?? plotType.defaultOptions[key];

    const optionRow = document.createElement('div');
    optionRow.className = 'analysis-option-row';

    let input;

    switch (def.type) {
      case 'select': {
        const label = document.createElement('label');
        label.className = 'analysis-option-label';
        label.textContent = def.label;
        label.htmlFor = `analysis-opt-${key}`;
        optionRow.appendChild(label);

        input = document.createElement('select');
        input.className = 'obs-select analysis-option-select';
        input.id = `analysis-opt-${key}`;
        for (const opt of def.options || []) {
          const option = document.createElement('option');
          option.value = opt.value;
          option.textContent = opt.label;
          if (opt.value === value) option.selected = true;
          input.appendChild(option);
        }
        input.addEventListener('change', () => {
          if (onChange) onChange(key, input.value);
        });
        optionRow.appendChild(input);
        break;
      }

      case 'checkbox': {
        optionRow.className = 'analysis-option-row checkbox-row';

        input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'analysis-option-checkbox';
        input.id = `analysis-opt-${key}`;
        input.checked = !!value;
        input.addEventListener('change', () => {
          if (onChange) onChange(key, input.checked);
        });

        const checkLabel = document.createElement('label');
        checkLabel.className = 'analysis-option-label';
        checkLabel.htmlFor = input.id;
        checkLabel.textContent = def.label;

        optionRow.appendChild(input);
        optionRow.appendChild(checkLabel);
        break;
      }

      case 'range':
      case 'number': {
        const label = document.createElement('label');
        label.className = 'analysis-option-label';
        label.textContent = def.label;
        label.htmlFor = `analysis-opt-${key}`;
        optionRow.appendChild(label);

        input = document.createElement('input');
        input.type = 'range';
        input.className = 'analysis-option-range';
        input.id = `analysis-opt-${key}`;
        input.min = def.min ?? 0;
        input.max = def.max ?? 100;
        input.step = def.step ?? 1;
        input.value = value ?? def.min ?? 0;

        const valueDisplay = document.createElement('span');
        valueDisplay.className = 'analysis-option-value';
        valueDisplay.textContent = input.value;

        input.addEventListener('input', () => {
          valueDisplay.textContent = input.value;
        });
        input.addEventListener('change', () => {
          if (onChange) onChange(key, parseFloat(input.value));
        });

        const rangeRow = document.createElement('div');
        rangeRow.className = 'slider-row';
        rangeRow.appendChild(input);
        rangeRow.appendChild(valueDisplay);
        optionRow.appendChild(rangeRow);
        break;
      }

      case 'text': {
        const label = document.createElement('label');
        label.className = 'analysis-option-label';
        label.textContent = def.label;
        label.htmlFor = `analysis-opt-${key}`;
        optionRow.appendChild(label);

        input = document.createElement('input');
        input.type = 'text';
        input.className = 'analysis-option-text';
        input.id = `analysis-opt-${key}`;
        input.value = value ?? '';
        input.placeholder = def.placeholder ?? '';
        input.addEventListener('change', () => {
          if (onChange) onChange(key, input.value);
        });
        optionRow.appendChild(input);
        break;
      }

      default:
        continue;
    }

    container.appendChild(optionRow);
  }

  if (container.children.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'legend-help';
    empty.textContent = 'No customization options available.';
    container.appendChild(empty);
  }
}

/**
 * Create export toolbar - compact style (for inline use)
 * @param {Object} options
 * @param {Function} options.onExportPNG - Export PNG callback
 * @param {Function} options.onExportSVG - Export SVG callback
 * @param {Function} options.onExportCSV - Export CSV callback
 * @returns {HTMLElement}
 */
export function createExportToolbar(options = {}) {
  const { onExportPNG, onExportSVG, onExportCSV } = options;

  const container = document.createElement('div');
  container.className = 'analysis-export-toolbar';

  const createButton = (label, title, onClick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-small';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  };

  if (onExportPNG) {
    container.appendChild(createButton('PNG', 'Download as PNG', onExportPNG));
  }
  if (onExportSVG) {
    container.appendChild(createButton('SVG', 'Download as SVG', onExportSVG));
  }
  if (onExportCSV) {
    container.appendChild(createButton('CSV', 'Download data', onExportCSV));
  }

  return container;
}

/**
 * Create "Open in Popup" button for expanding the analysis view
 */
export function createExpandButton(onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-small analysis-expand-btn';
  btn.innerHTML = '⤢ Expand';
  btn.title = 'Open in popup for more options';
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * Render summary statistics table
 * @param {HTMLElement} container
 * @param {Object[]} pageData - Page data with statistics
 * @param {string} variableName - Variable name
 */
export function renderSummaryStats(container, pageData, variableName) {
  container.innerHTML = '';

  if (!pageData || pageData.length === 0) return;

  const isCategorial = pageData[0]?.variableInfo?.kind === 'category';

  const table = document.createElement('table');
  table.className = 'analysis-stats-table';

  if (isCategorial) {
    // Show category counts per page
    const allCategories = new Set();
    for (const pd of pageData) {
      for (const val of pd.values) {
        allCategories.add(val);
      }
    }
    const categories = Array.from(allCategories).slice(0, 10); // Limit to top 10

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.innerHTML = `<th>${variableName}</th>` + pageData.map(pd => `<th>${pd.pageName}</th>`).join('');
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const cat of categories) {
      const row = document.createElement('tr');
      row.innerHTML = `<td>${cat}</td>` + pageData.map(pd => {
        const count = pd.values.filter(v => v === cat).length;
        const pct = pd.cellCount > 0 ? ((count / pd.cellCount) * 100).toFixed(1) : '0';
        return `<td>${count} (${pct}%)</td>`;
      }).join('');
      tbody.appendChild(row);
    }
    if (allCategories.size > 10) {
      const moreRow = document.createElement('tr');
      moreRow.innerHTML = `<td colspan="${pageData.length + 1}" style="font-style: italic; color: var(--viewer-ink-muted);">... and ${allCategories.size - 10} more categories</td>`;
      tbody.appendChild(moreRow);
    }
    table.appendChild(tbody);
  } else {
    // Show continuous stats
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.innerHTML = '<th>Statistic</th>' + pageData.map(pd => `<th>${pd.pageName}</th>`).join('');
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const stats = ['count', 'mean', 'median', 'min', 'max', 'std'];
    const statLabels = { count: 'Count', mean: 'Mean', median: 'Median', min: 'Min', max: 'Max', std: 'Std Dev' };

    for (const stat of stats) {
      const row = document.createElement('tr');
      row.innerHTML = `<td>${statLabels[stat]}</td>` + pageData.map(pd => {
        const vals = pd.values.filter(v => typeof v === 'number' && !Number.isNaN(v));
        let value = '-';
        if (vals.length > 0) {
          switch (stat) {
            case 'count': value = vals.length; break;
            case 'mean': value = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2); break;
            case 'median':
              const sorted = [...vals].sort((a, b) => a - b);
              const mid = Math.floor(sorted.length / 2);
              value = sorted.length % 2 === 0 ? ((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2) : sorted[mid].toFixed(2);
              break;
            case 'min': value = Math.min(...vals).toFixed(2); break;
            case 'max': value = Math.max(...vals).toFixed(2); break;
            case 'std':
              const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
              const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
              value = Math.sqrt(variance).toFixed(2);
              break;
          }
        }
        return `<td>${value}</td>`;
      }).join('');
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
  }

  container.appendChild(table);
}

/**
 * Render statistical annotations panel
 * Shows appropriate statistical tests based on data type and number of groups
 * @param {HTMLElement} container - Container element
 * @param {Object[]} pageData - Page data with values
 * @param {string} dataType - 'categorical_obs', 'continuous_obs', or 'gene_expression'
 */
export function renderStatisticalAnnotations(container, pageData, dataType) {
  container.innerHTML = '';

  if (!pageData || pageData.length < 2) {
    const help = document.createElement('div');
    help.className = 'analysis-annotations-help';
    help.textContent = 'Select at least 2 pages to see statistical comparisons.';
    container.appendChild(help);
    return;
  }

  // Run statistical tests
  const results = runStatisticalTests(pageData, dataType);

  // Create results display
  const resultsDiv = document.createElement('div');
  resultsDiv.className = 'analysis-annotations-results';

  for (const result of results) {
    const formatted = formatStatisticalResult(result);

    const testCard = document.createElement('div');
    testCard.className = 'analysis-test-card';

    // Test name and significance
    const headerRow = document.createElement('div');
    headerRow.className = 'analysis-test-header';

    const testName = document.createElement('span');
    testName.className = 'analysis-test-name';
    testName.textContent = formatted.test;

    const significance = document.createElement('span');
    significance.className = `analysis-test-significance ${result.significance === 'ns' ? 'not-significant' : 'significant'}`;
    significance.textContent = result.significance;
    significance.title = result.significance === 'ns'
      ? 'Not significant (p ≥ 0.05)'
      : result.significance === '*' ? 'p < 0.05'
      : result.significance === '**' ? 'p < 0.01'
      : 'p < 0.001';

    headerRow.appendChild(testName);
    headerRow.appendChild(significance);
    testCard.appendChild(headerRow);

    // Statistics table
    const statsTable = document.createElement('table');
    statsTable.className = 'analysis-test-stats';

    const addRow = (label, value, highlight = false) => {
      const row = document.createElement('tr');
      if (highlight) row.className = 'highlight';
      row.innerHTML = `<td class="stat-label">${label}</td><td class="stat-value">${value}</td>`;
      statsTable.appendChild(row);
    };

    addRow('Statistic', formatted.statistic);
    addRow('p-value', formatted.pValue, true);
    if (formatted.effectSize !== 'N/A') {
      addRow('Effect Size', formatted.effectSize);
    }

    testCard.appendChild(statsTable);

    // Interpretation
    const interpretation = document.createElement('div');
    interpretation.className = 'analysis-test-interpretation';
    interpretation.textContent = formatted.interpretation;
    testCard.appendChild(interpretation);

    resultsDiv.appendChild(testCard);
  }

  container.appendChild(resultsDiv);

  // Add legend
  const legend = document.createElement('div');
  legend.className = 'analysis-annotations-legend';
  legend.innerHTML = `
    <span class="legend-item"><span class="sig-marker sig-ns">ns</span> not significant</span>
    <span class="legend-item"><span class="sig-marker sig-1">*</span> p &lt; 0.05</span>
    <span class="legend-item"><span class="sig-marker sig-2">**</span> p &lt; 0.01</span>
    <span class="legend-item"><span class="sig-marker sig-3">***</span> p &lt; 0.001</span>
  `;
  container.appendChild(legend);
}

// Legacy exports for backwards compatibility
export function createVariableSelectorOld(options) {
  return createVariableSelector(options);
}

export function createPlotTypePicker(options) {
  return createPlotTypeSelector(options);
}

export function createOptionsPanel() {
  // Return empty container - we're removing options panel for simplicity
  return document.createElement('div');
}

export function createRunButton() {
  // Return empty container - we're removing run button for auto-update
  return document.createElement('div');
}

export default {
  createVariableSelector,
  createGeneExpressionSelector,
  createPageSelector,
  createPageMultiSelect,
  createPlotTypeSelector,
  createAnalysisModal,
  openModal,
  closeModal,
  renderPlotOptions,
  renderSummaryStats,
  renderStatisticalAnnotations,
  createExportToolbar,
  createExpandButton
};
