/**
 * A page of fake domains for the History v2 core tests (not a test itself):
 * `a` (filters, set), `b` (colors, incremented), `c` (analysis, derived from
 * a and b: it reads them), a camera that coalesces, and a theme (layout).
 * `slow` holds the derive open, so a test can act while an operation runs.
 */
import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { validateHistory } from '../assets/js/app/history/model.js';
import { valuesAt } from '../assets/js/app/history/tree.js';

const KEYS = { filters: 'a', colors: 'b', analysis: 'c', camera: 'cam', layout: 'theme' };

export function fakePage() {
  const state = { a: 0, b: 0, c: 0, cam: 0, theme: 'light' };
  const domains = createDomainRegistry();
  for (const [id, key] of Object.entries(KEYS)) {
    domains.provide(id, { capture: () => state[key], restore: value => { state[key] = value; }, describe: (x, y) => [`${x} → ${y}`] });
  }
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  return { state, domains };
}

export const NUMBER = Object.freeze({ type: 'object', additionalProperties: false, required: ['v'], properties: { v: { type: 'integer' } } });
export const NONE = Object.freeze({ type: 'object', additionalProperties: false, properties: {} });

export const definitions = [
  defineAction({ type: 'a.set', title: 'Set a', summary: 'Set a.', group: 'T', params: NUMBER, touches: ['filters'], reads: [], effect: 'state', describe: p => `a = ${p.v}`, code: p => `a(${p.v})` }),
  defineAction({ type: 'b.inc', title: 'Increment b', summary: 'b + 1.', group: 'T', params: NONE, touches: ['colors'], reads: [], effect: 'view', describe: () => 'b + 1', code: () => 'inc_b()' }),
  defineAction({ type: 'c.derive', title: 'Derive c', summary: 'c from a and b.', group: 'T', params: NONE, touches: ['analysis'], reads: ['filters', 'colors'], effect: 'state', describe: () => 'c = 10a + b', code: () => 'derive()' }),
  defineAction({ type: 'cam.set', title: 'Camera', summary: 'Camera.', group: 'T', params: NUMBER, touches: ['camera'], reads: [], effect: 'view', coalesce: () => 'cam', describe: p => `cam ${p.v}`, code: p => `cam(${p.v})` }),
];

export function trackerId(n) {
  return `t-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/**
 * A hold a test opens and releases: while armed, the derive waits on it;
 * `entered` resolves once the derive is waiting (no timer: the test knows).
 */
export function slowGate() {
  let open;
  let entered;
  const slow = { hold: false, promise: null, entered: null };
  slow.wait = () => { entered(); return slow.promise; };
  slow.arm = () => {
    slow.hold = true;
    slow.promise = new Promise(resolve => { open = resolve; });
    slow.entered = new Promise(resolve => { entered = resolve; });
  };
  slow.release = () => { slow.hold = false; open(); };
  return slow;
}

/** A promise and its resolve, for a test to hold something open and know when it is reached. */
export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

let trackers = 0;

/** A history on the fake page, started; `act` answers an action's outcome, `step` the step it made. */
export async function makePage({ offDomains = () => [], slow = null, extra = [], provide = () => {}, openSaved = null } = {}) {
  const page = fakePage();
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([...definitions, ...extra, ...historyActions]) });
  dispatcher.provide('a.set', ({ v }) => { page.state.a = v; });
  dispatcher.provide('b.inc', () => { page.state.b += 1; });
  dispatcher.provide('c.derive', async () => {
    if (slow !== null && slow.hold) await slow.wait();
    page.state.c = page.state.a * 10 + page.state.b;
  });
  dispatcher.provide('cam.set', ({ v }) => { page.state.cam = v; });
  provide(dispatcher, page);
  let t = 0;
  const history = createHistory({
    dispatcher, domains: page.domains, dataset: { id: 'd1', name: 'Demo', cellOrder: null },
    newTrackerId: () => trackerId(++trackers), now: () => ++t * 1000, offDomains, openSaved,
  });
  await history.startTracker();
  const act = async (type, params = {}, meta = {}) => (await dispatcher.dispatch(type, params, meta)).outcome;
  const step = async (type, params = {}, meta = {}) => (await dispatcher.dispatch(type, params, meta)).step;
  return { page, dispatcher, history, act, step };
}

/** Every step whose before-value of a domain is not its parent's value there (the invariant moves rely on). */
export function beforeInvariantBreaks(tracker) {
  const out = [];
  for (const step of tracker.steps.values()) {
    if (step.parent === null) continue;
    const at = valuesAt(tracker, step.parent);
    for (const [domain, hash] of Object.entries(step.before)) if (at[domain] !== hash) out.push(`${step.id}.before.${domain}`);
  }
  return out;
}

/** The model's validator's complaint about the whole history, or null. */
export function historyProblem(history) {
  try {
    validateHistory(history.snapshot());
    return null;
  } catch (error) {
    return error.message;
  }
}
