/**
 * @fileoverview "Save AnnData with this state…" (History v2 §3.11, P9, owner
 * decision Q3): the action `history.anndata.save`, one path for the History
 * ⋯ menu and for agents. It writes a **new** Cellucid-ready AnnData
 * `.zarr.zip` of the open dataset with the state shown applied, as
 * cellucid-python and cellucid-r apply a session, and never writes over the
 * dataset's own file.
 *
 * 1. **Where it goes.** A file the person names in the browser's save dialog
 *    (`showSaveFilePicker`, a new file; the dataset's own file, when it was
 *    opened from this computer, is refused), when the page may open one (the
 *    person's own click, in a browser that has it); else a spool in this
 *    browser's private storage (`app/exports/cell-exports.js` `createSpool`),
 *    downloaded once whole. On a failure or a cancel the file's writable is
 *    aborted (never closed: a closed one would leave a partial file under
 *    the chosen name) and the spool's files are removed.
 * 2. **What it writes.** What is shown is what is saved: the history's
 *    paused changes become a step first, as Share writes them
 *    (`session-serializer.js` `writeShare`, whose "Current state only" file
 *    names the provenance by its SHA-256). The head's state is planned
 *    against the dataset as stored (`exports/anndata-copy.js`, reading through
 *    `BaseAnnDataAdapter.readCopyTarget`: the obs columns, those the plan
 *    reads whole, the `uns` keys and the colors of the columns it renames,
 *    relabels or recolors, `uns['cellucid']`), with the open cells as the cells the
 *    state is known on; then copied (`BaseAnnDataAdapter.writeAnnDataCopy`).
 * 3. **How far it is.** One cancellable job (`app/jobs/cancellable-job.js`):
 *    its notification shows the copy's reads (kind `cells`, owned by the
 *    job) with Cancel; the outcome is told once, with what was left out in
 *    its details (the plan's rows not applied, the copy's own notes).
 *
 * Refused in one sentence, before anything is written: no dataset open, a
 * name a file cannot hold (a gene set or a field with `/` in its name, until
 * the three packages agree on a path-safe form), the dataset's matrix still
 * being read (`AnnDataReader.storedRoot`: a MatrixMarket folder streaming in).
 *
 * @module app/history/anndata-copy-save
 */

import { ActionRefused } from '../actions/dispatcher.js';
import { STATE_DEFAULTS } from '../session/share-scope.js';
import { CancellableJob } from '../jobs/cancellable-job.js';
import { chooseStep, planAnnDataCopy, unwritableName } from './exports/anndata-copy.js';
import { valuesAt } from './tree.js';
import { requireElementKey } from '../../data/anndata/write/names.js';
import { MODALITY_KEY } from '../../data/data-mapping.js';
import { findField, loadField } from '../state/domains/fields.js';
import { cancelled, isCancellation, onAbort } from '../../utils/abort.js';
import { formatBytes, formatCountOf } from '../../utils/format-units.js';
import { pageVersion } from '../utils/page-version.js';
import { failureSentence } from '../../utils/errors.js';
import { fileFormatOfName } from '../../data/input-formats.js';
import { sha256Hex } from '../../utils/sha256.js';
import { safeFileName } from '../utils/download.js';

/** The ending every copy's file has (owner decision Q3: `.zarr.zip` only). */
export const ANNDATA_COPY_SUFFIX = '.zarr.zip';
const TITLE = 'Save AnnData with this state';

/** A file name for the copy of a dataset named `name`. */
export function copyFileName(name) {
  return `${safeFileName(name, 'Cellucid dataset')} with this state${ANNDATA_COPY_SUFFIX}`;
}

/**
 * A name the caller gave, as the copy's file is named: as given when the
 * input-format registry reads it as an AnnData Zarr in one ZIP, else with
 * the copy's ending added.
 */
export function copyFileNamed(file) {
  const safe = safeFileName(file);
  const format = fileFormatOfName(safe);
  return (format?.format === 'zarr' || format?.format === 'mudata-zarr') && format.layout === 'zip' ? safe : `${safe}${ANNDATA_COPY_SUFFIX}`;
}

/**
 * Where the copy's bytes go: a new file the person names, or a spool then a download.
 *
 * @returns {Promise<{name: string, sink: {write: (part: Blob) => Promise<void>}, finish: () => Promise<void>,
 *   discard: () => Promise<void>, to: 'file'|'download'}>}
 */
async function openDestination({ name, useDialog, sourceHandle, createSpool, download }) {
  const view = globalThis;
  if (useDialog && typeof view.showSaveFilePicker === 'function') {
    let handle = null;
    try {
      handle = await view.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'Cellucid-ready AnnData (.zarr.zip)', accept: { 'application/zip': ['.zip'] } }],
      });
    } catch (error) {
      // The dialog closed without a name: nothing to save.
      if (isCancellation(error)) throw cancelled('user', 'No file was chosen, so no copy was saved.', error);
      // No dialog for this page now (no click of the person's to open it): saved as a download.
      if (error?.name !== 'SecurityError' && error?.name !== 'NotAllowedError') throw error;
    }
    if (handle !== null) {
      const own = await sourceHandle().catch(() => null);
      if (own !== null && typeof handle.isSameEntry === 'function' && await handle.isSameEntry(own)) {
        throw new ActionRefused('That is the file this dataset is open from; a copy is always saved as a new file, so choose another name.', { code: 'refused' });
      }
      const writable = await handle.createWritable();
      return {
        name: handle.name,
        to: 'file',
        sink: { write: part => writable.write(part) },
        finish: () => writable.close(),
        discard: () => writable.abort().catch(() => {}),
      };
    }
  }
  const spool = await createSpool('anndata-copy');
  return {
    name,
    to: 'download',
    sink: spool,
    finish: async () => download(await spool.finish(), name),
    discard: () => spool.discard(),
  };
}

/**
 * The genes of the var frame a copy can change, one per var row, as the
 * viewer names them: the data mapping's gene names on its gene axis when that
 * is a var frame (`X` or a layer, of the mapping's modality); null when the
 * mapping reads the raw matrix's genes (`raw.var`, which a copy keeps as
 * stored).
 */
function genesOf(state, mapping, varColumns) {
  if (mapping === null || mapping === undefined || mapping.expression === 'raw') return null;
  const names = [];
  for (const field of state.varData?.fields ?? []) {
    if (field?._isUserDefined === true || typeof field?.path !== 'string') continue;
    const match = /\/(0|[1-9][0-9]*)$/.exec(field.path);
    if (match !== null) names[Number(match[1])] = field.key;
  }
  if (names.length === 0) return null;
  for (let row = 0; row < names.length; row++) names[row] ??= null;
  return { names, modality: mapping[MODALITY_KEY] ?? null, columns: varColumns };
}

/** What was left out of a copy, in lines: the plan's rows not applied, then the copy's own notes. */
export function leftOutLines(plan, notes) {
  return [
    ...plan.rows.filter(row => row.status === 'not-applied').map(row => `${row.name}: ${row.note}`),
    ...notes,
  ];
}

/**
 * Provide `history.anndata.save` on `dispatcher`. Returns what stops providing it.
 *
 * @param {{
 *   dispatcher: ReturnType<typeof import('../actions/dispatcher.js').createActionDispatcher>,
 *   histories: ReturnType<typeof import('./dataset-history.js').createDatasetHistories>,
 *   serializer: import('../session/session-serializer.js').SessionSerializer,
 *   state: Object,
 *   adapter: () => Object|null,
 *   datasetFacts: () => {name?: string|null},
 *   sourceHandle?: () => Promise<FileSystemHandle|null>,
 *   createSpool: typeof import('../exports/cell-exports.js').createSpool,
 *   download: (blob: Blob, filename: string) => void,
 *   notifications: Object,
 *   version?: () => string|null,
 * }} options - `adapter`: the open dataset's `BaseAnnDataAdapter`; `sourceHandle`: the
 *   open dataset's own file when it was opened from this computer (never written over)
 */
export function provideAnnDataCopyAction({
  dispatcher, histories, serializer, state, adapter, datasetFacts, sourceHandle = async () => null, createSpool, download,
  notifications, version = () => pageVersion(),
}) {
  let running = null;
  return dispatcher.provide('history.anndata.save', async (params, context) => {
    try {
      return await saveCopy(params, context);
    } catch (error) {
      // Refused in one sentence, told once (a failure is told by its job).
      if (error instanceof ActionRefused) notifications.warning(failureSentence(error), { category: 'download' });
      throw error;
    }
  });

  async function saveCopy(params, { signal, meta }) {
    const history = histories.current();
    if (history === null || history.active === null) {
      throw new ActionRefused('A copy with this state is saved once a dataset is open.', { code: 'unavailable', type: 'history.anndata.save' });
    }
    const source = adapter();
    if (source === null || typeof source.writeAnnDataCopy !== 'function') {
      throw new ActionRefused('This dataset cannot be saved as an AnnData copy.', { code: 'unavailable', type: 'history.anndata.save' });
    }
    if (running !== null) {
      throw new ActionRefused('A copy is being saved: wait for it, or cancel it on its card.', { code: 'busy', type: 'history.anndata.save' });
    }
    // The dialog first, while the person's click still lets the page open it.
    const name = params.file === undefined ? copyFileName(datasetFacts()?.name ?? null) : copyFileNamed(params.file);
    const userActivated = globalThis.navigator?.userActivation?.isActive ?? true;
    const destination = await openDestination({
      name, useDialog: meta.origin === 'user' && userActivated, sourceHandle, createSpool, download,
    });
    const job = new CancellableJob({ title: TITLE, category: 'download', readKind: 'cells', successNotice: true, notifications });
    running = job;
    const stop = onAbort(signal, () => job.cancel());
    let written = false;
    try {
      job.step('Planning the copy');
      // What is shown is what is saved; the "Current state only" file names it.
      const { blob: stateFile } = await serializer.writeShare({ choice: STATE_DEFAULTS, signal });
      const sessionSha256 = await sha256Hex(new Uint8Array(await stateFile.arrayBuffer()));
      const shown = histories.current();
      if (shown !== history) throw new ActionRefused('Another dataset was opened while the copy was being planned; nothing was saved.', { code: 'refused' });
      const unhold = history.pool.hold();
      let made;
      let target;
      try {
        const snapshot = history.snapshot();
        const choice = chooseStep(snapshot.trackers, { activeTracker: snapshot.activeTracker });
        const hashes = valuesAt(choice.live, choice.step);
        const valueOf = domain => history.pool.get(hashes[domain]);
        const mapping = valueOf('mapping');
        const varModality = mapping?.[MODALITY_KEY] ?? null;
        const stored = await source.readCopyTarget([], { signal: job.signal, owner: job.id, varModality });
        const columns = new Map();
        const identity = state.cellIdentity;
        target = {
          nObs: stored.nObs,
          obsColumns: stored.obsColumns,
          modalityColumns: new Set(stored.modalityColumns),
          unsKeys: stored.unsKeys,
          colors: async column => {
            const read = await source.readCopyTarget([], { signal: job.signal, owner: job.id, varModality, colors: [column] });
            return read.colors[column] ?? null;
          },
          cellucid: stored.cellucid,
          known: identity?.kept ?? null,
          column: async column => {
            if (!columns.has(column)) {
              const read = await source.readCopyTarget([column], { signal: job.signal, owner: job.id, varModality });
              columns.set(column, read.columns[column] ?? null);
            }
            return columns.get(column);
          },
          copiedValues: async field => {
            const ref = { source: field.source, user: field.id };
            const found = findField(state, ref);
            if (found === null) throw new Error(`The field "${field.key}" is not open, so its values cannot be copied.`);
            await loadField(state, ref, found, job.signal);
            const values = found.field.values;
            const cells = new Uint32Array(values.length);
            for (let i = 0; i < cells.length; i++) cells[i] = identity.originalAt(i);
            return { cells, values };
          },
          genes: genesOf(state, mapping, stored.varColumns),
        };
        if (identity !== null && identity !== undefined && identity.nOriginal !== stored.nObs) {
          throw new ActionRefused(`The dataset's file holds ${formatCountOf(stored.nObs, 'cell')} and the open dataset ${formatCountOf(identity.nOriginal, 'cell')}; open it again to save a copy.`, { code: 'refused' });
        }
        made = await planAnnDataCopy({ choice, valueOf, target, sessionSha256, version: version() ?? 'unknown' });
      } finally {
        unhold();
      }
      const refusal = unwritableName(made.plan, requireElementKey);
      if (refusal !== null) throw new ActionRefused(refusal, { code: 'refused' });

      job.step('Writing the copy');
      const result = await source.writeAnnDataCopy(made.changes, { sink: destination.sink, signal: job.signal, owner: job.id });
      await destination.finish();
      written = true;
      const leftOut = leftOutLines(made.plan, [...made.leftOut, ...result.notes]);
      const wrote = made.plan.rows.filter(row => row.status === 'write' || row.status === 'replace').length;
      const summary = `Saved ${destination.name} (${formatBytes(result.bytes)}): ${wrote === 0 ? 'nothing new applied' : `${formatCountOf(wrote, 'change')} applied`}`
        + `${leftOut.length === 0 ? '' : `, ${formatCountOf(leftOut.length, 'item')} left out (see Details)`}.`;
      job.succeed(summary, { details: leftOut.length === 0 ? '' : `Left out:\n${leftOut.map(line => `• ${line}`).join('\n')}` });
      const idName = record => ({ id: record.id, name: record.name });
      const tracker = history.trackerRecord(made.plan.tracker);
      return {
        file: destination.name,
        to: destination.to,
        bytes: result.bytes,
        layout: result.layout,
        cells: result.nObs,
        tracker: idName(tracker),
        branch: idName(tracker.branches.find(branch => branch.id === made.plan.branch)),
        step: made.plan.step,
        applied: made.provenance !== null,
        rows: made.plan.rows.map(({ kind, name: rowName, status, cells, note }) => ({ kind, name: rowName, status, cells, note })),
        left_out: leftOut,
      };
    } catch (error) {
      if (!written) await destination.discard();
      if (signal?.aborted || job.signal.aborted || isCancellation(error)) {
        job.cancel();
        throw isCancellation(error) ? error : cancelled('user', `${TITLE} was canceled.`, error);
      }
      if (error instanceof ActionRefused) job.cancel();
      else job.fail(error);
      throw error;
    } finally {
      stop();
      running = null;
    }
  }
}
