/**
 * The page's own history, for the specs of the State panel: the history the
 * dataset lifecycle publishes once the dataset's starting view is applied
 * (`app/history/dataset-history.js`, `window._cellucidHistories`), driven by
 * the page's own actions (`getActions().dispatch`), so every step is one a
 * person, an agent or a notebook takes, and every undo puts back the real
 * state.
 */

/** Wait for the history of the dataset shown to start (its first tracker). */
export async function waitForHistory(page) {
  await page.waitForFunction(() => window._cellucidHistories?.current()?.active != null);
}

/**
 * Take the steps a spec names through the page's dispatcher, one after the
 * other: `[type, params, meta?]` each. Resolves to each step's id (null when
 * the action changed nothing).
 */
export async function takeSteps(page, steps) {
  return page.evaluate(async list => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    const ids = [];
    for (const [type, params, meta] of list) {
      const { step } = await getActions().dispatch(type, params, meta ?? {});
      ids.push(step?.id ?? null);
    }
    return ids;
  }, steps);
}

/**
 * The parameters of `camera.set` that turn the live view's camera `degrees`
 * around its target from where it is now.
 */
export async function turnedCamera(page, degrees) {
  return page.evaluate(turn => {
    const camera = structuredClone(window._cellucidViewer.getViewCameraState('live'));
    camera.orbit.theta += (turn * Math.PI) / 180;
    return { view: 'View 1', camera };
  }, degrees);
}

/** The shown tracker as plain facts: head, tip, step labels and statuses by id. */
export async function historyFacts(page) {
  return page.evaluate(() => {
    const history = window._cellucidHistories.current();
    const tree = history.active;
    return {
      tracker: tree.name,
      trackers: history.trackers().map(t => t.name),
      head: tree.headId,
      tip: tree.branches.get(tree.activeBranch).tip,
      steps: tree.steps.size,
      labels: Object.fromEntries([...tree.steps.values()].map(step => [step.id, step.label])),
      statuses: Object.fromEntries([...tree.steps.values()].map(step => [step.id, step.status])),
    };
  });
}

/** What the live view hides of `field` now (the `filters` domain's value of the live view). */
export async function hiddenOf(page, field) {
  return page.evaluate(async key => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { views } = await getStateDomains().owner('filters').capture();
    return views[0].find(entry => entry.field.key === key)?.hidden ?? [];
  }, field);
}

/**
 * The property every action's `touches` is proved by, on the page's own
 * history: each action is applied through the page's dispatcher, what it
 * changed must be among the domains it names, undo must put every domain
 * back exactly (the state fingerprint), and redo applies it again so the
 * next action acts on it. `steps` are `[type, params, meta?]`.
 *
 * @returns {Promise<Array<{type: string, step: boolean, refused: string|null, changed: string[], untouched: string[], differs: string[], redone: string[]}>>}
 *   per action: whether it was a step, why it was refused, the domains it changed, those it does
 *   not name, those undo did not put back, and those redo did not give again
 */
export async function applyUndoRedo(page, steps) {
  return page.evaluate(async list => {
    const { getActions, getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint, differingDomains } = await import('/assets/js/app/state/domains/fingerprint.js');
    const history = window._cellucidHistories.current();
    const domains = getStateDomains();
    const out = [];
    for (const [type, params, meta] of list) {
      const touches = getActions().catalog.get(type).touches;
      const before = await stateFingerprint(domains);
      let step = null;
      let refused = null;
      try {
        ({ step } = await getActions().dispatch(type, params, meta ?? {}));
      } catch (error) {
        refused = error?.message ?? String(error);
      }
      const after = await stateFingerprint(domains);
      const changed = differingDomains(before, after);
      let differs = [];
      let redone = [];
      if (step !== null) {
        await history.undo();
        differs = differingDomains(before, await stateFingerprint(domains));
        await history.redo();
        redone = differingDomains(after, await stateFingerprint(domains));
      }
      out.push({ type, step: step !== null, refused, changed, untouched: changed.filter(id => !touches.includes(id)), differs, redone });
    }
    return out;
  }, steps);
}
