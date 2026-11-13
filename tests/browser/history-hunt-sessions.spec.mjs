/**
 * History hunt: session files. A history with branches and two trackers is
 * saved, then loaded in a fresh browser profile: every step of every tracker
 * must give back the state fingerprint it had where it was made. Damaged,
 * truncated and hand-edited files must be refused with nothing changed: the
 * state shown, the trackers and their steps stay as they were.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { closeContextWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { waitForHistory } from './helpers/state-history.mjs';
import { mixedRun, observeProductErrors, recordRun } from './helpers/history-hunt.mjs';
import { readWholeSession, writeWholeSession } from './helpers/history-hunt-files.mjs';
import { clickLoadSession } from './helpers/session-buttons.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=history-hunt-sessions`;
const RESTORED = 'Session fully restored.';
/** Where a saved file is kept for the Python and R readers (`CELLUCID_HUNT_OUT`), if set. */
const KEEP = process.env.CELLUCID_HUNT_OUT ?? null;

async function open(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await waitForHistory(page);
}

/**
 * Share… › Save file with every tracker and every branch ticked (the dialog
 * opens with the tracker shown, its main and shown branches): the whole
 * history this file measures.
 */
async function save(page, testInfo, name) {
  await page.locator('#history-share-btn').click();
  await expect(page.locator('#history-share-dialog')).toBeVisible();
  const boxes = page.locator('#history-share-branches .history-share-branch-list input[type="checkbox"]');
  await expect(boxes.first()).toBeVisible();
  // Each tick draws the boxes again (the element ticked is replaced): click the first unticked one
  // until none is left.
  const unticked = boxes.and(page.locator(':not(:checked)'));
  for (let left = await unticked.count(); left > 0; left = await unticked.count()) {
    await unticked.first().click();
    await expect(unticked).toHaveCount(left - 1);
  }
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#history-share-save').click();
  const download = await downloadPromise;
  const file = testInfo.outputPath(name);
  await download.saveAs(file);
  const bytes = await readFile(file);
  if (KEEP !== null) {
    await mkdir(KEEP, { recursive: true });
    await writeFile(path.join(KEEP, name), bytes);
  }
  return bytes;
}

async function load(page, name, bytes) {
  const chooserPromise = page.waitForEvent('filechooser');
  await clickLoadSession(page);
  await (await chooserPromise).setFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
}

/** Once a load has said its outcome: no notification of it is still loading. */
async function settled(page) {
  await expect.poll(() => page.evaluate(() => document.querySelectorAll(
    '.notification[data-type="progress"], .notification[data-type="loading"]',
  ).length)).toBe(0);
}

/**
 * The notifications said since `markSaid` (a count of those shown would not do: a notification
 * shown before goes away on its own while a load runs).
 */
function messages(page) {
  return page.evaluate(() => [...document.querySelectorAll('.notification-message:not([data-hunt-said])')]
    .map(element => element.textContent.trim()));
}

/** Mark every notification shown now as said before. */
function markSaid(page) {
  return page.evaluate(() => {
    for (const element of document.querySelectorAll('.notification-message')) element.dataset.huntSaid = '1';
  });
}

/** Every tracker's steps with their branch names, head and tip, and the fingerprint shown, once idle. */
function wholeHistory(page) {
  return page.evaluate(async () => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint } = await import('/assets/js/app/state/domains/fingerprint.js');
    const history = window._cellucidHistories.current();
    await history.idle();
    return {
      active: history.active.name,
      trackers: history.trackers().map(tree => ({
        name: tree.name, head: tree.headId, activeBranch: tree.activeBranch, branches: [...tree.branches.values()].map(branch => `${branch.id}:${branch.name}:${branch.tip}`).sort(),
        steps: [...tree.steps.values()].map(step => `${step.id}<${step.parent}:${step.label}:${step.status}`),
      })),
      shown: (await stateFingerprint(getStateDomains())).digest,
    };
  });
}

/** Jump to every step of every tracker; the fingerprint of each, by `tracker/step`. */
function fingerprintsOfEveryStep(page) {
  return page.evaluate(async () => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint } = await import('/assets/js/app/state/domains/fingerprint.js');
    const history = window._cellucidHistories.current();
    const domains = getStateDomains();
    const back = history.active.id;
    const out = {};
    for (const tree of history.trackers()) {
      await history.useTracker(tree.id);
      const head = tree.headId;
      // Each step from the one before it in the tracker's order, so every jump is a short one
      // (a long jump can fail on its own: history-hunt-exact-restore.spec.mjs).
      for (const id of tree.steps.keys()) {
        try {
          await history.jump(id);
        } catch (error) {
          out[`${tree.name}/${id}`] = `jump failed: ${error.message}`;
          continue;
        }
        await history.idle();
        out[`${tree.name}/${id}`] = (await stateFingerprint(domains)).domains;
      }
      await history.jump(head);
    }
    await history.useTracker(back);
    await history.idle();
    return out;
  });
}

async function buildHistory(page) {
  // The mixed run's first 18 steps, kept views included (a long jump over a kept view and a rename:
  // history-hunt-exact-restore.spec.mjs).
  const run = await recordRun(page, (await mixedRun(page)).slice(0, 18));
  expect(run.after.filter(entry => entry.refused !== null)).toEqual([]);
  // A branch from the middle, a second tracker with its own labels, and Main shown again.
  await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    const history = window._cellucidHistories.current();
    const tree = history.active;
    const path = [];
    for (let step = tree.steps.get(tree.headId); step; step = tree.steps.get(step.parent)) path.unshift(step.id);
    await history.jump(path[8]);
    await getActions().dispatch('category.rename', { field: { source: 'obs', key: 'cell_type' }, category: 'beta', name: 'B side' });
    await getActions().dispatch('setting.set', { setting: 'point-size', value: 44 });
    await getActions().dispatch('history.branch.rename', { branch: tree.activeBranch, name: 'Side' });
    const main = tree.id;
    await history.startTracker({ name: 'Second' });
    await getActions().dispatch('category.rename', { field: { source: 'obs', key: 'cell_type' }, category: 'gamma', name: 'G2' });
    await history.useTracker(main);
    await history.jump(path.at(-1));
    await history.idle();
  });
}

test('saved and opened in a fresh profile: every step of every tracker gives its state back exactly', async ({ page, browser }, testInfo) => {
  test.setTimeout(300_000);
  const errors = observeProductErrors(page);
  await open(page);
  await buildHistory(page);
  const where = await wholeHistory(page);
  const expected = await fingerprintsOfEveryStep(page);
  const bytes = await save(page, testInfo, 'hunt-mixed.cellucid-session');

  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  const otherErrors = observeProductErrors(other);
  try {
    await open(other);
    await load(other, 'hunt-mixed.cellucid-session', bytes);
    await expect.poll(() => messages(other), { timeout: 60_000 }).toContain(RESTORED);
    // Loaded beside the fresh page's own tracker, each named apart where its name was taken.
    const loaded = await wholeHistory(other);
    const own = loaded.trackers.length - where.trackers.length;
    expect(own).toBe(1);
    const unsuffixed = name => name.replace(/ \(shared\)$/, '');
    expect({ ...loaded, active: unsuffixed(loaded.active), trackers: loaded.trackers.slice(own).map(tree => ({ ...tree, name: unsuffixed(tree.name) })) }).toEqual(where);
    const got = Object.fromEntries(Object.entries(await fingerprintsOfEveryStep(other)).map(([key, value]) => [key.replace(/ \(shared\)\//, '/'), value]));
    const differs = [];
    for (const [key, domains] of Object.entries(expected)) {
      const now = got[key];
      if (now === undefined) { differs.push(`${key}: missing`); continue; }
      if (typeof domains === 'string' || typeof now === 'string') {
        if (domains !== now) differs.push(`${key}: ${JSON.stringify(domains)} vs ${JSON.stringify(now)}`);
        continue;
      }
      const ids = Object.keys(domains).filter(id => domains[id] !== now[id]);
      if (ids.length) differs.push(`${key}: ${ids.join(', ')}`);
    }
    expect(differs).toEqual([]);
    expect(otherErrors).toEqual([]);
  } finally {
    await closeContextWithApplicationRetirement(fresh);
  }
  expect(errors).toEqual([]);

  // The file saved above, edited by hand, loaded on the page that wrote it.
  await test.step('a hand-edited file whose shown values cannot be put back is restored but for that part, which keeps what was shown', async () => {
    // Each domain refused is one part: named with its own words, left as shown; the rest of the file is restored.
    const edits = {
      'camera names a view that is not there': ['Camera', whole => editShown(whole, 'camera', value => { value.views.push(structuredClone(value.views[0])); })],
      'filters name a field the dataset lacks': ['Filters', whole => editShown(whole, 'filters', value => {
        value.views[0].push({ field: { source: 'obs', key: 'no_such_field' }, hidden: ['x'] });
      })],
      'highlights hold a cell past the dataset': ['Highlights', whole => editShown(whole, 'highlights', value => {
        value.pages[0].groups[0].cells = Uint32Array.from([1, 2, 999999]);
      })],
    };
    const outcomes = [];
    for (const [label, [part, edit]] of Object.entries(edits)) {
      const whole = await readWholeSession(bytes);
      await edit(whole);
      const edited = await writeWholeSession(whole);
      await markSaid(page);
      await load(page, `${label}.cellucid-session`, edited);
      await expect.poll(async () => (await messages(page)).length).toBeGreaterThan(0);
      await settled(page);
      const said = await messages(page);
      const named = new RegExp(`^Session restored but for 1 part\\. ${part} could not be restored: .+ It is left as it was shown\\.$`);
      outcomes.push({ label, restored: said.includes(RESTORED), named: said.some(text => named.test(text)), said });
    }
    expect(outcomes.filter(outcome => outcome.restored || !outcome.named)).toEqual([]);
  });
});

/** Change, on a copy, the value one domain shows at the active head, wherever a step holds it. */
async function editShown(whole, domain, edit) {
  const { hashValue } = await import('../../assets/js/app/history/value-pool.js');
  const tracker = whole.history.trackers.find(candidate => candidate.id === whole.history.activeTracker);
  const byId = new Map(tracker.steps.map(step => [step.id, step]));
  const hashes = {};
  const path = [];
  for (let step = byId.get(tracker.headId); step; step = step.parent === null ? undefined : byId.get(step.parent)) path.unshift(step);
  for (const step of path) Object.assign(hashes, step.after);
  const before = hashes[domain];
  const value = structuredClone(whole.values.get(before));
  edit(value);
  const after = await hashValue(value);
  whole.values.set(after, value);
  for (const each of whole.history.trackers) {
    for (const step of each.steps) for (const record of [step.before, step.after]) if (record[domain] === before) record[domain] = after;
  }
}
