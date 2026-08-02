/**
 * GitHubDataSource - Data source for datasets hosted in public GitHub repositories
 *
 * Allows users to load exported datasets from any public GitHub repository.
 * Uses GitHub's raw content URLs for direct file access with lazy loading.
 *
 * URL Format:
 * - Input: owner/repo/path/to/exports or owner/repo@branch/path/to/exports
 * - URL: https://github.com/owner/repo/tree/branch/path/to/exports
 * - Raw URL: https://raw.githubusercontent.com/owner/repo/branch/path/to/exports
 * - Resolved: https://raw.githubusercontent.com/owner/repo/main/path/to/exports/
 *
 * Features:
 * - Lazy loading: Files fetched on-demand, identical to local-demo behavior
 * - Multi-dataset support: Reads datasets.json
 * - Deterministic branch selection: shorthand uses 'main' unless @branch is explicit
 */

import {
  DATA_CONFIG,
  DataSourceError,
  DataSourceErrorCode,
  fetchJson,
  loadDatasetMetadata,
  resolveUrl,
  validateSchemaVersion
} from './data-source.js';
import {
  createMetadataAbortError,
  loadMetadataBatchAtomically,
} from './metadata-load-contract.js';
import { getNotificationCenter } from '../app/notification-center.js';

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

const DEFAULT_GITHUB_BRANCH = 'main';
const GITHUB_SOURCE_TYPE = 'github-repo';

function isSafeGitHubSegment(value) {
  return !(
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('%') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    /[\u0000-\u001f\u007f]/.test(value)
  );
}

function decodeGitHubSegment(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  return isSafeGitHubSegment(decoded) ? decoded : null;
}

function splitGitHubSegments(value, { urlPath = false } = {}) {
  let raw = value;
  if (urlPath) {
    if (!raw.startsWith('/')) return null;
    raw = raw.slice(1);
  }
  if (raw.endsWith('/')) {
    raw = raw.slice(0, -1);
  }
  if (raw.length === 0) return [];
  const encodedSegments = raw.split('/');
  if (encodedSegments.some(segment => segment.length === 0)) {
    return null;
  }
  const segments = encodedSegments.map(decodeGitHubSegment);
  return segments.some(segment => segment === null)
    ? null
    : segments;
}

/**
 * Parse a GitHub repository URL/path into components
 * @param {string} input - Exact shorthand, GitHub tree URL, or GitHub raw URL
 * @returns {{owner: string, repo: string, branch: string, path: string}|null}
 */
export function parseGitHubPath(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.trim();
  if (cleaned.length === 0) return null;

  let url = null;
  try {
    url = new URL(cleaned);
  } catch {
    // Exact shorthand is handled below.
  }

  if (url !== null) {
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null;
    }
    const segments = splitGitHubSegments(
      url.pathname,
      { urlPath: true }
    );
    if (segments === null) return null;

    if (url.hostname.toLowerCase() === 'github.com') {
      if (segments.length < 4 || segments[2] !== 'tree') {
        return null;
      }
      return {
        owner: segments[0],
        repo: segments[1],
        branch: segments[3],
        path: segments.slice(4).join('/'),
      };
    }
    if (
      url.hostname.toLowerCase() ===
      'raw.githubusercontent.com'
    ) {
      if (segments.length < 3) return null;
      return {
        owner: segments[0],
        repo: segments[1],
        branch: segments[2],
        path: segments.slice(3).join('/'),
      };
    }
    return null;
  }

  if (
    cleaned.includes('://') ||
    cleaned.includes('?') ||
    cleaned.includes('#') ||
    /^github\.com\//i.test(cleaned) ||
    /^raw\.githubusercontent\.com\//i.test(cleaned)
  ) {
    return null;
  }
  const segments = splitGitHubSegments(cleaned);
  if (segments === null || segments.length < 2) return null;

  const owner = segments[0];
  const repoSpecifier = segments[1];
  const atIndex = repoSpecifier.indexOf('@');
  let repo = repoSpecifier;
  let branch = DEFAULT_GITHUB_BRANCH;
  if (atIndex !== -1) {
    if (
      atIndex === 0 ||
      atIndex === repoSpecifier.length - 1 ||
      repoSpecifier.indexOf('@', atIndex + 1) !== -1
    ) {
      return null;
    }
    repo = repoSpecifier.slice(0, atIndex);
    branch = repoSpecifier.slice(atIndex + 1);
  }
  if (
    !isSafeGitHubSegment(repo) ||
    !isSafeGitHubSegment(branch)
  ) {
    return null;
  }
  return {
    owner,
    repo,
    branch,
    path: segments.slice(2).join('/'),
  };
}

/**
 * Build raw GitHub content URL from components
 * @param {{owner: string, repo: string, branch: string, path: string}} parsed
 * @returns {string}
 */
function buildRawUrl(parsed) {
  const { owner, repo, branch, path } = parsed;
  const segments = [owner, repo, branch];
  if (path.length > 0) {
    segments.push(...path.split('/'));
  }
  return (
    'https://raw.githubusercontent.com/' +
    segments.map(segment => encodeURIComponent(segment)).join('/') +
    '/'
  );
}

function invalidGitHubCatalog(message, details = {}) {
  return new DataSourceError(
    `Invalid datasets.json: ${message}`,
    DataSourceErrorCode.INVALID_FORMAT,
    GITHUB_SOURCE_TYPE,
    details
  );
}

function isPlainRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function requireExactKeys(value, required, optional, label) {
  if (!isPlainRecord(value)) {
    throw invalidGitHubCatalog(`${label} must be an object`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw invalidGitHubCatalog(
        `${label} is missing required field '${key}'`,
        { label, key }
      );
    }
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalidGitHubCatalog(
        `${label} contains unsupported field '${key}'`,
        { label, key }
      );
    }
  }
}

function validateDatasetDirectoryPath(value, id, baseUrl) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    !value.endsWith('/') ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    /^[A-Za-z]:/.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalidGitHubCatalog(
      `dataset '${id}' must declare a safe relative directory path ending in '/'`,
      { id, path: value }
    );
  }
  const encodedSegments = value.slice(0, -1).split('/');
  if (encodedSegments.some(segment => segment.length === 0)) {
    throw invalidGitHubCatalog(
      `dataset '${id}' must declare a safe relative directory path`,
      { id, path: value }
    );
  }
  const decodedSegments = [];
  for (const encodedSegment of encodedSegments) {
    const segment = decodeGitHubSegment(encodedSegment);
    if (segment === null) {
      throw invalidGitHubCatalog(
        `dataset '${id}' must declare a safe relative directory path`,
        { id, path: value }
      );
    }
    decodedSegments.push(segment);
  }
  const canonicalPath =
    decodedSegments
      .map(segment => encodeURIComponent(segment))
      .join('/') +
    '/';
  const resolved = resolveUrl(baseUrl, canonicalPath);
  if (!resolved.startsWith(baseUrl)) {
    throw invalidGitHubCatalog(
      `dataset '${id}' must declare a safe relative directory path`,
      { id, path: value }
    );
  }
  return resolved;
}

/**
 * Validate the sole current GitHub datasets.json contract.
 */
function validateGitHubCatalog(manifest, baseUrl) {
  requireExactKeys(
    manifest,
    ['version', 'default', 'datasets'],
    [],
    'catalog'
  );
  validateSchemaVersion(
    manifest.version,
    DATA_CONFIG.SUPPORTED_MANIFEST_VERSIONS,
    'datasets.json'
  );
  if (
    typeof manifest.default !== 'string' ||
    manifest.default.length === 0 ||
    manifest.default !== manifest.default.trim()
  ) {
    throw invalidGitHubCatalog(
      'an explicit default dataset id is required'
    );
  }
  if (
    !Array.isArray(manifest.datasets) ||
    manifest.datasets.length === 0
  ) {
    throw invalidGitHubCatalog(
      'datasets must be a non-empty array'
    );
  }

  const ids = new Set();
  const paths = new Set();
  for (
    let index = 0;
    index < manifest.datasets.length;
    index++
  ) {
    const entry = manifest.datasets[index];
    const label = `dataset entry ${index}`;
    requireExactKeys(
      entry,
      ['id', 'path'],
      ['name', 'description', 'n_cells', 'n_genes'],
      label
    );
    if (
      typeof entry.id !== 'string' ||
      entry.id.length === 0 ||
      entry.id !== entry.id.trim() ||
      /[\u0000-\u001f\u007f]/.test(entry.id)
    ) {
      throw invalidGitHubCatalog(
        `${label} requires a non-empty string id`,
        { index, id: entry.id }
      );
    }
    if (ids.has(entry.id)) {
      throw invalidGitHubCatalog(
        `every dataset requires a unique id; '${entry.id}' is duplicated`,
        { index, id: entry.id }
      );
    }
    ids.add(entry.id);

    const resolvedPath = validateDatasetDirectoryPath(
      entry.path,
      entry.id,
      baseUrl
    );
    if (paths.has(resolvedPath)) {
      throw invalidGitHubCatalog(
        `every dataset requires a unique path; '${entry.path}' is reused`,
        { index, id: entry.id, path: entry.path }
      );
    }
    paths.add(resolvedPath);

    if (
      Object.hasOwn(entry, 'name') &&
      (
        typeof entry.name !== 'string' ||
        entry.name.trim().length === 0
      )
    ) {
      throw invalidGitHubCatalog(
        `dataset '${entry.id}' name must be a non-empty string`,
        { id: entry.id, name: entry.name }
      );
    }
    if (
      Object.hasOwn(entry, 'description') &&
      typeof entry.description !== 'string'
    ) {
      throw invalidGitHubCatalog(
        `dataset '${entry.id}' description must be a string`,
        { id: entry.id, description: entry.description }
      );
    }
    for (const key of ['n_cells', 'n_genes']) {
      if (
        Object.hasOwn(entry, key) &&
        (
          !Number.isSafeInteger(entry[key]) ||
          entry[key] < 0
        )
      ) {
        throw invalidGitHubCatalog(
          `dataset '${entry.id}' ${key} must be a non-negative safe integer`,
          { id: entry.id, key, value: entry[key] }
        );
      }
    }
  }
  if (!ids.has(manifest.default)) {
    throw invalidGitHubCatalog(
      `default '${manifest.default}' is not present in datasets`,
      { default: manifest.default }
    );
  }
  return manifest;
}

function requireCatalogIdentityAgreement(entry, metadata) {
  const assertions = [
    ['name', metadata.name],
    ['description', metadata.description],
    ['n_cells', metadata.stats.n_cells],
    ['n_genes', metadata.stats.n_genes],
  ];
  for (const [key, identityValue] of assertions) {
    if (
      Object.hasOwn(entry, key) &&
      entry[key] !== identityValue
    ) {
      throw invalidGitHubCatalog(
        `dataset '${entry.id}' catalog ${key} does not match canonical dataset_identity.json ${key}`,
        {
          datasetId: entry.id,
          key,
          catalogValue: entry[key],
          identityValue,
        }
      );
    }
  }
}

/**
 * Adopt every catalog entry's identity as one atomic generation.
 *
 * Each entry's `dataset_identity.json` is an independent read, so they are
 * issued as one batch rather than one round trip after another: a five-dataset
 * repository costs one network latency instead of five before its picker can
 * render. `loadMetadataBatchAtomically` owns the exactness this needs — the
 * first failure cancels every sibling, no partial catalog is ever returned, and
 * results keep catalog order. It is the same contract `remote-source.js` and
 * `jupyter-source.js` already use for their catalogs.
 *
 * @param {Object} manifest
 * @param {string} baseUrl
 * @param {string} sourceType
 * @param {AbortSignal|null} signal
 * @returns {Promise<DatasetMetadata[]>}
 */
async function loadGitHubDatasets(
  manifest,
  baseUrl,
  sourceType,
  signal
) {
  validateGitHubCatalog(manifest, baseUrl);
  return loadMetadataBatchAtomically(
    manifest.datasets,
    signal,
    async (entry, entrySignal) => {
      try {
        const datasetBaseUrl = resolveUrl(baseUrl, entry.path);
        const metadata = await loadDatasetMetadata(
          datasetBaseUrl,
          entry.id,
          sourceType,
          { signal: entrySignal }
        );
        requireCatalogIdentityAgreement(entry, metadata);
        return metadata;
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw error;
        }
        throw new DataSourceError(
          `Dataset '${entry.id}' is invalid: ${error?.message || error}`,
          DataSourceErrorCode.INVALID_FORMAT,
          sourceType,
          { datasetId: entry.id, cause: error }
        );
      }
    },
    'GitHub catalog metadata loading'
  );
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

    /** @type {number} Connection generation for stale refresh rejection */
    this._connectionRevision = 0;

    this._operationRevision = 0;
    /** @type {AbortController|null} */
    this._pendingController = null;

    this.type = 'github-repo';
  }

  _beginOperation(reason) {
    const previousController = this._pendingController;
    const controller = new AbortController();
    this._pendingController = controller;
    const revision = ++this._operationRevision;
    previousController?.abort(new Error(reason));
    return { controller, revision };
  }

  _assertOperation(owner, label) {
    if (
      owner.controller.signal.aborted ||
      owner.controller !== this._pendingController ||
      owner.revision !== this._operationRevision
    ) {
      throw createMetadataAbortError(label);
    }
  }

  _finishOperation(owner) {
    if (this._pendingController === owner.controller) {
      this._pendingController = null;
    }
  }

  /**
   * Get the type identifier
   * @returns {string}
   */
  getType() {
    return this.type;
  }

  /**
   * Create an isolated connection candidate. Repository validation never
   * mutates the currently registered source.
   *
   * @returns {GitHubDataSource}
   */
  createConnectionCandidate() {
    return new GitHubDataSource();
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
    const owner = this._beginOperation(
      'GitHub connection was superseded'
    );

    try {
      const parsedPath = parseGitHubPath(inputPath);
      if (!parsedPath) {
        throw new DataSourceError(
          'Invalid GitHub path. Use format: owner/repo/exports (or owner/repo@branch/exports), or paste a GitHub URL.',
          DataSourceErrorCode.INVALID_FORMAT,
          this.type,
          { input: inputPath }
        );
      }

      const baseUrl = buildRawUrl(parsedPath);
      const manifestUrl = resolveUrl(
        baseUrl,
        DATA_CONFIG.DATASETS_MANIFEST
      );
      const manifest = await fetchJson(
        manifestUrl,
        this.type,
        { signal: owner.controller.signal }
      );
      const datasets = await loadGitHubDatasets(
        manifest,
        baseUrl,
        this.type,
        owner.controller.signal
      );
      this._assertOperation(owner, 'GitHub connection');

      const repoInfo = {
        owner: parsedPath.owner,
        repo: parsedPath.repo,
        branch: parsedPath.branch,
        path: parsedPath.path,
        baseUrl,
      };

      this._inputPath = inputPath.trim();
      this._parsedPath = parsedPath;
      this._baseUrl = baseUrl;
      this._manifest = manifest;
      this._datasets = datasets;
      this._activeDatasetId = null;
      this._connected = true;
      this._connectionRevision++;

      notifications.complete(
        trackerId,
        `Connected to ${parsedPath.owner}/${parsedPath.repo}`
      );
      console.log('[GitHubDataSource] Connected:', repoInfo);

      return { repoInfo, datasets };
    } catch (err) {
      if (err?.name === 'AbortError') {
        notifications.dismiss(trackerId);
        throw err;
      }
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
    } finally {
      this._finishOperation(owner);
    }
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
    this._operationRevision += 1;
    this._pendingController?.abort(
      new Error('GitHub connection was disconnected')
    );
    this._pendingController = null;
    this._baseUrl = null;
    this._inputPath = null;
    this._parsedPath = null;
    this._manifest = null;
    this._datasets = null;
    this._activeDatasetId = null;
    this._connected = false;
    this._connectionRevision++;
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
   * Files are loaded directly from the exact GitHub raw URL.
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
    if (!this._manifest) {
      throw new DataSourceError(
        'GitHub dataset catalog has not been loaded',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }
    validateGitHubCatalog(this._manifest, this._baseUrl);
    const entry = this._manifest.datasets.find(
      dataset => dataset.id === datasetId
    );
    if (!entry) {
      throw new DataSourceError(
        `Dataset '${datasetId}' not found in datasets.json`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { datasetId }
      );
    }

    const datasetBaseUrl = resolveUrl(this._baseUrl, entry.path);
    this._activeDatasetId = datasetId;
    return datasetBaseUrl;
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
    if (!this._connected || !this._inputPath || !this._baseUrl) {
      throw new DataSourceError(
        'Not connected to GitHub repository',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }

    const baseUrl = this._baseUrl;
    const inputPath = this._inputPath;
    const connectionRevision = this._connectionRevision;
    const owner = this._beginOperation(
      'GitHub refresh was superseded'
    );
    const manifestUrl = resolveUrl(
      baseUrl,
      DATA_CONFIG.DATASETS_MANIFEST
    );
    try {
      const manifest = await fetchJson(
        manifestUrl,
        this.type,
        { signal: owner.controller.signal }
      );
      const datasets = await loadGitHubDatasets(
        manifest,
        baseUrl,
        this.type,
        owner.controller.signal
      );
      this._assertOperation(owner, 'GitHub refresh');

      if (
        !this._connected ||
        this._baseUrl !== baseUrl ||
        this._inputPath !== inputPath ||
        this._connectionRevision !== connectionRevision
      ) {
        throw new DataSourceError(
          'GitHub repository connection changed during refresh',
          DataSourceErrorCode.VALIDATION_ERROR,
          this.type
        );
      }

      this._manifest = manifest;
      this._datasets = datasets;
      if (
        this._activeDatasetId !== null &&
        !manifest.datasets.some(
          entry => entry.id === this._activeDatasetId
        )
      ) {
        this._activeDatasetId = null;
      }
    } catch (error) {
      if (
        error?.name === 'AbortError' &&
        (
          !this._connected ||
          this._baseUrl !== baseUrl ||
          this._inputPath !== inputPath ||
          this._connectionRevision !== connectionRevision
        )
      ) {
        throw new DataSourceError(
          'GitHub repository connection changed during refresh',
          DataSourceErrorCode.VALIDATION_ERROR,
          this.type
        );
      }
      throw error;
    } finally {
      this._finishOperation(owner);
    }
  }

  /**
   * Cancel transient catalog work while retaining the adopted connection
   * snapshot.
   *
   * The manifest and identity list are compact connection state, not bulk
   * dataset buffers. Dropping them while `_connected` remains true makes the
   * synchronous base-URL contract unusable and cannot be repaired lazily.
   */
  clearCaches() {
    this._operationRevision += 1;
    this._pendingController?.abort(
      new Error('GitHub caches were cleared')
    );
    this._pendingController = null;
    console.log(
      '[GitHubDataSource] Cancelled transient catalog work; retained connection metadata'
    );
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
