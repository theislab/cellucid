/**
 * Dimension Manager - Handles multi-dimensional embeddings for cellucid viewer
 *
 * Supports 1D, 2D, 3D, and 4D embeddings with:
 * - Lazy loading of dimension-specific position data
 * - Automatic padding of 1D/2D data to work in 3D viewer
 * - Per-view dimension state tracking
 * - Efficient index-based operations (no data duplication)
 */

import { loadPointsBinary } from './data-loaders.js';

// Dimension priority for default selection: 3D > 2D > 1D > 4D
const DIMENSION_PRIORITY = [3, 2, 1, 4];

/**
 * Create a dimension manager instance
 * @param {Object} options - Configuration options
 * @param {string} options.baseUrl - Base URL for loading dimension files
 * @param {Object} options.embeddingsMetadata - Embeddings metadata from dataset_identity.json
 * @returns {DimensionManager}
 */
export function createDimensionManager(options = {}) {
  return new DimensionManager(options);
}

class DimensionManager {
  constructor({ baseUrl = '', embeddingsMetadata = null } = {}) {
    this.baseUrl = baseUrl;

    // Available dimensions from metadata
    this.availableDimensions = [];
    this.defaultDimension = 3;
    this.dimensionFiles = {};

    // Loaded position data cache: dimension -> Float32Array
    this.positionCache = new Map();

    // Loading promises to prevent duplicate fetches
    this.loadingPromises = new Map();

    // Per-view dimension state: viewId -> dimension
    this.viewDimensions = new Map();

    // Normalized/padded positions for 3D rendering: dimension -> Float32Array (n_cells * 3)
    this.paddedPositionCache = new Map();

    // Number of cells (consistent across all dimensions)
    this.nCells = 0;

    // Parse metadata if provided
    if (embeddingsMetadata) {
      this.initFromMetadata(embeddingsMetadata);
    }
  }

  /**
   * Initialize from dataset_identity.json embeddings metadata
   * @param {Object} meta - Embeddings metadata object
   */
  initFromMetadata(meta) {
    if (!meta) return;

    this.availableDimensions = meta.available_dimensions || [3];
    this.defaultDimension = meta.default_dimension || this._selectDefaultDimension();
    this.dimensionFiles = meta.files || {};

    console.log(`[DimensionManager] Available dimensions: ${this.availableDimensions.join(', ')}D`);
    console.log(`[DimensionManager] Default dimension: ${this.defaultDimension}D`);
  }

  /**
   * Select default dimension based on priority
   * @returns {number} Default dimension (1, 2, 3, or 4)
   */
  _selectDefaultDimension() {
    for (const dim of DIMENSION_PRIORITY) {
      if (this.availableDimensions.includes(dim)) {
        return dim;
      }
    }
    return this.availableDimensions[0] || 3;
  }

  /**
   * Set the base URL for loading files
   * @param {string} url - Base URL (should end with /)
   */
  setBaseUrl(url) {
    this.baseUrl = url.endsWith('/') ? url : `${url}/`;
  }

  /**
   * Check if a dimension is available
   * @param {number} dim - Dimension (1, 2, 3, or 4)
   * @returns {boolean}
   */
  hasDimension(dim) {
    return this.availableDimensions.includes(dim);
  }

  /**
   * Get the list of available dimensions
   * @returns {number[]} Array of available dimensions
   */
  getAvailableDimensions() {
    return [...this.availableDimensions];
  }

  /**
   * Get the default dimension
   * @returns {number}
   */
  getDefaultDimension() {
    return this.defaultDimension;
  }

  /**
   * Load raw position data for a dimension (lazy load)
   * @param {number} dim - Dimension to load
   * @returns {Promise<Float32Array>} Raw position data
   */
  async loadDimension(dim) {
    // Check if dimension is available
    if (!this.hasDimension(dim)) {
      throw new Error(`Dimension ${dim}D is not available. Available: ${this.availableDimensions.join(', ')}D`);
    }

    // Return cached data if available
    if (this.positionCache.has(dim)) {
      return this.positionCache.get(dim);
    }

    // Return existing loading promise if in progress
    if (this.loadingPromises.has(dim)) {
      return this.loadingPromises.get(dim);
    }

    // Start loading
    const filename = this.dimensionFiles[`${dim}d`] || `points_${dim}d.bin`;
    const url = `${this.baseUrl}${filename}`;

    console.log(`[DimensionManager] Loading ${dim}D positions from ${url}`);

    const promise = loadPointsBinary(url)
      .then(positions => {
        // Validate and cache
        const nCells = positions.length / dim;
        if (this.nCells === 0) {
          this.nCells = nCells;
        } else if (nCells !== this.nCells) {
          throw new Error(
            `Dimension ${dim}D has ${nCells} cells, but expected ${this.nCells} cells.`
          );
        }

        this.positionCache.set(dim, positions);
        this.loadingPromises.delete(dim);
        console.log(`[DimensionManager] Loaded ${dim}D: ${nCells.toLocaleString()} cells`);
        return positions;
      })
      .catch(err => {
        this.loadingPromises.delete(dim);
        console.error(`[DimensionManager] Failed to load ${dim}D:`, err);
        throw err;
      });

    this.loadingPromises.set(dim, promise);
    return promise;
  }

  /**
   * Get 3D-padded positions for a dimension (for rendering in 3D viewer)
   * This pads 1D and 2D data with zeros to create valid 3D coordinates.
   *
   * @param {number} dim - Dimension (1, 2, or 3)
   * @returns {Promise<Float32Array>} 3D positions (n_cells * 3)
   */
  async getPositions3D(dim) {
    // Handle 4D - raise error as it's not yet implemented
    if (dim === 4) {
      throw new Error(
        '4D visualization is not yet implemented. ' +
        'The infrastructure is in place, but rendering 4D data requires additional work.'
      );
    }

    // Check cache first
    if (this.paddedPositionCache.has(dim)) {
      return this.paddedPositionCache.get(dim);
    }

    // Load raw positions
    const rawPositions = await this.loadDimension(dim);
    const nCells = rawPositions.length / dim;

    // For 3D, return as-is
    if (dim === 3) {
      this.paddedPositionCache.set(dim, rawPositions);
      return rawPositions;
    }

    // For 1D and 2D, pad with zeros
    const positions3D = new Float32Array(nCells * 3);

    if (dim === 1) {
      // 1D: X values only, Y and Z are zero
      for (let i = 0; i < nCells; i++) {
        positions3D[i * 3] = rawPositions[i];     // X
        positions3D[i * 3 + 1] = 0;                // Y = 0
        positions3D[i * 3 + 2] = 0;                // Z = 0
      }
    } else if (dim === 2) {
      // 2D: X and Y values, Z is zero
      for (let i = 0; i < nCells; i++) {
        positions3D[i * 3] = rawPositions[i * 2];     // X
        positions3D[i * 3 + 1] = rawPositions[i * 2 + 1]; // Y
        positions3D[i * 3 + 2] = 0;                    // Z = 0
      }
    }

    this.paddedPositionCache.set(dim, positions3D);
    console.log(`[DimensionManager] Created 3D-padded positions for ${dim}D`);
    return positions3D;
  }

  /**
   * Get dimension for a specific view
   * @param {string} viewId - View identifier
   * @returns {number} Dimension for this view
   */
  getViewDimension(viewId) {
    return this.viewDimensions.get(viewId) || this.defaultDimension;
  }

  /**
   * Set dimension for a specific view
   * @param {string} viewId - View identifier
   * @param {number} dim - Dimension to set
   */
  setViewDimension(viewId, dim) {
    if (!this.hasDimension(dim)) {
      console.warn(`[DimensionManager] Dimension ${dim}D not available, using default`);
      dim = this.defaultDimension;
    }
    this.viewDimensions.set(viewId, dim);
  }

  /**
   * Copy dimension from one view to another (for "Keep View" feature)
   * @param {string} sourceViewId - Source view ID
   * @param {string} targetViewId - Target view ID
   */
  copyViewDimension(sourceViewId, targetViewId) {
    const dim = this.getViewDimension(sourceViewId);
    this.setViewDimension(targetViewId, dim);
  }

  /**
   * Remove dimension state for a view
   * @param {string} viewId - View identifier
   */
  removeView(viewId) {
    this.viewDimensions.delete(viewId);
  }

  /**
   * Clear all view dimension states
   */
  clearViewDimensions() {
    this.viewDimensions.clear();
  }

  /**
   * Get number of cells
   * @returns {number}
   */
  getCellCount() {
    return this.nCells;
  }

  /**
   * Check if positions are loaded for a dimension
   * @param {number} dim - Dimension
   * @returns {boolean}
   */
  isLoaded(dim) {
    return this.positionCache.has(dim);
  }

  /**
   * Check if any dimension is currently loading
   * @returns {boolean}
   */
  isLoading() {
    return this.loadingPromises.size > 0;
  }

  /**
   * Preload all available dimensions
   * @returns {Promise<void>}
   */
  async preloadAll() {
    const promises = this.availableDimensions
      .filter(dim => dim !== 4) // Skip 4D as it's not implemented
      .map(dim => this.loadDimension(dim).catch(e => {
        console.warn(`[DimensionManager] Failed to preload ${dim}D:`, e);
      }));
    await Promise.all(promises);
  }

  /**
   * Clear all cached data
   */
  clearCache() {
    this.positionCache.clear();
    this.paddedPositionCache.clear();
    this.loadingPromises.clear();
    this.nCells = 0;
  }

  /**
   * Get dimension info for UI display
   * @returns {Object[]} Array of {dim, label, available, loaded}
   */
  getDimensionInfo() {
    return [1, 2, 3, 4].map(dim => ({
      dim,
      label: `${dim}D`,
      available: this.hasDimension(dim),
      loaded: this.isLoaded(dim),
      isDefault: dim === this.defaultDimension,
      notImplemented: dim === 4
    }));
  }
}

export { DimensionManager };
