/**
 * `uns['cellucid']`: what a Cellucid-ready AnnData file says about itself.
 *
 * A Cellucid-ready AnnData file is a standard AnnData file (anndata reads it)
 * that the Python package's `prepare()` or the R package's
 * `cellucid_prepare()` wrote for fast reading, with this mapping in `uns`:
 *
 * | key | value |
 * | --- | --- |
 * | `schema` | the integer 1 |
 * | `id` | the dataset's stable id: sessions and community annotations key on it |
 * | `name` | the name shown for the dataset |
 * | `description` | one paragraph about it |
 * | `citation` | `{text, url}`: how to cite it (`url` optional) |
 * | `source` | `{name, url}`: where the data comes from (`url` optional) |
 * | `defaults` | the launch defaults the dataset opens with (`requireAnnDataLaunchDefaults`) |
 * | `outlierQuantiles` | `{latentKey, minPoints, fields}`: every categorical obs field's outlier quantiles in that latent space, one float32 array per field (`data/latent-outliers.js`) |
 * | `history_applied` | the record of each saved history the Python or R package applied to the data (`apply_cellucid_session_to_anndata`, `cellucid_apply_session()`): JSON text; never read |
 * | `gene_sets` | the gene sets a package pulled from the viewer or wrote from an applied history, by name; never read |
 * | `pulled` | what each column a package's pull wrote came from, by column; never read |
 * | `totalCounts` | `{field, over}`: the obs field holding each cell's total count (its library size), `over` `'all genes'` (the writer's caller's column, before any gene was selected), `'source panel'` (the writer's caller's column, over every gene of the source's gene panel: more than the file stores, not the whole transcriptome) or `'stored genes'` (the sum of X's rows as written); a MuData's maps each modality to its own record, `field` named as the viewer shows it (`rna:total_counts`) |
 * | `priority` | `{seed, specVersion, nObs, levels}`: the file stores its cells in priority order (`anndata/priority-layout.js`): the subsampling specification's `uniform` rank under `seed`, `specVersion` that specification's version, `nObs` the cell count it was written with, `levels` the ascending prefix sizes `varm['cellucid_prefix_counts']` counts at |
 *
 * Every key is optional, and a file without `uns['cellucid']` opens exactly as
 * any AnnData file does. The packages keep their own records under the last
 * three keys on the AnnData a person works with, so that object opens again in
 * the viewer as it is (`show_anndata(adata)` after a pull or an apply). A key that is present must be exactly right, and a key
 * not in the table refuses the file, so a misspelt default never passes
 * unnoticed -- except `priority`, which is never checked here: the reader
 * verifies it against the file's cells, and a record that does not describe
 * them (a file subset, combined or reordered and saved again, or written by a
 * newer Cellucid) is not used, never refused (`readPriorityLayout`). The reader (`anndata/reader.js`) hands the mapping over as plain
 * JSON values; this module checks it.
 *
 * A text value may be stored as one value or as a one-element list (a writer
 * may store a single string as a length-1 array); a list value is a list.
 *
 * @module data/anndata-cellucid-metadata
 */

import { DataSourceErrorCode, explainedFailure } from './data-source.js';
import { isObjectRecord, requireObjectKeys } from '../utils/exact-record.js';

/** The one schema this viewer reads. */
export const CELLUCID_UNS_SCHEMA = 1;

/** The keys `uns['cellucid']` may hold (a copy's changes are checked against them, `anndata/write/copy.js`). */
export const CELLUCID_UNS_KEYS = Object.freeze([
  'schema', 'id', 'name', 'description', 'citation', 'source', 'defaults', 'outlierQuantiles', 'totalCounts', 'priority',
  'history_applied', 'gene_sets', 'pulled',
]);
const TOTAL_COUNTS_KEYS = Object.freeze(['field', 'over']);
/**
 * What a record of the cells' totals covers (`uns['cellucid']['totalCounts']['over']`): every gene
 * measured (`all genes`), every gene of the source's gene panel, more than the file stores but not
 * the whole transcriptome (`source panel`), or the genes the file stores (`stored genes`).
 */
export const TOTAL_COUNTS_OVER = Object.freeze(['all genes', 'source panel', 'stored genes']);
const OUTLIER_KEYS = Object.freeze(['latentKey', 'minPoints', 'fields']);
const CITATION_KEYS = Object.freeze(['text', 'url']);

/**
 * A dataset's citation as one line of text, as the methods paragraph, the
 * history report, a figure's provenance and the agents' `dataset_summary`
 * quote it: the open dataset's metadata `citation` (`{text, url}`, from
 * `uns['cellucid']` or the provider that served the file) — its text, then
 * its address unless the text already carries it. Null without a citation.
 * (A dataset's `source` is where the data comes from and never holds the
 * citation: the identity check refuses a citation inside the source.)
 *
 * @param {{text?: unknown, url?: unknown}|null|undefined} citation
 * @returns {string|null}
 */
export function citationText(citation) {
  const text = typeof citation?.text === 'string' ? citation.text.trim() : '';
  if (text === '') return null;
  const url = typeof citation.url === 'string' ? citation.url.trim() : '';
  return url === '' || text.includes(url) ? text : `${text} ${url}`;
}
const SOURCE_KEYS = Object.freeze(['name', 'url']);

/**
 * The portable id rule the writers apply to a dataset id: 1 to 180 ASCII
 * letters, digits, '.', '_' or '-', starting with a letter or digit and not
 * ending with '.'. It is also safe in every address the viewer builds from it.
 */
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/;

/**
 * Whether a dataset id follows the portable id rule (see `PORTABLE_ID`), as
 * `uns['cellucid']['id']` and a dataset catalog's ids must.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isPortableDatasetId(id) {
  return typeof id === 'string' && PORTABLE_ID.test(id) && !id.endsWith('.');
}

/** The portable id rule, as a refusal names it. */
export const PORTABLE_DATASET_ID_RULE =
  "1 to 180 ASCII letters, digits, '.', '_' or '-', starting with a letter or digit and not ending with '.'";

// Characters with no glyph: they would make a shown name differ from the
// stored one without anyone seeing why.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const INVISIBLE = /[\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/;

function describe(value) {
  return typeof value === 'string' ? `'${value}'` : JSON.stringify(value) ?? String(value);
}

/**
 * @param {string} message
 * @param {string} sourceType
 */
function refuse(message, sourceType) {
  return explainedFailure(
    `${message}. uns['cellucid'] is what a file says about itself for Cellucid; ` +
    'write it again with cellucid.prepare() in Python or cellucid_prepare() in R, or remove it.',
    DataSourceErrorCode.INVALID_FORMAT,
    sourceType
  );
}

function requireMetadataKeys(value, allowed, label, sourceType) {
  return requireObjectKeys(value, [], allowed, label, message => refuse(message.replace(/\.$/, ''), sourceType));
}

/** One value stored as itself or as a one-element list. */
function single(value) {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function requireText(value, label, sourceType, { allowEmpty = false } = {}) {
  const text = single(value);
  if (typeof text !== 'string' || (!allowEmpty && text.length === 0)) {
    throw refuse(`${label} must be ${allowEmpty ? 'text' : 'non-empty text'}; got ${describe(value)}`, sourceType);
  }
  if (text.length > 0 && text.trim() !== text) {
    throw refuse(`${label} must not start or end with white space; got ${describe(text)}`, sourceType);
  }
  if (CONTROL.test(text) || INVISIBLE.test(text)) {
    throw refuse(`${label} holds a character with no glyph, so it would not show as stored: ${describe(text)}`, sourceType);
  }
  return text;
}

/**
 * The white space prose loses at either end (the writers' and the reader's one
 * set: ASCII white space, the Unicode space separators, the line and paragraph
 * separators and the byte order mark). cellucid-python `_contracts.PROSE_EDGE`,
 * cellucid-r `.prose_edge_pattern`.
 */
const PROSE_EDGE = /^[\t\n\v\f\r\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\v\f\r\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$/g;

/**
 * Descriptive text (`name`, `description`, citation text, source name): read
 * trimmed, as the writers write it, never refused for a space at either end
 * -- a paragraph typed by hand often ends in one. Identifiers (`id`, keys,
 * fields) keep `requireText`'s strict rule. What remains is checked as any
 * text is: drawable as stored.
 */
export function proseText(text) {
  return text.replace(PROSE_EDGE, '');
}

/**
 * The descriptive text of a `uns['cellucid']` record as a writer writes it:
 * `name`, `description`, `citation.text`, `source.name` trimmed (`proseText`),
 * every other key as given. A fresh record; the caller's is not changed.
 *
 * @param {Record<string, unknown>} record
 * @returns {Record<string, unknown>}
 */
export function withProseTrimmed(record) {
  const out = { ...record };
  for (const key of ['name', 'description']) if (typeof out[key] === 'string') out[key] = proseText(out[key]);
  for (const [key, field] of [['citation', 'text'], ['source', 'name']]) {
    const linked = out[key];
    if (linked !== null && typeof linked === 'object' && !Array.isArray(linked) && typeof linked[field] === 'string') {
      out[key] = { ...linked, [field]: proseText(linked[field]) };
    }
  }
  return out;
}

function requireProse(value, label, sourceType, { allowEmpty = false } = {}) {
  const text = single(value);
  return requireText(typeof text === 'string' ? proseText(text) : value, label, sourceType, { allowEmpty });
}

function requireUrl(value, label, sourceType) {
  const text = requireText(value, label, sourceType);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw refuse(`${label} must be an absolute http(s) address; got ${describe(text)}`, sourceType);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw refuse(`${label} must be an absolute http(s) address; got ${describe(text)}`, sourceType);
  }
  return text;
}

/**
 * Normalize the launch defaults as stored to the values
 * `requireAnnDataLaunchDefaults` checks: a text default stored as a
 * one-element list is its text, and a `{key, columns}` embedding default keeps
 * its column list.
 */
function launchDefaultsOf(value, sourceType) {
  if (!isObjectRecord(value)) throw refuse(`uns['cellucid']['defaults'] must be a mapping; got ${describe(value)}`, sourceType);
  const defaults = {};
  for (const [key, stored] of Object.entries(value)) {
    if (key === 'obsKeys') {
      defaults[key] = stored;
    } else if (/^embedding[123]d$/.test(key) && isObjectRecord(stored)) {
      defaults[key] = {
        ...stored,
        ...(Object.hasOwn(stored, 'key') ? { key: single(stored.key) } : {}),
      };
    } else {
      defaults[key] = single(stored);
    }
  }
  return defaults;
}

/**
 * `outlierQuantiles` as the reader describes it (`describeStoredOutlierQuantiles`):
 * the latent space and rule they were written for, and one float32 vector
 * per field. Their values are read when a field's outlier filter is used.
 */
function storedOutlierQuantilesOf(value, sourceType) {
  const label = "uns['cellucid']['outlierQuantiles']";
  requireMetadataKeys(value, OUTLIER_KEYS, label, sourceType);
  for (const key of OUTLIER_KEYS) {
    if (value[key] === undefined) throw refuse(`${label} must hold '${key}'`, sourceType);
  }
  const latentKey = requireText(value.latentKey, `${label}['latentKey']`, sourceType);
  const minPoints = single(value.minPoints);
  if (!Number.isSafeInteger(minPoints) || minPoints < 1) {
    throw refuse(`${label}['minPoints'] must be a positive integer; got ${describe(value.minPoints)}`, sourceType);
  }
  if (!isObjectRecord(value.fields)) throw refuse(`${label}['fields'] must be a mapping`, sourceType);
  const fields = new Map();
  for (const [key, array] of Object.entries(value.fields)) {
    if (array?.dtype !== 'float32' || !Array.isArray(array.shape) || array.shape.length !== 1) {
      throw refuse(`${label}['fields']['${key}'] must be a vector of float32 values, one per cell`, sourceType);
    }
    fields.set(key, array.shape[0]);
  }
  return Object.freeze({ latentKey, minPoints, fields });
}

function totalCountsRecordOf(value, label, sourceType) {
  requireMetadataKeys(value, TOTAL_COUNTS_KEYS, label, sourceType);
  for (const key of TOTAL_COUNTS_KEYS) {
    if (value[key] === undefined) throw refuse(`${label} must hold '${key}'`, sourceType);
  }
  const field = requireText(value.field, `${label}['field']`, sourceType);
  const over = requireText(value.over, `${label}['over']`, sourceType);
  if (!TOTAL_COUNTS_OVER.includes(over)) {
    const allowed = TOTAL_COUNTS_OVER.map(describe);
    throw refuse(`${label}['over'] must be ${allowed.slice(0, -1).join(', ')} or ${allowed.at(-1)}; got ${describe(over)}`, sourceType);
  }
  return Object.freeze({ field, over });
}

/**
 * `totalCounts`: each matrix's record of its cells' totals, by modality (null
 * for an AnnData's one `X`). Which obs field holds them is checked when the
 * fields are known (`data/library-sizes.js`), not here.
 */
function totalCountsOf(value, sourceType) {
  const label = "uns['cellucid']['totalCounts']";
  if (!isObjectRecord(value)) throw refuse(`${label} must be a mapping; got ${describe(value)}`, sourceType);
  if (Object.hasOwn(value, 'field')) return new Map([[null, totalCountsRecordOf(value, label, sourceType)]]);
  const records = new Map();
  for (const [modality, record] of Object.entries(value)) {
    if (!isObjectRecord(record)) throw refuse(`${label}['${modality}'] must be a mapping {field, over}; got ${describe(record)}`, sourceType);
    records.set(modality, totalCountsRecordOf(record, `${label}['${modality}']`, sourceType));
  }
  return records;
}

/**
 * @typedef {Object} CellucidFileMetadata
 * @property {string|null} id
 * @property {string|null} name
 * @property {string|null} description
 * @property {{text: string, url: string|null}|null} citation
 * @property {{name: string, url: string|null}|null} source
 * @property {Object} defaults - Launch defaults as stored, normalized; the
 *   adapter checks them with `requireAnnDataLaunchDefaults`
 * @property {StoredOutlierQuantiles|null} outlierQuantiles - What the file
 *   stores of outlier quantiles, described (no values are read at open)
 * @property {ReadonlyMap<string|null, {field: string, over: 'all genes'|'source panel'|'stored genes'}>|null} totalCounts -
 *   The record of each matrix's cell totals, by modality (null: an AnnData's X)
 */

/**
 * @typedef {Object} StoredOutlierQuantiles
 * @property {string} latentKey - The `obsm` key they were computed in
 * @property {number} minPoints - The fewest cells a category needed to get them
 * @property {ReadonlyMap<string, number>} fields - Each obs field that has
 *   them, with its array's length (one value per cell when it matches the file)
 */

/**
 * Check `uns['cellucid']` as the reader read it.
 *
 * @param {unknown} value - The mapping as plain JSON values, or null when the
 *   file has none
 * @param {string} sourceType - The data source type, for errors
 * @returns {Readonly<CellucidFileMetadata>}
 */
export function requireCellucidFileMetadata(value, sourceType) {
  const empty = { id: null, name: null, description: null, citation: null, source: null, defaults: {}, outlierQuantiles: null, totalCounts: null };
  if (value === null) return Object.freeze(empty);
  requireMetadataKeys(value, CELLUCID_UNS_KEYS, "uns['cellucid']", sourceType);
  if (Object.hasOwn(value, 'schema')) {
    const schema = single(value.schema);
    if (schema !== CELLUCID_UNS_SCHEMA) {
      throw refuse(
        `uns['cellucid']['schema'] is ${describe(value.schema)}; this viewer reads schema ${CELLUCID_UNS_SCHEMA}` +
        (Number.isSafeInteger(schema) && schema > CELLUCID_UNS_SCHEMA ? ', so open the file in a newer Cellucid' : ''),
        sourceType
      );
    }
  }
  const metadata = { ...empty };
  if (Object.hasOwn(value, 'id')) {
    const id = requireText(value.id, "uns['cellucid']['id']", sourceType);
    if (!isPortableDatasetId(id)) {
      throw refuse(`uns['cellucid']['id'] ${describe(id)} must be ${PORTABLE_DATASET_ID_RULE}`, sourceType);
    }
    metadata.id = id;
  }
  if (Object.hasOwn(value, 'name')) metadata.name = requireProse(value.name, "uns['cellucid']['name']", sourceType);
  if (Object.hasOwn(value, 'description')) {
    metadata.description = requireProse(value.description, "uns['cellucid']['description']", sourceType, { allowEmpty: true });
  }
  if (Object.hasOwn(value, 'citation')) {
    const citation = requireMetadataKeys(value.citation, CITATION_KEYS, "uns['cellucid']['citation']", sourceType);
    metadata.citation = Object.freeze({
      text: requireProse(citation.text, "uns['cellucid']['citation']['text']", sourceType),
      url: Object.hasOwn(citation, 'url') ? requireUrl(citation.url, "uns['cellucid']['citation']['url']", sourceType) : null,
    });
  }
  if (Object.hasOwn(value, 'source')) {
    const source = requireMetadataKeys(value.source, SOURCE_KEYS, "uns['cellucid']['source']", sourceType);
    metadata.source = Object.freeze({
      name: requireProse(source.name, "uns['cellucid']['source']['name']", sourceType),
      url: Object.hasOwn(source, 'url') ? requireUrl(source.url, "uns['cellucid']['source']['url']", sourceType) : null,
    });
  }
  if (Object.hasOwn(value, 'defaults')) metadata.defaults = launchDefaultsOf(value.defaults, sourceType);
  if (Object.hasOwn(value, 'outlierQuantiles')) {
    metadata.outlierQuantiles = storedOutlierQuantilesOf(value.outlierQuantiles, sourceType);
  }
  if (Object.hasOwn(value, 'totalCounts')) metadata.totalCounts = totalCountsOf(value.totalCounts, sourceType);
  return Object.freeze(metadata);
}
