/**
 * History hunt: exact restore across many domains. A long run of steps that
 * mixes every kind of state (labels, user fields, categories renamed, merged
 * and deleted, filters, hidden cells, highlights, gene sets, views kept and
 * removed, cameras, the camera path, settings, layout), then jumps far back
 * and forward in a seeded order: each must give the state fingerprint kept
 * after that step back exactly, domain by domain.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { waitForHistory } from './helpers/state-history.mjs';
import { jumpAndCompare, mixedRun, observeOutsideChanges, observeProductErrors, recordRun, seeded } from './helpers/history-hunt.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=history-hunt-exact`;

async function open(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await waitForHistory(page);
}

test('a long mixed run: every far jump back and forward gives each step\'s state back exactly', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = observeProductErrors(page);
  const outside = observeOutsideChanges(page);
  await open(page);
  const run = await recordRun(page, await mixedRun(page));
  const refused = run.after.filter(entry => entry.refused !== null).map(entry => `${entry.type}: ${entry.refused}`);
  expect(refused, 'every step of the run applies').toEqual([]);
  const targets = [{ step: run.root.step, fingerprint: run.root.fingerprint, label: 'root' },
    ...run.after.map(entry => ({ step: entry.step, fingerprint: entry.fingerprint, label: `#${entry.index} ${entry.type}` }))];
  const random = seeded(7);
  const order = [targets[0], targets.at(-1), targets[12], targets[3], targets.at(-1), targets[0]];
  for (let i = 0; i < 40; i++) order.push(targets[Math.floor(random() * targets.length)]);
  const report = await jumpAndCompare(page, order);
  const bad = report.filter(entry => entry.error !== null || entry.differs.length > 0);
  expect(bad, 'jumps that did not give the state back').toEqual([]);
  expect(outside, 'no change outside an action').toEqual([]);
  expect(errors).toEqual([]);
});

test('step by step: undo all the way back, then redo all the way forward, each step exact', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = observeProductErrors(page);
  const outside = observeOutsideChanges(page);
  await open(page);
  const run = await recordRun(page, await mixedRun(page));
  expect(run.after.filter(entry => entry.refused !== null)).toEqual([]);
  const result = await page.evaluate(async count => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint } = await import('/assets/js/app/state/domains/fingerprint.js');
    const history = window._cellucidHistories.current();
    const domains = getStateDomains();
    const back = [];
    for (let i = 0; i < count; i++) { await history.undo(); await history.idle(); back.push(await stateFingerprint(domains)); }
    const forward = [];
    for (let i = 0; i < count; i++) { await history.redo(); await history.idle(); forward.push(await stateFingerprint(domains)); }
    return { back, forward };
  }, run.after.length);
  const fp = [run.root.fingerprint, ...run.after.map(entry => entry.fingerprint)];
  const differs = (a, b) => Object.keys(a.domains).filter(id => a.domains[id] !== b.domains[id]);
  const bad = [];
  result.back.forEach((now, i) => {
    const expected = fp[fp.length - 2 - i];
    const d = differs(expected, now);
    if (d.length) bad.push(`undo to #${fp.length - 2 - i}: ${d.join(', ')}`);
  });
  result.forward.forEach((now, i) => {
    const d = differs(fp[i + 1], now);
    if (d.length) bad.push(`redo to #${i + 1}: ${d.join(', ')}`);
  });
  expect(bad).toEqual([]);
  expect(outside).toEqual([]);
  expect(errors).toEqual([]);
});

test('one jump back over a coloring, a category rename and a kept view gives the opening back', async ({ page }) => {
  const errors = observeProductErrors(page);
  await open(page);
  const field = { source: 'obs', key: 'cell_type' };
  // The fixture opens colored by cell_type: the rename and the kept view are of the field shown,
  // and the coloring jumped over is the change to score.
  const run = await recordRun(page, [
    ['category.rename', { field, category: 'alpha', name: 'A' }],
    ['view.keep', {}],
    ['color.by', { field: { source: 'obs', key: 'score' } }],
  ]);
  expect(run.after.filter(entry => entry.refused !== null)).toEqual([]);
  // Showing the opening (a click on "Opened", Undo turn of an agent that did all three).
  const [back] = await jumpAndCompare(page, [{ step: run.root.step, fingerprint: run.root.fingerprint, label: 'opening' }]);
  expect(back).toEqual({ to: 'opening', error: null, differs: [] });
  expect(errors).toEqual([]);
});
