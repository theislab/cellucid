/**
 * @fileoverview What a session says about its dataset, and how it is
 * checked: the dataset fingerprint (identity, counts, cell-order digest,
 * data mapping: `getDatasetFingerprint`, `verifySessionFingerprint`), the
 * fields its state uses (`collectRequiredFields`,
 * `describeMissingRequiredFields`), and the refusals that name what differs.
 * Session files (`history-file.js`) and saved states (`app/history/autosave.js`)
 * carry them in their header.
 *
 * @module session/session-context
 */

import { captureViewFilters } from '../state/domains/filters.js';
import { captureViewColors } from '../state/domains/colors.js';
import { captureViewActiveField } from '../state/domains/active-field.js';
import { fieldRef } from '../state/domains/fields.js';
import {
  assertNonEmptyString,
  assertNullableString,
  assertSafeInteger,
  requireMethod,
} from './schema-contract.js';
import {
  compareEmbeddingRefs,
  validateDataMapping,
  validateEmbeddingRef
} from '../../data/data-mapping.js';
import {
  describeEmbeddingRef,
  layoutEmbeddingRef,
  describeMappingGroupValue,
  MAPPING_GROUP_LABELS,
  resolveEmbeddingRefLayout,
  UNCHANGEABLE_GROUP_CLAUSE,
} from '../../data/dataset-mapping.js';
import { sameJson } from '../utils/same-json.js';
import { requireExactKeys, requirePlainRecord } from '../../utils/exact-record.js';
import { formatCountOf, countNoun } from '../../utils/format-units.js';

/**
 * The dataset fields a session uses: every observation field and gene that a
 * view shows or filters on, or that a highlight group is bound to, by the key
 * the dataset gives it (a field renamed in the session is listed by its
 * original key). Fields the session creates itself are not listed. Recorded as
 * the manifest's `requires`, so a dataset missing any of them is refused before
 * anything is applied, naming every missing key at once.
 *
 * @param {object} state
 * @returns {{obs: string[], var: string[]}}
 */
export function collectRequiredFields(state) {
  const required = { obs: new Set(), var: new Set() };
  // A user field (`{source, user}`) is made by the session itself.
  const add = ref => {
    if (ref !== null && ref.key !== undefined) required[ref.source].add(ref.key);
  };
  // The focused view's state is the top level; every other view's is parked
  // in its context. Each names its fields as its domain values do.
  const visit = owner => {
    for (const entry of captureViewFilters(owner)) add(entry.field);
    for (const entry of captureViewColors(owner)) add(entry.field);
    add(captureViewActiveField(owner));
  };
  visit(state);
  const activeViewId = state.getActiveViewId();
  if (state.viewContexts instanceof Map) {
    for (const [viewId, context] of state.viewContexts) {
      if (viewId !== activeViewId) visit(context);
    }
  }
  for (const page of state.getHighlightPages?.() ?? []) {
    for (const group of page.highlightedGroups ?? []) {
      if (typeof group.fieldKey !== 'string') continue;
      const source = group.fieldSource === 'var' ? 'var' : 'obs';
      const field = (source === 'var' ? state.varData?.fields : state.obsData?.fields)?.[group.fieldIndex] ?? null;
      if (field !== null && typeof field === 'object') add(fieldRef(field, source));
    }
  }
  return { obs: [...required.obs].sort(), var: [...required.var].sort() };
}

/**
 * Validate a manifest's `requires` record (untrusted input).
 * @param {unknown} value
 * @param {string} context
 * @returns {{obs: string[], var: string[]}}
 */
export function assertSessionRequires(value, context) {
  requireExactKeys(value, ['obs', 'var'], context);
  for (const source of ['obs', 'var']) {
    const keys = value[source];
    if (!Array.isArray(keys)) {
      throw new TypeError(`${context} ${source} must be an array of field keys.`);
    }
    for (let index = 0; index < keys.length; index++) {
      assertNonEmptyString(keys[index], `${context} ${source}[${index}]`);
      if (index > 0 && !(keys[index - 1] < keys[index])) {
        throw new TypeError(`${context} ${source} must be sorted and without duplicates.`);
      }
    }
  }
  return value;
}

function quoteKeys(keys) {
  return keys.map(key => `"${key}"`).join(', ');
}

/**
 * The refusal naming every field a session uses that the open dataset lacks,
 * or null when it has them all.
 *
 * @param {object} state
 * @param {{obs: string[], var: string[]}} requires
 * @returns {string|null}
 */
export function describeMissingRequiredFields(state, requires) {
  const keysOf = data => new Set(
    (Array.isArray(data?.fields) ? data.fields : [])
      .filter(field => field?._isUserDefined !== true)
      .map(field => field._originalKey ?? field.key)
  );
  const obsKeys = keysOf(state.obsData);
  const varKeys = keysOf(state.varData);
  const missingObs = requires.obs.filter(key => !obsKeys.has(key));
  const missingVar = requires.var.filter(key => !varKeys.has(key));
  if (missingObs.length === 0 && missingVar.length === 0) return null;
  const parts = [];
  if (missingObs.length > 0) {
    parts.push(`the observation ${countNoun(missingObs.length, 'field')} ${quoteKeys(missingObs)}`);
  }
  if (missingVar.length > 0) {
    parts.push(`the ${countNoun(missingVar.length, 'gene')} ${quoteKeys(missingVar)}`);
  }
  return (
    `This session uses ${parts.join(' and ')}, which the dataset that is open `
    + 'now does not have. The session was not opened. Open the dataset the '
    + 'session was saved on, then load the session again.'
  );
}

/**
 * The dataset a session belongs to, whatever it was opened from: its identity
 * id (the id its file states in `uns['cellucid']['id']`, else the one its
 * source gives it), its
 * counts, the digest of its cells' coordinates, and its data mapping. The
 * cell-order digest is what proves two copies hold the same cells at the
 * same coordinates, so a session saved on one host applies to the same
 * dataset opened from another.
 */
const DATASET_FINGERPRINT_KEYS = Object.freeze([
  'datasetId',
  'name',
  'cellCount',
  'varCount',
  'cellOrder',
  'dataMapping'
]);

function assertCellOrder(value, context) {
  requireExactKeys(value, ['embedding', 'dimension', 'digest'], context);
  const dimension = assertSafeInteger(
    value.dimension,
    `${context} dimension`,
    { minimum: 1, maximum: 3 }
  );
  const digest = assertNonEmptyString(value.digest, `${context} digest`);
  if (!/^[0-9a-f]{16}$/.test(digest)) {
    throw new TypeError(
      `${context} digest must be 16 lowercase hexadecimal characters.`
    );
  }
  try {
    validateEmbeddingRef(value.embedding, {
      dimension,
      label: `${context} embedding`,
    });
  } catch (error) {
    throw new TypeError(error.message, { cause: error });
  }
  return value;
}

/**
 * Validate one complete dataset fingerprint record from untrusted input.
 *
 * A file without the session signature never reaches this check: it is
 * refused first (`bundle/format.js`). A record that is malformed
 * in any way is a schema violation.
 *
 * @param {any} value
 * @param {string} context
 * @returns {object}
 */
export function assertDatasetFingerprint(value, context) {
  requireExactKeys(value, DATASET_FINGERPRINT_KEYS, context);
  assertNullableString(value.datasetId, `${context} datasetId`);
  assertNullableString(value.name, `${context} name`);
  assertSafeInteger(value.cellCount, `${context} cellCount`);
  assertSafeInteger(value.varCount, `${context} varCount`);
  let mapping;
  try {
    mapping = validateDataMapping(value.dataMapping, {
      label: `${context} dataMapping`,
    });
  } catch (error) {
    throw new TypeError(error.message, { cause: error });
  }
  if (JSON.stringify(mapping) !== JSON.stringify(value.dataMapping)) {
    throw new TypeError(`${context} dataMapping must be in canonical form.`);
  }
  assertCellOrder(value.cellOrder, `${context} cellOrder`);
  return value;
}

function requireCurrentDataMapping(state) {
  const mapping = requireMethod(
    state,
    'getDataMapping',
    'Dataset fingerprint DataState'
  ).call(state);
  if (mapping === null) {
    throw new TypeError('Dataset fingerprint requires the loaded data mapping.');
  }
  return mapping;
}

function currentFingerprintScalars(ctx) {
  requirePlainRecord(ctx, 'Session context');
  if (ctx.state === null || typeof ctx.state !== 'object') {
    throw new TypeError('Dataset fingerprint requires the current DataState.');
  }
  const manager = ctx.dataSourceManager;
  let datasetId = null;
  let name = null;
  if (manager !== null) {
    // The identity id, not the route's own id: a local copy of a published
    // dataset is the same dataset (`local-user:<id>` is only the route's key).
    requireMethod(manager, 'getCurrentIdentityId', 'Dataset fingerprint manager');
    datasetId = assertNullableString(
      manager.getCurrentIdentityId(),
      'Dataset fingerprint datasetId'
    );
    // The name the dataset gives itself, for the messages that ask the person
    // to open it; it is not part of the identity.
    const metadataName = manager.getCurrentMetadata?.()?.name;
    name = typeof metadataName === 'string' && metadataName.trim() !== ''
      ? metadataName.trim()
      : null;
  }
  const cellCount = assertSafeInteger(
    ctx.state.pointCount,
    'Dataset fingerprint cellCount'
  );
  if (
    ctx.state.varData === null
    || typeof ctx.state.varData !== 'object'
    || !Array.isArray(ctx.state.varData.fields)
  ) {
    throw new TypeError('Dataset fingerprint requires the current var field inventory.');
  }
  // The gene count describes the dataset, so it counts only the source's own
  // var fields. User-defined fields (a duplicated gene, a derived field) are
  // session content restored from the session itself; counting them would
  // make the session refuse the very dataset it was saved on.
  let sourceVarFieldCount = 0;
  for (const field of ctx.state.varData.fields) {
    if (field?._isUserDefined !== true) sourceVarFieldCount += 1;
  }
  const varCount = assertSafeInteger(
    sourceVarFieldCount,
    'Dataset fingerprint varCount'
  );
  return { datasetId, name, cellCount, varCount };
}

/**
 * The current dataset fingerprint without its cell-order digest, and the
 * layout the digest is taken over: the one the live view shows, which
 * `cellOrder.embedding` names under the dataset's data mapping. @private
 */
function describeCurrentFingerprint(ctx) {
  const scalars = currentFingerprintScalars(ctx);
  const state = ctx.state;
  const dataMapping = requireCurrentDataMapping(state);
  const positions = state.positionsArray;
  const dimension = assertSafeInteger(
    requireMethod(
      state,
      'getViewDimensionLevel',
      'Dataset fingerprint DataState'
    ).call(state, 'live'),
    'Dataset fingerprint live dimension',
    { minimum: 1, maximum: 3 }
  );
  if (
    !(positions instanceof Float32Array)
    || positions.length !== scalars.cellCount * dimension
  ) {
    throw new TypeError(
      'Dataset fingerprint requires the exact live dataset positions in the live view dimension.'
    );
  }
  const layoutKey = requireMethod(
    state,
    'getViewLayoutKey',
    'Dataset fingerprint DataState'
  ).call(state, 'live');
  const embedding = layoutEmbeddingRef(state.dimensionManager, layoutKey);
  return { scalars, dataMapping, embedding, dimension, layoutKey };
}

/**
 * Create the exact current dataset fingerprint.
 *
 * All five fields are mandatory; the dataset id may be explicitly null only
 * when no data-source manager owns the loaded state. The cell-order digest is
 * taken over the stored values of the embedding the live view shows, each
 * open cell named by its original position (`data/cell-order-digest.js`),
 * and `cellOrder.embedding` names that embedding under the dataset's data
 * mapping. The reader worker summed the values as it read them, so this
 * folds nothing on the page.
 *
 * @param {object} ctx
 * @returns {Promise<{
 *   datasetId: string|null,
 *   cellCount: number,
 *   varCount: number,
 *   cellOrder: { embedding: {key: string, columns: number[]}, dimension: number, digest: string },
 *   dataMapping: object
 * }>}
 */
export async function getDatasetFingerprint(ctx) {
  const { scalars, dataMapping, embedding, dimension, layoutKey } = describeCurrentFingerprint(ctx);
  const dimensionManager = ctx.state.dimensionManager;
  const digest = await requireMethod(
    dimensionManager,
    'getCellOrderDigest',
    'Dataset fingerprint DimensionManager'
  ).call(dimensionManager, layoutKey);
  return {
    ...scalars,
    cellOrder: Object.freeze({
      embedding: Object.freeze(embedding),
      dimension,
      digest
    }),
    dataMapping
  };
}

/**
 * Whether `fingerprint` (taken with `getDatasetFingerprint`) still names the
 * open dataset: every field but the digest compared with the current ones.
 * The digest is a function of the cells open and the embedding shown, so
 * while those and the dataset generation stand, it stands too.
 *
 * @param {object} ctx
 * @param {object} fingerprint
 * @returns {boolean}
 */
export function datasetFingerprintStillCurrent(ctx, fingerprint) {
  const { scalars, dataMapping, embedding, dimension } = describeCurrentFingerprint(ctx);
  return datasetFingerprintMatches(fingerprint, {
    ...scalars,
    cellOrder: { embedding, dimension, digest: fingerprint.cellOrder.digest },
    dataMapping
  });
}

/**
 * Compare two dataset fingerprints.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
export function datasetFingerprintMatches(a, b) {
  assertDatasetFingerprint(a, 'Saved dataset fingerprint');
  assertDatasetFingerprint(b, 'Current dataset fingerprint');
  return (
    a.datasetId === b.datasetId
    && a.cellCount === b.cellCount
    && a.varCount === b.varCount
    && sameJson(a.cellOrder.embedding, b.cellOrder.embedding)
    && a.cellOrder.dimension === b.cellOrder.dimension
    && a.cellOrder.digest === b.cellOrder.digest
    && sameJson(a.dataMapping, b.dataMapping)
  );
}

/**
 * Name one side of an identity mismatch the way the person reading it would:
 * by the name the Dataset box shows for it, quoted, never by its identity id
 * (an internal key: a link's is its encoded address); null when the dataset
 * gave no name.
 *
 * @param {{name?: string|null}} fingerprint
 * @returns {string|null}
 */
function describeDatasetIdentity(fingerprint) {
  return typeof fingerprint.name === 'string' && fingerprint.name !== '' ? `"${fingerprint.name}"` : null;
}

/** Where a session was saved, against what is open, when both have the same counts. */
function describeOtherDataset(saved, current) {
  const savedName = describeDatasetIdentity(saved);
  const currentName = describeDatasetIdentity(current);
  if (savedName !== null && savedName === currentName) {
    return `another dataset also called ${savedName} than the one open now`;
  }
  return `${savedName ?? 'another dataset'} and ${currentName ?? 'another one'} is open now`;
}

/** The mapping groups read within the modality, and on the var axis of the matrix, of their mapping. */
const EXPRESSION_CONTEXT_GROUPS = new Set(['expression', 'geneNames', 'log1p', 'highlyVariable']);

/**
 * The sentence naming the first way a saved data mapping cannot be restored
 * onto the open dataset, or null when it can.
 *
 * The embeddings may differ: a session restores every representation it
 * enables and its defaults, provided the dataset can plot each one
 * (`describeEmbeddingRefusal`). Every other group may differ too, provided
 * the dataset can use the saved choice (`describeChoiceRefusal`); a group the
 * dataset cannot change must be exactly the one it is shown with.
 *
 * @param {object} saved - A canonical DataMapping.
 * @param {object} current - A canonical DataMapping.
 * @param {{
 *   describeEmbeddingRefusal: (ref: {key: string, columns: number[]}) => string|null,
 *   describeChoiceRefusal: (group: string, value: unknown) => string|null
 * }} readers - Why the open dataset cannot show one embedding, or use one
 *   value of one group (in the context of `saved`: its modality and
 *   matrix), as a clause such as "this dataset does not have" (or
 *   {@link UNCHANGEABLE_GROUP_CLAUSE}), or null when it can.
 * @returns {string|null}
 */
export function describeDataMappingMismatch(saved, current, readers) {
  if (
    typeof readers?.describeEmbeddingRefusal !== 'function' ||
    typeof readers?.describeChoiceRefusal !== 'function'
  ) {
    throw new TypeError(
      'Data mapping comparison requires an embedding and a choice refusal reader.'
    );
  }
  const { describeEmbeddingRefusal, describeChoiceRefusal } = readers;
  if (sameJson(saved, current)) return null;
  for (const was of saved.embeddings.enabled) {
    if (current.embeddings.enabled.some(ref => compareEmbeddingRefs(ref, was) === 0)) continue;
    const refusal = describeEmbeddingRefusal(was);
    if (refusal === null) continue;
    return (
      `This session shows ${describeEmbeddingRef(was)}, `
      + `which ${refusal}. The session was not opened.`
      + ' Open the dataset version the session was saved on, then load the session again.'
    );
  }
  // A multimodal dataset's expression groups are its modality's: the modality first.
  // Gene names and highly variable genes are columns of the var axis of the
  // session's matrix, and every expression group is its modality's: one the
  // dataset shows too is checked again when the session reads it elsewhere.
  const contextMoved = !sameJson(saved.modality, current.modality) || !sameJson(saved.expression, current.expression);
  for (const group of ['knn', 'modality', 'geneNames', 'expression', 'log1p', 'highlyVariable', 'latent', 'vectorFields']) {
    const same = sameJson(saved[group], current[group]);
    if (same && !(contextMoved && EXPRESSION_CONTEXT_GROUPS.has(group))) continue;
    const refusal = describeChoiceRefusal(group, saved[group]);
    // A group shown as saved that the dataset cannot change is no difference:
    // the group that moved it (the matrix, the modality) is named instead.
    if (refusal === null || (same && refusal === UNCHANGEABLE_GROUP_CLAUSE)) continue;
    if (refusal !== UNCHANGEABLE_GROUP_CLAUSE) {
      return (
        `This session uses ${describeMappingGroupValue(group, saved[group])} as its `
        + `${MAPPING_GROUP_LABELS[group]}, which ${refusal}. The session was not opened.`
        + ' Open the dataset version the session was saved on, then load the session again.'
      );
    }
    return (
      `This session was saved with ${describeMappingGroupValue(group, saved[group])} `
      + `as its ${MAPPING_GROUP_LABELS[group]}, and this dataset is shown with `
      + `${describeMappingGroupValue(group, current[group])}. The session was not opened.`
      + ' Open the dataset version the session was saved on, then load the session again.'
    );
  }
  return null;
}

/**
 * Explain a dataset fingerprint mismatch to the person loading the session,
 * from everything but the cell-order digest.
 *
 * The session controls surface this text verbatim, so each cause gets the
 * sentence that names what actually differs and what to do next. Naming a cause
 * the evidence does not establish would be its own integrity failure.
 *
 * - The counts are conclusive, and they are also the evidence the first message
 *   quotes, so that message is reserved for the case where they actually
 *   differ. Two datasets that agree on every count but not on their id get
 *   their own sentence, which names the ids instead.
 *
 * @param {any} saved
 * @param {object} current - The current scalars.
 * @returns {string|null}
 */
function describeDatasetIdentityMismatch(saved, current) {
  if (
    saved.cellCount !== current.cellCount
    || saved.varCount !== current.varCount
  ) {
    return (
      'This session was saved on a different dataset than the one that is open '
      + `now (${formatCountOf(saved.cellCount, 'cell')} and `
      + `${formatCountOf(saved.varCount, 'gene')} when it was saved, `
      + `${formatCountOf(current.cellCount, 'cell')} and `
      + `${formatCountOf(current.varCount, 'gene')} now). Open the `
      + 'dataset the session was saved on, then load the session again.'
    );
  }
  // The counts are the evidence in the message above, so it can only be used
  // where they differ; two datasets with equal counts are told apart by
  // their identity, and named by the names they show.
  if (saved.datasetId !== current.datasetId) {
    return (
      'This session was saved on a different dataset. It has the same '
      + `${formatCountOf(saved.cellCount, 'cell')} and `
      + `${formatCountOf(saved.varCount, 'gene')}, but it was saved on `
      + `${describeOtherDataset(saved, current)}. Open the dataset `
      + 'the session was saved on, then load the session again.'
    );
  }
  return null;
}

/**
 * The refusal shown when a session's cell-order digest does not match.
 *
 * `cellOrder.digest` is a one-way hash of the embedding's stored values,
 * each cell named by its original position (`data/cell-order-digest.js`).
 * It changes when another cell sits at an original position (the cells
 * listed in another order) and when the coordinate values change, and a
 * hash cannot say which happened, so the message states the one thing that
 * is established and offers both causes. How the cells were opened (whole,
 * grown, cut, in priority order) never changes it.
 */
const CELL_ORDER_MISMATCH_MESSAGE =
  'This dataset is not the one this session was saved on. It has the same '
  + 'name and the same number of cells and genes, but the cell coordinates '
  + 'differ from the ones the session was saved against, so Cellucid cannot '
  + 'confirm that a saved selection still marks the same cells. Either the '
  + 'cells are listed in a different order, or the same cells were exported '
  + 'again from a re-computed embedding. The session was not opened. Load '
  + 'the version of the dataset the session was saved on, or re-create the '
  + 'selections on this one.';

/**
 * Verify a saved session fingerprint against the open dataset, without
 * changing anything the user sees.
 *
 * In order: the dataset's counts and identity, its data mapping, then the
 * cell-order digest of the very embedding the session names, over the open
 * cells, whichever layout the live view shows now (the reader worker's sums,
 * `DimensionManager.getCellOrderDigest`: no layout is loaded for it).
 * Nothing is applied before all of them pass.
 *
 * A session names the cells it was saved on, which are opened before it is
 * restored (`session-controls.js`): the digest of those cells is the same
 * however they are opened now -- whole, grown, cut in place from a larger
 * share, in priority order or as the file gives them.
 *
 * A dataset's published starting view (`profile` 'published-default') is
 * saved on every cell and holds no content a person made (one tracker of one
 * root, `published-default.js`): it applies to any subsample of its dataset --
 * fitted to the device, or named in the link -- as it does to every cell.
 * The cell count is then the dataset's (`nOriginal` of the open cells'
 * identity), and the cell-order digest, a sum over every cell, cannot be
 * taken from the cells a subsample holds: the catalog binds the view to its
 * dataset's generation by SHA-256 instead.
 *
 * @param {object} ctx
 * @param {any} saved - A validated `manifest.datasetFingerprint`.
 * @param {{profile?: 'published-default'|null}} [options]
 * @returns {Promise<string|null>} The refusal to show, or null when it matches.
 */
export async function verifySessionFingerprint(ctx, saved, { profile = null } = {}) {
  assertDatasetFingerprint(saved, 'Saved dataset fingerprint');
  const opened = currentFingerprintScalars(ctx);
  const cells = ctx.state.cellIdentity ?? null;
  const ontoSubsample = profile === 'published-default' && cells?.isSubset === true && cells.nOriginal === saved.cellCount;
  const scalars = ontoSubsample ? { ...opened, cellCount: cells.nOriginal } : opened;
  // Choosing None leaves a runtime of zero cells and no data mapping. That is
  // no dataset at all, so quoting its zero counts as "the one that is open
  // now" would be untrue.
  if (scalars.cellCount === 0) {
    const savedName = describeDatasetIdentity(saved);
    return (
      'No dataset is open. Open the dataset the session was saved on'
      + `${savedName === null ? '' : ` (${savedName})`}, then load the session again.`
    );
  }
  const dataMapping = requireCurrentDataMapping(ctx.state);
  // The gene count is that of the var axis the saved mapping names (raw.X
  // has its own), read from metadata: a session saved on raw restores onto a
  // file that opened on X.
  const varCount = requireMethod(
    ctx.state,
    'describeMappingVarCount',
    'Session restore DataState'
  ).call(ctx.state, saved.dataMapping);
  const current = { ...scalars, varCount, dataMapping };
  const identity = describeDatasetIdentityMismatch(saved, current);
  if (identity !== null) return identity;
  if (!sameJson(saved.dataMapping, current.dataMapping)) {
    const mapping = describeDataMappingMismatch(
      saved.dataMapping,
      current.dataMapping,
      {
        describeEmbeddingRefusal: requireMethod(
          ctx.state,
          'describeEmbeddingRefusal',
          'Session restore DataState'
        ).bind(ctx.state),
        // Expression choices are those of the session's modality, and gene
        // names and highly variable genes those of its matrix's var axis.
        describeChoiceRefusal: (group, value) => requireMethod(
          ctx.state,
          'describeMappingChoiceRefusal',
          'Session restore DataState'
        ).call(ctx.state, group, value, saved.dataMapping),
      }
    );
    if (mapping !== null) return mapping;
  }

  if (ontoSubsample) return null;
  const dimensionManager = ctx.state.dimensionManager;
  const layoutKey = resolveEmbeddingRefLayout(
    dimensionManager,
    saved.cellOrder.embedding,
    saved.cellOrder.dimension,
    'Saved cell-order embedding'
  );
  if (layoutKey === null) {
    return (
      `This session recorded its cell order on ${describeEmbeddingRef(saved.cellOrder.embedding)} `
      + `in ${saved.cellOrder.dimension}D, which this dataset does not have. `
      + 'The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.'
    );
  }
  const digest = await requireMethod(
    dimensionManager,
    'getCellOrderDigest',
    'Session restore DimensionManager'
  ).call(dimensionManager, layoutKey);
  return digest === saved.cellOrder.digest ? null : CELL_ORDER_MISMATCH_MESSAGE;
}
