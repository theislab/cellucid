/**
 * @fileoverview Mapping Manager: the data mapping a loaded dataset is shown
 * with, the representations it enables, and the representation each view
 * shows.
 *
 * A data mapping (`data/data-mapping.js`) enables any number of embeddings
 * (representations) of any mix of dimensions, names each dimension's default,
 * binds vector fields to embeddings and, for an AnnData source, names the
 * neighbour graph, gene names, expression matrix and latent space. This
 * manager owns, per dataset:
 * - the current mapping and where it came from (`origin`: the default rule,
 *   the best guess, a session or the user);
 * - the AnnData candidate catalog (`data/data-mapping-candidates.js`), when
 *   the source has one;
 * - the embeddings that failed their load-time check this session, which stay
 *   unusable with their reason.
 *
 * The mapping is the single source of truth for the enabled representations:
 * publishing or applying one registers every enabled layout (metadata only)
 * and hands the enabled set and the defaults to the dimension manager. Views
 * read them from there.
 *
 * A mapping is applied as one transaction: every layout a view must move to
 * is loaded and checked first, and so is every other changed group
 * (neighbour graph, gene names, expression matrix, latent space, vector
 * bindings; see `mapping-groups.js`). Then the enabled set and defaults are
 * published, every view whose representation is disabled -- or that follows
 * a default that changed -- moves, and the other groups are published; any
 * failure restores the previous set, every moved view and every group.
 * Enabling a representation loads nothing.
 *
 * The manager emits `mapping:changed` with `{mapping, cause: 'apply', origin}`
 * after a changed mapping is applied. Publishing a dataset's mapping emits nothing: it
 * is one step of a larger publication, and the interface refreshes from the
 * dataset-publication path once the whole dataset is in place.
 *
 * @module state/managers/mapping-manager
 */

import {
  ANNDATA_KIND,
  DIMENSION_SLOTS,
  compareEmbeddingRefs,
  slotDimension,
  validateDataMapping,
  vectorFieldKeys,
} from '../../../data/data-mapping.js';
import {
  MappingLoadError,
  mappingLayoutDescriptor,
  obsmWidth,
  resolveCandidateRef,
} from '../../../data/data-mapping-candidates.js';
import { layoutEmbeddingRef } from '../../../data/dataset-mapping.js';
import { representationName } from '../../../data/representation-names.js';

/** Where the current mapping came from. */
export const MAPPING_ORIGINS = Object.freeze(['default', 'best_guess', 'session', 'user', 'notebook']);


function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireOrigin(origin) {
  if (!MAPPING_ORIGINS.includes(origin)) {
    throw new TypeError(`Data mapping origin must be one of ${MAPPING_ORIGINS.join(', ')}.`);
  }
  return origin;
}

/**
 * Whether an error refuses one mapping choice (the AnnData adapter's load
 * check) rather than failing the transport.
 */
function isMappingLoadError(error) {
  return error instanceof MappingLoadError;
}

/**
 * The layout of every enabled reference and of every default, registering
 * AnnData layouts through the dimension manager's layout provider when none
 * plots them yet (metadata only).
 *
 * @param {Object} dimensionManager
 * @param {Object} mapping - A canonical DataMapping.
 * @returns {{enabled: string[], defaults: Map<number, string>}}
 */
function resolveMappingRepresentations(dimensionManager, mapping) {
  const enabled = mapping.embeddings.enabled.map(
    ref => dimensionManager.resolveRepresentation(ref)
  );
  const defaults = new Map();
  for (const slot of DIMENSION_SLOTS) {
    const ref = mapping.embeddings.defaults[slot];
    if (ref === null) continue;
    const layoutKey = dimensionManager.resolveRepresentation(ref);
    const dimension = slotDimension(slot);
    if (dimensionManager.getLayout(layoutKey).dimension !== dimension) {
      throw new RangeError(`The ${dimension}D default '${ref.key}' is not ${dimension}D.`);
    }
    defaults.set(dimension, layoutKey);
  }
  return { enabled, defaults };
}

function refsInclude(refs, ref) {
  return refs.some(candidate => compareEmbeddingRefs(candidate, ref) === 0);
}

export class DataStateMappingMethods {
  /**
   * Publish the data mapping a newly loaded dataset is shown with, or clear it
   * with `mapping: null` when no dataset is loaded: its enabled
   * representations and defaults go to the dimension manager, which must
   * already hold the dataset's layouts. Silent: see the module comment.
   *
   * @param {{
   *   mapping: Object|null,
   *   candidates: Object|null,
   *   origin: 'default'|'best_guess'
   * }} publication
   */
  publishDatasetMapping({ mapping, candidates, origin }) {
    if (mapping === null) {
      this.dataMapping = null;
      this._mappingCandidates = null;
      this._mappingOrigin = null;
      this._mappingPublicationOrigin = null;
      this._unusableEmbeddings = new Map();
      this._resetMappingGroups();
      return;
    }
    const canonical = Object.freeze(
      validateDataMapping(mapping, { label: 'Dataset data mapping' })
    );
    if (candidates !== null && candidates.kind !== ANNDATA_KIND) {
      throw new TypeError('A data-mapping candidate catalog must be of kind "anndata".');
    }
    requireOrigin(origin);
    const dimensionManager = this.dimensionManager;
    if (dimensionManager === null) {
      throw new Error('A data mapping is published after its dimension manager.');
    }
    const { enabled, defaults } = resolveMappingRepresentations(dimensionManager, canonical);
    dimensionManager.setRepresentations(enabled, defaults);
    this.dataMapping = canonical;
    this._mappingCandidates = candidates;
    this._mappingOrigin = origin;
    this._mappingPublicationOrigin = origin;
    this._unusableEmbeddings = new Map();
    this._resetMappingGroups();
  }

  /**
   * @returns {Object|null} The canonical DataMapping of the loaded dataset.
   */
  getDataMapping() {
    return this.dataMapping;
  }

  /**
   * @returns {'default'|'best_guess'|'session'|'user'|null}
   */
  getDataMappingOrigin() {
    return this._mappingOrigin ?? null;
  }

  /**
   * What usage analytics may know about the loaded dataset's mapping: whether
   * it opened on its defaults or a best guess, how many embeddings it could
   * show, how many it enables, and how many vector-field bindings it draws.
   * Never a key name.
   *
   * @returns {{origin: 'default'|'best_guess', embeddingCandidates: number, enabledRepresentations: number, vectorFields: number}|null}
   */
  getMappingAnalytics() {
    if (this.dataMapping === null) return null;
    const candidates = this.getMappingCandidates();
    const enabled = this.dataMapping.embeddings.enabled.length;
    const vectorKeys = candidates === null
      ? null
      : vectorFieldKeys(candidates.obsm.map(item => item.key));
    const count = candidates !== null && this.canMapAnyEmbedding()
      ? candidates.obsm.filter(item => item.usable && !vectorKeys.has(item.key)).length
      : enabled;
    return {
      origin: this._mappingPublicationOrigin === 'best_guess' ? 'best_guess' : 'default',
      embeddingCandidates: Math.max(1, count),
      enabledRepresentations: enabled,
      vectorFields: this.dataMapping.vectorFields.length,
    };
  }

  /**
   * The AnnData candidate catalog of the loaded dataset, or null when none
   * is loaded.
   *
   * @returns {Object|null}
   */
  getMappingCandidates() {
    return this._mappingCandidates ?? null;
  }

  /**
   * The groups the current mapping took from the best guess and still shows:
   * embedding slots (`'embeddings.2d'`), for a file without `X` the
   * `'expression'` matrix chosen in its place, the matrices' `'log1p'` (read
   * from Scanpy's `uns['log1p']`) and the `'highlyVariable'` column, each until
   * it is changed.
   *
   * @returns {string[]}
   */
  getGuessedMappingGroups() {
    const candidates = this.getMappingCandidates();
    if (candidates === null || this.dataMapping === null) return [];
    return candidates.guessed.filter(group => {
      if (group === 'expression' || group === 'log1p' || group === 'highlyVariable') {
        return sameJson(this.dataMapping[group], candidates.defaults[group]);
      }
      const slot = group.replace(/^embeddings\./, '');
      return (
        DIMENSION_SLOTS.includes(slot) &&
        sameJson(
          this.dataMapping.embeddings.defaults[slot],
          candidates.defaults.embeddings.defaults[slot]
        )
      );
    });
  }

  /**
   * Whether this dataset's source can plot any `obsm` array on request, so
   * any array can be enabled as a representation.
   *
   * @returns {boolean}
   */
  canMapAnyEmbedding() {
    return this.dimensionManager?.hasLayoutProvider?.() === true;
  }

  /**
   * Why an embedding key cannot be plotted this session, or null.
   *
   * @param {string} key - An obsm key.
   * @returns {string|null}
   */
  getEmbeddingUnusableReason(key) {
    return this._unusableEmbeddings?.get(key) ?? null;
  }

  /**
   * The enabled representations, in the order every picker lists them: by
   * dimension, highest first; within a dimension its default first, then the
   * mapping's order.
   *
   * @returns {Array<{
   *   layoutKey: string,
   *   dimension: number,
   *   name: string,
   *   label: string,
   *   ref: {key: string, columns: number[]}|null,
   *   isDefault: boolean
   * }>}
   */
  getEnabledRepresentations() {
    const dimensionManager = this.dimensionManager;
    if (dimensionManager === null) return [];
    // A synthetic (benchmark) scene enables layouts without a data mapping;
    // its representations have no embedding reference.
    const mapped = (this.dataMapping ?? null) !== null;
    return dimensionManager.getEnabledLayoutKeys()
      .map((layoutKey, order) => {
        const layout = dimensionManager.getLayout(layoutKey);
        return {
          layoutKey,
          dimension: layout.dimension,
          name: representationName(layout),
          label: layout.label,
          ref: mapped ? layoutEmbeddingRef(dimensionManager, layoutKey) : null,
          isDefault: dimensionManager.getDefaultLayout(layout.dimension) === layoutKey,
          order,
        };
      })
      .sort((left, right) => (
        right.dimension - left.dimension ||
        Number(right.isDefault) - Number(left.isDefault) ||
        left.order - right.order
      ))
      .map(({ order, ...representation }) => Object.freeze(representation));
  }

  /**
   * Every embedding the mapper can enable, enabled or not: every `obsm` array
   * (unusable ones with their reason) with every column selection that is
   * enabled now. An array with none enabled is offered at all of its columns
   * when it is 1 to 3 wide (an embedding), and at its first two, in 2D, when
   * it is wider: a matrix of components or latent dimensions (`X_pca`, a
   * 3,136-column latent space) is not an embedding, and its first two columns
   * are how it is conventionally plotted (PC1 against PC2). Offered as 3D at
   * its first three, every such matrix read as a 3D embedding beside the
   * file's real 2D UMAP. Embeddings are listed before wider arrays. A wide
   * array can be enabled at any further selection of 1 to 3 columns.
   *
   * @returns {Array<{
   *   ref: {key: string, columns: number[]|null},
   *   name: string,
   *   dimension: number|null,
   *   width: number|null,
   *   enabled: boolean,
   *   isDefault: boolean,
   *   usable: boolean,
   *   reason: string|null
   * }>}
   */
  getRepresentationChoices() {
    const mapping = this.dataMapping;
    const dimensionManager = this.dimensionManager;
    if (mapping === null || dimensionManager === null) return [];
    const enabledRefs = mapping.embeddings.enabled;
    const defaults = DIMENSION_SLOTS.map(slot => mapping.embeddings.defaults[slot])
      .filter(ref => ref !== null);
    const choice = (ref, extra) => {
      const loadReason = this.getEmbeddingUnusableReason(ref.key);
      return Object.freeze({
        ref,
        enabled: refsInclude(enabledRefs, ref),
        isDefault: refsInclude(defaults, ref),
        ...extra,
        ...(loadReason !== null ? { usable: false, reason: loadReason } : {}),
      });
    };
    const candidates = this.getMappingCandidates();
    if (candidates === null || !this.canMapAnyEmbedding()) {
      return enabledRefs.map(ref => {
        const layout = dimensionManager.getLayout(dimensionManager.resolveRepresentation(ref));
        return choice(ref, {
          name: representationName(layout),
          dimension: layout.dimension,
          width: null,
          usable: true,
          reason: null,
        });
      });
    }
    const choices = [];
    const wideChoices = [];
    const vectorKeys = vectorFieldKeys(candidates.obsm.map(item => item.key));
    for (const item of candidates.obsm) {
      if (vectorKeys.has(item.key)) continue;
      const width = item.usable ? obsmWidth(item) : null;
      if (!item.usable) {
        choices.push(choice({ key: item.key, columns: null }, {
          name: representationName({ layoutKey: item.key, label: item.key, provenance: null }),
          dimension: null,
          width: null,
          usable: false,
          reason: item.reason,
        }));
        continue;
      }
      const selections = enabledRefs.filter(ref => ref.key === item.key);
      const shown = selections.length > 0
        ? selections
        : [{ key: item.key, columns: Array.from({ length: width > 3 ? 2 : width }, (_, index) => index) }];
      for (const ref of shown) {
        (width > 3 ? wideChoices : choices).push(choice(ref, {
          name: representationName({
            layoutKey: item.key,
            label: item.key,
            provenance: { key: item.key, columns: ref.columns },
            width,
          }),
          dimension: ref.columns.length,
          width,
          usable: true,
          reason: null,
        }));
      }
    }
    return [...choices, ...wideChoices];
  }

  /**
   * The embedding reference of the representation a view shows.
   *
   * @param {string} viewId
   * @returns {{key: string, columns: number[]}}
   */
  getViewEmbeddingRef(viewId) {
    return layoutEmbeddingRef(this.dimensionManager, this.getViewLayoutKey(viewId));
  }

  /**
   * What one view shows, for its badge and its Compare-views row.
   *
   * @param {string} viewId
   * @returns {{dimension: number, name: string, label: string, layoutKey: string, isDefault: boolean}|null}
   *   Null while no dataset layout is published for the view.
   */
  describeViewEmbedding(viewId) {
    const dimensionManager = this.dimensionManager;
    if (dimensionManager === null || !dimensionManager.viewLayouts?.has(viewId)) return null;
    const layoutKey = dimensionManager.getViewLayout(viewId);
    const layout = dimensionManager.getLayout(layoutKey);
    return {
      dimension: layout.dimension,
      name: representationName(layout),
      label: layout.label,
      layoutKey,
      isDefault: dimensionManager.getDefaultLayout(layout.dimension) === layoutKey,
    };
  }

  /**
   * Show one enabled embedding in a view. An AnnData array that fails its
   * load-time check is marked unusable for the session and the view keeps
   * what it showed.
   *
   * @param {string} viewId
   * @param {{key: string, columns: number[]}} ref
   * @returns {Promise<string>} The layout key now shown.
   */
  async setViewEmbeddingRef(viewId, ref) {
    try {
      return await this.setViewEmbedding(viewId, ref);
    } catch (error) {
      if (isMappingLoadError(error)) this._unusableEmbeddings.set(error.key, error.reason);
      throw error;
    }
  }

  /**
   * Why the loaded dataset cannot show one embedding, as a clause ("this
   * dataset does not have", "this dataset cannot plot (NaN at cell 17)"), or
   * null when it can. A layout it names is registered on demand (metadata
   * only); nothing is loaded.
   *
   * @param {{key: string, columns: number[]}} ref
   * @returns {string|null}
   */
  describeEmbeddingRefusal(ref) {
    const candidates = this.getMappingCandidates();
    if (ref.columns !== null && candidates !== null) {
      if (!candidates.obsm.some(item => item.key === ref.key)) {
        return 'this dataset does not have';
      }
      const resolved = resolveCandidateRef(candidates, ref, ref.columns.length);
      if (!resolved.ok) return `this dataset cannot plot (${resolved.reason})`;
    }
    try {
      this.dimensionManager.resolveRepresentation(ref);
    } catch (error) {
      if (error instanceof RangeError) return 'this dataset does not have';
      throw error;
    }
    const unusable = this.getEmbeddingUnusableReason(ref.key);
    return unusable === null ? null : `this dataset cannot plot (${unusable})`;
  }

  /**
   * Explain why one mapping cannot be applied to the loaded dataset, or return
   * null when it can: every group this viewer cannot change must equal the
   * current mapping, and every enabled embedding must be one this dataset can
   * plot. Layouts the embeddings name are registered (metadata only); nothing
   * is loaded.
   *
   * @param {Object} next - A canonical DataMapping.
   * @returns {string|null}
   */
  describeDataMappingRefusal(next) {
    const current = this.dataMapping;
    if (current === null) return 'No dataset is loaded.';
    const groupRefusal = this.describeMappingGroupRefusal(current, next);
    if (groupRefusal !== null) return groupRefusal;
    for (const ref of next.embeddings.enabled) {
      if (refsInclude(current.embeddings.enabled, ref)) continue;
      const refusal = this.describeEmbeddingRefusal(ref);
      if (refusal !== null) return `${ref.key} is enabled, but ${refusal}.`;
    }
    for (const slot of DIMENSION_SLOTS) {
      const ref = next.embeddings.defaults[slot];
      if (ref === null) continue;
      const layoutKey = this.dimensionManager.resolveRepresentation(ref);
      if (this.dimensionManager.getLayout(layoutKey).dimension !== slotDimension(slot)) {
        return `The ${slot.toUpperCase()} default ${ref.key} is not ${slot.toUpperCase()}.`;
      }
    }
    return null;
  }

  /**
   * Where each view goes when `next` replaces the current representations:
   * a view whose representation is disabled moves to its dimension's new
   * default (its first enabled representation when the mapping names no
   * default), else to the dataset's opening representation; a view that
   * follows its dimension's default moves with it. Other views stay.
   *
   * @param {{enabled: string[], defaults: Map<number, string>}} next
   * @returns {Array<{viewId: string, from: string, to: string, followsDefault: boolean}>}
   */
  planRepresentationMoves(next) {
    const dimensionManager = this.dimensionManager;
    const openingFor = dimension => next.defaults.get(dimension)
      ?? next.enabled.find(key => dimensionManager.getLayout(key).dimension === dimension)
      ?? null;
    const datasetOpening = (() => {
      const preferred = dimensionManager.getDefaultDimension();
      if (next.defaults.has(preferred)) return next.defaults.get(preferred);
      return next.defaults.get(Math.max(...next.defaults.keys()));
    })();
    const moves = [];
    for (const viewId of this.viewContexts.keys()) {
      const from = dimensionManager.getViewLayout(viewId);
      const dimension = dimensionManager.getLayout(from).dimension;
      if (!next.enabled.includes(from)) {
        const to = openingFor(dimension) ?? datasetOpening;
        moves.push({ viewId, from, to, followsDefault: true });
        continue;
      }
      if (!this.viewFollowsDefault(viewId)) continue;
      const to = next.defaults.get(dimension) ?? null;
      if (to !== null && to !== from) {
        moves.push({ viewId, from, to, followsDefault: true });
      }
    }
    return moves;
  }

  /**
   * How many views applying `next` would switch to another representation
   * (see `planRepresentationMoves`). Layouts it names are registered
   * (metadata only); nothing is loaded.
   *
   * @param {Object} next - A DataMapping that `describeDataMappingRefusal` accepts.
   * @returns {number}
   */
  previewRepresentationMoves(next) {
    const canonical = validateDataMapping(next, { label: 'Previewed data mapping' });
    return this.planRepresentationMoves(
      resolveMappingRepresentations(this.dimensionManager, canonical)
    ).length;
  }

  /**
   * Apply a data mapping to the loaded dataset as one transaction.
   *
   * Every layout a view must move to is loaded and checked, and every other
   * changed group staged (`mapping-groups.js`), before anything is published
   * (enabling alone loads nothing); then the enabled set and defaults are
   * published, the views move (see `planRepresentationMoves`) and the other
   * groups are committed. A failure restores the previous set, every view
   * already moved and every committed group.
   *
   * @param {Object} next - A DataMapping of the loaded dataset's kind.
   * @param {{origin: 'session'|'user'|'notebook'}} options
   * @returns {Promise<boolean>} Whether anything changed.
   */
  async applyDataMapping(next, { origin }) {
    requireOrigin(origin);
    const canonical = validateDataMapping(next, { label: 'Requested data mapping' });
    const refusal = this.describeDataMappingRefusal(canonical);
    if (refusal !== null) throw new RangeError(refusal);

    while (this._mappingChangeLock) {
      await this._mappingChangeLock;
    }
    let unlock = null;
    this._mappingChangeLock = new Promise(resolve => {
      unlock = resolve;
    });
    const releases = [];
    try {
      const dimensionManager = this.dimensionManager;
      const current = this.dataMapping;
      const embeddingsChanged = !sameJson(canonical.embeddings, current.embeddings);

      const previous = {
        enabled: [...dimensionManager.getEnabledLayoutKeys()],
        defaults: new Map(
          dimensionManager.getAvailableDimensions()
            .map(dimension => [dimension, dimensionManager.getDefaultLayout(dimension)])
            .filter(([, layoutKey]) => layoutKey !== null)
        ),
      };
      const planned = resolveMappingRepresentations(dimensionManager, canonical);
      const moves = this.planRepresentationMoves(planned);

      // Stage: every layout a view moves to is pinned and loaded first.
      for (const layoutKey of new Set(moves.map(move => move.to))) {
        releases.push(dimensionManager.pinLayout(layoutKey));
        try {
          await dimensionManager.getPositions(layoutKey);
        } catch (error) {
          if (isMappingLoadError(error)) {
            this._unusableEmbeddings.set(error.key, error.reason);
          }
          throw error;
        }
      }

      // Stage every other changed group (mapping-groups.js): their data is
      // loaded and checked before anything is published.
      const groups = await this._stageMappingGroups(current, canonical);
      if (!embeddingsChanged && !groups.changed) return false;

      // Commit: publish the representations, then move the views, then the
      // other groups. A view leaving a disabled layout moves while that
      // layout is still drawn, so the new set is published before the moves
      // and restored after them on failure.
      const moved = [];
      dimensionManager.setRepresentations(planned.enabled, planned.defaults);
      try {
        for (const move of moves) {
          const followed = this.viewFollowsDefault(move.viewId);
          await this.setViewRepresentation(move.viewId, move.to, {
            followsDefault: move.followsDefault,
          });
          moved.push({ ...move, followed });
        }
        await groups.commit();
      } catch (error) {
        const restoreErrors = await groups.rollback();
        try {
          dimensionManager.setRepresentations(previous.enabled, previous.defaults);
        } catch (restoreError) {
          restoreErrors.push(restoreError);
        }
        for (const move of moved.reverse()) {
          try {
            await this.setViewRepresentation(move.viewId, move.from, {
              followsDefault: move.followed,
            });
          } catch (restoreError) {
            restoreErrors.push(restoreError);
          }
        }
        if (restoreErrors.length > 0) {
          throw new AggregateError(
            [error, ...restoreErrors],
            'Applying the data mapping failed and the previous mapping could not be fully restored.'
          );
        }
        throw error;
      }

      this.dataMapping = Object.freeze(canonical);
      this._mappingOrigin = origin;
      this.emit('mapping:changed', { mapping: this.dataMapping, cause: 'apply', origin });
      this.emit('representations:changed', { enabled: this.getEnabledRepresentations() });
      return true;
    } finally {
      for (const release of releases) release();
      unlock();
      this._mappingChangeLock = null;
    }
  }

}

/**
 * The layout provider of an AnnData catalog, for the dimension manager: any
 * usable `obsm` array, read at the columns a reference names.
 *
 * @param {Object} candidates
 * @returns {(ref: {key: string, columns: number[]}) => Object}
 */
export function createMappingLayoutProvider(candidates) {
  return ref => mappingLayoutDescriptor(candidates, ref, ref.columns.length);
}
