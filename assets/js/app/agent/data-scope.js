/**
 * @fileoverview What agents are sent of each dataset: the person's switch
 * "Agents see names and summaries only", kept per dataset in this browser,
 * whether they were told once what agents send (the notice), and which
 * groups and fields an agent shaped by naming cells (the shape tracker).
 *
 * Free reading is the default: an agent reads names, counts and summaries,
 * and, when it asks, values of cells and pictures of the plot; what it reads
 * goes to its provider with the conversation. With the switch on for the
 * dataset shown, no tool result carries a value of a single cell, a
 * statistic that is one cell's own value (a minimum, a maximum, a median), a
 * picture, or a summary of a group an agent shaped by naming cells: the tool
 * call (`bridge/tool-call.js`) refuses or leaves them out
 * (`bridge/data-guard.js`), for the chat bar and the connector alike, since
 * both run their calls there. It is not anonymization: a summary of a very
 * small group (a narrow range, a filter, a rare category) can still reveal
 * its cells' values, and the docs say so.
 *
 * The switch is the person's, never an action: no agent can turn it off.
 * It is kept by the dataset's identity (the id saved states and My datasets
 * key on, the history's `dataset.id`) in `localStorage`
 * (`cellucid:agent-data`), so it holds for that dataset whenever it is shown
 * in this browser, in every tab (each write merges into what is stored, and
 * a tab hears another's change, `storage`); a dataset with no identity
 * (nothing names it) keeps it for this page only, as does a browser that
 * keeps no site data.
 *
 * **Shaped by an agent** (`createShapeTracker`): a highlight group an agent
 * made by naming cells (`highlight.cells` of `origin: 'agent'`), a column an
 * agent pushed (`field.push`, `field.consensus`), and what is made from them
 * (a field made from pages holding such a group, a page combined from one,
 * a copy or a rename of such a field, a group made from such a field's
 * categories or range). Groups are known by their ids (kept through undo,
 * redo and renames, never reused), fields by every name they had. It is
 * followed from the dispatcher's events for this page; a saved state loaded
 * later starts unknown.
 *
 * @module app/agent/data-scope
 */

import { getCurrentHistory, subscribeCurrentHistory } from '../history/current.js';
import { webStorage } from '../../utils/web-storage.js';
import { createListenerSet } from '../../utils/listener-set.js';

export const AGENT_DATA_STORAGE_KEY = 'cellucid:agent-data';

/** The switch as the person sees it. */
export const SUMMARIES_ONLY_LABEL = 'Agents see names and summaries only';

/** Where the person finds the switch again (the notice and the refusals say it). */
export const SUMMARIES_ONLY_PLACE = 'Permissions… in the chat settings or Agents panel';

/** What the switch keeps out, and what it does not do, in two sentences (the notice, the settings, the docs). */
export const SUMMARIES_ONLY_CAVEAT = 'It keeps values of single cells, extremes (a minimum, a maximum, a median) and pictures out of what agents are sent. '
  + 'It is not anonymization: a summary of a very small group can still reveal its cells\' values.';

/** The key a dataset with no identity is kept under, for this page only. */
const UNNAMED = '\u0000page';

function emptyRecord() {
  return { summariesOnly: false, noticed: false };
}

function readStored(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(AGENT_DATA_STORAGE_KEY) ?? 'null');
    const datasets = parsed?.datasets;
    if (datasets === null || typeof datasets !== 'object' || Array.isArray(datasets)) return new Map();
    const out = new Map();
    for (const [id, value] of Object.entries(datasets)) {
      if (value === null || typeof value !== 'object') continue;
      const record = { summariesOnly: value.summariesOnly === true, noticed: value.noticed === true };
      if (record.summariesOnly || record.noticed) out.set(id, record);
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * The per-dataset records kept in this browser.
 *
 * @param {{storage?: Storage|null, win?: {addEventListener?: Function, removeEventListener?: Function}|null}} [options] -
 *   left out: `localStorage`, and this window's `storage` events (another tab's change)
 */
export function createAgentDataStore({ storage, win = storage === undefined ? globalThis.window ?? null : null } = {}) {
  const store = () => (storage === undefined ? webStorage('localStorage') : storage);
  /** What this page knows: the stored records, and those kept for this page only (none stored). */
  let records = readStored(store());
  const pageOnly = new Map();
  const listeners = createListenerSet('what agents are sent of a dataset');
  const keyOf = id => (typeof id === 'string' && id !== '' ? id : UNNAMED);

  function notify() {
    listeners.notify();
  }

  function recordOf(key) {
    return pageOnly.get(key) ?? records.get(key) ?? emptyRecord();
  }

  /** Write one dataset's record into what is stored now (another tab may have written others since). */
  function persist(key, record) {
    const storage = store();
    let written = false;
    if (key !== UNNAMED && storage !== null) {
      try {
        const now = readStored(storage);
        if (record.summariesOnly || record.noticed) now.set(key, record);
        else now.delete(key);
        storage.setItem(AGENT_DATA_STORAGE_KEY, JSON.stringify({ datasets: Object.fromEntries(now) }));
        records = now;
        pageOnly.delete(key);
        written = true;
      } catch {
        // A browser that keeps no site data: kept for this page below.
      }
    }
    if (!written) pageOnly.set(key, record);
  }

  function update(id, change) {
    const key = keyOf(id);
    const before = recordOf(key);
    const next = { ...before, ...change };
    if (next.summariesOnly === before.summariesOnly && next.noticed === before.noticed) return before;
    persist(key, next);
    notify();
    return next;
  }

  // Another tab changed the records: what this page shows and enforces follows.
  const onStorage = event => {
    if (event.key !== null && event.key !== AGENT_DATA_STORAGE_KEY) return;
    records = readStored(store());
    notify();
  };
  win?.addEventListener?.('storage', onStorage);

  return Object.freeze({
    /** `{summariesOnly, noticed}` of the dataset `id` (null: one with no identity, this page's). */
    get: id => ({ ...recordOf(keyOf(id)) }),
    /** Switch "names and summaries only" on or off for the dataset `id`. */
    setSummariesOnly: (id, on) => update(id, { summariesOnly: on === true }),
    /** The person was told what agents send of the dataset `id`. */
    markNoticed: id => update(id, { noticed: true }),
    /** Whether the dataset `id` is kept for this page only (it has no identity). */
    pageOnly: id => keyOf(id) === UNNAMED,
    subscribe(listener) {
      return listeners.add(listener);
    },
    destroy() {
      win?.removeEventListener?.('storage', onStorage);
      listeners.clear();
    },
  });
}

let pageStore = null;

/** This page's store (`localStorage`), made on first use. */
export function agentDataStore() {
  pageStore ??= createAgentDataStore();
  return pageStore;
}

// --------------------------------------------------------------- Shaped

/** Nothing shaped (no tracker: a test in Node, a page starting). */
const NOTHING_SHAPED = Object.freeze({ page: () => false, field: () => false });

/**
 * Field actions whose field (the outcome's `name`; a rename's `name`) holds the
 * cells of the field they name: another name of it, a copy, a grouping, an edit.
 */
const FIELD_FROM_FIELD = new Set(['field.rename', 'field.revert-name', 'field.duplicate', 'field.group', 'category.merge', 'category.delete']);

/** Highlight actions that make a group from a field (its categories, its range). */
const FROM_FIELD = new Set(['highlight.category', 'highlight.range']);

/**
 * Which groups and fields an agent shaped by naming cells, followed from the
 * dispatcher's events (module overview).
 *
 * @param {{
 *   actions: {subscribe: (listener: (event: object) => void) => () => void},
 *   state: {getHighlightPages?: () => object[]}|null,
 *   history?: () => object|null,
 * }} options
 */
export function createShapeTracker({ actions, state, history = getCurrentHistory }) {
  /** dataset key → {groups: Set<group id>, fields: Set<field key>} */
  const byDataset = new Map();

  function marks() {
    const key = history()?.dataset?.id ?? UNNAMED;
    let entry = byDataset.get(key);
    if (entry === undefined) {
      entry = { groups: new Set(), fields: new Set() };
      byDataset.set(key, entry);
    }
    return entry;
  }

  function pageNamed(name) {
    return (state?.getHighlightPages?.() ?? []).find(page => page.name === name) ?? null;
  }

  function pageShaped(name) {
    const page = pageNamed(name);
    const { groups } = marks();
    return page !== null && (page.highlightedGroups ?? []).some(group => groups.has(group.id));
  }

  function fieldShaped(key) {
    return typeof key === 'string' && marks().fields.has(key);
  }

  function markGroup(pageName, label) {
    const group = (pageNamed(pageName)?.highlightedGroups ?? []).find(each => each.label === label);
    if (group !== undefined) marks().groups.add(group.id);
  }

  function markPage(pageName) {
    for (const group of pageNamed(pageName)?.highlightedGroups ?? []) marks().groups.add(group.id);
  }

  const off = actions.subscribe(event => {
    if (event.kind !== 'done' || event.meta?.internal) return;
    const { type, params = {}, outcome = null } = event;
    const byAgent = event.meta?.origin === 'agent';
    try {
      if (type === 'highlight.cells' && byAgent && outcome !== null) markGroup(outcome.page, outcome.group);
      else if ((type === 'field.push' || type === 'field.consensus') && byAgent) marks().fields.add(params.key);
      else if (FROM_FIELD.has(type) && fieldShaped(params.field?.key) && outcome !== null) {
        // A range makes one group; categories, one group each.
        for (const label of type === 'highlight.category' ? outcome.groups : [outcome.group]) markGroup(outcome.page, label);
      }
      else if (type === 'highlight.page.combine' && outcome !== null && (params.pages ?? []).some(pageShaped)) markPage(outcome.page);
      else if (type === 'field.create-from-pages' && (params.pages ?? []).some(entry => pageShaped(entry.page))) marks().fields.add(params.key);
      else if (FIELD_FROM_FIELD.has(type) && fieldShaped(params.field?.key)) {
        // Every name it had stays marked: an undo of a rename brings the old name back. A column
        // made from it (a copy, a grouping, a file's column edited into a new one) is shaped too.
        const name = type === 'field.rename' ? params.name : outcome?.name;
        if (typeof name === 'string') marks().fields.add(name);
      }
    } catch (error) {
      console.error('[agents] following what an agent shaped failed', error);
    }
  });

  return Object.freeze({
    /** Whether the page `name` holds a group an agent shaped. */
    page: pageShaped,
    /** Whether the field `key` was shaped by an agent. */
    field: fieldShaped,
    destroy: off,
  });
}

let pageShapes = null;

/** The page's shape tracker (`initAgents`), or null to stop following. */
export function setShapeTracker(tracker) {
  pageShapes = tracker;
}

/**
 * What agents may be sent now: the dataset shown (its identity and name,
 * null while none is), whether it is set to names and summaries only, and
 * what an agent shaped there (`shaped.page(name)`, `shaped.field(key)`).
 *
 * @param {{store?: ReturnType<typeof createAgentDataStore>|null, history?: () => object|null,
 *   shapes?: {page: Function, field: Function}|null}} [options] - `store` left out: this page's
 *   (`agentDataStore`); `shapes` left out: this page's tracker
 * @returns {{dataset: {id: string|null, name: string|null}|null, summariesOnly: boolean,
 *   shaped: {page: (name: string) => boolean, field: (key: string) => boolean}}}
 */
export function dataScopeNow({ store = null, history = getCurrentHistory, shapes = null } = {}) {
  const shown = history()?.dataset ?? null;
  const shaped = shapes ?? pageShapes ?? NOTHING_SHAPED;
  // No dataset shown: nothing to send, and no store to open (a page starting, a test in Node).
  if (shown === null) return { dataset: null, summariesOnly: false, shaped };
  const dataset = { id: shown.id ?? null, name: shown.name ?? null };
  return { dataset, summariesOnly: (store ?? agentDataStore()).get(dataset.id).summariesOnly, shaped };
}

/**
 * Hear when what agents may be sent changes: the switch (here or in another
 * tab), or another dataset shown. Returns the unsubscribe.
 *
 * @param {() => void} listener
 * @param {{store?: ReturnType<typeof createAgentDataStore>, subscribeHistory?: (listener: () => void) => () => void}} [options]
 */
export function subscribeDataScope(listener, { store = agentDataStore(), subscribeHistory = subscribeCurrentHistory } = {}) {
  const offStore = store.subscribe(listener);
  const offHistory = subscribeHistory(listener);
  return () => {
    offStore();
    offHistory();
  };
}
