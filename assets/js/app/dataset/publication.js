/**
 * @fileoverview The publication of the runtime the page shows: a dataset, a
 * synthetic benchmark scene, or none. A dataset's runtime is staged from its
 * reads (`stageDatasetRuntime`), then committed in one synchronous step that
 * first retires everything of the dataset shown (kept views, the selection
 * under way, open field interactions, the edges, and the history unless the
 * same dataset is read again); a failed commit puts back the runtime that
 * was shown (`restorePreviousRuntime`); the interface settles on it after
 * (`synchronizePublishedDatasetUi`). Making it makes the connectivity owner
 * and the data mapping's runtime, then publishes the empty runtime.
 *
 * It owns the runtime shown: its base URL, dimension manager, stage and
 * publication, read by its clients through the getters it returns, and the
 * neighbor graph in use. A dataset change's transaction (`reload.js`), the
 * synthetic benchmark and the open cells resized in place are its clients;
 * the interface, the history, the host's results and the analysis module are
 * made after it and reached through getters.
 *
 * @module app/dataset/publication
 */

import {
  createObsFieldLoader,
  createVarFieldLoader,
  getEmbeddingsMetadata,
  loadCompleteMappingCandidates,
  loadDatasetGeneration,
  loadMappingCandidates,
  varLoaderMappingOf
} from '../../data/data-loaders.js';
import { anndataCellIdentity, anndataCellPriority } from '../../data/anndata-provider.js';
import { opensOnBestGuess } from '../../data/data-mapping.js';
import { MAPPING_CANDIDATES_ROUTE, resolveAnnDataMapping } from '../../data/dataset-mapping.js';
import { createDimensionManager } from '../../data/dimension-manager.js';
import { getReadActivityLog } from '../../data/read-activity-log.js';
import { getTransferLog } from '../../data/transfer-log.js';
import { createVectorFieldManager, resolveVectorFields } from '../../data/vector-field-manager.js';
import { abortReason, cancelled, isAbortSignal, onAbort, requireSignal } from '../../utils/abort.js';
import { debug } from '../../utils/debug.js';
import { failureDetails, joinFailure, sayFailure } from '../../utils/errors.js';
import { formatCountOf } from '../../utils/format-units.js';
import {
  createDatasetRuntimeRetirementOwner,
  settlePublishedDatasetUi,
  stageDatasetPositionPayload
} from '../dataset-reload-outcome.js';
import { refreshEmptyViewer } from '../opening-progress-view.js';
import { createMappingLayoutProvider } from '../state/managers/mapping-manager.js';
import { NO_DATASET_OPEN } from '../ui/no-dataset.js';


// The parts of a dataset, as the data loaders address them under its base.
function getObsUrl(baseUrl) { return `${baseUrl}obs`; }
function getGeneListUrl(baseUrl) { return `${baseUrl}var`; }
function getConnectivityUrl(baseUrl) { return `${baseUrl}obsp`; }

/**
 * @param {{
 *   state: Object, viewer: Object, notifications: Object, statsEl: HTMLElement|null,
 *   datasetPublicationOwner: ReturnType<typeof import('../dataset-reload-outcome.js').createLatestDatasetPublicationContinuationOwner>,
 *   viewerHostSource: Object|null, shownAnnDataSource: () => Object|null,
 *   initializeConnectivityControls: (graph: Object) => Object,
 *   getUi: () => Object|null, getDatasetHistories: () => Object|null,
 *   getViewerHostResults: () => Object|null, getComparisonModule: () => Object|null,
 * }} options - `datasetPublicationOwner` is made by the caller just before, so a teardown
 *   while this runs retires it; `initializeConnectivityControls` makes the connectivity owner
 *   from the graph's getters and setter.
 */
export function createDatasetPublication({
  state,
  viewer,
  notifications,
  statsEl,
  datasetPublicationOwner,
  viewerHostSource,
  shownAnnDataSource,
  initializeConnectivityControls,
  getUi,
  getDatasetHistories,
  getViewerHostResults,
  getComparisonModule
}) {
  // The base URL of the dataset shown (`anndata://<id>/`):
  // the data loaders address its parts under it.
  let DATASET_BASE_URL = '';

  // The live manager is replaced only when a complete dataset generation and
  // its default position payload have been staged successfully.
  let dimensionManager = createDimensionManager({ baseUrl: DATASET_BASE_URL });
  let activeRuntimeStage = null;
  const runtimeRetirementOwner =
    createDatasetRuntimeRetirementOwner();
  let datasetPublicationGeneration = 0;
  let activeDatasetPublication = null;

  // The empty runtime publishes `{runtimeKind: 'empty'}`; a dataset or a
  // synthetic benchmark publishes the stage that carries its cells.
  function publicationHasCells(publication) {
    if (publication === null || typeof publication !== 'object') {
      throw new TypeError('Cell presence requires one runtime publication.');
    }
    const runtimeKind = publication.stage?.runtimeKind
      ?? publication.runtimeKind;
    if (!['dataset', 'empty', 'synthetic'].includes(runtimeKind)) {
      throw new TypeError(
        `Runtime publication has unknown kind "${runtimeKind}".`
      );
    }
    return runtimeKind !== 'empty';
  }

  function publishRuntimeContinuation(details) {
    const publication = datasetPublicationOwner.publish(details);
    datasetPublicationGeneration = publication.generation;
    activeDatasetPublication = publication;
    getUi()?.publishCellPresence(publicationHasCells(publication));
    // The empty viewer says so, and stops saying it once cells are shown.
    refreshEmptyViewer();
    return publication;
  }

  // The dimension manager each publication replaced, retired once that
  // publication's interface has settled. It is kept beside the publication,
  // not in it: a publication lives as long as its dataset is shown, and
  // anything of the replaced dataset it held (its stage holds every
  // position) would stay in memory as long.
  const replacedDimensionManagers = new WeakMap();

  function publishDatasetReplacement(stage, previousDimensionManager) {
    const publication = publishRuntimeContinuation({ stage });
    replacedDimensionManagers.set(publication, previousDimensionManager);
    return publication;
  }

  function retireReplacedDimensionManager(publication) {
    const replaced = replacedDimensionManagers.get(publication);
    replacedDimensionManagers.delete(publication);
    if (replaced !== undefined) runtimeRetirementOwner.retire(replaced);
  }

  function requireRestorablePublication(expectedPublication) {
    if (
      expectedPublication === null ||
      typeof expectedPublication !== 'object' ||
      activeDatasetPublication !== expectedPublication ||
      expectedPublication.isCurrent() !== true
    ) {
      throw new Error(
        'Runtime restoration requires its exact current publication continuation.'
      );
    }
    return expectedPublication;
  }

  // An unconfirmed highlight selection is owned by the renderer (one unified
  // candidate set shared by the lasso, proximity, and KNN tools) and by the
  // highlight UI (the annotation candidate set plus every undo/redo stack).
  // Neither belongs to DataState, so `state.initScene()` cannot clear them:
  // a selection started on the outgoing dataset would survive replacement and
  // be intersected with candidates from the incoming one, saving a highlight
  // group of rows nobody ever selected. Every dataset replacement retires the
  // selection first. The per-tool cancels publish their exact cancelled-step
  // events, which is what resets the highlight UI's selection state, its step
  // controls, and the preview highlight; the unified cancel clears the shared
  // candidate set for the tool that is not currently active.
  function retireInProgressHighlightSelection() {
    const failures = [];
    for (const retire of [
      () => viewer.cancelAnnotationSelection(),
      () => viewer.cancelLassoSelection(),
      () => viewer.cancelProximitySelection(),
      () => viewer.cancelKnnSelection(),
      () => viewer.cancelUnifiedSelection()
    ]) {
      try {
        retire();
      } catch (error) {
        failures.push(error);
      }
    }
    const exactFailures = [...new Set(failures)];
    if (exactFailures.length === 1) throw exactFailures[0];
    if (exactFailures.length > 1) {
      throw new AggregateError(
        exactFailures,
        'Dataset replacement failed to retire every in-progress highlight selection.'
      );
    }
  }

  // Everything that shows or acts on the shown cells outside the live
  // scene: the dataset's history, kept views, the in-progress selection,
  // open field interactions, and the connectivity edges. Each goes before
  // the replacement touches DataState or the viewer. The history goes
  // first: it stops recording, and a jump under way puts nothing more back
  // (its autosave finishes writing what changed). The same dataset read
  // again on other cells (`keepHistory`: Cells to open, or a history step
  // shown that reads them) keeps its history: the reading is a step of it,
  // or one of its steps shown. Kept views go next, so the live view is the
  // focused one when the rest retire. The viewer drops its edge graph when
  // new points are loaded, so an edge owner retired any later still answers
  // the replacement's first visibility notification and asks the viewer
  // about a graph it no longer has.
  function retireDatasetInteractions({ keepHistory = false } = {}) {
    if (!keepHistory) void getDatasetHistories()?.retire();
    retireKeptViews();
    retireInProgressHighlightSelection();
    getUi()?.prepareDatasetReplacement?.();
    connectivityRuntimeOwner.prepareDatasetReplacement();
  }

  function publishEmptyDatasetRuntime({
    restorationPublication = null
  } = {}) {
    if (
      restorationPublication !== null &&
      typeof restorationPublication !== 'object'
    ) {
      throw new TypeError(
        'Empty dataset runtime publication takes an optional restoration publication.'
      );
    }
    if (restorationPublication !== null) {
      requireRestorablePublication(restorationPublication);
    }
    retireDatasetInteractions();
    DATASET_BASE_URL = '';
    dimensionManager = createDimensionManager({ baseUrl: '' });
    connectivitySummary = null;
    connectivityUrl = null;
    state.setDimensionManager(dimensionManager);
    state.setFieldLoader(null);
    state.setVarFieldLoader(null);
    state.initVarData({ fields: [] });
    state.beginGeneListing(false);
    state.setVectorFieldManager(null);
    state.publishDatasetMapping({ mapping: null, candidates: null, origin: null });
    state.initScene(new Float32Array(), { fields: [], count: 0 });
    state.clearActiveField();
    state.clearActivePageHighlights();
    viewer.updateHighlight(new Uint8Array());
    if (statsEl) statsEl.textContent = NO_DATASET_OPEN;
    activeRuntimeStage = null;
    return restorationPublication !== null
      ? requireRestorablePublication(restorationPublication)
      : publishRuntimeContinuation({ runtimeKind: 'empty' });
  }

  // A reload is bounded by its own transaction signal and publishes no
  // startup phase; only the startup load runs under the startup owner.
  /**
   * Evidence that a dataset's reads are alive (a startup step's
   * `progress`): bytes or requests counted, or bytes of a request still
   * under way arriving, as the Transfers log hears them. A request being
   * made again after a failure is not progress: nothing arrived.
   */
  const datasetReadProgress = onProgress => {
    const arrivals = entries => entries
      .map(entry => `${entry.key}:${entry.bytes}:${entry.requests}:${entry.lastArrivalAt}`)
      .join('|');
    let seen = arrivals(getTransferLog().entries());
    return getTransferLog().subscribe(entries => {
      const now = arrivals(entries);
      if (now === seen) return;
      seen = now;
      onProgress();
    });
  };

  /**
   * The reads still open, as the read activity log names them, and the
   * request being made again after a failure, naming its URL; null when
   * nothing is open.
   */
  function openDatasetReads() {
    const open = getReadActivityLog().entries()
      .filter(activity => activity.status === 'running')
      .map(activity => activity.label);
    const failing = getTransferLog().entries()
      .filter(entry => entry.status === 'active' && entry.retrying !== null)
      .map(entry => entry.retrying);
    const parts = [
      ...(open.length === 0 ? [] : [open.join('; ')]),
      ...(failing.length === 0 ? [] : [`last failure: ${failing.join('; ')}`]),
    ];
    return parts.length === 0 ? null : parts.join(' (') + (parts.length > 1 ? ')' : '');
  }

  const RELOAD_STAGE_PHASES = Object.freeze({
    enter() {},
    step: (_phase, _target, operation) => operation(null)
  });
  const UNCHANGED_URL_PUBLICATION = Object.freeze({
    commit() {},
    rollback() {}
  });

  /**
   * `work`'s outcome, or `signal`'s reason as soon as it aborts. A value
   * `work` produces after that is handed to `discard`, so nothing staged
   * for a superseded change is left behind.
   *
   * @template T
   * @param {Promise<T>} work
   * @param {AbortSignal} signal
   * @param {(value: T) => void} discard
   * @returns {Promise<T>}
   */
  function untilSuperseded(work, signal, discard) {
    const discardLate = () => {
      work.then(value => {
        try {
          discard(value);
        } catch (error) {
          console.error('[Main] A superseded dataset stage could not be discarded:', error);
        }
      }, () => {});
    };
    if (signal.aborted) {
      discardLate();
      return Promise.reject(abortReason(signal));
    }
    return new Promise((resolve, reject) => {
      const stopWaiting = onAbort(signal, () => {
        discardLate();
        reject(abortReason(signal));
      });
      work.then(
        value => {
          stopWaiting();
          resolve(value);
        },
        error => {
          stopWaiting();
          reject(error);
        }
      );
    });
  }

  function requireDatasetChangeTransaction(transaction) {
    if (
      transaction === null ||
      typeof transaction !== 'object' ||
      !isAbortSignal(transaction.signal) ||
      typeof transaction.assertCurrent !== 'function' ||
      typeof transaction.isCurrent !== 'function' ||
      typeof transaction.isLatest !== 'function'
    ) {
      throw new TypeError(
        'A dataset change requires the transaction its caller began.'
      );
    }
    return transaction;
  }

  /**
   * The data mapping one staged generation is shown with, the AnnData
   * candidate catalog it was resolved from, and whether it was guessed.
   * Every dataset is an AnnData file -- read in the browser, whether opened
   * here, from a link or a catalog, or served by Python -- and states its
   * mapping in its candidate catalog, because its graph and expression
   * matrix are not visible in the identity.
   */
  async function resolveStagedDataMapping({
    baseUrl,
    candidateAnnDataBinding,
    generation,
    signal
  }) {
    const candidates = await loadMappingCandidates(
      `${baseUrl}${MAPPING_CANDIDATES_ROUTE}`,
      { candidateAnnDataBinding, signal }
    );
    return Object.freeze({
      mapping: resolveAnnDataMapping(candidates, generation.identity),
      candidates,
      // A guess beside the file's own default (its UMAP's width named, the
      // others guessed) is no best-guess opening: only a file naming none is.
      origin: opensOnBestGuess(candidates.defaults.embeddings.defaults, candidates.guessed)
        ? 'best_guess'
        : 'default'
    });
  }

  async function stageDatasetRuntime({
    baseUrl,
    candidateAnnDataBinding,
    datasetSource,
    expectedIdentityId,
    phases,
    signal
  }) {
    if (
      typeof baseUrl !== 'string' ||
      baseUrl.length === 0 ||
      !baseUrl.endsWith('/')
    ) {
      throw new Error(
        'Selected dataset base URL must be a non-empty string ending in "/".'
      );
    }
    if (
      typeof expectedIdentityId !== 'string' ||
      expectedIdentityId.length === 0
    ) {
      throw new Error(
        'Selected dataset identity id must be a non-empty string.'
      );
    }
    requireSignal(signal, 'Dataset runtime staging signal');
    if (datasetSource === null || typeof datasetSource !== 'object') {
      throw new TypeError(
        'Dataset runtime staging requires the source the dataset is staged from.'
      );
    }
    const candidateDimensionManager = createDimensionManager({
      baseUrl,
      candidateAnnDataBinding
    });

    try {
      const generation = await phases.step(
        'dataset',
        baseUrl,
        stepSignal => loadDatasetGeneration(baseUrl, {
          candidateAnnDataBinding,
          expectedIdentityId,
          signal: stepSignal === null
            ? signal
            : AbortSignal.any([signal, stepSignal])
        }),
        { progress: datasetReadProgress, pending: openDatasetReads }
      );
      const mapping = await resolveStagedDataMapping({
        baseUrl,
        candidateAnnDataBinding,
        generation,
        signal
      });
      phases.enter('positions');
      const embeddingsMetadata = getEmbeddingsMetadata(generation.identity);
      candidateDimensionManager.initFromMetadata(embeddingsMetadata);
      // An AnnData file can plot any obsm array on request
      // (`obsm/{i}/{cols}`), so the embeddings its mapping
      // turns on beyond the identity's are registered as layouts by
      // reference.
      candidateDimensionManager.setLayoutProvider(
        createMappingLayoutProvider(mapping.candidates)
      );
      // loadDatasetGeneration has already proved this count against the obs
      // and var field lists and the graph summary, so it is the dataset's
      // exact cell axis. publishCellCount must follow initFromMetadata,
      // which clears the cache and zeroes the axis.
      candidateDimensionManager.publishCellCount(generation.identity.stats.n_cells);
      const positionStage = await stageDatasetPositionPayload({
        generation,
        dimensionManager: candidateDimensionManager,
        signal
      });

      // Every obs and var field is one value per cell, and the generation
      // has already proved both field lists declare exactly stats.n_cells
      // points: each field read is checked against that count.
      const fieldLoader = createObsFieldLoader(
        getObsUrl(baseUrl),
        {
          pointCount: generation.obsFields.n_points,
          outlierMinPoints: generation.obsFields.outlier_min_points,
          storedOutlierLatentKey: generation.obsFields.stored_outlier_latent_key,
        }
      );
      // The genes' loader needs no gene name: the list itself is read
      // after the first view (`DataState.listPublishedGenes`).
      const varFieldLoader = generation.identity.stats.n_genes > 0
        ? createVarFieldLoader(
            getGeneListUrl(baseUrl),
            {
              pointCount: generation.identity.stats.n_cells,
              // How its genes' values are transformed and which are highly
              // variable, as the mapping it opens with says.
              mapping: varLoaderMappingOf(mapping.mapping),
            }
          )
        : null;
      const vectorFieldManager = createVectorFieldManager({
        baseUrl,
        vectorFields: resolveVectorFields({
          mapping: mapping.mapping,
          candidates: mapping.candidates,
          dimensionManager: candidateDimensionManager,
          defaultField: generation.identity.vector_field_default ?? null
        }),
        dimensionManager: candidateDimensionManager
      });

      return Object.freeze({
        baseUrl,
        dimensionManager: candidateDimensionManager,
        mapping,
        embeddingsMetadata,
        fieldLoader,
        generation,
        positions: positionStage.positions,
        // Which of the dataset's cells were opened (a subsample's, or
        // every cell): published with the scene.
        cellIdentity: anndataCellIdentity(baseUrl, candidateAnnDataBinding),
        // The order levels of detail and progressive analyses take them in.
        cellPriority: anndataCellPriority(baseUrl, candidateAnnDataBinding),
        runtimeKind: 'dataset',
        defaultDimension: positionStage.defaultDimension,
        varFieldLoader,
        vectorFieldManager
      });
    } catch (error) {
      try {
        runtimeRetirementOwner.retire(candidateDimensionManager);
      } catch (retirementError) {
        throw new AggregateError(
          [error, retirementError],
          'Dataset runtime staging and candidate retirement failed.'
        );
      }
      throw error;
    }
  }

  let connectivitySummary = null;
  // Where the graph in use is read from: the dataset's own (`obsp`), or a
  // mapped graph's (`obsp/{p}`) once the data mapping names another one.
  let connectivityUrl = null;
  // The connectivity controls and the owner of the graph's edges, made
  // once, before the first publication (no graph exists yet): each
  // publication tells them its graph, or that it has none.
  const connectivityRuntimeOwner = initializeConnectivityControls({
    getDatasetBaseUrl: () => DATASET_BASE_URL,
    getPublicationGeneration: () => datasetPublicationGeneration,
    getGraphSummary: () => connectivitySummary,
    getGraphUrl: () => connectivityUrl,
    setGraph: (summary, url) => {
      connectivitySummary = summary;
      connectivityUrl = url;
    }
  });
  // A data-mapping transaction reads the chosen arrays under the open
  // dataset's base and publishes a new neighbor graph through its owner.
  state.setMappingRuntime({
    getBaseUrl: () => DATASET_BASE_URL,
    // The vector fields one mapping uses, for the dataset that is shown.
    createVectorFieldManager: mapping => {
      if (activeRuntimeStage === null) {
        throw new Error('No dataset is shown to draw vector fields for.');
      }
      const shownDimensionManager = state.getDimensionManager();
      return createVectorFieldManager({
        baseUrl: DATASET_BASE_URL,
        vectorFields: resolveVectorFields({
          mapping,
          candidates: state.getMappingCandidates(),
          dimensionManager: shownDimensionManager,
          defaultField: activeRuntimeStage.generation.identity.vector_field_default ?? null
        }),
        dimensionManager: shownDimensionManager
      });
    },
    getConnectivityGraph: connectivityRuntimeOwner.getConnectivityGraph,
    replaceConnectivityGraph: connectivityRuntimeOwner.replaceConnectivityGraph,
    // Results computed from the previous gene list are not kept: analysis
    // windows close and their caches clear, as for a new dataset.
    resetGeneAnalysis: () => {
      if (getComparisonModule() === null) return;
      void getComparisonModule().resetForDatasetReload({ reason: 'var-axis' })
        .catch(error => {
          console.error('[Main] Analysis reset after a gene-list change failed:', error);
        });
    }
  });
  if (
    typeof connectivityRuntimeOwner.prepareDatasetReplacement !==
    'function' ||
    typeof connectivityRuntimeOwner.synchronizeDatasetPublication !==
    'function'
  ) {
    throw new TypeError(
      'Dataset runtime requires one initialized connectivity owner.'
    );
  }

  function commitDatasetRuntimeStage(
    stage,
    { restorationPublication = null, keepHistory = false } = {}
  ) {
    if (
      stage === null ||
      typeof stage !== 'object' ||
      stage.runtimeKind !== 'dataset'
    ) {
      throw new TypeError(
        'Dataset runtime publication requires one exact staged generation.'
      );
    }
    if (
      restorationPublication !== null &&
      typeof restorationPublication !== 'object'
    ) {
      throw new TypeError(
        'Dataset runtime restoration publication must be an object or null.'
      );
    }
    if (restorationPublication !== null) {
      requireRestorablePublication(restorationPublication);
    }
    const previousDimensionManager = dimensionManager;

    // This function is intentionally synchronous. The reload transaction is
    // checked immediately before this sole publication call, so no newer
    // selection can interleave with the dataset-owned state replacement.
    retireDatasetInteractions({ keepHistory });
    DATASET_BASE_URL = stage.baseUrl;
    dimensionManager = stage.dimensionManager;
    connectivitySummary = stage.generation.connectivitySummary;
    connectivityUrl = connectivitySummary === null
      ? null
      : getConnectivityUrl(stage.baseUrl);

    state.setDimensionManager(dimensionManager);
    state.setFieldLoader(stage.fieldLoader);
    state.setVarFieldLoader(stage.varFieldLoader);
    // The var inventory is published empty: the first view never waits
    // for gene names. A dataset with genes lists them as soon as it is
    // published (`listPublishedGenes` below); until then its gene list is
    // pending, and everything that reads it (session capture, filters,
    // user-defined fields) treats it as a dataset whose genes are being
    // read.
    state.initVarData({ fields: [] });
    state.beginGeneListing(stage.varFieldLoader !== null);
    state.initScene(stage.positions, stage.generation.obsFields);
    if (stage.cellIdentity !== null) state.setCellIdentity(stage.cellIdentity);
    if (stage.cellPriority !== null) state.setCellPriority(stage.cellPriority);
    state.clearActiveField();
    state.clearActivePageHighlights();
    state.setVectorFieldManager(stage.vectorFieldManager);
    state.publishDatasetMapping(stage.mapping);
    activeRuntimeStage = stage;
    listPublishedGenes(stage);
    completePublishedMapping(stage);

    return restorationPublication !== null
      ? requireRestorablePublication(restorationPublication)
      : publishDatasetReplacement(stage, previousDimensionManager);
  }

  /**
   * Read the gene list of a dataset just published (a new one, or one
   * restored after a failed change; `DataState.listPublishedGenes`).
   * Everything the first view draws is in place already: nothing it needs
   * waits for this read. Everything that names genes shows them loading
   * until `genes:listed`.
   */
  function listPublishedGenes(stage) {
    if (!state.areGenesPending()) return;
    void state.listPublishedGenes().catch(error => {
      if (activeRuntimeStage !== stage) return;
      console.error('[Main] The gene list could not be read:', error);
      notifications.error(
        `${joinFailure(`The dataset is open, but its gene names could not be read`, sayFailure(error))}`,
        { ...failureDetails(error), category: 'data' }
      );
    });
  }

  /**
   * Complete the data mapping's catalog of a dataset just published (or
   * grown or reordered in place): whether each expression matrix holds
   * counts is read from its values, so never on the first view's path
   * (`BaseAnnDataAdapter.completeMappingCandidates`). Adopted while the
   * stage is still the one shown; the mapping's choices never change.
   */
  function completePublishedMapping(stage) {
    if (stage.mapping?.candidates?.kind !== 'anndata') return;
    void loadCompleteMappingCandidates(`${stage.baseUrl}${MAPPING_CANDIDATES_ROUTE}`).then(candidates => {
      if (activeRuntimeStage !== stage) return;
      state.adoptMappingCandidates(candidates);
    }).catch(error => {
      if (activeRuntimeStage !== stage) return;
      console.warn('[Main] Whether the expression matrices hold counts could not be read:', error);
    });
  }

  function commitSyntheticRuntimeStage(
    stage,
    { restorationPublication = null } = {}
  ) {
    if (
      stage === null ||
      typeof stage !== 'object' ||
      stage.runtimeKind !== 'synthetic' ||
      !(stage.positions instanceof Float32Array) ||
      !(stage.colors instanceof Uint8Array)
    ) {
      throw new TypeError(
        'Synthetic runtime publication requires one exact staged scene.'
      );
    }
    if (
      restorationPublication !== null &&
      typeof restorationPublication !== 'object'
    ) {
      throw new TypeError(
        'Synthetic runtime restoration publication must be an object or null.'
      );
    }
    if (restorationPublication !== null) {
      requireRestorablePublication(restorationPublication);
    }
    const previousDimensionManager = dimensionManager;
    retireDatasetInteractions();
    state.beginGeneListing(false);
    state.initSyntheticScene({
      positions: stage.positions,
      colors: stage.colors,
      dimensionLevel: stage.dimensionLevel,
      dimensionManager: stage.dimensionManager
    });
    // The opening point size and the antialiasing decision are derived from
    // how many points are being drawn, and a synthetic publication replaces
    // the whole cloud. They are derived here too, not only where a dataset
    // *identity* is published: a synthetic cloud would otherwise be drawn at
    // the size chosen for the previous dataset's count. The count is
    // authoritative here — `initSyntheticScene` measures the same
    // `positions.length / dimensionLevel`.
    getUi()?.applyDatasetRenderDefaults?.(
      stage.positions.length / stage.dimensionLevel,
      stage.dimensionLevel
    );
    DATASET_BASE_URL = '';
    dimensionManager = stage.dimensionManager;
    connectivitySummary = null;
    connectivityUrl = null;
    activeRuntimeStage = stage;
    return restorationPublication !== null
      ? requireRestorablePublication(restorationPublication)
      : publishDatasetReplacement(stage, previousDimensionManager);
  }

  // A failed publication puts back the runtime that was shown, empty or
  // not. Its connectivity edges were retired with the attempt (they are
  // read again when edges are next turned on), so the controls are
  // republished for the restored graph.
  function restorePreviousRuntime(stage, restorationPublication, { keepHistory = false } = {}) {
    if (stage === null) {
      publishEmptyDatasetRuntime({ restorationPublication });
    } else if (stage.runtimeKind === 'synthetic') {
      commitSyntheticRuntimeStage(stage, { restorationPublication });
    } else {
      commitDatasetRuntimeStage(stage, { restorationPublication, keepHistory });
    }
    connectivityRuntimeOwner.synchronizeDatasetPublication();
  }

  function assertCurrentDatasetPublication(publication) {
    if (
      publication === null ||
      typeof publication !== 'object' ||
      !Number.isSafeInteger(publication.generation) ||
      publication.generation < 1 ||
      !isAbortSignal(publication.signal) ||
      typeof publication.isCurrent !== 'function' ||
      typeof publication.assertCurrent !== 'function'
    ) {
      throw new TypeError(
        'Dataset continuation requires one exact publication token.'
      );
    }
    publication.assertCurrent();
    if (publication.generation !== datasetPublicationGeneration) {
      throw cancelled('superseded',
        'Dataset continuation was superseded by a newer runtime publication.'
      );
    }
  }

  // Kept views show the shown dataset's cells: their GPU buffers and their
  // DataState contexts are sized and indexed by it, and the renderer will
  // not replace its live points with another count while any is published.
  // They go first, before the replacement touches anything else. A failed
  // replacement cannot give them back either way: restoring the previous
  // dataset republishes its scene, which starts with the live view alone.
  function retireKeptViews() {
    const hadSnapshots = viewer.hasSnapshots();
    if (typeof hadSnapshots !== 'boolean') {
      throw new TypeError(
        'Dataset view retirement requires an exact viewer snapshot inventory.'
      );
    }
    const retirementFailures = [];
    if (hadSnapshots) {
      try {
        viewer.clearSnapshotViews();
      } catch (error) {
        retirementFailures.push(error);
      }
    }
    // Clear the state's own inventory whatever the renderer did, so a prior
    // partial failure cannot preserve a stale active-view identity.
    try {
      state.clearSnapshotViews();
    } catch (error) {
      retirementFailures.push(error);
    }
    // A view's name is of the views of its dataset: the next dataset's
    // history starts from an unnamed live view (a reading of the same
    // dataset carries its names back with the views, `view-carry.js`).
    try {
      viewer.setViewName('live', null);
    } catch (error) {
      retirementFailures.push(error);
    }

    const hasSnapshots = viewer.hasSnapshots();
    const activeViewId = state.getActiveViewId();
    const layout = viewer.getViewLayout();
    if (
      hasSnapshots !== false ||
      activeViewId !== 'live' ||
      layout === null ||
      typeof layout !== 'object' ||
      layout.activeId !== 'live' ||
      layout.liveViewHidden !== false
    ) {
      retirementFailures.push(
        new Error(
          'Kept-view retirement did not restore the visible live view.'
        )
      );
    }
    if (retirementFailures.length === 1) {
      throw retirementFailures[0];
    }
    if (retirementFailures.length > 1) {
      throw new AggregateError(
        retirementFailures,
        'Kept-view retirement was incomplete.'
      );
    }
  }

  async function synchronizePublishedDatasetUi(
    activeMetadata,
    publication
  ) {
    if (
      publication === null ||
      typeof publication !== 'object' ||
      publication.stage?.runtimeKind !== 'dataset'
    ) {
      throw new TypeError(
        'Published dataset UI synchronization requires one dataset publication.'
      );
    }
    return await settlePublishedDatasetUi({
      synchronize: async () => {
        assertCurrentDatasetPublication(publication);
        try {
          await getUi()?.settleFieldInteractions?.();
        } finally {
          assertCurrentDatasetPublication(publication);
        }
        connectivityRuntimeOwner.synchronizeDatasetPublication();
        if (getComparisonModule() !== null) {
          try {
            await getComparisonModule().resetForDatasetReload({
              reason: 'dataset-publication'
            });
          } finally {
            assertCurrentDatasetPublication(publication);
          }
        }
        debug.log(
          `[Main] Published dataset "${publication.stage.generation.identity.id}"`
        );
        const publishedGraph = publication.stage.generation.connectivitySummary;
        if (publishedGraph) {
          debug.log(publishedGraph.n_edges === null
            ? 'Loaded the neighbor graph summary; its edges are counted when they are read.'
            : `Loaded a neighbor graph of ${formatCountOf(publishedGraph.n_edges, 'edge')}.`);
        }
        getUi().refreshDatasetUI(activeMetadata);
        // The notebook learns the mapping each dataset opens with.
        if (viewerHostSource !== null && state.getDataMapping() !== null) {
          void viewerHostSource.notifyDataMapping({
            origin: state.getDataMappingOrigin(),
            mapping: state.getDataMapping()
          }).catch(error => {
            console.error('[Main] Viewer host data-mapping report failed:', error);
          });
        }
        // Each dataset opened starts a new epoch of results for the host:
        // its own dataset's, or none while another one is open.
        if (getViewerHostResults() !== null) {
          void getViewerHostResults().datasetOpened().catch(error => {
            console.error('[Main] Sending the results of the opened dataset to the host failed:', error);
          });
        }
        // The cell count is the one thing a sensible opening point size
        // depends on, and it is known here for the first time. Applied before
        // `restoreAdvertisedDatasetState`, so a saved session or a published
        // preset still overrides it. A progressive opening's first view is
        // drawn as the cells it grows to will be (`open-cells-resize.js`).
        getUi().applyDatasetRenderDefaults(
          shownAnnDataSource()?.getCellSubset?.()?.growth?.target
            ?? publication.stage.generation.identity.stats.n_cells,
          publication.stage.generation.identity.embeddings.default_dimension
        );
      },
      finalize: () => {
        retireReplacedDimensionManager(publication);
      },
      reportFailure: error => {
        if (publication.isCurrent() !== true) return;
        console.error(
          '[Main] Dataset was published, but UI synchronization failed:',
          error
        );
        notifications.error(
          `The dataset is loaded, but its controls could not be ` +
          `synchronized: ${sayFailure(error)}`,
          { ...failureDetails(error),
            category: 'data',
            title: 'Dataset controls unavailable',
            duration: 0
          }
        );
      }
    });
  }

  // Startup publishes the empty runtime and builds the whole interface
  // before any dataset is staged. The startup selection is then loaded as
  // one ordinary dataset change (see the end of this bootstrap), so every
  // data control is live while it loads and can replace it.
  const unusedDimensionManager = dimensionManager;
  publishEmptyDatasetRuntime();
  runtimeRetirementOwner.retire(unusedDimensionManager);

  return Object.freeze({
    runtimeRetirementOwner,
    connectivityRuntimeOwner,
    publicationHasCells,
    retireReplacedDimensionManager,
    retireInProgressHighlightSelection,
    publishEmptyDatasetRuntime,
    datasetReadProgress,
    openDatasetReads,
    RELOAD_STAGE_PHASES,
    UNCHANGED_URL_PUBLICATION,
    untilSuperseded,
    requireDatasetChangeTransaction,
    stageDatasetRuntime,
    commitDatasetRuntimeStage,
    completePublishedMapping,
    commitSyntheticRuntimeStage,
    restorePreviousRuntime,
    assertCurrentDatasetPublication,
    retireKeptViews,
    synchronizePublishedDatasetUi,
    getDatasetBaseUrl: () => DATASET_BASE_URL,
    getDimensionManager: () => dimensionManager,
    getActiveStage: () => activeRuntimeStage,
    getActivePublication: () => activeDatasetPublication,
    getPublicationGeneration: () => datasetPublicationGeneration,
    // The open cells grown or cut in place adopt their stage as the one shown.
    adoptStage: stage => {
      activeRuntimeStage = stage;
    }
  });
}
