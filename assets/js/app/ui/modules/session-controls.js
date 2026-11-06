/**
 * @fileoverview Loading a session file, and the opening of a saved state.
 *
 * Writing one is the history's action (`history.share`, the State panel's
 * Share dialog: `ui/modules/state/share-dialog.js`). Load (Load… › Open a
 * session file…), and opening a saved
 * state of this browser (`openSavedState`: the State section's list, the
 * Continue offer), take one path: the session's own dataset is opened first
 * (its source, its cells), then its history is loaded. Outcomes are said on
 * `NotificationCenter`.
 *
 * @module ui/modules/session-controls
 */

import { getNotificationCenter } from '../../notification-center.js';
import { beginOpening } from '../../../data/opening-progress.js';
import { describeSessionDataset } from '../../session/session-serializer.js';
import {
  describeDatasetSourceRecord
} from '../../session/dataset-source-record.js';
import { cancellationKind } from '../../../utils/abort.js';
import { isReported } from '../../../utils/errors.js';

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
 * @param {{kept: (datasetId: string) => Promise<{name: string, kind: string, granted: boolean}|null>,
 *   reopen: (datasetId: string) => Promise<boolean>}} options.localFiles
 *   A dataset opened from this computer, by the handle this browser kept of
 *   it (`app/library/local-file-handles.js`): what is kept, and its reopen, which
 *   asks the person for leave to read it unless given (inside a click).
 * @param {() => ({digest: string, isSubset: boolean}|null)} options.currentCellIdentity
 *   The open dataset's cells (`data/cell-identity.js`), or null.
 * @param {(cellSubset: Object) => Promise<{shown: boolean, inPlace: boolean}>} options.reopenDataset
 *   Reads the open dataset again with the cells `cellSubset` asks for (a
 *   cell subset request, `data/cell-subset-policy.js`); resolves whether it
 *   is shown.
 * @param {((genes: {cells: number, order: Object|null, digest: string}|null) => Promise<void>)|undefined} options.restoreGeneSample
 *   Reads genes for the open cells a session read them for (its `genes`,
 *   `session/cell-subset-record.js`), once its cells are open.
 * @param {{read: (id: string) => Promise<object>, load: (source: object) => Promise<void>}|null} [options.savedStates]
 *   The saved states of this browser (`app/history/dataset-history.js`):
 *   a saved state's source (`autosave.js` `openSavedState`), and its load
 *   into the shown history.
 * @param {(() => Promise<void>|void)|undefined} options.onAfterLoad
 */
export function initSessionControls({
  dom,
  sessionSerializer,
  datasetChanges,
  currentDatasetIdentityId,
  openDatasetSource,
  localFiles,
  currentCellIdentity,
  reopenDataset,
  restoreGeneSample = async () => {},
  savedStates = null,
  onAfterLoad,
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
    typeof openDatasetSource !== 'function' ||
    typeof localFiles?.kept !== 'function' ||
    typeof localFiles?.reopen !== 'function' ||
    typeof currentCellIdentity !== 'function' ||
    typeof reopenDataset !== 'function'
  ) {
    throw new TypeError(
      'Session controls require the dataset identity and opener.'
    );
  }
  const { loadBtn: loadStateBtn } = dom || {};
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
   * file or folder of this computer opens it from the handle this browser
   * kept of it: at once when the browser lets it be read, else on the
   * person's click on *Reopen <name>* (the browser asks only inside one),
   * after which the session is applied. With no handle kept, or a session
   * saved in a notebook, it is applied to whatever is open, and the restore
   * names the dataset (and file) it needs.
   *
   * @param {{describe: () => Promise<{datasetId: string|null, source: object|null,
   *   cells: object|null, genes: object|null}>, load: () => Promise<void>}} session -
   *   a session file, or a saved state of this browser: which dataset it is
   *   of, and its load into the history
   * @param {number} operationGeneration
   * @param {number} sessionLoad
   * @returns {Promise<boolean>} Whether this session is still the one to restore.
   */
  async function prepareDatasetForSession(session, operationGeneration, sessionLoad) {
    const current = () =>
      ownsOperation(operationGeneration) && sessionLoad === loadGeneration;
    if (!await awaitDatasetForSession(operationGeneration, sessionLoad)) {
      return false;
    }
    const { datasetId, source, cells, genes } = await session.describe();
    if (!current()) return false;
    if (source?.kind === 'file' && currentDatasetIdentityId() !== datasetId) {
      const kept = await localFiles.kept(source.dataset);
      if (!current()) return false;
      if (kept !== null && kept.granted) {
        const opened = await localFiles.reopen(source.dataset);
        return opened && current() && openSessionCells(datasetId, cells, genes, current);
      }
      if (kept !== null) {
        offerLocalReopen(session, source.dataset, kept, operationGeneration, sessionLoad);
        return false;
      }
    }
    // Without a handle a local file cannot be opened from the session: the
    // restore names it when the open dataset is not the one the session was
    // saved on.
    if (
      source === null
      || source.kind === 'file'
      || currentDatasetIdentityId() === datasetId
    ) {
      return openSessionCells(datasetId, cells, genes, current);
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
    return opened && current() && openSessionCells(datasetId, cells, genes, current);
  }

  /**
   * Open the session's dataset with the cells it was saved on: a subsample's
   * exact cells (`cells`), or every cell when it recorded none. A dataset
   * open with other cells is read again first, so the session's per-cell
   * state lands on the cells it names; genes are read for the open cells
   * the session read them for (`genes`): in the reading's request, or, on
   * the cells already open, read for them now.
   *
   * @returns {Promise<boolean>} Whether this file is still the one to restore.
   */
  async function openSessionCells(datasetId, cells, genes, current) {
    if (currentDatasetIdentityId() !== datasetId) return current();
    const open = currentCellIdentity();
    if (open === null) return current();
    const wanted = cells === null ? null : cells.digest;
    if (wanted === null ? !open.isSubset : (open.isSubset && open.digest === wanted)) {
      await restoreGeneSample(genes);
      return current();
    }
    const sample = genes === null ? {} : { genes: genes.cells };
    // The cell order the sample's cells were first in (every cell's, or a
    // share's spread through a file in its own order).
    const order = genes?.order == null ? {} : { order: genes.order };
    const { shown } = await reopenDataset(cells === null
      ? { mode: 'all', ...order, ...sample }
      : { mode: 'kept', spec: cells.spec, kept: cells.kept, ...order, ...sample });
    return shown === true && current();
  }

  /**
   * A session load that did not end in a restore: said once, unless the
   * restore's own progress already said it.
   *
   * @param {unknown} err
   */
  function reportLoadFailure(err) {
    // The reason is part of the text, so every engine logs the same words
    // (Firefox prints an Error argument as its name alone).
    console.error(`Failed to load state: ${err instanceof Error ? err.message : String(err)}`, err);
    // A restore that got as far as its own progress notification has
    // already shown this sentence, prefixed with what it was doing.
    // Announcing it again puts the identical text on screen twice.
    if (isReported(err)) return;
    const message = (
      err instanceof Error && err.message.length > 0
    )
      ? err.message
      : 'Failed to load session';
    showSessionStatus(message, true);
  }

  /** The notification offering *Reopen <name>* for a session, while it stands. */
  let localReopenOffer = null;

  /**
   * Offer *Reopen <name>* for the file or folder a session was saved on,
   * whose handle is kept but which the browser lets be read only once the
   * person allows it, in a click. The click reopens it, then applies the
   * session; until then nothing is applied, and a session chosen after this
   * one (`sessionLoad`) retires the offer.
   */
  function offerLocalReopen(session, datasetId, kept, operationGeneration, sessionLoad) {
    localReopenOffer = getNotificationCenter().show({
      type: 'info',
      category: 'session',
      message: `This session was saved on "${kept.name}", opened from this computer.`,
      duration: 0,
      action: {
        label: `Reopen ${kept.name}`,
        run: () => {
          localReopenOffer = null;
          if (!ownsOperation(operationGeneration) || sessionLoad !== loadGeneration) return;
          const reopenLoad = ++loadGeneration;
          void trackOperation((async () => {
            try {
              // Opened another way since the offer: only the session is left.
              if (currentDatasetIdentityId() !== datasetId && !await localFiles.reopen(datasetId)) return;
              if (!ownsOperation(operationGeneration) || reopenLoad !== loadGeneration) return;
              if (!await prepareDatasetForSession(session, operationGeneration, reopenLoad)) return;
              await session.load();
              if (!ownsOperation(operationGeneration)) return;
              if (typeof onAfterLoad === 'function') await onAfterLoad();
            } catch (err) {
              if (!ownsOperation(operationGeneration)) return;
              if (cancellationKind(err) === 'user' || cancellationKind(err) === 'superseded') return;
              reportLoadFailure(err);
            }
          })());
        }
      }
    });
  }

  if (loadStateBtn && sessionSerializer) {
    listen(loadStateBtn, 'click', () => {
      // IMPORTANT:
      // File pickers must be opened synchronously in the click handler (without
      // awaiting other work) or some browsers will block the dialog.
      const operationGeneration = generation;
      // A newer session file replaces the offer of the last one's file.
      if (localReopenOffer !== null) {
        getNotificationCenter().dismiss(localReopenOffer);
        localReopenOffer = null;
      }
      const operation = (async () => {
      try {
        const picked = await sessionSerializer.loadSessionFromFile({
          beforeRestore: file => prepareDatasetForSession(
            sessionFile(file),
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
        reportLoadFailure(err);
      }
      })();
      return trackOperation(operation);
    });
  }

  /** A session file as a session to open: its dataset from its manifest, its load. */
  function sessionFile(file) {
    return {
      describe: () => sessionSerializer.readSessionDataset(file),
      load: () => sessionSerializer.restoreFromBlob(file),
    };
  }

  /**
   * Open a saved state of this browser (the State section's list, the
   * Continue offer): its dataset first, as a session file's (its source, its
   * cells), then its history. Resolves whether it was opened; a failure is
   * said once.
   *
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  function openSavedState(id) {
    if (savedStates === null) return Promise.reject(new Error('Saved states are not available on this page.'));
    const operationGeneration = generation;
    if (localReopenOffer !== null) {
      getNotificationCenter().dismiss(localReopenOffer);
      localReopenOffer = null;
    }
    const sessionLoad = ++loadGeneration;
    return trackOperation((async () => {
      try {
        const source = await savedStates.read(id);
        const session = {
          describe: async () => describeSessionDataset(source.header),
          load: () => savedStates.load(source),
        };
        if (!await prepareDatasetForSession(session, operationGeneration, sessionLoad)) return false;
        await session.load();
        if (!ownsOperation(operationGeneration)) return false;
        if (typeof onAfterLoad === 'function') await onAfterLoad();
        return true;
      } catch (err) {
        if (!ownsOperation(operationGeneration)) return false;
        if (cancellationKind(err) === 'user' || cancellationKind(err) === 'superseded') return false;
        reportLoadFailure(err);
        return false;
      }
    })());
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

  return { showSessionStatus, openSavedState, destroy };
}
