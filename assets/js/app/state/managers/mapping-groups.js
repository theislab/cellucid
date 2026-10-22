/**
 * @fileoverview The data-mapping groups beside the embeddings: the neighbour
 * graph, gene names, expression matrix, latent space and vector fields.
 *
 * `DataState.applyDataMapping` (`mapping-manager.js`) owns the transaction.
 * This module adds, per group:
 * - whether the open dataset can change it, and why not;
 * - why one choice cannot be used (listing-time, or refused at load time this
 *   session);
 * - a *stage* step that loads and checks everything the new choice needs
 *   without changing what is shown, and the *commit* and *rollback* steps
 *   that publish it or restore the previous choice.
 *
 * Staging reads through the same mapping routes on every AnnData path
 * (`_cellucid/mapping/...` under the dataset base): a file read in the
 * browser answers them from its adapter, `cellucid serve` and a notebook over
 * HTTP. A choice whose data fails its check -- a graph that is not symmetric,
 * a NaN -- is a `MappingLoadError`: that choice is marked unusable with its
 * reason for the rest of the dataset's session, and the transaction rolls
 * back.
 *
 * Owners outside DataState (the connectivity owner in `main.js`) register
 * through `setMappingRuntime`.
 *
 * @module state/managers/mapping-groups
 */

import {
  ANNDATA_KIND,
  DIMENSION_SLOTS,
  VECTOR_KEY_PATTERN,
  canonicalEmbeddingId,
  isVectorFieldKey,
} from '../../../data/data-mapping.js';
import {
  MappingLoadError,
  axisVarColumns,
  expressionAxisRoute,
  geneNamesRoute,
  latentCandidateReason,
  mappingGenesBase,
  mappingKnnBase,
  mappingLatentOutlierPath,
  obsmIndexOf,
  obsmWidth,
  obspIndexOf,
  resolveVectorBinding,
} from '../../../data/data-mapping-candidates.js';
import {
  createVarFieldLoader,
  loadConnectivityManifest,
  loadOutlierQuantiles,
  loadVarManifest,
} from '../../../data/data-loaders.js';
import {
  describeMappingGroupValue,
  MAPPING_GROUP_LABELS,
  UNCHANGEABLE_GROUP_CLAUSE,
} from '../../../data/dataset-mapping.js';

/** The groups beside the embeddings, in the order a transaction applies them. */
export const MAPPING_GROUPS = Object.freeze([
  'vectorFields',
  'knn',
  'latent',
  'geneNames',
  'expression',
]);

const RUNTIME_METHODS = Object.freeze([
  'getBaseUrl',
  'createVectorFieldManager',
  'getConnectivityGraph',
  'replaceConnectivityGraph',
  'resetGeneAnalysis',
]);

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatCount(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The words one `obsp` candidate is listed with: `connectivities · sparse
 * 10,000 × 10,000`.
 *
 * @param {{key: string, storage: string, shape: number[]|null}} item
 * @returns {string}
 */
export function describeObspCandidate(item) {
  const kind = item.storage === 'dense' ? 'dense' : 'sparse';
  const shape = Array.isArray(item.shape) && item.shape.length === 2
    ? ` ${formatCount(item.shape[0])} × ${formatCount(item.shape[1])}`
    : '';
  return `${item.key} · ${kind}${shape}`;
}

/**
 * The groups each kind of dataset can change. A prepared export fixes its
 * graph, expression matrix and latent space at `prepare()` time, so they are
 * not part of its mapping at all; it can use any of the gene-name sets and
 * vector bindings it was exported with.
 */
const CHANGEABLE_GROUPS = Object.freeze({
  [ANNDATA_KIND]: Object.freeze(['vectorFields', 'knn', 'latent', 'geneNames', 'expression']),
  export: Object.freeze(['vectorFields', 'geneNames']),
});

function formatColumnCount(width) {
  return `${formatCount(width)} ${width === 1 ? 'column' : 'columns'}`;
}

/**
 * Whether `key` is named for the embedding `embeddingKey`, the way scVelo and
 * CellRank name what they compute on a basis (`velocity_umap` for `X_umap`),
 * or by the default rule (`velocity_umap_2d` for `X_umap` in 2D).
 */
function isSuggestedVector(key, embeddingKey, dimension) {
  const match = VECTOR_KEY_PATTERN.exec(key);
  if (match !== null) {
    return Number(match.groups.dimension) === dimension
      && (embeddingKey === 'X_umap' || embeddingKey === `X_umap_${dimension}d`);
  }
  const basis = embeddingKey.replace(/^X_/i, '').toLowerCase();
  return basis.length > 0 && key.toLowerCase().endsWith(`_${basis}`);
}

/**
 * Groups staged together: the gene names and the expression matrix are one
 * var axis, read and published as one step.
 */
const STAGE_OF_GROUP = Object.freeze({
  vectorFields: 'vectorFields',
  knn: 'knn',
  latent: 'latent',
  geneNames: 'genes',
  expression: 'genes',
});

function formatGeneCount(count) {
  return `${formatCount(count)} ${count === 1 ? 'gene' : 'genes'}`;
}

/**
 * The words one expression choice is listed with: `X`, `raw.X · 30,000
 * genes`, `layers['counts']`.
 */
function describeExpression(candidates, expression) {
  if (expression === 'X') return 'X';
  if (expression === 'raw') return `raw.X · ${formatGeneCount(candidates.raw.n_vars)}`;
  return `layers['${expression.slice('layer:'.length)}']`;
}

export class DataStateMappingGroupMethods {
  /**
   * Register the owners a mapping transaction publishes through, or remove
   * them with null.
   *
   * @param {{
   *   getBaseUrl: () => string,
   *   getConnectivityGraph: () => {manifest: Object|null, manifestUrl: string|null},
   *   replaceConnectivityGraph: (graph: {manifest: Object|null, manifestUrl: string|null}) => void
   * }|null} runtime
   */
  setMappingRuntime(runtime) {
    if (runtime !== null) {
      for (const method of RUNTIME_METHODS) {
        if (typeof runtime?.[method] !== 'function') {
          throw new TypeError(`The data-mapping runtime requires ${method}().`);
        }
      }
    }
    this._mappingRuntime = runtime;
  }

  /**
   * The edge count of the neighbour graph in use, or null for none.
   *
   * @returns {number|null}
   */
  getConnectivityEdgeCount() {
    const manifest = this._mappingRuntime?.getConnectivityGraph().manifest ?? null;
    return manifest === null ? null : manifest.n_edges;
  }

  /**
   * Forget every choice refused this session: a new dataset was published.
   * @private
   */
  _resetMappingGroups() {
    this._unusableMappingChoices = new Map();
    // A prepared export publishes every vector binding it was exported with;
    // those are the bindings its panel offers.
    this._exportVectorBindings = this.dataMapping?.kind === 'export'
      ? this.dataMapping.vectorFields
      : [];
  }

  /**
   * Whether the open dataset can change one group.
   *
   * @param {string} group
   * @returns {boolean}
   */
  canChangeMappingGroup(group) {
    const mapping = this.dataMapping;
    if (mapping === null || mapping === undefined) return false;
    if (mapping.kind === ANNDATA_KIND && this.getMappingCandidates() === null) return false;
    if (!(CHANGEABLE_GROUPS[mapping.kind] ?? []).includes(group)) return false;
    // A prepared export offers the gene-name sets and vector bindings it was
    // exported with.
    if (mapping.kind !== ANNDATA_KIND && group === 'geneNames') {
      return (this.varData?.geneNameSets?.length ?? 0) > 1;
    }
    if (mapping.kind !== ANNDATA_KIND && group === 'vectorFields') {
      return (this._exportVectorBindings?.length ?? 0) > 0;
    }
    return true;
  }

  /**
   * Why one choice of one group cannot be used this session, or null.
   *
   * @param {string} group
   * @param {string} key
   * @returns {string|null}
   */
  getMappingChoiceUnusableReason(group, key) {
    return this._unusableMappingChoices?.get(group)?.get(key) ?? null;
  }

  /**
   * Record that one choice failed its load-time check.
   * @private
   */
  _markMappingChoiceUnusable(group, key, reason) {
    if (!(this._unusableMappingChoices instanceof Map)) {
      this._unusableMappingChoices = new Map();
    }
    let byKey = this._unusableMappingChoices.get(group);
    if (byKey === undefined) {
      byKey = new Map();
      this._unusableMappingChoices.set(group, byKey);
    }
    byKey.set(key, reason);
  }

  /**
   * The choices one group offers, in the order a menu lists them, each with
   * whether it can be used and why not. Null for a group the open dataset
   * cannot change.
   *
   * @param {string} group
   * @returns {Array<{value: string|null, label: string, usable: boolean, reason: string|null}>|null}
   */
  getMappingGroupChoices(group) {
    if (!this.canChangeMappingGroup(group)) return null;
    const candidates = this.getMappingCandidates();
    if (group === 'expression') {
      const choices = [];
      if (candidates.X !== null) choices.push('X');
      for (const layer of candidates.layers) choices.push(`layer:${layer.key}`);
      if (candidates.raw !== null) choices.push('raw');
      return [
        { value: null, label: 'None', usable: true, reason: null },
        ...choices.map(value => {
          const layer = value.startsWith('layer:')
            ? candidates.layers.find(entry => entry.key === value.slice('layer:'.length))
            : null;
          const reason = layer !== null && !layer.usable
            ? layer.reason
            : this.getMappingChoiceUnusableReason('expression', value);
          return { value, label: describeExpression(candidates, value), usable: reason === null, reason };
        }),
      ];
    }
    if (group === 'geneNames') {
      return this.getGeneNameChoices(this.dataMapping.expression);
    }
    if (group === 'latent') {
      return [
        { value: null, label: 'None', usable: true, reason: null },
        ...candidates.obsm.filter(item => !isVectorFieldKey(item.key)).map(item => {
          const reason = latentCandidateReason(item)
            ?? this.getMappingChoiceUnusableReason('latent', item.key);
          const width = obsmWidth(item);
          return {
            value: item.key,
            label: width === null ? item.key : `${item.key} · ${formatColumnCount(width)}`,
            usable: reason === null,
            reason,
          };
        }),
      ];
    }
    if (group === 'knn') {
      return [
        { value: null, label: 'None', usable: true, reason: null },
        ...candidates.obsp.map(item => {
          const reason = item.usable
            ? this.getMappingChoiceUnusableReason('knn', item.key)
            : item.reason;
          return {
            value: item.key,
            label: describeObspCandidate(item),
            usable: reason === null,
            reason,
          };
        }),
      ];
    }
    return null;
  }

  /**
   * The gene-name choices of one expression source: the var index, then
   * every column of that axis's var (`raw.var` for `raw`). A prepared export
   * offers the name sets it was exported with.
   *
   * @param {string|null} expression
   * @returns {Array<{value: string, label: string, usable: boolean, reason: string|null}>}
   */
  getGeneNameChoices(expression) {
    if (this.dataMapping.kind !== ANNDATA_KIND) {
      return this.varData.geneNameSets.map(set => ({
        value: set.source === null ? 'index' : `column:${set.source}`,
        label: set.source === null ? 'var index' : set.source,
        usable: true,
        reason: null,
      }));
    }
    const candidates = this.getMappingCandidates();
    const index = { value: 'index', label: 'var index', usable: true, reason: null };
    if (expression === null) return [index];
    const axisRoute = expressionAxisRoute(candidates, expression);
    if (axisRoute === null) return [index];
    return [
      index,
      ...axisVarColumns(candidates, axisRoute).map(column => {
        const reason = column.usable
          ? this.getMappingChoiceUnusableReason('geneNames', column.key)
          : column.reason;
        return { value: `column:${column.key}`, label: column.key, usable: reason === null, reason };
      }),
    ];
  }

  /**
   * The vector bindings the panel offers, grouped by the embedding they bind
   * to. For an AnnData file: every embedding `mapping` shows or binds, each
   * with every `obsm` array that can be drawn on it (`resolveVectorBinding`),
   * the arrays named for it first and marked suggested. For a prepared export:
   * the bindings it was exported with. Every embedding `mapping` enables is
   * listed, since a binding's embedding must be enabled. Null when the dataset cannot change
   * its vector fields. Embeddings bound in the mapping in use are listed too,
   * so unbinding one does not hide it.
   *
   * @param {Object} mapping - The mapping whose embeddings are listed (the
   *   one being edited).
   * @returns {Array<{embeddingKey: string, label: string, options: Array<{binding: Object, label: string, usable: boolean, reason: string|null, suggested: boolean}>}>|null}
   */
  getVectorBindingChoices(mapping) {
    if (!this.canChangeMappingGroup('vectorFields')) return null;
    if (this.dataMapping.kind !== ANNDATA_KIND) {
      const groups = new Map();
      for (const binding of this._exportVectorBindings) {
        const key = binding.embedding.key;
        if (!groups.has(key)) groups.set(key, { embeddingKey: key, label: key, options: [] });
        groups.get(key).options.push({
          binding,
          label: binding.field,
          usable: true,
          reason: null,
          suggested: false,
        });
      }
      return [...groups.values()];
    }
    const candidates = this.getMappingCandidates();
    const refs = new Map();
    for (const ref of mapping.embeddings.enabled) refs.set(JSON.stringify(ref), ref);
    // An embedding stays listed while its bindings are being edited: those
    // in use and those staged.
    for (const binding of [...this.dataMapping.vectorFields, ...mapping.vectorFields]) {
      refs.set(JSON.stringify(binding.embedding), binding.embedding);
    }
    const result = [];
    for (const ref of refs.values()) {
      const item = candidates.obsm[obsmIndexOf(candidates, ref.key)];
      const width = item === undefined ? null : obsmWidth(item);
      const embeddingKey = width === null
        ? ref.key
        : canonicalEmbeddingId(ref.key, ref.columns, { width });
      const options = [];
      for (const vector of candidates.obsm) {
        // `X_…` arrays are representations (embeddings, latent spaces), as
        // AnnData names them, never vectors drawn on one.
        if (/^X_/.test(vector.key)) continue;
        const binding = { key: vector.key, embedding: { key: ref.key, columns: [...ref.columns] } };
        const resolved = resolveVectorBinding(candidates, binding);
        if (!resolved.ok) continue;
        const reason = this.getMappingChoiceUnusableReason('vectorFields', vector.key);
        options.push({
          binding,
          label: vector.key,
          usable: reason === null,
          reason,
          suggested: isSuggestedVector(vector.key, ref.key, ref.columns.length),
        });
      }
      options.sort((left, right) => (
        Number(right.suggested) - Number(left.suggested)
        || (left.label < right.label ? -1 : left.label > right.label ? 1 : 0)
      ));
      result.push({ embeddingKey, label: embeddingKey, options });
    }
    return result;
  }

  /**
   * The number of genes the var axis of one mapping holds: what a session
   * fingerprint's `varCount` is compared against before that mapping is
   * restored. Metadata only.
   *
   * @param {Object} mapping - A canonical mapping of the open dataset's kind.
   * @returns {number}
   */
  describeMappingVarCount(mapping) {
    // A gene list the dataset cannot change is the one it shows.
    if (!this.canChangeMappingGroup('expression')) return this.getVarAxisGeneCount();
    const candidates = this.getMappingCandidates();
    if (mapping.expression === null) return 0;
    if (mapping.expression === 'raw') return candidates.raw?.n_vars ?? 0;
    return candidates.var.n_vars;
  }

  /**
   * Why one value of one group cannot be shown on the open dataset, as a
   * clause ("this dataset does not have", "this dataset cannot use (not
   * symmetric ...)", "cannot be changed for this dataset"), or null.
   *
   * @param {string} group
   * @param {unknown} value
   * @returns {string|null}
   */
  describeMappingChoiceRefusal(group, value) {
    const current = this.dataMapping;
    if (sameJson(current?.[group], value)) return null;
    if (!this.canChangeMappingGroup(group)) {
      return UNCHANGEABLE_GROUP_CLAUSE;
    }
    if (group === 'knn') {
      if (value === null) return null;
      const item = this.getMappingCandidates().obsp.find(entry => entry.key === value);
      if (item === undefined) return 'this dataset does not have';
      const reason = item.usable
        ? this.getMappingChoiceUnusableReason('knn', value)
        : item.reason;
      return reason === null ? null : `this dataset cannot use (${reason})`;
    }
    if (group === 'latent') {
      if (value === null) return null;
      const choice = this.getMappingGroupChoices('latent').find(entry => entry.value === value);
      if (choice === undefined) return 'this dataset does not have';
      return choice.usable ? null : `this dataset cannot use (${choice.reason})`;
    }
    if (group === 'vectorFields') {
      return this._describeVectorBindingsRefusal(value);
    }
    if (group === 'expression' || group === 'geneNames') {
      const choices = group === 'expression'
        ? this.getMappingGroupChoices('expression')
        : this.getGeneNameChoices(this._pendingExpression ?? this.dataMapping.expression);
      const choice = choices.find(entry => entry.value === value);
      if (choice === undefined) return 'this dataset does not have';
      return choice.usable ? null : `this dataset cannot use (${choice.reason})`;
    }
    return UNCHANGEABLE_GROUP_CLAUSE;
  }

  /**
   * Why a list of vector bindings cannot be used, as a clause, or null.
   * @private
   */
  _describeVectorBindingsRefusal(bindings) {
    if (this.dataMapping.kind !== ANNDATA_KIND) {
      const declared = new Set(this._exportVectorBindings.map(binding => JSON.stringify(binding)));
      return bindings.every(binding => declared.has(JSON.stringify(binding)))
        ? null
        : 'this dataset does not have';
    }
    const candidates = this.getMappingCandidates();
    for (const binding of bindings) {
      if (obsmIndexOf(candidates, binding.key) < 0) return 'this dataset does not have';
      const resolved = resolveVectorBinding(candidates, binding);
      const reason = resolved.ok
        ? this.getMappingChoiceUnusableReason('vectorFields', binding.key)
        : resolved.reason;
      if (reason !== null) return `this dataset cannot use (${reason})`;
    }
    return null;
  }

  /**
   * Explain why the groups beside the embeddings of one mapping cannot be
   * applied to the open dataset, or return null when they can. Nothing is
   * loaded.
   *
   * @param {Object} current - The current canonical mapping.
   * @param {Object} next - A canonical mapping of the same kind.
   * @returns {string|null}
   */
  describeMappingGroupRefusal(current, next) {
    for (const group of MAPPING_GROUPS) {
      if (!Object.hasOwn(current, group)) continue;
      // Gene names are read from the axis of the next expression matrix, so a
      // name source is checked whenever either changes.
      const changed = !sameJson(current[group], next[group])
        || (group === 'geneNames' && !sameJson(current.expression, next.expression));
      if (!changed) continue;
      const refusal = this._withPendingExpression(
        next.expression,
        () => this.describeMappingChoiceRefusal(group, next[group])
      );
      if (refusal === null) continue;
      if (refusal === UNCHANGEABLE_GROUP_CLAUSE) {
        return `This mapping changes the ${MAPPING_GROUP_LABELS[group]}, which ${UNCHANGEABLE_GROUP_CLAUSE}.`;
      }
      return (
        `This mapping uses ${describeMappingGroupValue(group, next[group])} as its `
        + `${MAPPING_GROUP_LABELS[group]}, which ${refusal}.`
      );
    }
    return null;
  }

  /**
   * Run `read` with gene-name choices taken from the axis of `expression`.
   * @private
   */
  _withPendingExpression(expression, read) {
    const saved = this._pendingExpression;
    this._pendingExpression = expression;
    try {
      return read();
    } finally {
      this._pendingExpression = saved;
    }
  }

  /**
   * Load and check everything the changed groups of `next` need, without
   * changing what is shown, and return the steps that publish them.
   *
   * @param {Object} current
   * @param {Object} next
   * @returns {Promise<{changed: boolean, commit: () => Promise<void>, rollback: () => Promise<Error[]>}>}
   */
  async _stageMappingGroups(current, next) {
    const steps = [];
    const staged = new Set();
    for (const group of MAPPING_GROUPS) {
      if (!Object.hasOwn(current, group) || sameJson(current[group], next[group])) continue;
      const stageName = STAGE_OF_GROUP[group];
      if (staged.has(stageName)) continue;
      staged.add(stageName);
      const stage = GROUP_STAGES[stageName];
      if (stage === undefined) {
        throw new RangeError(
          `This mapping changes the ${MAPPING_GROUP_LABELS[group]}, which ${UNCHANGEABLE_GROUP_CLAUSE}.`
        );
      }
      try {
        steps.push(await stage.call(this, next, current));
      } catch (error) {
        if (error instanceof MappingLoadError) {
          this._markMappingChoiceUnusable(refusedGroup(stageName, error, next), error.key, error.reason);
        }
        throw error;
      }
    }
    const committed = [];
    return {
      changed: steps.length > 0,
      async commit() {
        for (const step of steps) {
          await step.commit();
          committed.push(step);
        }
      },
      async rollback() {
        const errors = [];
        for (const step of committed.reverse()) {
          try {
            await step.rollback();
          } catch (error) {
            errors.push(error);
          }
        }
        committed.length = 0;
        return errors;
      },
    };
  }

  /**
   * The runtime registered for the open dataset.
   * @private
   */
  _requireMappingRuntime() {
    if (this._mappingRuntime === null || this._mappingRuntime === undefined) {
      throw new Error('The data-mapping runtime is not registered.');
    }
    return this._mappingRuntime;
  }
}

/**
 * The group a load-time refusal is recorded under: a genes refusal names a
 * var column (gene names) or a matrix (expression).
 */
function refusedGroup(stageName, error, next) {
  if (stageName !== 'genes') return stageName;
  return next.geneNames === `column:${error.key}` ? 'geneNames' : 'expression';
}

/**
 * The stage step of each group: called with the group's next value on
 * DataState, it loads and checks what that value needs and returns
 * `{commit, rollback}`.
 */
const GROUP_STAGES = Object.freeze({
  /**
   * The neighbour graph: its manifest is read (and, in the browser, the graph
   * itself extracted and checked) before anything changes; commit hands the
   * connectivity owner the new graph, rollback the previous one.
   */
  async knn(next) {
    const key = next.knn;
    const runtime = this._requireMappingRuntime();
    let graph = { manifest: null, manifestUrl: null };
    if (key !== null) {
      const index = obspIndexOf(this.getMappingCandidates(), key);
      if (index < 0) {
        throw new RangeError(`This dataset has no obsp['${key}'].`);
      }
      const manifestUrl = `${runtime.getBaseUrl()}${mappingKnnBase(index)}connectivity_manifest.json`;
      const manifest = await loadConnectivityManifest(manifestUrl, {});
      if (manifest === null) {
        throw new MappingLoadError(
          key,
          'not present in this dataset',
          `obsp['${key}'] is not present in this dataset.`
        );
      }
      graph = { manifest, manifestUrl };
    }
    const previous = runtime.getConnectivityGraph();
    return {
      commit() {
        runtime.replaceConnectivityGraph(graph);
      },
      rollback() {
        runtime.replaceConnectivityGraph({
          manifest: previous.manifest,
          manifestUrl: previous.manifestUrl,
        });
      },
    };
  },

  /**
   * The latent space: every categorical field's outlier payload becomes the
   * mapping route of the new space (`_cellucid/mapping/latent/{obsm}/obs/
   * {field}.outliers.f32`), or none; the fields loaded now read theirs first
   * (`stageLatentReplacement`).
   */
  async latent(next) {
    const runtime = this._requireMappingRuntime();
    const candidates = this.getMappingCandidates();
    const obsmIndex = next.latent === null ? -1 : obsmIndexOf(candidates, next.latent);
    if (next.latent !== null && obsmIndex < 0) {
      throw new RangeError(`This dataset has no obsm['${next.latent}'].`);
    }
    const manifestUrl = `${runtime.getBaseUrl()}obs_manifest.json`;
    return this.stageLatentReplacement({
      outlierPathFor: payloadIndex => (
        obsmIndex < 0 ? null : mappingLatentOutlierPath(obsmIndex, payloadIndex)
      ),
      loadOutliers: descriptor => loadOutlierQuantiles(manifestUrl, descriptor, {
        pointCount: this.pointCount,
      }),
    });
  },

  /**
   * The vector fields: a manager for the new bindings is built before
   * anything changes (a binding that cannot be drawn is refused); nothing is
   * read until a view shows a field. Commit hands it to the views and drops
   * the overlay's uploaded data, so no binding outlives its mapping.
   */
  async vectorFields(next, current) {
    const runtime = this._requireMappingRuntime();
    const manager = runtime.createVectorFieldManager(next);
    const publish = replacement => {
      this.viewer?.resetVectorFieldOverlay();
      this.setVectorFieldManager(replacement);
    };
    return {
      commit() {
        publish(manager);
      },
      rollback() {
        // The replaced manager was retired when it was replaced.
        publish(runtime.createVectorFieldManager(current));
      },
    };
  },

  /**
   * The gene list: an AnnData file's gene names and expression matrix are
   * read through `_cellucid/mapping/genes/{axis}/{names}/`; a prepared
   * export relabels its genes with another exported name set. Only the genes
   * a view is coloured by are read now; the rest load on demand.
   */
  async genes(next, current) {
    const runtime = this._requireMappingRuntime();
    let varManifest;
    let varFieldLoader;
    let sameMatrix;
    // X and every layer share var; raw has its own axis.
    let sameAxis = true;
    if (next.kind === ANNDATA_KIND && next.expression === null) {
      // No expression matrix: an empty gene list, as a dataset without genes
      // is published.
      varManifest = { n_points: this.pointCount, fields: [] };
      varFieldLoader = null;
      sameMatrix = false;
      sameAxis = false;
    } else if (next.kind === ANNDATA_KIND) {
      const candidates = this.getMappingCandidates();
      const axisRoute = expressionAxisRoute(candidates, next.expression);
      const namesRoute = geneNamesRoute(candidates, axisRoute, next.geneNames);
      if (axisRoute === null || namesRoute === null) {
        throw new RangeError('This dataset does not have the expression matrix or gene names this mapping names.');
      }
      const manifestUrl = `${runtime.getBaseUrl()}${mappingGenesBase(axisRoute, namesRoute)}var_manifest.json`;
      varManifest = await loadVarManifest(manifestUrl, {});
      varFieldLoader = createVarFieldLoader(manifestUrl, { pointCount: varManifest.n_points });
      sameMatrix = next.expression === current.expression;
      sameAxis = current.expression !== null
        && (current.expression === 'raw') === (next.expression === 'raw');
    } else {
      const source = next.geneNames === 'index' ? null : next.geneNames.slice('column:'.length);
      const set = this.varData.geneNameSets.find(entry => entry.source === source);
      if (set === undefined) {
        throw new RangeError('This dataset was exported without these gene names.');
      }
      varManifest = {
        ...this.varData,
        fields: this._varFieldDescriptors.map((field, index) => ({ ...field, key: set.names[index] })),
      };
      varFieldLoader = this.varFieldLoader;
      sameMatrix = true;
    }
    const step = await this.stageVarAxisReplacement({
      varManifest,
      varFieldLoader,
      sameAxis,
      sameMatrix,
    });
    return {
      commit() {
        step.commit();
        runtime.resetGeneAnalysis();
      },
      rollback() {
        step.rollback();
      },
    };
  },
});
