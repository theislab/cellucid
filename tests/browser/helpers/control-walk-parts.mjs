/**
 * The control walk's parts and the shares they are run in
 * (`control-walk.mjs`; nothing here needs a browser, so the contract test
 * `tests/browser-workflow-sharding-contract.test.mjs` reads the same lists
 * the spec files declare from).
 *
 * A part is a test: a section of the sidebar each, then everything outside
 * them; one more test walks the graph and vector controls. The spec files
 * `control-walk-<k>-of-<n>.spec.mjs` hold a share each, and CI runs a share
 * a job, so the walk ends when its heaviest share does. The shares hold as
 * many tests as each other and are filled by weight (`walkShares`): a test weighs the controls its walk
 * operated when it was last recorded (`control-walk-weights.json`, written
 * by the walk itself, never by hand:
 * `CELLUCID_CONTROL_WALK_WEIGHTS=record` on a run of the walk). A record
 * that is behind the page costs balance and nothing else: a test it does not
 * name weighs as the average one, a name it holds that is no test is not
 * read, and every test is in exactly one share whatever it says.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEIGHTS_FILE = path.join(HERE, 'control-walk-weights.json');

/** The sidebar's sections, in page order (`details.accordion-section` of index.html). */
export const SECTIONS = [...fs.readFileSync(path.join(HERE, '..', '..', '..', 'index.html'), 'utf8')
  .matchAll(/<details class="accordion-section"[^>]*\bid="([^"]+)"/g)].map(match => match[1]);
export const OUTSIDE_SECTIONS = 'outside the sections';

/**
 * The only controls left out one by one: they replace the dataset (its
 * history is retired and another starts), which the dataset-switch and
 * benchmark specs cover.
 */
export const LEFT_OUT = Object.freeze([
  { key: '#dataset-select', why: 'opens another sample dataset: this dataset and its history are replaced (dataset-switch specs)' },
  { place: 'benchmark-section', why: 'generates and opens a synthetic dataset of up to 40M cells, replacing this one (benchmark specs)' },
  { name: 'Continue with GitHub', why: 'signs in: the page goes to github.com (community-annotation-startup-lifecycle and oauth-worker specs)' },
  { key: '#kept-stores-remove-all', why: 'deletes everything this browser keeps (stores, parts, saved states), which no history holds (kept-stores-dialog spec)' },
  { place: 'kept-stores-list', namePrefix: 'Remove', why: 'deletes what this browser keeps of one dataset, which no history holds (kept-stores-dialog spec)' },
]);

/**
 * The parts the walk is split into, a test each: every section of the sidebar the walk does not leave out whole, then
 * every control outside them (the toolbars, the legend, the floating panels
 * and analysis windows, the canvas, and the sections left out whole, listed
 * as left out). What a control opens is walked in its control's part.
 */
export const PARTS = [...SECTIONS.filter(id => !LEFT_OUT.some(item => item.place === id && item.namePrefix === undefined)), OUTSIDE_SECTIONS];

/** The test that walks the graph and vector controls of another dataset. */
export const GRAPH_AND_VECTORS = 'graph and vectors';

/** Every test of the walk by name: the parts, then the graph and vectors. */
export const WALK_TESTS = [...PARTS, GRAPH_AND_VECTORS];

/** The recorded weights: test name → controls its walk operated. */
export function readWalkWeights() {
  return fs.existsSync(WEIGHTS_FILE) ? JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8')) : {};
}

/** Whether this run records the weights (`CELLUCID_CONTROL_WALK_WEIGHTS=record`). */
export function recordsWalkWeights() {
  const value = process.env.CELLUCID_CONTROL_WALK_WEIGHTS ?? '';
  if (value !== '' && value !== 'record') throw new Error(`CELLUCID_CONTROL_WALK_WEIGHTS is "record" or unset, not "${value}".`);
  return value === 'record';
}

/**
 * Record what the test `name` weighs: the controls its walk operated (one
 * left out costs no time and is not counted). The file keeps the walk's
 * tests in their order and drops a name that is no test any more.
 */
export function recordWalkWeight(name, report) {
  const weights = { ...readWalkWeights(), [name]: report.filter(entry => entry.outcome !== 'left out').length };
  const kept = Object.fromEntries(WALK_TESTS.filter(test => Number.isInteger(weights[test])).map(test => [test, weights[test]]));
  fs.writeFileSync(WEIGHTS_FILE, `${JSON.stringify(kept, null, 2)}\n`);
}

/**
 * Split `names` into `shares` lists, each name in exactly one: as many names
 * in each as in the others (the first shares one more when they do not
 * divide), and of about equal weight. The count is Playwright's: `--shard`
 * splits by test count, so it gives each spec file a shard of its own only
 * while the files hold their tests in those numbers
 * (`tests/browser-shard-capacity-contract.test.mjs`). The weight is filled
 * the heaviest name first, each to the share that is lightest so far among
 * those with room (the first of equals), so the heaviest tests are a share
 * apart. A name `weights` does not hold weighs as the average of those it
 * holds (1 when it holds none). Each share keeps the order of `names`.
 *
 * @param {ReadonlyArray<string>} names
 * @param {Readonly<Record<string, number>>} weights
 * @param {number} shares
 * @returns {string[][]}
 */
export function walkShares(names, weights, shares) {
  const known = names.filter(name => Number.isInteger(weights[name]) && weights[name] >= 0);
  const average = known.length === 0 ? 1 : known.reduce((sum, name) => sum + weights[name], 0) / known.length;
  const weightOf = name => (known.includes(name) ? weights[name] : average);
  const room = Array.from({ length: shares }, (_, share) => Math.floor(names.length / shares) + (share < names.length % shares ? 1 : 0));
  const loads = room.map(() => 0);
  const shareOf = new Map();
  const heaviestFirst = names.map((name, index) => ({ name, index })).sort((a, b) => weightOf(b.name) - weightOf(a.name) || a.index - b.index);
  for (const { name } of heaviestFirst) {
    const open = loads.map((load, share) => ({ load, share })).filter(({ share }) => room[share] > 0);
    const { share } = open.reduce((lightest, next) => (next.load < lightest.load ? next : lightest));
    loads[share] += weightOf(name);
    room[share] -= 1;
    shareOf.set(name, share);
  }
  return loads.map((_, share) => names.filter(name => shareOf.get(name) === share));
}
