/**
 * @fileoverview Session save/load UI wiring.
 *
 * Wires the session buttons to the new `.cellucid-session` bundle system and
 * surfaces success/error status via `NotificationCenter`.
 *
 * @module ui/modules/session-controls
 */

import { getNotificationCenter } from '../../notification-center.js';
import { beginOpening } from '../../../data/opening-progress.js';
import {
  isSessionRestoreReportedError
} from '../../session/session-serializer.js';
import {
  describeDatasetSourceRecord
} from '../../session/dataset-source-record.js';

/**
 * @param {object} options
 * @param {object} options.dom
 * @param {object|null} options.sessionSerializer
 * @param {{
 *   settled: boolean,
 *   whenSettled: () => Promise<void>,
 *   recordAction: () => number
 * }} options.datasetChanges
 *   The dataset-change coordinator. A session is restored onto the dataset
 *   it was saved from, so a session chosen while a dataset is loading waits
 *   for that load and is then applied to whatever dataset it produced.
 *   Choosing a session is also an action that decides the dataset: a slower
 *   connection the user started earlier must not replace it afterwards.
 * @param {() => (string|null)} options.currentDatasetIdentityId
 *   The identity id of the dataset that is open, or null.
 * @param {(record: object) => Promise<boolean>} options.openDatasetSource
 *   Opens the dataset a session file recorded; resolves whether it is open.
 * @param {(() => Promise<void>|void)|undefined} options.onAfterLoad
 */
export function initSessionControls({
  dom,
  sessionSerializer,
  datasetChanges,
  currentDatasetIdentityId,
  openDatasetSource,
  onAfterLoad
}) {
  if (
    datasetChanges === null ||
    typeof datasetChanges !== 'object' ||
    typeof datasetChanges.settled !== 'boolean' ||
    typeof datasetChanges.whenSettled !== 'function' ||
    typeof datasetChanges.recordAction !== 'function'
  ) {
    throw new TypeError(
      'Session controls require the dataset-change coordinator.'
    );
  }
  if (
    typeof currentDatasetIdentityId !== 'function' ||
    typeof openDatasetSource !== 'function'
  ) {
    throw new TypeError(
      'Session controls require the dataset identity and opener.'
    );
  }
  const { saveBtn: saveStateBtn, loadBtn: loadStateBtn } = dom || {};
  const lifecycleController = new AbortController();
  const activeOperations = new Set();
  let destroyed = false;
  let generation = 0;
  // The newest session file chosen. An older one still waiting for a dataset
  // is replaced by it, as a second pick replaces the first.
  let loadGeneration = 0;
  let destructionPromise = null;

  function ownsOperation(operationGeneration) {
    return !destroyed && generation === operationGeneration;
  }

  function listen(target, eventName, listener) {
    target.addEventListener(eventName, (...args) => {
      if (destroyed) return undefined;
      return listener(...args);
    }, { signal: lifecycleController.signal });
  }

  function trackOperation(task) {
    activeOperations.add(task);
    void task.then(
      () => activeOperations.delete(task),
      () => activeOperations.delete(task)
    );
    return task;
  }

  /**
   * @param {string} message - One short sentence
   * @param {boolean} [isError]
   * @param {string} [details] - An error's technical text, folded under the
   *   message (the notification's Details)
   */
  function showSessionStatus(message, isError = false, details = '') {
    if (destroyed) return;
    const notifications = getNotificationCenter();
    if (isError) {
      notifications.error(message, { category: 'session', details });
    } else {
      notifications.success(message, { category: 'session' });
    }
  }

  if (saveStateBtn && sessionSerializer) {
    listen(saveStateBtn, 'click', () => {
      const operationGeneration = generation;
      const operation = (async () => {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        await sessionSerializer.downloadSession(`cellucid-session-${timestamp}.cellucid-session`);
        if (!ownsOperation(operationGeneration)) return;
        showSessionStatus('Session saved successfully');
      } catch (err) {
        if (!ownsOperation(operationGeneration)) return;
        console.error(`Failed to save state: ${err instanceof Error ? err.message : String(err)}`, err);
        showSessionStatus('Failed to save session', true);
      }
      })();
      return trackOperation(operation);
    });
  }

  /**
   * Hold a chosen session file until no dataset change is in flight. The wait
   * is announced, so a session chosen during a load is visibly queued rather
   * than appearing to do nothing.
   *
   * @param {number} operationGeneration
   * @param {number} sessionLoad
   * @returns {Promise<boolean>} Whether this file is still the one to restore.
   */
  async function awaitDatasetForSession(operationGeneration, sessionLoad) {
    // The session keeps the dataset it is applied to: a one-dataset
    // connection clicked earlier and answering later leaves it in place.
    datasetChanges.recordAction();
    if (datasetChanges.settled) return true;
    const notifications = getNotificationCenter();
    const waitingId = notifications.loading(
      'Waiting for the dataset to finish loading before applying the session…',
      { category: 'session' }
    );
    try {
      await datasetChanges.whenSettled();
    } finally {
      if (!destroyed) notifications.dismiss(waitingId);
    }
    return ownsOperation(operationGeneration) && sessionLoad === loadGeneration;
  }

  /**
   * Make the session's own dataset the open one when the file records where
   * it comes from and another dataset (or none) is open. A session saved on a
   * local file or in a notebook is applied to whatever is open, and the
   * restore names the dataset (and file) it needs.
   *
   * @param {File} file
   * @param {number} operationGeneration
   * @param {number} sessionLoad
   * @returns {Promise<boolean>} Whether this file is still the one to restore.
   */
  async function prepareDatasetForSession(file, operationGeneration, sessionLoad) {
    const current = () =>
      ownsOperation(operationGeneration) && sessionLoad === loadGeneration;
    if (!await awaitDatasetForSession(operationGeneration, sessionLoad)) {
      return false;
    }
    const { datasetId, source } = await sessionSerializer.readSessionDataset(file);
    if (!current()) return false;
    // A local file cannot be opened from the session: the restore names it
    // when the open dataset is not the one the session was saved on.
    if (
      source === null
      || source.kind === 'file'
      || currentDatasetIdentityId() === datasetId
    ) {
      return true;
    }
    // Shown by the opening progress; the source and the dataset change that
    // open it join this opening, and a failure is said where it happened:
    // the joined layer says how the opening ends (`saysOutcome: false`).
    const opening = beginOpening({
      title: `the session's dataset from ${describeDatasetSourceRecord(source)}`,
      saysOutcome: false
    });
    let opened = false;
    try {
      opened = await openDatasetSource(source);
    } finally {
      if (opened) opening.end();
      else opening.dismiss();
    }
    // A source that could not be opened reported why where it failed.
    return opened && current();
  }

  if (loadStateBtn && sessionSerializer) {
    listen(loadStateBtn, 'click', () => {
      // IMPORTANT:
      // File pickers must be opened synchronously in the click handler (without
      // awaiting other work) or some browsers will block the dialog.
      const operationGeneration = generation;
      const operation = (async () => {
      try {
        const picked = await sessionSerializer.loadSessionFromFile({
          beforeRestore: file => prepareDatasetForSession(
            file,
            operationGeneration,
            ++loadGeneration
          )
        });
        if (!picked || !ownsOperation(operationGeneration)) return;
        // The restore published its own outcome ("Session fully restored.")
        // on its progress notification; announcing it again is a duplicate.
        if (typeof onAfterLoad === 'function') {
          await onAfterLoad();
        }
      } catch (err) {
        if (!ownsOperation(operationGeneration)) return;
        // The reason is part of the text, so every engine logs the same words
        // (Firefox prints an Error argument as its name alone).
        console.error(`Failed to load state: ${err instanceof Error ? err.message : String(err)}`, err);
        // A restore that got as far as its own progress notification has
        // already shown this sentence, prefixed with what it was doing.
        // Announcing it again puts the identical text on screen twice.
        if (isSessionRestoreReportedError(err)) return;
        const message = (
          err instanceof Error && err.message.length > 0
        )
          ? err.message
          : 'Failed to load session';
        showSessionStatus(message, true);
      }
      })();
      return trackOperation(operation);
    });
  }

  function destroy() {
    if (destructionPromise !== null) return destructionPromise;
    destroyed = true;
    generation += 1;
    lifecycleController.abort();
    const ownedOperations = [...activeOperations];
    destructionPromise = Promise.allSettled(ownedOperations).then(() => {});
    return destructionPromise;
  }

  /**
   * A session records the state of a dataset's cells, so Save follows the
   * runtime. Load stays available: with nothing open it names the dataset the
   * session needs.
   *
   * @param {boolean} present
   */
  function setCellsPresent(present) {
    if (typeof present !== 'boolean') {
      throw new TypeError('Session-control cell presence must be one boolean.');
    }
    if (destroyed || !saveStateBtn) return;
    saveStateBtn.disabled = !present;
    saveStateBtn.title = present ? '' : 'Load a dataset to save a session';
  }
  setCellsPresent(false);

  return { showSessionStatus, setCellsPresent, destroy };
}
