/**
 * @fileoverview Exact binary analysis-cache session contributor.
 *
 * Each lazy dataset-dependent chunk owns one bulk-gene/page artifact. The
 * payload contains a canonical JSON metadata envelope followed by one exact
 * two-column table:
 * - cellIndex (uint32)
 * - value (float32)
 *
 * @module session/contributors/analysis-artifacts
 */

import {
  U32_BYTES,
  bytesToU32LE,
  u32ToBytesLE
} from '../bundle/format.js';
import { decodeTable, encodeTable } from '../codecs/table-codec.js';
import {
  assertArray,
  assertExactKeys,
  assertNonEmptyString,
  assertPlainRecord,
  assertSafeInteger,
  requireMethod
} from '../schema-contract.js';

export const id = 'analysis-artifacts';

const CHUNK_PREFIX = 'analysis/artifacts/bulk-gene/';
const ARTIFACT_KEYS = Object.freeze([
  'kind',
  'cacheKey',
  'gene',
  'pageId',
  'pageName',
  'cellCount',
  'timestamp',
  'geneCount',
  'values',
  'cellIndices'
]);
const METADATA_KEYS = Object.freeze([
  'kind',
  'cacheKey',
  'gene',
  'pageId',
  'pageName',
  'cellCount',
  'timestamp',
  'geneCount'
]);
const CHUNK_META_KEYS = Object.freeze([
  'id',
  'contributorId',
  'priority',
  'kind',
  'codec',
  'label',
  'datasetDependent',
  'storedBytes',
  'uncompressedBytes'
]);

function requireDataLayer(ctx, methodName) {
  assertPlainRecord(ctx, 'Analysis-artifact session context');
  if (
    ctx.comparisonModule === null
    || typeof ctx.comparisonModule !== 'object'
    || Array.isArray(ctx.comparisonModule)
  ) {
    throw new TypeError('Analysis artifacts require the current comparisonModule owner.');
  }
  const dataLayer = ctx.comparisonModule.dataLayer;
  if (
    dataLayer === null
    || typeof dataLayer !== 'object'
    || Array.isArray(dataLayer)
  ) {
    throw new TypeError('Analysis artifacts require the current analysis dataLayer owner.');
  }
  requireMethod(dataLayer, methodName, 'Analysis artifact dataLayer');
  return dataLayer;
}

function assertArtifactMetadata(value, context) {
  assertExactKeys(value, METADATA_KEYS, context);
  if (value.kind !== 'bulk-gene') {
    throw new TypeError(`${context} kind must equal "bulk-gene".`);
  }
  const cacheKey = assertNonEmptyString(value.cacheKey, `${context} cacheKey`);
  const gene = assertNonEmptyString(value.gene, `${context} gene`);
  const pageId = assertNonEmptyString(value.pageId, `${context} pageId`);
  const pageName = assertNonEmptyString(value.pageName, `${context} pageName`);
  const cellCount = assertSafeInteger(
    value.cellCount,
    `${context} cellCount`,
    { maximum: 0xffff_ffff }
  );
  const timestamp = assertSafeInteger(value.timestamp, `${context} timestamp`);
  const geneCount = assertSafeInteger(
    value.geneCount,
    `${context} geneCount`,
    { maximum: 0xffff_ffff }
  );
  return {
    kind: 'bulk-gene',
    cacheKey,
    gene,
    pageId,
    pageName,
    cellCount,
    timestamp,
    geneCount
  };
}

function assertArtifact(value, context) {
  assertExactKeys(value, ARTIFACT_KEYS, context);
  const metadata = assertArtifactMetadata({
    kind: value.kind,
    cacheKey: value.cacheKey,
    gene: value.gene,
    pageId: value.pageId,
    pageName: value.pageName,
    cellCount: value.cellCount,
    timestamp: value.timestamp,
    geneCount: value.geneCount
  }, context);
  if (!(value.values instanceof Float32Array)) {
    throw new TypeError(`${context} values must be a Float32Array.`);
  }
  if (!(value.cellIndices instanceof Uint32Array)) {
    throw new TypeError(`${context} cellIndices must be a Uint32Array.`);
  }
  if (
    value.values.length !== value.cellIndices.length
    || value.values.length !== metadata.cellCount
  ) {
    throw new RangeError(
      `${context} cellCount, values length, and cellIndices length must match.`
    );
  }
  return {
    ...metadata,
    values: value.values,
    cellIndices: value.cellIndices
  };
}

function encodeIdentitySegment(value, context) {
  return encodeURIComponent(assertNonEmptyString(value, context));
}

function decodeIdentitySegment(value, context) {
  const encoded = assertNonEmptyString(value, `${context} encoded segment`);
  const decoded = assertNonEmptyString(
    decodeURIComponent(encoded),
    context
  );
  if (encodeURIComponent(decoded) !== encoded) {
    throw new TypeError(`${context} chunk id segment must use canonical URI encoding.`);
  }
  return decoded;
}

function artifactChunkId(artifact) {
  return (
    CHUNK_PREFIX
    + `${encodeIdentitySegment(artifact.cacheKey, 'Analysis artifact cacheKey')}/`
    + `${encodeIdentitySegment(artifact.gene, 'Analysis artifact gene')}/`
    + encodeIdentitySegment(artifact.pageId, 'Analysis artifact pageId')
  );
}

function parseChunkIdentity(chunkId) {
  const exactId = assertNonEmptyString(chunkId, 'Analysis artifact chunk id');
  const parts = exactId.split('/');
  if (
    parts.length !== 6
    || parts[0] !== 'analysis'
    || parts[1] !== 'artifacts'
    || parts[2] !== 'bulk-gene'
  ) {
    throw new TypeError(
      'Analysis artifact chunk id must match the exact bulk-gene identity path.'
    );
  }
  const cacheKey = decodeIdentitySegment(parts[3], 'Analysis artifact cacheKey');
  const gene = decodeIdentitySegment(parts[4], 'Analysis artifact gene');
  const pageId = decodeIdentitySegment(parts[5], 'Analysis artifact pageId');
  if (artifactChunkId({ cacheKey, gene, pageId }) !== exactId) {
    throw new TypeError('Analysis artifact chunk id must be canonical.');
  }
  return { cacheKey, gene, pageId };
}

function metadataFromArtifact(artifact) {
  return {
    kind: artifact.kind,
    cacheKey: artifact.cacheKey,
    gene: artifact.gene,
    pageId: artifact.pageId,
    pageName: artifact.pageName,
    cellCount: artifact.cellCount,
    timestamp: artifact.timestamp,
    geneCount: artifact.geneCount
  };
}

function encodeArtifactPayload(artifact) {
  const metadataBytes = new TextEncoder().encode(
    JSON.stringify(metadataFromArtifact(artifact))
  );
  const tableBytes = encodeTable({
    rowCount: artifact.cellCount,
    columns: [
      { name: 'cellIndex', dtype: 'uint32', data: artifact.cellIndices },
      { name: 'value', dtype: 'float32', data: artifact.values }
    ]
  });
  const payloadLength = U32_BYTES + metadataBytes.byteLength + tableBytes.byteLength;
  if (metadataBytes.byteLength > 0xffff_ffff || payloadLength > 0xffff_ffff) {
    throw new RangeError('Analysis artifact payload exceeds the unsigned 32-bit format limit.');
  }
  const payload = new Uint8Array(payloadLength);
  payload.set(u32ToBytesLE(metadataBytes.byteLength), 0);
  payload.set(metadataBytes, U32_BYTES);
  payload.set(tableBytes, U32_BYTES + metadataBytes.byteLength);
  return payload;
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function decodeArtifactPayload(payload) {
  if (!(payload instanceof Uint8Array) || payload.byteLength <= U32_BYTES) {
    throw new TypeError('Analysis artifact payload must be a nonempty Uint8Array envelope.');
  }
  const metadataLength = bytesToU32LE(payload.subarray(0, U32_BYTES));
  if (
    metadataLength === 0
    || U32_BYTES + metadataLength >= payload.byteLength
  ) {
    throw new Error('Analysis artifact metadata length is invalid.');
  }
  const metadataBytes = payload.subarray(U32_BYTES, U32_BYTES + metadataLength);
  let metadata;
  try {
    metadata = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes)
    );
  } catch (error) {
    throw new Error('Analysis artifact metadata is not valid canonical JSON.', {
      cause: error
    });
  }
  assertExactKeys(metadata, METADATA_KEYS, 'Analysis artifact metadata');
  const artifactMetadata = assertArtifactMetadata(
    metadata,
    'Analysis artifact metadata envelope'
  );
  const canonicalMetadataBytes = new TextEncoder().encode(
    JSON.stringify(metadataFromArtifact(artifactMetadata))
  );
  if (!bytesEqual(metadataBytes, canonicalMetadataBytes)) {
    throw new TypeError('Analysis artifact metadata JSON must use its canonical encoding.');
  }

  const table = decodeTable(payload.subarray(U32_BYTES + metadataLength));
  assertExactKeys(table, ['rowCount', 'columns', 'meta'], 'Analysis artifact table');
  assertExactKeys(
    table.columns,
    ['cellIndex', 'value'],
    'Analysis artifact table columns'
  );
  if (
    table.rowCount !== artifactMetadata.cellCount
    || table.meta.rowCount !== artifactMetadata.cellCount
    || table.meta.columns.length !== 2
  ) {
    throw new RangeError('Analysis artifact table row count must match metadata cellCount.');
  }
  const [cellIndexMeta, valueMeta] = table.meta.columns;
  if (
    cellIndexMeta.name !== 'cellIndex'
    || cellIndexMeta.dtype !== 'uint32'
    || cellIndexMeta.encoding !== 'raw'
    || cellIndexMeta.byteLength !== artifactMetadata.cellCount * 4
    || valueMeta.name !== 'value'
    || valueMeta.dtype !== 'float32'
    || valueMeta.encoding !== 'raw'
    || valueMeta.byteLength !== artifactMetadata.cellCount * 4
  ) {
    throw new TypeError(
      'Analysis artifact table must contain canonical cellIndex uint32 and value float32 columns.'
    );
  }
  if (!(table.columns.cellIndex instanceof Uint32Array)) {
    throw new TypeError('Analysis artifact cellIndex column must decode to Uint32Array.');
  }
  if (!(table.columns.value instanceof Float32Array)) {
    throw new TypeError('Analysis artifact value column must decode to Float32Array.');
  }
  return {
    ...artifactMetadata,
    values: table.columns.value,
    cellIndices: table.columns.cellIndex
  };
}

function assertChunkMeta(chunkMeta, payload) {
  assertExactKeys(chunkMeta, CHUNK_META_KEYS, 'Analysis artifact chunk metadata');
  const chunkId = assertNonEmptyString(
    chunkMeta.id,
    'Analysis artifact chunk metadata id'
  );
  if (chunkMeta.contributorId !== id) {
    throw new TypeError(`Analysis artifact contributorId must equal "${id}".`);
  }
  if (
    chunkMeta.priority !== 'lazy'
    || chunkMeta.kind !== 'binary'
    || chunkMeta.codec !== 'gzip'
    || chunkMeta.datasetDependent !== true
  ) {
    throw new TypeError(
      'Analysis artifact chunk must be lazy, binary, gzip, and dataset-dependent.'
    );
  }
  assertNonEmptyString(chunkMeta.label, 'Analysis artifact chunk metadata label');
  assertSafeInteger(chunkMeta.storedBytes, 'Analysis artifact storedBytes');
  const uncompressedBytes = assertSafeInteger(
    chunkMeta.uncompressedBytes,
    'Analysis artifact uncompressedBytes'
  );
  if (uncompressedBytes !== payload.byteLength) {
    throw new RangeError(
      'Analysis artifact payload length must equal metadata uncompressedBytes.'
    );
  }
  return chunkId;
}

/**
 * Capture every current bulk-gene cache artifact.
 *
 * @param {object} ctx
 * @returns {import('../session-serializer.js').SessionChunk[]}
 */
export function capture(ctx) {
  const dataLayer = requireDataLayer(ctx, 'exportSessionCache');
  const artifacts = assertArray(
    dataLayer.exportSessionCache(),
    'Analysis artifact export'
  );
  const chunks = [];
  const chunkIds = new Set();
  for (let index = 0; index < artifacts.length; index++) {
    const artifact = assertArtifact(
      artifacts[index],
      `Analysis artifact export ${index}`
    );
    const chunkId = artifactChunkId(artifact);
    if (chunkIds.has(chunkId)) {
      throw new TypeError(`Analysis artifact chunk id "${chunkId}" is duplicated.`);
    }
    chunkIds.add(chunkId);
    chunks.push({
      id: chunkId,
      contributorId: id,
      priority: 'lazy',
      kind: 'binary',
      codec: 'gzip',
      label: `Analysis cache: ${artifact.gene} (${artifact.pageName})`,
      datasetDependent: true,
      payload: encodeArtifactPayload(artifact)
    });
  }
  return chunks;
}

/**
 * Restore one current bulk-gene cache artifact.
 *
 * @param {object} ctx
 * @param {object} chunkMeta
 * @param {Uint8Array} payload
 */
export function restore(ctx, chunkMeta, payload) {
  const dataLayer = requireDataLayer(ctx, 'importSessionCache');
  if (!(payload instanceof Uint8Array)) {
    throw new TypeError('Analysis artifact payload must be a Uint8Array.');
  }
  const chunkId = assertChunkMeta(chunkMeta, payload);
  const identity = parseChunkIdentity(chunkId);
  const artifact = decodeArtifactPayload(payload);
  if (
    artifact.cacheKey !== identity.cacheKey
    || artifact.gene !== identity.gene
    || artifact.pageId !== identity.pageId
  ) {
    throw new TypeError('Analysis artifact payload identity must match its chunk id.');
  }
  const expectedLabel = `Analysis cache: ${artifact.gene} (${artifact.pageName})`;
  if (chunkMeta.label !== expectedLabel) {
    throw new TypeError('Analysis artifact chunk label must match its exact payload identity.');
  }
  const imported = dataLayer.importSessionCache(artifact);
  if (imported !== 1) {
    throw new Error('Analysis dataLayer importSessionCache() must apply exactly one artifact.');
  }
}
