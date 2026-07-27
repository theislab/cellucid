/**
 * @fileoverview Integrity-pinned publication contract for an official
 * sample's static default session state.
 *
 * Only an explicitly advertised local-demo generation owns these sidecars.
 * Other sources and catalogs without the capability perform no probe.
 *
 * @module session/dataset-state-manifest
 */

import {
  assertArray,
  assertExactKeys,
  assertNonEmptyString,
  assertPlainRecord,
  requireMethod,
} from './schema-contract.js';
import {
  isSessionRestoreCanceledError,
  isSessionRestoreSupersededError,
} from './session-serializer.js';

const MANIFEST_FILENAME = 'state-snapshots.json';
const DEFAULT_STATE_FILENAME = 'default.cellucid-session';
const MAX_MANIFEST_BYTES = 4096;
const MAX_STATE_BYTES = 32768;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DESCRIPTOR_KEYS = Object.freeze([
  'baseUrl',
  'datasetId',
  'identityId',
  'manifestUrl',
  'selectionRevision',
  'sourceType',
  'stateSha256',
]);

export function classifyAdvertisedDatasetStateRestoreError(
  error,
  options
) {
  assertExactKeys(
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
      'Dataset state manifest signal must be an AbortSignal.'
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

function assertCanonicalHttpDirectoryUrl(value, label) {
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
    || parsed.search !== ''
    || parsed.hash !== ''
    || !parsed.pathname.endsWith('/')
    || parsed.href !== value
  ) {
    throw new TypeError(
      `${label} must be one canonical HTTP(S) directory URL.`
    );
  }
  return parsed.href;
}

function assertDatasetStateDescriptor(value) {
  assertExactKeys(value, DESCRIPTOR_KEYS, 'Dataset state descriptor');
  const baseUrl = assertCanonicalHttpDirectoryUrl(
    value.baseUrl,
    'Dataset state base URL'
  );
  const datasetId = assertNonEmptyString(
    value.datasetId,
    'Dataset state dataset id'
  );
  const identityId = assertNonEmptyString(
    value.identityId,
    'Dataset state identity id'
  );
  if (value.sourceType !== 'local-demo') {
    throw new TypeError(
      'Dataset state descriptor source type must be exactly local-demo.'
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
    typeof value.stateSha256 !== 'string'
    || !SHA256_PATTERN.test(value.stateSha256)
  ) {
    throw new TypeError(
      'Dataset state SHA-256 must be one lowercase digest.'
    );
  }
  const expectedManifestUrl = new URL(MANIFEST_FILENAME, baseUrl).href;
  if (value.manifestUrl !== expectedManifestUrl) {
    throw new TypeError(
      'Dataset state manifest URL must be the exact dataset state-snapshots.json sibling.'
    );
  }
  return Object.freeze({
    baseUrl,
    datasetId,
    identityId,
    manifestUrl: expectedManifestUrl,
    selectionRevision: value.selectionRevision,
    sourceType: 'local-demo',
    stateSha256: value.stateSha256,
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
      assertPlainRecord(result, `${owner} stream result`);
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
          `${owner} must not exceed ${maxBytes} bytes.`
        );
      }
      chunks.push(result.value);
    }
  } finally {
    if (!cancelledForSize && signal.aborted) {
      await reader.cancel();
    }
    reader.releaseLock();
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

async function fetchBoundedArtifact({
  accept,
  fetchArtifact,
  maxBytes,
  owner,
  signal,
  url,
}) {
  throwIfAborted(signal);
  const response = assertResponse(
    await fetchArtifact(url, {
      cache: 'no-store',
      headers: { accept },
      method: 'GET',
      signal,
    }),
    owner
  );
  throwIfAborted(signal);
  if (response.ok !== true) {
    throw new Error(`${owner} request failed with HTTP ${response.status}.`);
  }
  return readBoundedBytes(response, signal, maxBytes, owner);
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => (
    byte.toString(16).padStart(2, '0')
  )).join('');
}

export function assertDatasetStateManifest(value) {
  assertExactKeys(value, ['states'], 'Dataset state manifest');
  const states = assertArray(value.states, 'Dataset state manifest states');
  if (
    states.length !== 1
    || states[0] !== DEFAULT_STATE_FILENAME
  ) {
    throw new TypeError(
      'Dataset state manifest states must contain exactly default.cellucid-session.'
    );
  }
  return value;
}

export async function loadCurrentDatasetStateTarget(options) {
  assertExactKeys(
    options,
    ['dataSourceManager', 'fetchArtifact', 'signal'],
    'Dataset state target options'
  );
  const manager = assertOwner(
    options.dataSourceManager,
    'Dataset state data source manager'
  );
  const fetchArtifact = assertFetchArtifact(options.fetchArtifact);
  const signal = assertAbortSignal(options.signal);
  throwIfAborted(signal);

  const descriptor = readCurrentDescriptor(manager);
  if (descriptor === null) return null;
  const manifestBytes = await fetchBoundedArtifact({
    accept: 'application/json',
    fetchArtifact,
    maxBytes: MAX_MANIFEST_BYTES,
    owner: MANIFEST_FILENAME,
    signal,
    url: descriptor.manifestUrl,
  });
  const manifestText = new TextDecoder(
    'utf-8',
    { fatal: true }
  ).decode(manifestBytes);
  const manifest = assertDatasetStateManifest(
    JSON.parse(manifestText)
  );
  throwIfAborted(signal);
  assertCurrentDescriptor(manager, descriptor);

  return Object.freeze({
    ...descriptor,
    stateUrl: new URL(manifest.states[0], descriptor.baseUrl).href,
  });
}

export async function restoreCurrentDatasetState(options) {
  assertExactKeys(
    options,
    [
      'dataSourceManager',
      'fetchArtifact',
      'getPublicationRevision',
      'refreshUi',
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

  const target = await loadCurrentDatasetStateTarget({
    dataSourceManager: manager,
    fetchArtifact,
    signal,
  });
  if (target === null) return false;
  assertPublication();
  assertCurrentDescriptor(manager, target);

  const stateBytes = await fetchBoundedArtifact({
    accept: 'application/octet-stream',
    fetchArtifact,
    maxBytes: MAX_STATE_BYTES,
    owner: DEFAULT_STATE_FILENAME,
    signal,
    url: target.stateUrl,
  });
  throwIfAborted(signal);
  assertPublication();
  assertCurrentDescriptor(manager, target);
  const actualSha256 = await sha256Hex(stateBytes);
  throwIfAborted(signal);
  if (actualSha256 !== target.stateSha256) {
    throw new Error(
      'Default dataset state SHA-256 does not match the advertised generation.'
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
