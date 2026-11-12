/**
 * @fileoverview Session files of the open dataset: saving its history as a
 * `.cellucid-session` (format 4, `history-file.js`), loading one back into
 * the history, and putting a dataset's published starting view back.
 *
 * - **Save and Share** write what the person chose of the open dataset's
 *   history (`share-scope.js`: the whole history, the current state only, or
 *   its steps only; which trackers and branches; notes, conversations,
 *   Recently deleted, times, the dataset's source, analysis results), stamped
 *   with what wrote it (`app-stamp.js`). Changes made while recording was
 *   paused are made one step first (`history.settlePaused`), and a change
 *   made outside an action one too (`history.reconcile`), so what is shown is
 *   what is written. The dataset part (fingerprint, source, the cells and
 *   genes it was saved on, the fields the shown state uses) is taken with
 *   the open cells in use (`useOpenCells`), so a growth step or Apply waits
 *   until it is written, and a dataset replaced meanwhile is refused.
 * - **Load** verifies the file against the open dataset before anything is
 *   applied (its identity, data mapping and cell order,
 *   `verifySessionFingerprint`; the fields it uses), then adds its trackers
 *   beside the person's own (`history.importTrackers`, History v2 Q2): the
 *   file's active head is shown as soon as the eager chunks are read, the
 *   rest is read while it is shown, and a failure anywhere puts back what was
 *   shown before. A file of steps only opens as a replay plan
 *   (`history.replay`). The autosave's saved states (`app/history/autosave.js`)
 *   replace the history (`loadSavedHistory`, `history.load`): continuing one
 *   is continuing that work. Once either is shown, each analysis result it
 *   left out (Share › Results: compute again on open) is run again as a step
 *   (`recompute-results.js`).
 * - **A starting view** (`published-default.js`: one tracker of one root) is
 *   put back without a step, before the dataset's first tracker starts
 *   (`history.showValues`), and applies to any subsample of its dataset.
 *
 * Every load is one owned operation: a newer one cancels it and waits for it
 * to settle; Cancel on its progress cancels it.
 *
 * @module session/session-serializer
 */

import { NO_PAGE_CHROME, openHistoryFile, readHistoryFileManifest } from './history-file.js';
import { HistoryModelError } from '../history/model.js';
import { SAVE_DEFAULTS, writeSharedHistory } from './share-scope.js';
import { readReplayPlan } from '../history/replay.js';
import { recomputeLeftOutResults, recomputeSentences } from './recompute-results.js';
import { getActionCatalog } from '../actions/index.js';
import { domainName } from '../actions/domains.js';
import { writtenByOtherVersion } from './app-stamp.js';
import { createOpaqueId } from '../../utils/opaque-id.js';
import { pageVersion } from '../utils/page-version.js';
import { assertPublishedDefaultProfile, assertPublishedDefaultRoot, keepShownControls } from './published-default.js';
import { captureDatasetSourceRecord } from './dataset-source-record.js';
import {
  captureCellSubsetRecord, captureGeneSampleRecord, decodeCellSubsetRecord, decodeGeneSampleRecord,
} from './cell-subset-record.js';
import {
  collectRequiredFields, datasetFingerprintStillCurrent, describeMissingRequiredFields, getDatasetFingerprint,
  verifySessionFingerprint,
} from './session-context.js';
import { assertNonEmptyString, assertSafeInteger, requireMethod } from './schema-contract.js';
import { downloadBlob } from '../utils/download.js';
import { sameJson } from '../utils/same-json.js';
import { getNotificationCenter } from '../notification-center.js';
import { useOpenCells } from '../../data/open-cells-work.js';
import { requireExactKeys } from '../../utils/exact-record.js';
import { abortReason, awaitWithSignal, cancellationKind, cancelled, isCancellation, onAbort, throwIfAborted, requireSignal } from '../../utils/abort.js';
import {
  failureDetails, failureDetailsText, failureText, isDamagedFile, isInternalFailure, joinFailure, markReported, sayFailure,
} from '../../utils/errors.js';
import { heldCategoriesOf } from '../state/managers/field/pending-categories.js';
import { formatCountOf } from '../../utils/format-units.js';

/**
 * @typedef {object} SavedHistorySource
 * What a saved history is read from (a session file, a saved state of the
 * autosave): its dataset part, then its chunks or records in two stages.
 * @property {object} header - createdAt, datasetFingerprint, source, requires, cells?, genes?
 * @property {'history'|'state'|'steps'} content - what it holds: a history (or a state) to show, or steps only to replay
 * @property {{pressed: Record<string, string>}} chrome - the page chrome it carries outside its history
 * @property {{app: {version: string, catalog: string}, actions: Array<object>|null}} stamps - what wrote it:
 *   a file's manifest stamps; a saved state of this browser, its app and null actions (compare by `app.catalog`)
 * @property {() => Promise<{history: object, values: Map<string, unknown>}>} readEager
 * @property {() => Promise<{values: Map<string, unknown>, chats: Array<object>, journals: Array<object>,
 *   params: Array<object>}>} readRest - `history-file.js` `openHistoryFile`
 * @property {(reason: unknown) => Promise<void>} cancel
 */

/**
 * A history's load (a session file, a saved state, Continue) that failed, as
 * the person reads it, after the name of what was loaded: one sentence saying
 * what happened and that the history shown is as it was, and the failure's
 * own words (the trackers, steps and groups it names) under Details. A
 * refusal or a reader's sentence is said as it is.
 *
 * @param {unknown} error
 * @returns {{message: string, details: string}} `message` follows the name ("name: …")
 */
export function describeLoadFailure(error) {
  const unchanged = 'so it was not opened; the history shown is unchanged.';
  const other = error !== null && typeof error === 'object' ? WRITTEN_BY.get(error) : undefined;
  // A history another version wrote that this one cannot read is said as that, never as damaged or a problem inside (F155).
  if (other !== undefined && (isDamagedFile(error) || isInternalFailure(error) || modelFailure(error))) {
    return { message: `${otherVersionWords(other)}, which this version cannot read, ${unchanged}`, details: failureDetailsText(error) };
  }
  if (isDamagedFile(error)) return { message: `the file is damaged, ${unchanged}`, details: failureText(error) };
  if (modelFailure(error)) return { message: `it does not hold together as a history, ${unchanged}`, details: failureText(error) };
  return { message: sayFailure(error), details: failureDetails(error).details ?? '' };
}

/** Whether `error` (or what caused it) is the history model's refusal of a record. */
function modelFailure(error) {
  for (let at = error, depth = 0; at !== null && typeof at === 'object' && depth < 8; at = at.cause, depth++) {
    if (at instanceof HistoryModelError) return true;
  }
  return false;
}

/**
 * The failures of loads of a history another version of Cellucid wrote
 * (`writtenByOtherVersion`: `{when: 'earlier'|'newer', version}`), so
 * `describeLoadFailure` says that instead of a damaged file or a problem
 * inside Cellucid, wherever the error goes next (the session controls, an
 * agent's `history.saved.open`).
 */
const WRITTEN_BY = new WeakMap();

/** "it was saved by an earlier version of Cellucid (0.9.7)" */
function otherVersionWords({ when, version }) {
  return `it was saved by ${when === 'newer' ? 'a newer' : 'an earlier'} version of Cellucid${typeof version === 'string' && version !== '' ? ` (${version})` : ''}`;
}

/**
 * What a load could not restore (`history.load` / `importTrackers`
 * `unrestored`, F155), one sentence per part, each saying what that part is
 * and what became of it, and the words of each failure for Details. A part
 * of a history another version wrote (`other`) that this version refused is
 * said as saved by that version, which this one cannot read; any other
 * failure as `sayFailure` says it. `continued`: the saved state of this
 * browser it came from is kept as it was (the history goes on as a new one
 * beside it).
 *
 * A part of the state this version does not have (`unknown-domain`, F164)
 * is said once for all such parts: their changes are left out of every
 * step. `subject`: what was restored ("Session", "Starting view").
 *
 * @param {Array<{part: 'domain', domain: string, error: unknown}|{part: 'unknown-domain', domain: string}|{part: 'tracker', tracker: {id: string, name: string}, active: boolean, error: unknown}>} unrestored
 * @param {{other?: {when: 'earlier'|'newer', version: string}|null, savedState?: boolean, subject?: string}} [options]
 * @returns {{message: string, details: string}}
 */
export function describeUnrestored(unrestored, { other = null, savedState = false, subject = 'Session' } = {}) {
  const partReasonOf = error => {
    if (other !== null && (isInternalFailure(error) || isDamagedFile(error) || modelFailure(error))) {
      return `${otherVersionWords(other)}, and this version cannot read this part.`;
    }
    return sayFailure(error);
  };
  const ended = text => (/[.!?]$/.test(text) ? text : `${text}.`);
  const absent = unrestored.filter(part => part.part === 'unknown-domain').map(part => `"${part.domain}"`);
  const absentSentence = absent.length === 0 ? [] : [
    `${absent.length === 1 ? 'A part of the state' : 'Parts of the state'} this version of Cellucid does not have (${absent.join(', ')}) `
    + `${absent.length === 1 ? 'is' : 'are'} left out${other === null ? '' : `: ${otherVersionWords(other)}`}.`,
  ];
  const sentences = [...absentSentence, ...unrestored.filter(part => part.part !== 'unknown-domain').map(part => {
    if (part.part === 'domain') {
      return `${ended(joinFailure(`${domainName(part.domain)} could not be restored`, partReasonOf(part.error)))} It is left as it was shown.`;
    }
    const name = `The history "${part.tracker.name}"`;
    const then = part.active
      ? 'What it showed is restored, as the start of a new history of that name with its conversations.'
      : 'It is left out; the other histories are restored.';
    return `${ended(joinFailure(`${name} (its steps) could not be read`, partReasonOf(part.error)))} ${then}`;
  })];
  const what = formatCountOf(unrestored.length, 'part');
  const kept = savedState ? ' The saved state is kept as it was; this history goes on beside it.' : '';
  const detailOf = part => {
    if (part.part === 'unknown-domain') return `State part "${part.domain}": not a part of the state in this version of Cellucid; its changes are left out of every step.`;
    return `${part.part === 'domain' ? domainName(part.domain) : `History "${part.tracker.name}"`}: ${failureDetailsText(part.error)}`;
  };
  return {
    message: `${subject} restored but for ${what}. ${sentences.join(' ')}${kept}`,
    details: unrestored.map(detailOf).join('\n'),
  };
}

function isDismissal(error, signal) {
  return ['superseded', 'user'].includes(cancellationKind(error))
    || ['superseded', 'user'].includes(cancellationKind(signal.reason));
}

/**
 * The refusal naming every field a saved state uses that the open dataset
 * lacks, or null. Genes are named by the mapping's gene names, so they are
 * compared only when the saved mapping names them the way the open one does
 * (the same modality and gene-name column); otherwise the history names a
 * missing gene itself when its value is put back.
 */
function describeMissingFields(state, header) {
  const saved = header.datasetFingerprint.dataMapping;
  const current = state.getDataMapping();
  const sameGeneNames = current !== null
    && sameJson(current.geneNames ?? null, saved.geneNames ?? null)
    && sameJson(current.modality ?? null, saved.modality ?? null);
  return describeMissingRequiredFields(state, {
    obs: header.requires.obs,
    var: sameGeneNames ? header.requires.var : [],
  });
}

/**
 * What the person is told of a field the loaded state names categories of
 * that no open cell holds (a text or boolean column on a subsample: its
 * categories are those its open cells hold): their filters and colors are
 * held by label and applied when cells holding them open
 * (`state/managers/field/pending-categories.js`).
 *
 * @param {string} fieldKey
 * @param {number} count - How many categories are held
 * @param {string} what - What was loaded ("Session file", "Starting view", "Saved state")
 */
export function heldCategoriesNotice(fieldKey, count, what) {
  return `${formatCountOf(count, 'category', 'categories')} of "${fieldKey}" in this ${what.toLowerCase()} `
    + `${count === 1 ? "isn't" : "aren't"} among the open cells; `
    + `${count === 1 ? 'its settings apply' : 'their settings apply'} when those cells open.`;
}

/** Tell once per field, after a load, which categories it holds for cells not open. */
function tellHeldCategories(state, what, notifications) {
  for (const { key, labels } of heldCategoriesOf(state)) {
    notifications.info(heldCategoriesNotice(key, labels.length, what), { category: 'session' });
  }
}

export class SessionSerializer {
  /**
   * @param {{
   *   state: import('../state/core/data-state.js').DataState,
   *   dataSourceManager: object|null,
   *   getHistory: () => (ReturnType<typeof import('../history/history.js').createHistory>|null),
   *   dispatcher: {idle: () => Promise<void>},
   *   onLoaded: () => void,
   *   catalog?: object,
   *   version?: () => string,
   *   chrome?: {capture: () => {pressed: Record<string, string>}, plan: (chrome: {pressed: Record<string, string>}) => {notes: string[], apply: () => void}},
   * }} options - `getHistory`: the open dataset's history, or null while none is
   *   open; `onLoaded`: a session file, saved state or starting view is shown (the
   *   camera path saved with Autoplay on starts, `cinematic-camera` `startAutoplay`);
   *   `catalog`: the action catalog files are stamped with (the page's);
   *   `version`: the Cellucid version that writes (the page's `<meta name="cellucid-version">`);
   *   `chrome`: the page chrome sessions carry outside the history (the pressed selection tool,
   *   CEL-0249): taken at a save, put back once a load shows its head
   */
  constructor(options) {
    const keys = ['state', 'dataSourceManager', 'getHistory', 'dispatcher', 'onLoaded'];
    requireExactKeys(options, [...keys, ...['catalog', 'version', 'chrome'].filter(key => Object.hasOwn(options ?? {}, key))], 'SessionSerializer options');
    if (options.state === null || typeof options.state !== 'object') throw new TypeError('SessionSerializer needs the DataState.');
    if (typeof options.getHistory !== 'function') throw new TypeError('SessionSerializer needs getHistory().');
    if (typeof options.onLoaded !== 'function') throw new TypeError('SessionSerializer needs onLoaded().');
    requireMethod(options.dispatcher, 'idle', 'SessionSerializer dispatcher');
    this._state = options.state;
    this._dataSourceManager = options.dataSourceManager;
    this._getHistory = options.getHistory;
    this._dispatcher = options.dispatcher;
    this._onLoaded = options.onLoaded;
    this._catalog = options.catalog ?? getActionCatalog();
    this._version = options.version ?? writingVersion;
    this._chrome = options.chrome ?? null;
    /** @type {AbortController|null} */
    this._activeRestoreAbort = null;
    /** @type {Promise<void>|null} */
    this._activeRestoreTask = null;
    /** @type {Promise<void>} */
    this._operationTail = Promise.resolve();
    /** @type {(() => Promise<(() => Promise<void>|void)|void>)|null} */
    this._captureSettlement = null;
    /** @type {(() => Promise<(() => Promise<void>|void)|void>)|null} */
    this._restoreSettlement = null;
    /** The progress of the session file being read, while one is. @type {((loaded: number) => void)|null} */
    this._progress = null;
  }

  /**
   * Bind what a save waits for before it reads the open dataset (its genes
   * listed; no field interaction under way). Installed once.
   * @param {() => Promise<(() => Promise<void>|void)|void>} settle - may return its release
   */
  setCaptureSettlement(settle) {
    if (typeof settle !== 'function') throw new TypeError('Session capture settlement must be a function.');
    if (this._captureSettlement !== null && this._captureSettlement !== settle) throw new Error('Session capture settlement is already owned.');
    this._captureSettlement = settle;
  }

  /**
   * Bind what a load waits for before it puts state back. Installed once.
   * @param {() => Promise<(() => Promise<void>|void)|void>} settle - may return its release
   */
  setRestoreSettlement(settle) {
    if (typeof settle !== 'function') throw new TypeError('Session restore settlement must be a function.');
    if (this._restoreSettlement !== null && this._restoreSettlement !== settle) throw new Error('Session restore settlement is already owned.');
    this._restoreSettlement = settle;
  }

  /**
   * One operation on the session at a time; a failure does not stop the
   * next. `signal`: stopped while it waits for its turn, it never runs and
   * its caller hears so at once (as the history's `exclusive`, L20-2); once
   * running, the operation watches the signal itself.
   */
  _exclusive(operation, { signal = null } = {}) {
    let started = false;
    const task = this._operationTail.then(() => {
      throwIfAborted(signal);
      started = true;
      return operation();
    });
    this._operationTail = task.then(() => {}, () => {});
    if (signal === null) return task;
    return new Promise((resolve, reject) => {
      const stopWaiting = onAbort(signal, () => {
        if (!started) reject(abortReason(signal));
      });
      task.then(value => { stopWaiting(); resolve(value); }, error => { stopWaiting(); reject(error); });
    });
  }

  async _withSettlement(settle, operation) {
    const release = settle === null ? undefined : await settle();
    if (release !== undefined && typeof release !== 'function') {
      throw new TypeError('A session settlement must return its release function or nothing.');
    }
    try {
      return await operation();
    } finally {
      if (typeof release === 'function') await release();
    }
  }

  _requireHistory() {
    const history = this._getHistory();
    if (history === null || history.active === null) {
      throw new Error('There is no history to save: open a dataset first.');
    }
    return history;
  }

  /**
   * What a session says about the dataset it is saved on: its fingerprint,
   * where it opens from, the cells and genes it was saved on, and the
   * fields the shown state uses, taken together with the open cells in use.
   * A dataset replaced, remapped or resized while it is taken is refused.
   *
   * @returns {Promise<{createdAt: string, datasetFingerprint: object, source: object|null,
   *   requires: {obs: string[], var: string[]}, cells?: object, genes?: object}>}
   */
  captureSessionHeader() {
    const state = this._state;
    const dataSourceManager = this._dataSourceManager;
    return useOpenCells(async () => {
      const ctx = { state, dataSourceManager };
      const generation = state.getDatasetGeneration();
      const owner = { cellIdentity: state.cellIdentity ?? null, obsData: state.obsData, varData: state.varData, positionsArray: state.positionsArray };
      const datasetFingerprint = await getDatasetFingerprint(ctx);
      if (
        state.getDatasetGeneration() !== generation
        || (state.cellIdentity ?? null) !== owner.cellIdentity
        || state.obsData !== owner.obsData
        || state.varData !== owner.varData
        || state.positionsArray !== owner.positionsArray
        || !datasetFingerprintStillCurrent(ctx, datasetFingerprint)
      ) {
        const error = new Error(
          'The dataset changed while the session was being saved (another dataset, '
          + 'its data mapping or the cells shown). Save the session again.'
        );
        error.code = 'SESSION_CAPTURE_DATASET_CHANGED';
        throw error;
      }
      const cells = captureCellSubsetRecord(dataSourceManager);
      const genes = captureGeneSampleRecord(dataSourceManager);
      return {
        createdAt: new Date().toISOString(),
        datasetFingerprint,
        source: captureDatasetSourceRecord(dataSourceManager),
        requires: collectRequiredFields(state),
        ...(cells === null ? {} : { cells }),
        ...(genes === null ? {} : { genes }),
      };
    });
  }

  /**
   * What the person chose of the open dataset's history as a
   * `.cellucid-session` file (`share-scope.js`). Actions under way finish
   * first; changes made while recording was paused become one step, and a
   * change made outside an action one too; the history's records and values
   * are then taken in one turn.
   *
   * @param {{choice?: object}} [options] - a `share-scope.js` choice
   *   (`SAVE_DEFAULTS`, `SHARE_DEFAULTS`, `STATE_DEFAULTS` or one made from them)
   * @returns {Promise<Blob>}
   */
  createSessionBundle({ choice = SAVE_DEFAULTS } = {}) {
    return this.writeShare({ choice }).then(({ blob }) => blob);
  }

  /**
   * `createSessionBundle`, with what the file holds (`share-scope.js`
   * `shareHistory`'s answer: its trackers and scope), for `history.share`.
   *
   * `signal` (the `history.share` dispatch's, an agent's Stop): the waits
   * before the file is written (its turn, the actions still running) end at
   * once when it is stopped; they change nothing (L20-2).
   *
   * @param {{choice?: object, signal?: AbortSignal|null}} [options]
   * @returns {Promise<{blob: Blob, shared: object}>}
   */
  writeShare({ choice = SAVE_DEFAULTS, signal = null } = {}) {
    return this._exclusive(() => this._withSettlement(this._captureSettlement, async () => {
      await awaitWithSignal(this._dispatcher.idle(), signal);
      const history = this._requireHistory();
      // What is shown is what is saved: a paused period's changes and a change made outside an action become steps.
      await history.settlePaused({ origin: 'session' });
      await history.reconcile();
      const header = await this.captureSessionHeader();
      // The values read across awaits stay readable while they are read (`value-pool.js` hold).
      const unhold = history.pool.hold();
      try {
        return await writeSharedHistory({
          snapshot: history.snapshot(),
          shown: history.shownHashes(),
          valueOf: hash => history.pool.get(hash),
          choice,
          header,
          catalog: this._catalog,
          version: this._version(),
          newTrackerId: () => `t-${createOpaqueId()}`,
          now: Date.now(),
          chrome: this._chrome?.capture() ?? NO_PAGE_CHROME,
        });
      } finally {
        unhold();
      }
    }), { signal });
  }

  /**
   * Download what the person chose of the open dataset's history as a `.cellucid-session` file.
   * @param {string} filename
   * @param {{choice?: object}} [options]
   */
  async downloadSession(filename, options = {}) {
    assertNonEmptyString(filename, 'Session download filename');
    downloadBlob(await this.createSessionBundle(options), filename);
  }

  /**
   * Read only a session file's manifest and say which dataset it belongs to
   * and where that dataset opens from. Nothing is applied.
   *
   * @param {Blob} blob
   * @returns {Promise<{datasetId: string|null, name: string|null, source: object|null,
   *   cells: {spec: object, kept: Uint32Array, digest: string}|null,
   *   genes: {cells: number, order: object|null, digest: string}|null}>}
   */
  async readSessionDataset(blob) {
    if (!(blob instanceof Blob)) throw new TypeError('Session source must be a Blob or File.');
    return describeSessionDataset(await readHistoryFileManifest(blob));
  }

  /**
   * Load a session file into the history: `file` (dropped on the page,
   * chosen in Open… › File…), or, when null, the one the person chooses in
   * a file picker now. `beforeRestore(file)` runs once there is a file,
   * before anything is read from it; resolving false abandons the load (the
   * session controls open the session's dataset there first).
   *
   * @param {{beforeRestore: (file: File) => Promise<boolean>, file: File|null}} options
   * @returns {Promise<boolean>} whether a file was chosen and loaded
   */
  async loadSessionFromFile(options) {
    requireExactKeys(options, ['beforeRestore', 'file'], 'Session file load options');
    if (typeof options.beforeRestore !== 'function') throw new TypeError('Session file load beforeRestore must be a function.');
    if (options.file !== null && !(options.file instanceof Blob)) throw new TypeError('Session file load file must be a File, or null to choose one.');
    // A file given (dropped on the page, chosen in Open… › File…), else the one the person chooses now.
    const file = options.file ?? await this.pickSessionFile();
    if (file === null) return false;
    const proceed = await options.beforeRestore(file);
    if (typeof proceed !== 'boolean') throw new TypeError('Session file load beforeRestore must resolve a boolean.');
    if (!proceed) return false;
    try {
      await this.restoreFromBlob(file);
      return true;
    } catch (error) {
      if (['user', 'superseded'].includes(cancellationKind(error))) return false;
      throw error;
    }
  }

  /**
   * Load a session file into the open dataset's history: its trackers are
   * added beside the person's own (named after the file), and its active
   * head is shown. A file of steps only is replayed on the dataset shown.
   * @param {Blob} blob - a File keeps its name with the trackers it adds
   * @returns {Promise<void>}
   */
  restoreFromBlob(blob) {
    if (!(blob instanceof Blob)) throw new TypeError('Session restore source must be a Blob or File.');
    const totalBytes = assertSafeInteger(blob.size, 'Session restore Blob size');
    const file = typeof blob.name === 'string' && blob.name.length > 0 ? blob.name : 'session file';
    return this._runOwnedRestore(async controller => {
      const opened = await openHistoryFile(blob, {
        signal: controller.signal,
        onProgress: loaded => this._progress?.(loaded),
      });
      return { ...opened, ...sourceFacts(opened.manifest) };
    }, {
      label: 'Session file', totalBytes, signal: null, importFile: file,
      // What wrote it, for a failure before the file was read whole (`describeLoadFailure`).
      stampOf: async () => (await readHistoryFileManifest(blob)).app,
    });
  }

  /**
   * Load a saved history that is not a file (a saved state of the
   * autosave) into the open dataset's history, verified like a file.
   *
   * @param {() => Promise<SavedHistorySource>} open
   * @param {{label: string, signal?: AbortSignal|null, heavy?: ((estimate: Object) => Promise<void>)|null}} options -
   *   `heavy`: an action's `ctx.heavy` (an agent's `history.saved.open`), asked before the values it
   *   restores sum cells' totals (normalized values)
   * @returns {Promise<{notRestored: string|null}|undefined>} `notRestored`: the parts it could not
   *   restore, as the person was told (`describeUnrestored`), or null when every part was
   */
  loadSavedHistory(open, { label, signal = null, heavy = null }) {
    assertNonEmptyString(label, 'Saved history label');
    return this._runOwnedRestore(() => open(), { label, totalBytes: null, signal, heavy });
  }

  /**
   * Put a dataset's published starting view back (`published-default.js`):
   * its one root's values, without a step, before the dataset's first
   * tracker starts. It applies to any subsample of its dataset.
   *
   * @param {Blob} blob
   * @param {{signal: AbortSignal, refreshUi: (options: {phase: 'commit'|'rollback'}) => Promise<void>|void}} options
   * @returns {Promise<void>}
   */
  restorePublishedDefaultState(blob, options) {
    if (!(blob instanceof Blob)) throw new TypeError('Published default session restore source must be a Blob.');
    requireExactKeys(options, ['signal', 'refreshUi'], 'Published default session restore options');
    requireSignal(options.signal, 'Published default session restore signal');
    throwIfAborted(options.signal);
    if (typeof options.refreshUi !== 'function') throw new TypeError('Published default session restore refreshUi must be a function.');
    return this._runOwnedRestore(async controller => {
      const file = await openHistoryFile(blob, { signal: controller.signal, onProgress: null });
      try {
        assertPublishedDefaultProfile(file.manifest);
      } catch (error) {
        await file.cancel(error);
        throw error;
      }
      return { ...file, ...sourceFacts(file.manifest) };
    }, {
      label: 'Starting view', totalBytes: blob.size, signal: options.signal, startingView: true, refreshUi: options.refreshUi,
    });
  }

  /**
   * Cancel the load under way and resolve once it has settled.
   * @returns {Promise<void>}
   */
  cancelRestore() {
    this._activeRestoreAbort?.abort(cancelled('user', 'Session restore was canceled by the user.'));
    const task = this._activeRestoreTask;
    return task === null ? Promise.resolve() : task.then(() => {}, () => {});
  }

  async cancelRestoreAndWait() {
    await this.cancelRestore();
  }

  /**
   * A file picker for `.cellucid-session` files: one hidden file input, the
   * same in every browser; null when the person cancels it. Call it
   * synchronously from the click that asks for it (a browser opens a picker
   * only then): Load, and Replay a session file in the State panel.
   * @returns {Promise<File|null>}
   */
  pickSessionFile() {
    return pickSessionFile();
  }

  /**
   * A session file as a saved history to replay (`app/history/replay.js`):
   * its manifest, then its chunks, each checked as the file format requires.
   * It is not compared with the dataset shown: a replay applies its steps by
   * name, on this dataset or another, and never its values.
   *
   * @param {Blob} blob
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<SavedHistorySource>}
   */
  async openSessionFile(blob, { signal = null } = {}) {
    if (!(blob instanceof Blob)) throw new TypeError('A session file to replay must be a Blob or File.');
    const file = await openHistoryFile(blob, { signal, onProgress: null });
    return { ...file, ...sourceFacts(file.manifest) };
  }

  /**
   * One load: replaces (cancels and awaits) the one under way, holds the
   * restore settlement, shows its progress, verifies, loads, and reports.
   * @private
   */
  _runOwnedRestore(openSource, {
    label, totalBytes, signal, startingView = false, refreshUi = null, importFile = null, heavy = null, stampOf = null,
  }) {
    const previous = this._activeRestoreTask;
    this._activeRestoreAbort?.abort(cancelled('superseded', 'Session restore was superseded by a newer restore.'));
    const controller = new AbortController();
    const detach = onAbort(signal, () => controller.abort(abortReason(signal)));
    const task = this._exclusive(async () => {
      if (previous !== null) await previous.catch(() => {});
      throwIfAborted(controller.signal);
      return this._withSettlement(this._restoreSettlement, () => this._restore(openSource, {
        label, totalBytes, controller, startingView, refreshUi, importFile, heavy, stampOf,
      }));
    });
    this._activeRestoreAbort = controller;
    this._activeRestoreTask = task;
    const release = () => {
      detach();
      if (this._activeRestoreTask === task) {
        this._activeRestoreTask = null;
        this._activeRestoreAbort = null;
      }
    };
    task.then(release, release);
    return task;
  }

  /**
   * After trackers were loaded beside the person's: what the load's notice
   * says of them (its title), and its Undo (`run`), which removes them to Recently deleted (each
   * load is journaled, `load`; undoing it is `history.journal.undo`, so it is
   * undoable and restorable as any edit). Null when there is nothing to undo
   * (no tracker of the person's beside them: the only trackers cannot go).
   * @private
   */
  _undoLoadOf(added) {
    const undoable = added.filter(tracker => tracker.journal !== null);
    const own = this._getHistory()?.trackers().filter(tracker => !undoable.some(each => each.id === tracker.id)).length ?? 0;
    if (undoable.length === 0 || own === 0 || !this._dispatcher) return null;
    const notifications = getNotificationCenter();
    const what = undoable.length === 1 ? `"${undoable[0].name}"` : formatCountOf(undoable.length, 'tracker');
    return {
      title: `Loaded ${what} beside yours`,
      run: () => {
        void (async () => {
          for (const tracker of undoable) {
            await this._dispatcher.dispatch('history.journal.undo', { tracker: tracker.id, entry: tracker.journal }, { origin: 'user' });
          }
        })().catch(error => notifications.error(`${joinFailure(`The load could not be undone`, sayFailure(error))}`, { ...failureDetails(error), category: 'session' }));
      },
    };
  }

  /** @private */
  /**
   * Whether `app` (a history's stamp) names another version than this page
   * (`writtenByOtherVersion`): `{when, version}`, or null.
   * @private
   */
  async _writtenBy(app) {
    let version = null;
    try {
      version = this._version();
    } catch {
      // A page that names no version compares the catalog alone.
    }
    const when = await writtenByOtherVersion(app, { catalog: this._catalog, version });
    return when === null ? null : { when, version: app.version };
  }

  /** @private */
  async _restore(openSource, { label, totalBytes, controller, startingView, refreshUi, importFile, heavy = null, stampOf = null }) {
    const notifications = getNotificationCenter();
    const line = restoreLine(notifications, {
      label, totalBytes, startingView,
      onCancel: () => controller.abort(cancelled('user', 'Session restore was canceled by the user.')),
    });
    this._progress = loaded => line.progress(loaded);
    // Heavy work the load finds once its file is read (the cells' totals a normalized restore or a
    // replayed step sums, F167): an agent's load asks first (`heavy`); every load names it on its
    // own progress line, with its Cancel, in the words the work gives (`estimate.doing`).
    const loadHeavy = async estimate => {
      if (heavy !== null) await heavy(estimate);
      if (typeof estimate?.doing === 'string' && estimate.doing !== '') line.phase(estimate.doing);
    };
    let source = null;
    let applied = false;
    try {
      // The file's header is read before anything else is refused: with no
      // dataset open, the refusal names the dataset it was saved on
      // (`verifySessionFingerprint`), which only the header knows.
      source = await openSource(controller);
      throwIfAborted(controller.signal);
      const ctx = { state: this._state, dataSourceManager: this._dataSourceManager };
      const mismatch = await verifySessionFingerprint(ctx, source.header.datasetFingerprint, {
        profile: startingView ? 'published-default' : null,
      });
      throwIfAborted(controller.signal);
      if (mismatch !== null) throw new RangeError(mismatch);
      const history = this._getHistory();
      if (history === null) throw new Error('No dataset is open. Open the dataset the session was saved on, then load the session again.');
      const missing = describeMissingFields(this._state, source.header);
      if (missing !== null) throw new RangeError(missing);
      // The page chrome it carries (its selection tool, CEL-0249): checked against this page
      // before anything is replaced, put back once the head is shown, what this page lacks said.
      const chrome = source.chrome === undefined || this._chrome === null ? null : this._chrome.plan(source.chrome);
      if (!startingView && source.content === 'steps') {
        // Steps only: no values to show, a plan to replay here (its fingerprint matched: the same dataset).
        const plan = await readReplayPlan(source, { signal: controller.signal });
        await history.settlePaused({ origin: 'session' });
        await history.replay(plan, { signal: controller.signal, heavy: loadHeavy });
        chrome?.apply();
        line.complete('Session steps replayed.');
        for (const note of chrome?.notes ?? []) notifications.info(note);
        this._onLoaded();
        return;
      }
      const eager = await source.readEager();
      throwIfAborted(controller.signal);
      if (startingView) {
        await source.readRest();
        const [tracker] = eager.history.trackers;
        const [root] = tracker.steps;
        assertPublishedDefaultRoot(root);
        const values = Object.fromEntries(Object.entries(root.after).map(([id, hash]) => [id, eager.values.get(hash)]));
        const { leftOut } = await history.showValues(values, keepShownControls, { heavy: loadHeavy });
        // The starting view's page chrome (its selection tool, CEL-0249).
        chrome?.apply();
        applied = true;
        throwIfAborted(controller.signal);
        await refreshUi({ phase: 'commit' });
        line.dismiss();
        if (leftOut.length > 0) {
          // A part another version of Cellucid has and this one does not is left out, the rest shown (F164).
          const partial = describeUnrestored(leftOut.map(domain => ({ part: 'unknown-domain', domain })), {
            other: await this._writtenBy(source.stamps?.app).catch(() => null), subject: 'Starting view',
          });
          console.warn(`[session] ${partial.message}\n${partial.details}`);
          notifications.show({ type: 'warning', category: 'session', message: partial.message, duration: 0, details: partial.details });
        }
        tellHeldCategories(this._state, label, notifications);
        this._onLoaded();
        return;
      }
      const rest = async () => {
        throwIfAborted(controller.signal);
        const more = await source.readRest();
        throwIfAborted(controller.signal);
        return more;
      };
      // Changes made while recording was paused are kept as one step before anything else is shown.
      await history.settlePaused({ origin: 'session' });
      let loaded = null;
      let unrestored;
      if (importFile === null) {
        ({ unrestored } = await history.load(eager.history, { values: eager.values, signal: controller.signal, rest, heavy: loadHeavy }));
      } else {
        loaded = await history.importTrackers(eager.history, { file: importFile, values: eager.values, signal: controller.signal, rest, heavy: loadHeavy });
        ({ unrestored } = loaded);
      }
      chrome?.apply();
      // One notice says how the load ended, and, when it added trackers beside the person's, which, with
      // Undo: a progress notice keeps the action it was made with (its Cancel), so it gives way to that one.
      // A load that could not restore every part names each part it could not, with its words under Details (F155).
      const undo = loaded === null ? null : this._undoLoadOf(loaded.trackers);
      const partial = unrestored.length === 0 ? null : describeUnrestored(unrestored, {
        other: await this._writtenBy(source.stamps?.app), savedState: importFile === null,
      });
      if (partial !== null) console.warn(`[session] ${partial.message}\n${partial.details}`);
      if (undo === null && partial === null) {
        line.complete('Session fully restored.');
      } else {
        line.dismiss();
        const shown = notifications.show({
          type: partial === null ? 'success' : 'warning', category: 'session',
          ...(undo === null ? {} : { title: undo.title }),
          message: partial === null ? 'Session fully restored.' : partial.message,
          ...(partial === null ? { duration: 10_000 } : { duration: 0, details: partial.details }),
          ...(undo === null ? {} : { action: { label: 'Undo', run: () => { notifications.dismiss(shown); undo.run(); } } }),
        });
      }
      for (const note of chrome?.notes ?? []) notifications.info(note);
      // Analysis results the file left out are computed again, as steps (`recompute-results.js`).
      const recomputed = await recomputeLeftOutResults({ history, dispatcher: this._dispatcher, signal: controller.signal });
      for (const { tone, text } of recomputeSentences(recomputed)) notifications[tone](text, { category: 'session' });
      tellHeldCategories(this._state, label, notifications);
      this._onLoaded();
      return { notRestored: partial === null ? null : partial.message };
    } catch (err) {
      if (source !== null) await source.cancel(err).catch(() => {});
      if (startingView && applied) {
        // The starting view was put back, then its dataset changed or its
        // interface did not follow: the interface is shown again from what is
        // there (a replaced dataset retires this history anyway).
        try { await refreshUi({ phase: 'rollback' }); } catch { /* the failure above is the one reported */ }
      }
      if (isDismissal(err, controller.signal) || (startingView && isCancellation(err) && controller.signal.aborted)) {
        line.dismiss();
      } else if (startingView && !isCancellation(err)) {
        // Its caller says that the sample view could not be applied.
        line.dismiss();
      } else if (isCancellation(err)) {
        line.fail('Session restore canceled.');
        markReported(err);
      } else {
        // Written by another version: said as that (`describeLoadFailure`), wherever the error is said next.
        const app = source?.stamps?.app ?? (stampOf === null ? null : await stampOf().catch(() => null));
        const other = await this._writtenBy(app).catch(() => null);
        if (other !== null && err !== null && typeof err === 'object') WRITTEN_BY.set(err, other);
        const { message, details } = describeLoadFailure(err);
        line.fail(message, { details });
        markReported(err);
      }
      throw controller.signal.aborted && isDismissal(err, controller.signal) ? controller.signal.reason : err;
    } finally {
      this._progress = null;
    }
  }
}

/**
 * The line a load shows while it runs (round 9 close, RCA-7). A session file
 * or a saved state of this browser: a loading line with its Cancel (its bytes
 * as they are read, and their speed once measured: `download-tracking.js`). A
 * starting view: none. It is a part of its dataset's opening, whose card says
 * what is happening; a line of its own read "Loading Starting view 0 B/s" at
 * every sample's start, a transfer that was none (its file is in the page).
 * Its failure is said by its caller ("the sample view could not be applied").
 */
function restoreLine(notifications, { label, totalBytes, startingView, onCancel }) {
  if (startingView) {
    return Object.freeze({ progress() {}, phase() {}, complete() {}, dismiss() {}, fail() {} });
  }
  const id = notifications.startDownload(label, totalBytes, { onCancel });
  return Object.freeze({
    progress: loaded => notifications.updateDownload(id, loaded, totalBytes),
    phase: doing => notifications.phaseDownload(id, doing),
    complete: message => notifications.completeDownload(id, message),
    dismiss: () => notifications.dismissDownload(id),
    fail: (message, options = {}) => notifications.failDownload(id, message, options),
  });
}

/** What a session file says beside its history, as a `SavedHistorySource` gives it. */
function sourceFacts(manifest) {
  return {
    header: manifest, content: manifest.scope.content, chrome: manifest.chrome,
    stamps: { app: manifest.app, actions: manifest.actions },
  };
}

/** The Cellucid version this page names (`utils/page-version.js`); a session file says what wrote it. */
function writingVersion() {
  const version = pageVersion();
  if (version === null) throw new Error('This page names no Cellucid version, so a session file cannot say what wrote it.');
  return version;
}

/**
 * Which dataset a session manifest (or a saved state's header) belongs to,
 * and where it opens from.
 *
 * @param {object} header
 */
export function describeSessionDataset(header) {
  return Object.freeze({
    datasetId: header.datasetFingerprint.datasetId,
    name: header.datasetFingerprint.name,
    source: header.source,
    cells: Object.hasOwn(header, 'cells') ? decodeCellSubsetRecord(header.cells, 'Session manifest cells') : null,
    genes: Object.hasOwn(header, 'genes')
      ? decodeGeneSampleRecord(header.genes, header.datasetFingerprint.cellCount, 'Session manifest genes')
      : null,
  });
}

/**
 * Open a file picker for `.cellucid-session` files.
 * @returns {Promise<File|null>}
 */
function pickSessionFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = false;
    input.accept = '.cellucid-session,application/octet-stream';
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    input.style.top = '0';
    input.style.opacity = '0';
    document.body.appendChild(input);
    let settled = false;
    const settle = (file, error = null) => {
      if (settled) return;
      settled = true;
      input.remove();
      if (error !== null) reject(error);
      else resolve(file);
    };
    input.addEventListener('change', () => {
      if (input.files === null) {
        settle(null, new TypeError('Session file input did not publish a FileList.'));
        return;
      }
      settle(input.files.length === 1 ? input.files[0] : null);
    }, { once: true });
    input.addEventListener('cancel', () => settle(null), { once: true });
    input.click();
  });
}
