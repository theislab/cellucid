/**
 * History records for the persistence tests (the session file, the share
 * scope, the autosave), made with the model's own constructors
 * (`app/history/model.js`) and independent of the history controller:
 *
 * - `recordsHistory()`: a small live history with the controller's
 *   interface as the autosave and the serializer read it (`allTrackers()` with
 *   steps, branches, groups and turns as maps, `active`, `pool`, `snapshot()`,
 *   `shownHashes()`, `subscribe`, `reconcile`, `settlePaused`), whose edits
 *   (`step`, `chat`, `note`, `pause`, `deleteStep`, …) emit the controller's
 *   events, so a test says exactly what changed. A step changes its parent
 *   and its branch in place, as the controller does.
 * - `HEADER`: the dataset part of a session file of it.
 */
import {
  FIRST_BRANCH_ID, ROOT_STEP_ID, createBy, createNote, createStep, createTracker, createTurn,
} from '../../assets/js/app/history/model.js';
import { DOMAIN_IDS } from '../../assets/js/app/actions/domains.js';
import { hashValue } from '../../assets/js/app/history/value-pool.js';
import { validateDataMapping } from '../../assets/js/data/data-mapping.js';

const MAPPING = validateDataMapping({
  kind: 'anndata',
  embeddings: { enabled: [{ key: 'X_umap', columns: [0, 1] }], defaults: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null } },
  knn: null, geneNames: 'index', expression: 'X', log1p: {}, highlyVariable: null, latent: null, vectorFields: [],
});

export const HEADER = Object.freeze({
  createdAt: '2026-11-03T12:00:00.000Z',
  datasetFingerprint: {
    datasetId: 'demo', name: 'Demo', cellCount: 1000, varCount: 5,
    cellOrder: { embedding: { key: 'X_umap', columns: [0, 1] }, dimension: 2, digest: '0123456789abcdef' },
    dataMapping: MAPPING,
  },
  source: { kind: 'sample', dataset: 'demo' },
  requires: { obs: ['cell_type'], var: [] },
});

export const APP = Object.freeze({ version: '0.9.7', catalog: 'a'.repeat(64) });

export const T1 = 't-11111111-1111-4111-8111-111111111111';
export const T2 = 't-22222222-2222-4222-8222-222222222222';

/** Every domain's value at the start: plain data, a NaN and a -0, typed arrays. */
export function rootValues() {
  return Object.fromEntries(DOMAIN_IDS.map(domain => [domain, { domain, at: 0, nan: Number.NaN, zero: -0, cells: new Uint32Array(0) }]));
}

export const user = createBy({ origin: 'user' });
export const claude = turn => createBy({ origin: 'agent', agent: 'Claude', model: 'claude-sonnet-4-6', turn });

/**
 * A live history of the controller's shape over model records.
 *
 * @param {{trackers?: number, now?: () => number}} [options]
 */
export async function recordsHistory({ trackers: count = 1, now = (() => { let t = 1_767_225_600_000; return () => (t += 60_000); })() } = {}) {
  const pool = new Map();
  const listeners = new Set();
  const put = async value => {
    const hash = await hashValue(value);
    if (!pool.has(hash)) pool.set(hash, value);
    return hash;
  };
  const roots = {};
  for (const [domain, value] of Object.entries(rootValues())) roots[domain] = await put(value);
  /** tracker id → domain → hash shown at its head */
  const live = new Map();
  const trees = [];
  for (let n = 0; n < count; n++) {
    const id = [T1, T2][n] ?? `t-${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const record = createTracker({ id, name: `Tracker ${n + 1}`, dataset: { id: 'demo', name: 'Demo', cellOrder: null }, createdAt: now(), by: user, rootValues: roots });
    trees.push(liveTree(record));
    live.set(id, { ...roots });
  }
  let active = trees[0];

  function liveTree(record) {
    return {
      ...record,
      steps: new Map(record.steps.map(step => [step.id, step])),
      branches: new Map(record.branches.map(branch => [branch.id, branch])),
      groups: new Map(record.groups.map(group => [group.id, group])),
      turns: new Map(record.turns.map(turn => [turn.id, turn])),
      chats: new Map(record.chats),
      journal: [...record.journal],
    };
  }

  function notify(event) {
    for (const listener of [...listeners]) listener(event);
  }

  function recordOf(tree) {
    return {
      ...tree,
      steps: [...tree.steps.values()].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))),
      branches: [...tree.branches.values()],
      groups: [...tree.groups.values()],
      turns: [...tree.turns.values()],
      chats: [...tree.chats],
      journal: [...tree.journal],
    };
  }

  const history = {
    pool: { get: hash => pool.get(hash), has: hash => pool.has(hash), adopt: (hash, value) => pool.set(hash, value), hold: () => () => {} },
    get active() { return active; },
    trackers: () => trees.filter(tree => tree.removed === null),
    allTrackers: () => trees,
    destroyed: false,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot: () => ({ dataset: active.dataset, activeTracker: active.id, trackers: trees.map(recordOf) }),
    shownHashes: () => ({ ...live.get(active.id) }),
    reconcile: async () => {},
    settlePaused: async () => null,
    async idle() {},

    /** Record a step changing `changes` (domain → value) on the active branch's tip. */
    async step(changes, { type = 'color.by', params = { field: 'cell_type' }, by = user, label = 'Colored by cell_type', tree = active } = {}) {
      const shown = live.get(tree.id);
      const touches = DOMAIN_IDS.filter(domain => Object.hasOwn(changes, domain));
      const before = {};
      const after = {};
      for (const domain of touches) {
        before[domain] = shown[domain];
        after[domain] = await put(changes[domain]);
        shown[domain] = after[domain];
      }
      const id = `s${tree.nextStep}`;
      const parent = tree.steps.get(tree.headId);
      const step = createStep({
        id, parent: parent.id, branch: tree.activeBranch, type, params, v: 1, code: `${type}()`, label, by, at: now(),
        touches, before, after,
      });
      // In place, as the history controller does (`tree.js`): a record taken earlier sees it.
      parent.children.push(id);
      tree.steps.set(id, step);
      tree.nextStep += 1;
      tree.headId = id;
      tree.branches.get(tree.activeBranch).tip = id;
      if (by.turn !== null && !tree.turns.has(by.turn)) {
        tree.turns.set(by.turn, createTurn({ id: by.turn, by, label: 'Asked', startedAt: step.at, branch: tree.activeBranch }));
      }
      notify({ kind: 'step', tracker: tree.id, step: id, steps: [id, parent.id] });
      return step;
    },
    /** Keep a conversation (the chat bar's transcript shape). */
    chat(conversation, messages, { tree = active } = {}) {
      tree.chats.set(conversation, { schema: 1, id: conversation, createdAt: 1, updatedAt: 2, summary: null, messages: structuredClone(messages) });
      notify({ kind: 'chat', tracker: tree.id, conversation });
    },
    /** A note on the tracker (an edit: `edited`, no step). */
    note(text, { tree = active } = {}) {
      tree.notes = [...tree.notes, createNote({ id: `n${tree.nextNote}`, text, by: user, at: now() })];
      tree.nextNote += 1;
      notify({ kind: 'edited', tracker: tree.id, op: 'note.add', journal: null, steps: [], removed: [] });
    },
    /**
     * Pause recording with `draft` (domain → value) differing from the head,
     * as the paused draft the model keeps (`Tracker.paused`).
     */
    async pause(draft, { tree = active } = {}) {
      const hashes = {};
      for (const [domain, value] of Object.entries(draft)) hashes[domain] = await put(value);
      tree.paused = { at: now(), by: [user], draft: Object.keys(hashes).length === 0 ? null : hashes };
      notify({ kind: 'recording', tracker: tree.id, on: false });
    },
    /** Remove the head step (an edit naming what it removed and changed). */
    deleteHead({ tree = active } = {}) {
      const head = tree.steps.get(tree.headId);
      const parent = tree.steps.get(head.parent);
      tree.steps.delete(head.id);
      tree.steps.set(parent.id, { ...parent, children: parent.children.filter(id => id !== head.id) });
      tree.headId = parent.id;
      const branch = tree.branches.get(tree.activeBranch);
      tree.branches.set(branch.id, { ...branch, tip: parent.id });
      notify({ kind: 'edited', tracker: tree.id, op: 'step.delete', journal: null, steps: [parent.id], removed: [head.id] });
    },
    /** A whole load: the trackers given (records) replace these. */
    load(records) {
      trees.length = 0;
      for (const record of records) trees.push(liveTree(structuredClone(record)));
      active = trees[0];
      notify({ kind: 'loaded' });
    },
  };
  return history;
}

export { FIRST_BRANCH_ID, ROOT_STEP_ID };
