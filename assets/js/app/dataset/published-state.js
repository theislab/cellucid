/**
 * @fileoverview The starting view a dataset's catalog publishes for it
 * (its sample view, `session/catalog-default-session.js`), put back once the
 * dataset is published, and the one restore of it that may run at a time:
 * the next dataset change stops it and waits for it before it publishes.
 *
 * It owns that restore and how its outcome is said (ready, restored, or the
 * dataset open on its default view with the reason). Which dataset is
 * published, and when its starting view is asked, is the dataset change's
 * (`reload.js`); reading the view is the session serializer's.
 *
 * @module app/dataset/published-state
 */

import { abortReason, cancel, onAbort, requireSignal } from '../../utils/abort.js';
import { fetchCatalogFile } from '../../data/data-source.js';
import { getOpeningProgress } from '../../data/opening-progress.js';
import { afterWelcome } from '../../utils/startup-sequence.js';
import { isOtherSessionFormat } from '../session/bundle/format.js';
import {
  classifyAdvertisedDatasetStateRestoreError,
  restoreCurrentDatasetState
} from '../session/catalog-default-session.js';
import { STARTUP_STALL_CODE } from '../startup-phase.js';


/** Said of a published sample view of another session format: the dataset itself is open, nothing is wrong with it. */
const SAMPLE_VIEW_NOT_YET = 'This dataset\u2019s starting view isn\u2019t available right now, so it opens on its default view.';

/**
 * @param {{
 *   dataSourceManager: Object,
 *   sessionSerializer: Object,
 *   notifications: Object,
 *   getUi: () => Object,
 *   getPublicationRevision: () => number,
 * }} options - `getUi`: the interface (made after this owner); `getPublicationRevision`:
 *   the generation of the publication shown, which a restore that outlives it must not touch.
 * @returns {Readonly<{
 *   cancelPublishedDatasetStateAndWait: () => Promise<void>,
 *   restoreAdvertisedDatasetState: (options: {requestStep: Function, signal: AbortSignal}) => Promise<Object>,
 * }>}
 */
export function createPublishedDatasetState({
  dataSourceManager,
  sessionSerializer,
  notifications,
  getUi,
  getPublicationRevision
}) {
  let activePublishedStateController = null;
  let activePublishedStateTask = null;

  async function cancelPublishedDatasetStateAndWait() {
    const task = activePublishedStateTask;
    cancel(activePublishedStateController, 'superseded', 'The published dataset state was superseded.');
    await sessionSerializer.cancelRestoreAndWait();
    if (task !== null) {
      await task;
    }
  }

  async function restoreAdvertisedDatasetState({ requestStep, signal }) {
    requireSignal(signal, 'Published dataset state signal');
    if (typeof requestStep !== 'function') {
      throw new TypeError(
        'Published dataset state requires one request step runner.'
      );
    }
    if (activePublishedStateTask !== null) {
      throw new Error(
        'Published dataset state replacement must await its prior owner.'
      );
    }

    const controller = new AbortController();
    const stopRelay = onAbort(signal, () => controller.abort(abortReason(signal)));
    activePublishedStateController = controller;

    const task = (async () => {
      try {
        const restored = await restoreCurrentDatasetState({
          dataSourceManager,
          fetchArtifact: fetchCatalogFile,
          getPublicationRevision,
          refreshUi: getUi().refreshUiAfterStateLoad,
          requestStep,
          sessionSerializer,
          signal: controller.signal
        });
        return {
          status: restored ? 'ready-state-restored' : 'ready'
        };
      } catch (error) {
        const classified =
          classifyAdvertisedDatasetStateRestoreError(error, {
            ownerAborted: controller.signal.aborted
          });
        if (classified !== null) return classified;
        // A startup request that stalled ends startup on its failure
        // surface, naming the phase and URL, not as a missing sample view.
        if (error?.code === STARTUP_STALL_CODE) throw error;
        // A whole sample view of another session format: the app and the
        // datasets are deployed minutes apart. Nothing is wrong with the
        // dataset, which opens on the store's own default view.
        if (isOtherSessionFormat(error)) {
          console.info('[Main] The sample view is of another session format for now:', error.message);
          // After the welcome, never on top of it (`utils/startup-sequence.js`).
          const shownNow = dataSourceManager.getCurrentIdentityId();
          void afterWelcome().then(() => {
            if (dataSourceManager.getCurrentIdentityId() === shownNow) notifications.info(SAMPLE_VIEW_NOT_YET, { category: 'data' });
          });
          return { status: 'ready' };
        }
        const message = error instanceof Error
          ? error.message
          : String(error);
        console.error(
          '[Main] Dataset loaded, but its advertised default state failed:',
          error
        );
        // About this dataset: withdrawn when the next one opens; said after
        // the welcome, never on top of it.
        const shownNow = dataSourceManager.getCurrentIdentityId();
        void afterWelcome().then(() => dataSourceManager.getCurrentIdentityId() === shownNow && getOpeningProgress().untilNextOpening(notifications.error(
          'The dataset is open, but its published sample view could not be applied.',
          {
            category: 'data',
            duration: 0,
            title: 'Sample view unavailable',
            details: message
          }
        )));
        return {
          error,
          status: 'ready-state-error'
        };
      } finally {
        stopRelay();
      }
    })();
    activePublishedStateTask = task;
    try {
      return await task;
    } finally {
      if (activePublishedStateTask === task) {
        activePublishedStateTask = null;
        activePublishedStateController = null;
      }
    }
  }
  return Object.freeze({
    cancelPublishedDatasetStateAndWait,
    restoreAdvertisedDatasetState
  });
}
