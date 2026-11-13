/**
 * @fileoverview One change of the dataset shown, as a transaction: a dataset
 * opened (`reloadActiveDatasetInPlace`, shown from its first moment by its
 * opening: `reloadActiveDatasetShown`) or None (`clearActiveDatasetInPlace`).
 * Work that is not kept is asked about first; the dataset is staged under
 * the change's signal, its GPU stores made before anything is replaced, then
 * published, with each of its three failures unwinding what it had done
 * (the data source's stage, the address, the runtime, the history). Once
 * published: its history opened and begun, its starting view, its first
 * coloring, My datasets, and a progressive opening's growth.
 *
 * It owns the order of a change and what a failure of it puts back. The
 * publication itself is `publication.js`'s, the starting view
 * `published-state.js`'s, the transaction (who supersedes whom)
 * `dataset-reload-outcome.js`'s; the startup's dataset is this same change
 * (`isStartupLoad`), under the start-up's phases.
 *
 * @module app/dataset/reload
 */

import { createCandidateAnnDataBinding } from '../../data/anndata-provider.js';
import { beginOpening } from '../../data/opening-progress.js';
import { recordFirstFrame } from '../../data/opening-cost.js';
import { runAfterNextFrame } from '../../rendering/frame-phases.js';
import { cancelled, isCancellation, onAbort } from '../../utils/abort.js';
import { debug } from '../../utils/debug.js';
import { failureDetails, failureText, sayFailure } from '../../utils/errors.js';
import { formatCountOf } from '../../utils/format-units.js';
import { yieldToMacrotask } from '../../utils/yield-macrotask.js';
import { DATA_LOAD_METHODS } from '../data-load-methods.js';
import {
  handleDatasetReloadFailure,
  settlePublishedDatasetStateOutcome,
  settlePublishedDatasetUi
} from '../dataset-reload-outcome.js';
import { colorByFirstField } from '../first-coloring.js';
import { recordDatasetOpened } from '../library/my-datasets.js';
import { analytics } from '../optional-analytics.js';
import { prepareUrlForDatasetSelection, prepareUrlForDataSource } from '../url-state.js';

/**
 * Make the dataset changes, once the session and its histories exist and just
 * before the interface, which takes `reloadActiveDatasetShown` and
 * `clearActiveDatasetInPlace`.
 *
 * @param {{
 *   state: Object, viewer: Object, notifications: Object, dataSourceManager: Object,
 *   startup: Object, startupOpening: Object, datasetHistories: Object,
 *   confirmDatasetReplacement: (transaction: Object, change: Object) => Promise<void>,
 *   shownAnnDataSource: () => Object|null,
 *   cancelPublishedDatasetStateAndWait: () => Promise<void>,
 *   restoreAdvertisedDatasetState: (options: {requestStep: Function, signal: AbortSignal}) => Promise<Object>,
 *   datasetPublication: ReturnType<typeof import('./publication.js').createDatasetPublication>,
 *   getUi: () => Object, getComparisonModule: () => Object|null,
 *   getOpenCellsResize: () => Object|null, getPageHiddenCount: () => number,
 *   onGrowthStarted: (growth: {shown: Object, signal: AbortSignal}) => void,
 * }} options - `getUi` and `getOpenCellsResize` read what is made after this;
 *   `onGrowthStarted` hands the start-up the growth to resume when the page is shown again.
 * @returns {Readonly<{
 *   reloadActiveDatasetShown: (selection: Object) => Promise<boolean>,
 *   clearActiveDatasetInPlace: (transaction: Object) => Promise<boolean>,
 * }>}
 */
export function createDatasetChanges({

  state,
  viewer,
  notifications,
  dataSourceManager,
  startup,
  startupOpening,
  datasetHistories,
  confirmDatasetReplacement,
  shownAnnDataSource,
  cancelPublishedDatasetStateAndWait,
  restoreAdvertisedDatasetState,
  getUi,
  getComparisonModule,
  getOpenCellsResize,
  getPageHiddenCount,
  onGrowthStarted,
  datasetPublication: {
    runtimeRetirementOwner,
    publishEmptyDatasetRuntime,
    datasetReadProgress,
    openDatasetReads,
    RELOAD_STAGE_PHASES,
    UNCHANGED_URL_PUBLICATION,
    untilSuperseded,
    requireDatasetChangeTransaction,
    stageDatasetRuntime,
    commitDatasetRuntimeStage,
    restorePreviousRuntime,
    assertCurrentDatasetPublication,
    synchronizePublishedDatasetUi,
    connectivityRuntimeOwner,
    getActiveStage,
    getActivePublication,
    getDimensionManager
  }
}) {
  // Stage one exact manager/source/runtime/URL generation before publishing
  // any of it. This also activates not-yet-registered Remote/link
  // connection candidates without replacing the prior transport early.
  //
  // `transaction` is the dataset-change transaction the caller began when
  // the user acted (see createLatestDatasetReloadCoordinator), so work the
  // caller did before this call — reading a file, connecting a server — is
  // already owned by it. `startup` marks the one load the bootstrap starts:
  // its network awaits run as deadline-bound startup steps, its progress is
  // shown, it does not rewrite the address the page was opened with, and a
  // failure that no newer choice superseded is startup's to explain.
  //
  // `step` names each wait that is not a read of the dataset (reads name
  // themselves in the opening), so an opening that stalls says which one
  // it is in (`data/opening-progress.js`).
  async function reloadActiveDatasetInPlace(selection, {
    step = /** @type {(text: string) => void} */ (() => {}),
    named = /** @type {(name: string) => void} */ (() => {}),
  } = {}) {
    const activationKeys = [
      'datasetId',
      'loadMethod',
      'name',
      'source',
      'sourceType',
      'startup',
      'transaction'
    ];
    const activationShapeMessage =
      'Dataset activation must contain exactly datasetId, loadMethod, ' +
      'name, source, sourceType, startup, and transaction.';
    if (
      selection === null ||
      typeof selection !== 'object' ||
      Array.isArray(selection) ||
      Object.getPrototypeOf(selection) !== Object.prototype
    ) {
      throw new TypeError(activationShapeMessage);
    }
    const ownActivationKeys = Reflect.ownKeys(selection);
    if (
      ownActivationKeys.length !== activationKeys.length ||
      ownActivationKeys.some(
        key =>
          typeof key !== 'string' ||
          !activationKeys.includes(key)
      )
    ) {
      throw new TypeError(activationShapeMessage);
    }
    for (const key of activationKeys) {
      const descriptor =
        Object.getOwnPropertyDescriptor(selection, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        throw new TypeError(
          `Dataset activation ${key} must be an enumerable own data field.`
        );
      }
    }
    const {
      datasetId,
      loadMethod,
      name: datasetName,
      source,
      sourceType,
      startup: isStartupLoad,
      transaction: reloadTransaction
    } = selection;
    if (datasetName !== null && (typeof datasetName !== 'string' || datasetName.length === 0)) {
      throw new TypeError('Dataset activation name must be a non-empty string or null.');
    }
    if (typeof isStartupLoad !== 'boolean') {
      throw new TypeError('Dataset activation startup must be a boolean.');
    }
    requireDatasetChangeTransaction(reloadTransaction);
    reloadTransaction.assertCurrent();

    const dataLoad = isStartupLoad
      ? analytics.beginDataLoad(loadMethod, sourceType, {
          fromNavigation: true,
          datasetId
        })
      : analytics.beginDataLoad(loadMethod, sourceType);
    const stagePhases = isStartupLoad ? startup : RELOAD_STAGE_PHASES;
    let selectionStage = null;
    let runtimeStage = null;
    let urlPublication = null;
    // When the page starts showing the cells read (their GPU stores made
    // next): what showing a cell costs is measured from here to their
    // first frame (`data/opening-cost.js`), while the page stays shown.
    let showingStartedAt = null;
    let hiddenBeforeShowing = 0;

    try {
      // Work on the dataset shown that is not kept is asked about first;
      // the same dataset read on other cells keeps its history (no ask).
      if (!isStartupLoad && loadMethod !== DATA_LOAD_METHODS.SUBSAMPLE) {
        step('Asking before the dataset shown is replaced');
        await confirmDatasetReplacement(reloadTransaction, { to: datasetName });
      }
      // A newer dataset change ends this step at once: a catalog dataset
      // being opened for it stops (the stage's signal), a served store
      // finishes opening, and startup must not wait out its deadline behind
      // a choice the user already replaced. A stage that lands later is
      // discarded.
      // Opening reads the dataset's metadata, field lists and the embedding
      // its first view draws; every request of it bounds itself, so the
      // step stalls only when nothing at all arrives for a whole deadline,
      // and then names the reads still open.
      selectionStage = await stagePhases.step(
        'dataset',
        datasetName === null ? 'the host of the dataset' : `the host of "${datasetName}"`,
        () => untilSuperseded(
          dataSourceManager.stageDatasetSelection(
            sourceType,
            datasetId,
            { loadMethod, source, signal: reloadTransaction.signal }
          ),
          reloadTransaction.signal,
          stage => dataSourceManager.discardDatasetSelection(stage)
        ),
        { progress: datasetReadProgress, pending: openDatasetReads }
      );
      reloadTransaction.assertCurrent();
      // Its name is read with its metadata, the opening's first read: the opening says it from
      // here on, not the id the address or the catalog gave.
      if (typeof selectionStage.metadata?.name === 'string') named(selectionStage.metadata.name);
      // The address the page was opened with already names the startup
      // selection (or names nothing, for the catalog default), except a
      // link's: `?data=` then names it in its provider's form (a pasted
      // Drive link as `gdrive:<id>`), as opening it from the bar does.
      urlPublication = isStartupLoad && sourceType !== 'link'
        ? UNCHANGED_URL_PUBLICATION
        : prepareUrlForDatasetSelection({
            datasetId,
            source,
            sourceType
          });
      const candidateAnnDataBinding = createCandidateAnnDataBinding(
        selectionStage.baseUrl,
        source ?? dataSourceManager.getSource(sourceType)
      );
      step('Preparing the first view');
      runtimeStage = await stageDatasetRuntime({
        baseUrl: selectionStage.baseUrl,
        candidateAnnDataBinding,
        // The same source `stageDatasetSelection` staged the dataset from.
        datasetSource: source ?? dataSourceManager.getSource(sourceType),
        expectedIdentityId: selectionStage.identityId,
        phases: stagePhases,
        signal: reloadTransaction.signal
      });
      reloadTransaction.assertCurrent();
      step("Stopping the previous dataset's saved-state restore");
      await cancelPublishedDatasetStateAndWait();
      reloadTransaction.assertCurrent();
      // The dataset's GPU stores are allocated here, in a task of their
      // own, once the GPU has done the work queued before (startup's
      // programs, the frames drawn so far; waited for between tasks): the
      // publication below then reads nothing back, and a dataset the
      // device cannot hold is refused before anything is replaced.
      step('Waiting for the GPU to finish the frames already queued');
      await viewer.whenGpuIdle();
      reloadTransaction.assertCurrent();
      // The layout the live view opens on (`setDimensionManager`), whose
      // positions the stage holds.
      const stagedLayout = runtimeStage.dimensionManager.getDefaultLayoutKey();
      const stagedDimension = stagedLayout === null
        ? 0
        : runtimeStage.dimensionManager.getLayout(stagedLayout).dimension;
      const stagedPointCount = stagedDimension === 0
        ? 0
        : runtimeStage.positions.length / stagedDimension;
      // Positions that are not whole cells are refused by the publication
      // itself, with its own message.
      if (Number.isSafeInteger(stagedPointCount) && stagedPointCount > 0) {
        step('Allocating the GPU memory for the cells');
        showingStartedAt = performance.now();
        hiddenBeforeShowing = document.visibilityState === 'hidden' ? -1 : getPageHiddenCount();
        viewer.prepareDataStores(stagedPointCount, stagedDimension);
        // The publication runs in a task of its own.
        await yieldToMacrotask();
        reloadTransaction.assertCurrent();
      }
    } catch (err) {
      const stagingErrors = [err];
      try {
        viewer.releasePreparedDataStores();
      } catch (releaseError) {
        stagingErrors.push(releaseError);
      }
      if (runtimeStage !== null) {
        try {
          runtimeRetirementOwner.retire(
            runtimeStage.dimensionManager
          );
        } catch (retirementError) {
          stagingErrors.push(retirementError);
        }
      }
      if (selectionStage !== null) {
        try {
          dataSourceManager.discardDatasetSelection(selectionStage);
        } catch (discardError) {
          stagingErrors.push(discardError);
        }
      }
      const exactError = stagingErrors.length === 1
        ? err
        : new AggregateError(
            stagingErrors,
            'Dataset staging failure, retirement, or selection discard failed.'
          );
      return handleDatasetReloadFailure({
        error: exactError,
        transaction: reloadTransaction,
        cancel: () => dataLoad.cancel(),
        reportFailure: failure => {
          // A failed startup load is logged once, by the startup that
          // explains it (its failed opening, or the startup failure).
          if (!isStartupLoad) {
            console.error(
              '[Main] Failed to reload dataset in-place:',
              failure
            );
          }
          dataLoad.fail(failure, {
            datasetId,
            metadata: selectionStage?.metadata ?? null
          });
        }
      });
    }

    // All fallible dataset I/O and validation has completed, and the owner
    // was rechecked. Publication is one synchronous, non-interleavable step.
    let managerPublication;
    let publishedUrl = false;
    let managerCommitStarted = false;
    try {
      urlPublication.commit();
      publishedUrl = true;
      managerCommitStarted = true;
      managerPublication =
        dataSourceManager.commitDatasetSelection(selectionStage);
    } catch (error) {
      const publicationErrors = [error];
      if (publishedUrl) {
        try {
          urlPublication.rollback();
        } catch (rollbackError) {
          publicationErrors.push(rollbackError);
        }
      }
      if (!managerCommitStarted) {
        try {
          dataSourceManager.discardDatasetSelection(selectionStage);
        } catch (discardError) {
          publicationErrors.push(discardError);
        }
      }
      try {
        runtimeRetirementOwner.retire(
          runtimeStage.dimensionManager
        );
      } catch (retirementError) {
        publicationErrors.push(retirementError);
      }
      const exactError = publicationErrors.length === 1
        ? error
        : new AggregateError(
            publicationErrors,
            'Dataset selection publication, rollback, or staged-runtime retirement failed.'
          );
      return handleDatasetReloadFailure({
        error: exactError,
        transaction: reloadTransaction,
        cancel: () => dataLoad.cancel(),
        reportFailure: failure => {
          console.error('[Main] Failed to publish dataset selection:', failure);
          dataLoad.fail(failure, {
            datasetId,
            metadata: selectionStage.metadata
          });
        }
      });
    }

    let publication;
    const previousRuntimeStage = getActiveStage();
    const previousPublication = getActivePublication();
    // The open dataset read again on other cells (Cells to open, or a
    // history step shown that reads them) keeps its history: the reading
    // is one of its steps, and its starting view is not put back again.
    const keepHistory = loadMethod === DATA_LOAD_METHODS.SUBSAMPLE && (datasetHistories?.current() ?? null) !== null;
    try {
      publication = commitDatasetRuntimeStage(runtimeStage, { keepHistory });
    } catch (runtimeError) {
      let restorationError = null;
      try {
        restorePreviousRuntime(previousRuntimeStage, previousPublication, { keepHistory });
      } catch (error) {
        restorationError = error;
      }
      let managerRollbackError = null;
      try {
        dataSourceManager.rollbackDatasetSelection(managerPublication);
      } catch (error) {
        managerRollbackError = error;
      }
      let urlRollbackError = null;
      try {
        urlPublication.rollback();
      } catch (error) {
        urlRollbackError = error;
      }
      let retirementError = null;
      try {
        runtimeRetirementOwner.retire(
          runtimeStage.dimensionManager
        );
      } catch (error) {
        retirementError = error;
      }
      if (restorationError === null && managerRollbackError === null && !keepHistory) {
        restartShownDatasetHistory(previousRuntimeStage);
      }
      const rollbackErrors = [
        runtimeError,
        restorationError,
        managerRollbackError,
        urlRollbackError,
        retirementError
      ].filter(error => error !== null);
      const exactError = rollbackErrors.length === 1
        ? runtimeError
        : new AggregateError(
            rollbackErrors,
            'Dataset runtime publication and rollback failed.'
          );
      return handleDatasetReloadFailure({
        error: exactError,
        transaction: reloadTransaction,
        cancel: () => dataLoad.cancel(),
        reportFailure: failure => {
          console.error(
            '[Main] Failed to publish dataset runtime:',
            failure
          );
          dataLoad.fail(failure, {
            datasetId,
            metadata: selectionStage.metadata
          });
        }
      });
    }
    // The dataset shown now has its history (kept, when it is the same
    // dataset read again); a new one's first tracker starts once its
    // starting view is applied (`beginShownDatasetHistory`, below).
    const shownHistory = keepHistory
      ? datasetHistories.current()
      : datasetHistories.open({
          id: dataSourceManager.getCurrentIdentityId(),
          name: selectionStage.metadata?.name ?? datasetName
        });
    // What showing a cell costs this page, for the next opening's first
    // view: these cells, from their GPU stores to their first frame.
    if (showingStartedAt !== null) {
      const shownCells = state.pointCount;
      void recordFirstFrame({
        cells: shownCells,
        startedAt: showingStartedAt,
        afterNextFrame: runAfterNextFrame,
        // A page hidden meanwhile drew no frame: its wait is not theirs.
        drawn: () => getPageHiddenCount() === hiddenBeforeShowing &&
          viewer.hasRendererStats('live') && viewer.getRendererStats('live').visiblePoints > 0,
        signal: publication.signal
      }).then(ms => {
        if (ms !== null) debug.log(`[Main] ${formatCountOf(shownCells, 'cell')} shown: first frame ${ms.toFixed(0)} ms after their GPU stores`);
      });
    }
    // A listener's failure is reported by its set (`utils/listener-set.js`);
    // what is caught here is the publication itself refused.
    let managerPublicationError = null;
    try {
      dataSourceManager.publishDatasetSelection(managerPublication);
    } catch (error) {
      managerPublicationError = error;
    }
    step('Drawing the first view');
    const synchronizationOutcome = await synchronizePublishedDatasetUi(
      selectionStage.metadata,
      publication
    );
    let managerFinalizationError = null;
    try {
      dataSourceManager.finalizeDatasetSelection(managerPublication);
    } catch (error) {
      managerFinalizationError = error;
    }
    if (
      synchronizationOutcome.status === 'superseded' ||
      publication.isCurrent() !== true
    ) {
      return handleDatasetReloadFailure({
        error: cancelled('superseded',
          'Dataset reload was superseded during UI synchronization.'
        ),
        transaction: publication,
        cancel: () => dataLoad.cancel(),
        reportFailure() {
          throw new Error(
            'A superseded publication must not report reload failure.'
          );
        }
      });
    }
    assertCurrentDatasetPublication(publication);
    if (managerPublicationError !== null) {
      console.error(
        '[Main] Dataset loaded, but its publication to the data sources failed:',
        managerPublicationError
      );
      notifications.error(
        `The dataset is loaded, but a selection control could not be ` +
        `synchronized: ${sayFailure(managerPublicationError)}`,
        { ...failureDetails(managerPublicationError),
          category: 'data',
          title: 'Dataset controls unavailable',
          duration: 0
        }
      );
    }
    if (managerFinalizationError !== null) {
      console.error(
        '[Main] Dataset loaded, but prior-source cleanup failed:',
        managerFinalizationError
      );
      notifications.error(
        `The new dataset is loaded, but prior-source resources could not ` +
        `be fully released: ${sayFailure(managerFinalizationError)}`,
        { ...failureDetails(managerFinalizationError),
          category: 'data',
          title: 'Prior dataset cleanup failed',
          duration: 0
        }
      );
    }
    // The published sample view belongs to the dataset now on screen, so
    // it ends with that publication — not with a newer request, which may
    // still fail and leave this dataset in place. Startup's sidecar
    // requests are deadline-bound startup steps; an interactive switch's
    // end with the publication that owns them.
    const stateOutcome = keepHistory
      ? { status: 'ready' }
      : await restoreAdvertisedDatasetState({
          requestStep: isStartupLoad
            ? (url, operation) => startup.step('session', url, operation)
            : (_url, operation) => operation(publication.signal),
          signal: publication.signal
        });
    // No starting view, or one that failed: the dataset opens colored by
    // its best categorical field unless one is shown (`first-coloring.js`),
    // part of what its history opens on.
    if (!keepHistory && (stateOutcome.status === 'ready' || stateOutcome.status === 'ready-state-error')
      && publication.isCurrent() === true) {
      try {
        await colorByFirstField({ state, activateField: getUi().activateField, signal: publication.signal });
      } catch (error) {
        if (!isCancellation(error)) {
          console.error(`[Main] The first coloring could not be shown: ${failureText(error)}`, error);
          notifications.info(
            'The dataset is open uncolored: the field it opens colored by could not be read. Choose one in Color by.',
            { category: 'data', details: failureText(error) }
          );
        }
      }
    }
    // Its starting view applied (or none, or one that failed): the
    // dataset's first tracker starts from what is shown.
    if (publication.isCurrent() === true) await beginShownDatasetHistory(shownHistory);
    // My datasets (`library/my-datasets.js`): a dataset the person opened
    // (the startup's default sample is not one), or the same one read on
    // other cells, which only updates it.
    if (publication.isCurrent() === true && loadMethod !== DATA_LOAD_METHODS.DEFAULT_DEMO) {
      void recordDatasetOpened(dataSourceManager, { counted: !keepHistory });
    }
    const settledStateOutcome =
      await settlePublishedDatasetStateOutcome({
        outcome: stateOutcome,
        transaction: publication,
        cancel: () => dataLoad.cancel(),
        complete: () => dataLoad.succeed({
          datasetId,
          metadata: selectionStage.metadata,
          stateStatus: stateOutcome.status,
          mapping: state.getMappingAnalytics(),
          // The input format it was read as (a server or catalog names
          // only where; the reader found what).
          dataFormat: dataSourceManager.getSource(sourceType)
            ?.getAnnDataSource?.(datasetId)?.describeStorage?.()?.format ?? null
        })
      });
    debug.log(
      `[Main] Published dataset state outcome: ` +
      `${settledStateOutcome.status}`
    );
    const ready = synchronizationOutcome.status === 'ready' ||
      synchronizationOutcome.status === 'ready-ui-error';
    // A progressive opening grows in place, in the background, to the
    // cells it was asked for; a newer dataset change ends it.
    const shown = shownAnnDataSource();
    if (ready && shown?.getCellSubset?.()?.growth != null && getOpenCellsResize() !== null) {
      onGrowthStarted({ shown, signal: publication.signal });
      void getOpenCellsResize().grow(shown, publication.signal);
    }
    return ready;
  }

  /**
   * A dataset change, shown from its first moment by the opening progress
   * (`data/opening-progress.js`; the layers that read the dataset join
   * it): Cancel stops the change, and the dataset on screen stays. A
   * failure is explained by the dataset controls (or, at startup, by
   * startup), so the opening only lets go of it.
   */
  async function reloadActiveDatasetShown(selection) {
    // Named as the Dataset box names it (never by its id: a link's is its
    // encoded address); a dataset no listing named yet is named once its
    // source lists it.
    const opening = beginOpening({
      title: selection.name ?? 'Dataset',
      step: 'Opening the dataset',
      onCancel: () => selection.transaction.cancel()
    });
    if (selection.name === null) {
      const source = selection.source ?? dataSourceManager.getSource(selection.sourceType);
      Promise.resolve(source?.listDatasets?.())
        .then(datasets => {
          const name = datasets?.find?.(dataset => dataset.id === selection.datasetId)?.name;
          if (typeof name === 'string') opening.rename(name);
        })
        .catch(() => {});
    }
    // A newer choice replaces this change at once: the opening is left to
    // it (and so is the startup opening, when this change was startup's)
    // even while this change's own reads are still unwinding, which a
    // read that never answers would otherwise hold on screen.
    // (A malformed selection is refused by the reload itself.)
    const signal = selection?.transaction?.signal ?? null;
    const stopLettingGo = onAbort(signal, () => {
      opening.dismiss();
      if (selection.startup === true) startupOpening?.dismiss();
    });
    try {
      const ready = await reloadActiveDatasetInPlace(selection, {
        step: text => opening.step(text),
        // Startup's opening is the one shown while startup's dataset opens (this one joined it).
        named: text => {
          opening.rename(text);
          if (selection.startup === true) startupOpening?.rename(text);
        }
      });
      if (ready === true) opening.end();
      else opening.dismiss();
      return ready;
    } catch (error) {
      opening.dismiss();
      throw error;
    } finally {
      stopLettingGo();
    }
  }

  async function clearActiveDatasetInPlace(reloadTransaction) {
    requireDatasetChangeTransaction(reloadTransaction);
    reloadTransaction.assertCurrent();
    await confirmDatasetReplacement(reloadTransaction, { closing: true });
    await cancelPublishedDatasetStateAndWait();
    reloadTransaction.assertCurrent();
    const clearStage = dataSourceManager.stageDatasetClear({
      loadMethod: DATA_LOAD_METHODS.DATASET_DROPDOWN
    });
    const urlPublication = prepareUrlForDataSource(null, {});

    urlPublication.commit();
    let managerPublication;
    try {
      managerPublication = dataSourceManager.commitDatasetClear(clearStage);
    } catch (error) {
      urlPublication.rollback();
      throw error;
    }

    const previousRuntimeStage = getActiveStage();
    const previousDimensionManager = getDimensionManager();
    const previousPublication = getActivePublication();
    let emptyPublication = null;
    try {
      emptyPublication =
        publishEmptyDatasetRuntime();
    } catch (runtimeError) {
      const rollbackErrors = [runtimeError];
      const rejectedEmptyDimensionManager =
        getDimensionManager() === previousDimensionManager
          ? null
          : getDimensionManager();
      try {
        restorePreviousRuntime(previousRuntimeStage, previousPublication);
      } catch (error) {
        rollbackErrors.push(error);
      }
      if (managerPublication !== null) {
        try {
          dataSourceManager.rollbackDatasetSelection(managerPublication);
        } catch (error) {
          rollbackErrors.push(error);
        }
      }
      try {
        urlPublication.rollback();
      } catch (error) {
        rollbackErrors.push(error);
      }
      if (rejectedEmptyDimensionManager !== null) {
        try {
          runtimeRetirementOwner.retire(
            rejectedEmptyDimensionManager
          );
        } catch (error) {
          rollbackErrors.push(error);
        }
      }
      if (rollbackErrors.length === 1) restartShownDatasetHistory(previousRuntimeStage);
      throw rollbackErrors.length === 1
        ? runtimeError
        : new AggregateError(
            rollbackErrors,
            'Dataset clear runtime publication and rollback failed.'
          );
    }
    let managerPublicationError = null;
    if (managerPublication !== null) {
      try {
        dataSourceManager.publishDatasetSelection(managerPublication);
      } catch (error) {
        managerPublicationError = error;
      }
    }
    const synchronizationOutcome = await settlePublishedDatasetUi({
      synchronize: async () => {
        assertCurrentDatasetPublication(emptyPublication);
        try {
          await getUi()?.settleFieldInteractions?.();
        } finally {
          assertCurrentDatasetPublication(emptyPublication);
        }
        connectivityRuntimeOwner.synchronizeDatasetPublication();
        if (getComparisonModule() !== null) {
          try {
            await getComparisonModule().resetForDatasetReload({
              reason: 'dataset-clear'
            });
          } finally {
            assertCurrentDatasetPublication(emptyPublication);
          }
        }
        getUi().refreshDatasetUI(null);
      },
      finalize: () => {
        runtimeRetirementOwner.retire(previousDimensionManager);
      },
      reportFailure: error => {
        if (emptyPublication.isCurrent() !== true) return;
        console.error(
          '[Main] Dataset cleared, but UI synchronization failed:',
          error
        );
        notifications.error(
          `The dataset was cleared, but its controls could not be ` +
          `synchronized: ${sayFailure(error)}`,
          { ...failureDetails(error),
            category: 'data',
            title: 'Dataset controls unavailable',
            duration: 0
          }
        );
      }
    });
    let managerFinalizationError = null;
    if (managerPublication !== null) {
      try {
        dataSourceManager.finalizeDatasetSelection(managerPublication);
      } catch (error) {
        managerFinalizationError = error;
      }
    }
    if (
      synchronizationOutcome.status === 'superseded' ||
      emptyPublication.isCurrent() !== true
    ) {
      return handleDatasetReloadFailure({
        error: cancelled('superseded',
          'Dataset clear was superseded during UI synchronization.'
        ),
        transaction: emptyPublication,
        cancel() {},
        reportFailure() {
          throw new Error(
            'A superseded clear must not report dataset failure.'
          );
        }
      });
    }
    assertCurrentDatasetPublication(emptyPublication);
    if (managerPublicationError !== null) {
      console.error(
        '[Main] Empty dataset published, but its publication to the data sources failed:',
        managerPublicationError
      );
      notifications.error(
        `The dataset was cleared, but a selection control could not be ` +
        `synchronized: ${sayFailure(managerPublicationError)}`,
        { ...failureDetails(managerPublicationError),
          category: 'data',
          title: 'Dataset controls unavailable',
          duration: 0
        }
      );
    }
    if (managerFinalizationError !== null) {
      console.error(
        '[Main] Dataset cleared, but prior-source cleanup failed:',
        managerFinalizationError
      );
      notifications.error(
        `The dataset was cleared, but prior-source resources could not ` +
        `be fully released: ${sayFailure(managerFinalizationError)}`,
        { ...failureDetails(managerFinalizationError),
          category: 'data',
          title: 'Prior dataset cleanup failed',
          duration: 0
        }
      );
    }
    return true;
  }

  /**
   * Start the first tracker of the dataset shown, once its starting view is
   * applied. A history that cannot start leaves the dataset open with its
   * steps unrecorded, and says so once.
   */
  async function beginShownDatasetHistory(history) {
    try {
      await datasetHistories.begin(history);
    } catch (error) {
      console.error('[Main] The history of the dataset could not start:', error);
      notifications.error(
        'The dataset is open, but its history could not start, so its steps are not recorded and cannot be undone.',
        { category: 'session', title: 'History unavailable', details: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * A replacement that failed after the history was retired shows the
   * previous dataset again: its history starts again from what is shown
   * (the steps before are kept in this browser and offered to continue).
   */
  function restartShownDatasetHistory(previousStage) {
    if (previousStage === null || previousStage?.runtimeKind !== 'dataset') return;
    const history = datasetHistories.open({
      id: dataSourceManager.getCurrentIdentityId(),
      name: dataSourceManager.getCurrentMetadata?.()?.name ?? null
    });
    void beginShownDatasetHistory(history);
  }

  return Object.freeze({
    reloadActiveDatasetShown,
    clearActiveDatasetInPlace
  });
}
