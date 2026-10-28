/**
 * Publish what a person makes in the viewer to the host program (Python, R)
 * as viewer-protocol results (`data/viewer-protocol.js`), so a notebook pulls
 * it into its object in one call:
 *
 * - every highlight group of every page (`highlight`);
 * - every user-defined obs field: categoricals -- labels, annotations,
 *   clusters, merged categories, community consensus -- (`categorical`) and
 *   continuous fields, copied or pushed (`continuous`);
 * - the scores and gene sets the shown analyses hold, and the gene sets a
 *   notebook pushed (`registries/derived-results.js`);
 * - the cells the filters leave visible (`visibility`), and the cells open
 *   (`subset`, the dataset's cell identity).
 *
 * Results go out as they change: every change of state schedules one pass
 * that sends each result whose content changed since it was last sent and a
 * removal for each that is gone, each with the next revision. A pass first
 * waits for the burst of changes to end (a filter drag, a restore), so one
 * gesture is one message per result.
 *
 * `resync` is the snapshot: every field a session restore left unloaded is
 * read first, then every result is sent and the `results` inventory ends it.
 * It runs after the dataset opened and whenever the channel opens again. A
 * host thus always holds every result as of the last event it read, and
 * answers from that without asking: a notebook widget hears the viewer only
 * between cells, where nothing can wait for an answer. A field a session
 * restore leaves unloaded later is read in the background, then sent.
 *
 * Every event carries this page's epoch for the dataset it shows: drawn at
 * random when the page starts and again whenever a dataset opens
 * (`datasetOpened`), with revisions counted from 1 in each. A host keeps one
 * epoch's results, so a reloaded page, or the viewer shown again in another
 * notebook output, replaces what the host kept instead of being outranked by
 * the older page's higher revisions. The inventory names the host's dataset
 * the epoch describes; while the person has another dataset open in the
 * viewer it names none, lists nothing, and no result is sent: the host's
 * cell positions describe its own dataset.
 *
 * Cells inside the app are subset positions; the results carry original
 * positions (`CellIdentity.originalValues`), and a field's values cover the open
 * cells (`cells` the open cells' original positions, or every cell when all
 * are open).
 *
 * @module app/viewer-host-results
 */

import { FieldKind, FieldSource } from './utils/field-constants.js';
import { geneIdentities } from './analysis/shared/gene-sets.js';

/** How long a burst of changes may go quiet before its results are sent. */
const SETTLE_MS = 120;

/** The `_operation.type` of a field a notebook pushed (`setField`). */
export const NOTEBOOK_PUSH_OPERATION = 'notebook-push';

function sameFingerprint(a, b) {
  if (a === null || b === null || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (!Object.is(a[index], b[index])) return false;
  }
  return true;
}

/** Text as the protocol carries it: trimmed, no control characters, never empty. */
function cleanText(value, otherwise) {
  // eslint-disable-next-line no-control-regex
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text.length > 0 ? text : otherwise;
}

function itemKey(kind, id) {
  return `${kind}\u0000${id}`;
}

/** The cells (subset positions) whose visibility byte is 1, and a digest of them; null when every cell is. */
function visibleCells(transparency) {
  const n = transparency.length;
  let visible = 0;
  for (let index = 0; index < n; index++) visible += transparency[index];
  if (visible === n) return { cells: null, digest: n };
  const cells = new Uint32Array(visible);
  let at = 0;
  let hash = 0x811c9dc5;
  for (let index = 0; index < n; index++) {
    if (transparency[index] === 1) {
      cells[at++] = index;
      hash = Math.imul(hash ^ index, 0x01000193) >>> 0;
    }
  }
  return { cells, digest: `${visible}:${hash}` };
}

/** A new epoch: 64 random bits as 16 lowercase hexadecimal characters. */
function drawEpoch() {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return Array.from(words, word => word.toString(16).padStart(8, '0')).join('');
}

/**
 * @param {{
 *   state: Object,
 *   viewerHostSource: Object,
 *   getCellIdentity: () => import('../data/cell-identity.js').CellIdentity,
 * }} options
 *   The host's dataset the viewer shows comes from
 *   `viewerHostSource.getShownHostDataset()`.
 */
export function createViewerHostResults({ state, viewerHostSource, getCellIdentity }) {
  if (typeof getCellIdentity !== 'function') {
    throw new TypeError('Viewer host results need the open dataset\'s cell identity');
  }
  let epoch = drawEpoch();
  let revision = 0;
  /** @type {Map<string, {kind: string, id: string, revision: number, fingerprint: unknown[]}>} */
  const sent = new Map();
  let timer = null;
  let visibilityDirty = true;
  let visibility = { cells: null, digest: 0 };
  let colorBy = null;
  let started = false;
  /** Whether the last pass met a user-defined field not read yet, and whether it is being read. */
  let unloaded = false;
  let loading = null;

  const accepts = type => viewerHostSource.acceptsEvent(type);

  function fieldOrigin(field) {
    return field._operation?.type === NOTEBOOK_PUSH_OPERATION ? 'notebook' : 'user';
  }

  /**
   * Every result now, in subset positions: highlights, user-defined fields,
   * derived scores and gene sets, visibility, the open cells.
   */
  function collect() {
    unloaded = false;
    const identity = getCellIdentity();
    const items = [];
    items.push({
      kind: 'subset',
      id: 'open',
      meta: { digest: identity.digest },
      cells: null,
      values: null,
      fingerprint: [identity.digest],
    });
    for (const page of state.getHighlightPages()) {
      const color = state.getHighlightPageColor(page.id);
      for (const group of page.highlightedGroups) {
        const meta = {
          label: cleanText(group.label, group.id),
          tool: group.type,
          pageId: page.id,
          pageName: cleanText(page.name, page.id),
          color,
          enabled: group.enabled === true,
        };
        items.push({
          kind: 'highlight',
          id: group.id,
          meta,
          cells: group.cellIndices,
          values: null,
          fingerprint: [group.cellIndices, JSON.stringify(meta)],
        });
      }
    }
    for (const field of state.getFields() ?? []) {
      if (field?._isUserDefined !== true || field._isDeleted === true || field._fieldSource !== FieldSource.OBS) continue;
      if (field.loaded !== true) {
        unloaded = true;
        continue;
      }
      if (field.kind === FieldKind.CATEGORY) {
        const meta = {
          key: cleanText(field.key, field._userDefinedId),
          categories: field.categories.map(category => String(category)),
          origin: fieldOrigin(field),
        };
        items.push({
          kind: 'categorical',
          id: field._userDefinedId,
          meta,
          cells: null,
          values: field.codes,
          fingerprint: [field.codes, JSON.stringify(meta)],
        });
      } else if (field.kind === FieldKind.CONTINUOUS && ArrayBuffer.isView(field.values)) {
        const meta = { key: cleanText(field.key, field._userDefinedId), origin: fieldOrigin(field) };
        items.push({
          kind: 'continuous',
          id: field._userDefinedId,
          meta,
          cells: null,
          values: field.values,
          fingerprint: [field.values, JSON.stringify(meta)],
        });
      }
    }
    const derived = state.getDerivedResults();
    const genes = geneIdentities(state.varData);
    for (const score of derived.getScores()) {
      const meta = { key: score.key, origin: score.origin };
      items.push({
        kind: 'continuous',
        id: score.id,
        meta,
        cells: score.cells,
        values: score.values,
        fingerprint: [score.cells, score.values, JSON.stringify(meta)],
      });
    }
    for (const entry of derived.getGeneSets()) {
      const meta = {
        name: entry.set.name,
        description: entry.set.description,
        // By identifier (the var index), as every gene crossing a boundary,
        // with the name the viewer shows for each.
        genes: entry.set.genes.map(gene => genes.idOf(gene)),
        symbols: [...entry.set.genes],
        origin: entry.origin,
      };
      items.push({
        kind: 'geneSet',
        id: entry.id,
        meta,
        cells: new Uint32Array(0),
        values: null,
        fingerprint: [JSON.stringify(meta)],
      });
    }
    if (visibilityDirty) {
      visibility = visibleCells(state.categoryTransparency);
      visibilityDirty = false;
    }
    items.push({
      kind: 'visibility',
      id: 'visible',
      meta: {},
      cells: visibility.cells,
      values: null,
      fingerprint: [visibility.digest],
    });
    return { identity, items };
  }

  /** The result of one item, its cells named by original position. */
  function resultOf(item, identity, requestId, itemRevision) {
    let values = item.values;
    if (values !== null && item.kind === 'continuous' && !(values instanceof Float32Array) && !(values instanceof Float64Array)) {
      values = Float32Array.from(values);
    }
    // Named by original position, ascending, values with their cells:
    // `cells` null is every open cell (values in open order).
    let cells;
    ({ cells, values } = identity.originalValues(item.kind === 'subset' ? null : item.cells, values));
    if (cells !== null && !(cells instanceof Uint32Array)) cells = Uint32Array.from(cells);
    return {
      requestId,
      epoch,
      revision: itemRevision,
      kind: item.kind,
      id: item.id,
      nObs: identity.nOriginal,
      meta: item.meta,
      cells,
      values,
    };
  }

  function reportColorBy(force) {
    const active = state.getActiveField();
    const next = active === null || active === undefined
      ? { field: null, source: null, label: null }
      : {
          // A gene by its identifier (the var index), as every gene crossing
          // a boundary, and by the name the viewer shows.
          field: state.activeFieldSource === 'var' ? geneIdentities(state.varData).idOf(active.key) : active.key,
          source: state.activeFieldSource,
          label: active.key,
        };
    if (
      !force && colorBy !== null && colorBy.field === next.field && colorBy.source === next.source
      && colorBy.label === next.label
    ) return;
    colorBy = next;
    if (accepts('color_by')) viewerHostSource.notifyColorBy(next);
  }

  /** Send every result that changed since it was last sent, and every removal. */
  function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!started || !viewerHostSource.isConnected()) return null;
    // Another dataset is open: nothing of it describes the host's cells.
    if (viewerHostSource.getShownHostDataset() === null) return null;
    reportColorBy(false);
    if (!accepts('result')) return null;
    const collected = collect();
    if (unloaded && loading === null) {
      // Restored, not read yet: read in the background, then sent.
      loading = loadUserDefinedFields()
        .catch(error => console.error('[ViewerHostResults] Reading a restored field failed:', error))
        .finally(() => {
          loading = null;
          schedule();
        });
    }
    const present = new Set();
    for (const item of collected.items) {
      const key = itemKey(item.kind, item.id);
      present.add(key);
      const previous = sent.get(key);
      if (previous !== undefined && sameFingerprint(previous.fingerprint, item.fingerprint)) continue;
      // One result the protocol refuses (a label it cannot carry) is
      // reported and left out; every other result still reaches the host.
      try {
        const result = resultOf(item, collected.identity, null, revision + 1);
        viewerHostSource.notifyResult(result);
      } catch (error) {
        console.error(`[ViewerHostResults] The ${item.kind} result "${item.id}" could not be sent:`, error);
        present.delete(key);
        continue;
      }
      revision += 1;
      sent.set(key, { kind: item.kind, id: item.id, revision, fingerprint: item.fingerprint });
    }
    for (const [key, entry] of [...sent]) {
      if (present.has(key)) continue;
      revision += 1;
      sent.delete(key);
      if (accepts('result_removed')) {
        viewerHostSource.notifyResultRemoved({ epoch, revision, kind: entry.kind, id: entry.id });
      }
    }
    return collected;
  }

  function schedule() {
    if (!started) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        flush();
      } catch (error) {
        console.error('[ViewerHostResults] Sending results to the host failed:', error);
      }
    }, SETTLE_MS);
  }

  function inventory(identity, dataset) {
    return {
      epoch,
      dataset,
      revision,
      nObs: identity.nOriginal,
      items: [...sent.values()].map(entry => ({ kind: entry.kind, id: entry.id, revision: entry.revision })),
    };
  }

  /** Read every user-defined obs field a session restore left unloaded. */
  async function loadUserDefinedFields() {
    const fields = state.getFields() ?? [];
    for (let index = 0; index < fields.length; index++) {
      const field = fields[index];
      if (field?._isUserDefined === true && field._isDeleted !== true && field.loaded !== true) {
        await state.ensureFieldLoaded(index, { silent: true });
      }
    }
  }

  const unsubscribers = [
    state.on('highlight:changed', schedule),
    state.on('page:changed', schedule),
    state.on('field:changed', schedule),
    state.on('visibility:changed', () => {
      visibilityDirty = true;
      schedule();
    }),
    state.getDerivedResults().onChange(schedule),
  ];

  const api = Object.freeze({
    /**
     * The snapshot: every result again, then the inventory. The dataset
     * opened (or was opened again), or the channel opened again; the host's
     * copy is replaced whole.
     */
    async resync() {
      started = true;
      const dataset = viewerHostSource.getShownHostDataset();
      if (dataset === null) {
        // Another dataset: the host learns it, and holds nothing of it.
        sent.clear();
        if (viewerHostSource.isConnected() && accepts('results')) {
          viewerHostSource.notifyResults(inventory(getCellIdentity(), null));
        }
        return;
      }
      await loadUserDefinedFields();
      sent.clear();
      visibilityDirty = true;
      colorBy = null;
      const collected = flush();
      if (collected !== null && accepts('results')) {
        viewerHostSource.notifyResults(inventory(collected.identity, dataset));
      }
    },

    /**
     * A dataset opened in this page (the host's, or another the person
     * chose): a new epoch, whose snapshot follows once the results were
     * sent once (`resync`), at once.
     *
     * @returns {Promise<void>}
     */
    async datasetOpened() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      epoch = drawEpoch();
      revision = 0;
      sent.clear();
      if (started) await api.resync();
    },

    /**
     * Answer a `setField` or `setGeneSet`: the result it made, with its
     * request id.
     *
     * @param {string} requestId
     * @param {string} kind
     * @param {string} id
     */
    answer(requestId, kind, id) {
      started = true;
      if (viewerHostSource.getShownHostDataset() === null) {
        throw new Error('The viewer shows another dataset than the one the host opened.');
      }
      const collected = flush();
      if (collected === null) {
        throw new Error('The host does not accept results; upgrade its cellucid package.');
      }
      const item = collected.items.find(candidate => candidate.kind === kind && candidate.id === id);
      if (item === undefined) throw new Error(`The viewer holds no ${kind} result "${id}"`);
      const entry = sent.get(itemKey(kind, id));
      if (entry === undefined) throw new Error(`The ${kind} result "${id}" could not be sent`);
      viewerHostSource.notifyResult(resultOf(item, collected.identity, requestId, entry.revision));
    },

    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  });
  return api;
}
