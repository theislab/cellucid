/**
 * @fileoverview The gene sets a notebook pushed to the viewer (`setGeneSet`,
 * `registries/derived-results.js`).
 *
 * One eager JSON chunk, `gene-sets/notebook`: the sets in the order they were
 * pushed, each `{name, description, genes}`. It is written only when the
 * notebook pushed a set, and restoring a session without it leaves none. The
 * sets an analysis shows (markers, a gene signature's sets) are not stored
 * here: they come back with their analysis's result.
 *
 * @module session/contributors/gene-sets
 */

import { assertArray, assertNonEmptyString, requireMethod } from '../schema-contract.js';
import { requireExactKeys } from '../../../utils/exact-record.js';

export const id = 'gene-sets';

const CHUNK_ID = 'gene-sets/notebook';
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

function getRegistry(ctx, operation) {
  const state = ctx?.state;
  if (state === null || typeof state !== 'object') {
    throw new TypeError(`Gene set ${operation} requires the current DataState owner.`);
  }
  requireMethod(state, 'getDerivedResults', 'Gene set session owner');
  return state.getDerivedResults();
}

function assertGeneSets(payload) {
  assertArray(payload, 'Saved gene sets');
  for (const [index, set] of payload.entries()) {
    requireExactKeys(set, ['name', 'description', 'genes'], `Saved gene set ${index}`);
    assertNonEmptyString(set.name, `Saved gene set ${index} name`);
    if (typeof set.description !== 'string') throw new TypeError(`Saved gene set ${index} description must be text.`);
    assertArray(set.genes, `Saved gene set ${index} genes`);
    for (const gene of set.genes) assertNonEmptyString(gene, `Saved gene set ${index} gene`);
  }
  return payload;
}

export function capture(ctx) {
  const record = getRegistry(ctx, 'capture').toSessionRecord();
  if (record.length === 0) return [];
  return [{
    id: CHUNK_ID,
    contributorId: id,
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Notebook gene sets',
    datasetDependent: false,
    payload: assertGeneSets(record)
  }];
}

export function restore(ctx, chunkMeta, payload) {
  const registry = getRegistry(ctx, 'restore');
  requireExactKeys(chunkMeta, CHUNK_META_KEYS, 'Gene set chunk metadata');
  if (
    chunkMeta.id !== CHUNK_ID
    || chunkMeta.contributorId !== id
    || chunkMeta.priority !== 'eager'
    || chunkMeta.kind !== 'json'
    || chunkMeta.codec !== 'gzip'
    || chunkMeta.datasetDependent !== false
    || chunkMeta.label !== 'Notebook gene sets'
  ) {
    throw new TypeError(`Gene set chunk must be the eager, gzip JSON chunk "${CHUNK_ID}".`);
  }
  registry.restoreSessionRecord(assertGeneSets(payload));
}
