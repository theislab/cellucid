/**
 * Helpers of the history hunt specs (`history-hunt-*.spec.mjs`): a long run
 * of steps across many domains with the state fingerprint kept after each,
 * then jumps far back and forward that must give each fingerprint back
 * exactly. They drive the page's own history and dispatcher, so they hold for
 * any history implementation that keeps `window._cellucidHistories` and the
 * catalogue's actions.
 */

/**
 * Take `steps` (`[type, params, meta?]`) one after the other. After each,
 * once nothing is under way, keep the step shown and the state fingerprint.
 * Resolves to `{root, after: [{index, type, step, refused, fingerprint}]}`
 * (`root`: the fingerprint before the first step, with the step shown).
 */
export async function recordRun(page, steps) {
  return page.evaluate(async list => {
    const { getActions, getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint } = await import('/assets/js/app/state/domains/fingerprint.js');
    const history = window._cellucidHistories.current();
    const domains = getStateDomains();
    await history.idle();
    const root = { step: history.active.headId, fingerprint: await stateFingerprint(domains) };
    const after = [];
    for (const [index, [type, params, meta]] of list.entries()) {
      let refused = null;
      try {
        await getActions().dispatch(type, params, meta ?? {});
      } catch (error) {
        refused = error?.message ?? String(error);
      }
      await history.idle();
      after.push({ index, type, step: history.active.headId, refused, fingerprint: await stateFingerprint(domains) });
    }
    return { root, after };
  }, steps);
}

/**
 * Jump to each step of `targets` (`{step, fingerprint}`) in turn and report
 * the domains whose value differs from the one kept for it.
 */
export async function jumpAndCompare(page, targets) {
  return page.evaluate(async list => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint, differingDomains } = await import('/assets/js/app/state/domains/fingerprint.js');
    const history = window._cellucidHistories.current();
    const domains = getStateDomains();
    const out = [];
    for (const target of list) {
      let error = null;
      try {
        await history.jump(target.step);
      } catch (failure) {
        error = failure?.message ?? String(failure);
      }
      await history.idle();
      const now = await stateFingerprint(domains);
      out.push({ to: target.label ?? target.step, error, differs: differingDomains(target.fingerprint, now) });
    }
    return out;
  }, targets);
}

/** A small seeded random generator (mulberry32), so a run's order is the same every time. */
export function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Errors the page reports (console errors and uncaught exceptions). */
export function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

/** Warnings the history writes when it meets a change made outside an action. */
export function observeOutsideChanges(page) {
  const warnings = [];
  page.on('console', message => {
    if (message.type() === 'warning' && message.text().includes('[history]')) warnings.push(message.text());
  });
  return warnings;
}

const CELL_TYPE = Object.freeze({ source: 'obs', key: 'cell_type' });
const SCORE = Object.freeze({ source: 'obs', key: 'score' });
const COPY = Object.freeze({ source: 'obs', key: 'copy' });

/** The parameters of `camera.set` that turn the live view's camera `degrees` around its target. */
export function camera(page, degrees) {
  return page.evaluate(turn => {
    const state = structuredClone(window._cellucidViewer.getViewCameraState('live'));
    state.orbit.theta += (turn * Math.PI) / 180;
    return { view: 'View 1', camera: state };
  }, degrees);
}

/** A run of 30 steps over the current-ui fixture that touches every kind of state. */
export async function mixedRun(page) {
  return [
    ['color.by', { field: CELL_TYPE }],
    ['filter.category.visibility', { field: CELL_TYPE, categories: ['gamma'], visible: false }],
    ['category.rename', { field: CELL_TYPE, category: 'alpha', name: 'A' }],
    ['field.duplicate', { field: CELL_TYPE, name: 'copy' }],
    ['category.merge', { field: COPY, category: 'beta', into: 'A' }],
    ['camera.set', await camera(page, 25)],
    ['highlight.cells', { cells: [0, 2, 4, 6], label: 'First' }],
    ['category.delete', { field: COPY, category: 'gamma' }],
    ['cells.visibility.set', { cells: [5, 6, 7], visible: false }],
    ['gene-set.save', { name: 'T set', genes: ['CD3E', 'NKG7'] }],
    ['setting.set', { setting: 'point-size', value: 30 }],
    ['view.keep', {}],
    ['color.by', { field: SCORE }],
    ['filter.continuous.range', { field: SCORE, min: 0.2, max: 0.8 }],
    ['highlight.page.create', { name: 'B' }],
    ['highlight.cells', { cells: [10, 11, 12], label: 'Second' }],
    ['layout.theme.set', { theme: 'dark' }],
    ['camera-path.keyframe.add', { camera: (await camera(page, 40)).camera, label: 'K1' }],
    ['color.continuous.colormap', { field: SCORE, colormap: 'plasma' }],
    ['field.rename', { field: SCORE, name: 'quality' }],
    ['view.focus', { view: 'View 1' }],
    ['filter.category.visibility', { field: CELL_TYPE, categories: ['beta'], visible: false }],
    ['color.by', { field: { source: 'var', key: 'CD3E' } }],
    ['highlight.group.toggle', { group: 'First', enabled: false, page: 'Page 1' }],
    ['view.remove', { view: 'View 2' }],
    ['field.delete', { field: COPY }],
    ['camera.set', await camera(page, -60)],
    ['setting.set', { setting: 'point-size', value: 12 }],
    ['category.rename', { field: CELL_TYPE, category: 'A', name: 'alpha' }],
    ['layout.theme.set', { theme: 'light' }],
  ];
}

