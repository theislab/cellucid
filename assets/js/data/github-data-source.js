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
 * - Multi-dataset support: Reads datasets.json
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
 * @returns {{owner: string, repo: string, branch: string|null, pathSegments: string[], path: string, branchExplicit: boolean}|null}
 */
export function parseGitHubPath(input) {
  if (!input || typeof input !== 'string') return null;

  let cleaned = input.trim();
  let host = null;
  let path = cleaned;

  // Accept full URLs (github.com + raw.githubusercontent.com).
  try {
    const url = new URL(cleaned);
    host = (url.hostname || '').toLowerCase();
    path = url.pathname || '';
  } catch {
    // Not a URL; accept github.com/... and raw.githubusercontent.com/... without protocol.
    cleaned = cleaned.replace(/^https?:\/\//i, '');
    const lower = cleaned.toLowerCase();
    if (lower.startsWith('github.com/')) {
      host = 'github.com';
      cleaned = cleaned.slice('github.com/'.length);
    } else if (lower.startsWith('raw.githubusercontent.com/')) {
      host = 'raw.githubusercontent.com';
      cleaned = cleaned.slice('raw.githubusercontent.com/'.length);
    }
    path = cleaned;
  }

  // Normalize path: strip leading/trailing slashes and remove query/hash suffixes.
  path = (path || '').split('?')[0].split('#')[0];
  path = path.replace(/^\/+|\/+$/g, '');

  // If the user pasted a direct datasets.json URL, treat its parent as the exports root.
  if (path.toLowerCase().endsWith('/datasets.json')) {
    path = path.slice(0, -'/datasets.json'.length);
  }

  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const owner = parts[0];
  let repo = parts[1];
  let branch = null;
  let branchExplicit = false;

  // Allow explicit branch via owner/repo@branch/path or owner/repo#branch/path
  const repoBranchMatch = repo.match(/^([^@#]+)[@#]([^@#]+)$/);
  if (repoBranchMatch) {
    repo = repoBranchMatch[1];
    branch = repoBranchMatch[2];
    branchExplicit = true;
  }

  let rest = parts.slice(2);

  // Parse GitHub "tree/blob" URLs: /owner/repo/tree/<branch>/...
  if ((host === 'github.com' || host === null) && rest.length >= 2 && (rest[0] === 'tree' || rest[0] === 'blob')) {
    branch = rest[1];
    branchExplicit = true;
    rest = rest.slice(2);
  }

  // Parse raw URLs: /owner/repo/<branch>/...
  if (host === 'raw.githubusercontent.com' && rest.length >= 1) {
    branch = rest[0];
    branchExplicit = true;
    rest = rest.slice(1);
  }

  return {
    owner,
    repo,
    branch,
    pathSegments: rest,
    path: rest.join('/'),
    branchExplicit
  };
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
          'Invalid GitHub path. Use format: owner/repo/exports (or owner/repo@branch/exports), or paste a GitHub URL.',
          DataSourceErrorCode.INVALID_FORMAT,
          this.type,
          { input: inputPath }
        );
      }

      const commonBranches = ['main', 'master', 'gh-pages', 'develop', 'dev'];

      const attempts = [];
      const tried = new Set();

      const tryManifest = async ({ owner, repo, branch, path }) => {
        const baseUrl = buildRawUrl({ owner, repo, branch, path });
        const manifestUrl = resolveUrl(baseUrl, DATA_CONFIG.DATASETS_MANIFEST);
        if (tried.has(manifestUrl)) return null;
        tried.add(manifestUrl);

        try {
          const manifest = await fetchJson(manifestUrl);
          validateSchemaVersion(
            manifest.version,
            DATA_CONFIG.SUPPORTED_MANIFEST_VERSIONS,
            'datasets.json'
          );
          return { baseUrl, manifestUrl, manifest, branch, path };
        } catch (err) {
          attempts.push({
            baseUrl,
            manifestUrl,
            error: err?.message || String(err)
          });
          return null;
        }
      };

      const owner = this._parsedPath.owner;
      const repo = this._parsedPath.repo;

      let chosen = null;
      if (this._parsedPath.branch) {
        chosen = await tryManifest({
          owner,
          repo,
          branch: this._parsedPath.branch,
          path: this._parsedPath.path
        });
      } else {
        // First: default branches + the full path (most common: owner/repo/exports).
        for (const b of commonBranches) {
          chosen = await tryManifest({ owner, repo, branch: b, path: this._parsedPath.path });
          if (chosen) break;
        }

        // Next: treat the first path segment as a branch name (owner/repo/<branch>/<exportsPath>).
        if (!chosen && this._parsedPath.pathSegments.length >= 2) {
          const b = this._parsedPath.pathSegments[0];
          const p = this._parsedPath.pathSegments.slice(1).join('/');
          chosen = await tryManifest({ owner, repo, branch: b, path: p });
        }

        // Last resort: treat a single segment as a branch (owner/repo/<branch>).
        if (!chosen && this._parsedPath.pathSegments.length === 1) {
          const b = this._parsedPath.pathSegments[0];
          chosen = await tryManifest({ owner, repo, branch: b, path: '' });
        }
      }

      if (!chosen) {
        const hint = attempts[0]?.manifestUrl
          ? ` (example tried: ${attempts[0].manifestUrl})`
          : '';
        throw new DataSourceError(
          `datasets.json not found at this GitHub path${hint}. ` +
          `Make sure you point at an exports root folder that contains datasets.json.`,
          DataSourceErrorCode.NOT_FOUND,
          this.type,
          { input: inputPath, parsed: this._parsedPath, attempts }
        );
      }

      this._baseUrl = chosen.baseUrl;
      this._manifest = chosen.manifest;
      this._parsedPath.branch = chosen.branch;
      this._parsedPath.path = chosen.path;
      this._parsedPath.pathSegments = (chosen.path || '').split('/').filter(Boolean);
      console.log(`[GitHubDataSource] Connecting to: ${this._baseUrl}`);

      console.log(`[GitHubDataSource] Found datasets manifest with ${this._manifest.datasets?.length || 0} datasets`);

      // Load datasets
      this._datasets = await this._loadDatasets();
      this._connected = true;

      const repoInfo = {
        owner,
        repo,
        branch: chosen.branch,
        path: chosen.path,
        baseUrl: this._baseUrl,
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
   * Load datasets from manifest
   * @returns {Promise<DatasetMetadata[]>}
   * @private
   */
  async _loadDatasets() {
    if (!this._manifest) {
      throw new DataSourceError(
        'datasets.json manifest not loaded',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type,
        { url: this._baseUrl }
      );
    }

    // Multi-dataset mode
    const datasets = [];
    const failures = [];
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
        failures.push({
          id: entry.id,
          message: err?.message || String(err)
        });
      }
    }

    if (datasets.length === 0) {
      const hint = failures.length
        ? ` (first error: ${failures[0].message})`
        : '';
      throw new DataSourceError(
        `No valid datasets found at this GitHub path${hint}`,
        DataSourceErrorCode.INVALID_FORMAT,
        this.type,
        { url: this._baseUrl, failures }
      );
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

    // Re-load manifest + datasets
    if (!this._baseUrl) return;

    const manifestUrl = resolveUrl(this._baseUrl, DATA_CONFIG.DATASETS_MANIFEST);
    this._manifest = await fetchJson(manifestUrl);
    validateSchemaVersion(
      this._manifest.version,
      DATA_CONFIG.SUPPORTED_MANIFEST_VERSIONS,
      'datasets.json'
    );

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
