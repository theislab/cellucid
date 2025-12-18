/**
 * Scatter Plot Builder
 *
 * An interactive tool for scientists to explore correlations between variables.
 * Allows selection of any two continuous variables (genes or metadata) and
 * visualizes their relationship with a scatter plot.
 *
 * Features:
 * - Dual variable selectors (X and Y axes)
 * - Real-time correlation computation
 * - Trend line with R-squared
 * - Color by categorical variable
 * - Interactive point selection
 */

import { getNotificationCenter } from '../../notification-center.js';
import { createAnalysisModal, openModal, closeModal } from '../ui/components/modal.js';
import { createMinimalPlotly, downloadImage, getScatterTraceType, purgePlot } from './plotly-loader.js';
import { downloadCSV, toCSVCell } from '../shared/analysis-utils.js';

/**
 * Scatter Plot Builder class
 */
export class ScatterBuilder {
  /**
   * @param {Object} options
   * @param {Object} options.dataLayer - Enhanced data layer instance
   * @param {HTMLElement} options.container - Container element
   * @param {Object} options.plotRegistry - Plot registry instance
   * @param {Function} options.renderPlot - Function to render plots
   */
  constructor(options) {
    this.dataLayer = options.dataLayer;
    this.container = options.container;
    this.plotRegistry = options.plotRegistry;
    this.renderPlot = options.renderPlot;

    this._notifications = getNotificationCenter();

    // Current configuration
    this.config = {
      xVariable: null, // { type: 'continuous_obs'|'gene_expression', key: string }
      yVariable: null,
      colorBy: null,  // { type: 'categorical_obs', key: string }
      pageIds: [],
      showTrendline: true,
      logScaleX: false,
      logScaleY: false
    };

    this._plotContainer = null;
    this._statsContainer = null;
    this._actionsContainer = null;
    this._isLoading = false;
    this._modal = null;
    this._lastPlotData = null;
    this._lastCorrelation = null;
  }

  /**
   * Initialize the scatter builder UI
   */
  init() {
    this._render();
  }

  /**
   * Set the pages to analyze
   */
  setPages(pageIds) {
    this.config.pageIds = pageIds;
    this._updateUI();
  }

  /**
   * Render the scatter builder UI
   */
  _render() {
    this.container.innerHTML = '';
    this.container.className = 'scatter-builder';

    // Create header
    const header = document.createElement('div');
    header.className = 'scatter-builder-header';
    header.innerHTML = `
      <h3>Correlation Explorer</h3>
      <p>Select two variables to visualize their relationship.</p>
    `;
    this.container.appendChild(header);

    // Create variable selectors section
    const selectorsSection = document.createElement('div');
    selectorsSection.className = 'scatter-selectors';

    // X-axis variable
    const xAxisGroup = this._createVariableSelector('X Axis', 'x');
    selectorsSection.appendChild(xAxisGroup);

    // Y-axis variable
    const yAxisGroup = this._createVariableSelector('Y Axis', 'y');
    selectorsSection.appendChild(yAxisGroup);

    this.container.appendChild(selectorsSection);

    // Color by selector (optional)
    const colorSection = document.createElement('div');
    colorSection.className = 'scatter-color-section';

    const colorLabel = document.createElement('label');
    colorLabel.textContent = 'Color by (optional):';
    colorLabel.className = 'scatter-label';
    colorSection.appendChild(colorLabel);

    this._colorSelect = document.createElement('select');
    this._colorSelect.className = 'scatter-select';
    this._colorSelect.innerHTML = '<option value="">None</option>';
    this._populateColorOptions();
    this._colorSelect.addEventListener('change', () => {
      if (this._colorSelect.value) {
        this.config.colorBy = { type: 'categorical_obs', key: this._colorSelect.value };
      } else {
        this.config.colorBy = null;
      }
      this._updatePlot();
    });
    colorSection.appendChild(this._colorSelect);

    this.container.appendChild(colorSection);

    // Options row
    const optionsRow = document.createElement('div');
    optionsRow.className = 'scatter-options';

    // Trendline checkbox
    const trendlineLabel = document.createElement('label');
    trendlineLabel.className = 'scatter-checkbox-label';
    trendlineLabel.innerHTML = `
      <input type="checkbox" checked class="scatter-checkbox" id="scatter-trendline" />
      Show trendline
    `;
    trendlineLabel.querySelector('input').addEventListener('change', (e) => {
      this.config.showTrendline = e.target.checked;
      this._updatePlot();
    });
    optionsRow.appendChild(trendlineLabel);

    // Log scale X
    const logXLabel = document.createElement('label');
    logXLabel.className = 'scatter-checkbox-label';
    logXLabel.innerHTML = `
      <input type="checkbox" class="scatter-checkbox" id="scatter-logx" />
      Log scale X
    `;
    logXLabel.querySelector('input').addEventListener('change', (e) => {
      this.config.logScaleX = e.target.checked;
      this._updatePlot();
    });
    optionsRow.appendChild(logXLabel);

    // Log scale Y
    const logYLabel = document.createElement('label');
    logYLabel.className = 'scatter-checkbox-label';
    logYLabel.innerHTML = `
      <input type="checkbox" class="scatter-checkbox" id="scatter-logy" />
      Log scale Y
    `;
    logYLabel.querySelector('input').addEventListener('change', (e) => {
      this.config.logScaleY = e.target.checked;
      this._updatePlot();
    });
    optionsRow.appendChild(logYLabel);

    this.container.appendChild(optionsRow);

    // Plot container
    this._plotContainer = document.createElement('div');
    this._plotContainer.className = 'scatter-plot-container empty';
    this._plotContainer.innerHTML = '<p class="scatter-placeholder">Select X and Y variables to generate plot</p>';
    this.container.appendChild(this._plotContainer);

    // Stats container
    this._statsContainer = document.createElement('div');
    this._statsContainer.className = 'scatter-stats';
    this.container.appendChild(this._statsContainer);

    // Actions container (expand button)
    this._actionsContainer = document.createElement('div');
    this._actionsContainer.className = 'scatter-actions';
    this._actionsContainer.style.display = 'none';
    this.container.appendChild(this._actionsContainer);

    // Add expand button
    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'btn-small scatter-expand-btn';
    expandBtn.textContent = 'Expand';
    expandBtn.title = 'Open in full view with export options';
    expandBtn.addEventListener('click', () => this._openExpandedView());
    this._actionsContainer.appendChild(expandBtn);
  }

  /**
   * Create a variable selector group
   */
  _createVariableSelector(label, axis) {
    const group = document.createElement('div');
    group.className = 'scatter-variable-group';

    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    labelEl.className = 'scatter-label';
    group.appendChild(labelEl);

    // Type selector
    const typeSelect = document.createElement('select');
    typeSelect.className = 'scatter-select scatter-type-select';
    typeSelect.innerHTML = `
      <option value="">Select type...</option>
      <option value="continuous_obs">Metadata (continuous)</option>
      <option value="gene_expression">Gene Expression</option>
    `;
    group.appendChild(typeSelect);

    // Variable selector (initially hidden)
    const varSelect = document.createElement('select');
    varSelect.className = 'scatter-select scatter-var-select';
    varSelect.style.display = 'none';
    group.appendChild(varSelect);

    // Gene search input (for gene expression)
    const geneInput = document.createElement('input');
    geneInput.type = 'text';
    geneInput.className = 'scatter-input scatter-gene-input';
    geneInput.placeholder = 'Search gene...';
    geneInput.style.display = 'none';
    group.appendChild(geneInput);

    // Gene suggestions dropdown
    const geneSuggestions = document.createElement('div');
    geneSuggestions.className = 'scatter-suggestions';
    geneSuggestions.style.display = 'none';
    group.appendChild(geneSuggestions);

    // Event handlers
    typeSelect.addEventListener('change', () => {
      const type = typeSelect.value;

      if (type === 'continuous_obs') {
        varSelect.style.display = 'block';
        geneInput.style.display = 'none';
        geneSuggestions.style.display = 'none';
        this._populateContinuousOptions(varSelect);
      } else if (type === 'gene_expression') {
        varSelect.style.display = 'none';
        geneInput.style.display = 'block';
        geneInput.value = '';
      } else {
        varSelect.style.display = 'none';
        geneInput.style.display = 'none';
        geneSuggestions.style.display = 'none';
        this._setAxisVariable(axis, null);
      }
    });

    varSelect.addEventListener('change', () => {
      if (varSelect.value) {
        this._setAxisVariable(axis, { type: 'continuous_obs', key: varSelect.value });
      } else {
        this._setAxisVariable(axis, null);
      }
    });

    // Gene search with debounce
    let searchTimeout = null;
    geneInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      const query = geneInput.value.trim();

      if (query.length < 2) {
        geneSuggestions.style.display = 'none';
        return;
      }

      searchTimeout = setTimeout(() => {
        this._searchGenes(query, geneSuggestions, geneInput, axis);
      }, 200);
    });

    geneInput.addEventListener('blur', () => {
      // Delay hiding to allow click on suggestions
      setTimeout(() => {
        geneSuggestions.style.display = 'none';
      }, 200);
    });

    return group;
  }

  /**
   * Populate continuous variable options
   */
  _populateContinuousOptions(select) {
    const vars = this.dataLayer.getAvailableVariables('continuous_obs');
    select.innerHTML = '<option value="">Select variable...</option>';
    vars.forEach(v => {
      const option = document.createElement('option');
      option.value = v.key;
      option.textContent = v.name || v.key;
      select.appendChild(option);
    });
  }

  /**
   * Populate color by options
   */
  _populateColorOptions() {
    const vars = this.dataLayer.getAvailableVariables('categorical_obs');
    vars.forEach(v => {
      const option = document.createElement('option');
      option.value = v.key;
      option.textContent = v.name || v.key;
      this._colorSelect.appendChild(option);
    });
  }

  /**
   * Search genes and show suggestions
   */
  _searchGenes(query, container, input, axis) {
    const allGenes = this.dataLayer.getAvailableVariables('gene_expression');
    const lowerQuery = query.toLowerCase();

    const matches = allGenes
      .filter(g => g.key.toLowerCase().includes(lowerQuery))
      .slice(0, 10);

    if (matches.length === 0) {
      container.innerHTML = '<div class="scatter-suggestion-item no-results">No genes found</div>';
      container.style.display = 'block';
      return;
    }

    container.innerHTML = '';
    matches.forEach(gene => {
      const item = document.createElement('div');
      item.className = 'scatter-suggestion-item';
      item.textContent = gene.key;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = gene.key;
        container.style.display = 'none';
        this._setAxisVariable(axis, { type: 'gene_expression', key: gene.key });
      });
      container.appendChild(item);
    });

    container.style.display = 'block';
  }

  /**
   * Set an axis variable
   */
  _setAxisVariable(axis, variable) {
    if (axis === 'x') {
      this.config.xVariable = variable;
    } else {
      this.config.yVariable = variable;
    }
    this._updatePlot();
  }

  /**
   * Update the plot
   */
  async _updatePlot() {
    // Check if we have both variables
    if (!this.config.xVariable || !this.config.yVariable) {
      this._plotContainer.className = 'scatter-plot-container empty';
      this._plotContainer.innerHTML = '<p class="scatter-placeholder">Select X and Y variables to generate plot</p>';
      this._statsContainer.innerHTML = '';
      return;
    }

    if (this.config.pageIds.length === 0) {
      this._plotContainer.className = 'scatter-plot-container empty';
      this._plotContainer.innerHTML = '<p class="scatter-placeholder">No pages selected</p>';
      this._statsContainer.innerHTML = '';
      return;
    }

    // Show loading
    this._plotContainer.className = 'scatter-plot-container loading';
    this._isLoading = true;

    try {
      // Fetch data for both variables
      const [xData, yData] = await Promise.all([
        this.dataLayer.getDataForPages({
          type: this.config.xVariable.type,
          variableKey: this.config.xVariable.key,
          pageIds: this.config.pageIds
        }),
        this.dataLayer.getDataForPages({
          type: this.config.yVariable.type,
          variableKey: this.config.yVariable.key,
          pageIds: this.config.pageIds
        })
      ]);

      // Fetch color data if specified
      let colorData = null;
      if (this.config.colorBy) {
        colorData = await this.dataLayer.getDataForPages({
          type: this.config.colorBy.type,
          variableKey: this.config.colorBy.key,
          pageIds: this.config.pageIds
        });
      }

      // Prepare combined data
      const plotData = this._prepareScatterData(xData, yData, colorData);

      if (plotData.x.length === 0) {
        this._plotContainer.className = 'scatter-plot-container empty';
        this._plotContainer.innerHTML = '<p class="scatter-placeholder">No overlapping data points</p>';
        this._statsContainer.innerHTML = '';
        this._actionsContainer.style.display = 'none';
        return;
      }

      // Compute correlation
      const correlation = this._computeCorrelation(plotData.x, plotData.y);

      // Save for expand view
      this._lastPlotData = plotData;
      this._lastCorrelation = correlation;

      // Render plot
      await this._renderScatterPlot(plotData, correlation);

      // Show stats
      this._renderStats(correlation, plotData.x.length);

      // Show actions container
      this._actionsContainer.style.display = 'flex';

    } catch (error) {
      console.error('[ScatterBuilder] Failed to update plot:', error);
      this._plotContainer.className = 'scatter-plot-container error';
      this._plotContainer.innerHTML = `<p class="scatter-placeholder">Error: ${error.message}</p>`;
    } finally {
      this._isLoading = false;
    }
  }

  /**
   * Prepare scatter plot data
   */
  _prepareScatterData(xData, yData, colorData) {
    const result = {
      x: [],
      y: [],
      color: [],
      pageNames: []
    };

    // Build index maps
    for (const xPage of xData) {
      const yPage = yData.find(y => y.pageId === xPage.pageId);
      if (!yPage) continue;

      const colorPage = colorData?.find(c => c.pageId === xPage.pageId);

      // Create index -> value maps
      const xMap = new Map();
      for (let i = 0; i < xPage.cellIndices.length; i++) {
        xMap.set(xPage.cellIndices[i], xPage.values[i]);
      }

      const yMap = new Map();
      for (let i = 0; i < yPage.cellIndices.length; i++) {
        yMap.set(yPage.cellIndices[i], yPage.values[i]);
      }

      const colorMap = new Map();
      if (colorPage) {
        for (let i = 0; i < colorPage.cellIndices.length; i++) {
          colorMap.set(colorPage.cellIndices[i], colorPage.values[i]);
        }
      }

      // Find overlapping indices
      for (const [idx, xVal] of xMap) {
        if (!yMap.has(idx)) continue;

        const yVal = yMap.get(idx);

        // Skip invalid values
        if (!Number.isFinite(xVal)) continue;
        if (!Number.isFinite(yVal)) continue;

        result.x.push(xVal);
        result.y.push(yVal);
        result.color.push(colorMap.get(idx) || 'Default');
        result.pageNames.push(xPage.pageName);
      }
    }

    return result;
  }

  /**
   * Compute Pearson correlation
   */
  _computeCorrelation(x, y) {
    const n = x.length;
    if (n < 3) {
      return { r: NaN, rSquared: NaN, pValue: NaN };
    }

    // Compute means
    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;

    // Compute correlation
    let sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      sumXY += dx * dy;
      sumX2 += dx * dx;
      sumY2 += dy * dy;
    }

    const denom = Math.sqrt(sumX2 * sumY2);
    const r = denom > 0 ? (sumXY / denom) : 0;
    const rSquared = r * r;

    // Compute p-value (t-test for correlation)
    const t = rSquared >= 1 ? Infinity : (r * Math.sqrt((n - 2) / (1 - rSquared)));
    const pValue = Number.isFinite(t) ? this._tDistributionPValue(Math.abs(t), n - 2) : 0;

    // Compute trendline coefficients
    const slope = sumX2 > 0 ? (sumXY / sumX2) : 0;
    const intercept = meanY - slope * meanX;

    return {
      r: Number.isFinite(r) ? r : 0,
      rSquared: Number.isFinite(rSquared) ? rSquared : 0,
      pValue: Number.isFinite(pValue) ? pValue : 1,
      slope: Number.isFinite(slope) ? slope : 0,
      intercept: Number.isFinite(intercept) ? intercept : meanY
    };
  }

  /**
   * Approximate p-value from t-distribution
   */
  _tDistributionPValue(t, df) {
    // Use approximation for large df
    if (df > 30) {
      const z = t;
      return 2 * (1 - this._normalCDF(Math.abs(z)));
    }

    // Simple approximation for smaller df
    const x = df / (df + t * t);
    const beta = this._incompleteBeta(df / 2, 0.5, x);
    return beta;
  }

  _normalCDF(z) {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = z < 0 ? -1 : 1;
    z = Math.abs(z) / Math.sqrt(2);
    const t = 1 / (1 + p * z);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
    return 0.5 * (1 + sign * y);
  }

  _incompleteBeta(a, b, x) {
    // Simple approximation
    if (x === 0) return 0;
    if (x === 1) return 1;
    return x; // Rough approximation
  }

  /**
   * Render the scatter plot
   */
  async _renderScatterPlot(data, correlation) {
    this._plotContainer.className = 'scatter-plot-container';
    this._plotContainer.innerHTML = '';

    const plotDiv = document.createElement('div');
    plotDiv.className = 'scatter-plot';
    this._plotContainer.appendChild(plotDiv);

    // Prepare traces
    const traces = [];

    // If coloring by category, create separate traces
    if (this.config.colorBy && data.color.length > 0) {
      const categories = [...new Set(data.color)];
      const colors = this._generateColors(categories.length);

      categories.forEach((cat, idx) => {
        const indices = data.color.map((c, i) => c === cat ? i : -1).filter(i => i >= 0);
        traces.push({
          type: getScatterTraceType(),
          mode: 'markers',
          name: cat,
          x: indices.map(i => data.x[i]),
          y: indices.map(i => data.y[i]),
          marker: {
            color: colors[idx],
            size: 5,
            opacity: 0.7
          },
          hovertemplate: `${this.config.xVariable.key}: %{x:.3f}<br>${this.config.yVariable.key}: %{y:.3f}<br>${this.config.colorBy.key}: ${cat}<extra></extra>`
        });
      });
    } else {
      // Single trace
      traces.push({
        type: getScatterTraceType(),
        mode: 'markers',
        name: 'Data',
        x: data.x,
        y: data.y,
        marker: {
          color: '#111827',
          size: 5,
          opacity: 0.6
        },
        hovertemplate: `${this.config.xVariable.key}: %{x:.3f}<br>${this.config.yVariable.key}: %{y:.3f}<extra></extra>`
      });
    }

    // Add trendline if enabled
    if (this.config.showTrendline && Number.isFinite(correlation.slope) && Number.isFinite(correlation.intercept)) {
      let xMin = Infinity;
      let xMax = -Infinity;
      for (let i = 0; i < data.x.length; i++) {
        const x = data.x[i];
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      }
      traces.push({
        type: getScatterTraceType(),
        mode: 'lines',
        name: 'Trendline',
        x: [xMin, xMax],
        y: [correlation.intercept + correlation.slope * xMin, correlation.intercept + correlation.slope * xMax],
        line: {
          color: '#dc2626',
          width: 2,
          dash: 'dash'
        },
        showlegend: true
      });
    }

    const layout = {
      xaxis: {
        title: this.config.xVariable.key,
        type: this.config.logScaleX ? 'log' : 'linear',
        gridcolor: '#e5e7eb',
        zerolinecolor: '#d1d5db'
      },
      yaxis: {
        title: this.config.yVariable.key,
        type: this.config.logScaleY ? 'log' : 'linear',
        gridcolor: '#e5e7eb',
        zerolinecolor: '#d1d5db'
      },
      font: { family: 'Inter, sans-serif', size: 11 },
      paper_bgcolor: 'white',
      plot_bgcolor: 'white',
      margin: { l: 60, r: 20, t: 30, b: 50 },
      showlegend: traces.length > 2,
      legend: {
        orientation: 'h',
        y: -0.2,
        font: { size: 9 }
      },
      annotations: this.config.showTrendline && !isNaN(correlation.r) ? [{
        x: 0.02,
        y: 0.98,
        xref: 'paper',
        yref: 'paper',
        text: `R = ${correlation.r.toFixed(3)}, R<sup>2</sup> = ${correlation.rSquared.toFixed(3)}`,
        showarrow: false,
        font: { size: 10, color: '#374151' },
        bgcolor: 'rgba(255,255,255,0.8)',
        borderpad: 4
      }] : []
    };

    const config = {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'],
      displaylogo: false
    };

    try {
      const Plotly = await createMinimalPlotly();
      await Plotly.newPlot(plotDiv, traces, layout, config);
    } catch (err) {
      plotDiv.innerHTML = `<p class="scatter-placeholder">Plot error: ${err.message}</p>`;
    }
  }

  /**
   * Generate distinct colors
   */
  _generateColors(n) {
    const palette = [
      '#111827', '#374151', '#6b7280', '#9ca3af', '#d1d5db',
      '#1ed8ff', '#dc2626', '#059669', '#7c3aed', '#ea580c'
    ];
    const colors = [];
    for (let i = 0; i < n; i++) {
      colors.push(palette[i % palette.length]);
    }
    return colors;
  }

  /**
   * Render statistics
   */
  _renderStats(correlation, n) {
    const significance = correlation.pValue < 0.001 ? 'p < 0.001' :
                         correlation.pValue < 0.01 ? 'p < 0.01' :
                         correlation.pValue < 0.05 ? 'p < 0.05' : 'not significant';

    const sigClass = correlation.pValue < 0.05 ? 'significant' : 'not-significant';

    this._statsContainer.innerHTML = `
      <div class="scatter-stat-row">
        <span class="stat-name">Pearson R:</span>
        <span class="stat-value">${isNaN(correlation.r) ? 'N/A' : correlation.r.toFixed(4)}</span>
      </div>
      <div class="scatter-stat-row">
        <span class="stat-name">R-squared:</span>
        <span class="stat-value">${isNaN(correlation.rSquared) ? 'N/A' : (correlation.rSquared * 100).toFixed(2)}%</span>
      </div>
      <div class="scatter-stat-row">
        <span class="stat-name">Significance:</span>
        <span class="stat-value ${sigClass}">${significance}</span>
      </div>
      <div class="scatter-stat-row">
        <span class="stat-name">N:</span>
        <span class="stat-value">${n.toLocaleString()} points</span>
      </div>
    `;
  }

  /**
   * Open expanded view in modal
   * Uses the same grid layout as Detailed Analysis (Options, Plot, Stats, Annotations)
   */
  async _openExpandedView() {
    if (!this._lastPlotData || !this._lastCorrelation) return;

    try {
      // Create modal with export handlers
      this._modal = createAnalysisModal({
        onClose: () => {
          if (this._modal) {
            closeModal(this._modal);
            this._modal = null;
          }
        },
        onExportPNG: () => this._exportPlot('png'),
        onExportSVG: () => this._exportPlot('svg'),
        onExportCSV: () => this._exportPlot('csv')
      });

      // Set modal title
      if (this._modal._title) {
        this._modal._title.textContent = `Correlation: ${this.config.xVariable?.key} vs ${this.config.yVariable?.key}`;
      }

      // Render options panel (matching Detailed Analysis pattern)
      if (this._modal._optionsContent) {
        this._renderModalOptions(this._modal._optionsContent);
      }

      openModal(this._modal);

      // Render plot in modal
      if (this._modal._plotContainer) {
        await this._renderExpandedPlot(this._modal._plotContainer);
      }

      // Render stats in modal footer (matching Detailed Analysis pattern)
      if (this._modal._footer) {
        this._renderExpandedStats(this._modal._footer);
      }

      // Render annotations (matching Detailed Analysis pattern)
      if (this._modal._annotationsContent) {
        this._renderModalAnnotations(this._modal._annotationsContent);
      }
    } catch (err) {
      console.error('[ScatterBuilder] Failed to open expanded view:', err);
      this._notifications?.error?.(`Failed to open expanded view: ${err.message || err}`, { category: 'analysis' });
    }
  }

  /**
   * Render options in modal - Configuration display
   * @param {HTMLElement} container - Options container
   */
  _renderModalOptions(container) {
    container.innerHTML = `
      <div class="modal-analysis-info correlation-modal-options">
        <h5>Analysis Settings</h5>
        <table class="analysis-params-table">
          <tr>
            <td>X Variable</td>
            <td><strong>${this.config.xVariable?.key || 'N/A'}</strong></td>
          </tr>
          <tr>
            <td>X Type</td>
            <td><strong>${this.config.xVariable?.type === 'gene_expression' ? 'Gene Expression' : 'Metadata'}</strong></td>
          </tr>
          <tr>
            <td>Y Variable</td>
            <td><strong>${this.config.yVariable?.key || 'N/A'}</strong></td>
          </tr>
          <tr>
            <td>Y Type</td>
            <td><strong>${this.config.yVariable?.type === 'gene_expression' ? 'Gene Expression' : 'Metadata'}</strong></td>
          </tr>
          <tr>
            <td>Trendline</td>
            <td><strong>${this.config.showTrendline ? 'Shown' : 'Hidden'}</strong></td>
          </tr>
          <tr>
            <td>X Scale</td>
            <td><strong>${this.config.logScaleX ? 'Logarithmic' : 'Linear'}</strong></td>
          </tr>
          <tr>
            <td>Y Scale</td>
            <td><strong>${this.config.logScaleY ? 'Logarithmic' : 'Linear'}</strong></td>
          </tr>
          ${this.config.colorBy ? `
          <tr>
            <td>Color By</td>
            <td><strong>${this.config.colorBy.key}</strong></td>
          </tr>
          ` : ''}
        </table>
      </div>
    `;
  }

  /**
   * Render annotations in modal - Interpretation help
   * @param {HTMLElement} container - Annotations container
   */
  _renderModalAnnotations(container) {
    const correlation = this._lastCorrelation;
    const r = correlation?.r || 0;
    const absR = Math.abs(r);

    // Interpretation of correlation strength
    let strengthLabel, strengthClass;
    if (absR >= 0.8) {
      strengthLabel = 'Very Strong';
      strengthClass = 'very-strong';
    } else if (absR >= 0.6) {
      strengthLabel = 'Strong';
      strengthClass = 'strong';
    } else if (absR >= 0.4) {
      strengthLabel = 'Moderate';
      strengthClass = 'moderate';
    } else if (absR >= 0.2) {
      strengthLabel = 'Weak';
      strengthClass = 'weak';
    } else {
      strengthLabel = 'Very Weak / None';
      strengthClass = 'none';
    }

    const direction = r > 0 ? 'Positive' : r < 0 ? 'Negative' : 'None';

    container.innerHTML = `
      <h5>Correlation Interpretation</h5>
      <table class="analysis-stats-table correlation-interpretation">
        <tr>
          <td>Direction</td>
          <td><strong class="${r > 0 ? 'up' : r < 0 ? 'down' : ''}">${direction}</strong></td>
        </tr>
        <tr>
          <td>Strength</td>
          <td><strong class="correlation-${strengthClass}">${strengthLabel}</strong></td>
        </tr>
        <tr>
          <td>Explained Variance</td>
          <td><strong>${(correlation.rSquared * 100).toFixed(1)}% of variance explained</strong></td>
        </tr>
      </table>
      <p class="interpretation-note">
        ${absR >= 0.4
          ? `The ${direction.toLowerCase()} correlation suggests that as ${this.config.xVariable?.key} increases, ${this.config.yVariable?.key} ${r > 0 ? 'tends to increase' : 'tends to decrease'}.`
          : `The correlation is weak, suggesting little linear relationship between ${this.config.xVariable?.key} and ${this.config.yVariable?.key}.`
        }
      </p>
    `;
  }

  /**
   * Render plot in expanded modal
   */
  async _renderExpandedPlot(container) {
    container.innerHTML = '';
    container.className = 'analysis-modal-plot';

    const plotDiv = document.createElement('div');
    plotDiv.className = 'scatter-plot-expanded';
    plotDiv.style.width = '100%';
    plotDiv.style.height = '100%';
    plotDiv.style.minHeight = '400px';
    container.appendChild(plotDiv);

    const data = this._lastPlotData;
    const correlation = this._lastCorrelation;

    // Prepare traces (same as inline but larger)
    const traces = [];

    if (this.config.colorBy && data.color.length > 0) {
      const categories = [...new Set(data.color)];
      const colors = this._generateColors(categories.length);

      categories.forEach((cat, idx) => {
        const indices = data.color.map((c, i) => c === cat ? i : -1).filter(i => i >= 0);
        traces.push({
          type: getScatterTraceType(),
          mode: 'markers',
          name: cat,
          x: indices.map(i => data.x[i]),
          y: indices.map(i => data.y[i]),
          marker: {
            color: colors[idx],
            size: 6,
            opacity: 0.7
          },
          hovertemplate: `${this.config.xVariable.key}: %{x:.3f}<br>${this.config.yVariable.key}: %{y:.3f}<br>${this.config.colorBy.key}: ${cat}<extra></extra>`
        });
      });
    } else {
      traces.push({
        type: getScatterTraceType(),
        mode: 'markers',
        name: 'Data',
        x: data.x,
        y: data.y,
        marker: {
          color: '#111827',
          size: 6,
          opacity: 0.6
        },
        hovertemplate: `${this.config.xVariable.key}: %{x:.3f}<br>${this.config.yVariable.key}: %{y:.3f}<extra></extra>`
      });
    }

    // Add trendline
    if (this.config.showTrendline && Number.isFinite(correlation.slope) && Number.isFinite(correlation.intercept)) {
      let xMin = Infinity;
      let xMax = -Infinity;
      for (let i = 0; i < data.x.length; i++) {
        const x = data.x[i];
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      }
      traces.push({
        type: getScatterTraceType(),
        mode: 'lines',
        name: 'Trendline',
        x: [xMin, xMax],
        y: [correlation.intercept + correlation.slope * xMin, correlation.intercept + correlation.slope * xMax],
        line: {
          color: '#dc2626',
          width: 2,
          dash: 'dash'
        },
        showlegend: true
      });
    }

    const layout = {
      xaxis: {
        title: { text: this.config.xVariable.key, font: { size: 12 } },
        type: this.config.logScaleX ? 'log' : 'linear',
        gridcolor: '#e5e7eb',
        zerolinecolor: '#d1d5db'
      },
      yaxis: {
        title: { text: this.config.yVariable.key, font: { size: 12 } },
        type: this.config.logScaleY ? 'log' : 'linear',
        gridcolor: '#e5e7eb',
        zerolinecolor: '#d1d5db'
      },
      font: { family: 'Inter, sans-serif', size: 11 },
      paper_bgcolor: 'white',
      plot_bgcolor: 'white',
      margin: { l: 60, r: 30, t: 40, b: 60 },
      showlegend: traces.length > 2,
      legend: {
        orientation: 'h',
        y: -0.15,
        font: { size: 10 }
      },
      annotations: this.config.showTrendline && !isNaN(correlation.r) ? [{
        x: 0.02,
        y: 0.98,
        xref: 'paper',
        yref: 'paper',
        text: `R = ${correlation.r.toFixed(4)}, R<sup>2</sup> = ${correlation.rSquared.toFixed(4)}, p = ${correlation.pValue < 0.001 ? '<0.001' : correlation.pValue.toFixed(4)}`,
        showarrow: false,
        font: { size: 11, color: '#374151' },
        bgcolor: 'rgba(255,255,255,0.9)',
        borderpad: 6
      }] : []
    };

    const config = {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ['lasso2d', 'select2d'],
      displaylogo: false
    };

    try {
      const Plotly = await createMinimalPlotly();
      await Plotly.newPlot(plotDiv, traces, layout, config);
    } catch (err) {
      plotDiv.innerHTML = `<p class="scatter-placeholder">Plot error: ${err.message}</p>`;
    }
  }

  /**
   * Render stats in expanded modal
   */
  _renderExpandedStats(container) {
    const correlation = this._lastCorrelation;
    const n = this._lastPlotData?.x?.length || 0;

    const significance = correlation.pValue < 0.001 ? 'p < 0.001 (highly significant)' :
                         correlation.pValue < 0.01 ? 'p < 0.01 (significant)' :
                         correlation.pValue < 0.05 ? 'p < 0.05 (significant)' : 'Not significant (p >= 0.05)';

    const sigClass = correlation.pValue < 0.05 ? 'significant' : 'not-significant';

    container.innerHTML = `
      <h4>Correlation Statistics</h4>
      <table class="analysis-stats-table">
        <tr>
          <td>X Variable</td>
          <td><strong>${this.config.xVariable?.key || 'N/A'}</strong></td>
        </tr>
        <tr>
          <td>Y Variable</td>
          <td><strong>${this.config.yVariable?.key || 'N/A'}</strong></td>
        </tr>
        <tr>
          <td>Pearson R</td>
          <td><strong>${isNaN(correlation.r) ? 'N/A' : correlation.r.toFixed(4)}</strong></td>
        </tr>
        <tr>
          <td>R-squared</td>
          <td><strong>${isNaN(correlation.rSquared) ? 'N/A' : (correlation.rSquared * 100).toFixed(2)}%</strong></td>
        </tr>
        <tr>
          <td>P-value</td>
          <td><strong>${isNaN(correlation.pValue) ? 'N/A' : (correlation.pValue < 0.001 ? '<0.001' : correlation.pValue.toFixed(4))}</strong></td>
        </tr>
        <tr>
          <td>Significance</td>
          <td class="${sigClass}"><strong>${significance}</strong></td>
        </tr>
        <tr>
          <td>Sample Size</td>
          <td><strong>${n.toLocaleString()} points</strong></td>
        </tr>
        <tr>
          <td>Slope</td>
          <td><strong>${isNaN(correlation.slope) ? 'N/A' : correlation.slope.toFixed(4)}</strong></td>
        </tr>
        <tr>
          <td>Intercept</td>
          <td><strong>${isNaN(correlation.intercept) ? 'N/A' : correlation.intercept.toFixed(4)}</strong></td>
        </tr>
      </table>
    `;
  }

  /**
   * Export the plot
   */
  async _exportPlot(format) {
    const plotEl = this._modal?._plotContainer?.querySelector('.scatter-plot-expanded');
    if (!plotEl) return;

    const filename = `correlation_${this.config.xVariable?.key}_vs_${this.config.yVariable?.key}`;

    try {
      if (format === 'png' || format === 'svg') {
        await downloadImage(plotEl, {
          format,
          width: 1400,
          height: 900,
          scale: 2,
          filename
        });
        this._notifications.success(`Plot exported as ${format.toUpperCase()}`, { category: 'download' });
      } else if (format === 'csv') {
        this._exportCSV(filename);
      }
    } catch (err) {
      this._notifications.error(`Export failed: ${err.message}`, { category: 'download' });
    }
  }

  /**
   * Export data as CSV
   */
  _exportCSV(filename) {
    if (!this._lastPlotData) return;

    const data = this._lastPlotData;
    const header = [
      toCSVCell(this.config.xVariable?.key || 'x'),
      toCSVCell(this.config.yVariable?.key || 'y')
    ];
    if (this.config.colorBy) header.push(toCSVCell(this.config.colorBy.key || 'color'));

    const rows = [header.join(',')];
    for (let i = 0; i < data.x.length; i++) {
      const row = [toCSVCell(data.x[i]), toCSVCell(data.y[i])];
      if (this.config.colorBy) row.push(toCSVCell(data.color[i]));
      rows.push(row.join(','));
    }

    downloadCSV(rows.join('\n'), filename, this._notifications);
  }

  /**
   * Update UI based on available data
   */
  _updateUI() {
    // Nothing specific needed for now
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
    if (this._plotContainer) {
      const plotEl = this._plotContainer.querySelector('.scatter-plot');
      purgePlot(plotEl);
    }
    this.container.innerHTML = '';
  }
}

/**
 * Create a scatter builder instance
 */
export function createScatterBuilder(options) {
  const builder = new ScatterBuilder(options);
  builder.init();
  return builder;
}

export default ScatterBuilder;
