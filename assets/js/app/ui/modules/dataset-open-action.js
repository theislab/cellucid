/**
 * @fileoverview The Open data controls as actions: the datasets an agent can
 * open by name (`datasets.list`) and opening one (`dataset.open`), defined
 * in `app/actions/definitions/datasets.js`.
 *
 * Opening takes the paths the person's own choices take, so it behaves as
 * theirs does (the opening on screen with Cancel, failures said where theirs
 * are, My datasets recording it, the starting view and the offer to
 * continue a saved history):
 *
 * - a sample: the sample list's opening (`openDatasetSource`);
 * - a dataset of My datasets: as its menu opens it, with the cells it was
 *   last open with (`openWithLastCells`); a file or folder of this computer
 *   only where the browser already lets the page read it again (it asks
 *   the person for leave only inside their own click), else refused with
 *   what the person does instead;
 * - a link, an accession or a server: as the address bar opens it
 *   (`openTypedAddress`), showing its default dataset.
 *
 * A whole-file download (a host that serves no parts of a file, nothing of
 * it kept here) is asked about first when an agent opens the dataset: the
 * page's download gate (`data/whole-download.js`) asks through the
 * dispatcher's confirmer (`ctx.confirm`) for the opening this action
 * started, never for an opening someone else started meanwhile. A refusal
 * ends that opening as cancelled, so the dataset shown stays.
 *
 * A notebook (a viewer host) does not open datasets this way: its viewer
 * shows what it serves (`app/viewer-host/command-handler.js`).
 *
 * @module ui/modules/dataset-open-action
 */

import { quoteName } from '../../actions/targets/names.js';
import { ActionRefused } from '../../actions/dispatcher.js';
import { resolveDatasetName } from '../../actions/targets/datasets.js';
import { listMyDatasets } from '../../library/my-datasets.js';
import { listSavedStates } from '../../history/autosave.js';
import { getSavedHistories } from '../../history/current.js';
import { routeAddress } from './address-routing.js';
import { openWithLastCells } from './my-datasets/index.js';
import { datasetKind, keptOf, savedStatesOf } from './my-datasets/model.js';
import { listKeptStores } from '../../../data/anndata/transcode/space.js';
import { getProviderRegistry } from '../../../data/sources/registry.js';
import { getOpeningProgress } from '../../../data/opening-progress.js';
import { setWholeDownloadGate } from '../../../data/whole-download.js';
import { cancelled, onAbort, throwIfAborted } from '../../../utils/abort.js';
import { formatBytes } from '../../../utils/format-units.js';
import { PLACES, placePath } from '../place-names.js';

/** What each data source type is as `datasets.list` and `dataset.open` name it. */
const KIND_OF_SOURCE = Object.freeze({
  'local-demo': 'sample',
  link: 'link',
  remote: 'server',
  'local-user': 'file',
  jupyter: 'notebook',
});

/** Why the link box would not take `text`, or null (`address-routing.js`, the provider registry). */
export function linkProblemOf(text, { registry = getProviderRegistry() } = {}) {
  const route = routeAddress(text, { registry });
  if (route.kind === 'invalid') return route.message;
  if (route.kind !== 'link') return null;
  try {
    registry.resolve(route.value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * @param {{
 *   actions: ReturnType<typeof import('../../actions/dispatcher.js').createActionDispatcher>,
 *   dataSourceManager: object,
 *   state: {pointCount: number},
 *   datasetControls: {
 *     openDatasetSource: (record: object) => Promise<boolean>,
 *     openTypedAddress: (text: string, options?: {signal?: AbortSignal|null}) => Promise<{shown: boolean, problem: string|null}>,
 *     keptLocalFile: (datasetId: string) => Promise<{name: string, kind: string, granted: boolean}|null>,
 *     reopenLocalFile: (datasetId: string) => Promise<boolean>,
 *   },
 *   listMine?: () => Promise<object[]>,
 *   listSaved?: () => Promise<Array<{dataset: {id: string|null}, current?: boolean, bytes: number}>>,
 *   listKept?: () => Promise<Array<{name: string|null, host: string|null, bytes: number, kind: string}>>,
 *   opening?: ReturnType<typeof getOpeningProgress>,
 * }} options - `listKept`: what the Stored machinery keeps (`listKeptStores`), whose part of each
 *   dataset My datasets' facts name (`keptOf`)
 * @returns {() => void} removes both implementations and the download gate
 */
export function installDatasetOpenActions({
  actions, dataSourceManager, state, datasetControls,
  listMine = () => listMyDatasets(),
  // The State section's list marks the history shown now (`current`): not a state kept from before.
  listSaved = () => getSavedHistories()?.list() ?? listSavedStates(),
  listKept = () => listKeptStores().catch(() => []),
  opening = getOpeningProgress(),
}) {
  /**
   * The agent's opening under way: the opening it started (its id, once one
   * begins after it), how to ask the person, and their refusal once given.
   * @type {{before: string|null, ours: string|null, confirm: Function, declined: Error|null}|null}
   */
  let agentOpening = null;

  const stopFollowing = opening.subscribe(snapshot => {
    if (agentOpening === null || agentOpening.ours !== null || snapshot === null) return;
    if (snapshot.id !== agentOpening.before) agentOpening.ours = snapshot.id;
  });

  const removeGate = setWholeDownloadGate(async ({ name, bytes, why }) => {
    const owner = agentOpening;
    if (owner === null || owner.ours === null || opening.snapshot()?.id !== owner.ours) return;
    const size = bytes === null ? 'all of it' : formatBytes(bytes);
    try {
      await owner.confirm(`It downloads the whole file ${name} (${size}) into this browser: ${why}.`);
    } catch (error) {
      owner.declined = error;
      throw cancelled('user', 'The download was declined.', error);
    }
  });

  async function samples() {
    const source = dataSourceManager.getSource('local-demo');
    if (typeof source?.listCatalogEntries !== 'function' || !(await source.isAvailable())) return [];
    try {
      return (await source.listDatasets()).map(sample => ({
        id: sample.id, name: sample.name, cells: sample.stats?.n_cells ?? null, genes: sample.stats?.n_genes ?? null,
      }));
    } catch {
      // Their files could not be described: the catalog's own entries still name them.
      return (await source.listCatalogEntries()).map(entry => ({ id: entry.id, name: entry.name, cells: null, genes: null }));
    }
  }

  function openNow() {
    const sourceType = dataSourceManager.getCurrentSourceType();
    const metadata = dataSourceManager.getCurrentMetadata?.() ?? null;
    if (typeof sourceType !== 'string' || metadata === null) return null;
    return { sourceType, metadata };
  }

  /** Whether the browser lets this page read a kept file again without the person's click. */
  async function agentCanOpen(entry) {
    if (entry.source.kind !== 'file') return true;
    const kept = await datasetControls.keptLocalFile(entry.source.dataset);
    return kept !== null && kept.granted === true;
  }

  async function list() {
    const [listedSamples, mine, saved, kept] = await Promise.all([samples(), listMine(), listSaved(), listKept()]);
    const shown = openNow();
    return {
      open: shown === null ? null : { name: shown.metadata.name, kind: KIND_OF_SOURCE[shown.sourceType] ?? 'file' },
      samples: listedSamples,
      // Each with the facts My datasets › All… shows of its size: its file, its saved states, what Stored keeps of it.
      my_datasets: await Promise.all(mine.map(async entry => {
        const states = savedStatesOf(entry, saved);
        return {
          name: entry.name,
          kind: datasetKind(entry),
          cells: entry.cells ?? null,
          genes: entry.genes ?? null,
          last_opened: new Date(entry.lastOpenedAt).toISOString(),
          saved_states: states.filter(each => each.current !== true).length,
          size: entry.storage?.bytes ?? null,
          saved_states_bytes: states.reduce((sum, each) => sum + each.bytes, 0),
          kept_bytes: keptOf(entry, kept)?.bytes ?? 0,
          agent_can_open: await agentCanOpen(entry),
        };
      })),
    };
  }

  /** The dataset open now, as `dataset.open` answers. */
  async function outcomeOf(kind, alreadyOpen) {
    const shown = openNow();
    const id = dataSourceManager.getCurrentIdentityId?.() ?? null;
    const saved = id === null ? [] : (await listSaved()).filter(each => each.dataset?.id === id && each.current !== true);
    return {
      name: shown?.metadata.name ?? '',
      kind,
      cells: Number.isSafeInteger(state.pointCount) ? state.pointCount : 0,
      total_cells: shown?.metadata.stats?.n_cells ?? state.pointCount ?? 0,
      genes: shown?.metadata.stats?.n_genes ?? null,
      saved_states: saved.length,
      already_open: alreadyOpen,
    };
  }

  /** Why the opening this action started did not show its dataset, as one sentence. */
  function notOpened(owner, name) {
    if (owner.declined !== null) {
      return new ActionRefused(`The person declined the download, so ${quoteName(name)} was not opened.`, { code: 'declined', type: 'dataset.open' });
    }
    const snapshot = owner.ours === null ? null : opening.snapshot();
    if (snapshot !== null && snapshot.id === owner.ours) {
      if (snapshot.state === 'cancelled') {
        return new ActionRefused(`The person cancelled opening ${quoteName(name)}; the dataset shown stays.`, { code: 'cancelled', type: 'dataset.open' });
      }
      if (snapshot.state === 'failed') {
        const why = snapshot.summary ?? snapshot.message ?? 'it could not be read';
        return new ActionRefused(`${quoteName(name)} could not be opened: ${why}`, { code: 'failed', type: 'dataset.open' });
      }
    }
    return new ActionRefused(`${quoteName(name)} was not opened: another dataset was chosen meanwhile, or its opening was stopped.`, {
      code: 'not-opened', type: 'dataset.open',
    });
  }

  async function open(params, { signal, confirm }) {
    throwIfAborted(signal);
    const [listedSamples, mine] = await Promise.all([samples(), listMine()]);
    const target = resolveDatasetName(params.name, {
      kind: params.kind, samples: listedSamples, mine, linkProblem: text => linkProblemOf(text),
    });
    const shown = openNow();
    const currentId = dataSourceManager.getCurrentDatasetId?.() ?? null;
    const currentIdentity = dataSourceManager.getCurrentIdentityId?.() ?? null;
    if (target.kind === 'sample' && shown?.sourceType === 'local-demo' && currentId === target.sample.id) {
      return outcomeOf('sample', true);
    }
    if (target.kind === 'my-datasets' && currentIdentity === target.entry.id) {
      return outcomeOf(datasetKind(target.entry), true);
    }
    if (target.kind === 'my-datasets' && target.entry.source.kind === 'file') {
      const kept = await datasetControls.keptLocalFile(target.entry.source.dataset);
      if (kept === null) {
        throw new ActionRefused(`${target.entry.name} is a ${datasetKind(target.entry)} of the person's computer that this browser no longer holds: ask them to open it with ${placePath(PLACES.session, PLACES.openData)} › Open….`, {
          code: 'needs-person', type: 'dataset.open',
        });
      }
      if (!kept.granted) {
        throw new ActionRefused(`${target.entry.name} is a ${datasetKind(target.entry)} of the person's computer, which the browser lets only the person open again: ask them to choose it in ${PLACES.myDatasets.name}.`, {
          code: 'needs-person', type: 'dataset.open',
        });
      }
    }
    if (agentOpening !== null) {
      throw new ActionRefused('Another dataset is being opened for an agent; wait for it to finish.', { code: 'busy', type: 'dataset.open' });
    }

    const owner = { before: opening.snapshot()?.id ?? null, ours: null, confirm, declined: null };
    agentOpening = owner;
    // Stopped by the agent (or its tab closing): the opening it started stops too.
    const removeAbort = onAbort(signal, () => {
      const snapshot = opening.snapshot();
      if (owner.ours !== null && snapshot?.id === owner.ours && snapshot.state === 'running') opening.cancel();
    });
    const name = target.kind === 'sample' ? target.sample.name : target.kind === 'my-datasets' ? target.entry.name : target.value;
    let shownNow = false;
    let kind;
    try {
      if (target.kind === 'sample') {
        kind = 'sample';
        shownNow = await datasetControls.openDatasetSource({ kind: 'sample', dataset: target.sample.id });
      } else if (target.kind === 'my-datasets') {
        const { entry } = target;
        kind = datasetKind(entry);
        shownNow = await openWithLastCells(entry, true, () => (entry.source.kind === 'file'
          ? datasetControls.reopenLocalFile(entry.source.dataset)
          : datasetControls.openDatasetSource(entry.source)));
      } else {
        const opened = await datasetControls.openTypedAddress(target.value, { signal });
        if (opened.problem !== null) throw new ActionRefused(opened.problem, { code: 'unknown-dataset', type: 'dataset.open' });
        shownNow = opened.shown;
        kind = KIND_OF_SOURCE[dataSourceManager.getCurrentSourceType()] ?? 'link';
      }
    } finally {
      removeAbort();
      agentOpening = null;
    }
    throwIfAborted(signal);
    if (!shownNow) throw notOpened(owner, name);
    return outcomeOf(kind, false);
  }

  const removers = [
    actions.provide('datasets.list', () => list()),
    actions.provide('dataset.open', open),
  ];
  return () => {
    for (const remove of removers) remove();
    removeGate();
    stopFollowing();
  };
}
