/**
 * GitHubDataSource - Data source for datasets hosted in public GitHub repositories
 *
 * Allows users to load exported datasets from any public GitHub repository.
 * Uses GitHub's raw content URLs for direct file access with lazy loading.
 *
 * URL Format:
 * - Input: owner/repo/path/to/exports or owner/repo/branch/path
 * - Resolved: https://raw.githubusercontent.com/owner/repo/main/path/to/exports/
 *
 * Features:
 * - Lazy loading: Files fetched on-demand, identical to local-demo behavior
 * - Multi-dataset support: Reads datasets.json if present
 * - Legacy mode: Single dataset if datasets.json not found
 * - Branch selection: Default 'main', can specify 'master' or other branches
 */

import {
  DATA_CONFIG,
  DataSourceError,
  DataSourceErrorCode,
  loadDatasetMetadata,
  resolveUrl,
  validateSchemaVersion
} from './data-source.js';
import { getNotificationCenter } from '../app/notification-center.js';

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

/**
 * Parse a GitHub repository URL/path into components
 * @param {string} input - Input like "owner/repo/path" or "owner/repo/branch/path"
 * @returns {{owner: string, repo: string, branch: string, path: string}|null}
 */
export function parseGitHubPath(input) {
  if (!input || typeof input !== 'string') return null;

  // Clean up input
  let cleaned = input.trim();

  // Remove https://github.com/ prefix if present
  cleaned = cleaned.replace(/^https?:\/\/github\.com\//i, '');
  // Remove https://raw.githubusercontent.com/ prefix if present
  cleaned = cleaned.replace(/^https?:\/\/raw\.githubusercontent\.com\//i, '');
  // Remove leading/trailing slashes
  cleaned = cleaned.replace(/^\/+|\/+$/g, '');

  const parts = cleaned.split('/');
  if (parts.length < 2) {
    return null;
  }

  const owner = parts[0];
  const repo = parts[1];

  // Common branch names
  const commonBranches = ['main', 'master', 'develop', 'dev', 'gh-pages'];

  // Check if third part looks like a branch name
  let branch = 'main';
  let pathStart = 2;

  if (parts.length > 2) {
    // If third part is a common branch name, use it
    if (commonBranches.includes(parts[2])) {
      branch = parts[2];
      pathStart = 3;
    }
    // Otherwise, keep default 'main' and treat rest as path
  }

  const path = parts.slice(pathStart).join('/');

  return { owner, repo, branch, path };
}

/**
 * Build raw GitHub content URL from components
 * @param {{owner: string, repo: string, branch: string, path: string}} parsed
 * @returns {string}
 */
function buildRawUrl(parsed) {
  const { owner, repo, branch, path } = parsed;
  let url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;
  if (path) {
    url += `/${path}`;
  }
  if (!url.endsWith('/')) {
    url += '/';
  }
  return url;
}

/**
 * Check if a URL is a github-repo:// protocol URL
 * @param {string} url
 * @returns {boolean}
 */
export function isGitHubRepoUrl(url) {
  return url?.startsWith('github-repo://');
}

/**
 * Parse a github-repo:// URL
 * @param {string} url
 * @returns {{datasetId: string, path: string}|null}
 */
export function parseGitHubRepoUrl(url) {
  if (!isGitHubRepoUrl(url)) return null;

  const withoutProtocol = url.substring('github-repo://'.length);
  const slashIdx = withoutProtocol.indexOf('/');

  if (slashIdx === -1) {
    return { datasetId: withoutProtocol, path: '' };
  }

  return {
    datasetId: withoutProtocol.substring(0, slashIdx),
    path: withoutProtocol.substring(slashIdx + 1)
  };
}

/**
 * Fetch JSON from URL with error handling
 * @param {string} url
 * @returns {Promise<Object>}
 */
async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Check if a URL exists (returns 2xx status)
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function urlExists(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Data source for datasets hosted in GitHub repositories
 */
export class GitHubDataSource {
  constructor() {
    /** @type {string|null} Raw GitHub base URL */
    this._baseUrl = null;

    /** @type {string|null} Original user input */
    this._inputPath = null;

    /** @type {{owner: string, repo: string, branch: string, path: string}|null} */
    this._parsedPath = null;

    /** @type {Object|null} Datasets manifest */
    this._manifest = null;

    /** @type {DatasetMetadata[]|null} */
    this._datasets = null;

    /** @type {boolean|null} */
    this._isLegacyMode = null;

    /** @type {string|null} Active dataset ID */
    this._activeDatasetId = null;

    /** @type {boolean} */
    this._connected = false;

    this.type = 'github-repo';
  }

  /**
   * Get the type identifier
   * @returns {string}
   */
  getType() {
    return this.type;
  }

  /**
   * Check if connected to a repository
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return this._connected && this._baseUrl !== null;
  }

  /**
   * Connect to a GitHub repository
   * @param {string} inputPath - Repository path like "owner/repo/path" or full URL
   * @returns {Promise<{repoInfo: Object, datasets: DatasetMetadata[]}>}
   */
  async connect(inputPath) {
    const notifications = getNotificationCenter();
    const trackerId = notifications.loading('Connecting to GitHub repository...', { category: 'data' });

    try {
      this._inputPath = inputPath;
      this._parsedPath = parseGitHubPath(inputPath);

      if (!this._parsedPath) {
        throw new DataSourceError(
          'Invalid GitHub path. Use format: owner/repo/path or owner/repo/branch/path',
          DataSourceErrorCode.INVALID_FORMAT,
          this.type,
          { input: inputPath }
        );
      }

      this._baseUrl = buildRawUrl(this._parsedPath);
      console.log(`[GitHubDataSource] Connecting to: ${this._baseUrl}`);

      // Try to load datasets manifest
      const manifestUrl = resolveUrl(this._baseUrl, DATA_CONFIG.DATASETS_MANIFEST);

      try {
        this._manifest = await fetchJson(manifestUrl);
        validateSchemaVersion(
          this._manifest.version,
          DATA_CONFIG.SUPPORTED_MANIFEST_VERSIONS,
          'datasets.json'
        );
        this._isLegacyMode = false;
        console.log(`[GitHubDataSource] Found datasets manifest with ${this._manifest.datasets?.length || 0} datasets`);
      } catch (err) {
        // Try legacy mode
        const legacyManifestUrl = resolveUrl(this._baseUrl, 'obs_manifest.json');
        if (await urlExists(legacyManifestUrl)) {
          console.log('[GitHubDataSource] Using legacy single-dataset mode');
          this._isLegacyMode = true;
          this._manifest = null;
        } else {
          // Try alternate branches
          const alternativeBranches = ['master', 'main'];
          let found = false;

          for (const branch of alternativeBranches) {
            if (branch === this._parsedPath.branch) continue;

            const altParsed = { ...this._parsedPath, branch };
            const altBaseUrl = buildRawUrl(altParsed);
            const altManifestUrl = resolveUrl(altBaseUrl, 'obs_manifest.json');

            if (await urlExists(altManifestUrl)) {
              console.log(`[GitHubDataSource] Found data on branch '${branch}'`);
              this._parsedPath = altParsed;
              this._baseUrl = altBaseUrl;
              this._isLegacyMode = true;
              this._manifest = null;
              found = true;
              break;
            }
          }

          if (!found) {
            throw new DataSourceError(
              'No Cellucid dataset found at this GitHub path. Ensure the repository contains exported data (obs_manifest.json).',
              DataSourceErrorCode.NOT_FOUND,
              this.type,
              { url: this._baseUrl }
            );
          }
        }
      }

      // Load datasets
      this._datasets = await this._loadDatasets();
      this._connected = true;

      const repoInfo = {
        owner: this._parsedPath.owner,
        repo: this._parsedPath.repo,
        branch: this._parsedPath.branch,
        path: this._parsedPath.path,
        baseUrl: this._baseUrl,
        isLegacyMode: this._isLegacyMode,
      };

      notifications.complete(trackerId, `Connected to ${this._parsedPath.owner}/${this._parsedPath.repo}`);
      console.log('[GitHubDataSource] Connected:', repoInfo);

      return { repoInfo, datasets: this._datasets };
    } catch (err) {
      this._cleanup();
      notifications.fail(trackerId, err.message || 'Failed to connect');

      if (err instanceof DataSourceError) {
        throw err;
      }

      throw new DataSourceError(
        `Failed to connect to GitHub: ${err.message}`,
        DataSourceErrorCode.NETWORK_ERROR,
        this.type,
        { input: inputPath, originalError: err.message }
      );
    }
  }

  /**
   * Load datasets from manifest or legacy mode
   * @returns {Promise<DatasetMetadata[]>}
   * @private
   */
  async _loadDatasets() {
    if (this._isLegacyMode) {
      // Legacy mode: single dataset at baseUrl
      const metadata = await loadDatasetMetadata(this._baseUrl, DATA_CONFIG.LEGACY_DATASET_ID, this.type);
      if (metadata.name === DATA_CONFIG.LEGACY_DATASET_ID) {
        metadata.name = `${this._parsedPath.owner}/${this._parsedPath.repo}`;
      }
      return [metadata];
    }

    // Multi-dataset mode
    const datasets = [];
    for (const entry of (this._manifest?.datasets || [])) {
      try {
        const datasetBaseUrl = resolveUrl(this._baseUrl, entry.path);
        const metadata = await loadDatasetMetadata(datasetBaseUrl, entry.id, this.type);

        if (entry.name) {
          metadata.name = entry.name;
        }
        if (entry.description) {
          metadata.description = entry.description;
        }

        datasets.push(metadata);
      } catch (err) {
        console.warn(`[GitHubDataSource] Failed to load dataset '${entry.id}':`, err);
      }
    }

    return datasets;
  }

  /**
   * Disconnect from the repository
   */
  disconnect() {
    this._cleanup();
    console.log('[GitHubDataSource] Disconnected');
  }

  /**
   * Cleanup internal state
   * @private
   */
  _cleanup() {
    this._baseUrl = null;
    this._inputPath = null;
    this._parsedPath = null;
    this._manifest = null;
    this._datasets = null;
    this._isLegacyMode = null;
    this._activeDatasetId = null;
    this._connected = false;
  }

  /**
   * List all available datasets
   * @returns {Promise<DatasetMetadata[]>}
   */
  async listDatasets() {
    if (!this._connected) {
      return [];
    }
    return this._datasets || [];
  }

  /**
   * Check if a dataset exists
   * @param {string} datasetId
   * @returns {Promise<boolean>}
   */
  async hasDataset(datasetId) {
    if (!this._connected || !this._datasets) {
      return false;
    }
    return this._datasets.some(d => d.id === datasetId);
  }

  /**
   * Get metadata for a specific dataset
   * @param {string} datasetId
   * @returns {Promise<DatasetMetadata>}
   */
  async getMetadata(datasetId) {
    if (!this._connected) {
      throw new DataSourceError(
        'Not connected to GitHub repository',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }

    const dataset = this._datasets?.find(d => d.id === datasetId);
    if (!dataset) {
      throw new DataSourceError(
        `Dataset '${datasetId}' not found`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { datasetId }
      );
    }

    return dataset;
  }

  /**
   * Get the base URL for loading a dataset's files
   * Files are loaded directly from GitHub raw URLs - no github-repo:// protocol needed
   * @param {string} datasetId
   * @returns {string}
   */
  getBaseUrl(datasetId) {
    if (!this._connected || !this._baseUrl) {
      throw new DataSourceError(
        'Not connected to GitHub repository',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }

    this._activeDatasetId = datasetId;

    // For legacy mode, use base URL directly
    if (this._isLegacyMode) {
      return this._baseUrl;
    }

    // For multi-dataset, find the dataset's path
    const entry = this._manifest?.datasets?.find(d => d.id === datasetId);
    if (entry?.path) {
      return resolveUrl(this._baseUrl, entry.path);
    }

    return this._baseUrl;
  }

  /**
   * Get connection info
   * @returns {Object}
   */
  getConnectionInfo() {
    return {
      connected: this._connected,
      inputPath: this._inputPath,
      parsedPath: this._parsedPath,
      baseUrl: this._baseUrl,
      isLegacyMode: this._isLegacyMode,
      datasetsCount: this._datasets?.length || 0,
    };
  }

  /**
   * Called when source is deactivated
   */
  onDeactivate() {
    // Keep connection alive - user might switch back
    console.log('[GitHubDataSource] Deactivated (connection kept alive)');
  }

  /**
   * Refresh cached data
   */
  async refresh() {
    if (!this._connected || !this._inputPath) {
      return;
    }

    // Re-load datasets
    this._datasets = null;
    this._datasets = await this._loadDatasets();
  }

  /**
   * Clear cached data to free memory
   * Keeps connection alive but clears loaded dataset information
   */
  clearCaches() {
    this._manifest = null;
    this._datasets = null;
    console.log('[GitHubDataSource] Cleared caches to free memory');
  }

  /**
   * Whether manual reconnection is required
   * @returns {boolean}
   */
  requiresManualReconnect() {
    return !this._connected;
  }
}

/**
 * Create a GitHubDataSource instance
 * @returns {GitHubDataSource}
 */
export function createGitHubDataSource() {
  return new GitHubDataSource();
}
