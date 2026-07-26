/**
 * Hover Context Component
 *
 * Displays contextual information when hovering over heatmap cells.
 * Shows gene statistics, group information, and marker details.
 *
 * Features:
 * - Position-aware placement (avoids viewport edges)
 * - Smooth fade in/out transitions
 * - Formatted statistics display
 * - Gene and group highlighting linkage
 *
 * @module ui/components/hover-context
 */

// =============================================================================
// HOVER CONTEXT COMPONENT
// =============================================================================

/**
 * Hover Context display component
 *
 * @example
 * const hover = new HoverContext({ container: document.body, offset: 10 });
 *
 * plotElement.on('plotly_hover', (data) => {
 *   hover.show({
 *     gene: data.points[0].y,
 *     group: data.points[0].x,
 *     value: data.points[0].z,
 *     position: { x: data.event.clientX, y: data.event.clientY },
 *     markerInfo: null
 *   });
 * });
 *
 * plotElement.on('plotly_unhover', () => hover.hide(100));
 */
export class HoverContext {
  /**
   * Create a HoverContext
   *
   * @param {Object} options
   * @param {HTMLElement} options.container - Container element
   * @param {number} options.offset - Offset from cursor
   */
  constructor(options) {
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).sort().join(',') !== 'container,offset'
    ) {
      throw new TypeError(
        '[HoverContext] options must contain exactly container and offset'
      );
    }
    const { container, offset } = options;
    if (
      container === null ||
      typeof container !== 'object' ||
      container.nodeType !== 1 ||
      container.ownerDocument === null ||
      typeof container.ownerDocument !== 'object' ||
      typeof container.appendChild !== 'function'
    ) {
      throw new TypeError('[HoverContext] container must be an HTMLElement');
    }
    if (!Number.isFinite(offset) || offset < 0) {
      throw new RangeError(
        '[HoverContext] offset must be a finite non-negative number'
      );
    }
    const view = container.ownerDocument.defaultView;
    if (
      view === null ||
      typeof view !== 'object' ||
      typeof view.setTimeout !== 'function' ||
      typeof view.clearTimeout !== 'function'
    ) {
      throw new TypeError(
        '[HoverContext] container document must own an active window'
      );
    }

    /** @type {HTMLElement} */
    this._container = container;

    /** @type {Document} */
    this._document = container.ownerDocument;

    /** @type {Window} */
    this._view = view;

    /** @type {number} */
    this._offset = offset;

    /** @type {HTMLElement|null} */
    this._element = null;

    /** @type {number|null} */
    this._hideTimeout = null;

    /** @type {boolean} */
    this._visible = false;

    /** @type {boolean} */
    this._destroyed = false;

    this._createTooltipElement();
  }

  /**
   * Show the hover context
   *
   * @param {Object} data
   * @param {string} data.gene - Gene symbol
   * @param {string} data.group - Group name
   * @param {number} data.value - Expression value
   * @param {{ x: number, y: number }} data.position - Cursor position
   * @param {{
   *   pValue: number,
   *   adjustedPValue: number|null,
   *   log2FoldChange: number,
   *   percentInGroup: number|null,
   *   rank: number
   * }|null} data.markerInfo - Normalized marker statistics or explicit absence
   */
  show(data) {
    this._requireAlive();
    this._validateShowData(data);
    const { gene, group, value, position, markerInfo } = data;

    // Cancel any pending hide
    if (this._hideTimeout !== null) {
      this._view.clearTimeout(this._hideTimeout);
      this._hideTimeout = null;
    }

    // Build content
    const content = this._buildContent(gene, group, value, markerInfo);
    this._element.replaceChildren(content);

    // Position the tooltip
    this._positionTooltip(position);

    // Show
    this._element.classList.add('visible');
    this._visible = true;
  }

  /**
   * Hide the hover context
   *
   * @param {number} delay - Delay before hiding (ms)
   */
  hide(delay) {
    this._requireAlive();
    if (!Number.isSafeInteger(delay) || delay < 0) {
      throw new RangeError(
        '[HoverContext] hide delay must be a non-negative integer'
      );
    }
    if (this._hideTimeout !== null) {
      this._view.clearTimeout(this._hideTimeout);
    }

    this._hideTimeout = this._view.setTimeout(() => {
      this._element.classList.remove('visible');
      this._visible = false;
      this._hideTimeout = null;
    }, delay);
  }

  /**
   * Destroy the component
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._hideTimeout !== null) {
      this._view.clearTimeout(this._hideTimeout);
      this._hideTimeout = null;
    }
    if (this._element.parentNode !== null) {
      this._element.parentNode.removeChild(this._element);
    }
    this._element = null;
    this._visible = false;
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Create the tooltip DOM element
   * @private
   */
  _createTooltipElement() {
    this._element = this._document.createElement('div');
    this._element.className = 'hover-context-tooltip';
    this._container.appendChild(this._element);
  }

  /**
   * Build tooltip content
   * @private
   */
  _buildContent(gene, group, value, markerInfo) {
    const fragment = this._document.createDocumentFragment();
    fragment.appendChild(this._createTextElement('gene-name', gene));
    fragment.appendChild(this._createTextElement('group-name', group));
    const valueClass = value > 0 ? 'positive' : value < 0 ? 'negative' : '';
    fragment.appendChild(
      this._createStatRow('Value:', this._formatNumber(value), valueClass)
    );

    if (markerInfo !== null) {
      fragment.appendChild(this._createTextElement('divider', ''));
      fragment.appendChild(
        this._createStatRow('p-value:', this._formatPValue(markerInfo.pValue))
      );
      if (markerInfo.adjustedPValue !== null) {
        fragment.appendChild(
          this._createStatRow(
            'Adj. p-value:',
            this._formatPValue(markerInfo.adjustedPValue)
          )
        );
      }
      const foldChangeClass =
        markerInfo.log2FoldChange > 0
          ? 'positive'
          : markerInfo.log2FoldChange < 0
            ? 'negative'
            : '';
      fragment.appendChild(
        this._createStatRow(
          'Log2 FC:',
          this._formatNumber(markerInfo.log2FoldChange),
          foldChangeClass
        )
      );
      if (markerInfo.percentInGroup !== null) {
        fragment.appendChild(
          this._createStatRow(
            '% in group:',
            this._formatPercent(markerInfo.percentInGroup)
          )
        );
      }
      fragment.appendChild(
        this._createStatRow('Rank:', `#${markerInfo.rank}`)
      );
    }

    return fragment;
  }

  /**
   * Create a text-only element.
   * @private
   */
  _createTextElement(className, text) {
    const element = this._document.createElement('div');
    element.className = className;
    element.textContent = text;
    return element;
  }

  /**
   * Create one statistics row.
   * @private
   */
  _createStatRow(label, value, valueClass = '') {
    const row = this._document.createElement('div');
    row.className = 'stat-row';
    const labelElement = this._document.createElement('span');
    labelElement.className = 'stat-label';
    labelElement.textContent = label;
    const valueElement = this._document.createElement('span');
    valueElement.className =
      valueClass.length === 0
        ? 'stat-value'
        : `stat-value ${valueClass}`;
    valueElement.textContent = value;
    row.append(labelElement, valueElement);
    return row;
  }

  /**
   * Position the tooltip relative to cursor
   * @private
   */
  _positionTooltip(position) {
    const { x, y } = position;
    const rect = this._element.getBoundingClientRect();
    const viewportWidth = this._view.innerWidth;
    const viewportHeight = this._view.innerHeight;
    if (
      !Number.isFinite(viewportWidth) ||
      viewportWidth <= 0 ||
      !Number.isFinite(viewportHeight) ||
      viewportHeight <= 0
    ) {
      throw new RangeError(
        '[HoverContext] window dimensions must be finite and positive'
      );
    }

    let left = x + this._offset;
    let top = y + this._offset;

    // Check right edge
    if (left + rect.width > viewportWidth - 10) {
      left = x - rect.width - this._offset;
    }

    // Check bottom edge
    if (top + rect.height > viewportHeight - 10) {
      top = y - rect.height - this._offset;
    }

    // Clamp to viewport
    left = Math.max(10, Math.min(left, viewportWidth - rect.width - 10));
    top = Math.max(10, Math.min(top, viewportHeight - rect.height - 10));

    this._element.style.left = `${left}px`;
    this._element.style.top = `${top}px`;
  }

  /**
   * Format a number for display
   * @private
   */
  _formatNumber(value) {
    if (Math.abs(value) < 0.01) return value.toExponential(2);
    return value.toFixed(2);
  }

  /**
   * Format a p-value for display
   * @private
   */
  _formatPValue(value) {
    if (value < 0.0001) return value.toExponential(2);
    if (value < 0.001) return value.toFixed(4);
    return value.toFixed(3);
  }

  /**
   * Format a percentage for display
   * @private
   */
  _formatPercent(value) {
    return `${value.toFixed(1)}%`;
  }

  /**
   * Reject use after destroy.
   * @private
   */
  _requireAlive() {
    if (this._destroyed) {
      throw new Error('[HoverContext] component is destroyed');
    }
  }

  /**
   * Validate the normalized tooltip input.
   * @private
   */
  _validateShowData(data) {
    if (
      data === null ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      Object.keys(data).sort().join(',') !==
        'gene,group,markerInfo,position,value'
    ) {
      throw new TypeError(
        '[HoverContext] show data must contain exactly gene, group, markerInfo, position, and value'
      );
    }
    if (typeof data.gene !== 'string' || data.gene.length === 0) {
      throw new TypeError('[HoverContext] gene must be a non-empty string');
    }
    if (typeof data.group !== 'string' || data.group.length === 0) {
      throw new TypeError('[HoverContext] group must be a non-empty string');
    }
    if (!Number.isFinite(data.value)) {
      throw new TypeError('[HoverContext] value must be finite');
    }
    if (
      data.position === null ||
      typeof data.position !== 'object' ||
      Array.isArray(data.position) ||
      Object.keys(data.position).sort().join(',') !== 'x,y' ||
      !Number.isFinite(data.position.x) ||
      !Number.isFinite(data.position.y)
    ) {
      throw new TypeError(
        '[HoverContext] position must contain exactly finite x and y coordinates'
      );
    }
    if (data.markerInfo === null) return;
    const info = data.markerInfo;
    if (
      typeof info !== 'object' ||
      Array.isArray(info) ||
      Object.keys(info).sort().join(',') !==
        'adjustedPValue,log2FoldChange,pValue,percentInGroup,rank'
    ) {
      throw new TypeError(
        '[HoverContext] markerInfo must be null or the exact normalized marker schema'
      );
    }
    if (
      !Number.isFinite(info.pValue) ||
      info.pValue < 0 ||
      info.pValue > 1 ||
      (
        info.adjustedPValue !== null &&
        (
          !Number.isFinite(info.adjustedPValue) ||
          info.adjustedPValue < 0 ||
          info.adjustedPValue > 1
        )
      ) ||
      !Number.isFinite(info.log2FoldChange) ||
      (
        info.percentInGroup !== null &&
        (
          !Number.isFinite(info.percentInGroup) ||
          info.percentInGroup < 0 ||
          info.percentInGroup > 100
        )
      ) ||
      !Number.isSafeInteger(info.rank) ||
      info.rank < 1
    ) {
      throw new RangeError(
        '[HoverContext] markerInfo statistics are outside their exact domains'
      );
    }
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a HoverContext instance
 *
 * @param {Object} options - Same options as HoverContext constructor
 * @returns {HoverContext}
 */
export function createHoverContext(options) {
  return new HoverContext(options);
}

export default HoverContext;
