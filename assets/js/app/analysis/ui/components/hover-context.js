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
 * const hover = new HoverContext({ container: document.body });
 *
 * plotElement.on('plotly_hover', (data) => {
 *   hover.show({
 *     gene: data.points[0].y,
 *     group: data.points[0].x,
 *     value: data.points[0].z,
 *     position: { x: data.event.clientX, y: data.event.clientY }
 *   });
 * });
 *
 * plotElement.on('plotly_unhover', () => hover.hide());
 */
export class HoverContext {
  /**
   * Create a HoverContext
   *
   * @param {Object} options
   * @param {HTMLElement} options.container - Container element
   * @param {Object} [options.markers] - Marker discovery results for stats lookup
   * @param {number} [options.offset=10] - Offset from cursor
   */
  constructor(options) {
    const { container, markers = null, offset = 10 } = options;

    if (!container) {
      throw new Error('[HoverContext] container is required');
    }

    /** @type {HTMLElement} */
    this._container = container;

    /** @type {Object|null} */
    this._markers = markers;

    /** @type {number} */
    this._offset = offset;

    /** @type {HTMLElement|null} */
    this._element = null;

    /** @type {number|null} */
    this._hideTimeout = null;

    /** @type {boolean} */
    this._visible = false;

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
   * @param {Object} [data.markerInfo] - Additional marker statistics
   */
  show(data) {
    const { gene, group, value, position, markerInfo = null } = data;

    // Cancel any pending hide
    if (this._hideTimeout) {
      clearTimeout(this._hideTimeout);
      this._hideTimeout = null;
    }

    // Build content
    const content = this._buildContent(gene, group, value, markerInfo);
    this._element.innerHTML = content;

    // Position the tooltip
    this._positionTooltip(position);

    // Show
    this._element.classList.add('visible');
    this._visible = true;
  }

  /**
   * Hide the hover context
   *
   * @param {number} [delay=100] - Delay before hiding (ms)
   */
  hide(delay = 100) {
    if (this._hideTimeout) {
      clearTimeout(this._hideTimeout);
    }

    this._hideTimeout = setTimeout(() => {
      this._element.classList.remove('visible');
      this._visible = false;
      this._hideTimeout = null;
    }, delay);
  }

  /**
   * Update marker data for stats lookup
   *
   * @param {Object} markers - Marker discovery results
   */
  setMarkers(markers) {
    this._markers = markers;
  }

  /**
   * Destroy the component
   */
  destroy() {
    if (this._hideTimeout) {
      clearTimeout(this._hideTimeout);
    }
    if (this._element && this._element.parentNode) {
      this._element.parentNode.removeChild(this._element);
    }
    this._element = null;
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Create the tooltip DOM element
   * @private
   */
  _createTooltipElement() {
    this._element = document.createElement('div');
    this._element.className = 'hover-context-tooltip';
    this._element.style.cssText = `
      position: fixed;
      z-index: 10000;
      background: var(--color-bg-elevated, #fff);
      border: 1px solid var(--color-border, #ddd);
      border-radius: 6px;
      padding: 8px 12px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      font-family: var(--font-sans, system-ui, sans-serif);
      font-size: 12px;
      line-height: 1.4;
      max-width: 280px;
      pointer-events: none;
      opacity: 0;
      transform: translateY(4px);
      transition: opacity 0.15s ease, transform 0.15s ease;
    `;

    // Add visible state styles once (avoids leaking <style> tags across reruns).
    const styleId = 'cellucid-hover-context-tooltip-styles';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        .hover-context-tooltip.visible {
          opacity: 1;
          transform: translateY(0);
        }
        .hover-context-tooltip .gene-name {
          font-weight: 600;
          font-size: 13px;
          color: var(--color-text, #333);
          margin-bottom: 4px;
        }
        .hover-context-tooltip .group-name {
          color: var(--color-text-muted, #666);
          margin-bottom: 6px;
        }
        .hover-context-tooltip .stat-row {
          display: flex;
          justify-content: space-between;
          margin-top: 2px;
        }
        .hover-context-tooltip .stat-label {
          color: var(--color-text-muted, #666);
        }
        .hover-context-tooltip .stat-value {
          font-weight: 500;
          color: var(--color-text, #333);
        }
        .hover-context-tooltip .stat-value.positive {
          color: var(--color-success, #22c55e);
        }
        .hover-context-tooltip .stat-value.negative {
          color: var(--color-error, #ef4444);
        }
        .hover-context-tooltip .divider {
          border-top: 1px solid var(--color-border, #eee);
          margin: 6px 0;
        }
      `;
      document.head.appendChild(style);
    }
    this._container.appendChild(this._element);
  }

  /**
   * Build tooltip content HTML
   * @private
   */
  _buildContent(gene, group, value, markerInfo) {
    let html = `
      <div class="gene-name">${this._escapeHtml(gene)}</div>
      <div class="group-name">${this._escapeHtml(group)}</div>
    `;

    // Value row
    const valueClass = value > 0 ? 'positive' : value < 0 ? 'negative' : '';
    html += `
      <div class="stat-row">
        <span class="stat-label">Value:</span>
        <span class="stat-value ${valueClass}">${this._formatNumber(value)}</span>
      </div>
    `;

    // Add marker stats if available
    if (markerInfo) {
      html += '<div class="divider"></div>';

      if (markerInfo.pValue !== undefined) {
        html += `
          <div class="stat-row">
            <span class="stat-label">p-value:</span>
            <span class="stat-value">${this._formatPValue(markerInfo.pValue)}</span>
          </div>
        `;
      }

      if (markerInfo.adjustedPValue !== undefined && markerInfo.adjustedPValue !== null) {
        html += `
          <div class="stat-row">
            <span class="stat-label">Adj. p-value:</span>
            <span class="stat-value">${this._formatPValue(markerInfo.adjustedPValue)}</span>
          </div>
        `;
      }

      if (markerInfo.log2FoldChange !== undefined) {
        const fcClass = markerInfo.log2FoldChange > 0 ? 'positive' : 'negative';
        html += `
          <div class="stat-row">
            <span class="stat-label">Log2 FC:</span>
            <span class="stat-value ${fcClass}">${this._formatNumber(markerInfo.log2FoldChange)}</span>
          </div>
        `;
      }

      if (markerInfo.percentInGroup !== undefined) {
        html += `
          <div class="stat-row">
            <span class="stat-label">% in group:</span>
            <span class="stat-value">${this._formatPercent(markerInfo.percentInGroup)}</span>
          </div>
        `;
      }

      if (markerInfo.rank !== undefined) {
        html += `
          <div class="stat-row">
            <span class="stat-label">Rank:</span>
            <span class="stat-value">#${markerInfo.rank}</span>
          </div>
        `;
      }
    } else if (this._markers) {
      // Try to find marker info from stored markers
      const info = this._findMarkerInfo(gene, group);
      if (info) {
        return this._buildContent(gene, group, value, info);
      }
    }

    return html;
  }

  /**
   * Find marker info for a gene in a group
   * @private
   */
  _findMarkerInfo(gene, group) {
    if (!this._markers || !this._markers.groups) return null;

    const groupData = this._markers.groups[group];
    if (!groupData || !groupData.markers) return null;

    return groupData.markers.find(m => m.gene === gene);
  }

  /**
   * Position the tooltip relative to cursor
   * @private
   */
  _positionTooltip(position) {
    const { x, y } = position;
    const rect = this._element.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

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
    if (!Number.isFinite(value)) return 'N/A';
    if (Math.abs(value) < 0.01) return value.toExponential(2);
    return value.toFixed(2);
  }

  /**
   * Format a p-value for display
   * @private
   */
  _formatPValue(value) {
    if (!Number.isFinite(value)) return 'N/A';
    if (value < 0.0001) return value.toExponential(2);
    if (value < 0.001) return value.toFixed(4);
    return value.toFixed(3);
  }

  /**
   * Format a percentage for display
   * @private
   */
  _formatPercent(value) {
    if (!Number.isFinite(value)) return 'N/A';
    return `${value.toFixed(1)}%`;
  }

  /**
   * Escape HTML to prevent XSS
   * @private
   */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
