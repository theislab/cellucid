/**
 * Where a session's dataset can be opened from, recorded in the session
 * manifest as `source`, so loading the session can open its dataset first.
 *
 * The fingerprint says *which* dataset a session belongs to and is checked
 * before anything is applied; the source only says where to find it. It is
 * one of:
 *
 * - `{kind: 'sample', dataset}`: a dataset of the page's sample catalog;
 * - `{kind: 'link', locator, dataset}`: a data link in its public form and
 *   the dataset it holds;
 * - `{kind: 'remote', url, dataset}`: a Cellucid server;
 * - `{kind: 'file', name, dataset}`: a file or folder opened from this
 *   computer (`name` is the `.h5ad`, `.zarr.zip` or folder name). The session
 *   opens it only where this browser kept its handle, under `dataset`
 *   (`app/local-file-handles.js`, Chromium); elsewhere loading the session
 *   asks for it by name. The handle is never part of the session;
 * - `null`: a notebook, or no dataset.
 *
 * A link is recorded in its public form (`getConnectionInfo().locator`,
 * `data/sources/link-credentials.js`): whatever the opened link carried to
 * grant access (a Dropbox share key, a Drive resource key, a signature, a
 * token) is never part of a session. A session of such a link opens its
 * dataset for whoever has access to it; anyone else opens the link first,
 * then loads the session.
 *
 * @module session/dataset-source-record
 */

import { requireExactKeys } from '../../utils/exact-record.js';


const KEYS_BY_KIND = Object.freeze({
  sample: Object.freeze(['dataset', 'kind']),
  link: Object.freeze(['dataset', 'kind', 'locator']),
  remote: Object.freeze(['dataset', 'kind', 'url']),
  file: Object.freeze(['dataset', 'kind', 'name']),
});

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} must be a non-empty, unpadded string.`);
  }
  return value;
}

/**
 * Validate one recorded source (untrusted input).
 *
 * @param {unknown} value
 * @param {string} context
 * @returns {object|null}
 */
export function assertDatasetSourceRecord(value, context) {
  if (value === null) return null;
  const kind = value?.kind;
  const keys = Object.hasOwn(KEYS_BY_KIND, kind) ? KEYS_BY_KIND[kind] : null;
  if (keys === null) {
    throw new TypeError(`${context} kind must be "sample", "link", "remote" or "file".`);
  }
  requireExactKeys(value, [...keys], context);
  requireText(value.dataset, `${context} dataset`);
  if (kind === 'link') requireText(value.locator, `${context} locator`);
  if (kind === 'file') requireText(value.name, `${context} name`);
  if (kind === 'remote') {
    const url = new URL(requireText(value.url, `${context} url`));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new TypeError(`${context} url must be an http(s) address.`);
    }
  }
  return value;
}

/**
 * The source of the dataset that is open, or null when nothing names it (a
 * notebook).
 *
 * @param {object|null} dataSourceManager
 * @returns {object|null}
 */
export function captureDatasetSourceRecord(dataSourceManager) {
  if (dataSourceManager === null) return null;
  const sourceType = dataSourceManager.getCurrentSourceType();
  const dataset = dataSourceManager.getCurrentDatasetId();
  if (typeof dataset !== 'string' || dataset.length === 0) return null;
  if (sourceType === 'local-demo') return { kind: 'sample', dataset };
  const info = dataSourceManager.activeSource?.getConnectionInfo?.() ?? null;
  if (sourceType === 'link' && typeof info?.locator === 'string') {
    return { kind: 'link', locator: info.locator, dataset };
  }
  if (sourceType === 'remote' && typeof info?.url === 'string') {
    return { kind: 'remote', url: info.url, dataset };
  }
  if (sourceType === 'local-user') {
    const name = dataSourceManager.activeSource?.getPath?.() ?? null;
    if (typeof name === 'string' && name.trim() !== '' && name === name.trim()
        && !/[\u0000-\u001f\u007f]/.test(name)) {
      return { kind: 'file', name, dataset };
    }
  }
  return null;
}

/**
 * Name a recorded source for the person loading the session.
 *
 * @param {object} record
 * @returns {string}
 */
export function describeDatasetSourceRecord(record) {
  if (record.kind === 'sample') return `the sample dataset "${record.dataset}"`;
  if (record.kind === 'link') return record.locator;
  if (record.kind === 'file') return `the file "${record.name}" on the computer it was saved on`;
  return `the Cellucid server at ${record.url}`;
}
