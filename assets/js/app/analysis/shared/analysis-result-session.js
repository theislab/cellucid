/**
 * Analysis results in a session: one envelope per result, and the checks a
 * restored result must pass against the open dataset.
 *
 * `exportResult()` of an analysis UI returns
 *
 *   { kind, version, payload }
 *
 * where `kind` names the analysis, `version` is the layout of `payload` for
 * that kind (`ANALYSIS_RESULT_VERSION`), and `payload` is the analysis's own
 * result encoded by `shared/analysis-result-codec.js`: JSON values plus typed
 * numeric arrays. Genes, observation fields and categories are named by key;
 * `importResult()` refuses a result that names one the open dataset lacks.
 *
 * @module shared/analysis-result-session
 */

import { decodeAnalysisResult, encodeAnalysisResult } from './analysis-result-codec.js';

/** Layout version of every analysis result payload written today. */
export const ANALYSIS_RESULT_VERSION = 2;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
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
 * Decode an envelope written for `kind`.
 *
 * @param {unknown} envelope
 * @param {string} kind
 * @returns {unknown} The decoded payload
 */
export function readResultEnvelope(envelope, kind) {
  if (!isPlainObject(envelope)) {
    throw new TypeError(`A ${kind} result must be an object`);
  }
  const keys = Object.keys(envelope).sort();
  if (keys.join(',') !== 'kind,payload,version') {
    throw new TypeError(`A ${kind} result must hold exactly kind, version and payload`);
  }
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
      `${label} names ${missing.length === 1 ? 'a gene' : `${missing.length} genes`} ` +
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
