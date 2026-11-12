/**
 * @fileoverview The Open data controls as actions: the datasets an agent can
 * open by name (`datasets.list`) and opening one (`dataset.open`), defined
 * in `app/actions/definitions/datasets.js`; and opening a saved state of
 * this browser to continue it (`history.saved.open`, defined in
 * `definitions/history.js`), which is Load…'s Open (`SavedHistories.open`:
 * its dataset first, then its history) run as an agent's opening, so a
 * whole-file download of its dataset is asked about as `dataset.open`'s is.
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
 * A count or fraction of the cells (`CELLS_TO_OPEN`, checked as `cells.open`
 * checks it: `targets/cells-to-open.js`) is the next opening's request
 * (`setNextCellSubsetRequest`), as a link's subsample is: the dataset is read
 * once with those cells, in place of the cells the tab opens datasets with
 * or a dataset of My datasets was last open with. A dataset open already is
 * not opened again; asked for other cells, it is refused naming `cells.open`.
 *
 * A link, an accession or a server the person has not seen in this tab
 * (`seen-addresses.js`: typed or pasted in the address bar or the chat, open
 * now, or one of My datasets) is asked about before anything is requested
 * (`ctx.confirmLink`, F121): the request alone could carry to any host what
 * an agent misled by text it read put in the address. Declined, nothing is
 * opened or fetched.
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
import { setAgentReplacementAsk } from '../../unkept-work-guard.js';
import { setNextCellSubsetRequest, withdrawNextCellSubsetRequest } from '../../../data/cell-subset-policy.js';
import { openingCellsRequestOf } from '../../actions/targets/cells-to-open.js';
import { cancelled, onAbort, throwIfAborted } from '../../../utils/abort.js';
import { formatBytes } from '../../../utils/format-units.js';
import { joinFailure } from '../../../utils/errors.js';
import { PLACES, placePath } from '../place-names.js';
import { isSeenAddress } from './seen-addresses.js';
import { upperFirst } from '../../../utils/text-case.js';

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
 *   state: {pointCount: number, cellIdentity?: {nOriginal: number}|null},
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
 *   savedHistories?: () => import('../../history/current.js').SavedHistories|null,
 * }} options - `listKept`: what the Stored machinery keeps (`listKeptStores`), whose part of each
 *   dataset My datasets' facts name (`keptOf`); `savedHistories`: this browser's saved states
 *   (`history.saved.open` opens one as Load…'s Open does)
 * @returns {() => void} removes the three implementations and the download gate
 */
export function installDatasetOpenActions({
  actions, dataSourceManager, state, datasetControls,
  listMine = () => listMyDatasets(),
  // The State section's list marks the history shown now (`current`): not a state kept from before.
  listSaved = () => getSavedHistories()?.list() ?? listSavedStates(),
  listKept = () => listKeptStores().catch(() => []),
  opening = getOpeningProgress(),
  savedHistories = () => getSavedHistories(),
}) {
  /**
   * The agent's opening under way: the opening it started (its id, once one
   * begins after it), how to ask the person, and their refusal once given.
   * @type {{before: string|null, ours: string|null, confirm: Function, confirmReplacing: Function, declined: Error|null, kept: Error|null}|null}
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

  // The dataset shown holds work this browser is not keeping: the agent's
  // opening asks its person through the consent path (`ctx.confirmReplacing`,
  // `app/unkept-work-guard.js`), never a page dialog of its own.
  const removeReplacementAsk = setAgentReplacementAsk(() => {
    const owner = agentOpening;
    if (owner === null || owner.ours === null || opening.snapshot()?.id !== owner.ours) return null;
    return async text => {
      try {
        await owner.confirmReplacing(text);
      } catch (error) {
        owner.kept = error;
        throw error;
      }
    };
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
    const cells = Number.isSafeInteger(state.pointCount) ? state.pointCount : 0;
    return {
      name: shown?.metadata.name ?? '',
      kind,
      cells,
      // The dataset's cells, whatever share is open (its metadata counts the cells open).
      total_cells: state.cellIdentity?.nOriginal ?? cells,
      genes: shown?.metadata.stats?.n_genes ?? null,
      saved_states: saved.length,
      already_open: alreadyOpen,
    };
  }

  /**
   * Why the opening an action started did not show its dataset, as one
   * sentence. `name`: the dataset's, or (`history.saved.open`) the saved
   * state's as spoken, quoted already.
   */
  function notOpened(owner, name, type) {
    const spoken = type === 'dataset.open' ? quoteName(name) : name;
    const Spoken = upperFirst(spoken);
    if (owner.declined !== null) {
      return new ActionRefused(`The person declined the download, so ${spoken} was not opened.`, { code: 'declined', type });
    }
    if (owner.kept !== null) {
      return new ActionRefused(`The person kept the dataset shown, whose steps this browser is not keeping, so ${spoken} was not opened.`, { code: 'declined', type });
    }
    const snapshot = owner.ours === null ? null : opening.snapshot();
    if (snapshot !== null && snapshot.id === owner.ours) {
      if (snapshot.state === 'cancelled') {
        return new ActionRefused(`The person canceled opening ${spoken}; the dataset shown stays.`, { code: 'canceled', type });
      }
      if (snapshot.state === 'failed') {
        const why = snapshot.summary ?? snapshot.message ?? 'it could not be read';
        // The opening's summary says its own lead ("The linked data could not be opened: …"): said once.
        return new ActionRefused(joinFailure(`${Spoken} could not be opened`, why), { code: 'failed', type });
      }
    }
    return new ActionRefused(`${Spoken} was not opened: another dataset or session was chosen meanwhile, or its opening was stopped.`, {
      code: 'not-opened', type,
    });
  }

  /** A dataset already open is not opened again: asked for other cells, it says which action reads them. */
  function alreadyOpen(kind, cells, name) {
    if (cells !== null) {
      throw new ActionRefused(`${quoteName(name)} is open already: cells_open reads it again with other cells.`, {
        code: 'already-open', type: 'dataset.open',
      });
    }
    return outcomeOf(kind, true);
  }

  /**
   * The addresses the person sees in this tab now: the dataset open (its
   * link or server) and My datasets' links and servers (`mine`).
   */
  function shownAddresses(mine) {
    const sourceType = dataSourceManager.getCurrentSourceType?.() ?? null;
    const info = sourceType === null ? null : dataSourceManager.getSource?.(sourceType)?.getConnectionInfo?.() ?? null;
    const shown = [info?.locator, info?.url].filter(each => typeof each === 'string');
    for (const { source } of mine) {
      if (source?.kind === 'link') shown.push(source.locator);
      else if (source?.kind === 'remote') shown.push(source.url);
    }
    return shown;
  }

  async function open(params, { signal, confirm, confirmLink, confirmReplacing }) {
    throwIfAborted(signal);
    // The cells asked for, checked before anything is read (`cells-to-open.js`, as `cells.open` checks them).
    const cells = openingCellsRequestOf(params);
    const [listedSamples, mine] = await Promise.all([samples(), listMine()]);
    const target = resolveDatasetName(params.name, {
      kind: params.kind, samples: listedSamples, mine, linkProblem: text => linkProblemOf(text),
    });
    const shown = openNow();
    const currentId = dataSourceManager.getCurrentDatasetId?.() ?? null;
    const currentIdentity = dataSourceManager.getCurrentIdentityId?.() ?? null;
    if (target.kind === 'sample' && shown?.sourceType === 'local-demo' && currentId === target.sample.id) {
      return alreadyOpen('sample', cells, target.sample.name);
    }
    if (target.kind === 'my-datasets' && currentIdentity === target.entry.id) {
      return alreadyOpen(datasetKind(target.entry), cells, target.entry.name);
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
    // An address the person has not seen here is asked about before anything of it is requested.
    if (target.kind === 'link' && !isSeenAddress(target.value, shownAddresses(mine))) {
      await confirmLink(target.value);
      throwIfAborted(signal);
    }
    const name = target.kind === 'sample' ? target.sample.name : target.kind === 'my-datasets' ? target.entry.name : target.value;
    let shownNow = false;
    let kind;
    // The cells asked for are the next opening's (`cell-subset-policy.js`), as a link's subsample is:
    // the dataset is read once with them; the tab's choice for later openings stays the person's.
    let held = null;
    const owner = await asAgentOpening('dataset.open', { signal, confirm, confirmReplacing }, async () => {
      held = cells === null ? null : setNextCellSubsetRequest(cells);
      if (target.kind === 'sample') {
        kind = 'sample';
        shownNow = await datasetControls.openDatasetSource({ kind: 'sample', dataset: target.sample.id });
      } else if (target.kind === 'my-datasets') {
        const { entry } = target;
        kind = datasetKind(entry);
        const reopen = () => (entry.source.kind === 'file'
          ? datasetControls.reopenLocalFile(entry.source.dataset)
          : datasetControls.openDatasetSource(entry.source));
        // Without cells named, the cells it was last open with.
        shownNow = await (cells === null ? openWithLastCells(entry, true, reopen) : reopen());
      } else {
        const opened = await datasetControls.openTypedAddress(target.value, { signal });
        if (opened.problem !== null) throw new ActionRefused(opened.problem, { code: 'unknown-dataset', type: 'dataset.open' });
        shownNow = opened.shown;
        kind = KIND_OF_SOURCE[dataSourceManager.getCurrentSourceType()] ?? 'link';
      }
    }).finally(() => {
      if (held !== null) withdrawNextCellSubsetRequest(held);
    });
    throwIfAborted(signal);
    if (!shownNow) throw notOpened(owner, name, 'dataset.open');
    return outcomeOf(kind, false);
  }

  /**
   * Run `opens` as the agent's opening: the opening it starts is the one
   * the download gate asks the agent's person about, and the one stopped
   * when the agent stops; one at a time. Resolves the opening's owner (its
   * opening's id, the person's refusal) for `notOpened`.
   */
  async function asAgentOpening(type, { signal, confirm, confirmReplacing }, opens) {
    if (agentOpening !== null) {
      throw new ActionRefused('Another dataset is being opened for an agent; wait for it to finish.', { code: 'busy', type });
    }
    const owner = { before: opening.snapshot()?.id ?? null, ours: null, confirm, confirmReplacing, declined: null, kept: null };
    agentOpening = owner;
    // Stopped by the agent (or its tab closing): the opening it started stops too.
    const removeAbort = onAbort(signal, () => {
      const snapshot = opening.snapshot();
      if (owner.ours !== null && snapshot?.id === owner.ours && snapshot.state === 'running') opening.cancel();
    });
    try {
      await opens();
    } finally {
      removeAbort();
      agentOpening = null;
    }
    return owner;
  }

  /** How `history.saved.open` names a saved state, as the Load dialog does: its name, else its autosave's latest step. */
  function savedName(entry) {
    if (entry.name !== null) return quoteName(entry.name);
    return entry.lastStep != null ? `the autosave at ${quoteName(entry.lastStep)}` : `the autosave ${quoteName(entry.id)}`;
  }


  /**
   * Open a saved state of this browser to continue it (`history.saved.open`):
   * Load…'s Open (`SavedHistories.open`, the session controls' path: its
   * dataset first, with its cells, then its history), as the agent's
   * opening. Refused before anything opens when it cannot be: no such
   * state, one this version cannot open. The history shown already goes on.
   */
  async function openSaved({ saved: id }, { signal, confirm, confirmReplacing, heavy = null }) {
    throwIfAborted(signal);
    const type = 'history.saved.open';
    const store = savedHistories();
    if (store === null) {
      throw new ActionRefused('This browser keeps no saved states on this page (it gives the site no IndexedDB).', { code: 'unavailable', type });
    }
    const states = await store.list();
    const entry = states.find(state => state.id === id);
    if (entry === undefined) {
      throw new ActionRefused(
        `No saved state of this browser has the id ${quoteName(id)}; ${states.length === 0 ? 'none is saved' : `the saved states are ${states.map(state => quoteName(state.id)).join(', ')}`} (history_saved_list).`,
        { code: 'no-target', type },
      );
    }
    const result = ({ datasetOpened = false, alreadyShown = false, notRestored = null }) => ({
      saved: entry.id, name: entry.name, dataset: entry.dataset?.name ?? null, steps: entry.steps,
      dataset_opened: datasetOpened, already_shown: alreadyShown, not_restored: notRestored,
    });
    if (entry.current === true) return result({ alreadyShown: true });
    if (entry.openable === false) {
      throw new ActionRefused(`${upperFirst(savedName(entry))} was kept by another version of Cellucid, which this version cannot open or replay.`, { code: 'unopenable', type });
    }
    const before = dataSourceManager.getCurrentIdentityId?.() ?? null;
    let outcome = null;
    const owner = await asAgentOpening(type, { signal, confirm, confirmReplacing }, async () => {
      // The values it shows may sum cells' totals (normalized values): asked as heavy work.
      // Its Stop cancels the opening (above) and the history's restore after it.
      outcome = await store.open(id, { heavy, signal });
    });
    throwIfAborted(signal);
    if (!outcome.opened) {
      if (owner.declined !== null || owner.kept !== null || outcome.problem === null) throw notOpened(owner, savedName(entry), type);
      throw new ActionRefused(`${upperFirst(savedName(entry))} was not opened. ${outcome.problem}`, {
        code: outcome.code === 'needs-person' ? 'needs-person' : outcome.code === 'canceled' ? 'canceled' : 'failed', type,
      });
    }
    return result({ datasetOpened: (dataSourceManager.getCurrentIdentityId?.() ?? null) !== before, notRestored: outcome.notRestored ?? null });
  }

  const removers = [
    actions.provide('datasets.list', () => list()),
    actions.provide('dataset.open', open),
    actions.provide('history.saved.open', openSaved),
  ];
  return () => {
    for (const remove of removers) remove();
    removeGate();
    removeReplacementAsk();
    stopFollowing();
  };
}
