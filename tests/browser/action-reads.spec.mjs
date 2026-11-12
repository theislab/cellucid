/**
 * Declared inputs hold on the real page (History v2 §3.4, §6 test 2): an
 * action applied in two states that differ only in domains it neither
 * touches nor reads gives the same after-values, or the same refusal. That
 * is what makes a step's staleness and a deleted step's dependent re-apply
 * exact; the declarations themselves are checked in Node
 * (`tests/action-reads-contract.test.mjs`).
 *
 * On the Current UI fixture, each action of a list that covers every area is
 * applied at a base state, and again after each of a set of perturbations
 * (one action each: a field renamed, a filter, a color, hidden cells, a
 * highlight, the camera, the camera path, a setting, the layout, a gene set,
 * the data mapping, the coloring, another share of the cells, a kept
 * view). Which domains a perturbation changed is measured (the state
 * fingerprint), never assumed; a pair is checked when the perturbation
 * changed none of the domains the action touches or reads. Every action must
 * change the state at the base (so no pair is vacuous), and every
 * perturbation must change something. The page's own history takes each
 * step back, and the base is checked to be exactly what it was before the
 * next pair.
 *
 * After-values are compared with the ids the app generates renamed in order
 * of appearance (a highlight group's and a page's counters, a user field's
 * time-and-counter id and its `createdAt` time, a keyframe's random id): an
 * action applied twice makes new ones each time, which is no input it reads. (That a re-applied
 * step never gives its first after-values back, by its ids alone, matters to
 * the history's dependent re-apply: History v2 §3.3.4.)
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { turnedCamera, waitForHistory } from './helpers/state-history.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=action-reads`;

const CELL_TYPE = { source: 'obs', key: 'cell_type' };
const SCORE = { source: 'obs', key: 'score' };

/**
 * What the base state holds besides the fixture's start: a continuous
 * coloring and a page with cells. No analysis is open: with one open, an
 * undo of a highlight or field change leaves the `analysis` domain changed
 * (its selected pages, its options), outside any step, so the base could not
 * be put back; the analyses' inputs are checked here once that is fixed.
 */
const SETUP = [
  ['color.by', { field: SCORE }],
  ['highlight.cells', { cells: Array.from({ length: 30 }, (_, cell) => cell * 2), label: 'Setup' }],
];

/** The actions checked, each with parameters that change the base state. */
function actionsUnderTest(camera) {
  return [
    ['color.by', { field: CELL_TYPE }],
    ['color.category', { field: CELL_TYPE, category: 'beta', color: '#654321' }],
    ['color.continuous.colormap', { field: SCORE, colormap: 'plasma' }],
    ['color.continuous.log', { field: SCORE, enabled: true }],
    ['color.continuous.rescale', { field: SCORE, enabled: false }],
    ['filter.category.visibility', { field: CELL_TYPE, categories: ['beta'], visible: false }],
    ['filter.category.missing', { field: CELL_TYPE, visible: false }],
    ['filter.category.cell-count', { field: CELL_TYPE, category: 'beta', count: 7, seed: 3 }],
    ['filter.category.all', { field: CELL_TYPE, visible: false }],
    ['filter.continuous.range', { field: SCORE, min: 0.2, max: 0.8 }],
    ['category.rename', { field: CELL_TYPE, category: 'alpha', name: 'A' }],
    ['field.rename', { field: SCORE, name: 'quality' }],
    ['field.duplicate', { field: CELL_TYPE, name: 'copy' }],
    ['field.create-from-pages', { key: 'from_pages', pages: [{ page: 'Page 1', label: 'Picked' }] }],
    ['field.push', {
      key: 'pushed', kind: 'continuous', categories: null, n_obs: 120, cells: null,
      values: Array.from({ length: 120 }, (_, cell) => cell / 120),
    }],
    ['gene-set.save', { name: 'Mine', genes: ['CD3E'] }],
    ['highlight.cells', { cells: [7, 9, 11], label: 'Three' }],
    ['highlight.category', { field: CELL_TYPE, categories: ['gamma'] }],
    ['highlight.range', { field: SCORE, min: 0, max: 0.5 }],
    ['highlight.page.create', { name: 'Second' }],
    ['cells.visibility.set', { cells: [10, 11], visible: false }],
    ['camera.set', camera],
    ['camera-path.keyframe.add', { label: 'K' }],
    ['view.keep', {}],
    ['setting.set', { setting: 'point-size', value: 7 }],
    ['layout.theme.set', { theme: 'dark' }],
    ['mapping.set', { latent: null }],
  ];
}

/** The perturbations: one action each, whatever it changes (measured). */
function perturbations(camera) {
  return [
    ['field.rename', { field: { source: 'obs', key: 'cell_type' }, name: 'kind' }],
    ['filter.category.visibility', { field: CELL_TYPE, categories: ['alpha'], visible: false }],
    ['color.category', { field: CELL_TYPE, category: 'gamma', color: '#123456' }],
    ['cells.visibility.set', { cells: [5, 6], visible: false }],
    ['highlight.cells', { cells: [1, 3, 5], label: 'Other' }],
    ['camera.set', camera],
    ['camera-path.keyframe.add', { label: 'P' }],
    ['setting.set', { setting: 'point-size', value: 3 }],
    ['layout.section.open', { section: 'Visualization', open: true }],
    ['gene-set.save', { name: 'Theirs', genes: ['CD3E'] }],
    ['mapping.set', { latent: null }],
    ['color.by', { field: CELL_TYPE }],
    ['cells.open', { mode: 'subsample', count: 60, method: 'uniform', seed: 1 }],
    ['view.keep', {}],
  ];
}

async function openFixture(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  await waitForHistory(page);
}

test('an action gives the same after-values in states that differ only in domains it neither touches, reads nor resolves names in', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openFixture(page);
  const camera = await turnedCamera(page, 40);
  const otherCamera = await turnedCamera(page, -25);

  const report = await page.evaluate(async ({ setup, actions, perturbers }) => {
    const { getActions, getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint, differingDomains } = await import('/assets/js/app/state/domains/fingerprint.js');
    const { hashValue } = await import('/assets/js/app/history/value-pool.js');
    const GENERATED_ID = /^(?:highlight_\d+|page_\d+|user_[a-z_]+_\d+_\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
    /** `value` with every generated id renamed by its order of appearance, and creation times left out. */
    function withIdsInOrder(value) {
      const names = new Map();
      const name = text => {
        if (!GENERATED_ID.test(text)) return text;
        if (!names.has(text)) names.set(text, `#${names.size}`);
        return names.get(text);
      };
      const walk = node => {
        if (typeof node === 'string') return name(node);
        if (node === null || typeof node !== 'object' || ArrayBuffer.isView(node)) return node;
        if (Array.isArray(node)) return node.map(walk);
        return Object.fromEntries(Object.entries(node).map(([key, item]) => [name(key), key === 'createdAt' ? '#time' : walk(item)]));
      };
      return walk(value);
    }
    const dispatcher = getActions();
    const domains = getStateDomains();
    const history = window._cellucidHistories.current();
    const settle = () => dispatcher.idle();
    const fingerprint = async () => { await settle(); return stateFingerprint(domains); };

    /** Dispatch; the step (or null), the refusal code (or null), and the state after. */
    async function apply(type, params) {
      let step = null;
      let refused = null;
      try {
        ({ step } = await dispatcher.dispatch(type, params, {}));
      } catch (error) {
        refused = `${error?.code ?? error?.name}: ${error?.message ?? error}`;
      }
      return { step, refused, after: await fingerprint() };
    }
    async function undo(step) {
      if (step === null) return;
      await history.undo();
      await settle();
    }
    /** The after-values of the domains `type` touches, generated ids in order of appearance. */
    async function touched(type) {
      const out = {};
      for (const id of dispatcher.catalog.get(type).touches) out[id] = await hashValue(withIdsInOrder(await domains.owner(id).capture()));
      return out;
    }

    for (const [type, params] of setup) {
      const { refused } = await apply(type, params);
      if (refused !== null) return { setupRefused: `${type}: ${refused}` };
    }
    const base = await fingerprint();

    // Each action at the base: what it gives, and that it changes the state.
    const atBase = new Map();
    const problems = [];
    for (const [type, params] of actions) {
      const { step, refused } = await apply(type, params);
      if (refused !== null || step === null) problems.push(`${type} changes nothing at the base (${refused ?? 'no step'})`);
      atBase.set(type, { refused, values: await touched(type) });
      await undo(step);
      const back = await fingerprint();
      if (back.digest !== base.digest) return { problems: [...problems, `undo of ${type} left ${differingDomains(base, back).join(', ')}`] };
    }

    const pairs = [];
    const skipped = [];
    for (const [perturber, perturbParams] of perturbers) {
      const perturbed = await apply(perturber, perturbParams);
      if (perturbed.refused !== null || perturbed.step === null) {
        problems.push(`perturbation ${perturber} changes nothing (${perturbed.refused ?? 'no step'})`);
        await undo(perturbed.step);
        continue;
      }
      const changed = differingDomains(base, perturbed.after);
      for (const [type, params] of actions) {
        const definition = dispatcher.catalog.get(type);
        const depends = [...definition.touches, ...definition.reads, ...definition.context];
        const overlap = changed.filter(id => depends.includes(id));
        if (overlap.length > 0) {
          skipped.push(`${type} after ${perturber}: ${overlap.join(', ')}`);
          continue;
        }
        const { step, refused } = await apply(type, params);
        const expected = atBase.get(type);
        const values = await touched(type);
        const differs = Object.keys(values).filter(id => values[id] !== expected.values[id]);
        pairs.push({ type, perturber, changed, refused, expectedRefused: expected.refused, differs });
        await undo(step);
        const back = await fingerprint();
        if (back.digest !== perturbed.after.digest) {
          return { problems: [...problems, `undo of ${type} after ${perturber} left ${differingDomains(perturbed.after, back).join(', ')}`] };
        }
      }
      await undo(perturbed.step);
      const back = await fingerprint();
      if (back.digest !== base.digest) return { problems: [...problems, `undo of ${perturber} left ${differingDomains(base, back).join(', ')}`] };
    }
    return { problems, pairs, skipped };
  }, { setup: SETUP, actions: actionsUnderTest(camera), perturbers: perturbations(otherCamera) });

  expect(report.setupRefused).toBeUndefined();
  const violations = (report.pairs ?? [])
    .filter(pair => pair.differs.length > 0 || pair.refused !== pair.expectedRefused)
    .map(pair => `${pair.type} after ${pair.perturber} (which changed ${pair.changed.join(', ')}): `
      + (pair.refused !== pair.expectedRefused ? `refused ${pair.refused} here, ${pair.expectedRefused} at the base` : `${pair.differs.join(', ')} differ`));
  // Problems: an action that changes nothing at the base, a perturbation that changes nothing, an
  // undo that does not put back exactly. Violations: an action read a domain it does not declare.
  expect({ problems: report.problems ?? [], violations }).toEqual({ problems: [], violations: [] });
  // Every action is checked against several perturbations, and every perturbation against several actions.
  const types = new Set(report.pairs.map(pair => pair.type));
  const perturbers = new Set(report.pairs.map(pair => pair.perturber));
  expect([...types].sort()).toEqual(actionsUnderTest(camera).map(([type]) => type).sort());
  expect(perturbers.size).toBeGreaterThanOrEqual(10);
  expect(report.pairs.length).toBeGreaterThan(150);
  expect(errors).toEqual([]);
});
