/**
 * History v2 §6 test 1 (the shared body; `history-tree-properties-*.test.mjs` run its seeds in shards): seeded random sequences of every operation on the
 * history (actions, undo, redo, jumps, branch here, switch, rename, archive,
 * main, lock, delete a step, delete a branch in both modes, squash, groups,
 * notes, bookmarks, the journal's undo and emptying, trackers started, used
 * and removed, pausing and resuming, save and load), on fake domains whose
 * actions declare what they read. After every operation the history's
 * invariants hold:
 * - the model's validators accept it whole (one root, parents and children
 *   agree, each branch one line from its fork step to its tip, `step.branch`
 *   consistent, unique names, the head on the active branch's path, …);
 * - the head's values kept by the history equal the plain reading from the
 *   root, and what is shown equals them (while recording);
 * - every value a tracker refers to is in the pool, and after emptying
 *   Recently deleted no value is left that nothing refers to;
 * - undoing a journaled edit from Recently deleted gives back exactly what
 *   was there before it;
 * - a snapshot loaded into a fresh page is the same history;
 * - after deleting a step, the values at the head equal the actions applied
 *   again from the root (the dependent re-apply is exact).
 *
 * The PRNG is a small seeded one; no new dependency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { validateHistory } from '../assets/js/app/history/model.js';
import { pathTo, referencedHashes, valuesAt } from '../assets/js/app/history/tree.js';

/** mulberry32: a seeded PRNG in [0, 1). */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = { filters: 'a', colors: 'b', analysis: 'c', camera: 'cam' };

/**
 * Four domains: `a` (set), `b` (incremented: a relative change), `c` (derived
 * from a and b: it reads them), and a camera.
 */
function fakePage() {
  const state = { a: 0, b: 0, c: 0, cam: 0 };
  const domains = createDomainRegistry();
  for (const [id, key] of Object.entries(KEYS)) {
    domains.provide(id, {
      capture: () => state[key],
      restore: value => { state[key] = value; },
      describe: (x, y) => [`${x} → ${y}`],
    });
  }
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  return { state, domains };
}

const number = { type: 'object', additionalProperties: false, required: ['v'], properties: { v: { type: 'integer' } } };
const none = { type: 'object', additionalProperties: false, properties: {} };
const definitions = [
  defineAction({ type: 'a.set', title: 'Set a', summary: 'Set a.', group: 'T', params: number, touches: ['filters'], reads: [], effect: 'state', describe: p => `a = ${p.v}`, code: p => `a(${p.v})` }),
  defineAction({ type: 'b.inc', title: 'Increment b', summary: 'b + 1.', group: 'T', params: none, touches: ['colors'], reads: [], effect: 'view', describe: () => 'b + 1', code: () => 'inc_b()' }),
  defineAction({ type: 'c.derive', title: 'Derive c', summary: 'c from a and b.', group: 'T', params: none, touches: ['analysis'], reads: ['filters', 'colors'], effect: 'state', describe: () => 'c = 10a + b', code: () => 'derive()' }),
  defineAction({ type: 'cam.set', title: 'Camera', summary: 'Camera.', group: 'T', params: number, touches: ['camera'], reads: [], effect: 'view', coalesce: () => 'cam', describe: p => `cam ${p.v}`, code: p => `cam(${p.v})` }),
];

/** What the fake actions do, applied to a state: the "full re-apply" a delete's dependent re-apply must equal. */
function apply(state, step) {
  switch (step.type) {
    case 'a.set': return { ...state, a: step.params.v };
    case 'b.inc': return { ...state, b: state.b + 1 };
    case 'c.derive': return { ...state, c: state.a * 10 + state.b };
    case 'cam.set': return { ...state, cam: step.params.v };
    default: return null;
  }
}

function trackerId(n) {
  return `t-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

async function makePage() {
  const page = fakePage();
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([...definitions, ...historyActions]) });
  dispatcher.provide('a.set', ({ v }) => { page.state.a = v; });
  dispatcher.provide('b.inc', () => { page.state.b += 1; });
  dispatcher.provide('c.derive', () => { page.state.c = page.state.a * 10 + page.state.b; });
  dispatcher.provide('cam.set', ({ v }) => { page.state.cam = v; });
  let n = 0;
  let t = 0;
  const history = createHistory({
    dispatcher, domains: page.domains, dataset: { id: 'd1', name: 'Demo', cellOrder: null },
    newTrackerId: () => trackerId(++n), now: () => ++t * 1000,
  });
  await history.startTracker();
  return { page, dispatcher, history };
}

function pick(random, list) {
  return list[Math.floor(random() * list.length)];
}

function comparable(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

/** The snapshot without what a restore itself changes: the journal, and the id counters (ids are never reused). */
function withoutJournal(snapshot) {
  const copy = comparable(snapshot);
  for (const tracker of copy.trackers) {
    for (const key of ['journal', 'nextJournal', 'nextStep', 'nextBranch', 'nextGroup', 'nextNote']) delete tracker[key];
  }
  return copy;
}

async function checkInvariants({ page, history }, label) {
  const snapshot = history.snapshot();
  try {
    validateHistory(snapshot);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
  const tracker = history.active;
  const head = valuesAt(tracker, tracker.headId);
  assert.deepEqual(history.headHashes(), head, `${label}: the head's values kept equal the plain reading`);
  for (const each of history.allTrackers()) {
    for (const hash of referencedHashes(each)) assert.ok(history.pool.has(hash), `${label}: the pool holds ${hash.slice(0, 8)}`);
    // Every step's before-values are its parent's values (what every move relies on): one walk, values carried down.
    const stack = [[each.rootId, {}]];
    while (stack.length > 0) {
      const [id, parentValues] = stack.pop();
      const step = each.steps.get(id);
      for (const [domain, hash] of Object.entries(step.before)) assert.equal(hash, parentValues[domain], `${label}: ${each.id} ${id}.before.${domain} is its parent's value`);
      const values = { ...parentValues, ...step.after };
      for (const child of step.children) stack.push([child, values]);
    }
  }
  // §3.5: the pool holds no value nothing refers to (a merged gesture, an action that changed nothing or a
  // paused change keeps none).
  const referenced = new Set([...Object.values(history.shownHashes()), ...Object.values(history.headHashes())]);
  for (const each of history.allTrackers()) referencedHashes(each, referenced);
  const loose = history.pool.hashes().filter(hash => !referenced.has(hash));
  assert.deepEqual(loose, [], `${label}: the pool keeps only values something refers to`);
  if (tracker.paused === null) {
    for (const [domain, key] of Object.entries(KEYS)) {
      assert.equal(history.pool.get(head[domain]), page.state[key], `${label}: ${domain} shows the head's value`);
    }
  }
}

/** The values at the head computed by applying every action again from the root, or null when a step is not an action. */
function fullReapply(history) {
  const tracker = history.active;
  const [root, ...rest] = pathTo(tracker, tracker.headId);
  let state = Object.fromEntries(Object.entries(KEYS).map(([domain, key]) => [key, history.pool.get(root.after[domain])]));
  for (const step of rest) {
    if (step.kind !== 'action' || step.status !== 'applied') return null;
    state = apply(state, step);
    if (state === null) return null;
  }
  return state;
}

async function act(ctx, type, params = {}) {
  try {
    return (await ctx.dispatcher.dispatch(type, params)).outcome;
  } catch (error) {
    if (error?.name === 'ActionRefused') return null;
    throw error;
  }
}

const JOURNALED = new Set([
  'history.branch.rename', 'history.branch.archive', 'history.branch.lock', 'history.branch.set-main', 'history.step.delete',
  'history.branch.delete', 'history.squash', 'history.group.create', 'history.group.remove', 'history.note.add',
  'history.bookmark.set', 'history.clear', 'history.turn.undo',
]);

async function randomOperation(ctx, random, log) {
  const { history } = ctx;
  const tracker = history.active;
  const steps = [...tracker.steps.keys()];
  const nonRoot = steps.filter(id => id !== tracker.rootId);
  const branches = [...tracker.branches.values()];
  const roll = random();
  if (roll < 0.03) {
    // Load this history's own snapshot beside its trackers (ids re-issued, names "(shared)").
    log.push('load beside');
    const saved = history.snapshot();
    const values = new Map(history.pool.hashes().map(hash => [hash, history.pool.get(hash)]));
    await history.importTrackers(saved, { file: 'beside.cellucid', values });
    return null;
  }
  if (roll < 0.06) {
    // Two writers at once: an action and a history operation started together, neither awaited first.
    const [type, params] = pick(random, [
      ['history.undo', {}], ['history.squash', { from: pick(random, steps), to: pick(random, steps) }],
      ['history.note.add', { target: { step: pick(random, steps) }, text: 'At once.' }],
      ['history.step.delete', { step: pick(random, steps) }], ['history.branch.rename', { branch: pick(random, branches).id, name: `Name ${Math.floor(random() * 6)}` }],
    ]);
    log.push(`concurrently b.inc and ${type} ${JSON.stringify(params)}`);
    const results = await Promise.allSettled([ctx.dispatcher.dispatch('b.inc', {}), ctx.dispatcher.dispatch(type, params)]);
    for (const result of results) if (result.status === 'rejected' && result.reason?.name !== 'ActionRefused') throw result.reason;
    return null;
  }
  if (roll < 0.09) {
    // An agent's turn with the person's steps between its own (A, P1, B, P2).
    const turn = `turn-${Math.floor(random() * 2)}`;
    log.push(`interleaved (${turn})`);
    for (const [kind, meta] of [['a.set', { origin: 'agent', agent: 'Claude', turn }], ['c.derive', {}], ['b.inc', { origin: 'agent', agent: 'Claude', turn }], ['c.derive', {}]]) {
      try {
        await ctx.dispatcher.dispatch(kind, kind === 'a.set' ? { v: Math.floor(random() * 5) } : {}, meta);
      } catch (error) {
        if (error?.name !== 'ActionRefused') throw error;
      }
    }
    return null;
  }
  if (roll < 0.40) {
    const kind = pick(random, ['a.set', 'b.inc', 'c.derive', 'cam.set']);
    const params = kind === 'a.set' || kind === 'cam.set' ? { v: Math.floor(random() * 5) } : {};
    // Some changes are an agent's, in one of two turns.
    const meta = random() < 0.25 ? { origin: 'agent', agent: 'Claude', turn: `turn-${Math.floor(random() * 2)}` } : {};
    log.push(`${kind} ${JSON.stringify(params)}${meta.turn ? ` (${meta.turn})` : ''}`);
    try {
      await ctx.dispatcher.dispatch(kind, params, meta);
    } catch (error) {
      if (error?.name !== 'ActionRefused') throw error;
    }
    return null;
  }
  const ops = [
    ['history.undo', {}], ['history.redo', {}], ['history.jump', { step: pick(random, steps) }],
    ['history.branch.create', { step: pick(random, steps) }],
    ['history.branch.switch', { branch: pick(random, branches).id }],
    ['history.branch.rename', { branch: pick(random, branches).id, name: `Name ${Math.floor(random() * 6)}` }],
    ['history.branch.archive', { branch: pick(random, branches).id, archived: random() < 0.5 }],
    ['history.branch.lock', { branch: pick(random, branches).id, locked: random() < 0.5 }],
    ['history.branch.set-main', { branch: pick(random, branches).id }],
    ['history.branch.delete', { branch: pick(random, branches).id, with_sub_branches: random() < 0.3 }],
    ['history.note.add', { target: { step: pick(random, steps) }, text: 'A note.' }],
    ['history.bookmark.set', { step: pick(random, steps), name: random() < 0.3 ? null : `Mark ${Math.floor(random() * 4)}` }],
    ['history.journal.empty', {}],
    random() < 0.6 ? ['history.recording.resume', {}] : ['history.recording.pause', {}],
    ['history.tracker.start', { start: random() < 0.5 ? 'opened' : 'shown' }],
    ['history.clear', { keep_state: random() < 0.7 }],
    ['history.turn.undo', { turn: `turn-${Math.floor(random() * 2)}`, only_own: random() < 0.5 }],
  ];
  if (nonRoot.length > 0) {
    ops.push(['history.step.delete', { step: pick(random, nonRoot) }]);
    const from = pick(random, nonRoot);
    const run = pathTo(tracker, branches.find(b => b.id === tracker.steps.get(from).branch).tip).map(step => step.id);
    const to = run[Math.min(run.length - 1, run.indexOf(from) + Math.floor(random() * 3))];
    ops.push(['history.squash', { from, to }]);
    ops.push(['history.group.create', { from, to, name: `G ${Math.floor(random() * 3)}` }]);
    ops.push(['history.step.revert', { step: pick(random, nonRoot) }]);
    ops.push(['history.branch.without', { step: pick(random, nonRoot) }]);
  }
  if (tracker.groups.size > 0) {
    ops.push(['history.group.remove', { group: pick(random, [...tracker.groups.keys()]) }]);
    ops.push(['history.group.rename', { group: pick(random, [...tracker.groups.keys()]), name: `G ${Math.floor(random() * 3)}` }]);
  }
  // Restores of older entries (not only the one just made), twice as likely.
  const open = tracker.journal.filter(entry => !entry.purged);
  if (open.length > 0) {
    ops.push(['history.journal.undo', { entry: pick(random, open).id }]);
    ops.push(['history.journal.undo', { entry: pick(random, open).id }]);
  }
  const others = history.trackers().filter(each => each !== tracker);
  if (others.length > 0) {
    ops.push(['history.tracker.use', { tracker: pick(random, others).id }]);
    ops.push(['history.tracker.remove', { tracker: pick(random, history.trackers()).id }]);
  }
  const [type, params] = pick(random, ops);
  log.push(`${type} ${JSON.stringify(params)}`);
  // An edit made while paused with changes keeps them as one step first (a move never loses them), which
  // the edit's own undo leaves: its exact-restore check is made without paused changes.
  const before = JOURNALED.has(type) && history.pausedChanges() === null ? withoutJournal(history.snapshot()) : null;
  const outcome = await act(ctx, type, params);
  return { type, params, outcome, before };
}

/**
 * Register one test per seed in `[from, to]` (a shard of the seeds; the
 * shards run in parallel). `HISTORY_SEEDS` runs seeds 1 to n in one shard
 * instead (a deeper local run).
 */
export function runSeeds(from, to) {
  for (let seed = from; seed <= to; seed++) {
    test(`history invariants hold through a random sequence (seed ${seed})`, async () => {
      const random = prng(seed);
      const ctx = await makePage();
      const log = [];
      for (let i = 0; i < 40; i++) {
        let done;
        try {
          done = await randomOperation(ctx, random, log);
        } catch (error) {
          error.message = `seed ${seed}, operation ${i} (${log.join(' | ')}): ${error.message}`;
          throw error;
        }
        const label = `seed ${seed}, operation ${i} (${log.join(' | ')})`;
        await ctx.history.idle();
        await checkInvariants(ctx, label);
        if (done?.type === 'history.step.delete' && done.outcome !== null && ctx.history.active.paused === null) {
          const expected = fullReapply(ctx.history);
          if (expected !== null) {
            const head = valuesAt(ctx.history.active, ctx.history.active.headId);
            for (const [domain, key] of Object.entries(KEYS)) {
              assert.equal(ctx.history.pool.get(head[domain]), expected[key], `${label}: ${domain} after the dependent re-apply`);
            }
          }
        }
        // Undo of the edit just made puts back exactly what was there (from Recently deleted).
        if (done?.before && done.outcome?.journal && random() < 0.5) {
          const tracker = ctx.history.active;
          const restored = await act(ctx, 'history.journal.undo', { entry: done.outcome.journal, tracker: tracker.id });
          if (restored?.restored === 'exact') {
            await ctx.history.idle();
            assert.deepEqual(withoutJournal(ctx.history.snapshot()), done.before, `${label}: the restore gives back what was there`);
            await checkInvariants(ctx, `${label} (restored)`);
          }
        }
      }
      // Save and load: the same history in a fresh page.
      const saved = ctx.history.snapshot();
      const values = new Map(ctx.history.pool.hashes().map(hash => [hash, ctx.history.pool.get(hash)]));
      const fresh = await makePage();
      await fresh.history.load(saved, { values });
      assert.deepEqual(comparable(fresh.history.snapshot()), comparable(saved), `seed ${seed}: save → load is the same history`);
    });
  }
}

/** The test of the pool after emptying Recently deleted (in the first shard). */
export function runPoolTest() {
  test('emptying Recently deleted leaves no value that nothing refers to', async () => {
    const random = prng(99);
    const ctx = await makePage();
    const log = [];
    for (let i = 0; i < 80; i++) await randomOperation(ctx, random, log);
    await act(ctx, 'history.journal.empty', {});
    await ctx.history.idle();
    const kept = new Set(Object.values(ctx.history.shownHashes()));
    for (const tracker of ctx.history.allTrackers()) referencedHashes(tracker, kept);
    for (const hash of ctx.history.pool.hashes()) assert.ok(kept.has(hash), `the pool keeps ${hash.slice(0, 8)} only while something refers to it`);
  });
}
