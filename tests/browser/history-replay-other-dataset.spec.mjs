/**
 * A history recorded on one dataset replays on another
 * (`assets/js/app/history/replay.js`, `history.replay`, the State panel):
 * "run my workflow on my next sample".
 *
 * Dataset A is the test catalog's `current-ui` (cell_type alpha, beta,
 * gamma; score; genes GAPDH, CD3E, …). Dataset B is `replay-other.h5ad`, the
 * same cells as another sample: its cell_type shares only gamma (delta,
 * epsilon), score is the same, and CD3E is CD3D. Steps taken on A are
 * replayed on B twice, from A's saved state (Saved states › Replay here) and
 * from A's session file (History menu › Replay a session file here…). Each
 * replay starts a new tracker on B linked to A's tracker; every step is
 * applied by name; the three that do not match (beta, alpha, CD3E) are kept
 * in the new tracker, flagged with the sentence that says why, and listed
 * under the status line; undo walks back step by step to exactly the state
 * the replay started on; B's own tracker keeps its steps; a session saved
 * on B and loaded again still says where its steps came from.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recordNotifications, saidInNotifications } from './helpers/notifications.mjs';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { chooseFiles } from './helpers/file-input.mjs';
import { waitForDatasetReady, waitForPageAtRest } from './helpers/dataset-ready.mjs';
import { takeSteps } from './helpers/state-history.mjs';
import { clickSaveSession, clickLoadSession } from './helpers/session-buttons.mjs';

const OTHER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'replay-other.h5ad');
const CELL_TYPE = { source: 'obs', key: 'cell_type' };

/**
 * The steps taken on A, and why each that does not match on B is refused (null: it applies).
 * Both open colored by cell_type (their first coloring, part of the opening): the first
 * coloring of the workflow is a gene both have, a change on A and on B.
 */
const WORKFLOW = Object.freeze([
  [['color.by', { field: { source: 'var', key: 'GAPDH' } }], null],
  [['highlight.category', { field: CELL_TYPE, categories: ['gamma'] }], null],
  [['filter.category.visibility', { field: CELL_TYPE, categories: ['beta'], visible: false }], /beta/],
  [['filter.category.visibility', { field: CELL_TYPE, categories: ['gamma'], visible: false }], null],
  [['color.category', { field: CELL_TYPE, category: 'alpha', color: '#ff0000' }], /alpha/],
  [['color.by', { field: { source: 'obs', key: 'score' } }], null],
  [['color.by', { field: { source: 'var', key: 'CD3E' } }], /CD3E/],
  [['color.by', { field: { source: 'var', key: 'GAPDH' } }], null],
]);
const UNMATCHED = WORKFLOW.filter(([, reason]) => reason !== null).length;

function collectProductErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/** The history of the dataset called `name`, once its first tracker started. */
async function waitForHistoryOf(page, name) {
  await page.waitForFunction(datasetName => {
    const history = window._cellucidHistories?.current();
    return history?.active != null && history.dataset.name === datasetName;
  }, name);
}

/** The shown tracker and every tracker, as plain facts. */
function trackerFacts(page) {
  return page.evaluate(() => {
    const history = window._cellucidHistories.current();
    const facts = tree => ({
      id: tree.id,
      name: tree.name,
      head: tree.headId,
      from: tree.start.from,
      steps: [...tree.steps.values()].slice(1).map(step => ({
        label: step.label, type: step.type, origin: step.by.origin, status: step.status, note: step.reason, touches: [...step.touches],
      })),
    });
    return { active: facts(history.active), trackers: history.trackers().map(facts) };
  });
}

/** The state fingerprint, and the values the history says it shows. */
function shownAndRecorded(page) {
  return page.evaluate(async () => {
    const { getActions, getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint } = await import('/assets/js/app/state/domains/fingerprint.js');
    await getActions().idle();
    const history = window._cellucidHistories.current();
    return { shown: (await stateFingerprint(getStateDomains())).domains, recorded: history.shownHashes() };
  });
}

/** What the live view shows of the replayed workflow: hidden categories, colors, highlights, the field. */
function liveState(page) {
  return page.evaluate(async () => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    const domains = getStateDomains();
    const [filters, colors, highlights, active] = await Promise.all(
      ['filters', 'colors', 'highlights', 'active-field'].map(id => domains.owner(id).capture()),
    );
    return {
      hidden: filters.views[0].filter(entry => entry.field.key === 'cell_type').map(entry => entry.hidden ?? []),
      categoryColors: colors.views[0].filter(entry => entry.field.key === 'cell_type').map(entry => entry.colors ?? []),
      groups: highlights.pages.flatMap(page => page.groups.map(group => ({ category: group.category ?? null, cells: group.cells.length }))),
      field: active.views[0],
    };
  });
}

function replayRow(page) {
  return page.locator('.saved-state', { hasText: 'Current UI fixture' });
}

/**
 * The banner above the graph (one line: where the tracker comes from) and
 * the report it opens (Report…): each step not applied here, with why.
 */
async function replayReport(page) {
  const banner = page.locator('#history-banner');
  await expect(banner).toBeVisible();
  const line = (await banner.locator('.history-banner-text').textContent()).trim();
  const dialog = page.locator('#history-replay-dialog');
  await banner.getByRole('button', { name: 'Report…' }).click();
  await expect(dialog).toBeVisible();
  const report = {
    summary: line,
    items: await dialog.locator('.history-replay-item[data-outcome="unmatched"]').evaluateAll(items => items.map(item => ({
      label: item.querySelector('.history-replay-step').textContent,
      reason: item.querySelector('.history-replay-reason').textContent,
    }))),
  };
  await dialog.locator('.app-dialog-close').click();
  return report;
}

/** Use another tracker, as a person does: the branch picker's tracker menu. */
async function useTracker(page, name) {
  await page.locator('#history-branch-btn').click();
  await page.locator('#history-branches .history-tracker-btn').click();
  await page.getByRole('menuitemcheckbox', { name }).click();
  await page.locator('#history-branch-btn').click();
}

/**
 * Every step a replay of WORKFLOW gives on B, in order: each by its label on
 * A (the same names on the same cells read the same), applied or flagged.
 */
function expectReplayedSteps(steps, labelsOnA) {
  expect(steps.map(step => step.label)).toEqual(labelsOnA);
  expect(steps.map(step => step.origin)).toEqual(WORKFLOW.map(() => 'replay'));
  expect(steps.map(step => step.type)).toEqual(WORKFLOW.map(([[type]]) => type));
  WORKFLOW.forEach(([, reason], index) => {
    const step = steps[index];
    if (reason === null) {
      expect(step.status, `${step.label} applies on B`).toBe('applied');
      expect(step.touches.length, `${step.label} changed something`).toBeGreaterThan(0);
    } else {
      expect(step.status, `${step.label} does not match on B`).toBe('unapplicable');
      expect(step.note).toMatch(reason);
      expect(step.touches).toEqual([]);
    }
  });
}

test('a history recorded on one dataset replays on another, in a new tracker linked to it, reporting every step that did not match', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await recordNotifications(page);
  const errors = collectProductErrors(page);

  // Panels, windows and theme are not recorded here (History settings): the
  // sections this spec opens would otherwise be steps or not depending on
  // whether they open before the history starts; the workflow is the history.
  await page.addInitScript(() => {
    try { localStorage.setItem('cellucid:history-settings', JSON.stringify({ recordLayout: false })); } catch { /* none kept */ }
  });

  // ---- Dataset A: the workflow, kept in this browser and saved as a session file.
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=browser-ci`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await waitForDatasetReady(page, 120);
  await waitForHistoryOf(page, 'Current UI fixture');
  const ids = await takeSteps(page, WORKFLOW.map(([step]) => step));
  expect(ids.every(id => id !== null), 'every step changes A').toBe(true);
  const source = await page.evaluate(() => {
    const history = window._cellucidHistories.current();
    return {
      dataset: { id: history.dataset.id, name: history.dataset.name },
      tracker: { id: history.active.id, name: history.active.name },
      head: history.active.headId,
      branch: { id: history.active.mainBranch, name: history.active.branches.get(history.active.mainBranch).name },
      labels: [...history.active.steps.values()].slice(1).map(step => step.label),
    };
  });
  expect(source.labels).toHaveLength(WORKFLOW.length);
  const downloadA = page.waitForEvent('download');
  await clickSaveSession(page);
  const sessionA = testInfo.outputPath('dataset-a.cellucid-session');
  await (await downloadA).saveAs(sessionA);

  // ---- Dataset B, with one step of its own.
  await chooseFiles(page.locator('#user-data-file-input'), OTHER);
  await expect(page.locator('#dataset-name')).toHaveText('Replay fixture');
  await waitForDatasetReady(page, 120);
  await waitForHistoryOf(page, 'Replay fixture');
  await takeSteps(page, [['color.by', { field: { source: 'obs', key: 'score' } }]]);
  await waitForPageAtRest(page);
  const own = (await trackerFacts(page)).active;
  expect(own.steps.map(step => step.label)).toEqual(['Colored by score']);
  const startedOn = await shownAndRecorded(page);
  expect(startedOn.shown).toEqual(startedOn.recorded);

  // ---- Replay A's saved state on B: Load… › Replay here.
  await page.locator('#history-load-btn').click();
  await expect(page.locator('#saved-states-dialog')).toBeVisible();
  await expect(replayRow(page)).toHaveCount(1);
  // B's own history is the one shown: it offers no replay onto itself.
  await expect(page.locator('.saved-state[data-current="true"] [data-saved-action="replay"]')).toBeHidden();
  await replayRow(page).getByRole('button', { name: /^Replay the steps of .* on the dataset shown$/ }).click();
  await expect(page.locator('#saved-states-dialog')).toBeHidden();
  await expect(page.locator('#history-banner')).toBeVisible({ timeout: 60_000 });
  // The banner shows once the new tracker starts; its report opens once the replay has ended
  // (steps did not match): only then are its steps all there.
  await expect(page.locator('#history-replay-dialog')).toBeVisible({ timeout: 60_000 });
  await waitForPageAtRest(page);

  const first = await trackerFacts(page);
  expect(first.trackers.map(tracker => tracker.name)).toEqual([own.name, 'Replay of Current UI fixture']);
  expect(first.active.name).toBe('Replay of Current UI fixture');
  // It names the saved state it came from, so its report can replay it again with other names.
  expect(first.active.from).toEqual({
    dataset: source.dataset, tracker: source.tracker, branch: source.branch, step: source.head, file: null, saved: expect.any(String),
  });
  expectReplayedSteps(first.active.steps, source.labels);
  // B's own tracker is as it was.
  expect(first.trackers[0]).toEqual(own);
  // What matched is applied by name on B's cells; what did not changed nothing.
  expect(await liveState(page)).toEqual({
    hidden: [['gamma']],
    categoryColors: [],
    groups: [{ category: 'gamma', cells: 40 }],
    field: { source: 'var', key: 'GAPDH' },
  });

  // The State panel: one line, the steps that did not match on click, each flagged in the timeline.
  // A replay with steps that did not match opened its report itself; closed, the banner's Report… opens it again.
  await page.locator('#history-replay-dialog').getByRole('button', { name: 'Keep as is', exact: true }).click();
  await expect(page.locator('#history-replay-dialog')).toBeHidden();
  const report = await replayReport(page);
  expect(report.summary).toBe(`Replayed from Current UI fixture: ${UNMATCHED} of ${WORKFLOW.length} steps did not match`);
  expect(report.items.map(item => item.label)).toEqual(first.active.steps.filter(step => step.status === 'unapplicable').map(step => step.label));
  expect(report.items[0].reason).toMatch(/beta/);
  await expect(page.locator('#history-graph .hg-row[aria-label*="did not match here"]')).toHaveCount(UNMATCHED);
  await expect.poll(async () => (await saidInNotifications(page)).join('\n')).toContain(`Replayed ${WORKFLOW.length} steps: ${WORKFLOW.length - UNMATCHED} applied; ${UNMATCHED} steps did not match.`);
  await page.locator('#history-banner').getByRole('button', { name: 'Report…' }).click();
  await page.locator('#history-replay-list .history-replay-item[data-outcome="unmatched"] .history-replay-step').first().click();
  await expect(page.locator('#history-graph .hg-details')).toHaveCount(1);

  // Undo walks back one step at a time, each exactly the state the history recorded, to where the replay started.
  const finished = await shownAndRecorded(page);
  expect(finished.shown).toEqual(finished.recorded);
  for (let undone = 1; undone <= WORKFLOW.length; undone++) {
    await page.locator('#history-undo-btn').click();
    await expect.poll(() => page.evaluate(() => {
      const tree = window._cellucidHistories.current().active;
      return [...tree.steps.keys()].indexOf(tree.headId);
    })).toBe(WORKFLOW.length - undone);
    const now = await shownAndRecorded(page);
    expect(now.shown, `after ${undone} undo`).toEqual(now.recorded);
  }
  await expect(page.locator('#history-undo-btn')).toBeDisabled();
  expect((await shownAndRecorded(page)).shown).toEqual(startedOn.shown);
  for (let redone = 1; redone <= WORKFLOW.length; redone++) {
    await page.locator('#history-redo-btn').click();
    await expect.poll(() => page.evaluate(() => {
      const tree = window._cellucidHistories.current().active;
      return [...tree.steps.keys()].indexOf(tree.headId);
    })).toBe(redone);
  }
  expect((await shownAndRecorded(page)).shown).toEqual(finished.shown);

  // ---- Replay A's session file on B, from B's own tracker: ⋯ › Replay a saved history… › Replay a session file here….
  await useTracker(page, own.name);
  await expect.poll(async () => (await trackerFacts(page)).active.id).toBe(own.id);
  await expect(page.locator('#history-banner')).toBeHidden();
  expect((await shownAndRecorded(page)).shown).toEqual(startedOn.shown);
  await page.locator('#history-menu-btn').click();
  await page.getByRole('menuitem', { name: 'Replay a saved history…' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#saved-states-replay-file').click();
  await (await chooser).setFiles(sessionA);
  await expect.poll(async () => (await trackerFacts(page)).trackers.length, { timeout: 60_000 }).toBe(3);
  await expect(page.locator('#history-banner')).toBeVisible();
  // Its report opens itself (steps did not match): closed, the page is the person's again.
  await expect(page.locator('#history-replay-dialog')).toBeVisible();
  await page.locator('#history-replay-dialog').getByRole('button', { name: 'Keep as is', exact: true }).click();
  await waitForPageAtRest(page);
  const second = await trackerFacts(page);
  // It names the session file it came from (by its name), and no saved state.
  expect(second.active.from).toEqual({ ...first.active.from, file: 'dataset-a.cellucid-session', saved: null });
  expectReplayedSteps(second.active.steps, source.labels);
  expect(second.active.steps).toEqual(first.active.steps.map(step => ({ ...step })));
  expect(second.trackers.find(tracker => tracker.id === own.id)).toEqual(own);
  expect(await liveState(page)).toEqual({
    hidden: [['gamma']], categoryColors: [], groups: [{ category: 'gamma', cells: 40 }], field: { source: 'var', key: 'GAPDH' },
  });

  // ---- A session saved on B says where its steps came from when it is loaded again.
  const downloadB = page.waitForEvent('download');
  await clickSaveSession(page);
  const sessionB = testInfo.outputPath('dataset-b.cellucid-session');
  await (await downloadB).saveAs(sessionB);
  await useTracker(page, own.name);
  await expect(page.locator('#history-banner')).toBeHidden();
  const load = page.waitForEvent('filechooser');
  await clickLoadSession(page);
  await (await load).setFiles(sessionB);
  // Loaded beside the page's own trackers: the file's three, named apart, its active one shown.
  await expect.poll(async () => (await trackerFacts(page)).trackers.length, { timeout: 60_000 }).toBe(second.trackers.length * 2);
  const reloaded = await trackerFacts(page);
  expect(reloaded.active.id).not.toBe(second.active.id);
  expect(reloaded.active.name).toBe(`${second.active.name} (shared)`);
  // A replayed tracker loaded keeps where its steps came from.
  expect(reloaded.active.from).toEqual(second.active.from);
  expect(reloaded.active.steps).toEqual(second.active.steps);
  expect((await replayReport(page)).summary).toBe(report.summary);

  // No change was made outside the history anywhere.
  for (const tracker of reloaded.trackers) {
    expect(tracker.steps.filter(step => step.label === 'Changed outside the history'), tracker.name).toEqual([]);
  }
  expect(errors).toEqual([]);
});

test('Use instead: the names that did not match are chosen in the report, and the steps replay again with them', async ({ page }) => {
  test.setTimeout(240_000);
  await recordNotifications(page);
  const errors = collectProductErrors(page);
  await page.addInitScript(() => {
    try { localStorage.setItem('cellucid:history-settings', JSON.stringify({ recordLayout: false })); } catch { /* none kept */ }
  });
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=browser-ci`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await waitForDatasetReady(page, 120);
  await waitForHistoryOf(page, 'Current UI fixture');
  await takeSteps(page, WORKFLOW.map(([step]) => step));
  await page.evaluate(() => window._cellucidHistories.flush());

  await chooseFiles(page.locator('#user-data-file-input'), OTHER);
  await expect(page.locator('#dataset-name')).toHaveText('Replay fixture');
  await waitForDatasetReady(page, 120);
  await waitForHistoryOf(page, 'Replay fixture');
  await page.locator('#history-load-btn').click();
  await replayRow(page).getByRole('button', { name: /^Replay the steps of .* on the dataset shown$/ }).click();

  // The report offers a name of B for each of A's names it lacks: two categories and a gene.
  const dialog = page.locator('#history-replay-dialog');
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  const again = dialog.getByRole('button', { name: 'Replay again with these names' });
  await expect(again).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Keep as is', exact: true })).toBeVisible();
  const beta = dialog.getByRole('combobox', { name: 'Use instead of the category “beta”' });
  await expect(beta).toBeEnabled();
  expect(await beta.locator('option').allTextContents()).toEqual(['Use instead…', 'gamma', 'delta', 'epsilon']);
  await beta.selectOption('delta');
  await expect(again).toBeEnabled();
  await dialog.getByRole('combobox', { name: 'Use instead of the category “alpha”' }).selectOption('epsilon');
  const gene = dialog.getByRole('combobox', { name: 'Use instead of the gene “CD3E”' });
  await gene.fill('CD3D');
  await again.click();
  await expect(dialog).toBeHidden();

  // A new tracker, every step applied with the names chosen; it keeps them (its mapping).
  await expect.poll(async () => (await trackerFacts(page)).trackers.length, { timeout: 60_000 }).toBe(3);
  // The tracker is there as the replay starts; its steps are made one by one. Every step matched: the
  // status line says so as it ends, and no report opens.
  await expect.poll(async () => (await saidInNotifications(page)).join('\n'), { timeout: 60_000 }).toContain(`Replayed ${WORKFLOW.length} steps; every one matched.`);
  await waitForPageAtRest(page);
  const replayed = await trackerFacts(page);
  // A second replay of the same source is named apart, as every replayed tracker is.
  expect(replayed.active.name).toBe('Replay of Current UI fixture (replay)');
  // Replayed again from where the first replay started, every step applies with the names chosen.
  expect(replayed.active.steps.map(step => (step.status === 'applied' ? 'applied' : `${step.label}: ${step.note}`))).toEqual(WORKFLOW.map(() => 'applied'));
  expect(await page.evaluate(() => window._cellucidHistories.current().active.start.mapping)).toEqual({
    fields: [],
    categories: [{ field: 'cell_type', from: 'beta', to: 'delta' }, { field: 'cell_type', from: 'alpha', to: 'epsilon' }],
    genes: [{ from: 'CD3E', to: 'CD3D' }],
  });
  const live = await liveState(page);
  expect(live.hidden.flat().sort()).toEqual(['delta', 'gamma']);
  expect(live.groups).toEqual([{ category: 'gamma', cells: 40 }]);
  expect(live.field).toEqual({ source: 'var', key: 'GAPDH' });
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});
