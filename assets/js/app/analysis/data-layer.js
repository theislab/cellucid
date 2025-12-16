/**
 * Data Abstraction Layer for Page Analysis
 *
 * Provides a unified interface for accessing any variable from pages:
 * - Categorical obs fields (cell type, cluster, patient ID, etc.)
 * - Continuous obs fields (pseudotime, QC metrics, age)
 * - Gene expression values
 */

/**
 * @typedef {'categorical_obs' | 'continuous_obs' | 'gene_expression'} DataType
 */

/**
 * @typedef {Object} VariableInfo
 * @property {string} key - Variable identifier
 * @property {string} name - Display name
 * @property {'category' | 'continuous'} kind - Data kind
 * @property {string[]} [categories] - Category names for categorical variables
 * @property {number} [min] - Minimum value for continuous variables
 * @property {number} [max] - Maximum value for continuous variables
 * @property {number} [mean] - Mean value for continuous variables
 * @property {boolean} loaded - Whether data is fully loaded
 */

/**
 * @typedef {Object} PageData
 * @property {string} pageId - Page identifier
 * @property {string} pageName - Human-readable page name
 * @property {VariableInfo} variableInfo - Information about the variable
 * @property {(string|number)[]} values - Decoded values for each cell
 * @property {number[]} cellIndices - Original cell indices in the dataset
 * @property {number} cellCount - Total number of cells in this page data
 */

/**
 * @typedef {Object} FetchOptions
 * @property {DataType} type - Type of data to fetch
 * @property {string} variableKey - Variable key/name to fetch
 * @property {string[]} pageIds - Array of page IDs to include
 */

export class DataLayer {
  /**
   * @param {Object} state - Reference to DataState instance
   */
  constructor(state) {
    this.state = state;
    this._variableCache = new Map();
  }

  /**
   * Get list of available variables by type
   * @param {DataType} type - Type of variables to list
   * @returns {VariableInfo[]}
   */
  getAvailableVariables(type) {
    switch (type) {
      case 'categorical_obs':
        return this._getCategoricalObsVariables();
      case 'continuous_obs':
        return this._getContinuousObsVariables();
      case 'gene_expression':
        return this._getGeneExpressionVariables();
      default:
        console.warn(`[DataLayer] Unknown variable type: ${type}`);
        return [];
    }
  }

  /**
   * Get categorical obs variables
   * @returns {VariableInfo[]}
   * @private
   */
  _getCategoricalObsVariables() {
    const obsData = this.state.obsData;
    if (!obsData || !obsData.fields) return [];

    const results = [];
    // Iterate with original index to preserve correct field reference
    for (let i = 0; i < obsData.fields.length; i++) {
      const field = obsData.fields[i];
      if (field.kind === 'category') {
        results.push({
          key: field.key,
          name: field.key,
          kind: 'category',
          categories: field.categories || [],
          categoryCount: (field.categories || []).length,
          loaded: field.loaded || false,
          _fieldIndex: i  // Use original index, not filtered index
        });
      }
    }
    return results;
  }

  /**
   * Get continuous obs variables
   * @returns {VariableInfo[]}
   * @private
   */
  _getContinuousObsVariables() {
    const obsData = this.state.obsData;
    if (!obsData || !obsData.fields) return [];

    const results = [];
    // Iterate with original index to preserve correct field reference
    for (let i = 0; i < obsData.fields.length; i++) {
      const field = obsData.fields[i];
      if (field.kind === 'continuous') {
        const stats = field._continuousStats || {};
        results.push({
          key: field.key,
          name: field.key,
          kind: 'continuous',
          min: stats.min ?? null,
          max: stats.max ?? null,
          mean: stats.mean ?? null,
          loaded: field.loaded || false,
          _fieldIndex: i  // Use original index, not filtered index
        });
      }
    }
    return results;
  }

  /**
   * Get gene expression variables
   * @returns {VariableInfo[]}
   * @private
   */
  _getGeneExpressionVariables() {
    const varData = this.state.varData;
    if (!varData || !varData.fields) return [];

    return varData.fields.map((field, index) => {
      const stats = field._continuousStats || {};
      return {
        key: field.key,
        name: field.key,
        kind: 'continuous',
        min: stats.min ?? 0,
        max: stats.max ?? null,
        mean: stats.mean ?? null,
        loaded: field.loaded || false,
        _fieldIndex: index,
        _isGene: true
      };
    });
  }

  /**
   * Get variable info for a specific variable
   * @param {DataType} type - Type of data
   * @param {string} key - Variable key
   * @returns {VariableInfo|null}
   */
  getVariableInfo(type, key) {
    const variables = this.getAvailableVariables(type);
    return variables.find(v => v.key === key) || null;
  }

  /**
   * Get all highlight pages
   * @returns {Object[]}
   */
  getPages() {
    return this.state.getHighlightPages() || [];
  }

  /**
   * Get cell indices for a specific page
   * @param {string} pageId - Page identifier
   * @returns {number[]} Array of cell indices
   */
  getCellIndicesForPage(pageId) {
    const pages = this.state.getHighlightPages() || [];
    const page = pages.find(p => p.id === pageId);

    if (!page) {
      console.warn(`[DataLayer] Page not found: ${pageId}`);
      return [];
    }

    // Collect all cell indices from enabled highlight groups
    const cellIndices = new Set();
    for (const group of (page.highlightedGroups || [])) {
      if (group.enabled === false) continue;
      if (group.cellIndices) {
        for (const idx of group.cellIndices) {
          cellIndices.add(idx);
        }
      }
    }

    return Array.from(cellIndices).sort((a, b) => a - b);
  }

  /**
   * Ensure a field is loaded
   * @param {Object} field - Field object
   * @param {number} fieldIndex - Index of the field
   * @param {string} source - 'obs' or 'var'
   * @returns {Promise<void>}
   * @private
   */
  async _ensureFieldLoaded(field, fieldIndex, source) {
    if (field.loaded) return;

    // If there's a loading promise in progress, wait for it
    if (field._loadingPromise) {
      await field._loadingPromise;
      return;
    }

    // Use state's loading mechanism - state methods take fieldIndex
    try {
      if (source === 'obs' && this.state.ensureFieldLoaded) {
        await this.state.ensureFieldLoaded(fieldIndex);
      } else if (source === 'var' && this.state.ensureVarFieldLoaded) {
        await this.state.ensureVarFieldLoaded(fieldIndex);
      }
    } catch (err) {
      console.warn(`[DataLayer] Failed to load field at index ${fieldIndex}:`, err);
    }
  }

  /**
   * Fetch data for a specific variable and page(s)
   * @param {FetchOptions} options - Fetch options
   * @returns {Promise<PageData[]>}
   */
  async getDataForPages(options) {
    const { type, variableKey, pageIds } = options;

    if (!pageIds || pageIds.length === 0) {
      return [];
    }

    // Get the variable info and field
    const variableInfo = this.getVariableInfo(type, variableKey);
    if (!variableInfo) {
      console.warn(`[DataLayer] Variable not found: ${variableKey} (type: ${type})`);
      return [];
    }

    // Get the source and field
    const source = type === 'gene_expression' ? 'var' : 'obs';
    const fields = source === 'var'
      ? this.state.varData?.fields
      : this.state.obsData?.fields;

    if (!fields) {
      console.warn(`[DataLayer] No ${source} fields available`);
      return [];
    }

    const fieldIndex = variableInfo._fieldIndex;
    const field = fields[fieldIndex];

    if (!field) {
      console.warn(`[DataLayer] Field not found at index ${fieldIndex}`);
      return [];
    }

    // Ensure field is loaded
    await this._ensureFieldLoaded(field, fieldIndex, source);

    // Get values array
    const rawValues = field.kind === 'category'
      ? field.codes
      : field.values;

    if (!rawValues || rawValues.length === 0) {
      console.warn(`[DataLayer] No values for field: ${variableKey}`);
      return [];
    }

    // Categories for decoding (if categorical)
    const categories = field.categories || [];

    // Process each page
    const results = [];
    const allPages = this.getPages();

    for (const pageId of pageIds) {
      const page = allPages.find(p => p.id === pageId);
      if (!page) {
        console.warn(`[DataLayer] Page not found: ${pageId}`);
        continue;
      }

      const cellIndices = this.getCellIndicesForPage(pageId);

      if (cellIndices.length === 0) {
        // Include empty page data
        results.push({
          pageId,
          pageName: page.name,
          variableInfo: { ...variableInfo },
          values: [],
          cellIndices: [],
          cellCount: 0
        });
        continue;
      }

      // Extract values for cells in this page
      const values = [];
      const validIndices = [];

      for (const idx of cellIndices) {
        if (idx >= 0 && idx < rawValues.length) {
          let value = rawValues[idx];

          // Handle missing values
          if (value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))) {
            continue; // Skip missing values
          }

          // Decode categorical values
          if (field.kind === 'category') {
            value = categories[value] ?? `Unknown (${value})`;
          }

          values.push(value);
          validIndices.push(idx);
        }
      }

      results.push({
        pageId,
        pageName: page.name,
        variableInfo: {
          ...variableInfo,
          // Update stats based on actual data if needed
          categories: field.kind === 'category' ? categories : undefined
        },
        values,
        cellIndices: validIndices,
        cellCount: values.length
      });
    }

    return results;
  }

  /**
   * Batch fetch multiple variables
   * @param {FetchOptions[]} requests - Array of fetch requests
   * @returns {Promise<Map<string, PageData[]>>}
   */
  async batchFetch(requests) {
    const results = new Map();

    // Process in parallel
    await Promise.all(
      requests.map(async (request) => {
        const key = `${request.type}:${request.variableKey}`;
        const data = await this.getDataForPages(request);
        results.set(key, data);
      })
    );

    return results;
  }

  /**
   * Get aggregated statistics for a variable across pages
   * @param {DataType} type - Data type
   * @param {string} variableKey - Variable key
   * @param {string[]} pageIds - Page IDs
   * @returns {Promise<Object>}
   */
  async getAggregatedStats(type, variableKey, pageIds) {
    const pageData = await this.getDataForPages({ type, variableKey, pageIds });

    const variableInfo = this.getVariableInfo(type, variableKey);
    if (!variableInfo) return null;

    if (variableInfo.kind === 'category') {
      // Aggregate category counts
      const categoryCounts = new Map();
      let totalCount = 0;

      for (const pd of pageData) {
        for (const value of pd.values) {
          categoryCounts.set(value, (categoryCounts.get(value) || 0) + 1);
          totalCount++;
        }
      }

      return {
        kind: 'category',
        variableKey,
        categoryCounts: Object.fromEntries(categoryCounts),
        categories: Array.from(categoryCounts.keys()),
        totalCount
      };
    } else {
      // Aggregate continuous statistics
      const allValues = pageData.flatMap(pd => pd.values);
      const validValues = allValues.filter(v => typeof v === 'number' && !Number.isNaN(v));

      if (validValues.length === 0) {
        return {
          kind: 'continuous',
          variableKey,
          count: 0,
          min: null,
          max: null,
          mean: null,
          median: null
        };
      }

      validValues.sort((a, b) => a - b);
      const sum = validValues.reduce((acc, v) => acc + v, 0);
      const mid = Math.floor(validValues.length / 2);
      const median = validValues.length % 2 === 0
        ? (validValues[mid - 1] + validValues[mid]) / 2
        : validValues[mid];

      return {
        kind: 'continuous',
        variableKey,
        count: validValues.length,
        min: validValues[0],
        max: validValues[validValues.length - 1],
        mean: sum / validValues.length,
        median
      };
    }
  }

  /**
   * Get category counts per page for comparison
   * @param {string} variableKey - Categorical variable key
   * @param {string[]} pageIds - Page IDs to compare
   * @returns {Promise<Object>}
   */
  async getCategoryCountsByPage(variableKey, pageIds) {
    const pageData = await this.getDataForPages({
      type: 'categorical_obs',
      variableKey,
      pageIds
    });

    // Get all unique categories
    const allCategories = new Set();
    for (const pd of pageData) {
      for (const value of pd.values) {
        allCategories.add(value);
      }
    }

    // Count per page per category
    const result = {
      categories: Array.from(allCategories),
      pages: {}
    };

    for (const pd of pageData) {
      const counts = {};
      for (const cat of allCategories) {
        counts[cat] = 0;
      }
      for (const value of pd.values) {
        counts[value] = (counts[value] || 0) + 1;
      }
      result.pages[pd.pageId] = {
        name: pd.pageName,
        counts,
        total: pd.cellCount
      };
    }

    return result;
  }

  /**
   * Clear internal caches
   */
  clearCache() {
    this._variableCache.clear();
  }
}

/**
 * Create a new DataLayer instance
 * @param {Object} state - DataState instance
 * @returns {DataLayer}
 */
export function createDataLayer(state) {
  return new DataLayer(state);
}
