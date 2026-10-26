/**
 * @fileoverview The default view a dataset catalog names for a dataset: its
 * `session` (`datasets.json`, `data/sources/anndata-catalog.js`), a
 * `.cellucid-session` file pinned by its exact byte length and SHA-256,
 * applied when the dataset is opened from the catalog.
 *
 * Only a dataset of a catalog (the sample catalog, or a linked one) that
 * names a session owns one; every other dataset performs no request.
 *
 * @module session/catalog-default-session
 */

import {
  assertNonEmptyString,
  requireMethod,
} from './schema-contract.js';
import {
  isSessionRestoreCanceledError,
  isSessionRestoreSupersededError,
} from './session-serializer.js';
// `crypto.subtle` is secure-context only and has no non-secure counterpart, so
// verifying a published state's advertised digest through it fails on exactly
// the plain-HTTP LAN address the Python package is built to serve from.
import { sha256Hex } from '../utils/sha256.js';
import { requireExactKeys, requirePlainRecord } from '../../utils/exact-record.js';
import { formatCountOf } from '../../utils/format-units.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DESCRIPTOR_KEYS = Object.freeze([
  'datasetId',
  'identityId',
  'selectionRevision',
  'sessionBytes',
  'sessionSha256',
  'sessionUrl',
  'sourceType',
]);

export function classifyAdvertisedDatasetStateRestoreError(
  error,
  options
) {
  requireExactKeys(
    options,
    ['ownerAborted'],
    'Advertised dataset state error classification options'
  );
  if (typeof options.ownerAborted !== 'boolean') {
    throw new TypeError(
      'Advertised dataset state ownerAborted must be boolean.'
    );
  }
  if (options.ownerAborted) {
    return Object.freeze({ status: 'superseded' });
  }
  if (isSessionRestoreSupersededError(error)) {
    return Object.freeze({ status: 'ready-state-replaced' });
  }
  if (isSessionRestoreCanceledError(error)) {
    return Object.freeze({ status: 'ready-state-canceled' });
  }
  return null;
}

function assertAbortSignal(value) {
  if (!(value instanceof AbortSignal)) {
    throw new TypeError(
      'Default session signal must be an AbortSignal.'
    );
  }
  return value;
}

function assertOwner(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function throwIfAborted(signal) {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function assertHttpUrl(value, label) {
  assertNonEmptyString(value, label);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTP(S) URL.`);
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.href !== value
  ) {
    throw new TypeError(`${label} must be one canonical HTTP(S) URL.`);
  }
  return parsed.href;
}

function assertDatasetStateDescriptor(value) {
  requireExactKeys(value, DESCRIPTOR_KEYS, 'Dataset state descriptor');
  const datasetId = assertNonEmptyString(
    value.datasetId,
    'Dataset state dataset id'
  );
  const identityId = assertNonEmptyString(
    value.identityId,
    'Dataset state identity id'
  );
  if (value.sourceType !== 'local-demo' && value.sourceType !== 'link') {
    throw new TypeError(
      'Dataset state descriptor source type must be local-demo or link.'
    );
  }
  if (
    !Number.isSafeInteger(value.selectionRevision)
    || value.selectionRevision < 0
  ) {
    throw new TypeError(
      'Dataset state selection revision must be a non-negative safe integer.'
    );
  }
  if (
    typeof value.sessionSha256 !== 'string'
    || !SHA256_PATTERN.test(value.sessionSha256)
  ) {
    throw new TypeError(
      'Dataset state SHA-256 must be one lowercase digest.'
    );
  }
  if (!Number.isSafeInteger(value.sessionBytes) || value.sessionBytes < 1) {
    throw new TypeError(
      'Dataset state byte length must be a positive safe integer.'
    );
  }
  return Object.freeze({
    datasetId,
    identityId,
    selectionRevision: value.selectionRevision,
    sessionBytes: value.sessionBytes,
    sessionSha256: value.sessionSha256,
    sessionUrl: assertHttpUrl(value.sessionUrl, 'Dataset state session URL'),
    sourceType: value.sourceType,
  });
}

function descriptorsEqual(left, right) {
  return DESCRIPTOR_KEYS.every(key => left[key] === right[key]);
}

function readCurrentDescriptor(manager) {
  const descriptor = requireMethod(
    manager,
    'getCurrentStateDescriptor',
    'Dataset state data source manager'
  ).call(manager);
  if (descriptor === null) return null;
  return assertDatasetStateDescriptor(descriptor);
}

function assertCurrentDescriptor(manager, expected) {
  const current = readCurrentDescriptor(manager);
  if (current === null || !descriptorsEqual(current, expected)) {
    throw new Error(
      'Dataset generation changed before its default state restore completed.'
    );
  }
}

function assertResponse(response, owner) {
  if (
    response === null
    || typeof response !== 'object'
    || Array.isArray(response)
  ) {
    throw new TypeError(`${owner} response must be an object.`);
  }
  if (typeof response.ok !== 'boolean') {
    throw new TypeError(`${owner} response ok must be boolean.`);
  }
  if (!Number.isSafeInteger(response.status)) {
    throw new TypeError(
      `${owner} response status must be a safe integer.`
    );
  }
  return response;
}

async function readBoundedBytes(response, signal, maxBytes, owner) {
  const body = response.body;
  if (
    body === null
    || typeof body !== 'object'
    || typeof body.getReader !== 'function'
  ) {
    throw new TypeError(`${owner} response must expose a readable body.`);
  }
  const reader = body.getReader();
  const chunks = [];
  let byteLength = 0;
  let cancelledForSize = false;
  try {
    while (true) {
      throwIfAborted(signal);
      const result = await reader.read();
      requirePlainRecord(result, `${owner} stream result`);
      if (typeof result.done !== 'boolean') {
        throw new TypeError(`${owner} stream done must be boolean.`);
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw new TypeError(
          `${owner} stream chunks must be Uint8Array values.`
        );
      }
      byteLength += result.value.byteLength;
      if (byteLength > maxBytes) {
        cancelledForSize = true;
        await reader.cancel();
        throw new RangeError(
          `${owner} must not exceed ${formatCountOf(maxBytes, 'byte')}.`
        );
      }
      chunks.push(result.value);
    }
  } finally {
    if (!cancelledForSize && signal.aborted) {
      await reader.cancel();
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function assertFetchArtifact(value) {
  if (typeof value !== 'function') {
    throw new TypeError(
      'Dataset state fetchArtifact must be a function.'
    );
  }
  return value;
}

function assertRequestStep(value) {
  if (typeof value !== 'function') {
    throw new TypeError(
      'Dataset state requestStep must be a function.'
    );
  }
  return value;
}

/**
 * Fetch one bounded sidecar as one request step: the response and its whole
 * body run inside `requestStep(url, operation)`, whose runner hands
 * `operation` a signal it may abort (startup aborts it at its step deadline).
 * The request observes that signal and the restore's own signal.
 */
async function fetchBoundedArtifact({
  accept,
  fetchArtifact,
  maxBytes,
  owner,
  requestStep,
  signal,
  url,
}) {
  throwIfAborted(signal);
  return requestStep(url, async stepSignal => {
    if (!(stepSignal instanceof AbortSignal)) {
      throw new TypeError(
        `${owner} request step must provide an AbortSignal.`
      );
    }
    const requestSignal = AbortSignal.any([signal, stepSignal]);
    const response = assertResponse(
      // Revalidated like every catalog file (CATALOG_FILE_CACHE in
      // data/data-source.js); the catalog's sha256 pins the bytes.
      await fetchArtifact(url, {
        headers: { accept },
        method: 'GET',
        signal: requestSignal,
      }),
      owner
    );
    throwIfAborted(requestSignal);
    if (response.ok !== true) {
      throw new Error(`${owner} request failed with HTTP ${response.status}.`);
    }
    return readBoundedBytes(response, requestSignal, maxBytes, owner);
  });
}

export async function restoreCurrentDatasetState(options) {
  requireExactKeys(
    options,
    [
      'dataSourceManager',
      'fetchArtifact',
      'getPublicationRevision',
      'refreshUi',
      'requestStep',
      'sessionSerializer',
      'signal',
    ],
    'Dataset state restore options'
  );
  const manager = assertOwner(
    options.dataSourceManager,
    'Dataset state restore data source manager'
  );
  const fetchArtifact = assertFetchArtifact(options.fetchArtifact);
  const requestStep = assertRequestStep(options.requestStep);
  const serializer = assertOwner(
    options.sessionSerializer,
    'Dataset state session serializer'
  );
  if (typeof options.getPublicationRevision !== 'function') {
    throw new TypeError(
      'Dataset state getPublicationRevision must be a function.'
    );
  }
  if (typeof options.refreshUi !== 'function') {
    throw new TypeError(
      'Dataset state restore refreshUi must be a function.'
    );
  }
  const signal = assertAbortSignal(options.signal);
  const publicationRevision = options.getPublicationRevision();
  if (
    !Number.isSafeInteger(publicationRevision)
    || publicationRevision < 0
  ) {
    throw new TypeError(
      'Dataset runtime publication revision must be a non-negative safe integer.'
    );
  }
  const assertPublication = () => {
    if (options.getPublicationRevision() !== publicationRevision) {
      throw new Error(
        'Dataset runtime changed before its default state restore completed.'
      );
    }
  };

  throwIfAborted(signal);
  const target = readCurrentDescriptor(manager);
  if (target === null) return false;
  assertPublication();

  const stateBytes = await fetchBoundedArtifact({
    accept: 'application/octet-stream',
    fetchArtifact,
    // The catalog declares the session's exact length (bytes) and its digest
    // (sha256): the read stops past the declared length, and there is no
    // other size limit.
    maxBytes: target.sessionBytes,
    owner: 'The default session',
    requestStep,
    signal,
    url: target.sessionUrl,
  });
  throwIfAborted(signal);
  assertPublication();
  assertCurrentDescriptor(manager, target);
  if (stateBytes.byteLength !== target.sessionBytes) {
    throw new Error(
      `The default session is ${formatCountOf(stateBytes.byteLength, 'byte')}; the catalog declares ${target.sessionBytes}.`
    );
  }
  const actualSha256 = await sha256Hex(stateBytes);
  throwIfAborted(signal);
  if (actualSha256 !== target.sessionSha256) {
    throw new Error(
      'The default session SHA-256 does not match the one the catalog declares.'
    );
  }
  assertPublication();
  assertCurrentDescriptor(manager, target);

  await requireMethod(
    serializer,
    'restorePublishedDefaultState',
    'Dataset state session serializer'
  ).call(
    serializer,
    new Blob([stateBytes], { type: 'application/octet-stream' }),
    {
      async refreshUi({ phase }) {
        if (phase === 'rollback') {
          await options.refreshUi();
          return;
        }
        if (phase !== 'commit') {
          throw new TypeError(
            'Published dataset state UI refresh phase is invalid.'
          );
        }
        throwIfAborted(signal);
        assertPublication();
        assertCurrentDescriptor(manager, target);
        await options.refreshUi();
        throwIfAborted(signal);
        assertPublication();
        assertCurrentDescriptor(manager, target);
      },
      signal
    }
  );
  throwIfAborted(signal);
  assertPublication();
  assertCurrentDescriptor(manager, target);
  return true;
}
