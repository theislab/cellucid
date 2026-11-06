/**
 * Analysis results in a session: one envelope per result, and the checks a
 * restored result must pass against the open dataset.
 *
 * `exportResult()` of an analysis UI returns
 *
 *   { kind, version, payload, provenance }
 *
 * where `kind` names the analysis, `version` is the layout of `payload` for
 * that kind (`ANALYSIS_RESULT_VERSION`), `payload` is the analysis's own
 * result encoded by `shared/analysis-result-codec.js` (JSON values plus typed
 * numeric arrays), and `provenance` is what it was computed on
 * (`shared/result-provenance.js`), so a restored result is current or stale
 * as it is against the page it is restored on. Genes, observation fields and
 * categories are named by key; `importResult()` refuses a result that names
 * one the open dataset lacks.
 *
 * A result **left out** of a shared session (Share › Results: compute again
 * on open, `session/share-scope.js`) is `{kind, leftOut: true, provenance}`:
 * the envelope without its payload, so it stays apart from an analysis that
 * never ran, and keeps what it was computed on. An analysis restored with
 * one shows its settings and no result (`importLeftOutResult`) and gives
 * the same record back until it has a result again; opening the file runs
 * it again (`session/recompute-results.js`).
 *
 * @module shared/analysis-result-session
 */

import { decodeAnalysisResult, encodeAnalysisResult } from './analysis-result-codec.js';
import { isPlainRecord } from '../../../utils/exact-record.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { requireProvenance } from './result-provenance.js';

/** Layout version of every analysis result payload written today. */
export const ANALYSIS_RESULT_VERSION = 2;

/**
 * The result part of an envelope (the analysis UI adds its provenance,
 * `FormBasedAnalysisUI.exportResult`).
 *
 * @param {string} kind
 * @param {unknown} payload - The plain result value to encode
 * @returns {{kind: string, version: number, payload: unknown}}
 */
export function createResultEnvelope(kind, payload) {
  return {
    kind,
    version: ANALYSIS_RESULT_VERSION,
    payload: encodeAnalysisResult(payload, `${kind} result`)
  };
}

/**
 * Decode an envelope written for `kind`; its provenance is checked here and
 * handed to `_restoreAnalysisResult` by the caller (`envelope.provenance`).
 *
 * @param {unknown} envelope
 * @param {string} kind
 * @returns {unknown} The decoded payload
 */
export function readResultEnvelope(envelope, kind) {
  if (!isPlainRecord(envelope)) {
    throw new TypeError(`A ${kind} result must be an object`);
  }
  const keys = Object.keys(envelope).sort();
  if (keys.join(',') !== 'kind,payload,provenance,version') {
    throw new TypeError(`A ${kind} result must hold exactly kind, version, payload and provenance`);
  }
  requireProvenance(envelope.provenance, `${kind} result provenance`);
  if (envelope.kind !== kind) {
    throw new TypeError(
      `A ${String(envelope.kind)} result cannot be restored into the ${kind} analysis`
    );
  }
  if (envelope.version !== ANALYSIS_RESULT_VERSION) {
    throw new RangeError(
      `${kind} result version ${String(envelope.version)} is not one this version reads ` +
      `(expected ${ANALYSIS_RESULT_VERSION})`
    );
  }
  return decodeAnalysisResult(envelope.payload, `${kind} result`);
}

/**
 * The record of a result left out of a shared session: `envelope` without
 * its payload (null, and a record already left out, as they are).
 *
 * @param {null|{kind: string, provenance?: object}} envelope
 * @returns {null|{kind: string, leftOut: true, provenance: object|null}}
 */
export function leftOutResultOf(envelope) {
  if (envelope === null || isLeftOutResult(envelope)) return envelope;
  return { kind: envelope.kind, leftOut: true, provenance: envelope.provenance ?? null };
}

/**
 * Whether a session's result is the record of one left out
 * (`leftOutResultOf`): exactly `kind`, `leftOut: true` and `provenance`.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isLeftOutResult(value) {
  return isPlainRecord(value) && value.leftOut === true && typeof value.kind === 'string'
    && Object.keys(value).sort().join(',') === 'kind,leftOut,provenance';
}

function missingList(missing) {
  const shown = missing.slice(0, 5).map(name => `"${name}"`).join(', ');
  return missing.length > 5 ? `${shown} and ${missing.length - 5} more` : shown;
}

/**
 * Throw unless every gene exists in the open dataset: in the expression
 * matrix the result was read from (`DataLayer.getGeneKeys`), the mapped one
 * by default.
 *
 * @param {{getGeneKeys: Function}} dataLayer
 * @param {Iterable<string>} genes
 * @param {string} label
 * @param {string} [matrix='mapped']
 * @returns {Promise<void>}
 */
export async function requireDatasetGenes(dataLayer, genes, label, matrix = 'mapped') {
  const known = new Set(await dataLayer.getGeneKeys(matrix));
  const missing = [];
  for (const gene of new Set(genes)) {
    if (typeof gene !== 'string' || !known.has(gene)) {
      missing.push(String(gene));
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${label} names ${missing.length === 1 ? 'a gene' : `${formatCountOf(missing.length, 'gene')}`} ` +
      `the open dataset lacks: ${missingList(missing)}`
    );
  }
}

/**
 * Throw unless the variable exists in the open dataset.
 *
 * @param {{getVariableInfo: Function}} dataLayer
 * @param {string} type - 'gene_expression' | 'categorical_obs' | 'continuous_obs'
 * @param {string} key
 * @param {string} label
 * @returns {Object} The variable's info
 */
export function requireDatasetVariable(dataLayer, type, key, label) {
  const info = typeof key === 'string' && key.length > 0
    ? dataLayer.getVariableInfo(type, key)
    : null;
  if (info === null || info === undefined) {
    const what = type === 'gene_expression' ? 'gene' : 'field';
    throw new Error(`${label} names the ${what} "${String(key)}", which the open dataset lacks`);
  }
  return info;
}

/**
 * Throw unless every page exists.
 *
 * @param {{getPageInfo: Function}} dataLayer
 * @param {Iterable<string>} pageIds
 * @param {string} label
 */
export function requireDatasetPages(dataLayer, pageIds, label) {
  const missing = [];
  for (const pageId of new Set(pageIds)) {
    if (typeof pageId !== 'string' || dataLayer.getPageInfo(pageId) === null) {
      missing.push(String(pageId));
    }
  }
  if (missing.length > 0) {
    throw new Error(`${label} names cell groups that do not exist: ${missingList(missing)}`);
  }
}
