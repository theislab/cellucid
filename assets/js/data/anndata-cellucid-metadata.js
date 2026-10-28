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
 * | `session` | the record of a session applied to the file in Python; never read |
 * | `priority` | `{seed, specVersion, nObs, levels}`: the file stores its cells in priority order (`anndata/priority-layout.js`): the subsampling specification's `uniform` rank under `seed`, `specVersion` that specification's version, `nObs` the cell count it was written with, `levels` the ascending prefix sizes `varm['cellucid_prefix_counts']` counts at |
 *
 * Every key is optional, and a file without `uns['cellucid']` opens exactly as
 * any AnnData file does. A key that is present must be exactly right, and a key
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

const KEYS = Object.freeze(['schema', 'id', 'name', 'description', 'citation', 'source', 'defaults', 'outlierQuantiles', 'session', 'priority']);
const OUTLIER_KEYS = Object.freeze(['latentKey', 'minPoints', 'fields']);
const CITATION_KEYS = Object.freeze(['text', 'url']);
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
 * Normalise the launch defaults as stored to the values
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

/**
 * @typedef {Object} CellucidFileMetadata
 * @property {string|null} id
 * @property {string|null} name
 * @property {string|null} description
 * @property {{text: string, url: string|null}|null} citation
 * @property {{name: string, url: string|null}|null} source
 * @property {Object} defaults - Launch defaults as stored, normalised; the
 *   adapter checks them with `requireAnnDataLaunchDefaults`
 * @property {StoredOutlierQuantiles|null} outlierQuantiles - What the file
 *   stores of outlier quantiles, described (no values are read at open)
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
  const empty = { id: null, name: null, description: null, citation: null, source: null, defaults: {}, outlierQuantiles: null };
  if (value === null) return Object.freeze(empty);
  requireMetadataKeys(value, KEYS, "uns['cellucid']", sourceType);
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
  if (Object.hasOwn(value, 'name')) metadata.name = requireText(value.name, "uns['cellucid']['name']", sourceType);
  if (Object.hasOwn(value, 'description')) {
    metadata.description = requireText(value.description, "uns['cellucid']['description']", sourceType, { allowEmpty: true });
  }
  if (Object.hasOwn(value, 'citation')) {
    const citation = requireMetadataKeys(value.citation, CITATION_KEYS, "uns['cellucid']['citation']", sourceType);
    metadata.citation = Object.freeze({
      text: requireText(citation.text, "uns['cellucid']['citation']['text']", sourceType),
      url: Object.hasOwn(citation, 'url') ? requireUrl(citation.url, "uns['cellucid']['citation']['url']", sourceType) : null,
    });
  }
  if (Object.hasOwn(value, 'source')) {
    const source = requireMetadataKeys(value.source, SOURCE_KEYS, "uns['cellucid']['source']", sourceType);
    metadata.source = Object.freeze({
      name: requireText(source.name, "uns['cellucid']['source']['name']", sourceType),
      url: Object.hasOwn(source, 'url') ? requireUrl(source.url, "uns['cellucid']['source']['url']", sourceType) : null,
    });
  }
  if (Object.hasOwn(value, 'defaults')) metadata.defaults = launchDefaultsOf(value.defaults, sourceType);
  if (Object.hasOwn(value, 'outlierQuantiles')) {
    metadata.outlierQuantiles = storedOutlierQuantilesOf(value.outlierQuantiles, sourceType);
  }
  return Object.freeze(metadata);
}
