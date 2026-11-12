/**
 * History hunt: the history kept in this browser. A full storage pauses the
 * autosave; removing saved states anywhere the page offers (the Stored
 * dialog included) must resume it. A page that crashes while it writes
 * leaves a saved state that reopens whole, as it was at some step. Two tabs
 * continuing one saved state must not leave a saved state that reopens as
 * a history neither tab had.
 */
import { closePageWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { continueWhereLeftOff, dismissWelcome } from './helpers/welcome.mjs';
import { takeSteps } from './helpers/state-history.mjs';
import { observeProductErrors } from './helpers/history-hunt.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=history-hunt-autosave`;
const CELL_TYPE = Object.freeze({ source: 'obs', key: 'cell_type' });
const SCORE = Object.freeze({ source: 'obs', key: 'score' });
const hide = categories => ['filter.category.visibility', { field: CELL_TYPE, categories, visible: false }];
const show = categories => ['filter.category.visibility', { field: CELL_TYPE, categories, visible: true }];

async function open(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expect.poll(() => page.evaluate(() => window._cellucidHistories.current()?.active != null)).toBe(true);
}

/** A storage that refuses writes for room while `window.__storageFull` is true. */
function simulateFullStorage() {
  window.__storageFull = false;
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function guarded(...args) {
    if (window.__storageFull) throw new DOMException('The storage is full.', 'QuotaExceededError');
    return put.apply(this, args);
  };
}

function savedStates(page) {
  return page.evaluate(() => window._cellucidHistories.savedStates.list());
}

function ownSteps(page) {
  return page.evaluate(async () => {
    const list = await window._cellucidHistories.savedStates.list();
    return list.find(state => state.current)?.steps ?? 0;
  });
}

test('a full storage pauses the autosave; removing a saved state in the Stored dialog resumes it', async ({ page }) => {
  await page.addInitScript(simulateFullStorage);
  await open(page);
  await page.evaluate(() => window._cellucidHistories.savedStates.saveAs('Old work'));
  await takeSteps(page, [hide(['gamma'])]);
  await expect.poll(() => ownSteps(page)).toBe(1);
  // The disk fills up: the next step is refused for room, and the autosave pauses.
  await page.evaluate(() => { window.__storageFull = true; });
  await takeSteps(page, [hide(['beta'])]);
  await expect.poll(() => page.evaluate(() => window._cellucidHistories.currentAutosave().paused)).toBe(true);
  await page.evaluate(() => { window.__storageFull = false; });
  // The person frees room where the page lists what it stores: Session › Stored.
  await page.locator('#kept-stores-manage-btn').click();
  const row = page.locator('#kept-stores-dialog .kept-saved-states [data-item-id^="saved:"]').filter({ hasText: 'Old work' });
  await row.locator('input').check();
  await page.locator('#kept-stores-remove-selected').click();
  await expect(page.locator('#kept-stores-status')).toHaveText('Removed 1 item.');
  await page.keyboard.press('Escape');
  // Keeping resumes: the next step is written, with the one taken while it was full.
  await takeSteps(page, [show(['beta'])]);
  expect(await page.evaluate(() => window._cellucidHistories.currentAutosave().paused)).toBe(false);
  await expect.poll(() => ownSteps(page)).toBe(3);
});

test('a page killed while it writes leaves a saved state that reopens as it was at one of its steps', async ({ page, context }) => {
  test.setTimeout(180_000);
  await open(page);
  // Steps that are written, then many more with the kill right after: some writes are under way.
  const steps = [];
  for (let i = 0; i < 60; i++) steps.push(i % 2 === 0 ? hide(['gamma']) : show(['gamma']), ['setting.set', { setting: 'point-size', value: 10 + i }]);
  await takeSteps(page, steps.slice(0, 20));
  await expect.poll(() => ownSteps(page)).toBe(20);
  await page.evaluate(async list => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    for (const [type, params] of list) await getActions().dispatch(type, params);
    window.__fired = true;
  }, steps.slice(20));
  // The tab is killed at once: no pagehide, no flush, writes under way are cut (a crash, so no
  // application retirement here; the pages opened after it are retired).
  await page.close({ runBeforeUnload: false });
  const reopened = await context.newPage();
  const errors = observeProductErrors(reopened);
  await open(reopened);
  await continueWhereLeftOff(reopened);
  await expect.poll(() => reopened.evaluate(() => [...document.querySelectorAll('.notification-message')].map(e => e.textContent.trim())), { timeout: 60_000 })
    .toContain('Session fully restored.');
  // Whole: every step reachable, and the state shown is what its head recorded.
  const facts = await reopened.evaluate(async () => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint } = await import('/assets/js/app/state/domains/fingerprint.js');
    const history = window._cellucidHistories.current();
    await history.idle();
    const shown = (await stateFingerprint(getStateDomains())).domains;
    const recorded = history.shownHashes();
    return { steps: history.active.steps.size - 1, same: Object.keys(shown).filter(id => shown[id] !== recorded[id]) };
  });
  expect(facts.steps).toBeGreaterThanOrEqual(20);
  expect(facts.same, 'the state shown is the head\'s').toEqual([]);
  expect(errors).toEqual([]);
  await closePageWithApplicationRetirement(reopened);
});

test('two tabs continuing one saved state: it reopens as the history of one of them', async ({ page, context }) => {
  test.setTimeout(180_000);
  await open(page);
  // The fixture opens colored by cell_type (its first coloring): score is the step.
  await takeSteps(page, [['color.by', { field: SCORE }]]);
  await expect.poll(() => ownSteps(page)).toBe(1);
  // A second tab on the same dataset continues it while the first is still open.
  const second = await context.newPage();
  await open(second);
  // The first tab holds it (Web Lock): the second is told so and opens a copy (History v2 §3.7).
  const offer = second.locator('.notification').filter({ hasText: 'This history is open in another tab' });
  await offer.getByRole('button', { name: 'Open a copy here' }).click();
  await expect.poll(() => second.evaluate(() => window._cellucidHistories.current().active.steps.size)).toBe(2);
  // Each tab goes on with its own work.
  await takeSteps(page, [hide(['gamma']), hide(['alpha'])]);
  await takeSteps(second, [hide(['beta'])]);
  await page.evaluate(() => window._cellucidHistories.flush());
  await second.evaluate(() => window._cellucidHistories.flush());
  const tabs = {};
  for (const [name, each] of [['first', page], ['second', second]]) {
    tabs[name] = await each.evaluate(() => {
      const tree = window._cellucidHistories.current().active;
      return [...tree.steps.values()].map(step => `${step.id}<${step.parent}:${step.label}`).sort();
    });
  }
  const states = (await savedStates(page)).filter(state => state.kind === 'autosave');
  // A third tab opens what this browser kept.
  const third = await context.newPage();
  await open(third);
  const kept = await third.evaluate(async ids => {
    const out = [];
    for (const id of ids) {
      try {
        const source = await window._cellucidHistories.savedStates.read(id);
        const { history } = await source.readEager();
        out.push(history.trackers.flatMap(tracker => tracker.steps.map(step => `${step.id}<${step.parent}:${step.label}`)).sort());
      } catch (error) {
        out.push(`unreadable: ${error.message}`);
      }
    }
    return out;
  }, states.map(state => state.id));
  for (const each of kept) {
    expect([JSON.stringify(tabs.first), JSON.stringify(tabs.second)], `kept: ${JSON.stringify(each)}`).toContain(JSON.stringify(each));
  }
  await closePageWithApplicationRetirement(third);
  await closePageWithApplicationRetirement(second);
});
